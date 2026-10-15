import { Router } from 'express';
import { getDb } from '../db/index.js';
import { env } from '../config.js';
import { requireAuth } from '../auth/middleware.js';

export const stretchRouter = Router();

/**
 * GET /api/subscriptions/:id/numeric-history (STRETCH Item)
 * Extracts numeric metrics (e.g. price, counts) across version history for Chart.js visualization.
 */
stretchRouter.get('/subscriptions/:id/numeric-history', requireAuth, (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
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

  const points = versions.map(v => {
    // Extract first currency or floating/integer number in the version text
    const match = v.stored_text.match(/\$?(\d+(?:\.\d+)?)/);
    const value = match ? parseFloat(match[1]) : null;
    return {
      versionNumber: v.version_number,
      timestamp: v.created_at,
      value,
    };
  }).filter(p => p.value !== null);

  res.json({ subscriptionId: id, points });
});

/**
 * GET /api/subscriptions/:id/rss (STRETCH Item)
 * Generates an RSS 2.0 XML feed of change events for the subscription.
 */
stretchRouter.get('/subscriptions/:id/rss', (req, res) => {
  const { id } = req.params;
  const db = getDb();

  const sub = db.prepare(`
    SELECT s.id, s.name, t.canonical_url
    FROM subscriptions s
    JOIN targets t ON t.id = s.target_id
    WHERE s.id = ?
  `).get(id) as { id: string; name: string; canonical_url: string } | undefined;

  if (!sub) {
    res.status(404).type('text/plain').send('Subscription not found');
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
      <title>[${ev.event_type}] ${sub.name} - ${ev.summary.replace(/[<>&]/g, '')}</title>
      <link>${link}</link>
      <guid isPermaLink="false">${ev.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${ev.summary}]]></description>
    </item>`;
  }).join('');

  const rssXml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>ChangeWatch: ${sub.name.replace(/[<>&]/g, '')}</title>
    <link>${sub.canonical_url}</link>
    <description>Live change alert feed for ${sub.name.replace(/[<>&]/g, '')}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${itemsXml}
  </channel>
</rss>`;

  res.type('application/rss+xml').send(rssXml);
});
