import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { type NotificationPayload } from './dispatchers.js';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  digest_enabled: number;
}

interface SuppressedEventRow {
  id: string;
  subscription_id: string;
  previous_version_id: string | null;
  current_version_id: string | null;
  summary: string;
  created_at: string;
  subscription_name: string;
}

interface DestinationRow {
  id: string;
  user_id: string;
  channel: 'discord' | 'telegram' | 'email' | 'in_app';
  enabled: number;
}

/**
 * Bundles suppressed change events from the last 24 hours into a daily digest
 * per user per channel using deterministic digest idempotency keys (Section 9.9).
 */
export function processDailyDigest(
  db: Database,
  targetDate?: string
): number {
  const now = new Date();
  const dateStr = targetDate || now.toISOString().slice(0, 10); // YYYY-MM-DD
  const cutoffIso = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();

  const users = db.prepare(`
    SELECT id, email, display_name, digest_enabled
    FROM users
    WHERE digest_enabled = 1
  `).all() as UserRow[];

  let totalDigestsCreated = 0;

  for (const user of users) {
    const suppressedEvents = db.prepare(`
      SELECT e.id, e.subscription_id, e.previous_version_id, e.current_version_id,
             e.summary, e.created_at, s.name as subscription_name
      FROM change_events e
      JOIN subscriptions s ON e.subscription_id = s.id
      WHERE s.user_id = ? AND e.suppressed = 1 AND e.created_at >= ?
      ORDER BY e.created_at ASC
    `).all(user.id, cutoffIso) as SuppressedEventRow[];

    if (suppressedEvents.length === 0) {
      continue;
    }

    const eventSummaries = suppressedEvents
      .map(e => `• ${e.subscription_name}: ${e.summary}`)
      .join('\n');

    const digestPayload: NotificationPayload = {
      monitorName: 'ChangeWatch Daily Digest',
      eventType: 'CHANGE',
      summary: `${suppressedEvents.length} suppressed change(s) in the last 24h:\n${eventSummaries}`,
      timestamp: nowIso,
    };
    const payloadStr = JSON.stringify(digestPayload);

    // 1. In-App Digest
    const inAppKey = `digest_${user.id}_${dateStr}_in_app_default`;
    const inAppRes = db.prepare(`
      INSERT OR IGNORE INTO notification_outbox (
        id, user_id, kind, change_event_id, channel, destination_id,
        idempotency_key, payload, status, attempts, next_attempt_at, sent_at, created_at
      ) VALUES (?, ?, 'DIGEST', NULL, 'in_app', 'default', ?, ?, 'RECORDED_IN_APP', 1, NULL, ?, ?)
    `).run(crypto.randomUUID(), user.id, inAppKey, payloadStr, nowIso, nowIso);

    if (inAppRes.changes > 0) totalDigestsCreated++;

    // 2. External Destinations
    const destinations = db.prepare(`
      SELECT id, user_id, channel, enabled
      FROM notification_destinations
      WHERE user_id = ? AND enabled = 1
    `).all(user.id) as DestinationRow[];

    for (const dest of destinations) {
      if (dest.channel === 'in_app') continue;

      const idempotencyKey = `digest_${user.id}_${dateStr}_${dest.channel}_${dest.id}`;
      const destRes = db.prepare(`
        INSERT OR IGNORE INTO notification_outbox (
          id, user_id, kind, change_event_id, channel, destination_id,
          idempotency_key, payload, status, attempts, next_attempt_at, created_at
        ) VALUES (?, ?, 'DIGEST', NULL, ?, ?, ?, ?, 'QUEUED', 0, ?, ?)
      `).run(
        crypto.randomUUID(), user.id, dest.channel, dest.id,
        idempotencyKey, payloadStr, nowIso, nowIso
      );

      if (destRes.changes > 0) totalDigestsCreated++;
    }
  }

  return totalDigestsCreated;
}
