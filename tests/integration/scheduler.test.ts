import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { schedulerTick } from '../../src/server/queue/scheduler.js';
import { WorkerPool } from '../../src/server/queue/worker.js';
import { captureFingerprint } from '../../src/server/capture/captureConfig.js';

describe('Phase 3 Integration: Scheduler & Due-Only Grouping (Acceptance Matrix AA, AB, S)', () => {
  let db: Database.Database;
  const testDbPath = path.resolve('data', 'test-scheduler.db');

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = new Database(testDbPath);
    const schema = fs.readFileSync(path.resolve('src', 'server', 'db', 'schema.sql'), 'utf-8');
    db.exec(schema);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  function setupUserAndTarget(): { userId: string; targetId: string } {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
      VALUES (?, 'test@example.com', 'hash', 'salt', 1000, 'Test User')
    `).run(userId);

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://demo.example.com', 'demo.example.com', 'https://demo.example.com', ?)
    `).run(targetId, now);

    return { userId, targetId };
  }

  it('groups multiple due subscriptions by target and fingerprint into one job (Acceptance Matrix S)', () => {
    const { userId, targetId } = setupUserAndTarget();
    const now = Date.now();
    const pastTime = new Date(now - 1000).toISOString();
    const { config, fingerprint } = captureFingerprint({});

    // Create 3 due subscriptions with the same capture config
    for (let i = 1; i <= 3; i++) {
      const subId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, target_id, name, interval_minutes, next_check_at,
          capture_config, capture_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, 15, ?, ?, ?, ?)
      `).run(subId, userId, targetId, `Sub ${i}`, pastTime, JSON.stringify(config), fingerprint, pastTime);

      db.prepare('INSERT INTO sub_state (subscription_id) VALUES (?)').run(subId);
    }

    const tickResult = schedulerTick(db, now);
    expect(tickResult.dueGroupsCount).toBe(1);
    expect(tickResult.jobsEnqueuedCount).toBe(1);

    const queuedJobs = db.prepare("SELECT * FROM jobs WHERE status = 'QUEUED'").all() as { target_id: string; capture_fingerprint: string }[];
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0].target_id).toBe(targetId);
    expect(queuedJobs[0].capture_fingerprint).toBe(fingerprint);
  });

  it('evaluates and advances ONLY due subscriptions during shared capture (Acceptance Matrix AA)', async () => {
    const { userId, targetId } = setupUserAndTarget();
    const now = Date.now();
    const pastDueTime = new Date(now - 60_000).toISOString();
    const futureTime = new Date(now + 1_800_000).toISOString(); // +30m
    const { config, fingerprint } = captureFingerprint({});

    const subDueId = crypto.randomUUID();
    const subNotDueId = crypto.randomUUID();

    // Due subscription
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, created_at
      ) VALUES (?, ?, ?, 'Due Monitor', 15, ?, ?, ?, ?)
    `).run(subDueId, userId, targetId, pastDueTime, JSON.stringify(config), fingerprint, pastDueTime);
    db.prepare('INSERT INTO sub_state (subscription_id) VALUES (?)').run(subDueId);

    // Not-due subscription with same target and fingerprint
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, created_at
      ) VALUES (?, ?, ?, 'Future Monitor', 60, ?, ?, ?, ?)
    `).run(subNotDueId, userId, targetId, futureTime, JSON.stringify(config), fingerprint, pastDueTime);
    db.prepare('INSERT INTO sub_state (subscription_id) VALUES (?)').run(subNotDueId);

    // Enqueue job
    schedulerTick(db, now);

    // Simulate pre-existing fresh observation to test shared reuse path
    const obsId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO observations (
        id, target_id, capture_fingerprint, engine_used, final_url,
        http_status, sanitized_dom, raw_text, screenshot_path, subresource_count, captured_at
      ) VALUES (?, ?, ?, 'playwright', 'https://demo.example.com', 200, '<div>Content</div>', 'Content', NULL, 0, ?)
    `).run(obsId, targetId, fingerprint, new Date(now - 5000).toISOString());

    // Allow robots cache
    db.prepare(`
      INSERT INTO robots_cache (origin, raw_content, http_status, response_headers, cached_at, expires_at)
      VALUES ('https://demo.example.com', 'User-agent: *\\nAllow: /', 200, '{}', datetime('now'), datetime('now', '+1 day'))
    `).run();

    const worker = new WorkerPool(db, 1);
    await worker.pollAndExecute();

    // Verify: subDue was evaluated and advanced
    const updatedDueSub = db.prepare('SELECT next_check_at FROM subscriptions WHERE id = ?').get(subDueId) as { next_check_at: string };
    expect(new Date(updatedDueSub.next_check_at).getTime()).toBeGreaterThan(now);

    // Verify: subNotDue was NOT advanced (timestamp untouched)
    const updatedNotDueSub = db.prepare('SELECT next_check_at FROM subscriptions WHERE id = ?').get(subNotDueId) as { next_check_at: string };
    expect(updatedNotDueSub.next_check_at).toBe(futureTime);

    // Verify check_runs recorded for subDue only
    const runs = db.prepare('SELECT subscription_id, was_deduplicated FROM check_runs').all() as { subscription_id: string; was_deduplicated: number }[];
    expect(runs).toHaveLength(1);
    expect(runs[0].subscription_id).toBe(subDueId);
    expect(runs[0].was_deduplicated).toBe(1);
  });

  it('creates separate captures for different configs on the same URL (Acceptance Matrix AB)', () => {
    const { userId, targetId } = setupUserAndTarget();
    const now = Date.now();
    const pastTime = new Date(now - 1000).toISOString();

    const { config: configA, fingerprint: fpA } = captureFingerprint({ viewport: { width: 1280, height: 720 } });
    const { config: configB, fingerprint: fpB } = captureFingerprint({ viewport: { width: 375, height: 667 } });

    expect(fpA).not.toBe(fpB);

    // Sub A: Desktop viewport
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, created_at
      ) VALUES (?, ?, ?, 'Desktop Sub', 15, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), userId, targetId, pastTime, JSON.stringify(configA), fpA, pastTime);

    // Sub B: Mobile viewport
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, created_at
      ) VALUES (?, ?, ?, 'Mobile Sub', 15, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), userId, targetId, pastTime, JSON.stringify(configB), fpB, pastTime);

    const tickResult = schedulerTick(db, now);
    expect(tickResult.dueGroupsCount).toBe(2);
    expect(tickResult.jobsEnqueuedCount).toBe(2);

    const jobs = db.prepare("SELECT capture_fingerprint FROM jobs WHERE status = 'QUEUED' ORDER BY capture_fingerprint ASC").all() as { capture_fingerprint: string }[];
    expect(jobs).toHaveLength(2);
    expect(jobs.map(j => j.capture_fingerprint).sort()).toEqual([fpA, fpB].sort());
  });
});
