import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { createApp } from '../src/server/app.js';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';
import { env } from '../src/server/config.js';

async function main() {
  console.log('[Phase 6 UI Verification] Starting...');

  const evidenceDir = path.resolve(process.cwd(), 'docs/evidence/phase-6');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const testDbPath = path.resolve(process.cwd(), './data/test_phase6_ui.db');
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }
  process.env.DATABASE_PATH = testDbPath;
  process.env.PBKDF2_ITERATIONS = '1000';

  const db = getDb(testDbPath);
  migrate(db);

  const app = createApp();

  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);

  let server: Server | null = null;
  let baseUrl = '';

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server!.address();
      if (typeof addr === 'object' && addr !== null) {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });

  console.log(`[Phase 6 UI Verification] Server running at ${baseUrl}`);

  try {
    // 1. Seed user & versions
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ui_test@example.com', password: 'password123', displayName: 'QA Tester' }),
    });
    const regData = (await regRes.json()) as { user: { id: string } };
    const userId = regData.user.id;

    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    const obs1Id = crypto.randomUUID();
    const obs2Id = crypto.randomUUID();
    const v1Id = crypto.randomUUID();
    const v2Id = crypto.randomUUID();

    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'http://example.com/pricing', 'example.com', 'http://example.com', ?)
    `).run(targetId, nowIso);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, capture_config, capture_fingerprint,
        next_check_at, created_at
      ) VALUES (?, ?, ?, 'Acme Pricing Monitor', 60, '{}', 'fp-pricing', ?, ?)
    `).run(subId, userId, targetId, nowIso, nowIso);

    const screenshotsDir = path.join(env.DATA_DIR, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const ss1Path = path.join(screenshotsDir, `${obs1Id}.png`);
    const ss2Path = path.join(screenshotsDir, `${obs2Id}.png`);

    const png1 = new PNG({ width: 320, height: 240 });
    png1.data.fill(240);
    fs.writeFileSync(ss1Path, PNG.sync.write(png1));

    const png2 = new PNG({ width: 320, height: 240 });
    png2.data.fill(240);
    // Draw changed blue box in png2
    for (let y = 50; y < 150; y++) {
      for (let x = 50; x < 250; x++) {
        const idx = (y * 320 + x) * 4;
        png2.data[idx] = 59;
        png2.data[idx + 1] = 130;
        png2.data[idx + 2] = 246;
        png2.data[idx + 3] = 255;
      }
    }
    fs.writeFileSync(ss2Path, PNG.sync.write(png2));

    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
      VALUES (?, ?, 'fp-pricing', 'playwright', 'http://example.com/pricing', 200, '<p>1</p>', 'Acme Pricing Plan\nStarter: $19/mo\nPro: $49/mo\nEnterprise: Contact us', ?, ?)
    `).run(obs1Id, targetId, ss1Path, nowIso);

    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
      VALUES (?, ?, 'fp-pricing', 'playwright', 'http://example.com/pricing', 200, '<p>2</p>', 'Acme Pricing Plan\nStarter: $29/mo\nPro: $79/mo\nUltimate: $149/mo\nEnterprise: Contact us', ?, ?)
    `).run(obs2Id, targetId, ss2Path, nowIso);

    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, change_summary, created_at)
      VALUES (?, ?, ?, 1, 'hash-v1', 'Acme Pricing Plan\nStarter: $19/mo\nPro: $49/mo\nEnterprise: Contact us', 'Initial baseline', ?)
    `).run(v1Id, subId, obs1Id, nowIso);

    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, change_summary, created_at)
      VALUES (?, ?, ?, 2, 'hash-v2', 'Acme Pricing Plan\nStarter: $29/mo\nPro: $79/mo\nUltimate: $149/mo\nEnterprise: Contact us', '3 lines added, 2 lines removed', ?)
    `).run(v2Id, subId, obs2Id, nowIso);

    // 2. Playwright automation
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // Login via UI
    await page.goto(`${baseUrl}/`);
    await page.fill('input[type="email"]', 'ui_test@example.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');

    // Wait for Dashboard to mount
    await page.waitForSelector('text=ChangeWatch');

    // Navigate to Compare view with query parameters
    await page.goto(`${baseUrl}/?from=${v1Id}&to=${v2Id}`);
    await page.waitForSelector('text=Unified Diff View');

    // Screenshot 1: Unified Text Diff
    const unifiedPath = path.join(evidenceDir, 'compare-unified.png');
    await page.screenshot({ path: unifiedPath, fullPage: true });
    console.log(`[Phase 6 UI Verification] Saved ${unifiedPath}`);

    // Screenshot 2: Side-by-Side Text
    await page.click('button:has-text("Side-by-Side Text")');
    await page.waitForSelector('text=Version 1 (Before)');
    const splitPath = path.join(evidenceDir, 'compare-side-by-side.png');
    await page.screenshot({ path: splitPath, fullPage: true });
    console.log(`[Phase 6 UI Verification] Saved ${splitPath}`);

    // Screenshot 3: Visual Screenshot Diff
    await page.click('button:has-text("Screenshot Diff")');
    await page.waitForSelector('text=Diff Overlay (Red Pixels)');
    const visualPath = path.join(evidenceDir, 'compare-screenshot-diff.png');
    await page.screenshot({ path: visualPath, fullPage: true });
    console.log(`[Phase 6 UI Verification] Saved ${visualPath}`);

    await browser.close();
    console.log('[Phase 6 UI Verification] All UI screenshots captured successfully.');
  } finally {
    await vite.close();
    if (server) (server as Server).close();
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  }
}

main().catch(err => {
  console.error('[Phase 6 UI Verification] Fatal error:', err);
  process.exit(1);
});
