import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

async function runProdSmoke() {
  console.log('>>> ChangeWatch Production Boot Smoke Test');

  const clientDist = path.resolve(process.cwd(), 'dist/client/index.html');
  if (!fs.existsSync(clientDist)) {
    throw new Error('Production client bundle not found at dist/client/index.html. Run npm run build first.');
  }

  const port = Math.floor(Math.random() * 8000) + 32000;
  const tempDb = path.join(os.tmpdir(), `changewatch-smoke-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  const appSecret = crypto.randomBytes(32).toString('hex');

  console.log(`[ProdSmoke] Launching server on port ${port} with temp DB: ${tempDb}`);

  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    'src/server/index.ts',
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: port.toString(),
      BASE_URL: `http://127.0.0.1:${port}`,
      DATABASE_PATH: tempDb,
      APP_SECRET: appSecret,
      COOKIE_SECRET: appSecret,
      PBKDF2_ITERATIONS: '600000',
      ALLOW_LOCAL_DEMO: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (d) => process.stdout.write(`[Server stdout] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[Server stderr] ${d}`));

  let serverStarted = false;
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < 15000) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          serverStarted = true;
          break;
        }
      } catch {
        // server not ready yet
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!serverStarted) {
      throw new Error('Production server failed to start and respond to /api/health within 15s');
    }

    console.log('[ProdSmoke] Server booted! Executing production smoke assertions...');

    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (healthRes.status !== 200) {
      throw new Error(`Expected /api/health to return 200, got ${healthRes.status}`);
    }
    const healthJson = await healthRes.json() as { ok: boolean };
    if (!healthJson.ok) {
      throw new Error('/api/health did not return { ok: true }');
    }
    console.log('  ✓ /api/health returns 200 JSON { ok: true }');

    // 2. Root route SPA fallback
    const rootRes = await fetch(`http://127.0.0.1:${port}/`);
    if (rootRes.status !== 200) {
      throw new Error(`Expected / to return 200, got ${rootRes.status}`);
    }
    const rootHtml = await rootRes.text();
    if (!rootHtml.includes('<div id="root">') && !rootHtml.includes('ChangeWatch')) {
      throw new Error('/ did not return production index.html');
    }
    console.log('  ✓ / returns 200 index.html');

    // 3. Deep client route SPA fallback
    const deepRes = await fetch(`http://127.0.0.1:${port}/monitors/123`);
    if (deepRes.status !== 200) {
      throw new Error(`Expected /monitors/123 to return 200, got ${deepRes.status}`);
    }
    const deepHtml = await deepRes.text();
    if (!deepHtml.includes('<div id="root">') && !deepHtml.includes('ChangeWatch')) {
      throw new Error('/monitors/123 did not return production index.html');
    }
    console.log('  ✓ /monitors/123 returns 200 index.html');

    // 4. Unknown API route returns 404 JSON, NOT index.html
    const apiNopeRes = await fetch(`http://127.0.0.1:${port}/api/nope`);
    if (apiNopeRes.status !== 404) {
      throw new Error(`Expected /api/nope to return 404, got ${apiNopeRes.status}`);
    }
    const nopeType = apiNopeRes.headers.get('content-type') || '';
    if (!nopeType.includes('application/json')) {
      throw new Error(`Expected /api/nope to return JSON, got content-type: ${nopeType}`);
    }
    const nopeJson = await apiNopeRes.json() as { error: string };
    if (!nopeJson.error) {
      throw new Error('/api/nope returned JSON without error field');
    }
    console.log('  ✓ /api/nope returns 404 JSON error');

    console.log('[ProdSmoke] All assertions PASSED! Shutting down server...');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    try {
      if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);
      if (fs.existsSync(`${tempDb}-wal`)) fs.unlinkSync(`${tempDb}-wal`);
      if (fs.existsSync(`${tempDb}-shm`)) fs.unlinkSync(`${tempDb}-shm`);
    } catch {}
  }

  console.log('======================================================================');
  console.log('  ✅ PASS | ChangeWatch Production Boot Smoke Test');
  console.log('======================================================================');
}

runProdSmoke().catch((err) => {
  console.error('[ProdSmoke] FAILED:', err);
  process.exit(1);
});
