import nodemailer from 'nodemailer';
import { env } from '../config.js';

export interface NotificationPayload {
  monitorName: string;
  monitorId?: string;
  eventType: 'CHANGE' | 'DOWN' | 'RECOVERED' | 'TEST';
  summary: string;
  compareUrl?: string;
  previousVersionId?: string;
  currentVersionId?: string;
  timestamp: string;
}

export interface DispatchResult {
  success: boolean;
  status: 'SENT_EXTERNAL' | 'RECORDED_IN_APP' | 'RETRYING' | 'FAILED' | 'PENDING_CONFIG';
  retryAfterMs?: number;
  error?: string;
}

export interface DiscordConfig {
  webhookUrl?: string;
}

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

export interface EmailConfig {
  toEmail?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  fromEmail?: string;
}

/**
 * Dispatches a notification payload to Discord webhook.
 */
export async function dispatchDiscord(config: DiscordConfig, payload: NotificationPayload): Promise<DispatchResult> {
  if (!config.webhookUrl) {
    return { success: false, status: 'PENDING_CONFIG', error: 'Discord webhook URL not configured' };
  }

  const colors = {
    CHANGE: 0x6366f1,    // Indigo
    DOWN: 0xef4444,      // Red
    RECOVERED: 0x10b981, // Emerald
    TEST: 0x3b82f6,      // Blue
  };

  const embed = {
    title: `[${payload.eventType}] ${payload.monitorName}`,
    description: payload.summary,
    url: payload.compareUrl,
    color: colors[payload.eventType] || 0x6366f1,
    timestamp: payload.timestamp,
    fields: payload.compareUrl ? [{ name: 'Diff Link', value: `[View Changes](${payload.compareUrl})`, inline: true }] : [],
    footer: { text: 'ChangeWatch Website Monitor' },
  };

  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({})) as { retry_after?: number };
      const retryAfterSec = data.retry_after ?? Number(res.headers.get('retry-after')) ?? 5;
      return {
        success: false,
        status: 'RETRYING',
        retryAfterMs: Math.round(retryAfterSec * 1000),
        error: `Discord rate-limited: retry after ${retryAfterSec}s`,
      };
    }

    if (res.ok) {
      return { success: true, status: 'SENT_EXTERNAL' };
    }

    const errBody = await res.text().catch(() => '');
    const isClientError = res.status >= 400 && res.status < 500;
    return {
      success: false,
      status: isClientError ? 'FAILED' : 'RETRYING',
      error: `Discord HTTP ${res.status}: ${errBody.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      success: false,
      status: 'RETRYING',
      error: err instanceof Error ? err.message : 'Network error reaching Discord',
    };
  }
}

/**
 * Dispatches a notification payload to Telegram Bot API.
 */
export async function dispatchTelegram(config: TelegramConfig, payload: NotificationPayload): Promise<DispatchResult> {
  if (!config.botToken || !config.chatId) {
    return { success: false, status: 'PENDING_CONFIG', error: 'Telegram botToken or chatId not configured' };
  }

  const text = `<b>[${payload.eventType}] ${payload.monitorName}</b>\n\n${payload.summary}${
    payload.compareUrl ? `\n\n<a href="${payload.compareUrl}">View Comparison</a>` : ''
  }`;

  const apiUrl = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
      }),
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({})) as { parameters?: { retry_after?: number } };
      const retryAfterSec = data.parameters?.retry_after ?? 5;
      return {
        success: false,
        status: 'RETRYING',
        retryAfterMs: retryAfterSec * 1000,
        error: `Telegram rate-limited: retry after ${retryAfterSec}s`,
      };
    }

    if (res.ok) {
      return { success: true, status: 'SENT_EXTERNAL' };
    }

    const errBody = await res.text().catch(() => '');
    const isClientError = res.status >= 400 && res.status < 500;
    return {
      success: false,
      status: isClientError ? 'FAILED' : 'RETRYING',
      error: `Telegram HTTP ${res.status}: ${errBody.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      success: false,
      status: 'RETRYING',
      error: err instanceof Error ? err.message : 'Network error reaching Telegram',
    };
  }
}

/**
 * Dispatches an email notification via Nodemailer.
 */
export async function dispatchEmail(config: EmailConfig, payload: NotificationPayload): Promise<DispatchResult> {
  const host = config.smtpHost || env.SMTP_HOST;
  const port = config.smtpPort || (env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined);
  const user = config.smtpUser || env.SMTP_USER;
  const pass = config.smtpPass || env.SMTP_PASS;
  const from = config.fromEmail || env.SMTP_FROM || 'changewatch@local';
  const to = config.toEmail;

  if (!host || !to) {
    return { success: false, status: 'PENDING_CONFIG', error: 'SMTP host or recipient email not configured' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port: port || 587,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  const subject = `[${payload.eventType}] ${payload.monitorName} - ChangeWatch`;
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #4f46e5; margin-top: 0;">ChangeWatch Alert</h2>
      <p><strong>Monitor:</strong> ${payload.monitorName}</p>
      <p><strong>Event:</strong> ${payload.eventType}</p>
      <p><strong>Summary:</strong> ${payload.summary}</p>
      ${payload.compareUrl ? `<p><a href="${payload.compareUrl}" style="background-color: #4f46e5; color: white; padding: 10px 16px; text-decoration: none; border-radius: 6px; display: inline-block;">View Comparison</a></p>` : ''}
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <small style="color: #64748b;">ChangeWatch Automated Monitoring &bull; ${payload.timestamp}</small>
    </div>
  `;

  try {
    await transporter.sendMail({ from, to, subject, html });
    return { success: true, status: 'SENT_EXTERNAL' };
  } catch (err) {
    return {
      success: false,
      status: 'RETRYING',
      error: err instanceof Error ? err.message : 'Failed to send email via SMTP',
    };
  }
}
