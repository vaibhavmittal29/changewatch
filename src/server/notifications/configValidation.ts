import { z } from 'zod';
import { env } from '../config.js';

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

export const EmailConfigSchema = z.object({
  toEmail: z.string().email('Invalid recipient email address'),
  smtpHost: z.string().optional().refine(host => {
    if (!host) return true;
    if (env.SMTP_HOST && host !== env.SMTP_HOST) return false;
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.startsWith('127.') || lower === '::1' || lower === '169.254.169.254') return false;
    return true;
  }, 'Custom SMTP host not permitted or untrusted'),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  fromEmail: z.string().email().optional(),
}).strict();

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

export function sanitizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // invalid URL
  }
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
  } catch {
    // stream cancelled or read error
  }

  const combined = Buffer.concat(chunks, Math.min(totalBytes, maxBytes));
  return combined.toString('utf8');
}
