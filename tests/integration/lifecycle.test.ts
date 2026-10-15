import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { createApp } from '../../src/server/app.js';
import { hashPassword } from '../../src/server/auth/password.js';
import { deleteSubscriptionCascade } from '../../src/server/maintenance/deleteFlow.js';
import { runRetentionCleanup } from '../../src/server/maintenance/cleanup.js';

describe('Phase 8: Lifecycle, Retention & Dashboard API', () => {
  let server: Server;
  let baseUrl: string;
  const testDbPath = path.resolve(process.cwd(), './data/test_lifecycle.db');
  const testScreenshots: string[] = [];

  const createDummyScreenshot = (name: string): string => {
    const dir = path.join(process.cwd(), 'data', 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.png`);
    fs.writeFileSync(filePath, 'fake-png-content');
    testScreenshots.push(filePath);
    return filePath;
  };

  async function createTestUser() {
    const db = getDb(testDbPath);
    const newUserId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { hash, salt, iterations } = await hashPassword('Password123!', 1000);

    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newUserId, `user_${newUserId.slice(0, 8)}@test.com`, hash, salt, iterations, 'Test User', now);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `user_${newUserId.slice(0, 8)}@test.com`, password: 'Password123!' }),
    });
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    const meBody = await meRes.json() as { csrfToken: string };

    return { userId: newUserId, cookie, csrfToken: meBody.csrfToken };
  }

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
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  afterEach(() => {
    for (const file of testScreenshots) {
      if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  });

  it('Requirement Z2: deletes monitor, cascades rows, and unlinks orphan screenshot & target', async () => {
    const { userId } = await createTestUser();
    const db = getDb(testDbPath);
    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    const obsId = crypto.randomUUID();
    const now = new Date().toISOString();
    const screenshotPath = createDummyScreenshot(`orphan_${obsId.slice(0, 8)}`);

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(targetId, 'https://example.com/unique-test', 'example.com', 'https://example.com', now);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, sensitivity, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'fp1', 'balanced', ?)
    `).run(subId, userId, targetId, 'Z2 Monitor', 30, now, now);

    db.prepare(`
      INSERT INTO observations (
        id, target_id, capture_fingerprint, engine_used, final_url, http_status,
        sanitized_dom, raw_text, screenshot_path, captured_at
      ) VALUES (?, ?, 'fp1', 'playwright', 'https://example.com/unique-test', 200, '<p>Test</p>', 'Test', ?, ?)
    `).run(obsId, targetId, screenshotPath, now);

    expect(fs.existsSync(screenshotPath)).toBe(true);

    const result = deleteSubscriptionCascade(subId, userId);
    expect(result).not.toBeNull();
    expect(result?.deletedSubscriptionId).toBe(subId);
    expect(result?.orphanedObservationsCleaned).toBe(1);
    expect(result?.screenshotsRemoved).toBe(1);
    expect(result?.targetDeleted).toBe(true);

    expect(fs.existsSync(screenshotPath)).toBe(false);

    const subCheck = db.prepare('SELECT id FROM subscriptions WHERE id = ?').get(subId);
    expect(subCheck).toBeUndefined();
    const obsCheck = db.prepare('SELECT id FROM observations WHERE id = ?').get(obsId);
    expect(obsCheck).toBeUndefined();
    const targetCheck = db.prepare('SELECT id FROM targets WHERE id = ?').get(targetId);
    expect(targetCheck).toBeUndefined();
  });

  it('Requirement Z: retention removes unreferenced old observations, while confirmed and pending survive', async () => {
    const { userId } = await createTestUser();
    const db = getDb(testDbPath);
    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(targetId, 'https://example.com/retention-test', 'example.com', 'https://example.com', now);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, sensitivity, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'fp1', 'balanced', ?)
    `).run(subId, userId, targetId, 'Retention Monitor', 60, now, now);

    // 1. Unreferenced old observation (> 30 days)
    const oldUnreferencedId = crypto.randomUUID();
    const oldScreenshot = createDummyScreenshot(`old_unref_${oldUnreferencedId.slice(0, 8)}`);
    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
      VALUES (?, ?, 'fp1', 'playwright', 'https://example.com', 200, '<p>Old</p>', 'Old', ?, ?)
    `).run(oldUnreferencedId, targetId, oldScreenshot, oldDate);

    // 2. Confirmed version observation (> 30 days)
    const confirmedObsId = crypto.randomUUID();
    const confirmedScreenshot = createDummyScreenshot(`confirmed_${confirmedObsId.slice(0, 8)}`);
    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
      VALUES (?, ?, 'fp1', 'playwright', 'https://example.com', 200, '<p>Confirmed</p>', 'Confirmed', ?, ?)
    `).run(confirmedObsId, targetId, confirmedScreenshot, oldDate);

    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
      VALUES (?, ?, ?, 1, 'hash_conf', 'Confirmed text', ?)
    `).run(crypto.randomUUID(), subId, confirmedObsId, oldDate);

    // 3. Pending candidate observation (> 30 days)
    const pendingObsId = crypto.randomUUID();
    const pendingScreenshot = createDummyScreenshot(`pending_${pendingObsId.slice(0, 8)}`);
    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
      VALUES (?, ?, 'fp1', 'playwright', 'https://example.com', 200, '<p>Pending</p>', 'Pending', ?, ?)
    `).run(pendingObsId, targetId, pendingScreenshot, oldDate);

    db.prepare(`
      INSERT INTO sub_state (subscription_id, pending_candidate_hash, pending_candidate_checks, pending_observation_id)
      VALUES (?, 'hash_pend', 1, ?)
    `).run(subId, pendingObsId);

    const cleanupResult = runRetentionCleanup(30);
    expect(cleanupResult.prunedObservations).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(oldScreenshot)).toBe(false);
    expect(db.prepare('SELECT id FROM observations WHERE id = ?').get(oldUnreferencedId)).toBeUndefined();

    expect(fs.existsSync(confirmedScreenshot)).toBe(true);
    expect(db.prepare('SELECT id FROM observations WHERE id = ?').get(confirmedObsId)).toBeDefined();
    expect(fs.existsSync(pendingScreenshot)).toBe(true);
    expect(db.prepare('SELECT id FROM observations WHERE id = ?').get(pendingObsId)).toBeDefined();
  });

  it('GET /api/dashboard and lifecycle endpoints work end-to-end', async () => {
    const { cookie, csrfToken } = await createTestUser();
    // 1. Create a monitor via API
    const createRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        url: 'https://example.com/blog',
        name: 'Tech Blog',
        interval_minutes: 60,
        sensitivity: 'balanced',
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json() as { id: string };
    const subId = createBody.id;

    // 2. Fetch dashboard
    const dashRes = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { Cookie: cookie },
    });
    expect(dashRes.status).toBe(200);
    const dashBody = await dashRes.json() as { monitors: Array<{ id: string; name: string; status: string }> };
    expect(dashBody.monitors).toHaveLength(1);
    expect(dashBody.monitors[0].id).toBe(subId);
    expect(dashBody.monitors[0].name).toBe('Tech Blog');
    expect(dashBody.monitors[0].status).toBe('OK');

    // 3. Pause monitor
    const pauseRes = await fetch(`${baseUrl}/api/subscriptions/${subId}/pause`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    });
    expect(pauseRes.status).toBe(200);

    const dashPaused = await (await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: cookie } })).json() as { monitors: Array<{ status: string }> };
    expect(dashPaused.monitors[0].status).toBe('PAUSED');

    // 4. Resume monitor
    const resumeRes = await fetch(`${baseUrl}/api/subscriptions/${subId}/resume`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    });
    expect(resumeRes.status).toBe(200);

    // 5. Trigger Check-Now
    const checkNowRes = await fetch(`${baseUrl}/api/subscriptions/${subId}/check-now`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    });
    expect(checkNowRes.status).toBe(200);

    // 6. Timeline API
    const timelineRes = await fetch(`${baseUrl}/api/subscriptions/${subId}/timeline`, {
      headers: { Cookie: cookie },
    });
    expect(timelineRes.status).toBe(200);
    const timelineBody = await timelineRes.json() as { subscription: { name: string }; versions: unknown[]; events: unknown[]; recent_checks: unknown[] };
    expect(timelineBody.subscription.name).toBe('Tech Blog');
    expect(Array.isArray(timelineBody.versions)).toBe(true);
    expect(Array.isArray(timelineBody.events)).toBe(true);
    expect(Array.isArray(timelineBody.recent_checks)).toBe(true);

    // 7. Delete monitor via DELETE /api/subscriptions/:id
    const delRes = await fetch(`${baseUrl}/api/subscriptions/${subId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    });
    expect(delRes.status).toBe(200);

    const dashEmpty = await (await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: cookie } })).json() as { monitors: unknown[] };
    expect(dashEmpty.monitors).toHaveLength(0);
  });
});
