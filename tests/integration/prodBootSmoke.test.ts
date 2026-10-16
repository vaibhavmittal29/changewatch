import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app';

describe('Phase 1: Production Boot Smoke & Route Validation', () => {
  let app: express.Express;
  let server: Server;
  let port: number;
  const clientDist = path.resolve(process.cwd(), 'dist/client');

  beforeAll(async () => {
    app = createApp();

    // Mount production static serving and Express 5 wildcard fallback
    if (fs.existsSync(clientDist)) {
      app.use(express.static(clientDist));
      app.get('/{*splat}', (req, res) => {
        if (req.path.startsWith('/api')) {
          res.status(404).json({ error: 'Endpoint not found' });
          return;
        }
        res.sendFile(path.join(clientDist, 'index.html'));
      });
    }

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves /api/health with 200 and JSON ok status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it('serves production index.html on root /', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('ChangeWatch');
  });

  it('serves production index.html on deep client routes like /monitors/123', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/monitors/123`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('ChangeWatch');
  });

  it('returns 404 JSON error for unknown /api/nope and does NOT return index.html', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/nope`);
    expect(res.status).toBe(404);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('application/json');
    const json = (await res.json()) as { error: string };
    expect(json.error).toBeDefined();
    expect(json.error).toBe('Endpoint not found');
  });
});
