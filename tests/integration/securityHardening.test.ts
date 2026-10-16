import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/server/app.js';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { validateRouteUrl } from '../../src/server/capture/routeValidation.js';
import { validateDestinationConfig, escapeHtml, sanitizeUrl } from '../../src/server/notifications/configValidation.js';
import { env } from '../../src/server/config.js';

describe('CW-SEC Security Hardening (CW-SEC-01 through CW-SEC-07)', () => {
  let server: Server;
  let baseUrl: string;
  const testDbPath = path.resolve(process.cwd(), './data/test_sec_hardening.db');
  let userACookie = '';
  let userBCookie = '';
  let userACsrf = '';
  let userBCsrf = '';
  let userAId = '';
  let destAId = '';
  let obsAId = '';
  let verA1Id = '';
  let verA2Id = '';

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';

    const db = getDb(testDbPath);
    migrate(db);

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (typeof address === 'object' && address !== null) {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });

    // Register User A
    const resA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'userA@sec.local', password: 'Password123!', displayName: 'User A' }),
    });
    userACookie = resA.headers.get('set-cookie')?.split(';')[0] || '';
    const bodyA = await resA.json() as { csrfToken: string; user: { id: string } };
    userACsrf = bodyA.csrfToken;
    userAId = bodyA.user.id;

    // Register User B
    const resB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'userB@sec.local', password: 'Password123!', displayName: 'User B' }),
    });
    userBCookie = resB.headers.get('set-cookie')?.split(';')[0] || '';
    const bodyB = await resB.json() as { csrfToken: string };
    userBCsrf = bodyB.csrfToken;

    // Create Destination for User A
    const destRes = await fetch(`${baseUrl}/api/destinations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: userACookie, 'x-csrf-token': userACsrf },
      body: JSON.stringify({
        channel: 'discord',
        config: { webhookUrl: 'https://discord.com/api/webhooks/111222333/validtoken123' },
      }),
    });
    const destBody = await destRes.json() as { id: string };
    destAId = destBody.id;

    // Seed observation, subscription, and versions for User A
    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    obsAId = crypto.randomUUID();
    verA1Id = crypto.randomUUID();
    verA2Id = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(`INSERT INTO targets (id, canonical_url, hostname, origin, created_at) VALUES (?, 'https://example.com', 'example.com', 'https://example.com', ?)`).run(targetId, nowIso);
    db.prepare(`INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, capture_config, capture_fingerprint, next_check_at, created_at) VALUES (?, ?, ?, 'Sec Mon', 60, '{}', 'fp1', ?, ?)`).run(subId, userAId, targetId, nowIso, nowIso);
    db.prepare(`INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at) VALUES (?, ?, 'fp1', 'playwright', 'https://example.com', 200, '<p>dom</p>', 'txt', 'data/screenshots/${obsAId}.png', ?)`).run(obsAId, targetId, nowIso);
    db.prepare(`INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at) VALUES (?, ?, ?, 1, 'h1', 'v1 text', ?)`).run(verA1Id, subId, obsAId, nowIso);
    db.prepare(`INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at) VALUES (?, ?, ?, 2, 'h2', 'v2 text', ?)`).run(verA2Id, subId, obsAId, nowIso);

    // Write dummy screenshot and diff files
    const scrDir = path.join(env.DATA_DIR, 'screenshots');
    const diffDir = path.join(env.DATA_DIR, 'diffs');
    fs.mkdirSync(scrDir, { recursive: true });
    fs.mkdirSync(diffDir, { recursive: true });
    fs.writeFileSync(path.join(scrDir, `${obsAId}.png`), Buffer.from('fake-screenshot'));
    fs.writeFileSync(path.join(diffDir, `diff_${verA1Id}_${verA2Id}.png`), Buffer.from('fake-diff'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  it('CW-SEC-01: Shared route validation rejects loopback, private IPs, credentials, and metadata targets', async () => {
    const loopback = await validateRouteUrl('http://127.0.0.1/admin');
    expect(loopback.allowed).toBe(false);

    const metadata = await validateRouteUrl('http://169.254.169.254/latest/meta-data');
    expect(metadata.allowed).toBe(false);

    const credentials = await validateRouteUrl('https://admin:pass@example.com/');
    expect(credentials.allowed).toBe(false);
    expect(credentials.reason).toBe('EMBEDDED_CREDENTIALS');

    const weirdPort = await validateRouteUrl('http://example.com:8080/');
    expect(weirdPort.allowed).toBe(false);
    expect(weirdPort.reason).toContain('PROHIBITED_PORT');

    const blockedDomain = await validateRouteUrl('http://internal.service.local/');
    expect(blockedDomain.allowed).toBe(false);
  });

  it('CW-SEC-02: Enforces provider-specific schemas on notification configs', () => {
    expect(() => validateDestinationConfig('discord', { webhookUrl: 'http://attacker.com/webhook' })).toThrow();
    expect(() => validateDestinationConfig('discord', { webhookUrl: 'https://discord.com/other/path' })).toThrow();
    expect(() => validateDestinationConfig('discord', { webhookUrl: 'https://discord.com:8443/api/webhooks/123/token' })).toThrow();

    expect(() => validateDestinationConfig('discord', { webhookUrl: 'https://discord.com/api/webhooks/12345/token_abc' })).not.toThrow();
    expect(() => validateDestinationConfig('telegram', { botToken: 'bad_token', chatId: '123' })).toThrow();
    expect(() => validateDestinationConfig('telegram', { botToken: '12345:valid_token', chatId: '-100123' })).not.toThrow();
    expect(() => validateDestinationConfig('email', { toEmail: 'test@example.com', smtpHost: '127.0.0.1' })).toThrow();
  });

  it('CW-SEC-03: Two-user test prevents User B from overwriting User A destination', async () => {
    const maliciousUpdate = await fetch(`${baseUrl}/api/destinations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: userBCookie, 'x-csrf-token': userBCsrf },
      body: JSON.stringify({
        id: destAId,
        channel: 'discord',
        config: { webhookUrl: 'https://discord.com/api/webhooks/999/attacker' },
      }),
    });

    expect(maliciousUpdate.status).toBe(403);
    const body = await maliciousUpdate.json() as { error: string };
    expect(body.error).toContain('Forbidden');
  });

  it('CW-SEC-04: Two-user test prevents User B from accessing User A screenshot and diff image', async () => {
    const userAScr = await fetch(`${baseUrl}/api/diff/screenshot/${obsAId}`, {
      headers: { Cookie: userACookie },
    });
    expect(userAScr.status).toBe(200);

    const userBScr = await fetch(`${baseUrl}/api/diff/screenshot/${obsAId}`, {
      headers: { Cookie: userBCookie },
    });
    expect(userBScr.status).toBe(404);

    const userADiff = await fetch(`${baseUrl}/api/diff/image-file/diff_${verA1Id}_${verA2Id}.png`, {
      headers: { Cookie: userACookie },
    });
    expect(userADiff.status).toBe(200);

    const userBDiff = await fetch(`${baseUrl}/api/diff/image-file/diff_${verA1Id}_${verA2Id}.png`, {
      headers: { Cookie: userBCookie },
    });
    expect(userBDiff.status).toBe(404);
  });

  it('CW-SEC-05: Sanitizes URLs and escapes HTML to prevent XSS in alerts', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(sanitizeUrl('https://changewatch.local/diff')).toBe('https://changewatch.local/diff');

    const escaped = escapeHtml('<script>alert("XSS & Injection")</script>');
    expect(escaped).toBe('&lt;script&gt;alert(&quot;XSS &amp; Injection&quot;)&lt;/script&gt;');
  });
});
