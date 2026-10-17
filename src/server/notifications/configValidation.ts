import { z } from 'zod';
import dns from 'node:dns/promises';
import { env } from '../config.js';
import { isPublicIp } from '../capture/validateUrl.js';

export const DiscordConfigSchema = z.object({
  webhookUrl: z.string().url().refine(val => {
    try {
      const u = new URL(val);
      if (u.protocol !== 'https:') return false;
      const validHost = u.hostname === 'discord.com' || u.hostname === 'discordapp.com';
      if (!validHost) return false;
      if (u.port && u.port !== '443') return false;
      if (u.username || u.password) return false;
      return /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(u.pathname);
    } catch {
      return false;
    }
  }, 'Invalid Discord webhook URL format. Must be https://discord.com/api/webhooks/<id>/<token> with no credentials or custom port.'),
}).strict();

export const TelegramConfigSchema = z.object({
  botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/, 'Invalid Telegram bot token format'),
  chatId: z.string().regex(/^-?\d+$/, 'Invalid Telegram chat ID format'),
}).strict();

export function isSafeSmtpHostString(host?: string): boolean {
  if (!host) return true;
  if (env.SMTP_HOST && host === env.SMTP_HOST) return true;
  if (env.SMTP_HOST && host !== env.SMTP_HOST) return false;

  const lower = host.toLowerCase().trim();
  // Reject alternate IP formats (integer, hex, octal)
  if (/^\d+$/.test(lower) || /^0x[0-9a-f]+$/i.test(lower)) return false;
  if (/\b0[0-7]+\b/.test(lower)) return false;
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.lan') || lower.endsWith('.arpa')) {
    return false;
  }

  // Reject literal loopback, private, link-local, ULA, or metadata IPs
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(lower) || lower.includes(':')) {
    return isPublicIp(lower);
  }

  return true;
}

export const EmailConfigSchema = z.object({
  toEmail: z.string().email('Invalid recipient email address'),
  smtpHost: z.string().optional().refine(host => isSafeSmtpHostString(host), 'Custom SMTP host not permitted or untrusted'),
  smtpPort: z.coerce.number().int().refine(p => [25, 465, 587, 2525].includes(p), 'Only standard SMTP ports (25, 465, 587, 2525) permitted').optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  fromEmail: z.string().email().optional(),
}).strict();

export type SmtpDnsLookupFn = (hostname: string, options: { all: boolean }) => Promise<Array<{ address: string; family: number }>>;
let customSmtpDnsLookup: SmtpDnsLookupFn | null = null;

export function setCustomSmtpDnsLookup(fn: SmtpDnsLookupFn | null): void {
  customSmtpDnsLookup = fn;
}

export async function resolveSmtpHostIp(host?: string): Promise<string | undefined> {
  if (!host) return undefined;
  if (env.SMTP_HOST && host === env.SMTP_HOST) return host;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) {
    return isPublicIp(host) ? host : undefined;
  }
  try {
    const lookupFn = customSmtpDnsLookup || dns.lookup;
    const records = await lookupFn(host, { all: true });
    if (records && records.length > 0) {
      const publicRecord = records.find(r => isPublicIp(r.address));
      return publicRecord?.address;
    }
  } catch {}
  return undefined;
}

export async function validateSmtpHostDns(host?: string): Promise<boolean> {
  if (!host) return true;
  if (!isSafeSmtpHostString(host)) return false;
  if (env.SMTP_HOST && host === env.SMTP_HOST) return true;

  try {
    const lookupFn = customSmtpDnsLookup || dns.lookup;
    const records = await lookupFn(host, { all: true });
    if (!records || records.length === 0) return false;
    for (const r of records) {
      if (!isPublicIp(r.address)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export type ValidatedDiscordConfig = z.infer<typeof DiscordConfigSchema>;
export type ValidatedTelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type ValidatedEmailConfig = z.infer<typeof EmailConfigSchema>;

export function validateDestinationConfig(channel: string, config: unknown) {
  if (channel === 'discord') return DiscordConfigSchema.parse(config);
  if (channel === 'telegram') return TelegramConfigSchema.parse(config);
  if (channel === 'email') return EmailConfigSchema.parse(config);
  if (channel === 'in_app') return config;
  throw new Error(`Unsupported channel: ${channel}`);
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeDiscordMarkdown(text: string): string {
  return text
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere')
    .replace(/<@&/g, '<\u200b@&')
    .replace(/<@!/g, '<\u200b@!')
    .replace(/<@/g, '<\u200b@')
    .replace(/\]\(/g, ']\u200b(');
}

export function sanitizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {}
  return undefined;
}

export async function readLimitedBody(res: globalThis.Response, maxBytes = 4096): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      totalBytes += value.length;
      if (totalBytes >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } catch {}

  const combined = Buffer.concat(chunks, Math.min(totalBytes, maxBytes));
  return combined.toString('utf8');
}
