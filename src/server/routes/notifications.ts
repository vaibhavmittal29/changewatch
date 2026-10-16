import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { env } from '../config.js';
import { encryptConfig, decryptConfig, maskDestinationConfig } from '../notifications/crypto.js';
import {
  validateDestinationConfig,
} from '../notifications/configValidation.js';
import {
  dispatchDiscord,
  dispatchTelegram,
  dispatchEmail,
  type NotificationPayload,
  type DispatchResult,
} from '../notifications/dispatchers.js';

export const notificationsRouter = Router();

const DestinationSchema = z.object({
  id: z.string().optional(),
  channel: z.enum(['discord', 'telegram', 'email', 'in_app']),
  config: z.record(z.unknown()),
  enabled: z.boolean().default(true),
});

const TestDestinationSchema = z.object({
  channel: z.enum(['discord', 'telegram', 'email']),
  config: z.record(z.unknown()),
});

interface DestinationDbRow {
  id: string;
  user_id: string;
  channel: 'discord' | 'telegram' | 'email' | 'in_app';
  destination_config: string;
  enabled: number;
  created_at: string;
}

/**
 * GET /api/destinations
 * Lists user's destinations with decrypted & masked sensitive fields.
 */
notificationsRouter.get('/destinations', (req: Request, res: Response) => {
  const userId = req.session!.userId;
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, user_id, channel, destination_config, enabled, created_at
    FROM notification_destinations
    WHERE user_id = ?
    ORDER BY created_at ASC
  `).all(userId) as DestinationDbRow[];

  const destinations = rows.map(row => {
    let rawConfig: Record<string, unknown> = {};
    try {
      rawConfig = decryptConfig<Record<string, unknown>>(row.destination_config);
    } catch {
      rawConfig = {};
    }
    return {
      id: row.id,
      channel: row.channel,
      config: maskDestinationConfig(rawConfig),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
    };
  });

  res.json({ destinations });
});

/**
 * PUT /api/destinations
 * Creates or updates a destination with ownership verification and schema validation.
 */
notificationsRouter.put('/destinations', (req: Request, res: Response) => {
  const parsed = DestinationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid destination payload', details: parsed.error.issues });
    return;
  }

  const userId = req.session!.userId;
  const db = getDb();
  const { channel, config, enabled } = parsed.data;

  try {
    validateDestinationConfig(channel, config);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid destination config' });
    return;
  }

  const encryptedConfig = encryptConfig(config);

  if (parsed.data.id) {
    const existing = db.prepare('SELECT id, user_id FROM notification_destinations WHERE id = ?').get(parsed.data.id) as { id: string; user_id: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Destination not found' });
      return;
    }
    if (existing.user_id !== userId) {
      res.status(403).json({ error: 'Forbidden: you do not own this destination' });
      return;
    }

    db.prepare(`
      UPDATE notification_destinations
      SET channel = ?, destination_config = ?, enabled = ?
      WHERE id = ? AND user_id = ?
    `).run(channel, encryptedConfig, enabled ? 1 : 0, parsed.data.id, userId);

    res.json({
      id: parsed.data.id,
      channel,
      config: maskDestinationConfig(config),
      enabled,
      message: 'Destination updated successfully',
    });
    return;
  }

  const newId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO notification_destinations (id, user_id, channel, destination_config, enabled)
    VALUES (?, ?, ?, ?, ?)
  `).run(newId, userId, channel, encryptedConfig, enabled ? 1 : 0);

  res.json({
    id: newId,
    channel,
    config: maskDestinationConfig(config),
    enabled,
    message: 'Destination created successfully',
  });
});

/**
 * DELETE /api/destinations/:id
 */
notificationsRouter.delete('/destinations/:id', (req: Request, res: Response) => {
  const userId = req.session!.userId;
  const db = getDb();
  const destId = String(req.params.id);

  const result = db.prepare(`
    DELETE FROM notification_destinations WHERE id = ? AND user_id = ?
  `).run(destId, userId);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Destination not found' });
    return;
  }

  res.json({ success: true, message: 'Destination removed' });
});

/**
 * POST /api/destinations/test
 * Sends a test alert directly after validating configuration.
 */
notificationsRouter.post('/destinations/test', async (req: Request, res: Response) => {
  const parsed = TestDestinationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid test payload', details: parsed.error.issues });
    return;
  }

  const { channel, config } = parsed.data;

  try {
    validateDestinationConfig(channel, config);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid destination config' });
    return;
  }

  const payload: NotificationPayload = {
    monitorName: 'ChangeWatch Test Notification',
    eventType: 'TEST',
    summary: 'Test notification confirming your destination is working correctly.',
    compareUrl: `${env.BASE_URL}/`,
    timestamp: new Date().toISOString(),
  };

  let result: DispatchResult;
  if (channel === 'discord') {
    result = await dispatchDiscord(config, payload);
  } else if (channel === 'telegram') {
    result = await dispatchTelegram(config, payload);
  } else if (channel === 'email') {
    result = await dispatchEmail(config, payload);
  } else {
    res.status(400).json({ error: 'Unsupported channel' });
    return;
  }

  if (result.success || result.status === 'SENT_EXTERNAL') {
    res.json({ success: true, status: result.status, message: 'Test alert delivered' });
  } else {
    res.status(result.status === 'PENDING_CONFIG' ? 400 : 502).json({
      success: false,
      status: result.status,
      error: result.error || 'Failed to deliver test alert',
    });
  }
});

/**
 * GET /api/notifications
 * Returns recent in-app outbox records for the user.
 */
notificationsRouter.get('/notifications', (req: Request, res: Response) => {
  const userId = req.session!.userId;
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, kind, change_event_id, channel, destination_id,
           payload, status, attempts, last_error, sent_at, created_at
    FROM notification_outbox
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(userId) as Array<Record<string, unknown>>;

  const notifications = rows.map(r => {
    let parsedPayload: unknown = null;
    try {
      parsedPayload = JSON.parse(String(r.payload));
    } catch {
      parsedPayload = r.payload;
    }
    return { ...r, payload: parsedPayload };
  });

  res.json({ notifications });
});
