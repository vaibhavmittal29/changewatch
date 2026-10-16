import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../src/server/config.js';
import { createApp } from '../../src/server/app.js';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate, hasColumn } from '../../src/server/db/migrate.js';
import { Scheduler } from '../../src/server/queue/scheduler.js';
import { enqueueProbeJob } from '../../src/server/queue/jobs.js';
import { executeProbeJob, processOkOutcome, type WorkerCandidateRow, type SubscriptionRow, type ObservationRow } from '../../src/server/queue/workerHandlers.js';
import { retryFailedUnlinks, ensureOrphanCleanupTable } from '../../src/server/maintenance/cleanup.js';
import { deleteSubscriptionCascade } from '../../src/server/maintenance/deleteFlow.js';
import * as volatilityModule from '../../src/server/engine/volatility.js';
import * as robotsModule from '../../src/server/queue/robots.js';
import * as geminiModule from '../../src/server/engine/geminiSummary.js';

let testDbPath: string;
let db: Database.Database;
const originalDigestHour = process.env.DIGEST_HOUR;

describe('Phase C — Async, Queue, and Background Correctness', () => {
  beforeEach(() => {
    testDbPath = path.join(process.cwd(), `test_phase_c_${crypto.randomUUID()}.db`);
    process.env.DATABASE_PATH = testDbPath;
    process.env.APP_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.DIGEST_HOUR = '8';

    db = getDb(testDbPath);
    migrate(db);
  });

  afterEach(() => {
    if (originalDigestHour !== undefined) process.env.DIGEST_HOUR = originalDigestHour;
    else delete process.env.DIGEST_HOUR;
    try {
      closeDb();
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
      if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    } catch {}
    vi.restoreAllMocks();
  });

  describe('1. Worker PROBE Jobs & Endpoint Rate Limiting', () => {
    it('executes a PROBE job, checks robots, probes volatility, and updates learned patterns', async () => {
      const userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
        VALUES (?, 'probeuser@example.com', 'hash', 'salt', 1000, 'Probe User')
      `).run(userId);

      const targetId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO targets (id, canonical_url, hostname, origin)
        VALUES (?, 'https://example.com/page', 'example.com', 'https://example.com')
      `).run(targetId);

      const subId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, target_id, name, interval_minutes, next_check_at,
          capture_config, capture_fingerprint, learned_ignore_patterns
        ) VALUES (?, ?, ?, 'Probe Sub', 30, datetime('now'), '{"engine":"playwright"}', 'fp1', '["#existing"]')
      `).run(subId, userId, targetId);

      const job = enqueueProbeJob(db, targetId, subId);
      expect(job.kind).toBe('PROBE');
      expect(job.status).toBe('QUEUED');

      vi.spyOn(robotsModule, 'checkRobotsPermission').mockResolvedValue({ allowed: true, cached: false });
      vi.spyOn(volatilityModule, 'probeTargetVolatility').mockResolvedValue({
        suggestedPatterns: ['#dynamic-ad', '.timestamp'],
        unstableLines: ['ad line'],
        capturesCount: 2,
      });

      const candidate: WorkerCandidateRow = {
        id: job.id,
        kind: 'PROBE',
        target_id: targetId,
        capture_fingerprint: null,
        subscription_id: subId,
        hostname: 'example.com',
        canonical_url: 'https://example.com/page',
      };

      await executeProbeJob(db, candidate, job.id, candidate.canonical_url, candidate.hostname);

      const updatedJob = db.prepare('SELECT status, completed_at FROM jobs WHERE id = ?').get(job.id) as { status: string; completed_at: string };
      expect(updatedJob.status).toBe('COMPLETED');
      expect(updatedJob.completed_at).toBeTruthy();

      const updatedSub = db.prepare('SELECT learned_ignore_patterns FROM subscriptions WHERE id = ?').get(subId) as { learned_ignore_patterns: string };
      const patterns = JSON.parse(updatedSub.learned_ignore_patterns);
      expect(patterns).toContain('#existing');
      expect(patterns).toContain('#dynamic-ad');
      expect(patterns).toContain('.timestamp');
    });

    it('enqueues probe via POST /api/subscriptions/:id/probe and enforces 5/min rate limit', async () => {
      const app = createApp();
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const regRes = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'probe_test@example.com', password: 'password123', displayName: 'Probe Tester' }),
        });
        const userCookie = regRes.headers.get('set-cookie')?.split(';')[0] || '';
        const regBody = await regRes.json() as { csrfToken: string; user: { id: string } };
        const csrfToken = regBody.csrfToken;
        const userId = regBody.user.id;

        const targetId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO targets (id, canonical_url, hostname, origin)
          VALUES (?, 'https://example.com/test', 'example.com', 'https://example.com')
        `).run(targetId);

        const subId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO subscriptions (
            id, user_id, target_id, name, interval_minutes, next_check_at,
            capture_config, capture_fingerprint
          ) VALUES (?, ?, ?, 'Sub 1', 30, datetime('now'), '{"engine":"playwright"}', 'fp1')
        `).run(subId, userId, targetId);

        // First 5 requests should succeed (202 Accepted)
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${baseUrl}/api/subscriptions/${subId}/probe`, {
            method: 'POST',
            headers: {
              Cookie: userCookie,
              'x-csrf-token': csrfToken,
            },
          });

          expect(res.status).toBe(202);
          const body = await res.json() as { ok: boolean; jobId: string };
          expect(body.ok).toBe(true);
          expect(body.jobId).toBeTruthy();
        }

        // 6th request must be rate limited (429)
        const resRateLimited = await fetch(`${baseUrl}/api/subscriptions/${subId}/probe`, {
          method: 'POST',
          headers: {
            Cookie: userCookie,
            'x-csrf-token': csrfToken,
          },
        });

        expect(resRateLimited.status).toBe(429);
        const body429 = await resRateLimited.json() as { error: string };
        expect(body429.error).toMatch(/rate limit/i);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('2. Gemini AI Summary Consistency', () => {
    it('updates change_events, monitor_versions, AND notification_outbox when Gemini succeeds', async () => {
      const userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
        VALUES (?, 'aiuser@example.com', 'hash', 'salt', 1000, 'AI User')
      `).run(userId);
      process.env.GEMINI_API_KEY = 'test-key';
      env.GEMINI_API_KEY = 'test-key';

      const targetId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO targets (id, canonical_url, hostname, origin)
        VALUES (?, 'https://example.com/ai', 'example.com', 'https://example.com')
      `).run(targetId);

      const subId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, target_id, name, interval_minutes, next_check_at,
          capture_config, capture_fingerprint
        ) VALUES (?, ?, ?, 'Sub AI', 30, datetime('now'), '{"engine":"playwright"}', 'fp1')
      `).run(subId, userId, targetId);

      const obs1Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO observations (
          id, target_id, capture_fingerprint, engine_used, final_url, http_status,
          sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at
        ) VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/ai', 200, '<p>Hello</p>', 'Hello Old', 0, 1, datetime('now'))
      `).run(obs1Id, targetId);

      const v1Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO monitor_versions (
          id, subscription_id, observation_id, version_number, content_hash, stored_text, change_summary, created_at
        ) VALUES (?, ?, ?, 1, 'hash1', 'Hello Old', 'Baseline version', datetime('now'))
      `).run(v1Id, subId, obs1Id);

      db.prepare(`
        INSERT INTO sub_state (subscription_id, active_version_id, pending_candidate_hash, pending_candidate_checks)
        VALUES (?, ?, 'hash2', 1)
      `).run(subId, v1Id);

      // Mock Gemini returning an enriched summary
      vi.spyOn(geminiModule, 'generateChangeSummary').mockResolvedValue({
        summary: 'Enriched AI change summary for test',
        source: 'gemini',
      });

      const dueSub: SubscriptionRow = {
        id: subId,
        target_id: targetId,
        interval_minutes: 30,
        capture_config: '{"engine":"playwright"}',
        capture_fingerprint: 'fp1',
        next_check_at: new Date().toISOString(),
        include_selectors: '[]',
        ignore_selectors: '[]',
        sensitivity: 'balanced',
        noise_filters: '{}',
        learned_ignore_patterns: '[]',
      };

      const obs2Id = crypto.randomUUID();
      const capturedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO observations (
          id, target_id, capture_fingerprint, engine_used, final_url, http_status,
          sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at
        ) VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/ai', 200, '<p>Hello New</p>', 'Hello New Content', 0, 1, ?)
      `).run(obs2Id, targetId, capturedAt);

      const obs2: ObservationRow = {
        id: obs2Id,
        sanitized_dom: '<p>Hello New</p>',
        raw_text: 'Hello New Content',
        captured_at: capturedAt,
      };

      const jobId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO jobs (id, kind, target_id, capture_fingerprint, status, scheduled_at, created_at)
        VALUES (?, 'CHECK', ?, 'fp1', 'RUNNING', datetime('now'), datetime('now'))
      `).run(jobId, targetId);

      // Run candidate observation twice to confirm change (Criterion P state machine)
      await processOkOutcome(db, [dueSub], jobId, targetId, 100, false, obs2);
      await processOkOutcome(db, [dueSub], jobId, targetId, 100, false, obs2);

      const event = db.prepare('SELECT summary, current_version_id FROM change_events WHERE subscription_id = ?').get(subId) as { summary: string; current_version_id: string };
      expect(event.summary).toBe('Enriched AI change summary for test');

      const v2 = db.prepare('SELECT change_summary FROM monitor_versions WHERE id = ?').get(event.current_version_id) as { change_summary: string };
      expect(v2.change_summary).toBe('Enriched AI change summary for test');

      const outbox = db.prepare('SELECT payload FROM notification_outbox WHERE change_event_id IS NOT NULL').get() as { payload: string };
      expect(outbox).toBeTruthy();
      const parsedOutbox = JSON.parse(outbox.payload);
      expect(parsedOutbox.summary).toBe('Enriched AI change summary for test');
    });

    it('retains deterministic summary everywhere if Gemini fails or times out', async () => {
      const userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
        VALUES (?, 'falluser@example.com', 'hash', 'salt', 1000, 'Fall User')
      `).run(userId);
      process.env.GEMINI_API_KEY = 'test-key';
      env.GEMINI_API_KEY = 'test-key';

      const targetId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO targets (id, canonical_url, hostname, origin)
        VALUES (?, 'https://example.com/fallback', 'example.com', 'https://example.com')
      `).run(targetId);

      const subId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, target_id, name, interval_minutes, next_check_at,
          capture_config, capture_fingerprint
        ) VALUES (?, ?, ?, 'Sub Fallback', 30, datetime('now'), '{"engine":"playwright"}', 'fp1')
      `).run(subId, userId, targetId);

      const obs1Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO observations (
          id, target_id, capture_fingerprint, engine_used, final_url, http_status,
          sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at
        ) VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/fallback', 200, '<p>A</p>', 'Line A', 0, 1, datetime('now'))
      `).run(obs1Id, targetId);

      const v1Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO monitor_versions (
          id, subscription_id, observation_id, version_number, content_hash, stored_text, change_summary, created_at
        ) VALUES (?, ?, ?, 1, 'hashA', 'Line A', 'Baseline', datetime('now'))
      `).run(v1Id, subId, obs1Id);

      db.prepare(`
        INSERT INTO sub_state (subscription_id, active_version_id, pending_candidate_hash, pending_candidate_checks)
        VALUES (?, ?, 'hashB', 1)
      `).run(subId, v1Id);

      // Mock Gemini throwing an error
      vi.spyOn(geminiModule, 'generateChangeSummary').mockRejectedValue(new Error('Gemini API timeout'));

      const dueSub: SubscriptionRow = {
        id: subId,
        target_id: targetId,
        interval_minutes: 30,
        capture_config: '{"engine":"playwright"}',
        capture_fingerprint: 'fp1',
        next_check_at: new Date().toISOString(),
        include_selectors: '[]',
        ignore_selectors: '[]',
        sensitivity: 'balanced',
        noise_filters: '{}',
        learned_ignore_patterns: '[]',
      };

      const obs2Id = crypto.randomUUID();
      const capturedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO observations (
          id, target_id, capture_fingerprint, engine_used, final_url, http_status,
          sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at
        ) VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/fallback', 200, '<p>B</p>', 'Line B', 0, 1, ?)
      `).run(obs2Id, targetId, capturedAt);

      const obs2: ObservationRow = {
        id: obs2Id,
        sanitized_dom: '<p>B</p>',
        raw_text: 'Line B',
        captured_at: capturedAt,
      };

      const jobId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO jobs (id, kind, target_id, capture_fingerprint, status, scheduled_at, created_at)
        VALUES (?, 'CHECK', ?, 'fp1', 'RUNNING', datetime('now'), datetime('now'))
      `).run(jobId, targetId);

      // Run candidate observation twice to confirm change (Criterion P state machine)
      await processOkOutcome(db, [dueSub], jobId, targetId, 100, false, obs2);
      await processOkOutcome(db, [dueSub], jobId, targetId, 100, false, obs2);

      const event = db.prepare('SELECT summary, current_version_id FROM change_events WHERE subscription_id = ?').get(subId) as { summary: string; current_version_id: string };
      expect(event.summary).toContain('added,'); // Deterministic diff summary

      const v2 = db.prepare('SELECT change_summary FROM monitor_versions WHERE id = ?').get(event.current_version_id) as { change_summary: string };
      expect(v2.change_summary).toBe(event.summary);

      const outbox = db.prepare('SELECT payload FROM notification_outbox WHERE change_event_id IS NOT NULL').get() as { payload: string };
      const parsedOutbox = JSON.parse(outbox.payload);
      expect(parsedOutbox.summary).toBe(event.summary);
    });
  });

  describe('3. Safe Schema Migrations', () => {
    it('detects existing columns using hasColumn helper', () => {
      expect(hasColumn(db, 'subscriptions', 'feed_token')).toBe(true);
      expect(hasColumn(db, 'observations', 'top_level_navigations')).toBe(true);
      expect(hasColumn(db, 'subscriptions', 'nonexistent_col_123')).toBe(false);
    });

    it('safely runs migration on an existing database without error or duplication', () => {
      expect(() => migrate(db)).not.toThrow();
      expect(Number(db.pragma('user_version', { simple: true }))).toBeGreaterThanOrEqual(3);
    });
  });

  describe('4. Daily Scheduler Catch-up & Ledger', () => {
    it('runs missed daily tasks if started after DIGEST_HOUR and records in ledger', () => {
      let digestCalled = 0;
      let cleanupCalled = 0;

      const scheduler = new Scheduler(db, {
        timezone: 'UTC',
        dailyDigestHandler: () => { digestCalled++; },
        retentionCleanupHandler: () => { cleanupCalled++; },
      });

      // Server starts at 14:00 UTC (DIGEST_HOUR is 8)
      const afterDigestHourDate = new Date('2026-05-10T14:30:00Z');
      const ran = scheduler.checkDailyTasks(afterDigestHourDate);

      expect(ran).toBe(true);
      expect(digestCalled).toBe(1);
      expect(cleanupCalled).toBe(1);

      // Verify recorded in daily_task_ledger
      const ledgerEntry = db.prepare('SELECT * FROM daily_task_ledger WHERE task_date = ?').get('2026-05-10') as { task_date: string };
      expect(ledgerEntry).toBeTruthy();
      expect(ledgerEntry.task_date).toBe('2026-05-10');

      // Calling again on same date must NOT duplicate
      const ranAgain = scheduler.checkDailyTasks(new Date('2026-05-10T15:00:00Z'));
      expect(ranAgain).toBe(false);
      expect(digestCalled).toBe(1);
    });

    it('does not run before DIGEST_HOUR', () => {
      let digestCalled = 0;

      const scheduler = new Scheduler(db, {
        timezone: 'UTC',
        dailyDigestHandler: () => { digestCalled++; },
        retentionCleanupHandler: () => {},
      });

      const beforeDigestHourDate = new Date('2026-05-11T05:00:00Z');
      const ran = scheduler.checkDailyTasks(beforeDigestHourDate);

      expect(ran).toBe(false);
      expect(digestCalled).toBe(0);
    });
  });

  describe('5. Orphan Screenshot Cleanup & Retry Queue', () => {
    it('records failed screenshot unlinks in orphan_cleanup_queue without failing cascade', () => {
      const userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
        VALUES (?, 'deluser@example.com', 'hash', 'salt', 1000, 'Del User')
      `).run(userId);

      const targetId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO targets (id, canonical_url, hostname, origin)
        VALUES (?, 'https://example.com/del', 'example.com', 'https://example.com')
      `).run(targetId);

      const subId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, target_id, name, interval_minutes, next_check_at,
          capture_config, capture_fingerprint
        ) VALUES (?, ?, ?, 'Del Sub', 30, datetime('now'), '{"engine":"playwright"}', 'fp1')
      `).run(subId, userId, targetId);

      const fakeScreenshotPath = path.join(process.cwd(), `test_fake_screenshot_${crypto.randomUUID()}.png`);
      fs.writeFileSync(fakeScreenshotPath, 'fake-png-data');

      db.prepare(`
        INSERT INTO observations (
          id, target_id, capture_fingerprint, engine_used, final_url, http_status,
          sanitized_dom, raw_text, screenshot_path, subresource_count, top_level_navigations, captured_at
        ) VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/del', 200, '<p>Del</p>', 'Del Text', ?, 0, 1, datetime('now'))
      `).run(crypto.randomUUID(), targetId, fakeScreenshotPath);

      // Mock fs.unlinkSync to throw an error (e.g. file lock or permissions error)
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
        if (typeof p === 'string' && p === fakeScreenshotPath) {
          throw new Error('EBUSY: resource locked');
        }
      });

      const res = deleteSubscriptionCascade(subId, userId);
      expect(res).toBeTruthy();
      expect(res?.deletedSubscriptionId).toBe(subId);

      // Verify the error was recorded in orphan_cleanup_queue for later retry
      ensureOrphanCleanupTable(db);
      const queued = db.prepare('SELECT * FROM orphan_cleanup_queue WHERE file_path = ?').get(fakeScreenshotPath) as { file_path: string; failed_attempts: number };
      expect(queued).toBeTruthy();
      expect(queued.failed_attempts).toBe(1);

      // Restore unlinkSync and retry
      unlinkSpy.mockRestore();
      const cleaned = retryFailedUnlinks(db);
      expect(cleaned).toBe(1);
      expect(fs.existsSync(fakeScreenshotPath)).toBe(false);

      const remainingQueue = db.prepare('SELECT * FROM orphan_cleanup_queue WHERE file_path = ?').get(fakeScreenshotPath);
      expect(remainingQueue).toBeFalsy();
    });
  });
});
