import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { env } from '../config.js';
import { extractText } from '../capture/extract.js';
import { normalizeText, hashContent } from './normalize.js';
import { calculateDiff, type SensitivityLevel } from './diffSummary.js';
import { getActiveVersion, commitNextVersion, createBaselineVersion, type MonitorVersionRow } from './versions.js';
import type { NoiseFilterConfig } from './noiseFilters.js';
import { enqueueNotificationForEvent } from '../notifications/outbox.js';

export interface SubscriptionRecord {
  id: string;
  interval_minutes: number;
  sensitivity: SensitivityLevel;
  include_selectors: string;
  ignore_selectors: string;
  noise_filters: string;
  learned_ignore_patterns: string;
}

export interface ObservationRecord {
  id: string;
  sanitized_dom: string;
  raw_text: string;
}

export interface SubStateRow {
  subscription_id: string;
  active_version_id: string | null;
  consecutive_failures: number;
  is_currently_down: number;
  last_down_alert_at: string | null;
  pending_candidate_hash: string | null;
  pending_candidate_checks: number;
  pending_observation_id: string | null;
  last_alerted_hash: string | null;
  last_alert_sent_at: string | null;
  recent_checks_window: string;
  is_noisy: number;
}

export type DecisionAction =
  | 'BASELINE_CREATED'
  | 'UNCHANGED'
  | 'CANDIDATE_RECORDED'
  | 'CHANGE_CONFIRMED';

export interface DecisionResult {
  action: DecisionAction;
  version?: MonitorVersionRow;
  contentHash: string;
  storedText: string;
  changeEventId?: string;
  isSuppressed?: boolean;
  recheckDelayMs?: number;
}

/**
 * Updates rolling checks window and computes noisy flag (>70% candidate checks in last 10).
 */
function updateRollingWindow(db: Database, subId: string, currentWindowStr: string, code: 'U' | 'C'): { isNoisy: number; nextWindow: string } {
  let list: string[] = [];
  try { list = JSON.parse(currentWindowStr); } catch { list = []; }
  const next = [...list.slice(-9), code];
  const isNoisy = next.length >= 3 && (next.filter(c => c === 'C').length / next.length) > 0.7 ? 1 : 0;
  const nextWindow = JSON.stringify(next);
  db.prepare('UPDATE sub_state SET recent_checks_window = ?, is_noisy = ? WHERE subscription_id = ?').run(nextWindow, isNoisy, subId);
  return { isNoisy, nextWindow };
}

/**
 * Handles outage transition on check failure (Section 9.6 step 10).
 */
