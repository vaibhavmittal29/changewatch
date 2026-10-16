import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app.js';
import { getDb, setDb, closeDb } from '../../src/server/db/index.js';

describe('Phase 9: RSS Privacy & Feed Token Authentication', () => {
  let appServer: Server;
  let appUrl: string;
  let userACookie: string;
  let userBCookie: string;
  let userACsrf: string;
  let userBCsrf: string;
  let subAId: string;
  let feedTokenA: string;
  const testDbPath = path.resolve('data', 'test_rss_privacy.db');

  beforeAll(async () => {
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }

    setDb(null);
    process.env.DATABASE_PATH = testDbPath;
    const db = getDb(testDbPath);
    const schema = fs.readFileSync(path.resolve('src', 'server', 'db', 'schema.sql'), 'utf-8');
    db.exec(schema);

    const app = createApp();
    appServer = app.listen(0);
    const addr = appServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;
    appUrl = `http://127.0.0.1:${port}`;

    // Register User A
    const regResA = await fetch(`${appUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'usera@example.com', password: 'password123', displayName: 'User A' }),
    });
    const regDataA = await regResA.json() as { user: { id: string }; csrfToken: string };
    userACookie = regResA.headers.get('set-cookie')!.split(';')[0];
    userACsrf = regDataA.csrfToken;

    // Register User B
    const regResB = await fetch(`${appUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'userb@example.com', password: 'password123', displayName: 'User B' }),
    });
    const regDataB = await regResB.json() as { user: { id: string }; csrfToken: string };
    userBCookie = regResB.headers.get('set-cookie')!.split(';')[0];
    userBCsrf = regDataB.csrfToken;

    // Direct DB seeding for User A's subscription & target
    const targetId = crypto.randomUUID();
    subAId = crypto.randomUUID();
    feedTokenA = crypto.randomBytes(24).toString('hex');
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://example.com/feed-page', 'example.com', 'https://example.com', ?)
    `).run(targetId, now);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, feed_token, created_at
      ) VALUES (?, ?, ?, 'Alpha Feed', 15, ?, '{}', 'fp1', ?, ?)
    `).run(subAId, regDataA.user.id, targetId, now, feedTokenA, now);

    const obsId = crypto.randomUUID();
    const vId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at)
      VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/feed-page', 200, '<html></html>', 'text', 0, 1, ?)
    `).run(obsId, targetId, now);

    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
      VALUES (?, ?, ?, 1, 'hash1', 'v1 text', ?)
    `).run(vId, subAId, obsId, now);

    // Add change events to User A's subscription
    const eventId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO change_events (id, subscription_id, current_version_id, event_type, summary, created_at)
      VALUES (?, ?, ?, 'CHANGE', 'Headline updated to Version 2', datetime('now'))
    `).run(eventId, subAId, vId);
  });

  afterAll(async () => {
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
  });

  it('rejects unauthenticated requests without a feed token with 401', async () => {
    const res = await fetch(`${appUrl}/api/subscriptions/${subAId}/rss`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('Unauthorized: Missing feed token');
  });

  it('rejects requests with an invalid feed token with 403', async () => {
    const res = await fetch(`${appUrl}/api/subscriptions/${subAId}/rss?token=invalid_token_12345`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('Forbidden: Invalid feed token');
  });

  it('serves valid RSS 2.0 XML with valid token query parameter', async () => {
    const res = await fetch(`${appUrl}/api/subscriptions/${subAId}/rss?token=${feedTokenA}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');

    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('<channel>');
    expect(xml).toContain('<title>ChangeWatch: Alpha Feed</title>');
    expect(xml).toContain('<item>');
    expect(xml).toContain('Headline updated to Version 2');
    // Ensure no sensitive or private target URLs leaked
    expect(xml).not.toContain('http://127.0.0.1:4000');
  });

  it('serves valid RSS 2.0 XML when authenticated via Authorization Bearer header', async () => {
    const res = await fetch(`${appUrl}/api/subscriptions/${subAId}/rss`, {
      headers: { Authorization: `Bearer ${feedTokenA}` },
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('Alpha Feed');
  });

  it('rotates feed token and invalidates previous token', async () => {
    const rotateRes = await fetch(`${appUrl}/api/subscriptions/${subAId}/rotate-feed-token`, {
      method: 'POST',
      headers: {
        Cookie: userACookie,
        'X-CSRF-Token': userACsrf,
      },
    });
    expect(rotateRes.status).toBe(200);
    const rotateData = await rotateRes.json() as { feedToken: string; rssUrl: string };
    expect(rotateData.feedToken).toBeDefined();
    expect(rotateData.feedToken).not.toBe(feedTokenA);
    expect(rotateData.rssUrl).toContain(rotateData.feedToken);

    // Old token must now be rejected
    const oldRes = await fetch(`${appUrl}/api/subscriptions/${subAId}/rss?token=${feedTokenA}`);
    expect(oldRes.status).toBe(403);

    // New token must succeed
    const newRes = await fetch(`${appUrl}/api/subscriptions/${subAId}/rss?token=${rotateData.feedToken}`);
    expect(newRes.status).toBe(200);
  });

  it('prevents User B from rotating User A feed token', async () => {
    const crossRes = await fetch(`${appUrl}/api/subscriptions/${subAId}/rotate-feed-token`, {
      method: 'POST',
      headers: {
        Cookie: userBCookie,
        'X-CSRF-Token': userBCsrf,
      },
    });
    expect(crossRes.status).toBe(404);
  });
});
