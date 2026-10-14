import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { PolitenessManager } from './politeness.js';

export interface JobRow {
  id: string;
  kind: 'CHECK' | 'PROBE';
  target_id: string;
  capture_fingerprint: string | null;
  subscription_id: string | null;
  status: 'QUEUED' | 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  attempts: number;
  max_attempts: number;
  scheduled_at: string;
  lease_expires_at: string | null;
  locked_by: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

const RETRY_BACKOFF_STEPS_MS = [30_000, 120_000, 480_000]; // 30s, 2m, 8m per spec 9.4

/**
 * Enqueues a CHECK job for a target and capture fingerprint.
 * The partial unique index `uq_jobs_active_group` prevents duplicates
 * if an active job already exists.
 */
export function enqueueCheckJob(
  db: Database,
  targetId: string,
  captureFingerprint: string,
  scheduledAtIso: string = new Date().toISOString()
): JobRow | null {
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  try {
    const row = db.prepare(`
      INSERT INTO jobs (id, kind, target_id, capture_fingerprint, status, scheduled_at, created_at)
      VALUES (?, 'CHECK', ?, ?, 'QUEUED', ?, ?)
      RETURNING *
    `).get(id, targetId, captureFingerprint, scheduledAtIso, nowIso) as JobRow | undefined;

    return row ?? null;
  } catch (err: unknown) {
    // SQLite constraint violation means active job already exists for this group
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      return null;
    }
    throw err;
  }
}

/**
 * Enqueues a PROBE job for volatility suggestions on a subscription.
 */
export function enqueueProbeJob(
  db: Database,
  targetId: string,
  subscriptionId: string,
  scheduledAtIso: string = new Date().toISOString()
): JobRow {
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  return db.prepare(`
    INSERT INTO jobs (id, kind, target_id, subscription_id, status, scheduled_at, created_at)
    VALUES (?, 'PROBE', ?, ?, 'QUEUED', ?, ?)
    RETURNING *
  `).get(id, targetId, subscriptionId, scheduledAtIso, nowIso) as JobRow;
}

/**
 * Atomically claims a queued job with lease expiration.
 */
export function atomicClaimJob(
  db: Database,
  workerId: string,
  leaseDurationMs: number = 30_000,
  specificJobId?: string,
  now: number = Date.now()
): JobRow | null {
  const leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();

  if (specificJobId) {
    const claimed = db.prepare(`
      UPDATE jobs
      SET status = 'CLAIMED', locked_by = ?, lease_expires_at = ?
      WHERE id = ? AND status = 'QUEUED'
      RETURNING *
    `).get(workerId, leaseExpiresAt, specificJobId) as JobRow | undefined;

    return claimed ?? null;
  }

  const nowIso = new Date(now).toISOString();
  const claimed = db.prepare(`
    UPDATE jobs
    SET status = 'CLAIMED', locked_by = ?, lease_expires_at = ?
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'QUEUED' AND scheduled_at <= ?
      ORDER BY scheduled_at ASC
      LIMIT 1
    )
    RETURNING *
  `).get(workerId, leaseExpiresAt, nowIso) as JobRow | undefined;

  return claimed ?? null;
}

/**
 * Renews the lease of a currently running or claimed job (heartbeat).
 */
export function heartbeatJob(
  db: Database,
  jobId: string,
  workerId: string,
  leaseDurationMs: number = 30_000,
  now: number = Date.now()
): boolean {
  const leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();
  const res = db.prepare(`
    UPDATE jobs
    SET lease_expires_at = ?
    WHERE id = ? AND locked_by = ? AND status IN ('CLAIMED', 'RUNNING')
  `).run(leaseExpiresAt, jobId, workerId);

  return res.changes > 0;
}

/**
 * Transitions claimed job to RUNNING.
 */
export function startJob(db: Database, jobId: string, workerId: string): boolean {
  const res = db.prepare(`
    UPDATE jobs
    SET status = 'RUNNING'
    WHERE id = ? AND locked_by = ? AND status = 'CLAIMED'
  `).run(jobId, workerId);

  return res.changes > 0;
}

/**
 * Marks job COMPLETED and releases locks.
 */
export function completeJob(
  db: Database,
  jobId: string,
  now: number = Date.now()
): boolean {
  const completedAt = new Date(now).toISOString();
  const res = db.prepare(`
    UPDATE jobs
    SET status = 'COMPLETED', completed_at = ?, locked_by = NULL, lease_expires_at = NULL
    WHERE id = ?
  `).run(completedAt, jobId);

  return res.changes > 0;
}

/**
 * Handles job failure with exponential backoff & jitter or marks FAILED if exhausted.
 */
export function failOrRetryJob(
  db: Database,
  jobId: string,
  errorMessage: string,
  isTransient: boolean = false,
  retryAfterSeconds?: number,
  now: number = Date.now()
): { retried: boolean; exhausted: boolean; attempts: number } {
  const current = db.prepare('SELECT attempts, max_attempts FROM jobs WHERE id = ?').get(jobId) as
    | { attempts: number; max_attempts: number }
    | undefined;

  if (!current) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const nextAttempts = current.attempts + 1;

  if (isTransient && nextAttempts < current.max_attempts) {
    let delayMs: number;
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      delayMs = Math.min(retryAfterSeconds * 1000, 3600 * 1000);
    } else {
      const stepIndex = Math.min(current.attempts, RETRY_BACKOFF_STEPS_MS.length - 1);
      delayMs = PolitenessManager.addJitter(RETRY_BACKOFF_STEPS_MS[stepIndex], 0.1);
    }

    const scheduledAt = new Date(now + delayMs).toISOString();

    db.prepare(`
      UPDATE jobs
      SET status = 'QUEUED',
          attempts = ?,
          scheduled_at = ?,
          error_message = ?,
          locked_by = NULL,
          lease_expires_at = NULL
      WHERE id = ?
    `).run(nextAttempts, scheduledAt, errorMessage, jobId);

    return { retried: true, exhausted: false, attempts: nextAttempts };
  }

  // Non-transient or exhausted all retry attempts
  const completedAt = new Date(now).toISOString();
  db.prepare(`
    UPDATE jobs
    SET status = 'FAILED',
        attempts = ?,
        completed_at = ?,
        error_message = ?,
        locked_by = NULL,
        lease_expires_at = NULL
    WHERE id = ?
  `).run(nextAttempts, completedAt, errorMessage, jobId);

  return { retried: false, exhausted: true, attempts: nextAttempts };
}

/**
 * Crash Recovery: Recovers jobs whose lease has expired back to QUEUED.
 */
export function recoverExpiredLeases(db: Database, now: number = Date.now()): number {
  const nowIso = new Date(now).toISOString();
  const res = db.prepare(`
    UPDATE jobs
    SET status = 'QUEUED',
        locked_by = NULL,
        lease_expires_at = NULL
    WHERE status IN ('CLAIMED', 'RUNNING')
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
  `).run(nowIso);

  return res.changes;
}
