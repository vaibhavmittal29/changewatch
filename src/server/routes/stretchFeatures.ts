import { Router } from 'express';
import { getDb } from '../db/index.js';
import { env } from '../config.js';
import { requireAuth } from '../auth/middleware.js';

export const stretchRouter = Router();

import crypto from 'node:crypto';

export function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeCdata(str: string): string {
  if (!str) return '';
  return str.replace(/]]>/g, ']]]]><![CDATA[>');
}

export function extractNumericValue(text: string, label?: string): number | null {
  if (!text) return null;
  if (label && label.trim().length > 0) {
    const escaped = label.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const labelRegex = new RegExp(`${escaped}\\s*[:=-]?\\s*([+-]?)\\s*[$€£¥₹]?\\s*([+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, 'i');
    const labelMatch = text.match(labelRegex);
    if (labelMatch) {
      const isNeg = labelMatch[1] === '-' || labelMatch[2].startsWith('-');
      const raw = labelMatch[2].replace(/^[+-]/, '').replace(/,/g, '');
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed)) return isNeg ? -parsed : parsed;
    }
  }

  const match = text.match(/([+-]?)\s*[$€£¥₹]?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  if (!match) return null;
  const isNegative = match[1] === '-' || match[2].startsWith('-');
  const rawNum = match[2].replace(/^[+-]/, '').replace(/,/g, '');
  const parsed = parseFloat(rawNum);
  if (!Number.isFinite(parsed)) return null;
  return isNegative ? -parsed : parsed;
}

/**
 * GET /api/subscriptions/:id/numeric-history (STRETCH Item)
 * Extracts numeric metrics across version history for Chart.js / Canvas visualization.
 */
stretchRouter.get('/subscriptions/:id/numeric-history', requireAuth, (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const label = typeof req.query.label === 'string' ? req.query.label : undefined;
  const db = getDb();

  const sub = db.prepare('SELECT id, name FROM subscriptions WHERE id = ? AND user_id = ?').get(id, userId);
  if (!sub) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  const versions = db.prepare(`
    SELECT version_number, stored_text, created_at
    FROM monitor_versions
    WHERE subscription_id = ?
    ORDER BY version_number ASC
  `).all(id) as Array<{ version_number: number; stored_text: string; created_at: string }>;

  const points = versions.map(v => ({
    versionNumber: v.version_number,
    timestamp: v.created_at,
    value: extractNumericValue(v.stored_text, label),
  })).filter((p): p is { versionNumber: number; timestamp: string; value: number } => p.value !== null);

  res.json({ subscriptionId: id, points });
});

/**
 * POST /api/subscriptions/:id/rotate-feed-token (Phase 9 RSS Privacy)
 * Rotates or generates a revocable feed token for private RSS syndication.
 */
stretchRouter.post('/subscriptions/:id/rotate-feed-token', requireAuth, (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const db = getDb();

  const sub = db.prepare('SELECT id FROM subscriptions WHERE id = ? AND user_id = ?').get(id, userId);
  if (!sub) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  const newToken = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE subscriptions SET feed_token = ? WHERE id = ?').run(newToken, id);

  res.json({
    subscriptionId: id,
    feedToken: newToken,
    rssUrl: `${env.BASE_URL}/api/subscriptions/${id}/rss?token=${newToken}`,
  });
});

/**
 * GET /api/subscriptions/:id/rss (Phase 9 RSS Privacy)
 * Generates an RSS 2.0 XML feed authenticated via revocable feed token.
 * Feeds do not leak sequential IDs, private URLs, or cross-tenant subscription metadata.
 */
stretchRouter.get('/subscriptions/:id/rss', (req, res) => {
  const { id } = req.params;
  const token = (req.query.token as string | undefined) || req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!token) {
    res.status(401).type('text/plain').send('Unauthorized: Missing feed token');
    return;
  }

  const db = getDb();
  const sub = db.prepare(`
    SELECT s.id, s.name, s.user_id, s.feed_token
    FROM subscriptions s
    WHERE s.id = ?
  `).get(id) as { id: string; name: string; user_id: string; feed_token: string | null } | undefined;

  if (!sub) {
    res.status(404).type('text/plain').send('Subscription not found');
    return;
  }

  if (!sub.feed_token || sub.feed_token !== token) {
    res.status(403).type('text/plain').send('Forbidden: Invalid feed token');
    return;
  }

  const events = db.prepare(`
    SELECT id, event_type, summary, created_at, previous_version_id, current_version_id
    FROM change_events
    WHERE subscription_id = ?
    ORDER BY created_at DESC
    LIMIT 25
  `).all(id) as Array<{ id: string; event_type: string; summary: string; created_at: string; previous_version_id: string | null; current_version_id: string | null }>;

  const itemsXml = events.map(ev => {
    const pubDate = new Date(ev.created_at).toUTCString();
    const link = `${env.BASE_URL}/compare/${sub.id}?from=${ev.previous_version_id || ''}&to=${ev.current_version_id || ''}`;
    return `
    <item>
      <title>[${escapeXml(ev.event_type)}] ${escapeXml(sub.name)} - ${escapeXml(ev.summary)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(ev.id)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${escapeCdata(ev.summary)}]]></description>
    </item>`;
  }).join('');

  const rssXml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>ChangeWatch: ${escapeXml(sub.name)}</title>
    <link>${escapeXml(env.BASE_URL)}/monitor/${escapeXml(sub.id)}</link>
    <description>Live change alert feed for ${escapeXml(sub.name)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${itemsXml}
  </channel>
</rss>`;

  res.type('application/rss+xml').send(rssXml);
});
