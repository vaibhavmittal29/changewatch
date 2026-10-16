import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/server/app.js';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { startDemoServer } from '../../src/server/demo/demoServer.js';
import { captureHttpDom } from '../../src/server/capture/httpDomCapture.js';
import { captureFingerprint } from '../../src/server/capture/captureConfig.js';
import { generateChangeSummary } from '../../src/server/engine/geminiSummary.js';

describe('STRETCH Features: http_dom, Gemini, Numeric History, RSS', () => {
  let appServer: Server;
  let demoServer: Server;
  let appUrl: string;
  const testDbPath = path.resolve(process.cwd(), './data/test_stretch_features.db');
  let authCookie = '';
  let subId = '';

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';

    const db = getDb(testDbPath);
    migrate(db);

    demoServer = await startDemoServer(4000);

    const app = createApp();
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, () => {
        const addr = appServer.address();
        if (typeof addr === 'object' && addr !== null) {
          appUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    // Register test user
    const regRes = await fetch(`${appUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'stretch_user@example.com', password: 'password123', displayName: 'Stretch User' }),
    });
    authCookie = regRes.headers.get('set-cookie')?.split(';')[0] || '';
    const regData = (await regRes.json()) as { user: { id: string } };

    // Create target and subscription
    const targetId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(targetId, 'http://127.0.0.1:4000/demo/price', '127.0.0.1', 'http://127.0.0.1:4000');

    subId = crypto.randomUUID();
    const fp = 'fp_default';
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes,
        next_check_at, capture_config, capture_fingerprint, feed_token, created_at
      ) VALUES (?, ?, ?, ?, 15, datetime('now'), '{}', ?, 'test_rss_token', datetime('now'))
    `).run(subId, regData.user.id, targetId, 'Price Watch', fp);

    // Insert observations & monitor_versions with numeric price values
    const obs1Id = crypto.randomUUID();
    const obs2Id = crypto.randomUUID();
    const v1Id = crypto.randomUUID();
    const v2Id = crypto.randomUUID();

    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at)
      VALUES (?, ?, ?, 'playwright', 'http://127.0.0.1:4000/demo/price', 200, '<html></html>', 'text1', 0, 1, datetime('now', '-2 hours'))
    `).run(obs1Id, targetId, fp);
    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
      VALUES (?, ?, ?, 1, 'hash1', 'Current Price: $49.99 in stock', datetime('now', '-2 hours'))
    `).run(v1Id, subId, obs1Id);

    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at)
      VALUES (?, ?, ?, 'playwright', 'http://127.0.0.1:4000/demo/price', 200, '<html></html>', 'text2', 0, 1, datetime('now', '-1 hour'))
    `).run(obs2Id, targetId, fp);
    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
      VALUES (?, ?, ?, 2, 'hash2', 'Current Price: $29.99 on sale', datetime('now', '-1 hour'))
    `).run(v2Id, subId, obs2Id);

    // Insert change event
    const eventId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO change_events (id, subscription_id, previous_version_id, current_version_id, event_type, summary, created_at)
      VALUES (?, ?, ?, ?, 'CHANGE', 'Price dropped from $49.99 to $29.99', datetime('now', '-1 hour'))
    `).run(eventId, subId, v1Id, v2Id);
  });

  afterAll(async () => {
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    await new Promise<void>((resolve) => demoServer.close(() => resolve()));
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
  });

  it('Requirement X1: captures page using lightweight http_dom engine without Playwright', async () => {
    const { config } = captureFingerprint({ engine: 'http_dom' });
    const result = await captureHttpDom('http://127.0.0.1:4000/demo/stable', config);

    expect(result.httpStatus).toBe(200);
    expect(result.rawText.includes('ChangeWatch Stable Documentation')).toBe(true);
    expect(result.screenshotPath).toBeNull();
    expect(result.subresourceCount).toBe(0);
    expect(result.topLevelNavigations).toBe(1);
    expect(result.pageTooLarge).toBe(false);
  });

  it('Requirement X2: gracefully falls back to deterministic rule-based summary when GEMINI_API_KEY is unset', async () => {
    const fallback = await generateChangeSummary('+ New line item', 'Added 1 line');
    expect(fallback.source).toBe('rule_based');
    expect(fallback.summary).toBe('Added 1 line');
  });

  it('Requirement X2: extracts numeric history points across versions for Chart.js', async () => {
    const res = await fetch(`${appUrl}/api/subscriptions/${subId}/numeric-history`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { subscriptionId: string; points: Array<{ versionNumber: number; value: number }> };

    expect(data.subscriptionId).toBe(subId);
    expect(data.points.length).toBe(2);
    expect(data.points[0].versionNumber).toBe(1);
    expect(data.points[0].value).toBe(49.99);
    expect(data.points[1].versionNumber).toBe(2);
    expect(data.points[1].value).toBe(29.99);
  });

  it('Requirement X2: serves valid RSS 2.0 XML feed of change events with feed token', async () => {
    const unauth = await fetch(`${appUrl}/api/subscriptions/${subId}/rss`);
    expect(unauth.status).toBe(401);

    const res = await fetch(`${appUrl}/api/subscriptions/${subId}/rss?token=test_rss_token`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');

    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('<channel>');
    expect(xml).toContain('<title>ChangeWatch: Price Watch</title>');
    expect(xml).toContain('<item>');
    expect(xml).toContain('Price dropped from $49.99 to $29.99');
  });
});
