import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createApp } from './app.js';
import { getDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { env } from './config.js';

import { Scheduler } from './queue/scheduler.js';
import { WorkerPool } from './queue/worker.js';
import { NotificationWorker } from './notifications/worker.js';
import { startDemoServer } from './demo/demoServer.js';
import { closeBrowser } from './capture/playwrightCapture.js';

async function startServer() {
  // 1. Initialize database & apply schema
  const db = getDb();
  migrate(db);
  console.log(`[Database] SQLite connected at ${env.DATABASE_PATH} (WAL mode, FK enabled)`);

  // 2. Start background queue scheduler and worker pool
  const scheduler = new Scheduler(db);
  scheduler.start();
  console.log(`[Scheduler] Background scheduler started (tick ${env.TICK_MS}ms)`);

  const workerPool = new WorkerPool(db);
  workerPool.start();
  console.log(`[WorkerPool] Worker pool started (${env.WORKER_CONCURRENCY} workers)`);

  const notificationWorker = new NotificationWorker(db);
  notificationWorker.start();
  console.log('[NotificationWorker] Notification outbox worker started');

  // 3. Start local demo server if enabled
  if (env.ALLOW_LOCAL_DEMO) {
    await startDemoServer(env.DEMO_PORT);
  }

  // 4. Create Express app
  const app = createApp();

  // 5. Vite development middleware or static production client
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

  // 6. Start listening on single port
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`[ChangeWatch] Server running at ${env.BASE_URL} (Port ${env.PORT})`);
  });

  const shutdown = async () => {
    console.log('[ChangeWatch] Shutting down gracefully...');
    scheduler.stop();
    workerPool.stop();
    notificationWorker.stop();

    // Drain in-flight jobs up to a 10s deadline
    await Promise.allSettled([
      workerPool.waitForIdle(10_000),
      notificationWorker.waitForIdle(10_000),
    ]);

    await closeBrowser().catch(() => {});
    try {
      db.close();
    } catch {}

    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

startServer().catch(err => {
  console.error('[ChangeWatch] Failed to start server:', err);
  process.exit(1);
});
