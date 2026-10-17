import nodemailer from 'nodemailer';
import { env } from '../config.js';
import {
  DiscordConfigSchema,
  TelegramConfigSchema,
  EmailConfigSchema,
  escapeHtml,
  escapeDiscordMarkdown,
  sanitizeUrl,
  readLimitedBody,
  validateSmtpHostDns,
  resolveSmtpHostIp,
} from './configValidation.js';

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

export async function dispatchDiscord(config: DiscordConfig, payload: NotificationPayload): Promise<DispatchResult> {
  const parsed = DiscordConfigSchema.safeParse(config);
  if (!parsed.success) {
    return { success: false, status: 'PENDING_CONFIG', error: parsed.error.issues[0]?.message || 'Invalid Discord config' };
  }

  const validUrl = sanitizeUrl(payload.compareUrl);
  const colors = { CHANGE: 0x6366f1, DOWN: 0xef4444, RECOVERED: 0x10b981, TEST: 0x3b82f6 };

  const safeTitle = escapeDiscordMarkdown(`[${payload.eventType}] ${payload.monitorName}`);
  const safeDesc = escapeDiscordMarkdown(payload.summary);

  const embed = {
    title: safeTitle,
    description: safeDesc,
    url: validUrl,
    color: colors[payload.eventType] || 0x6366f1,
    timestamp: payload.timestamp,
    fields: validUrl ? [{ name: 'Diff Link', value: `[View Changes](${validUrl})`, inline: true }] : [],
    footer: { text: 'ChangeWatch Website Monitor' },
  };

  try {
    const res = await fetch(parsed.data.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 429) {
      const body = await readLimitedBody(res, 2048);
      let retryAfterSec = 5;
      try {
        const data = JSON.parse(body) as { retry_after?: number };
        retryAfterSec = data.retry_after ?? Number(res.headers.get('retry-after')) ?? 5;
      } catch { /* use default */ }
      return { success: false, status: 'RETRYING', retryAfterMs: Math.round(retryAfterSec * 1000), error: `Discord 429: retry after ${retryAfterSec}s` };
    }

    if (res.ok) {
      return { success: true, status: 'SENT_EXTERNAL' };
    }

    const errBody = await readLimitedBody(res, 1024);
    const isClientError = res.status >= 400 && res.status < 500;
    return {
      success: false,
      status: isClientError ? 'FAILED' : 'RETRYING',
      error: `Discord HTTP ${res.status}: ${errBody.slice(0, 200)}`,
    };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      success: false,
      status: 'RETRYING',
      error: isTimeout ? 'Discord dispatch timed out after 10s' : (err instanceof Error ? err.message : 'Network error reaching Discord'),
    };
  }
}

export async function dispatchTelegram(config: TelegramConfig, payload: NotificationPayload): Promise<DispatchResult> {
  const parsed = TelegramConfigSchema.safeParse(config);
  if (!parsed.success) {
    return { success: false, status: 'PENDING_CONFIG', error: parsed.error.issues[0]?.message || 'Invalid Telegram config' };
  }

  const safeName = escapeHtml(payload.monitorName);
  const safeSummary = escapeHtml(payload.summary);
  const validUrl = sanitizeUrl(payload.compareUrl);
  const safeUrlAttr = validUrl ? validUrl.replace(/"/g, '&quot;') : '';

  const text = `<b>[${payload.eventType}] ${safeName}</b>\n\n${safeSummary}${
    validUrl ? `\n\n<a href="${safeUrlAttr}">View Comparison</a>` : ''
  }`;

  const apiUrl = `https://api.telegram.org/bot${parsed.data.botToken}/sendMessage`;

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: parsed.data.chatId, text, parse_mode: 'HTML' }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 429) {
      const body = await readLimitedBody(res, 2048);
      let retryAfterSec = 5;
      try {
        const data = JSON.parse(body) as { parameters?: { retry_after?: number } };
        retryAfterSec = data.parameters?.retry_after ?? 5;
      } catch { /* use default */ }
      return { success: false, status: 'RETRYING', retryAfterMs: retryAfterSec * 1000, error: `Telegram 429: retry after ${retryAfterSec}s` };
    }

    if (res.ok) {
      return { success: true, status: 'SENT_EXTERNAL' };
    }

    const errBody = await readLimitedBody(res, 1024);
    const isClientError = res.status >= 400 && res.status < 500;
    return {
      success: false,
      status: isClientError ? 'FAILED' : 'RETRYING',
      error: `Telegram HTTP ${res.status}: ${errBody.slice(0, 200)}`,
    };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      success: false,
      status: 'RETRYING',
      error: isTimeout ? 'Telegram dispatch timed out after 10s' : (err instanceof Error ? err.message : 'Network error reaching Telegram'),
    };
  }
}

export async function dispatchEmail(config: EmailConfig, payload: NotificationPayload): Promise<DispatchResult> {
  const parsed = EmailConfigSchema.safeParse(config);
  if (!parsed.success) {
    return { success: false, status: 'PENDING_CONFIG', error: parsed.error.issues[0]?.message || 'Invalid Email config' };
  }

  const host = env.SMTP_HOST || parsed.data.smtpHost;
  const port = parsed.data.smtpPort || (env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined);
  const user = parsed.data.smtpUser || env.SMTP_USER;
  const pass = parsed.data.smtpPass || env.SMTP_PASS;
  const from = parsed.data.fromEmail || env.SMTP_FROM || 'changewatch@local';
  const to = parsed.data.toEmail;

  if (!host || !to) {
    return { success: false, status: 'PENDING_CONFIG', error: 'SMTP host or recipient email not configured' };
  }

  const isDnsSafe = await validateSmtpHostDns(host);
  if (!isDnsSafe) {
    return { success: false, status: 'FAILED', error: `Untrusted or non-public SMTP host rejected: ${host}` };
  }

  const pinnedIp = await resolveSmtpHostIp(host);
  const targetHost = pinnedIp || host;

  const transporter = nodemailer.createTransport({
    host: targetHost,
    port: port || 587,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
    tls: {
      servername: host,
    },
    connectionTimeout: 10000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });

  const safeName = escapeHtml(payload.monitorName);
  const safeType = escapeHtml(payload.eventType);
  const safeSummary = escapeHtml(payload.summary);
  const validUrl = sanitizeUrl(payload.compareUrl);
  const safeUrlAttr = validUrl ? validUrl.replace(/"/g, '&quot;') : '';

  const subject = `[${payload.eventType}] ${payload.monitorName} - ChangeWatch`;
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #4f46e5; margin-top: 0;">ChangeWatch Alert</h2>
      <p><strong>Monitor:</strong> ${safeName}</p>
      <p><strong>Event:</strong> ${safeType}</p>
      <p><strong>Summary:</strong> ${safeSummary}</p>
      ${validUrl ? `<p><a href="${safeUrlAttr}" style="background-color: #4f46e5; color: white; padding: 10px 16px; text-decoration: none; border-radius: 6px; display: inline-block;">View Comparison</a></p>` : ''}
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <small style="color: #64748b;">ChangeWatch Automated Monitoring &bull; ${escapeHtml(payload.timestamp)}</small>
    </div>
  `;

  try {
    await transporter.sendMail({ from, to, subject, html });
    return { success: true, status: 'SENT_EXTERNAL' };
  } catch (err: unknown) {
    return {
      success: false,
      status: 'RETRYING',
      error: err instanceof Error ? err.message : 'Failed to send email via SMTP',
    };
  }
}
