import type { Database } from 'better-sqlite3';
import { decryptConfig } from './crypto.js';
import {
  dispatchDiscord,
  dispatchTelegram,
  dispatchEmail,
  type NotificationPayload,
  type DispatchResult,
} from './dispatchers.js';

export interface OutboxRow {
  id: string;
  user_id: string;
  kind: 'EVENT' | 'DIGEST';
  change_event_id: string | null;
  channel: 'discord' | 'telegram' | 'email' | 'in_app';
  destination_id: string;
  payload: string;
  status: 'QUEUED' | 'PENDING_CONFIG' | 'SENT_EXTERNAL' | 'RECORDED_IN_APP' | 'RETRYING' | 'FAILED';
  attempts: number;
}

export class NotificationWorker {
  private isRunning = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly db: Database,
    private readonly pollIntervalMs: number = 2000
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextPoll();
  }

  public stop(): void {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.isRunning = false;
  }

  public async waitForIdle(timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (this.isProcessing) {
      if (Date.now() - start > timeoutMs) break;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning) return;
    this.loopTimer = setTimeout(async () => {
      try {
        await this.processOutboxBatch();
      } catch (err) {
        console.error('[NotificationWorker] Poll error:', err);
      } finally {
        this.scheduleNextPoll();
      }
    }, this.pollIntervalMs);
  }

  /**
   * Processes a batch of queued or retrying notification outbox items.
   */
  public async processOutboxBatch(batchSize = 10): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;
    try {
      const nowIso = new Date().toISOString();
      const rows = this.db.prepare(`
        SELECT id, user_id, kind, change_event_id, channel, destination_id, payload, status, attempts
        FROM notification_outbox
        WHERE status IN ('QUEUED', 'RETRYING')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC
        LIMIT ?
      `).all(nowIso, batchSize) as OutboxRow[];

      for (const row of rows) {
        await this.processSingleItem(row);
      }

      return rows.length;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processSingleItem(row: OutboxRow): Promise<void> {
    const newAttempts = row.attempts + 1;
    let payload: NotificationPayload;

    try {
      payload = JSON.parse(row.payload) as NotificationPayload;
    } catch {
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'FAILED', attempts = ?, last_error = 'Corrupt payload JSON'
        WHERE id = ?
      `).run(newAttempts, row.id);
      return;
    }

    // in_app messages are immediately finalized on enqueue
    if (row.channel === 'in_app') {
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'RECORDED_IN_APP', attempts = ?, sent_at = ?
        WHERE id = ?
      `).run(newAttempts, new Date().toISOString(), row.id);
      return;
    }

    // Look up destination config
    const dest = this.db.prepare(`
      SELECT user_id, destination_config, enabled FROM notification_destinations WHERE id = ?
    `).get(row.destination_id) as { user_id: string; destination_config: string; enabled: number } | undefined;

    if (!dest || dest.user_id !== row.user_id) {
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'FAILED', attempts = ?, last_error = 'Destination owner mismatch or destination deleted'
        WHERE id = ?
      `).run(newAttempts, row.id);
      return;
    }

    if (!dest.enabled) {
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'PENDING_CONFIG', attempts = ?, last_error = 'Destination disabled'
        WHERE id = ?
      `).run(newAttempts, row.id);
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = decryptConfig<Record<string, unknown>>(dest.destination_config);
    } catch {
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'FAILED', attempts = ?, last_error = 'Failed to decrypt destination config'
        WHERE id = ?
      `).run(newAttempts, row.id);
      return;
    }

    let result: DispatchResult;
    try {
      if (row.channel === 'discord') {
        result = await dispatchDiscord(config, payload);
      } else if (row.channel === 'telegram') {
        result = await dispatchTelegram(config, payload);
      } else if (row.channel === 'email') {
        result = await dispatchEmail(config, payload);
      } else {
        result = { success: false, status: 'FAILED', error: `Unsupported channel: ${row.channel}` };
      }
    } catch (err) {
      result = {
        success: false,
        status: 'RETRYING',
        error: err instanceof Error ? err.message : 'Unknown dispatch error',
      };
    }

    const now = new Date().toISOString();

    if (result.status === 'SENT_EXTERNAL') {
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'SENT_EXTERNAL', attempts = ?, sent_at = ?, last_error = NULL
        WHERE id = ?
      `).run(newAttempts, now, row.id);
    } else if (result.status === 'PENDING_CONFIG') {
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'PENDING_CONFIG', attempts = ?, last_error = ?
        WHERE id = ?
      `).run(newAttempts, result.error || 'Configuration pending', row.id);
    } else if (result.status === 'RETRYING') {
      if (newAttempts >= 3) {
        this.db.prepare(`
          UPDATE notification_outbox
          SET status = 'FAILED', attempts = ?, last_error = ?
          WHERE id = ?
        `).run(newAttempts, `Max retries exceeded: ${result.error || 'Network error'}`, row.id);
      } else {
        const delayMs = result.retryAfterMs ?? (newAttempts * 10_000);
        const nextAttempt = new Date(Date.now() + delayMs).toISOString();
        this.db.prepare(`
          UPDATE notification_outbox
          SET status = 'RETRYING', attempts = ?, next_attempt_at = ?, last_error = ?
          WHERE id = ?
        `).run(newAttempts, nextAttempt, result.error || 'Temporary dispatch failure', row.id);
      }
    } else {
      // FAILED
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'FAILED', attempts = ?, last_error = ?
        WHERE id = ?
      `).run(newAttempts, result.error || 'Dispatch failed permanently', row.id);
    }
  }
}
