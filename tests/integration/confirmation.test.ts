import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  evaluateSubscriptionChange,
  recordCheckFailure,
  type SubscriptionRecord,
} from '../../src/server/engine/changeDetector.js';
import { getVersionHistory } from '../../src/server/engine/versions.js';
import { captureFingerprint } from '../../src/server/capture/captureConfig.js';

interface SubStateTestRow {
  subscription_id: string;
  consecutive_failures: number;
  is_currently_down: number;
  pending_candidate_hash: string | null;
  pending_candidate_checks: number;
  is_noisy: number;
  recent_checks_window: string;
}

interface ChangeEventTestRow {
  id: string;
  subscription_id: string;
  event_type: string;
  suppressed: number;
  summary: string;
}

interface SubscriptionNextCheckRow {
  next_check_at: string;
}

describe('Phase 5 Integration: Confirmation, Cooldown, Noisy Flag & Outages (Acceptance Matrix J, P, Q)', () => {
  let db: Database.Database;
  const testDbPath = path.resolve('data', 'test-confirmation.db');

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = new Database(testDbPath);
    const schema = fs.readFileSync(path.resolve('src', 'server', 'db', 'schema.sql'), 'utf-8');
    db.exec(schema);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  function setupSubscription(): { subId: string; targetId: string } {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { config, fingerprint } = captureFingerprint({});

    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
      VALUES (?, 'test@example.com', 'h', 's', 1000, 'User')
    `).run(userId);

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://demo.example.com/item', 'demo.example.com', 'https://demo.example.com', ?)
    `).run(targetId, now);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, sensitivity,
        include_selectors, ignore_selectors, noise_filters,
        learned_ignore_patterns, created_at
      ) VALUES (?, ?, ?, 'Confirmation Monitor', 60, ?, ?, ?, 'balanced', '[]', '[]', '{"timestamps":true}', '[]', ?)
    `).run(subId, userId, targetId, now, JSON.stringify(config), fingerprint, now);

    db.prepare(`
      INSERT INTO sub_state (subscription_id, consecutive_failures, is_currently_down, recent_checks_window, is_noisy)
      VALUES (?, 0, 0, '[]', 0)
    `).run(subId);

    return { subId, targetId };
  }

  function makeObservation(targetId: string, dom: string, text: string): { id: string; sanitized_dom: string; raw_text: string } {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO observations (
        id, target_id, capture_fingerprint, engine_used, final_url,
        http_status, sanitized_dom, raw_text, subresource_count, captured_at
      ) VALUES (?, ?, 'fp', 'playwright', 'https://demo.example.com/item', 200, ?, ?, 0, datetime('now'))
    `).run(id, targetId, dom, text);

    return { id, sanitized_dom: dom, raw_text: text };
  }

  it('requires 2 consecutive matching checks to confirm a change and uses CONFIRM_DELAY (Acceptance Matrix P)', () => {
    const { subId, targetId } = setupSubscription();
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId) as SubscriptionRecord;

    const baselineDom = '<div><h1>Original Item</h1><p>Description text</p></div>';
    const baselineObs = makeObservation(targetId, baselineDom, 'Original Item\nDescription text');
    const now = 1_000_000;

    // 1. Initial check creates baseline
    const r1 = evaluateSubscriptionChange(db, sub, baselineObs, now);
    expect(r1.action).toBe('BASELINE_CREATED');

    // 2. Check with change -> Candidate recorded, quick recheck scheduled
    const candidateDom = '<div><h1>New Price Updated</h1><p>Description text</p></div>';
    const candidateObs1 = makeObservation(targetId, candidateDom, 'New Price Updated\nDescription text');
    const r2 = evaluateSubscriptionChange(db, sub, candidateObs1, now + 10_000);

    expect(r2.action).toBe('CANDIDATE_RECORDED');
    expect(r2.recheckDelayMs).toBe(120_000); // 2 minutes CONFIRM_DELAY_MS

    // Pending state populated
    const stateAfterCandidate = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateTestRow;
    expect(stateAfterCandidate.pending_candidate_hash).toBe(r2.contentHash);
    expect(stateAfterCandidate.pending_candidate_checks).toBe(1);

    // Verify next_check_at was set to now + CONFIRM_DELAY_MS
    const updatedSub = db.prepare('SELECT next_check_at FROM subscriptions WHERE id = ?').get(subId) as SubscriptionNextCheckRow;
    expect(new Date(updatedSub.next_check_at).getTime()).toBe(now + 10_000 + 120_000);

    // 3. Second check with SAME candidate -> CONFIRMED!
    const candidateObs2 = makeObservation(targetId, candidateDom, 'New Price Updated\nDescription text');
    const r3 = evaluateSubscriptionChange(db, sub, candidateObs2, now + 130_000);

    expect(r3.action).toBe('CHANGE_CONFIRMED');
    expect(r3.version?.version_number).toBe(2);

    // Pending state cleared
    const stateAfterConfirm = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateTestRow;
    expect(stateAfterConfirm.pending_candidate_hash).toBeNull();
    expect(stateAfterConfirm.pending_candidate_checks).toBe(0);

    // Change event created
    const events = db.prepare('SELECT * FROM change_events WHERE subscription_id = ?').all(subId) as ChangeEventTestRow[];
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('CHANGE');
    expect(events[0].suppressed).toBe(0);
  });

  it('discards candidate when page flips back to baseline before confirmation (Acceptance Matrix P)', () => {
    const { subId, targetId } = setupSubscription();
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId) as SubscriptionRecord;

    const baselineDom = '<div><h1>Stable Page</h1></div>';
    const baselineObs = makeObservation(targetId, baselineDom, 'Stable Page');
    const now = 1_000_000;

    // Baseline
    evaluateSubscriptionChange(db, sub, baselineObs, now);

    // Blip / Candidate
    const blipDom = '<div><h1>Temporary Blip</h1></div>';
    const blipObs = makeObservation(targetId, blipDom, 'Temporary Blip');
    const rBlip = evaluateSubscriptionChange(db, sub, blipObs, now + 1000);
    expect(rBlip.action).toBe('CANDIDATE_RECORDED');

    // Page flips back to baseline!
    const flipBackObs = makeObservation(targetId, baselineDom, 'Stable Page');
    const rFlipBack = evaluateSubscriptionChange(db, sub, flipBackObs, now + 2000);

    expect(rFlipBack.action).toBe('UNCHANGED');

    // Pending candidate cleared
    const state = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateTestRow;
    expect(state.pending_candidate_hash).toBeNull();
    expect(state.pending_candidate_checks).toBe(0);

    // Zero version 2 committed
    const history = getVersionHistory(db, subId);
    expect(history).toHaveLength(1);
    expect(history[0].version_number).toBe(1);
  });

  it('triggers DOWN alert after OUTAGE_THRESHOLD failed jobs and RECOVERED on next OK (Acceptance Matrix J)', () => {
    const { subId, targetId } = setupSubscription();
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId) as SubscriptionRecord;

    // Establish baseline
    const baseObs = makeObservation(targetId, '<div><h1>Site</h1></div>', 'Site');
    evaluateSubscriptionChange(db, sub, baseObs);

    // Simulate failure 1
    recordCheckFailure(db, subId, 'http_503');
    let state = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateTestRow;
    expect(state.consecutive_failures).toBe(1);
    expect(state.is_currently_down).toBe(0);

    // Simulate failure 2
    recordCheckFailure(db, subId, 'http_503');
    state = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateTestRow;
    expect(state.consecutive_failures).toBe(2);
    expect(state.is_currently_down).toBe(0);

    // Simulate failure 3 (OUTAGE_THRESHOLD reached: default 3)
    recordCheckFailure(db, subId, 'http_503');
    state = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateTestRow;
    expect(state.consecutive_failures).toBe(3);
    expect(state.is_currently_down).toBe(1);

    // Verify DOWN event
    let events = db.prepare('SELECT * FROM change_events WHERE subscription_id = ?').all(subId) as ChangeEventTestRow[];
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('DOWN');

    // Next check recovers!
    const recObs = makeObservation(targetId, '<div><h1>Site</h1></div>', 'Site');
    evaluateSubscriptionChange(db, sub, recObs);

    state = db.prepare('SELECT * FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateTestRow;
    expect(state.is_currently_down).toBe(0);
    expect(state.consecutive_failures).toBe(0);

    events = db.prepare('SELECT * FROM change_events WHERE subscription_id = ? ORDER BY created_at ASC').all(subId) as ChangeEventTestRow[];
    expect(events).toHaveLength(2);
    expect(events[1].event_type).toBe('RECOVERED');
  });

  it('suppresses alert within COOLDOWN_HOURS and flags noisy pages >70% candidates (Acceptance Matrix Q)', () => {
    const { subId, targetId } = setupSubscription();
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId) as SubscriptionRecord;

    const baseObs = makeObservation(targetId, '<div><h1>Initial</h1></div>', 'Initial');
    const now = 10_000_000;
    evaluateSubscriptionChange(db, sub, baseObs, now);

    // Change 1 confirmed at now + 1000
    const c1 = makeObservation(targetId, '<div><h1>Change 1</h1></div>', 'Change 1');
    evaluateSubscriptionChange(db, sub, c1, now + 1000);
    const conf1 = evaluateSubscriptionChange(db, sub, c1, now + 2000);
    expect(conf1.isSuppressed).toBe(false);

    // Change 2 confirmed 1 hour later (cooldown is 6 hours) -> suppressed = 1
    const oneHourLater = now + 2000 + (3600 * 1000);
    const c2 = makeObservation(targetId, '<div><h1>Change 2</h1></div>', 'Change 2');
    evaluateSubscriptionChange(db, sub, c2, oneHourLater);
    const conf2 = evaluateSubscriptionChange(db, sub, c2, oneHourLater + 1000);

    expect(conf2.isSuppressed).toBe(true);

    const events = db.prepare('SELECT * FROM change_events WHERE subscription_id = ? ORDER BY created_at DESC').all(subId) as ChangeEventTestRow[];
    expect(events[0].suppressed).toBe(1);

    // Test Noisy Flag: simulate frequent candidate changes >70% of last 10
    for (let i = 0; i < 8; i++) {
      const noisyObs = makeObservation(targetId, `<div><h1>Noise ${i}</h1></div>`, `Noise ${i}`);
      evaluateSubscriptionChange(db, sub, noisyObs, oneHourLater + 5000 + (i * 1000));
    }

    const noisyState = db.prepare('SELECT is_noisy, recent_checks_window FROM sub_state WHERE subscription_id = ?').get(subId) as SubStateTestRow;
    expect(noisyState.is_noisy).toBe(1);
  });
});
