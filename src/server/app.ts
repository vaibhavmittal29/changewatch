import express from 'express';
import cookieParser from 'cookie-parser';
import { attachSession, requireAuth } from './auth/middleware.js';
import { verifyCsrf } from './auth/csrf.js';
import { authRouter } from './routes/auth.js';
import { subscriptionsRouter } from './routes/subscriptions.js';

import { diffRouter } from './routes/diff.js';
import { notificationsRouter } from './routes/notifications.js';
import { dashboardRouter } from './routes/dashboard.js';
import { subscriptionActionsRouter } from './routes/subscriptionActions.js';
import { demoRouter } from './routes/demo.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // Attach session if cookie exists
  app.use(attachSession);

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // Auth routes (some endpoints are public, e.g. login/register)
  app.use('/api/auth', authRouter);

  // CSRF validation on all subsequent state-changing routes
  app.use('/api', verifyCsrf);

  // Authenticated API routes
  app.use('/api/subscriptions', requireAuth, subscriptionsRouter);
  app.use('/api', requireAuth, subscriptionActionsRouter);
  app.use('/api', requireAuth, dashboardRouter);
  app.use('/api/diff', requireAuth, diffRouter);
  app.use('/api', requireAuth, notificationsRouter);
  app.use('/api/demo', requireAuth, demoRouter);

  return app;
}
