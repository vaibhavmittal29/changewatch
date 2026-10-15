import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { env } from '../config.js';
import { type NotificationPayload } from './dispatchers.js';

interface ChangeEventWithContext {
  id: string;
  subscription_id: string;
  previous_version_id: string | null;
  current_version_id: string | null;
  event_type: 'CHANGE' | 'DOWN' | 'RECOVERED';
  suppressed: number;
  summary: string;
  created_at: string;
  subscription_name: string;
  user_id: string;
}

interface DestinationRow {
  id: string;
  user_id: string;
  channel: 'discord' | 'telegram' | 'email' | 'in_app';
  enabled: number;
}

/**
 * Enqueues truthful notification outbox records for a change event with composite idempotency keys.
 */
export function enqueueNotificationForEvent(
  db: Database,
  eventId: string
): number {
  const event = db.prepare(`
    SELECT e.*, s.name as subscription_name, s.user_id
    FROM change_events e
    JOIN subscriptions s ON e.subscription_id = s.id
    WHERE e.id = ?
  `).get(eventId) as ChangeEventWithContext | undefined;

  if (!event) return 0;

  const nowIso = new Date().toISOString();
  let compareUrl: string | undefined;
  if (event.current_version_id) {
    const fromParam = event.previous_version_id ? `from=${event.previous_version_id}&` : '';
    compareUrl = `${env.BASE_URL}/compare/${event.subscription_id}?${fromParam}to=${event.current_version_id}`;
  }

  const payloadObj: NotificationPayload = {
    monitorName: event.subscription_name,
    monitorId: event.subscription_id,
    eventType: event.event_type,
    summary: event.summary,
    compareUrl,
    previousVersionId: event.previous_version_id ?? undefined,
    currentVersionId: event.current_version_id ?? undefined,
    timestamp: event.created_at,
  };
  const payloadStr = JSON.stringify(payloadObj);

  let insertedCount = 0;

  // 1. Always enqueue in-app outbox (Section 9.9)
  const inAppKey = `${event.id}_in_app_default`;
  const inAppInsert = db.prepare(`
    INSERT OR IGNORE INTO notification_outbox (
      id, user_id, kind, change_event_id, channel, destination_id,
      idempotency_key, payload, status, attempts, next_attempt_at, sent_at, created_at
    ) VALUES (?, ?, 'EVENT', ?, 'in_app', 'default', ?, ?, 'RECORDED_IN_APP', 1, NULL, ?, ?)
  `).run(crypto.randomUUID(), event.user_id, event.id, inAppKey, payloadStr, nowIso, nowIso);

  if (inAppInsert.changes > 0) insertedCount++;

  // 2. Query configured destinations for the user (only if not suppressed by cooldown)
  if (event.suppressed !== 1) {
    const destinations = db.prepare(`
      SELECT id, user_id, channel, enabled
      FROM notification_destinations
      WHERE user_id = ? AND enabled = 1
    `).all(event.user_id) as DestinationRow[];

    for (const dest of destinations) {
      if (dest.channel === 'in_app') continue; // Handled above

      const idempotencyKey = `${event.id}_${dest.channel}_${dest.id}`;
      const insertRes = db.prepare(`
        INSERT OR IGNORE INTO notification_outbox (
          id, user_id, kind, change_event_id, channel, destination_id,
          idempotency_key, payload, status, attempts, next_attempt_at, created_at
        ) VALUES (?, ?, 'EVENT', ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?)
      `).run(
        crypto.randomUUID(), event.user_id, event.id, dest.channel, dest.id,
        idempotencyKey, payloadStr, nowIso, nowIso
      );

      if (insertRes.changes > 0) insertedCount++;
    }
  }

  return insertedCount;
}
