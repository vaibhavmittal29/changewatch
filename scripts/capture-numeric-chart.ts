import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import crypto from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';
import { hashPassword } from '../src/server/auth/password.js';

async function captureNumericChartScreenshot() {
  const globalTimeout = setTimeout(() => {
    console.error('Timed out capturing numeric chart screenshot');
    process.exit(1);
  }, 30000);
  globalTimeout.unref();

  let appServer: Server | null = null;
  const testDbPath = path.resolve(process.cwd(), './data/test_numeric_chart.db');

  try {
    const finalDir = path.resolve(process.cwd(), 'docs/evidence/final');
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });
    if (fs.existsSync(testDbPath)) { try { fs.unlinkSync(testDbPath); } catch {} }

    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';

    console.log('[1/5] Setting up database with multi-version numeric history...');
    const db = getDb(testDbPath);
    migrate(db);

    const userId = crypto.randomUUID();
    const { hash, salt, iterations } = await hashPassword('Password123!', 1000);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
      VALUES (?, 'chart_qa@changewatch.local', ?, ?, ?, 'Chart QA')
    `).run(userId, hash, salt, iterations);

    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://demo.store.local/item', 'demo.store.local', 'https://demo.store.local', ?)
    `).run(targetId, nowIso);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, sensitivity,
        include_selectors, ignore_selectors, noise_filters,
        learned_ignore_patterns, keyword_rules, is_paused, created_at
      ) VALUES (?, ?, ?, 'GPU Pricing Tracker', 15, ?, '{}', 'fp1', 'balanced', '[]', '[]', '{}', '[]', '[]', 0, ?)
    `).run(subId, userId, targetId, nowIso, nowIso);

    db.prepare('INSERT INTO sub_state (subscription_id, consecutive_failures, is_currently_down, recent_checks_window) VALUES (?, 0, 0, \'[]\')').run(subId);

    // Insert 5 versions showing price dropping over time: $1,499.00 -> $1,299.99 -> $1,150.00 -> $999.00 -> $849.50
    const priceSeries = [
      { v: 1, text: 'Product Price: $1,499.00 (MSRP)', delay: '-4 hours' },
      { v: 2, text: 'Product Price: $1,299.99 (Special discount)', delay: '-3 hours' },
      { v: 3, text: 'Product Price: $1,150.00 (Weekend deal)', delay: '-2 hours' },
      { v: 4, text: 'Product Price: $999.00 (Flash sale)', delay: '-1 hour' },
      { v: 5, text: 'Product Price: $849.50 (Clearance finale)', delay: '-10 minutes' },
    ];

    for (const item of priceSeries) {
      const obsId = crypto.randomUUID();
      const vId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
        VALUES (?, ?, 'fp1', 'playwright', 'https://demo.store.local/item', 200, '<html></html>', ?, datetime('now', ?))
      `).run(obsId, targetId, item.text, item.delay);

      db.prepare(`
        INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, change_summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'Price adjusted', datetime('now', ?))
      `).run(vId, subId, obsId, item.v, `hash_v${item.v}`, item.text, item.delay);
    }

    console.log('[2/5] Starting ChangeWatch App Server on 3006...');
    const app = createApp();
    const clientDist = path.resolve(process.cwd(), 'dist/client');
    app.use(express.static(clientDist));
    app.use((_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });

    await new Promise<void>(resolve => {
      appServer = app.listen(3006, '127.0.0.1', () => resolve());
    });

    console.log('[3/5] Launching Playwright browser...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });

    console.log('[4/5] Logging in and opening monitor detail page...');
    await page.goto('http://127.0.0.1:3006/');
    await page.fill('input[type="email"]', 'chart_qa@changewatch.local');
    await page.fill('input[type="password"]', 'Password123!');
    await page.click('button[type="submit"]:has-text("Sign In")');

    await page.waitForSelector('h1:has-text("Monitors Dashboard")', { timeout: 10000 });

    // Click into GPU Pricing Tracker monitor detail
    await page.click('button:has-text("GPU Pricing Tracker")');
    await page.waitForSelector('h1:has-text("GPU Pricing Tracker")', { timeout: 10000 });

    // Wait for Numeric Trend Chart SVG to render with data
    await page.waitForSelector('h3:has-text("Numeric Value Trend History")', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Save screenshot of chart
    const targetScreenshot = path.join(finalDir, 'numeric_chart.png');
    await page.screenshot({ path: targetScreenshot, fullPage: true });
    console.log(`[5/5] Saved numeric chart screenshot to: ${targetScreenshot}`);

    await browser.close();
  } finally {
    if (appServer) await new Promise(r => (appServer as Server).close(r));
    closeDb();
    if (fs.existsSync(testDbPath)) { try { fs.unlinkSync(testDbPath); } catch {} }
  }
}

captureNumericChartScreenshot().catch(err => {
  console.error('Error capturing chart screenshot:', err);
  process.exit(1);
});
