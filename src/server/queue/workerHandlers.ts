import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { PolitenessManager } from './politeness.js';
import { completeJob, failOrRetryJob } from './jobs.js';
import { evaluateSubscriptionChange, recordCheckFailure } from '../engine/changeDetector.js';

export interface WorkerCandidateRow {
  id: string;
  kind: 'CHECK' | 'PROBE';
  target_id: string;
  capture_fingerprint: string | null;
  subscription_id: string | null;
  hostname: string;
  canonical_url: string;
}

export interface SubscriptionRow {
  id: string;
  target_id: string;
  interval_minutes: number;
  capture_config: string;
  capture_fingerprint: string;
  next_check_at: string;
  include_selectors: string;
  ignore_selectors: string;
  sensitivity: 'low' | 'balanced' | 'high';
  noise_filters: string;
  learned_ignore_patterns: string;
}

export interface ObservationRow {
  id: string;
  sanitized_dom: string;
  raw_text: string;
  captured_at: string;
}

/**
 * Inserts an execution record into check_runs table.
 */
export function recordCheckRun(
  db: Database,
  subscriptionId: string | null,
  targetId: string,
  jobId: string,
  outcome: 'OK' | 'ERROR' | 'BLOCKED',
  reason: string | null,
  httpStatus: number | null,
  durationMs: number,
  wasDeduplicated: boolean
): void {
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO check_runs (
      id, subscription_id, target_id, job_id, outcome, reason,
      http_status, duration_ms, was_deduplicated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, subscriptionId, targetId, jobId, outcome, reason,
    httpStatus, durationMs, wasDeduplicated ? 1 : 0, nowIso
  );
}

export function incrementFailureAndAdvance(db: Database, subId: string, intervalMinutes: number, reason: string): void {
  recordCheckFailure(db, subId, reason);

  const nextMs = Date.now() + PolitenessManager.addJitter(intervalMinutes * 60 * 1000, 0.1);
  db.prepare('UPDATE subscriptions SET next_check_at = ? WHERE id = ?')
    .run(new Date(nextMs).toISOString(), subId);
}

export function handleBlockedByRobots(db: Database, candidate: WorkerCandidateRow, reason: string): void {
  const dueSubs = db.prepare(`
    SELECT id, interval_minutes FROM subscriptions
    WHERE target_id = ? AND capture_fingerprint = ? AND is_paused = 0
  `).all(candidate.target_id, candidate.capture_fingerprint) as { id: string; interval_minutes: number }[];

  for (const sub of dueSubs) {
    recordCheckRun(db, sub.id, candidate.target_id, candidate.id, 'BLOCKED', reason, null, 0, false);
    incrementFailureAndAdvance(db, sub.id, sub.interval_minutes, reason);
  }

  failOrRetryJob(db, candidate.id, reason, false);
}

export function processOkOutcome(
  db: Database,
  dueSubs: SubscriptionRow[],
  jobId: string,
  targetId: string,
  durationMs: number,
  wasDeduplicated: boolean,
  observation: ObservationRow
): void {
  for (const sub of dueSubs) {
    const decision = evaluateSubscriptionChange(db, sub, observation);

    recordCheckRun(db, sub.id, targetId, jobId, 'OK', null, 200, durationMs, wasDeduplicated);
    db.prepare('UPDATE sub_state SET consecutive_failures = 0 WHERE subscription_id = ?').run(sub.id);

    // If candidate change recorded, next_check_at is already set to recheck delay
    if (decision.action !== 'CANDIDATE_RECORDED') {
      const nextMs = Date.now() + PolitenessManager.addJitter(sub.interval_minutes * 60 * 1000, 0.1);
      db.prepare('UPDATE subscriptions SET next_check_at = ? WHERE id = ?')
        .run(new Date(nextMs).toISOString(), sub.id);
    }
  }

  completeJob(db, jobId);
}

export function handleFailedCapture(
  db: Database,
  dueSubs: SubscriptionRow[],
  jobId: string,
  targetId: string,
  outcome: 'ERROR' | 'BLOCKED',
  reason: string | null,
  httpStatus: number | null,
  durationMs: number
): void {
  for (const sub of dueSubs) {
    recordCheckRun(db, sub.id, targetId, jobId, outcome, reason, httpStatus, durationMs, false);
  }

  const isTransient = outcome === 'ERROR' && (reason === 'timeout' || reason === 'network_error' || (httpStatus !== null && httpStatus >= 500));
  const retryResult = failOrRetryJob(db, jobId, reason ?? outcome, isTransient);

  if (retryResult.exhausted || !retryResult.retried) {
    for (const sub of dueSubs) {
      incrementFailureAndAdvance(db, sub.id, sub.interval_minutes, reason ?? outcome);
    }
  }
}
