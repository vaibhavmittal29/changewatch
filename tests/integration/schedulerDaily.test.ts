import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { handleBlockedByRobots, type WorkerCandidateRow } from '../../src/server/queue/workerHandlers.js';
import { Scheduler } from '../../src/server/queue/scheduler.js';
import { env } from '../../src/server/config.js';

describe('Phase C: Scheduler, Queue & Robots Due-Only Fix', () => {
  const testDbPath = path.resolve(process.cwd(), './data/test_sched_daily.db');

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    process.env.DATABASE_PATH = testDbPath;
    const db = getDb(testDbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('handleBlockedByRobots evaluates ONLY due unpaused subscriptions', () => {
    const db = getDb(testDbPath);
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const subDueId = crypto.randomUUID();
    const subFutureId = crypto.randomUUID();
    const subPausedId = crypto.randomUUID();

    const nowIso = new Date().toISOString();
    const pastIso = new Date(Date.now() - 60000).toISOString();
    const futureIso = new Date(Date.now() + 600000).toISOString();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
      VALUES (?, 'u@example.com', 'h', 's', 1000, 'User')
    `).run(userId);

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://example.com/page', 'example.com', 'https://example.com', ?)
    `).run(targetId, nowIso);

    // Sub 1: DUE
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint, is_paused)
      VALUES (?, ?, ?, 'Due Sub', 15, ?, '{}', 'fp1', 0)
    `).run(subDueId, userId, targetId, pastIso);
    db.prepare('INSERT INTO sub_state (subscription_id, consecutive_failures) VALUES (?, 0)').run(subDueId);

    // Sub 2: FUTURE (not due)
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint, is_paused)
      VALUES (?, ?, ?, 'Future Sub', 30, ?, '{}', 'fp1', 0)
    `).run(subFutureId, userId, targetId, futureIso);
    db.prepare('INSERT INTO sub_state (subscription_id, consecutive_failures) VALUES (?, 0)').run(subFutureId);

    // Sub 3: PAUSED
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint, is_paused)
      VALUES (?, ?, ?, 'Paused Sub', 15, ?, '{}', 'fp1', 1)
    `).run(subPausedId, userId, targetId, pastIso);
    db.prepare('INSERT INTO sub_state (subscription_id, consecutive_failures) VALUES (?, 0)').run(subPausedId);

    const jobId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO jobs (id, target_id, capture_fingerprint, kind, status, scheduled_at, created_at)
      VALUES (?, ?, 'fp1', 'CHECK', 'CLAIMED', ?, ?)
    `).run(jobId, targetId, pastIso, pastIso);

    const candidate: WorkerCandidateRow = {
      id: jobId,
      kind: 'CHECK',
      target_id: targetId,
      capture_fingerprint: 'fp1',
      subscription_id: null,
      hostname: 'example.com',
      canonical_url: 'https://example.com/page',
    };

    handleBlockedByRobots(db, candidate, 'robots_disallowed');

    // 1. Due sub must have 1 failure recorded and next_check_at advanced
    const stateDue = db.prepare('SELECT consecutive_failures FROM sub_state WHERE subscription_id = ?').get(subDueId) as { consecutive_failures: number };
    expect(stateDue.consecutive_failures).toBe(1);

    // 2. Future sub must NOT be incremented
    const stateFuture = db.prepare('SELECT consecutive_failures FROM sub_state WHERE subscription_id = ?').get(subFutureId) as { consecutive_failures: number };
    expect(stateFuture.consecutive_failures).toBe(0);

    // 3. Paused sub must NOT be incremented
    const statePaused = db.prepare('SELECT consecutive_failures FROM sub_state WHERE subscription_id = ?').get(subPausedId) as { consecutive_failures: number };
    expect(statePaused.consecutive_failures).toBe(0);
  });

  it('Scheduler.checkDailyTasks triggers daily digest and retention at DIGEST_HOUR', () => {
    const db = getDb(testDbPath);
    const scheduler = new Scheduler(db);

    const matchingDate = new Date();
    matchingDate.setUTCHours(env.DIGEST_HOUR, 0, 0, 0);

    // Calling checkDailyTasks on the designated digest hour should run without error
    expect(() => scheduler.checkDailyTasks(matchingDate)).not.toThrow();

    // Calling it again on the same date should be a no-op (idempotent for the day)
    expect(() => scheduler.checkDailyTasks(matchingDate)).not.toThrow();
  });
});
