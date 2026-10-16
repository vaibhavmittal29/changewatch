import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../src/server/config.js';
import { createApp } from '../../src/server/app.js';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { escapeXml, escapeCdata, extractNumericValue } from '../../src/server/routes/stretchFeatures.js';
import { processDailyDigest } from '../../src/server/notifications/digest.js';
import { evaluateSubscriptionChange, type SubscriptionRecord, type ObservationRecord } from '../../src/server/engine/changeDetector.js';
import * as imageDiffModule from '../../src/server/engine/imageDiff.js';

let testDbPath: string;
let db: Database.Database;

describe('Phase D: Output Correctness (RSS, Digest Suppression, Numeric Extraction, Diff Caching)', () => {
  beforeEach(() => {
    testDbPath = path.join(process.cwd(), `test_phase_d_${crypto.randomUUID()}.db`);
    process.env.DATABASE_PATH = testDbPath;
    process.env.APP_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.COOKIE_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.DATA_DIR = path.join(process.cwd(), `test_data_d_${crypto.randomUUID()}`);
    env.DATA_DIR = process.env.DATA_DIR;
    fs.mkdirSync(path.join(process.env.DATA_DIR, 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(process.env.DATA_DIR, 'diffs'), { recursive: true });

    db = getDb(testDbPath);
    migrate(db);
  });

  afterEach(() => {
    try {
      closeDb();
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
      if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
      if (process.env.DATA_DIR && fs.existsSync(process.env.DATA_DIR)) {
        fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
      }
    } catch {}
    vi.restoreAllMocks();
  });

  describe('1. RSS XML Escaping & CDATA Safety', () => {
    it('escapes XML special characters without stripping content', () => {
      const escaped = escapeXml('Tom & Jerry <cartoon> "funny" \'show\'');
      expect(escaped).toBe('Tom &amp; Jerry &lt;cartoon&gt; &quot;funny&quot; &apos;show&apos;');
    });

    it('safely escapes CDATA terminator ]]> into separate CDATA blocks', () => {
      const raw = 'Text with ]]> inside';
      const cdataSafe = escapeCdata(raw);
      expect(cdataSafe).toBe('Text with ]]]]><![CDATA[> inside');
      expect(`<![CDATA[${cdataSafe}]]>`).toBe('<![CDATA[Text with ]]]]><![CDATA[> inside]]>');
    });

    it('generates valid RSS feed retaining & and < characters in title and CDATA summary', async () => {
      const app = createApp();
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const userId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
          VALUES (?, 'rssuser@example.com', 'h', 's', 1000, 'RSS User')
        `).run(userId);

        const targetId = crypto.randomUUID();
        db.prepare('INSERT INTO targets (id, canonical_url, hostname, origin) VALUES (?, \'https://example.com/rss\', \'example.com\', \'https://example.com\')').run(targetId);

        const subId = crypto.randomUUID();
        const token = 'feed-token-xyz-123';
        db.prepare(`
          INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint, feed_token)
          VALUES (?, ?, ?, 'Tech & Gadgets <Daily>', 30, datetime('now'), '{}', 'fp1', ?)
        `).run(subId, userId, targetId, token);

        const obsId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
          VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/rss', 200, '<p>rss</p>', 'rss', datetime('now'))
        `).run(obsId, targetId);

        const v1Id = crypto.randomUUID();
        db.prepare(`
          INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
          VALUES (?, ?, ?, 1, 'h1', 'rss', datetime('now'))
        `).run(v1Id, subId, obsId);

        db.prepare(`
          INSERT INTO change_events (id, subscription_id, current_version_id, event_type, summary, created_at)
          VALUES (?, ?, ?, 'CHANGE', 'Price: $100 & Discount < 20% with ]]> tag', datetime('now'))
        `).run(crypto.randomUUID(), subId, v1Id);

        const res = await fetch(`${baseUrl}/api/subscriptions/${subId}/rss?token=${token}`);
        expect(res.status).toBe(200);
        const xml = await res.text();

        expect(xml).toContain('ChangeWatch: Tech &amp; Gadgets &lt;Daily&gt;');
        expect(xml).toContain('Tech &amp; Gadgets &lt;Daily&gt; - Price: $100 &amp; Discount &lt; 20% with ]]&gt; tag');
        expect(xml).toContain('<![CDATA[Price: $100 & Discount < 20% with ]]]]><![CDATA[> tag]]>');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('2. Daily Digest Suppression Reason Segregation', () => {
    it('sets suppression_reason = cooldown and includes in digest, but excludes keyword_unmatched', () => {
      const userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name, digest_enabled)
        VALUES (?, 'digest_user@example.com', 'h', 's', 1000, 'Digest User', 1)
      `).run(userId);

      const targetId = crypto.randomUUID();
      db.prepare('INSERT INTO targets (id, canonical_url, hostname, origin) VALUES (?, \'https://example.com/digest\', \'example.com\', \'https://example.com\')').run(targetId);

      const subId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint, keyword_rules)
        VALUES (?, ?, ?, 'Digest Sub', 30, datetime('now'), '{}', 'fp1', '["sale"]')
      `).run(subId, userId, targetId);

      const obsId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
        VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/digest', 200, '<p>d</p>', 'd', datetime('now'))
      `).run(obsId, targetId);

      const v1Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
        VALUES (?, ?, ?, 1, 'h1', 'd', datetime('now'))
      `).run(v1Id, subId, obsId);

      // Event 1: Cooldown suppressed (should be in digest)
      const ev1Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO change_events (id, subscription_id, current_version_id, event_type, suppressed, suppression_reason, summary, created_at)
        VALUES (?, ?, ?, 'CHANGE', 1, 'cooldown', 'Price updated during cooldown', datetime('now'))
      `).run(ev1Id, subId, v1Id);

      // Event 2: Keyword unmatched suppressed (should NOT be in digest)
      const ev2Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO change_events (id, subscription_id, current_version_id, event_type, suppressed, suppression_reason, summary, created_at)
        VALUES (?, ?, ?, 'CHANGE', 1, 'keyword_unmatched', 'Footer copyright changed (no sale keyword)', datetime('now'))
      `).run(ev2Id, subId, v1Id);

      const digestsCreated = processDailyDigest(db);
      expect(digestsCreated).toBeGreaterThanOrEqual(1);

      const outbox = db.prepare('SELECT payload FROM notification_outbox WHERE user_id = ? AND kind = \'DIGEST\'').get(userId) as { payload: string };
      expect(outbox).toBeTruthy();
      const payload = JSON.parse(outbox.payload);
      expect(payload.summary).toContain('Price updated during cooldown');
      expect(payload.summary).not.toContain('Footer copyright changed');
    });

    it('sets suppression_reason = keyword_unmatched when change occurs but keyword rules fail', () => {
      const userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
        VALUES (?, 'eval_user@example.com', 'h', 's', 1000, 'Eval User')
      `).run(userId);

      const targetId = crypto.randomUUID();
      db.prepare('INSERT INTO targets (id, canonical_url, hostname, origin) VALUES (?, \'https://example.com/eval\', \'example.com\', \'https://example.com\')').run(targetId);

      const subId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint, keyword_rules)
        VALUES (?, ?, ?, 'Eval Sub', 30, datetime('now'), '{}', 'fp1', '["mandatory-sale"]')
      `).run(subId, userId, targetId);

      const sub: SubscriptionRecord = {
        id: subId,
        interval_minutes: 30,
        sensitivity: 'low',
        include_selectors: '[]',
        ignore_selectors: '[]',
        noise_filters: '{}',
        learned_ignore_patterns: '[]',
        keyword_rules: '["mandatory-sale"]',
      };

      // 1. Baseline observation
      const obs1: ObservationRecord = { id: crypto.randomUUID(), sanitized_dom: '<p>Initial content baseline</p>', raw_text: 'Initial content baseline' };
      db.prepare(`
        INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
        VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/eval', 200, ?, ?, datetime('now'))
      `).run(obs1.id, targetId, obs1.sanitized_dom, obs1.raw_text);

      const res1 = evaluateSubscriptionChange(db, sub, obs1);
      expect(res1.action).toBe('BASELINE_CREATED');

      // 2. Candidate observation (different text, no "mandatory-sale")
      const obs2: ObservationRecord = { id: crypto.randomUUID(), sanitized_dom: '<p>Completely different updated content</p>', raw_text: 'Completely different updated content' };
      db.prepare(`
        INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
        VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/eval', 200, ?, ?, datetime('now'))
      `).run(obs2.id, targetId, obs2.sanitized_dom, obs2.raw_text);

      const res2 = evaluateSubscriptionChange(db, sub, obs2);
      expect(res2.action).toBe('CANDIDATE_RECORDED');

      // 3. Confirm candidate with same text
      const obs3: ObservationRecord = { id: crypto.randomUUID(), sanitized_dom: '<p>Completely different updated content</p>', raw_text: 'Completely different updated content' };
      db.prepare(`
        INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
        VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/eval', 200, ?, ?, datetime('now'))
      `).run(obs3.id, targetId, obs3.sanitized_dom, obs3.raw_text);

      const res3 = evaluateSubscriptionChange(db, sub, obs3);
      expect(res3.action).toBe('CHANGE_CONFIRMED');

      const eventRow = db.prepare('SELECT suppressed, suppression_reason FROM change_events WHERE subscription_id = ? AND event_type = \'CHANGE\'').get(subId) as { suppressed: number; suppression_reason: string };
      expect(eventRow.suppressed).toBe(1);
      expect(eventRow.suppression_reason).toBe('keyword_unmatched');
    });
  });

  describe('3. Labeled Numeric Extraction & Numeric History', () => {
    it('extracts specific labeled number when multiple numbers are present on the page', () => {
      const pageText = 'Date: 2026-10-16. Views: 12,450 users. Price: $299.99 USD. Discount: -15%.';

      const priceVal = extractNumericValue(pageText, 'Price');
      expect(priceVal).toBe(299.99);

      const viewsVal = extractNumericValue(pageText, 'Views');
      expect(viewsVal).toBe(12450);

      const discountVal = extractNumericValue(pageText, 'Discount');
      expect(discountVal).toBe(-15);

      // Fallback to first number when label is unspecified
      const firstVal = extractNumericValue(pageText);
      expect(firstVal).toBe(2026);

      // Return null when text has no number
      expect(extractNumericValue('No numbers here at all', 'Price')).toBeNull();
      expect(extractNumericValue('', 'Price')).toBeNull();
    });

    it('returns filtered points when label query param is supplied to /api/subscriptions/:id/numeric-history', async () => {
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
          body: JSON.stringify({ email: 'numeric_user@example.com', password: 'password123', displayName: 'Numeric User' }),
        });
        const userCookie = regRes.headers.get('set-cookie')?.split(';')[0] || '';
        const regBody = await regRes.json() as { user: { id: string } };
        const userId = regBody.user.id;

        const targetId = crypto.randomUUID();
        db.prepare('INSERT INTO targets (id, canonical_url, hostname, origin) VALUES (?, \'https://example.com/num\', \'example.com\', \'https://example.com\')').run(targetId);

        const subId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint)
          VALUES (?, ?, ?, 'Num Sub', 30, datetime('now'), '{}', 'fp1')
        `).run(subId, userId, targetId);

        const obsId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
          VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/num', 200, '<p>Text</p>', 'Text', datetime('now'))
        `).run(obsId, targetId);

        db.prepare(`
          INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
          VALUES (?, ?, ?, 1, 'h1', 'Views: 50. Price: $99', datetime('now'))
        `).run(crypto.randomUUID(), subId, obsId);

        db.prepare(`
          INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
          VALUES (?, ?, ?, 2, 'h2', 'Views: 120. Price: $149', datetime('now'))
        `).run(crypto.randomUUID(), subId, obsId);

        // Fetch without label -> returns first numbers (Views: 50, 120)
        const resNoLabel = await fetch(`${baseUrl}/api/subscriptions/${subId}/numeric-history`, {
          headers: { Cookie: userCookie },
        });
        expect(resNoLabel.status).toBe(200);
        const dataNoLabel = await resNoLabel.json() as { points: Array<{ value: number }> };
        expect(dataNoLabel.points.map(p => p.value)).toEqual([50, 120]);

        // Fetch with label=Price -> returns Price values (99, 149)
        const resPrice = await fetch(`${baseUrl}/api/subscriptions/${subId}/numeric-history?label=Price`, {
          headers: { Cookie: userCookie },
        });
        expect(resPrice.status).toBe(200);
        const dataPrice = await resPrice.json() as { points: Array<{ value: number }> };
        expect(dataPrice.points.map(p => p.value)).toEqual([99, 149]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('4. Diff Image Caching & Security Isolation', () => {
    it('caches computed diff image and metadata, and reuses cache on subsequent calls', async () => {
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
          body: JSON.stringify({ email: 'diff_user@example.com', password: 'password123', displayName: 'Diff User' }),
        });
        const userCookie = regRes.headers.get('set-cookie')?.split(';')[0] || '';
        const regBody = await regRes.json() as { user: { id: string } };
        const userId = regBody.user.id;

        const targetId = crypto.randomUUID();
        db.prepare('INSERT INTO targets (id, canonical_url, hostname, origin) VALUES (?, \'https://example.com/diff\', \'example.com\', \'https://example.com\')').run(targetId);

        const subId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint)
          VALUES (?, ?, ?, 'Diff Sub', 30, datetime('now'), '{}', 'fp1')
        `).run(subId, userId, targetId);

        // Create 2 valid 1x1 PNG files
        const fakePngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        const screen1Path = path.join(process.env.DATA_DIR!, 'screenshots', 'obs1.png');
        const screen2Path = path.join(process.env.DATA_DIR!, 'screenshots', 'obs2.png');
        fs.writeFileSync(screen1Path, fakePngBuffer);
        fs.writeFileSync(screen2Path, fakePngBuffer);

        const obs1Id = crypto.randomUUID();
        const obs2Id = crypto.randomUUID();
        db.prepare(`
          INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
          VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/diff', 200, '<p>1</p>', '1', ?, datetime('now'))
        `).run(obs1Id, targetId, screen1Path);
        db.prepare(`
          INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
          VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/diff', 200, '<p>2</p>', '2', ?, datetime('now'))
        `).run(obs2Id, targetId, screen2Path);

        const v1Id = crypto.randomUUID();
        const v2Id = crypto.randomUUID();
        db.prepare(`
          INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
          VALUES (?, ?, ?, 1, 'h1', '1', datetime('now'))
        `).run(v1Id, subId, obs1Id);
        db.prepare(`
          INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
          VALUES (?, ?, ?, 2, 'h2', '2', datetime('now'))
        `).run(v2Id, subId, obs2Id);

        const computeSpy = vi.spyOn(imageDiffModule, 'computeImageDiff');

        // First call: computes and creates cache
        const res1 = await fetch(`${baseUrl}/api/diff/image?from=${v1Id}&to=${v2Id}`, {
          headers: { Cookie: userCookie },
        });
        expect(res1.status).toBe(200);
        expect(computeSpy).toHaveBeenCalledTimes(1);

        // Verify cache files exist on disk
        const cachedImgPath = path.join(process.env.DATA_DIR!, 'diffs', `diff_${v1Id}_${v2Id}.png`);
        const cachedMetaPath = path.join(process.env.DATA_DIR!, 'diffs', `diff_${v1Id}_${v2Id}.json`);
        expect(fs.existsSync(cachedImgPath)).toBe(true);
        expect(fs.existsSync(cachedMetaPath)).toBe(true);

        // Second call: reuses cache without invoking computeImageDiff again
        const res2 = await fetch(`${baseUrl}/api/diff/image?from=${v1Id}&to=${v2Id}`, {
          headers: { Cookie: userCookie },
        });
        expect(res2.status).toBe(200);
        expect(computeSpy).toHaveBeenCalledTimes(1); // Still 1!
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('enforces ownership before serving cached diff image', async () => {
      const app = createApp();
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        // Register User A (owner)
        const regA = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'userA_d@example.com', password: 'password123', displayName: 'User A' }),
        });
        const regABody = await regA.json() as { user: { id: string } };
        const userAId = regABody.user.id;

        // Register User B (attacker)
        const regB = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'userB_d@example.com', password: 'password123', displayName: 'User B' }),
        });
        const userBCookie = regB.headers.get('set-cookie')?.split(';')[0] || '';

        const targetId = crypto.randomUUID();
        db.prepare('INSERT INTO targets (id, canonical_url, hostname, origin) VALUES (?, \'https://example.com/sec\', \'example.com\', \'https://example.com\')').run(targetId);

        const subId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint)
          VALUES (?, ?, ?, 'A Sub', 30, datetime('now'), '{}', 'fp1')
        `).run(subId, userAId, targetId);

        const obsId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
          VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/sec', 200, '<p>1</p>', '1', datetime('now'))
        `).run(obsId, targetId);

        const v1Id = crypto.randomUUID();
        const v2Id = crypto.randomUUID();
        db.prepare('INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at) VALUES (?, ?, ?, 1, \'h1\', \'1\', datetime(\'now\'))').run(v1Id, subId, obsId);
        db.prepare('INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at) VALUES (?, ?, ?, 2, \'h2\', \'2\', datetime(\'now\'))').run(v2Id, subId, obsId);

        // Create diff file on disk
        const cachedImgPath = path.join(process.env.DATA_DIR!, 'diffs', `diff_${v1Id}_${v2Id}.png`);
        fs.writeFileSync(cachedImgPath, Buffer.from('fake-diff-png'));

        // User B attempts to access cached diff image
        const res = await fetch(`${baseUrl}/api/diff/image-file/diff_${v1Id}_${v2Id}.png`, {
          headers: { Cookie: userBCookie },
        });
        expect(res.status).toBe(404);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
