import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { evaluateSubscriptionChange, type SubscriptionRecord } from '../../src/server/engine/changeDetector.js';
import { KeywordRulesArraySchema } from '../../src/server/engine/keywordRules.js';

interface TestObs {
  id: string;
  sanitized_dom: string;
  raw_text: string;
}

interface EventRow {
  suppressed: number;
  keyword_matches: string;
  summary?: string;
}

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

  function setupTestSub(db: Database, rules: unknown): {
    sub: SubscriptionRecord;
    targetId: string;
    insertObs: (id: string, dom: string, text: string) => TestObs;
  } {
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
    `).run(subId, userId, targetId, nowIso, JSON.stringify(rules), nowIso);

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
      keyword_rules: JSON.stringify(rules),
    };

    const insertObs = (id: string, dom: string, text: string) => {
      db.prepare(`
        INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
        VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/kw', 200, ?, ?, ?)
      `).run(id, targetId, dom, text, nowIso);
      return { id, sanitized_dom: dom, raw_text: text };
    };

    return { sub, targetId, insertObs };
  }

  it('Case 1 & 2: keyword matches -> alert sent; keyword missing -> change detected but notification suppressed', () => {
    const db = getDb(testDbPath);
    const { sub, insertObs } = setupTestSub(db, ['discount', 'sale']);

    // Baseline
    const obs1 = insertObs(crypto.randomUUID(), '<p>Regular price</p>', 'Regular price');
    expect(evaluateSubscriptionChange(db, sub, obs1).action).toBe('BASELINE_CREATED');

    // Change without matching keywords: confirmed but suppressed
    const obsNoMatch = insertObs(crypto.randomUUID(), '<p>Updated hours</p>', 'Updated hours');
    evaluateSubscriptionChange(db, sub, obsNoMatch);
    const resNoMatch = evaluateSubscriptionChange(db, sub, obsNoMatch);
    expect(resNoMatch.action).toBe('CHANGE_CONFIRMED');
    expect(resNoMatch.isSuppressed).toBe(true);

    const eventNoMatch = db.prepare('SELECT suppressed, keyword_matches FROM change_events WHERE id = ?').get(resNoMatch.changeEventId) as EventRow;
    expect(eventNoMatch.suppressed).toBe(1);
    expect(JSON.parse(eventNoMatch.keyword_matches)).toEqual([]);

    // Change with matching keyword: confirmed and alerted
    const obsMatch = insertObs(crypto.randomUUID(), '<p>Huge discount today!</p>', 'Huge discount today!');
    evaluateSubscriptionChange(db, sub, obsMatch);
    const resMatch = evaluateSubscriptionChange(db, sub, obsMatch);
    expect(resMatch.action).toBe('CHANGE_CONFIRMED');
    expect(resMatch.isSuppressed).toBe(false);

    const eventMatch = db.prepare('SELECT suppressed, keyword_matches, summary FROM change_events WHERE id = ?').get(resMatch.changeEventId) as EventRow;
    expect(eventMatch.suppressed).toBe(0);
    expect(JSON.parse(eventMatch.keyword_matches)).toContain('discount');
  });

  it('Case 3: regex pattern rule matches and triggers alert', () => {
    const db = getDb(testDbPath);
    const { sub, insertObs } = setupTestSub(db, [{ type: 'regex', pattern: 'save \\d+%' }]);

    // Baseline
    const obs1 = insertObs(crypto.randomUUID(), '<p>Full price</p>', 'Full price');
    evaluateSubscriptionChange(db, sub, obs1);

    // Matching change with regex 'save 40%'
    const obsRegex = insertObs(crypto.randomUUID(), '<p>Special: Save 40% this weekend!</p>', 'Special: Save 40% this weekend!');
    evaluateSubscriptionChange(db, sub, obsRegex);
    const resRegex = evaluateSubscriptionChange(db, sub, obsRegex);
    expect(resRegex.action).toBe('CHANGE_CONFIRMED');
    expect(resRegex.isSuppressed).toBe(false);

    const eventRegex = db.prepare('SELECT suppressed, keyword_matches FROM change_events WHERE id = ?').get(resRegex.changeEventId) as EventRow;
    expect(eventRegex.suppressed).toBe(0);
    expect(JSON.parse(eventRegex.keyword_matches)).toContain('save \\d+%');
  });

  it('Case 4: invalid regex syntax and ReDoS patterns are rejected by validation', () => {
    // 1. Valid regex passes
    const valid = KeywordRulesArraySchema.safeParse([{ type: 'regex', pattern: 'price:\\s*\\$\\d+' }]);
    expect(valid.success).toBe(true);

    // 2. Invalid regex syntax rejected
    const invalidSyntax = KeywordRulesArraySchema.safeParse([{ type: 'regex', pattern: '[unclosed group' }]);
    expect(invalidSyntax.success).toBe(false);

    // 3. ReDoS vulnerable nested quantifier rejected
    const redos = KeywordRulesArraySchema.safeParse([{ type: 'regex', pattern: '(a+)+' }]);
    expect(redos.success).toBe(false);

    // 4. Pattern exceeding 100 chars rejected
    const tooLong = KeywordRulesArraySchema.safeParse([{ type: 'regex', pattern: 'x'.repeat(101) }]);
    expect(tooLong.success).toBe(false);
  });
});
