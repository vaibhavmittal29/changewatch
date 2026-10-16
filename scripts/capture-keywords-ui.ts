import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { createApp } from '../src/server/app.js';
import { createDemoApp } from '../src/server/demo/demoServer.js';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';

async function captureKeywordsUiScreenshot() {
  const globalTimeout = setTimeout(() => {
    console.error('Timed out capturing keywords UI screenshot');
    process.exit(1);
  }, 30000);
  globalTimeout.unref();

  let demoServer: Server | null = null;
  let appServer: Server | null = null;
  const testDbPath = path.resolve(process.cwd(), './data/test_keywords_ui.db');

  try {
    const finalDir = path.resolve(process.cwd(), 'docs/evidence/final');
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });
    if (fs.existsSync(testDbPath)) { try { fs.unlinkSync(testDbPath); } catch {} }

    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';
    process.env.ALLOW_LOCAL_DEMO = 'true';
    process.env.DEMO_PORT = '4005';

    console.log('[1/6] Initializing DB...');
    const db = getDb(testDbPath);
    migrate(db);

    console.log('[2/6] Starting Demo Server on 4005...');
    const demoApp = createDemoApp();
    await new Promise<void>(resolve => {
      demoServer = demoApp.listen(4005, '127.0.0.1', () => resolve());
    });

    console.log('[3/6] Starting App Server on 3005 with static dist/client...');
    const app = createApp();
    const clientDist = path.resolve(process.cwd(), 'dist/client');
    app.use(express.static(clientDist));
    app.use((_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });

    await new Promise<void>(resolve => {
      appServer = app.listen(3005, '127.0.0.1', () => resolve());
    });

    console.log('[4/6] Launching Playwright browser...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    console.log('[5/6] Navigating to http://127.0.0.1:3005/...');
    await page.goto('http://127.0.0.1:3005/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // Register user
    console.log('Registering test user...');
    await page.click('button:text-is("Create Account")');
    await page.fill('input[placeholder="Alex Mercer"]', 'QA Engineer');
    await page.fill('input[type="email"]', 'keywords@changewatch.local');
    await page.fill('input[type="password"]', 'Password123!');
    await page.click('button[type="submit"]:has-text("Register & Continue")');

    await page.waitForSelector('h1:has-text("Monitors Dashboard")', { timeout: 10000 });

    // Open Add Monitor Modal
    console.log('Opening Add Monitor modal...');
    await page.click('button:has-text("Add Monitor")');
    await page.waitForSelector('h2:has-text("Add New Monitor")');

    await page.fill('input[placeholder="https://example.com/pricing"]', 'http://127.0.0.1:4005/demo/headline');
    await page.fill('input[placeholder="e.g. Example Pricing Page"]', 'E-Commerce Sale Watcher');

    // Click Show Advanced Options
    console.log('Expanding advanced options...');
    await page.click('button:has-text("Show Advanced")');
    await page.waitForSelector('input[placeholder*="Comma-separated keywords"]');

    // Fill keyword alert rules
    await page.fill('input[placeholder*="Comma-separated keywords"]', 'discount, sale, regex:\\$\\d+, !sold out');
    await page.waitForTimeout(500);

    // Capture screenshot of keyword configuration UI
    const targetScreenshot = path.join(finalDir, 'keywords_ui.png');
    await page.screenshot({ path: targetScreenshot, fullPage: true });
    console.log(`[6/6] Saved keywords UI screenshot to: ${targetScreenshot}`);

    await browser.close();
  } finally {
    if (appServer) await new Promise(r => (appServer as Server).close(r));
    if (demoServer) await new Promise(r => (demoServer as Server).close(r));
    closeDb();
    if (fs.existsSync(testDbPath)) { try { fs.unlinkSync(testDbPath); } catch {} }
  }
}

captureKeywordsUiScreenshot().catch(err => {
  console.error('Error capturing screenshot:', err);
  process.exit(1);
});