export function recordCheckFailure(
  db: Database,
  subId: string,
  reason: string,
  nowIso: string = new Date().toISOString()
): void {
  const state = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateRow | undefined;
  if (!state) return;

  const nextFailures = state.consecutive_failures + 1;

  if (nextFailures >= env.OUTAGE_THRESHOLD && state.is_currently_down === 0) {
    const eventId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO change_events (id, subscription_id, current_version_id, event_type, summary, created_at)
      VALUES (?, ?, ?, 'DOWN', ?, ?)
    `).run(eventId, subId, state.active_version_id, `Site outage detected: ${reason}`, nowIso);
    enqueueNotificationForEvent(db, eventId);

    db.prepare(`
      UPDATE sub_state
      SET consecutive_failures = ?, is_currently_down = 1, last_down_alert_at = ?
      WHERE subscription_id = ?
    `).run(nextFailures, nowIso, subId);
  } else {
    db.prepare('UPDATE sub_state SET consecutive_failures = ? WHERE subscription_id = ?')
      .run(nextFailures, subId);
  }
}

/**
 * Evaluates a successful capture against a subscription with noise filtering,
 * sensitivity thresholds, 2-check confirmation, and cooldown gate (Sections 9.5 & 9.6).
 */
export function evaluateSubscriptionChange(
  db: Database,
  sub: SubscriptionRecord,
  obs: ObservationRecord,
  nowMs: number = Date.now()
): DecisionResult {
  const nowIso = new Date(nowMs).toISOString();

  const safeParse = <T>(val: string, fallback: T): T => { try { return JSON.parse(val) as T; } catch { return fallback; } };
  const inc = safeParse<string[]>(sub.include_selectors, []);
  const ign = safeParse<string[]>(sub.ignore_selectors, []);
  const filters = safeParse<NoiseFilterConfig>(sub.noise_filters, {});
  const learned = safeParse<string[]>(sub.learned_ignore_patterns, []);

  // 1. Single extraction contract + full normalizer
  const extracted = extractText(obs.sanitized_dom, inc, ign);
  const normalized = normalizeText(extracted, filters, learned);
  const hash = hashContent(normalized);

  const state = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(sub.id) as SubStateRow;
  const activeVersion = getActiveVersion(db, sub.id);

  // Recovery flow: if previously DOWN, create RECOVERED event
  if (state.is_currently_down === 1) {
    const recId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO change_events (id, subscription_id, current_version_id, event_type, summary, created_at)
      VALUES (?, ?, ?, 'RECOVERED', 'Target has recovered and is responding normally', ?)
    `).run(recId, sub.id, state.active_version_id, nowIso);
    enqueueNotificationForEvent(db, recId);

    db.prepare('UPDATE sub_state SET is_currently_down = 0, consecutive_failures = 0 WHERE subscription_id = ?')
      .run(sub.id);
  } else if (state.consecutive_failures > 0) {
    db.prepare('UPDATE sub_state SET consecutive_failures = 0 WHERE subscription_id = ?')
      .run(sub.id);
  }

  // 2. First OK check ever: establish Version 1 baseline
  if (!activeVersion) {
    const baseline = createBaselineVersion(db, sub.id, obs.id, normalized, hash, nowIso);
    updateRollingWindow(db, sub.id, state.recent_checks_window, 'U');
    return { action: 'BASELINE_CREATED', version: baseline, contentHash: hash, storedText: normalized };
  }

  // 3. Compare with active baseline hash
  if (activeVersion.content_hash === hash) {
    // Content unchanged: clear pending candidates (blip discarded if any)
    db.prepare(`
      UPDATE sub_state
      SET pending_candidate_hash = NULL, pending_candidate_checks = 0, pending_observation_id = NULL
      WHERE subscription_id = ?
    `).run(sub.id);

    updateRollingWindow(db, sub.id, state.recent_checks_window, 'U');
    return { action: 'UNCHANGED', version: activeVersion, contentHash: hash, storedText: normalized };
  }

  // 4. Content differs: evaluate Myers line diff & sensitivity threshold
  const diffResult = calculateDiff(activeVersion.stored_text, normalized, sub.sensitivity);

  if (!diffResult.meetsThreshold) {
    // Change below sensitivity threshold -> treat as unchanged
    db.prepare(`
      UPDATE sub_state
      SET pending_candidate_hash = NULL, pending_candidate_checks = 0, pending_observation_id = NULL
      WHERE subscription_id = ?
    `).run(sub.id);

    updateRollingWindow(db, sub.id, state.recent_checks_window, 'U');
    return { action: 'UNCHANGED', version: activeVersion, contentHash: hash, storedText: normalized };
  }

  // 5. Candidate confirmation state machine (Criterion P)
  if (state.pending_candidate_hash !== hash) {
    // First observation of this candidate: set pending state & schedule quick re-check
    const confirmDelayMs = env.CONFIRM_DELAY_MS;
    const recheckAt = new Date(nowMs + confirmDelayMs).toISOString();

    db.prepare(`
      UPDATE sub_state
      SET pending_candidate_hash = ?, pending_candidate_checks = 1, pending_observation_id = ?
      WHERE subscription_id = ?
    `).run(hash, obs.id, sub.id);

    // Short-interval recheck
    db.prepare('UPDATE subscriptions SET next_check_at = ? WHERE id = ?')
      .run(recheckAt, sub.id);

    updateRollingWindow(db, sub.id, state.recent_checks_window, 'C');
    return {
      action: 'CANDIDATE_RECORDED',
      contentHash: hash,
      storedText: normalized,
      recheckDelayMs: confirmDelayMs,
    };
  }

  // Same candidate hash seen consecutively (checks = 2): CONFIRMED!
  const newVersion = commitNextVersion(db, sub.id, obs.id, normalized, hash, diffResult.summary, nowIso);

  // Check Cooldown (STRONG, Criterion Q)
  const cooldownMs = env.COOLDOWN_HOURS * 3600 * 1000;
  const lastAlertTime = state.last_alert_sent_at ? new Date(state.last_alert_sent_at).getTime() : 0;
  const isSuppressed = Boolean(state.last_alert_sent_at) && (nowMs - lastAlertTime) < cooldownMs;

  const eventId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO change_events (
      id, subscription_id, previous_version_id, current_version_id,
      event_type, suppressed, summary, created_at
    ) VALUES (?, ?, ?, ?, 'CHANGE', ?, ?, ?)
  `).run(
    eventId, sub.id, activeVersion.id, newVersion.id,
    isSuppressed ? 1 : 0, diffResult.summary, nowIso
  );
  enqueueNotificationForEvent(db, eventId);

  db.prepare(`
    UPDATE sub_state
    SET pending_candidate_hash = NULL, pending_candidate_checks = 0, pending_observation_id = NULL,
        last_alerted_hash = ?, last_alert_sent_at = ?
    WHERE subscription_id = ?
  `).run(hash, isSuppressed ? state.last_alert_sent_at : nowIso, sub.id);

  updateRollingWindow(db, sub.id, state.recent_checks_window, 'C');

  return {
    action: 'CHANGE_CONFIRMED',
    version: newVersion,
    contentHash: hash,
    storedText: normalized,
    changeEventId: eventId,
    isSuppressed,
  };
}
