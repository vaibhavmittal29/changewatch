import { chromium, type Browser } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server/app.js';
import { createDemoApp } from '../src/server/demo/demoServer.js';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';
import type { ViteDevServer } from 'vite';

function checkPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function runPhase8UiWalkthrough() {
  const globalTimeout = setTimeout(() => {
    console.error('[Timeout] Walkthrough timed out after 3 minutes. Force exiting with code 1.');
    process.exit(1);
  }, 180000);
  globalTimeout.unref();

  let browser: Browser | null = null;
  let vite: ViteDevServer | null = null;
  let demoServer: Server | null = null;
  let appServer: Server | null = null;

  const testDbPath = path.resolve(process.cwd(), './data/test_phase8_ui.db');

  try {
    // 1. Verify ports 3000 and 4000 are free
    console.log('[Phase 8 Verification] Checking ports 3000 and 4000...');
    const port3000Free = await checkPortFree(3000);
    const port4000Free = await checkPortFree(4000);

    if (!port3000Free) {
      throw new Error('Port 3000 is already in use. Please terminate existing processes before running walkthrough.');
    }
    if (!port4000Free) {
      throw new Error('Port 4000 is already in use. Please terminate existing processes before running walkthrough.');
    }

    const evidenceDir = path.resolve(process.cwd(), 'docs/evidence/phase-8');
    if (!fs.existsSync(evidenceDir)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
    }

    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }

    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';
    process.env.ALLOW_LOCAL_DEMO = 'true';
    process.env.DEMO_PORT = '4000';

    const db = getDb(testDbPath);
    migrate(db);

    // 2. Start Demo Server on port 4000
    const demoApp = createDemoApp();
    await new Promise<void>(resolve => {
      demoServer = demoApp.listen(4000, '127.0.0.1', () => {
        console.log('Demo fixture server listening on http://127.0.0.1:4000');
        resolve();
      });
    });

    // 3. Start ChangeWatch app on port 3000 with Vite middleware
    const app = createApp();
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    await new Promise<void>(resolve => {
      appServer = app.listen(3000, '127.0.0.1', () => {
        console.log('ChangeWatch App listening on http://127.0.0.1:3000');
        resolve();
      });
    });

    // 4. Launch Playwright
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    console.log('Navigating to ChangeWatch login...');
    await page.goto('http://127.0.0.1:3000/');
    await page.waitForTimeout(1000);

    // Switch to Create Account tab and register user
    console.log('Registering test user...');
    await page.click('button:text-is("Create Account")');
    await page.fill('input[placeholder="Alex Mercer"]', 'Lead Engineer');
    await page.fill('input[type="email"]', 'lead@changewatch.local');
    await page.fill('input[type="password"]', 'Password123!');
    await page.click('button[type="submit"]:has-text("Register & Continue")');

    // Wait for Dashboard to load
    await page.waitForSelector('h1:has-text("Monitors Dashboard")', { timeout: 10000 });
    console.log('Dashboard loaded.');

    // Screenshot 1: Empty Dashboard
    await page.screenshot({ path: path.join(evidenceDir, 'dashboard-empty.png') });
    console.log('Saved dashboard-empty.png');

    // Screenshot 2: Open Add Monitor Modal
    await page.click('button:has-text("Add Monitor")');
    await page.waitForSelector('h2:has-text("Add New Monitor")');
    await page.fill('input[placeholder="https://example.com/pricing"]', 'http://127.0.0.1:4000/demo/headline');
    await page.fill('input[placeholder="e.g. Example Pricing Page"]', 'Demo Headline News');
    await page.screenshot({ path: path.join(evidenceDir, 'add-monitor-modal.png') });
    console.log('Saved add-monitor-modal.png');

    // Submit form
    await page.click('button[type="submit"]:has-text("Add Monitor")');
    await page.waitForSelector('button:has-text("Demo Headline News")', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Screenshot 3: Dashboard with active monitor
    await page.screenshot({ path: path.join(evidenceDir, 'dashboard.png') });
    console.log('Saved dashboard.png');

    // Click into Monitor Detail
    await page.click('button:has-text("Demo Headline News")');
    await page.waitForSelector('h1:has-text("Demo Headline News")', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Screenshot 4: Monitor Detail & Timeline
    await page.screenshot({ path: path.join(evidenceDir, 'monitor-detail-timeline.png') });
    console.log('Saved monitor-detail-timeline.png');

    // Navigate to Settings
    await page.click('button:has-text("Settings")');
    await page.waitForSelector('h1:has-text("Alert Destinations")', { timeout: 10000 });
    await page.fill('input[placeholder="https://discord.com/api/webhooks/..."]', 'https://discord.com/api/webhooks/12345/abcdef');
    await page.screenshot({ path: path.join(evidenceDir, 'settings.png') });
    console.log('Saved settings.png');

    // Navigate to Test Rig
    await page.click('button:has-text("Test Rig")');
    await page.waitForSelector('h1:has-text("Test Rig & Demo Fixtures")', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(evidenceDir, 'test-rig.png') });
    console.log('Saved test-rig.png');

    console.log('Phase 8 UI Walkthrough completed successfully!');
  } catch (err) {
    console.error('Walkthrough error:', err);
    process.exitCode = 1;
  } finally {
    // Graceful teardown in strict order
    console.log('[Cleanup] Closing browser...');
    if (browser) {
      try { await browser.close(); } catch {}
    }

    console.log('[Cleanup] Closing Vite dev server...');
    if (vite) {
      try { await vite.close(); } catch {}
    }

    console.log('[Cleanup] Closing HTTP servers...');
    if (appServer) {
      try {
        (appServer as any).closeAllConnections?.();
        await new Promise<void>(resolve => (appServer as Server).close(() => resolve()));
      } catch {}
    }

    if (demoServer) {
      try {
        (demoServer as any).closeAllConnections?.();
        await new Promise<void>(resolve => (demoServer as Server).close(() => resolve()));
      } catch {}
    }

    console.log('[Cleanup] Closing database connection...');
    closeDb();

    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }

    clearTimeout(globalTimeout);
    console.log('[Cleanup] Teardown complete. Exiting.');
    process.exit(process.exitCode ?? 0);
  }
}

runPhase8UiWalkthrough();
