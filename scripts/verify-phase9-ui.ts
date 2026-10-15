import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../src/server/app.js';
import { createDemoApp } from '../src/server/demo/demoServer.js';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';
import { hashPassword } from '../src/server/auth/password.js';

function checkPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
      .once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} is occupied`));
        else reject(err);
      })
      .once('listening', () => s.close(() => resolve()))
      .listen(port, '127.0.0.1');
  });
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error('[verify-phase9-ui] Watchdog timeout after 180s. Force exiting.');
    process.exit(1);
  }, 180000);
  watchdog.unref();

  await checkPortFree(3000);
  await checkPortFree(4000);

  const evidenceDir = path.resolve(process.cwd(), 'docs/evidence/phase-9');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const testDbPath = path.resolve(process.cwd(), 'data/test_phase9_ui.db');
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }
  process.env.DATABASE_PATH = testDbPath;
  process.env.ALLOW_LOCAL_DEMO = 'true';
  process.env.DEMO_PORT = '4000';
  process.env.PBKDF2_ITERATIONS = '1000';

  const db = getDb(testDbPath);
  migrate(db);

  const userId = 'u-phase9-demo';
  const { hash, salt, iterations } = await hashPassword('Password123!', 1000);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, 'phase9@changewatch.local', hash, salt, iterations, 'Phase 9 Admin', new Date().toISOString());

  // 1. Start demo server on port 4000
  const demoApp = createDemoApp();
  const demoServer = http.createServer(demoApp);
  await new Promise<void>((r) => demoServer.listen(4000, '127.0.0.1', () => r()));

  // 2. Start app with Vite middleware on port 3000
  const expressApp = createApp();
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  expressApp.use(vite.middlewares);
  const appServer = http.createServer(expressApp);
  await new Promise<void>((r) => appServer.listen(3000, '127.0.0.1', () => r()));

  console.log('[verify-phase9-ui] Servers running on ports 3000 and 4000.');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', msg => console.log('[BROWSER CONSOLE]', msg.text()));
    page.on('pageerror', err => console.log('[BROWSER ERR]', err));

    // Step 1: Login
    console.log('[verify-phase9-ui] Logging in...');
    await page.goto('http://127.0.0.1:3000/');
    await page.waitForSelector('input[type="email"]');
    await page.fill('input[type="email"]', 'phase9@changewatch.local');
    await page.fill('input[type="password"]', 'Password123!');
    await page.click('button[type="submit"]');

    // Wait for Dashboard to mount
    await page.waitForSelector('text=ChangeWatch');
    console.log('[verify-phase9-ui] Logged in successfully.');

    // Step 2: Open Visual Picker
    console.log('[verify-phase9-ui] Navigating to Visual Picker...');
    await page.click('button:has-text("Visual Picker")');
    await page.waitForSelector('text=Visual Selector Picker');

    // Wait for target render on /demo/banner
    await page.waitForSelector('img[alt="Visual Picker Target"]', { timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(evidenceDir, 'picker-initial.png') });
    console.log('[verify-phase9-ui] Saved picker-initial.png');

    // Step 3: Hover over #headline
    const imgElement = await page.$('img[alt="Visual Picker Target"]');
    if (imgElement) {
      const box = await imgElement.boundingBox();
      if (box) {
        // Move mouse over the ad banner area to show hover tooltip
        await page.mouse.move(box.x + 150, box.y + 25);
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(evidenceDir, 'picker-hover.png') });
        console.log('[verify-phase9-ui] Saved picker-hover.png');

        // Step 4: Click #ad-banner area to trigger popover
        await page.mouse.click(box.x + 150, box.y + 25);
        await page.waitForSelector('button:has-text("Ignore")', { timeout: 5000 });
        await page.screenshot({ path: path.join(evidenceDir, 'picker-popover.png') });
        console.log('[verify-phase9-ui] Saved picker-popover.png');

        // Click "Ignore" on #ad-banner
        await page.click('button:has-text("Ignore")');
        await page.waitForTimeout(400);

        // Click #headline area and click "Watch"
        await page.mouse.click(box.x + 150, box.y + 80);
        await page.waitForSelector('button:has-text("Watch")', { timeout: 5000 });
        await page.click('button:has-text("Watch")');
        await page.waitForTimeout(400);

        // Test manual fallback input
        await page.fill('input[placeholder*="cookie-banner"]', '#footer');
        await page.click('button:has-text("+ Ignore")');
        await page.waitForTimeout(300);
      }
    }

    // Step 5: Test Selectors
    console.log('[verify-phase9-ui] Testing extraction with active selectors...');
    await page.click('button:has-text("Test Selectors")');
    await page.waitForSelector('text=Single Contract Output', { timeout: 8000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(evidenceDir, 'picker-tested.png') });
    console.log('[verify-phase9-ui] Saved picker-tested.png');

    // Step 6: Create monitor with these rules from dashboard
    console.log('[verify-phase9-ui] Creating monitor with picker selectors...');
    await page.click('button:has-text("Dashboard")');
    await page.waitForSelector('text=Add Monitor');
    await page.click('button:has-text("Add Monitor")');
    await page.waitForSelector('input[name="url"], input[type="url"]');
    await page.fill('input[type="url"]', 'http://localhost:4000/demo/banner');
    await page.fill('input[placeholder*="Pricing"]', 'Banner Filtered Monitor');
    // Open advanced
    await page.click('button:has-text("Advanced")');
    await page.waitForSelector('textarea');
    // Fill selectors
    const textareas = await page.$$('textarea');
    if (textareas.length >= 2) {
      await textareas[0].fill('#headline');
      await textareas[1].fill('#ad-banner');
    }
    await page.click('button[type="submit"]:has-text("Add Monitor")');
    await page.waitForSelector('text=Banner Filtered Monitor', { timeout: 8000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(evidenceDir, 'picker-applied.png') });
    console.log('[verify-phase9-ui] Saved picker-applied.png');

    console.log('[verify-phase9-ui] Phase 9 UI Walkthrough completed successfully!');
  } catch (err) {
    console.error('[verify-phase9-ui] Failure during UI walkthrough:', err);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
    await vite.close().catch(() => {});
    if (appServer) appServer.closeAllConnections();
    if (demoServer) demoServer.close();
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((err) => {
  console.error('[verify-phase9-ui] Uncaught error:', err);
  process.exit(1);
});
