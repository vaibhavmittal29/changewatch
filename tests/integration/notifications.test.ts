import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { getDb, closeDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { encryptConfig } from '../../src/server/notifications/crypto.js';
import { enqueueNotificationForEvent } from '../../src/server/notifications/outbox.js';
import { NotificationWorker } from '../../src/server/notifications/worker.js';
import { processDailyDigest } from '../../src/server/notifications/digest.js';
import * as configValidationModule from '../../src/server/notifications/configValidation.js';

describe('Phase 7 Integration: Notifications, Outbox Truthfulness, Idempotency & Digest (Criteria V, W, DG, EM)', () => {
  const testDbPath = path.resolve(process.cwd(), './data/test_notifications.db');
  let db: ReturnType<typeof getDb>;
  let userId: string;
  let subId: string;
  let targetId: string;
  let versionId: string;
  let discordDestId: string;
  let telegramDestId: string;

  beforeAll(() => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    process.env.DATABASE_PATH = testDbPath;
    process.env.APP_SECRET = 'super-secret-test-key-32chars-long!';

    db = getDb(testDbPath);
    migrate(db);

    userId = crypto.randomUUID();
    targetId = crypto.randomUUID();
    subId = crypto.randomUUID();
    discordDestId = crypto.randomUUID();
    telegramDestId = crypto.randomUUID();
    versionId = crypto.randomUUID();
    const obsId = crypto.randomUUID();

    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name, digest_enabled, created_at)
      VALUES (?, 'notify_user@example.com', 'hash', 'salt', 1000, 'Notify Tester', 1, ?)
    `).run(userId, nowIso);

    db.prepare(`
      INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
      VALUES (?, 'https://example.com/status', 'example.com', 'https://example.com', ?)
    `).run(targetId, nowIso);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, capture_config, capture_fingerprint,
        next_check_at, created_at
      ) VALUES (?, ?, ?, 'Prod Monitor', 60, '{}', 'fp-notif', ?, ?)
    `).run(subId, userId, targetId, nowIso, nowIso);

    db.prepare(`
      INSERT INTO observations (id, target_id, capture_fingerprint, engine_used, final_url, http_status, sanitized_dom, raw_text, captured_at)
      VALUES (?, ?, 'fp-notif', 'playwright', 'https://example.com/status', 200, '<p>test</p>', 'test', ?)
    `).run(obsId, targetId, nowIso);

    db.prepare(`
      INSERT INTO monitor_versions (id, subscription_id, observation_id, version_number, content_hash, stored_text, created_at)
      VALUES (?, ?, ?, 1, 'hash-v1', 'test', ?)
    `).run(versionId, subId, obsId, nowIso);

    // Seed encrypted destinations
    db.prepare(`
      INSERT INTO notification_destinations (id, user_id, channel, destination_config, enabled)
      VALUES (?, ?, 'discord', ?, 1)
    `).run(discordDestId, userId, encryptConfig({ webhookUrl: 'https://discord.com/api/webhooks/1234567890/mocktoken' }));

    db.prepare(`
      INSERT INTO notification_destinations (id, user_id, channel, destination_config, enabled)
      VALUES (?, ?, 'telegram', ?, 1)
    `).run(telegramDestId, userId, encryptConfig({ botToken: '123:mock', chatId: '456' }));
  });

  afterAll(() => {
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    vi.restoreAllMocks();
  });

  it('W: Enqueues outbox records with composite idempotency key and suppresses duplicates', () => {
    const eventId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO change_events (id, subscription_id, current_version_id, event_type, suppressed, summary, created_at)
      VALUES (?, ?, ?, 'CHANGE', 0, 'Pricing updated', ?)
    `).run(eventId, subId, versionId, nowIso);

    // Initial enqueue: creates in_app, discord, telegram records
    const inserted1 = enqueueNotificationForEvent(db, eventId);
    expect(inserted1).toBe(3);

    // Duplicate call: idempotency keys prevent duplicates
    const inserted2 = enqueueNotificationForEvent(db, eventId);
    expect(inserted2).toBe(0);

    const rows = db.prepare('SELECT * FROM notification_outbox WHERE change_event_id = ?').all(eventId);
    expect(rows).toHaveLength(3);
  });

  it('V & W: Outbox worker enforces truthful statuses and delivers channels independently on partial failure', async () => {
    const eventId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO change_events (id, subscription_id, event_type, summary, created_at)
      VALUES (?, ?, 'DOWN', 'Site offline', ?)
    `).run(eventId, subId, nowIso);

    enqueueNotificationForEvent(db, eventId);

    // Mock global fetch: Discord returns 500 error, Telegram returns 200 OK
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('discord.com')) {
        return new Response(JSON.stringify({ message: 'Internal Server Error' }), { status: 500 });
      }
      if (urlStr.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const worker = new NotificationWorker(db);
    await worker.processOutboxBatch(10);

    const outbox = db.prepare('SELECT channel, status, attempts, last_error FROM notification_outbox WHERE change_event_id = ?').all(eventId) as Array<{ channel: string; status: string; attempts: number; last_error: string | null }>;

    const inApp = outbox.find(r => r.channel === 'in_app');
    const telegram = outbox.find(r => r.channel === 'telegram');
    const discord = outbox.find(r => r.channel === 'discord');

    expect(inApp?.status).toBe('RECORDED_IN_APP');
    expect(telegram?.status).toBe('SENT_EXTERNAL');
    expect(discord?.status).toBe('RETRYING'); // First attempt failed with 500 -> RETRYING
    expect(discord?.attempts).toBe(1);

    // Second attempt: make ready and execute
    db.prepare('UPDATE notification_outbox SET next_attempt_at = ? WHERE change_event_id = ? AND channel = \'discord\'')
      .run(nowIso, eventId);
    await worker.processOutboxBatch(10);
    const discord2 = db.prepare('SELECT status, attempts FROM notification_outbox WHERE change_event_id = ? AND channel = \'discord\'').get(eventId) as { status: string; attempts: number };
    expect(discord2.attempts).toBe(2);
    expect(discord2.status).toBe('RETRYING');

    // Third attempt: make ready and execute -> exhausts max retries -> FAILED
    db.prepare('UPDATE notification_outbox SET next_attempt_at = ? WHERE change_event_id = ? AND channel = \'discord\'')
      .run(nowIso, eventId);
    await worker.processOutboxBatch(10);
    const discord3 = db.prepare('SELECT status, attempts FROM notification_outbox WHERE change_event_id = ? AND channel = \'discord\'').get(eventId) as { status: string; attempts: number };
    expect(discord3.status).toBe('FAILED');
    expect(discord3.attempts).toBe(3);
  });

  it('EM: Email falls back to PENDING_CONFIG without SMTP and transitions to SENT_EXTERNAL when configured', async () => {
    // 1. Destination without SMTP host -> PENDING_CONFIG
    const emailDestId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO notification_destinations (id, user_id, channel, destination_config, enabled)
      VALUES (?, ?, 'email', ?, 1)
    `).run(emailDestId, userId, encryptConfig({ toEmail: 'user@example.com' }));

    const eventId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO change_events (id, subscription_id, event_type, summary, created_at)
      VALUES (?, ?, 'RECOVERED', 'Site recovered', ?)
    `).run(eventId, subId, nowIso);

    enqueueNotificationForEvent(db, eventId);

    const worker = new NotificationWorker(db);
    await worker.processOutboxBatch(10);

    const emailRow = db.prepare('SELECT status FROM notification_outbox WHERE change_event_id = ? AND channel = \'email\'').get(eventId) as { status: string };
    expect(emailRow.status).toBe('PENDING_CONFIG');

    // 2. Mock nodemailer transporter to test successful delivery
    const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'mock-mail-id' });
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: sendMailMock,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    vi.spyOn(configValidationModule, 'validateSmtpHostDns').mockResolvedValue(true);

    // Update email config with host
    db.prepare('UPDATE notification_destinations SET destination_config = ? WHERE id = ?')
      .run(encryptConfig({ toEmail: 'user@example.com', smtpHost: 'smtp.mailgun.org' }), emailDestId);

    // Reset status to QUEUED for delivery test
    db.prepare('UPDATE notification_outbox SET status = \'QUEUED\', attempts = 0 WHERE change_event_id = ? AND channel = \'email\'')
      .run(eventId);

    await worker.processOutboxBatch(10);

    const emailDelivered = db.prepare('SELECT status FROM notification_outbox WHERE change_event_id = ? AND channel = \'email\'').get(eventId) as { status: string };
    expect(emailDelivered.status).toBe('SENT_EXTERNAL');
    expect(sendMailMock).toHaveBeenCalled();
  });

  it('DG: Bundles suppressed events into a single daily digest per user per channel with deterministic idempotency', () => {
    const nowIso = new Date().toISOString();

    // Insert 3 suppressed change events (e.g. from cooldown suppression)
    for (let i = 1; i <= 3; i++) {
      db.prepare(`
        INSERT INTO change_events (id, subscription_id, current_version_id, event_type, suppressed, summary, created_at)
        VALUES (?, ?, ?, 'CHANGE', 1, ?, ?)
      `).run(crypto.randomUUID(), subId, versionId, `Minor update #${i}`, nowIso);
    }

    const todayStr = '2026-10-15';
    const count1 = processDailyDigest(db, todayStr);
    expect(count1).toBeGreaterThanOrEqual(1);

    // Verify digest payload was bundled
    const digests = db.prepare('SELECT * FROM notification_outbox WHERE kind = \'DIGEST\'').all() as Array<{ payload: string; idempotency_key: string; status: string }>;
    expect(digests.length).toBeGreaterThan(0);

    const sample = JSON.parse(digests[0].payload) as { summary: string };
    expect(sample.summary).toContain('suppressed change');

    // Second call on the same day is idempotent (returns 0 new records)
    const count2 = processDailyDigest(db, todayStr);
    expect(count2).toBe(0);
  });
});
