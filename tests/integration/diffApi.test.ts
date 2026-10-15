import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { createApp } from '../../src/server/app.js';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { env } from '../../src/server/config.js';

describe('Phase 6 Integration: Diff API & Ownership Isolation (Acceptance Matrix T)', () => {
  let server: Server;
  let baseUrl: string;
  const testDbPath = path.resolve(process.cwd(), './data/test_diff_api.db');
  let userACookie = '';
  let userBCookie = '';
  let v1Id = '';
  let v2Id = '';
  let obs1Id = '';
  let obs2Id = '';

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
    const regARes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'diff_a@example.com', password: 'password123', displayName: 'User A' }),
    });
    userACookie = regARes.headers.get('set-cookie')?.split(';')[0] || '';
    const userAData = (await regARes.json()) as { user: { id: string } };

    // Register User B
    const regBRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'diff_b@example.com', password: 'password123', displayName: 'User B' }),
    });
    userBCookie = regBRes.headers.get('set-cookie')?.split(';')[0] || '';

    // Create target and subscription for User A
    const targetId = crypto.randomUUID();
    const subId = crypto.randomUUID();
    obs1Id = crypto.randomUUID();
    obs2Id = crypto.randomUUID();
    v1Id = crypto.randomUUID();
    v2Id = crypto.randomUUID();

    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'http://example.com/diff-test', 'example.com', 'http://example.com', ?)
    `).run(targetId, nowIso);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, capture_config, capture_fingerprint,
        next_check_at, created_at
      ) VALUES (?, ?, ?, 'Test Diff Monitor', 60, '{}', 'fp-diff', ?, ?)
    `).run(subId, userAData.user.id, targetId, nowIso, nowIso);

    // Create sample screenshot PNGs on disk
    const screenshotsDir = path.join(env.DATA_DIR, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const ss1Path = path.join(screenshotsDir, `${obs1Id}.png`);
    const ss2Path = path.join(screenshotsDir, `${obs2Id}.png`);

    const png1 = new PNG({ width: 50, height: 50 });
    png1.data.fill(255);
    fs.writeFileSync(ss1Path, PNG.sync.write(png1));

    const png2 = new PNG({ width: 50, height: 50 });
    png2.data.fill(255);
    // Add colored rectangle to png2
    for (let i = 0; i < 20 * 20; i++) {
      png2.data[i * 4] = 255;
      png2.data[i * 4 + 1] = 0;
      png2.data[i * 4 + 2] = 0;
    }
    fs.writeFileSync(ss2Path, PNG.sync.write(png2));

    // Insert observations
    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
      VALUES (?, ?, 'fp-diff', 'playwright', 'http://example.com/diff-test', 200, '<p>1</p>', 'Apple\nBanana\nCherry', ?, ?)
    `).run(obs1Id, targetId, ss1Path, nowIso);

    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, screenshot_path, captured_at)
      VALUES (?, ?, 'fp-diff', 'playwright', 'http://example.com/diff-test', 200, '<p>2</p>', 'Apple\nBlueberry\nCherry\nDate', ?, ?)
    `).run(obs2Id, targetId, ss2Path, nowIso);

    // Insert monitor_versions
    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, change_summary, created_at)
      VALUES (?, ?, ?, 1, 'hash-v1', 'Apple\nBanana\nCherry', 'Initial version', ?)
    `).run(v1Id, subId, obs1Id, nowIso);

    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, change_summary, created_at)
      VALUES (?, ?, ?, 2, 'hash-v2', 'Apple\nBlueberry\nCherry\nDate', '2 lines added, 1 line removed', ?)
    `).run(v2Id, subId, obs2Id, nowIso);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  it('T: GET /api/diff/text returns unified and side-by-side text diff for User A', async () => {
    const res = await fetch(`${baseUrl}/api/diff/text?from=${v1Id}&to=${v2Id}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: { addedLines: number; removedLines: number };
      summary: string;
      unified: Array<{ type: string; text: string }>;
    };

    expect(body.stats.addedLines).toBe(2);
    expect(body.stats.removedLines).toBe(1);
    expect(body.summary).toContain('2 lines added');
    expect(body.summary).toContain('1 line removed');
    expect(body.unified.some(l => l.type === 'added' && l.text === 'Blueberry')).toBe(true);
    expect(body.unified.some(l => l.type === 'removed' && l.text === 'Banana')).toBe(true);
  });

  it('T: GET /api/diff/image computes visual diff, reports percentage and serves cached PNG', async () => {
    const res = await fetch(`${baseUrl}/api/diff/image?from=${v1Id}&to=${v2Id}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changedPct: number;
      diffPixels: number;
      diffImageUrl: string;
    };

    expect(body.changedPct).toBeGreaterThan(0);
    expect(body.diffPixels).toBeGreaterThan(0);
    expect(body.diffImageUrl).toMatch(/^\/api\/diff\/image-file\/diff_/);

    // Fetch the generated diff image file
    const imgRes = await fetch(`${baseUrl}${body.diffImageUrl}`, {
      headers: { Cookie: userACookie },
    });
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('content-type')).toBe('image/png');
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
    expect(imgBuffer.length).toBeGreaterThan(50);
  });

  it('GET /api/versions/:id returns single version metadata and screenshot info', async () => {
    const res = await fetch(`${baseUrl}/api/versions/${v1Id}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      versionNumber: number;
      hasScreenshot: boolean;
      screenshotUrl: string | null;
    };

    expect(body.id).toBe(v1Id);
    expect(body.versionNumber).toBe(1);
    expect(body.hasScreenshot).toBe(true);
    expect(body.screenshotUrl).toBe(`/api/diff/screenshot/${obs1Id}`);
  });

  it('A1: User B cannot access or diff User A versions (strict ownership isolation)', async () => {
    // User B attempts to text-diff User A's versions
    const textRes = await fetch(`${baseUrl}/api/diff/text?from=${v1Id}&to=${v2Id}`, {
      headers: { Cookie: userBCookie },
    });
    expect(textRes.status).toBe(404);

    // User B attempts to image-diff User A's versions
    const imgRes = await fetch(`${baseUrl}/api/diff/image?from=${v1Id}&to=${v2Id}`, {
      headers: { Cookie: userBCookie },
    });
    expect(imgRes.status).toBe(404);

    // User B attempts to inspect User A's version
    const verRes = await fetch(`${baseUrl}/api/versions/${v1Id}`, {
      headers: { Cookie: userBCookie },
    });
    expect(verRes.status).toBe(404);
  });
});
