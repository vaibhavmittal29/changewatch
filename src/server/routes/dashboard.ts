import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ACTIVE_JOB_STATUSES } from '../queue/jobConstants.js';

export const dashboardRouter = Router();

export type DashboardStatus = 'PAUSED' | 'CHECKING' | 'BLOCKED' | 'ERROR' | 'CHANGED' | 'OK';

interface SubscriptionDashboardRow {
  id: string;
  name: string;
  canonical_url: string;
  hostname: string;
  origin: string;
  interval_minutes: number;
  sensitivity: string;
  is_paused: number;
  is_noisy: number;
  is_currently_down: number;
  last_fetch_outcome: string | null;
  last_checked_at: string | null;
  last_changed_at: string | null;
  version_count: number;
  active_jobs: number;
}

export function computeStatusBadge(row: SubscriptionDashboardRow): DashboardStatus {
  if (row.is_paused === 1) return 'PAUSED';
  if (row.active_jobs > 0) return 'CHECKING';
  if (row.is_currently_down === 1 || row.last_fetch_outcome === 'BLOCKED') return 'BLOCKED';
  if (row.last_fetch_outcome === 'ERROR') return 'ERROR';
  if (row.last_changed_at) {
    const changedTime = new Date(row.last_changed_at).getTime();
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (changedTime >= twentyFourHoursAgo) return 'CHANGED';
  }
  return 'OK';
}

// GET /api/dashboard
dashboardRouter.get('/dashboard', (req, res) => {
  const db = getDb();
  const userId = req.user!.id;

  const activeStatusesSql = ACTIVE_JOB_STATUSES.map(s => `'${s}'`).join(', ');
  const rows = db.prepare(`
    SELECT s.id, s.name, s.interval_minutes, s.sensitivity, s.is_paused,
           t.canonical_url, t.hostname, t.origin, t.last_fetched_at as last_checked_at, t.last_fetch_outcome,
           COALESCE(st.is_noisy, 0) as is_noisy,
           COALESCE(st.is_currently_down, 0) as is_currently_down,
           (SELECT COUNT(*) FROM monitor_versions mv WHERE mv.subscription_id = s.id) as version_count,
           (SELECT MAX(ce.created_at) FROM change_events ce WHERE ce.subscription_id = s.id AND ce.event_type = 'CHANGE') as last_changed_at,
           (SELECT COUNT(*) FROM jobs j WHERE j.target_id = s.target_id AND j.capture_fingerprint = s.capture_fingerprint AND j.status IN (${activeStatusesSql})) as active_jobs
    FROM subscriptions s
    JOIN targets t ON t.id = s.target_id
    LEFT JOIN sub_state st ON st.subscription_id = s.id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `).all(userId) as SubscriptionDashboardRow[];

  const monitors = rows.map(row => ({
    id: row.id,
    name: row.name,
    url: row.canonical_url,
    hostname: row.hostname,
    interval_minutes: row.interval_minutes,
    sensitivity: row.sensitivity,
    is_paused: Boolean(row.is_paused),
    is_noisy: Boolean(row.is_noisy),
    version_count: row.version_count,
    last_checked_at: row.last_checked_at,
    last_changed_at: row.last_changed_at,
    status: computeStatusBadge(row),
  }));

  res.json({ monitors });
});

// GET /api/versions/:id
dashboardRouter.get('/versions/:id', (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const db = getDb();

  const version = db.prepare(`
    SELECT mv.id, mv.subscription_id, mv.version_number, mv.content_hash,
           mv.stored_text, mv.change_summary, mv.created_at, mv.observation_id,
           obs.screenshot_path
    FROM monitor_versions mv
    JOIN subscriptions s ON s.id = mv.subscription_id
    JOIN observations obs ON obs.id = mv.observation_id
    WHERE mv.id = ? AND s.user_id = ?
  `).get(id, userId) as Record<string, unknown> | undefined;

  if (!version) {
    res.status(404).json({ error: 'Version not found or access denied' });
    return;
  }

  res.json({
    id: version.id,
    versionNumber: version.version_number,
    hasScreenshot: Boolean(version.screenshot_path),
    screenshotUrl: version.screenshot_path ? `/api/diff/screenshot/${version.observation_id}` : null,
    createdAt: version.created_at,
    changeSummary: version.change_summary,
    storedText: version.stored_text,
    version,
  });
});
