import { Router } from 'express';
import { getDb } from '../db/index.js';
import { enqueueCheckJob } from '../queue/jobs.js';

export const subscriptionActionsRouter = Router();

// POST /api/subscriptions/:id/check-now
subscriptionActionsRouter.post('/subscriptions/:id/check-now', (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const db = getDb();

  const sub = db.prepare(`
    SELECT id, target_id, capture_fingerprint, is_paused
    FROM subscriptions
    WHERE id = ? AND user_id = ?
  `).get(id, userId) as { id: string; target_id: string; capture_fingerprint: string; is_paused: number } | undefined;

  if (!sub) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE subscriptions
    SET next_check_at = ?
    WHERE id = ?
  `).run(nowIso, id);

  enqueueCheckJob(db, sub.target_id, sub.capture_fingerprint, nowIso);

  res.json({ ok: true, message: 'Check queued immediately' });
});

// POST /api/subscriptions/:id/pause
subscriptionActionsRouter.post('/subscriptions/:id/pause', (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const db = getDb();

  const sub = db.prepare('SELECT id FROM subscriptions WHERE id = ? AND user_id = ?').get(id, userId);
  if (!sub) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  db.prepare('UPDATE subscriptions SET is_paused = 1 WHERE id = ?').run(id);
  res.json({ ok: true, is_paused: true });
});

// POST /api/subscriptions/:id/resume
subscriptionActionsRouter.post('/subscriptions/:id/resume', (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const db = getDb();

  const sub = db.prepare(`
    SELECT id, target_id, capture_fingerprint
    FROM subscriptions
    WHERE id = ? AND user_id = ?
  `).get(id, userId) as { id: string; target_id: string; capture_fingerprint: string } | undefined;

  if (!sub) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  const nowIso = new Date().toISOString();
  db.prepare('UPDATE subscriptions SET is_paused = 0, next_check_at = ? WHERE id = ?').run(nowIso, id);
  enqueueCheckJob(db, sub.target_id, sub.capture_fingerprint, nowIso);

  res.json({ ok: true, is_paused: false });
});

// GET /api/subscriptions/:id/timeline
subscriptionActionsRouter.get('/subscriptions/:id/timeline', (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const db = getDb();

  const sub = db.prepare(`
    SELECT s.id, s.name, s.interval_minutes, s.sensitivity, s.is_paused,
           t.canonical_url, t.hostname, t.origin,
           COALESCE(st.is_noisy, 0) as is_noisy,
           COALESCE(st.is_currently_down, 0) as is_currently_down
    FROM subscriptions s
    JOIN targets t ON t.id = s.target_id
    LEFT JOIN sub_state st ON st.subscription_id = s.id
    WHERE s.id = ? AND s.user_id = ?
  `).get(id, userId) as Record<string, unknown> | undefined;

  if (!sub) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  const versions = db.prepare(`
    SELECT mv.id, mv.version_number, mv.content_hash, mv.change_summary,
           mv.created_at, mv.observation_id, obs.screenshot_path
    FROM monitor_versions mv
    JOIN observations obs ON obs.id = mv.observation_id
    WHERE mv.subscription_id = ?
    ORDER BY mv.version_number DESC
  `).all(id);

  const events = db.prepare(`
    SELECT ce.id, ce.event_type, ce.summary, ce.suppressed, ce.created_at,
           ce.previous_version_id, ce.current_version_id
    FROM change_events ce
    WHERE ce.subscription_id = ?
    ORDER BY ce.created_at DESC
    LIMIT 50
  `).all(id);

  const recent_checks = db.prepare(`
    SELECT cr.id, cr.outcome, cr.reason, cr.http_status, cr.duration_ms,
           cr.was_deduplicated, cr.created_at
    FROM check_runs cr
    WHERE cr.subscription_id = ?
    ORDER BY cr.created_at DESC
    LIMIT 30
  `).all(id);

  res.json({
    subscription: sub,
    versions,
    events,
    recent_checks,
  });
});
