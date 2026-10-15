import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { evaluateSubscriptionChange, type SubscriptionRecord } from '../../src/server/engine/changeDetector.js';

describe('STRETCH Feature: Keyword-Only Alerts (Row X2)', () => {
  const testDbPath = path.resolve(process.cwd(), './data/test_keywords.db');

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

  it('suppresses alert when changed content does not match keyword_rules, and alerts when keywords match', () => {
    const db = getDb(testDbPath);
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
      VALUES (?, 'kw@example.com', 'h', 's', 1000, 'User')
    `).run(userId);

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://example.com/kw', 'example.com', 'https://example.com', ?)
    `).run(targetId, nowIso);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, sensitivity,
        include_selectors, ignore_selectors, noise_filters,
        learned_ignore_patterns, keyword_rules, created_at
      ) VALUES (?, ?, ?, 'Keyword Sub', 15, ?, '{}', 'fp1', 'high', '[]', '[]', '{}', '[]', ?, ?)
    `).run(subId, userId, targetId, nowIso, JSON.stringify(['discount', 'sale']), nowIso);

    db.prepare(`
      INSERT INTO sub_state (subscription_id, consecutive_failures, is_currently_down, recent_checks_window)
      VALUES (?, 0, 0, '[]')
    `).run(subId);

    const sub: SubscriptionRecord = {
      id: subId,
      interval_minutes: 15,
      sensitivity: 'high',
      include_selectors: '[]',
      ignore_selectors: '[]',
      noise_filters: '{}',
      learned_ignore_patterns: '[]',
      keyword_rules: JSON.stringify(['discount', 'sale']),
    };

    const insertObs = (id: string, dom: string, text: string) => {
      db.prepare(`
        INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
        VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/kw', 200, ?, ?, ?)
      `).run(id, targetId, dom, text, nowIso);
      return { id, sanitized_dom: dom, raw_text: text };
    };

    // 1. First check establishes baseline Version 1
    const obs1 = insertObs(crypto.randomUUID(), '<html><body><p>Welcome to our store. All items regular price.</p></body></html>', 'Welcome to our store. All items regular price.');
    const res1 = evaluateSubscriptionChange(db, sub, obs1);
    expect(res1.action).toBe('BASELINE_CREATED');

    // 2. Change without matching keywords (candidate 1)
    const obsNoMatch = insertObs(crypto.randomUUID(), '<html><body><p>Welcome to our store. Updated hours of operation.</p></body></html>', 'Welcome to our store. Updated hours of operation.');
    evaluateSubscriptionChange(db, sub, obsNoMatch);
    // Confirmation check (candidate 2)
    const resNoMatch = evaluateSubscriptionChange(db, sub, obsNoMatch);
    expect(resNoMatch.action).toBe('CHANGE_CONFIRMED');
    expect(resNoMatch.isSuppressed).toBe(true);

    const eventNoMatch = db.prepare('SELECT suppressed, keyword_matches FROM change_events WHERE id = ?').get(resNoMatch.changeEventId) as { suppressed: number; keyword_matches: string };
    expect(eventNoMatch.suppressed).toBe(1);
    expect(JSON.parse(eventNoMatch.keyword_matches)).toEqual([]);

    // 3. Change WITH matching keyword 'discount' (candidate 1)
    const obsMatch = insertObs(crypto.randomUUID(), '<html><body><p>Welcome to our store. Huge discount on all items!</p></body></html>', 'Welcome to our store. Huge discount on all items!');
    evaluateSubscriptionChange(db, sub, obsMatch);
    // Confirmation check (candidate 2)
    const resMatch = evaluateSubscriptionChange(db, sub, obsMatch);
    expect(resMatch.action).toBe('CHANGE_CONFIRMED');
    expect(resMatch.isSuppressed).toBe(false);

    const eventMatch = db.prepare('SELECT suppressed, keyword_matches, summary FROM change_events WHERE id = ?').get(resMatch.changeEventId) as { suppressed: number; keyword_matches: string; summary: string };
    expect(eventMatch.suppressed).toBe(0);
    expect(JSON.parse(eventMatch.keyword_matches)).toContain('discount');
    expect(eventMatch.summary).toContain('discount');
  });
});
