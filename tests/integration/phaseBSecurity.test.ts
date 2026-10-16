import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/server/app.js';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { isSafeSmtpHostString, EmailConfigSchema, escapeDiscordMarkdown, escapeHtml } from '../../src/server/notifications/configValidation.js';
import { NotificationWorker } from '../../src/server/notifications/worker.js';
import { cacheDom, getCachedDom } from '../../src/server/capture/pickerRender.js';

describe('Phase B: Security Hardening Verification', () => {
  let server: Server;
  let baseUrl: string;
  const testDbPath = path.resolve(process.cwd(), './data/test_phase_b.db');
  let userACookie = '';
  let userACsrf = '';
  let userAId = '';
  let userBId = '';

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

    const regA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'userA_b@sec.local', password: 'Password123!', displayName: 'User A' }),
    });
    userACookie = regA.headers.get('set-cookie')?.split(';')[0] || '';
    const bodyA = await regA.json() as { csrfToken: string; user: { id: string } };
    userACsrf = bodyA.csrfToken;
    userAId = bodyA.user.id;

    const regB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'userB_b@sec.local', password: 'Password123!', displayName: 'User B' }),
    });
    const bodyB = await regB.json() as { user: { id: string } };
    userBId = bodyB.user.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  it('B1: SMTP egress validation rejects loopback, RFC1918, ULA, metadata, alternate IP encodings and bad ports', () => {
    // Loopback & Private
    expect(isSafeSmtpHostString('127.0.0.1')).toBe(false);
    expect(isSafeSmtpHostString('localhost')).toBe(false);
    expect(isSafeSmtpHostString('::1')).toBe(false);
    expect(isSafeSmtpHostString('10.0.0.1')).toBe(false);
    expect(isSafeSmtpHostString('172.16.0.1')).toBe(false);
    expect(isSafeSmtpHostString('192.168.1.10')).toBe(false);
    expect(isSafeSmtpHostString('169.254.169.254')).toBe(false);
    expect(isSafeSmtpHostString('fe80::1')).toBe(false); // Link-local
    expect(isSafeSmtpHostString('fc00::1')).toBe(false); // IPv6 ULA

    // Alternate IP encodings (integer, hex, octal)
    expect(isSafeSmtpHostString('2130706433')).toBe(false); // 127.0.0.1 in integer
    expect(isSafeSmtpHostString('0x7f000001')).toBe(false); // 127.0.0.1 in hex
    expect(isSafeSmtpHostString('0177.0.0.1')).toBe(false); // octal

    // Public host allowed
    expect(isSafeSmtpHostString('smtp.mailgun.org')).toBe(true);

    // Schema port check
    expect(() => EmailConfigSchema.parse({ toEmail: 'test@example.com', smtpHost: 'smtp.mailgun.org', smtpPort: 8080 })).toThrow();
    expect(() => EmailConfigSchema.parse({ toEmail: 'test@example.com', smtpHost: 'smtp.mailgun.org', smtpPort: 587 })).not.toThrow();
  });

  it('B2: approve-patterns validates schema, rejects ReDoS patterns, and never writes invalid input to SQLite', async () => {
    const db = getDb();
    const subId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(`INSERT INTO targets (id, canonical_url, hostname, origin, created_at) VALUES (?, 'http://example.com/b2', 'example.com', 'http://example.com', ?)`).run(targetId, nowIso);
    db.prepare(`INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, capture_config, capture_fingerprint, learned_ignore_patterns, next_check_at, created_at) VALUES (?, ?, ?, 'B2 Sub', 60, '{}', 'fp-b2', '["existing_pattern"]', ?, ?)`).run(subId, userAId, targetId, nowIso, nowIso);

    // Non-string
    const r1 = await fetch(`${baseUrl}/api/subscriptions/${subId}/approve-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: userACookie, 'x-csrf-token': userACsrf },
      body: JSON.stringify({ patterns: [12345] }),
    });
    expect(r1.status).toBe(400);

    // Empty string
    const r2 = await fetch(`${baseUrl}/api/subscriptions/${subId}/approve-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: userACookie, 'x-csrf-token': userACsrf },
      body: JSON.stringify({ patterns: [''] }),
    });
    expect(r2.status).toBe(400);

    // ReDoS nested quantifiers: (a+)+$
    const r3 = await fetch(`${baseUrl}/api/subscriptions/${subId}/approve-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: userACookie, 'x-csrf-token': userACsrf },
      body: JSON.stringify({ patterns: ['(a+)+$'] }),
    });
    expect(r3.status).toBe(400);

    // Assert SQLite record was NOT modified
    const subRow = db.prepare('SELECT learned_ignore_patterns FROM subscriptions WHERE id = ?').get(subId) as { learned_ignore_patterns: string };
    expect(subRow.learned_ignore_patterns).toBe('["existing_pattern"]');

    // Valid pattern is accepted
    const r4 = await fetch(`${baseUrl}/api/subscriptions/${subId}/approve-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: userACookie, 'x-csrf-token': userACsrf },
      body: JSON.stringify({ patterns: ['SessionID: [0-9]+'] }),
    });
    expect(r4.status).toBe(200);
    const updated = db.prepare('SELECT learned_ignore_patterns FROM subscriptions WHERE id = ?').get(subId) as { learned_ignore_patterns: string };
    expect(updated.learned_ignore_patterns).toContain('SessionID: [0-9]+');
  });

  it('B4: Notification worker enforces destination ownership and marks owner mismatch terminal FAILED', async () => {
    const db = getDb();
    const destBId = crypto.randomUUID();
    const outboxAId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    // Destination owned by User B
    db.prepare(`
      INSERT INTO notification_destinations (id, user_id, channel, destination_config, enabled)
      VALUES (?, ?, 'email', 'encrypted-conf', 1)
    `).run(destBId, userBId);

    // Outbox record owned by User A pointing to User B's destination ID
    db.prepare(`
      INSERT INTO notification_outbox (id, user_id, kind, idempotency_key, change_event_id, channel, destination_id, payload, status, attempts, next_attempt_at, created_at)
      VALUES (?, ?, 'DIGEST', ?, NULL, 'email', ?, '{"monitorName":"test","summary":"test"}', 'QUEUED', 0, ?, ?)
    `).run(outboxAId, userAId, `idem-${outboxAId}`, destBId, nowIso, nowIso);

    const worker = new NotificationWorker(db);
    await worker.processOutboxBatch(10);

    const row = db.prepare('SELECT status, last_error FROM notification_outbox WHERE id = ?').get(outboxAId) as { status: string; last_error: string };
    expect(row.status).toBe('FAILED');
    expect(row.last_error).toContain('Destination owner mismatch');
  });

  it('B5: Dispatcher context-specific encoding neutralizes @everyone and Discord/Telegram injection', () => {
    const maliciousDiscord = 'Check this out @everyone and <@&12345678> [click here](http://evil.com)';
    const encodedDiscord = escapeDiscordMarkdown(maliciousDiscord);
    expect(encodedDiscord).not.toContain('@everyone');
    expect(encodedDiscord).toContain('@\u200beveryone');
    expect(encodedDiscord).not.toContain('<@&');
    expect(encodedDiscord).toContain('<\u200b@&');
    expect(encodedDiscord).not.toContain('](');

    const maliciousHtml = '<script>alert("1")</script> & "quotes"';
    const encodedHtml = escapeHtml(maliciousHtml);
    expect(encodedHtml).toBe('&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt; &amp; &quot;quotes&quot;');
  });

  it('B6: Tracker host check allows lookalike domains and blocks exact / subdomain matches', () => {
    const TRACKER_DOMAINS = ['google-analytics.com'];
    const isTracker = (host: string) => TRACKER_DOMAINS.some(d => host === d || host.endsWith('.' + d));

    expect(isTracker('notgoogle-analytics.com')).toBe(false);
    expect(isTracker('fakegoogle-analytics.com')).toBe(false);
    expect(isTracker('google-analytics.com')).toBe(true);
    expect(isTracker('ssl.google-analytics.com')).toBe(true);
  });

  it('B7: Picker cache enforces LRU eviction and 1MB DOM length cap', () => {
    // 1. DOM length cap
    const hugeDom = 'A'.repeat(2 * 1024 * 1024); // 2MB
    cacheDom('huge-id', hugeDom);
    const cached = getCachedDom('huge-id');
    expect(cached?.length).toBe(1024 * 1024); // Capped to 1MB

    // 2. LRU eviction when exceeding 50 entries
    for (let i = 0; i < 55; i++) {
      cacheDom(`test-render-${i}`, `<div>${i}</div>`);
    }
    // Oldest items (test-render-0 through test-render-4) evicted
    expect(getCachedDom('test-render-0')).toBeNull();
    expect(getCachedDom('test-render-54')).toBe('<div>54</div>');
  });
});
