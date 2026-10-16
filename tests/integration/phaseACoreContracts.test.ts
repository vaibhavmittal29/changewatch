import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/server/app.js';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { CANONICAL_FIXTURES } from '../../src/server/demo/fixtures.js';
import { startDemoServer } from '../../src/server/demo/demoServer.js';
import { env } from '../../src/server/config.js';

describe('Phase A: Core Contract and Runtime Defect Verification', () => {
  let server: Server;
  let demoServerInstance: Server | null = null;
  let baseUrl: string;
  const demoUrl = 'http://127.0.0.1:4000';
  const testDbPath = path.resolve(process.cwd(), './data/test_phase_a.db');
  let userCookie = '';
  let csrfToken = '';
  let userId = '';

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';
    env.ALLOW_LOCAL_DEMO = true;

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

    try {
      demoServerInstance = await startDemoServer(4000);
    } catch {
      // Demo server might already be running on 4000 from another suite
    }

    // Register user
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'phase_a@example.com', password: 'password123', displayName: 'Phase A User' }),
    });
    userCookie = regRes.headers.get('set-cookie')?.split(';')[0] || '';
    const regBody = await regRes.json() as { csrfToken: string; user: { id: string } };
    csrfToken = regBody.csrfToken;
    userId = regBody.user.id;
  });

  afterAll(async () => {
    if (demoServerInstance) {
      await new Promise<void>((resolve) => demoServerInstance!.close(() => resolve()));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    vi.restoreAllMocks();
  });

  it('A1: Saves Discord, Telegram, and Email destinations with config schema and rejects misspelled fields', async () => {
    // 1. Rejects payload using old "destination_config" field (misspelled / strict schema check)
    const badPayload = await fetch(`${baseUrl}/api/destinations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: userCookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ channel: 'discord', destination_config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' } }),
    });
    expect(badPayload.status).toBe(400);

    // 2. Rejects misspelled field inside email config (e.g. "to" instead of "toEmail")
    const badEmail = await fetch(`${baseUrl}/api/destinations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: userCookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ channel: 'email', config: { to: 'alerts@example.com' } }),
    });
    expect(badEmail.status).toBe(400);

    // 3. Successfully saves Discord destination
    const dcRes = await fetch(`${baseUrl}/api/destinations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: userCookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ channel: 'discord', config: { webhookUrl: 'https://discord.com/api/webhooks/12345/my-secret-token' }, enabled: true }),
    });
    expect(dcRes.status).toBe(200);
    const dcData = await dcRes.json() as { config: { webhookUrl: string } };
    expect(dcData.config.webhookUrl).toContain('••••');

    // 4. Updating without changing masked secret preserves original secret
    const dcUpdate = await fetch(`${baseUrl}/api/destinations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: userCookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ channel: 'discord', config: { webhookUrl: dcData.config.webhookUrl }, enabled: true }),
    });
    expect(dcUpdate.status).toBe(200);

    // 5. Saves Telegram and Email destinations
    const tgRes = await fetch(`${baseUrl}/api/destinations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: userCookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ channel: 'telegram', config: { botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', chatId: '98765432' } }),
    });
    expect(tgRes.status).toBe(200);

    const emRes = await fetch(`${baseUrl}/api/destinations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: userCookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ channel: 'email', config: { toEmail: 'alerts@example.com' } }),
    });
    expect(emRes.status).toBe(200);
  });

  it('A2 & A3: Dashboard reflects active job states (QUEUED, CLAIMED, RUNNING) and baseline-only monitor shows OK', async () => {
    const db = getDb();
    const target1Id = crypto.randomUUID();
    const sub1Id = crypto.randomUUID();
    const sub2Id = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(`INSERT INTO targets (id, canonical_url, hostname, origin, created_at) VALUES (?, 'http://example.com/p1', 'example.com', 'http://example.com', ?)`).run(target1Id, nowIso);
    db.prepare(`INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, capture_config, capture_fingerprint, next_check_at, created_at) VALUES (?, ?, ?, 'Sub 1', 60, '{}', 'fp-active', ?, ?)`).run(sub1Id, userId, target1Id, nowIso, nowIso);
    db.prepare(`INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, capture_config, capture_fingerprint, next_check_at, created_at) VALUES (?, ?, ?, 'Baseline Only', 60, '{}', 'fp-baseline', ?, ?)`).run(sub2Id, userId, target1Id, nowIso, nowIso);

    // Baseline version for sub2 (Version 1, no CHANGE event)
    const obsId = crypto.randomUUID();
    db.prepare(`INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at) VALUES (?, ?, 'fp-baseline', 'playwright', 'http://example.com', 200, '<p>base</p>', 'base', ?)`).run(obsId, target1Id, nowIso);
    db.prepare(`INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at) VALUES (?, ?, ?, 1, 'h-base', 'base', ?)`).run(crypto.randomUUID(), sub2Id, obsId, nowIso);

    // Insert active jobs with QUEUED, CLAIMED, RUNNING
    const checkState = async (status: string) => {
      const jobId = crypto.randomUUID();
      db.prepare(`INSERT INTO jobs (id, kind, target_id, capture_fingerprint, status, scheduled_at, created_at) VALUES (?, 'CHECK', ?, 'fp-active', ?, ?, ?)`).run(jobId, target1Id, status, nowIso, nowIso);
      const res = await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: userCookie } });
      const data = await res.json() as { monitors: Array<{ id: string; status: string }> };
      const m1 = data.monitors.find(m => m.id === sub1Id);
      db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId);
      return m1?.status;
    };

    expect(await checkState('QUEUED')).toBe('CHECKING');
    expect(await checkState('CLAIMED')).toBe('CHECKING');
    expect(await checkState('RUNNING')).toBe('CHECKING');
    expect(await checkState('COMPLETED')).toBe('OK');
    expect(await checkState('FAILED')).toBe('OK');

    // Sub 2 (baseline only) must show OK, not CHANGED
    const dashRes = await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: userCookie } });
    const dashData = await dashRes.json() as { monitors: Array<{ id: string; status: string; last_changed_at: string | null }> };
    const m2 = dashData.monitors.find(m => m.id === sub2Id);
    expect(m2?.status).toBe('OK');
    expect(m2?.last_changed_at).toBeNull();
  });

  it('A4: GET /api/subscriptions/:id returns 200 with check runs ordered latest-first by created_at', async () => {
    const db = getDb();
    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    const now = Date.now();

    db.prepare(`INSERT INTO targets (id, canonical_url, hostname, origin, created_at) VALUES (?, 'http://example.com/p4', 'example.com', 'http://example.com', ?)`).run(targetId, new Date(now).toISOString());
    db.prepare(`INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, capture_config, capture_fingerprint, next_check_at, created_at) VALUES (?, ?, ?, 'Check Run Test', 60, '{}', 'fp-cr', ?, ?)`).run(subId, userId, targetId, new Date(now).toISOString(), new Date(now).toISOString());

    const cr1 = crypto.randomUUID();
    const cr2 = crypto.randomUUID();
    const t1 = new Date(now - 10000).toISOString();
    const t2 = new Date(now).toISOString();

    db.prepare(`INSERT INTO check_runs (id, subscription_id, target_id, outcome, duration_ms, created_at) VALUES (?, ?, ?, 'OK', 100, ?)`).run(cr1, subId, targetId, t1);
    db.prepare(`INSERT INTO check_runs (id, subscription_id, target_id, outcome, duration_ms, created_at) VALUES (?, ?, ?, 'OK', 120, ?)`).run(cr2, subId, targetId, t2);

    const res = await fetch(`${baseUrl}/api/subscriptions/${subId}`, { headers: { Cookie: userCookie } });
    expect(res.status).toBe(200);
    const data = await res.json() as { checkRuns: Array<{ id: string; created_at: string }> };
    expect(data.checkRuns).toHaveLength(2);
    expect(data.checkRuns[0].id).toBe(cr2); // latest first
    expect(data.checkRuns[1].id).toBe(cr1);
  });

  it('A5: GET /api/auth/csrf handles authenticated and logged-out requests', async () => {
    // Unauthenticated request returns 401
    const unauth = await fetch(`${baseUrl}/api/auth/csrf`);
    expect(unauth.status).toBe(401);

    // Authenticated request returns csrfToken
    const auth = await fetch(`${baseUrl}/api/auth/csrf`, { headers: { Cookie: userCookie } });
    expect(auth.status).toBe(200);
    const body = await auth.json() as { csrfToken: string };
    expect(typeof body.csrfToken).toBe('string');
    expect(body.csrfToken.length).toBeGreaterThan(10);
  });

  it('A6: Requests every canonical fixture URL and verifies live server responses', async () => {
    for (const fixture of CANONICAL_FIXTURES) {
      if (fixture.path === '/demo/slow') continue; // skip slow timeout in quick test
      const res = await fetch(`${demoUrl}${fixture.path}`, { redirect: 'manual' });
      expect(res.status).not.toBe(404);
      if (fixture.path === '/demo/503') expect(res.status).toBe(503);
      if (fixture.path === '/demo/rate-limit') expect(res.status).toBe(429);
      if (fixture.path === '/demo/redirect-private') expect(res.status).toBe(302);
      if (fixture.path === '/demo/stable') expect(res.status).toBe(200);
    }
  });
});
