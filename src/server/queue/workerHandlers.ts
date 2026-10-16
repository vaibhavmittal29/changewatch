import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { env } from '../config.js';
import { PolitenessManager } from './politeness.js';
import { completeJob, failOrRetryJob } from './jobs.js';
import { checkRobotsPermission } from './robots.js';
import { probeTargetVolatility } from '../engine/volatility.js';
import { CaptureConfigSchema } from '../capture/captureConfig.js';
import { evaluateSubscriptionChange, recordCheckFailure } from '../engine/changeDetector.js';
import { generateChangeSummary } from '../engine/geminiSummary.js';

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
  keyword_rules?: string;
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
  const nowIso = new Date().toISOString();
  const dueSubs = db.prepare(`
    SELECT id, interval_minutes FROM subscriptions
    WHERE target_id = ? AND capture_fingerprint = ? AND is_paused = 0 AND next_check_at <= ?
  `).all(candidate.target_id, candidate.capture_fingerprint, nowIso) as { id: string; interval_minutes: number }[];

  for (const sub of dueSubs) {
    recordCheckRun(db, sub.id, candidate.target_id, candidate.id, 'BLOCKED', reason, null, 0, false);
    incrementFailureAndAdvance(db, sub.id, sub.interval_minutes, reason);
  }

  failOrRetryJob(db, candidate.id, reason, false);
}

export async function processOkOutcome(
  db: Database,
  dueSubs: SubscriptionRow[],
  jobId: string,
  targetId: string,
  durationMs: number,
  wasDeduplicated: boolean,
  observation: ObservationRow
): Promise<void> {
  for (const sub of dueSubs) {
    const decision = evaluateSubscriptionChange(db, sub, observation);

    if (decision.action === 'CHANGE_CONFIRMED' && decision.changeEventId && env.GEMINI_API_KEY) {
      try {
        const ev = db.prepare('SELECT summary, previous_version_id, current_version_id FROM change_events WHERE id = ?').get(decision.changeEventId) as { summary: string; previous_version_id: string | null; current_version_id: string | null } | undefined;
        if (ev?.previous_version_id && ev?.current_version_id) {
          const vPrev = db.prepare('SELECT stored_text FROM monitor_versions WHERE id = ?').get(ev.previous_version_id) as { stored_text: string } | undefined;
          const vCurr = db.prepare('SELECT stored_text FROM monitor_versions WHERE id = ?').get(ev.current_version_id) as { stored_text: string } | undefined;
          if (vPrev && vCurr) {
            const aiRes = await generateChangeSummary(
              `--- Previous\n${vPrev.stored_text.slice(0, 500)}\n+++ Current\n${vCurr.stored_text.slice(0, 500)}`,
              ev.summary
            );
            if (aiRes.source === 'gemini') {
              db.prepare('UPDATE change_events SET summary = ? WHERE id = ?').run(aiRes.summary, decision.changeEventId);
              if (decision.version) {
                db.prepare('UPDATE monitor_versions SET change_summary = ? WHERE id = ?').run(aiRes.summary, decision.version.id);
              }
              const outboxRows = db.prepare('SELECT id, payload FROM notification_outbox WHERE change_event_id = ?').all(decision.changeEventId) as { id: string; payload: string }[];
              for (const row of outboxRows) {
                try {
                  const parsed = JSON.parse(row.payload);
                  parsed.summary = aiRes.summary;
                  db.prepare('UPDATE notification_outbox SET payload = ? WHERE id = ?').run(JSON.stringify(parsed), row.id);
                } catch {}
              }
            }
          }
        }
      } catch (err) {
        console.warn('[processOkOutcome] Failed to enrich with Gemini summary:', err);
      }
    }

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

export async function executeProbeJob(
  db: Database,
  candidate: WorkerCandidateRow,
  jobId: string,
  canonicalUrl: string,
  _hostname: string
): Promise<void> {
  const robots = await checkRobotsPermission(db, canonicalUrl);
  if (!robots.allowed) {
    failOrRetryJob(db, jobId, robots.reason ?? 'robots_disallowed', false);
    return;
  }

  const sub = candidate.subscription_id
    ? db.prepare('SELECT id, capture_config, learned_ignore_patterns FROM subscriptions WHERE id = ?')
        .get(candidate.subscription_id) as { id: string; capture_config: string; learned_ignore_patterns: string } | undefined
    : undefined;

  let config;
  try {
    config = CaptureConfigSchema.parse(JSON.parse(sub?.capture_config || '{}'));
  } catch {
    config = CaptureConfigSchema.parse({});
  }

  try {
    const probeResult = await probeTargetVolatility(canonicalUrl, config, 1000);
    if (sub && probeResult.suggestedPatterns.length > 0) {
      let existing: string[] = [];
      try { existing = JSON.parse(sub.learned_ignore_patterns || '[]'); } catch {}
      const merged = Array.from(new Set([...existing, ...probeResult.suggestedPatterns]));
      db.prepare('UPDATE subscriptions SET learned_ignore_patterns = ? WHERE id = ?')
        .run(JSON.stringify(merged), sub.id);
    }
    completeJob(db, jobId);
  } catch (err: unknown) {
    failOrRetryJob(db, jobId, err instanceof Error ? err.message : String(err), false);
  }
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
