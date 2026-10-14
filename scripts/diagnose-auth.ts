import { createApp } from '../src/server/app.js';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';

async function diagnose() {
  console.log('[Diag] Initializing DB...');
  const db = getDb();
  migrate(db);

  console.log('[Diag] Creating app...');
  const app = createApp();

  console.log('[Diag] Binding server to 127.0.0.1:3001...');
  const server = app.listen(3001, '127.0.0.1');

  await new Promise<void>((resolve) => server.once('listening', resolve));
  console.log('[Diag] Server listening on http://127.0.0.1:3001');

  try {
    // 1. Health check
    console.log('[Diag] Testing GET /api/health...');
    const t0 = Date.now();
    const healthRes = await fetch('http://127.0.0.1:3001/api/health');
    console.log(`[Diag] Health status: ${healthRes.status} (${Date.now() - t0}ms)`);
    console.log('[Diag] Health response:', await healthRes.json());

    // 2. Register
    const email = `diag_${Date.now()}@example.com`;
    console.log(`[Diag] Testing POST /api/auth/register with email: ${email}...`);
    const t1 = Date.now();
    const regRes = await fetch('http://127.0.0.1:3001/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'Password123!',
        displayName: 'Diag User',
      }),
    });
    console.log(`[Diag] Register status: ${regRes.status} (${Date.now() - t1}ms)`);
    const regJson = await regRes.json();
    console.log('[Diag] Register response:', regJson);

    // 3. Login
    console.log(`[Diag] Testing POST /api/auth/login...`);
    const t2 = Date.now();
    const loginRes = await fetch('http://127.0.0.1:3001/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'Password123!',
      }),
    });
    console.log(`[Diag] Login status: ${loginRes.status} (${Date.now() - t2}ms)`);
    const loginJson = await loginRes.json();
    console.log('[Diag] Login response:', loginJson);

  } catch (err) {
    console.error('[Diag] Error encountered:', err);
  } finally {
    console.log('[Diag] Closing server and DB...');
    server.close();
    closeDb();
    console.log('[Diag] Diagnostic complete.');
  }
}

diagnose();
