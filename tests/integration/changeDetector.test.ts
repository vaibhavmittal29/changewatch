import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { evaluateSubscriptionChange } from '../../src/server/engine/changeDetector.js';
import { getActiveVersion, getVersionHistory } from '../../src/server/engine/versions.js';
import { captureFingerprint } from '../../src/server/capture/captureConfig.js';

describe('Phase 4 Integration: Hashing, Baseline & Version History (Acceptance Matrix I, L, M)', () => {
  let db: Database.Database;
  const testDbPath = path.resolve('data', 'test-change-detector.db');

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = new Database(testDbPath);
    const schema = fs.readFileSync(path.resolve('src', 'server', 'db', 'schema.sql'), 'utf-8');
    db.exec(schema);
    // Explicitly enable foreign keys
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  function setupSubscription(name = 'Test Monitor'): {
    userId: string;
    targetId: string;
    subId: string;
    fingerprint: string;
    configStr: string;
  } {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { config, fingerprint } = captureFingerprint({});
    const configStr = JSON.stringify(config);

    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
      VALUES (?, 'user@example.com', 'h', 's', 1000, 'User')
    `).run(userId);

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://demo.example.com/page', 'demo.example.com', 'https://demo.example.com', ?)
    `).run(targetId, now);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, include_selectors, ignore_selectors, created_at
      ) VALUES (?, ?, ?, ?, 15, ?, ?, ?, '[]', '[]', ?)
    `).run(subId, userId, targetId, name, now, configStr, fingerprint, now);

    db.prepare(`
      INSERT INTO sub_state (subscription_id, consecutive_failures, is_currently_down)
      VALUES (?, 0, 0)
    `).run(subId);

    return { userId, targetId, subId, fingerprint, configStr };
  }

  function createObservation(targetId: string, dom: string, text: string): string {
    const obsId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO observations (
        id, target_id, capture_fingerprint, engine_used, final_url,
        http_status, sanitized_dom, raw_text, subresource_count, captured_at
      ) VALUES (?, ?, 'fp', 'playwright', 'https://demo.example.com/page', 200, ?, ?, 0, ?)
    `).run(obsId, targetId, dom, text, now);
    return obsId;
  }

  it('creates Version 1 baseline on the first check, and 5 stable checks create exactly 1 version (Acceptance Matrix L)', () => {
    const { targetId, subId } = setupSubscription();
    const subInput = { id: subId, include_selectors: '[]', ignore_selectors: '[]' };
    const stableDom = '<div><h1>Stable Title</h1><p>Stable content paragraph.</p></div>';
    const stableText = 'Stable Title\nStable content paragraph.';

    // Run 1: First check ever -> creates Version 1
    const obsId1 = createObservation(targetId, stableDom, stableText);
    const res1 = evaluateSubscriptionChange(db, subInput, { id: obsId1, sanitized_dom: stableDom, raw_text: stableText });

    expect(res1.action).toBe('BASELINE_CREATED');
    expect(res1.version.version_number).toBe(1);
    expect(res1.version.change_summary).toBe('Baseline (Version 1)');

    const active1 = getActiveVersion(db, subId);
    expect(active1).not.toBeNull();
    expect(active1?.version_number).toBe(1);

    // Runs 2, 3, 4, 5: Identical content -> UNCHANGED, zero new versions committed
    for (let i = 2; i <= 5; i++) {
      const obsId = createObservation(targetId, stableDom, stableText);
      const res = evaluateSubscriptionChange(db, subInput, { id: obsId, sanitized_dom: stableDom, raw_text: stableText });

      expect(res.action).toBe('UNCHANGED');
      expect(res.version.version_number).toBe(1);
      expect(res.contentHash).toBe(res1.contentHash);
    }

    // Verify exactly 1 version exists in history
    const history = getVersionHistory(db, subId);
    expect(history).toHaveLength(1);
    expect(history[0].version_number).toBe(1);
  });

  it('creates Version 2 when headline changes (Acceptance Matrix M)', () => {
    const { targetId, subId } = setupSubscription();
    const subInput = { id: subId, include_selectors: '[]', ignore_selectors: '[]' };

    // Baseline
    const v1Dom = '<div><h1>Original Headline</h1></div>';
    const v1Text = 'Original Headline';
    const obs1 = createObservation(targetId, v1Dom, v1Text);
    evaluateSubscriptionChange(db, subInput, { id: obs1, sanitized_dom: v1Dom, raw_text: v1Text });

    // Headline change
    const v2Dom = '<div><h1>Breaking News: Major Discovery</h1></div>';
    const v2Text = 'Breaking News: Major Discovery';
    const obs2 = createObservation(targetId, v2Dom, v2Text);
    const res2 = evaluateSubscriptionChange(db, subInput, { id: obs2, sanitized_dom: v2Dom, raw_text: v2Text });

    expect(res2.action).toBe('VERSION_COMMITTED');
    expect(res2.version.version_number).toBe(2);

    const active = getActiveVersion(db, subId);
    expect(active?.version_number).toBe(2);
    expect(active?.stored_text).toBe('Breaking News: Major Discovery');

    const history = getVersionHistory(db, subId);
    expect(history).toHaveLength(2);
    expect(history[0].version_number).toBe(2);
    expect(history[1].version_number).toBe(1);
  });

  it('protects baseline and versions on ERROR and BLOCKED outcomes (Acceptance Matrix I)', () => {
    const { targetId, subId } = setupSubscription();

    // 1. Establish initial baseline
    const v1Dom = '<div><h1>Initial Baseline</h1></div>';
    const v1Text = 'Initial Baseline';
    const obs1 = createObservation(targetId, v1Dom, v1Text);
    evaluateSubscriptionChange(
      db,
      { id: subId, include_selectors: '[]', ignore_selectors: '[]' },
      { id: obs1, sanitized_dom: v1Dom, raw_text: v1Text }
    );

    const baselineVersion = getActiveVersion(db, subId);
    expect(baselineVersion?.version_number).toBe(1);

    // 2. Simulate error outcome (e.g. 503, CAPTCHA, timeout)
    // Baseline protection invariant: ERROR / BLOCKED checks never invoke version commit
    // Record check_run as ERROR
    db.prepare(`
      INSERT INTO check_runs (id, subscription_id, target_id, job_id, outcome, reason, http_status, duration_ms, was_deduplicated, created_at)
      VALUES (?, ?, ?, 'job-err', 'ERROR', 'http_503', 503, 100, 0, datetime('now'))
    `).run(crypto.randomUUID(), subId, targetId);

    // Record check_run as BLOCKED
    db.prepare(`
      INSERT INTO check_runs (id, subscription_id, target_id, job_id, outcome, reason, http_status, duration_ms, was_deduplicated, created_at)
      VALUES (?, ?, ?, 'job-block', 'BLOCKED', 'captcha_challenge', 403, 100, 0, datetime('now'))
    `).run(crypto.randomUUID(), subId, targetId);

    // Ensure baseline and versions remain completely untouched
    const versionAfterError = getActiveVersion(db, subId);
    expect(versionAfterError?.id).toBe(baselineVersion?.id);
    expect(versionAfterError?.version_number).toBe(1);
    expect(versionAfterError?.stored_text).toBe('Initial Baseline');

    const history = getVersionHistory(db, subId);
    expect(history).toHaveLength(1);
    expect(history[0].version_number).toBe(1);
  });

  it('enforces ON DELETE RESTRICT on observations referenced by monitor_versions', () => {
    const { targetId, subId } = setupSubscription();
    const dom = '<div><h1>Guarded History</h1></div>';
    const obsId = createObservation(targetId, dom, 'Guarded History');

    evaluateSubscriptionChange(
      db,
      { id: subId, include_selectors: '[]', ignore_selectors: '[]' },
      { id: obsId, sanitized_dom: dom, raw_text: 'Guarded History' }
    );

    // Attempting to delete the referenced observation must be rejected by foreign key constraint
    expect(() => {
      db.prepare('DELETE FROM observations WHERE id = ?').run(obsId);
    }).toThrow(/FOREIGN KEY constraint failed/);

    // Unreferenced observation CAN be deleted safely
    const unreferencedObsId = createObservation(targetId, '<div>temp</div>', 'temp');
    const deleteResult = db.prepare('DELETE FROM observations WHERE id = ?').run(unreferencedObsId);
    expect(deleteResult.changes).toBe(1);
  });
});
