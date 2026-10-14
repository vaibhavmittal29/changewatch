import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createApp } from './app.js';
import { getDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { env } from './config.js';

async function startServer() {
  // 1. Initialize database & apply schema
  const db = getDb();
  migrate(db);
  console.log(`[Database] SQLite connected at ${env.DATABASE_PATH} (WAL mode, FK enabled)`);

  // 2. Create Express app
  const app = createApp();

  // 3. Vite development middleware or static production client
  if (env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('[Server] Vite middleware mounted for SPA client');
  } else {
    const clientDist = path.resolve(process.cwd(), 'dist/client');
    if (fs.existsSync(clientDist)) {
      app.use(express.static(clientDist));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(clientDist, 'index.html'));
      });
      console.log(`[Server] Serving production static bundle from ${clientDist}`);
    }
  }

  // 4. Start listening on single port
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`[ChangeWatch] Server running at ${env.BASE_URL} (Port ${env.PORT})`);
  });

  return server;
}

startServer().catch(err => {
  console.error('[ChangeWatch] Failed to start server:', err);
  process.exit(1);
});
