import crypto from 'node:crypto';
import { env } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Derives a deterministic 32-byte key from APP_SECRET using SHA-256.
 */
function getEncryptionKey(): Buffer {
  return crypto.createHash('sha256').update(env.APP_SECRET).digest();
}

/**
 * Encrypts a plaintext string or object into an AES-256-GCM hex string (iv:ciphertext:tag).
 */
export function encryptConfig(data: unknown): string {
  const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM hex string back to its original parsed object or string.
 */
export function decryptConfig<T = unknown>(encryptedPayload: string): T {
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format. Expected iv:ciphertext:tag');
  }

  const [ivHex, cipherHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

  try {
    return JSON.parse(decrypted) as T;
  } catch {
    return decrypted as unknown as T;
  }
}

/**
 * Masks a sensitive string, exposing only the last 4 characters (e.g. ••••••••abcd).
 */
export function maskSecret(secret?: string | null): string {
  if (!secret) return '';
  if (secret.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(secret.length - 4, 12))}${secret.slice(-4)}`;
}

/**
 * Recursively masks sensitive fields in destination config objects for safe API responses.
 */
export function maskDestinationConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['webhookUrl', 'botToken', 'password', 'chatId', 'apiKey', 'secret'];
  const masked: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && sensitiveKeys.includes(key)) {
      masked[key] = maskSecret(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      masked[key] = maskDestinationConfig(value as Record<string, unknown>);
    } else {
      masked[key] = value;
    }
  }

  return masked;
}
