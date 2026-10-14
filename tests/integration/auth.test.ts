import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/server/app.js';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';

describe('Auth, Sessions, CSRF, Ownership Isolation, and Intervals (A1, A2, D)', () => {
  let server: Server;
  let baseUrl: string;
  const testDbPath = path.resolve(process.cwd(), './data/test_auth.db');

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000'; // Fast PBKDF2 for tests

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

  it('A1: Register and login flow produces session and CSRF token', async () => {
    // 1. Register User A
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user_a@example.com',
        password: 'password123',
        displayName: 'User A',
      }),
    });

    expect(regRes.status).toBe(201);
    const setCookie = regRes.headers.get('set-cookie');
    expect(setCookie).toContain('cw_session=');
    expect(setCookie).toContain('HttpOnly');

    const regData = await regRes.json();
    expect(regData.user.email).toBe('user_a@example.com');
    expect(regData.csrfToken).toBeDefined();

    // 2. /api/auth/me returns User A details with valid cookie
    const cookie = setCookie!.split(';')[0];
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(200);
    const meData = await meRes.json();
    expect(meData.user.email).toBe('user_a@example.com');
    expect(meData.csrfToken).toBe(regData.csrfToken);
  });

  it('A2: Mutating endpoints enforce X-CSRF-Token header', async () => {
    // Register and obtain session
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user_csrf@example.com',
        password: 'password123',
        displayName: 'User CSRF',
      }),
    });
    const cookie = regRes.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await regRes.json();

    // 1. Mutating POST without CSRF token header -> 403 Forbidden
    const noCsrfRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        url: 'https://example.com/blog',
        name: 'CSRF Test',
        interval_minutes: 30,
      }),
    });
    expect(noCsrfRes.status).toBe(403);

    // 2. Mutating POST with invalid CSRF token header -> 403 Forbidden
    const badCsrfRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': 'invalid_token_xyz',
      },
      body: JSON.stringify({
        url: 'https://example.com/blog',
        name: 'CSRF Test',
        interval_minutes: 30,
      }),
    });
    expect(badCsrfRes.status).toBe(403);

    // 3. Mutating POST with correct CSRF token header -> 201 Created
    const okCsrfRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        url: 'https://example.com/blog',
        name: 'CSRF Test',
        interval_minutes: 30,
      }),
    });
    expect(okCsrfRes.status).toBe(201);
  });

  it('D: Enforces interval between 15 and 1440 minutes on standard URLs', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user_interval@example.com',
        password: 'password123',
        displayName: 'User Interval',
      }),
    });
    const cookie = regRes.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await regRes.json();

    // Interval too short (< 15)
    const tooShortRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        url: 'https://example.com/news',
        name: 'News',
        interval_minutes: 10,
      }),
    });
    expect(tooShortRes.status).toBe(400);

    // Interval too long (> 1440)
    const tooLongRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        url: 'https://example.com/news',
        name: 'News',
        interval_minutes: 2000,
      }),
    });
    expect(tooLongRes.status).toBe(400);

    // Valid interval (60 min)
    const validRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        url: 'https://example.com/news',
        name: 'News',
        interval_minutes: 60,
      }),
    });
    expect(validRes.status).toBe(201);
    const validData = await validRes.json();
    expect(validData.next_check_at).toBeDefined();
    // Verify next_check_at is initialized to now (within 5 seconds)
    const nextCheck = new Date(validData.next_check_at).getTime();
    expect(Math.abs(Date.now() - nextCheck)).toBeLessThan(5000);
  });

  it('A1: Strict ownership isolation between User A and User B', async () => {
    // 1. User A creates a monitor
    const regARes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'password123',
        displayName: 'Alice',
      }),
    });
    const cookieA = regARes.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken: csrfA } = await regARes.json();

    const createRes = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
        'X-CSRF-Token': csrfA,
      },
      body: JSON.stringify({
        url: 'https://alice-private-domain.com/status',
        name: "Alice's Monitor",
        interval_minutes: 15,
      }),
    });
    expect(createRes.status).toBe(201);
    const subA = await createRes.json();

    // 2. User B registers and logs in
    const regBRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bob@example.com',
        password: 'password123',
        displayName: 'Bob',
      }),
    });
    const cookieB = regBRes.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken: csrfB } = await regBRes.json();

    // 3. User B lists subscriptions: Alice's monitor must NOT be present
    const listBRes = await fetch(`${baseUrl}/api/subscriptions`, {
      headers: { Cookie: cookieB },
    });
    const listBData = await listBRes.json();
    expect(listBData.subscriptions).toHaveLength(0);

    // 4. User B attempts to PATCH Alice's monitor: must be rejected with 404
    const patchBRes = await fetch(`${baseUrl}/api/subscriptions/${subA.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieB,
        'X-CSRF-Token': csrfB,
      },
      body: JSON.stringify({ name: 'Hacked by Bob' }),
    });
    expect(patchBRes.status).toBe(404);

    // 5. User B attempts to DELETE Alice's monitor: must be rejected with 404
    const deleteBRes = await fetch(`${baseUrl}/api/subscriptions/${subA.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: cookieB,
        'X-CSRF-Token': csrfB,
      },
    });
    expect(deleteBRes.status).toBe(404);

    // 6. Alice's monitor is still intact
    const listARes = await fetch(`${baseUrl}/api/subscriptions`, {
      headers: { Cookie: cookieA },
    });
    const listAData = await listARes.json();
    expect(listAData.subscriptions).toHaveLength(1);
    expect(listAData.subscriptions[0].name).toBe("Alice's Monitor");
  });
});
