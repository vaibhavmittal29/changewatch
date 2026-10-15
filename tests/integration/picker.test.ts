import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { createApp } from '../../src/server/app.js';
import { createDemoApp } from '../../src/server/demo/demoServer.js';
import { fixtureState, resetFixtureState } from '../../src/server/demo/fixtures.js';
import { hashPassword } from '../../src/server/auth/password.js';
import { evaluateSubscriptionChange, type SubscriptionRecord } from '../../src/server/engine/changeDetector.js';
import { capturePage, closeBrowser } from '../../src/server/capture/playwrightCapture.js';
import { DEFAULT_CAPTURE_CONFIG } from '../../src/server/capture/captureConfig.js';

describe('Phase 9: Visual Selector Picker API & Change Isolation', () => {
  let appServer: Server;
  let demoServer: Server;
  let baseUrl: string;
  const demoUrl = 'http://localhost:4000';
  const testDbPath = path.resolve(process.cwd(), './data/test_picker.db');

  let testCookie = '';
  let testCsrfToken = '';
  let testUserId = '';

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';
    process.env.ALLOW_LOCAL_DEMO = 'true';
    process.env.DEMO_PORT = '4000';

    const db = getDb(testDbPath);
    migrate(db);

    // 1. Start demo server on port 4000
    const demoApp = createDemoApp();
    await new Promise<void>((resolve) => {
      demoServer = demoApp.listen(4000, () => resolve());
    });

    // 2. Start app server on dynamic port
    const app = createApp();
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, () => {
        const addr = appServer.address() as AddressInfo;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    // 3. Create test user
    testUserId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { hash, salt, iterations } = await hashPassword('Password123!', 1000);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(testUserId, 'picker_user@test.com', hash, salt, iterations, 'Picker User', now);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'picker_user@test.com', password: 'Password123!' }),
    });
    testCookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: testCookie },
    });
    const meBody = await meRes.json() as { csrfToken: string };
    testCsrfToken = meBody.csrfToken;
  });

  afterAll(async () => {
    resetFixtureState();
    await closeBrowser();
    if (appServer) await new Promise<void>((r) => appServer.close(() => r()));
    if (demoServer) await new Promise<void>((r) => demoServer.close(() => r()));
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  it('renders target page and returns screenshot, dimensions, and element boxes', async () => {
    const res = await fetch(`${baseUrl}/api/picker/render`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': testCookie,
        'X-CSRF-Token': testCsrfToken,
      },
      body: JSON.stringify({ url: `${demoUrl}/demo/banner` }),
    });

    expect(res.status).toBe(200);
    interface PickerElement { selector: string; textPreview: string; isFragile: boolean; }
    interface RenderResp { renderId: string; screenshotBase64: string; width: number; height: number; elements: PickerElement[]; }
    const body = await res.json() as RenderResp;

    expect(body.renderId).toBeDefined();
    expect(body.screenshotBase64).toMatch(/^data:image\/png;base64,/);
    expect(body.width).toBeGreaterThan(0);
    expect(body.height).toBeGreaterThan(0);
    expect(Array.isArray(body.elements)).toBe(true);

    const selectors = body.elements.map(el => el.selector);
    expect(selectors).toContain('#ad-banner');
    expect(selectors).toContain('#headline');

    const headlineEl = body.elements.find(el => el.selector === '#headline')!;
    expect(headlineEl.isFragile).toBe(false);
    expect(headlineEl.textPreview).toContain('Markets Reach Historic');
  });

  it('tests selectors and extracts text with include and ignore filters', async () => {
    // 1. Initial render to get renderId
    const renderRes = await fetch(`${baseUrl}/api/picker/render`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': testCookie,
        'X-CSRF-Token': testCsrfToken,
      },
      body: JSON.stringify({ url: `${demoUrl}/demo/banner` }),
    });
    const { renderId } = await renderRes.json() as { renderId: string };

    // 2. Test with ignore_selectors: ['#ad-banner']
    const testIgnRes = await fetch(`${baseUrl}/api/picker/test-selectors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': testCookie,
        'X-CSRF-Token': testCsrfToken,
      },
      body: JSON.stringify({
        renderId,
        include_selectors: [],
        ignore_selectors: ['#ad-banner'],
      }),
    });
    expect(testIgnRes.status).toBe(200);
    interface TestResp { extractedText: string; lineCount: number; }
    const ignData = await testIgnRes.json() as TestResp;
    expect(ignData.extractedText).not.toContain('SPONSORED PROMOTION');
    expect(ignData.extractedText).toContain('Markets Reach Historic');

    // 3. Test with include_selectors: ['#headline']
    const testIncRes = await fetch(`${baseUrl}/api/picker/test-selectors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': testCookie,
        'X-CSRF-Token': testCsrfToken,
      },
      body: JSON.stringify({
        renderId,
        include_selectors: ['#headline'],
        ignore_selectors: [],
      }),
    });
    expect(testIncRes.status).toBe(200);
    const incData = await testIncRes.json() as TestResp;
    expect(incData.extractedText.trim()).toBe(fixtureState.headlineText);
    expect(incData.extractedText).not.toContain('SPONSORED PROMOTION');
  });

  it('honors Watch and Ignore selectors across checks (ignores banner, alerts on headline)', async () => {
    const db = getDb(testDbPath);
    const subId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, ?, 'localhost', 'http://localhost:4000', ?)
    `).run(targetId, `${demoUrl}/demo/banner`, now);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, sensitivity,
        include_selectors, ignore_selectors, noise_filters, created_at
      ) VALUES (?, ?, ?, 'Banner Test Monitor', 15, ?, '{}', 'fp_banner', 'high', ?, ?, '{}', ?)
    `).run(
      subId, testUserId, targetId, now,
      JSON.stringify(['#headline']),
      JSON.stringify(['#ad-banner']),
      now
    );

    db.prepare(`INSERT INTO sub_state (subscription_id) VALUES (?)`).run(subId);

    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId) as SubscriptionRecord;

    const insertObservation = (id: string, cap: { sanitizedDom: string; rawText: string }) => {
      db.prepare(`
        INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, subresource_count, captured_at)
        VALUES (?, ?, 'fp_banner', 'playwright', ?, 200, ?, ?, 0, ?)
      `).run(id, targetId, `${demoUrl}/demo/banner`, cap.sanitizedDom, cap.rawText, new Date().toISOString());
    };

    // Check 1: baseline creation
    const cap1 = await capturePage(`${demoUrl}/demo/banner`, DEFAULT_CAPTURE_CONFIG);
    insertObservation('obs1', cap1);
    const res1 = evaluateSubscriptionChange(db, sub, { id: 'obs1', sanitized_dom: cap1.sanitizedDom, raw_text: cap1.rawText });
    expect(res1.action).toBe('BASELINE_CREATED');

    // Check 2: banner changes automatically (random adId in HTML), but headline is constant
    const cap2 = await capturePage(`${demoUrl}/demo/banner`, DEFAULT_CAPTURE_CONFIG);
    insertObservation('obs2', cap2);
    const res2 = evaluateSubscriptionChange(db, sub, { id: 'obs2', sanitized_dom: cap2.sanitizedDom, raw_text: cap2.rawText });
    expect(res2.action).toBe('UNCHANGED'); // Proves banner rotation was ignored!

    // Mutate headline
    fixtureState.headlineText = 'Urgent: Tech Stocks Rally Across Global Exchanges';

    // Check 3: headline changed -> candidate recorded
    const cap3 = await capturePage(`${demoUrl}/demo/banner`, DEFAULT_CAPTURE_CONFIG);
    insertObservation('obs3', cap3);
    const res3 = evaluateSubscriptionChange(db, sub, { id: 'obs3', sanitized_dom: cap3.sanitizedDom, raw_text: cap3.rawText });
    expect(res3.action).toBe('CANDIDATE_RECORDED');

    // Check 4: matching headline on re-check -> confirmed change!
    const cap4 = await capturePage(`${demoUrl}/demo/banner`, DEFAULT_CAPTURE_CONFIG);
    insertObservation('obs4', cap4);
    const res4 = evaluateSubscriptionChange(db, sub, { id: 'obs4', sanitized_dom: cap4.sanitizedDom, raw_text: cap4.rawText });
    expect(res4.action).toBe('CHANGE_CONFIRMED');
    expect(res4.version?.version_number).toBe(2);
  });
});
