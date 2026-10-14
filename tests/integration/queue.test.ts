import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  enqueueCheckJob,
  atomicClaimJob,
  heartbeatJob,
  completeJob,
  failOrRetryJob,
  recoverExpiredLeases,
} from '../../src/server/queue/jobs.js';

describe('Phase 3 Integration: Durable SQLite Queue & Crash Recovery (Acceptance Matrix R, AK)', () => {
  let db: Database.Database;
  const testDbPath = path.resolve('data', 'test-queue.db');

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

  function createTestTarget(): string {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://queue-test.example.com', 'queue-test.example.com', 'https://queue-test.example.com', datetime('now'))
    `).run(id);
    return id;
  }

  it('atomically claims a job with lease expiry (single worker ownership)', () => {
    const targetId = createTestTarget();
    const fingerprint = 'fp-test-1';

    const job = enqueueCheckJob(db, targetId, fingerprint);
    expect(job).not.toBeNull();

    // Worker 1 claims
    const claimedByW1 = atomicClaimJob(db, 'worker-1', 15_000);
    expect(claimedByW1).not.toBeNull();
    expect(claimedByW1?.status).toBe('CLAIMED');
    expect(claimedByW1?.locked_by).toBe('worker-1');

    // Worker 2 attempts to claim concurrently -> returns null (no queued jobs left)
    const claimedByW2 = atomicClaimJob(db, 'worker-2', 15_000);
    expect(claimedByW2).toBeNull();
  });

  it('renews lease via heartbeat', () => {
    const targetId = createTestTarget();
    const fingerprint = 'fp-test-2';

    const job = enqueueCheckJob(db, targetId, fingerprint)!;
    const now = 1_000_000;
    atomicClaimJob(db, 'worker-1', 10_000, job.id, now);

    // Heartbeat from the locking worker
    const renewed = heartbeatJob(db, job.id, 'worker-1', 20_000, now + 5000);
    expect(renewed).toBe(true);

    const refreshed = db.prepare('SELECT lease_expires_at FROM jobs WHERE id = ?').get(job.id) as { lease_expires_at: string };
    expect(new Date(refreshed.lease_expires_at).getTime()).toBe(now + 5000 + 20_000);

    // Heartbeat from wrong worker fails
    const imposterRenew = heartbeatJob(db, job.id, 'worker-99', 20_000, now + 6000);
    expect(imposterRenew).toBe(false);
  });

  it('recovers expired leases on startup without losing jobs (Acceptance Matrix R)', () => {
    const targetId = createTestTarget();
    const job1 = enqueueCheckJob(db, targetId, 'fp-recover-1')!;
    const job2 = enqueueCheckJob(db, targetId, 'fp-recover-2')!;

    const pastTime = Date.now() - 60_000; // 1 minute ago
    const expiredLease = new Date(pastTime).toISOString();

    // Simulate worker crash: jobs stuck in CLAIMED/RUNNING with expired lease
    db.prepare("UPDATE jobs SET status = 'CLAIMED', locked_by = 'crashed-worker-1', lease_expires_at = ? WHERE id = ?")
      .run(expiredLease, job1.id);
    db.prepare("UPDATE jobs SET status = 'RUNNING', locked_by = 'crashed-worker-2', lease_expires_at = ? WHERE id = ?")
      .run(expiredLease, job2.id);

    // Run crash recovery
    const recoveredCount = recoverExpiredLeases(db, Date.now());
    expect(recoveredCount).toBe(2);

    const rows = db.prepare('SELECT id, status, locked_by, lease_expires_at FROM jobs WHERE id IN (?, ?)').all(job1.id, job2.id) as { status: string; locked_by: string | null; lease_expires_at: string | null }[];
    for (const r of rows) {
      expect(r.status).toBe('QUEUED');
      expect(r.locked_by).toBeNull();
      expect(r.lease_expires_at).toBeNull();
    }
  });

  it('prevents duplicate active jobs for the same target and capture fingerprint (uq_jobs_active_group)', () => {
    const targetId = createTestTarget();
    const fingerprint = 'fp-dedup';

    // First enqueue succeeds
    const job1 = enqueueCheckJob(db, targetId, fingerprint);
    expect(job1).not.toBeNull();

    // Second enqueue with same target_id & fingerprint returns null (unique active index prevents duplicate)
    const job2 = enqueueCheckJob(db, targetId, fingerprint);
    expect(job2).toBeNull();

    // Once completed, a new job for the same group CAN be enqueued
    completeJob(db, job1!.id);
    const job3 = enqueueCheckJob(db, targetId, fingerprint);
    expect(job3).not.toBeNull();
  });

  it('ensures retries do not inflate failure count and one exhausted job = one failure (Acceptance Matrix AK)', () => {
    const targetId = createTestTarget();
    const job = enqueueCheckJob(db, targetId, 'fp-retry')!;

    // Initial attempts = 0
    expect(job.attempts).toBe(0);

    // Transient failure 1
    const res1 = failOrRetryJob(db, job.id, 'timeout', true);
    expect(res1.retried).toBe(true);
    expect(res1.exhausted).toBe(false);
    expect(res1.attempts).toBe(1);

    // Transient failure 2
    const res2 = failOrRetryJob(db, job.id, 'timeout', true);
    expect(res2.retried).toBe(true);
    expect(res2.exhausted).toBe(false);
    expect(res2.attempts).toBe(2);

    // Transient failure 3 -> max_attempts reached (default 3) -> exhausted!
    const res3 = failOrRetryJob(db, job.id, 'timeout', true);
    expect(res3.retried).toBe(false);
    expect(res3.exhausted).toBe(true);
    expect(res3.attempts).toBe(3);

    const finalRow = db.prepare('SELECT status, error_message FROM jobs WHERE id = ?').get(job.id) as { status: string; error_message: string };
    expect(finalRow.status).toBe('FAILED');
    expect(finalRow.error_message).toBe('timeout');
  });
});
