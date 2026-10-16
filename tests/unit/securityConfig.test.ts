import { describe, it, expect } from 'vitest';
import { EnvSchema } from '../../src/server/config.js';
import { encryptConfig, decryptConfig, maskSecret } from '../../src/server/notifications/crypto.js';

describe('Security Configuration & Secret Management (Criterion A)', () => {
  it('rejects missing APP_SECRET in production mode', () => {
    const res = EnvSchema.safeParse({
      NODE_ENV: 'production',
      APP_SECRET: undefined,
      CONTACT_EMAIL: 'admin@example.com',
      PBKDF2_ITERATIONS: 600000,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const msgs = res.error.issues.map(i => i.message);
      expect(msgs.some(m => m.includes('Production requires a high-entropy APP_SECRET'))).toBe(true);
    }
  });

  it('rejects predictable or weak APP_SECRET in production mode', () => {
    const res = EnvSchema.safeParse({
      NODE_ENV: 'production',
      APP_SECRET: 'changewatch_super_secure_random_key_min_32_chars_long_2026',
      CONTACT_EMAIL: 'admin@example.com',
      PBKDF2_ITERATIONS: 600000,
    });
    expect(res.success).toBe(false);
  });

  it('rejects low-entropy or repeated character strings in production mode', () => {
    const repeated = EnvSchema.safeParse({
      NODE_ENV: 'production',
      APP_SECRET: 'a'.repeat(32),
      CONTACT_EMAIL: 'admin@example.com',
      PBKDF2_ITERATIONS: 600000,
    });
    expect(repeated.success).toBe(false);

    const alternating = EnvSchema.safeParse({
      NODE_ENV: 'production',
      APP_SECRET: 'abababababababababababababababab',
      CONTACT_EMAIL: 'admin@example.com',
      PBKDF2_ITERATIONS: 600000,
    });
    expect(alternating.success).toBe(false);
  });

  it('allows omitted APP_SECRET in development mode with fallback', () => {
    const res = EnvSchema.safeParse({
      NODE_ENV: 'development',
      CONTACT_EMAIL: 'admin@example.com',
    });
    expect(res.success).toBe(true);
  });

  it('accepts valid high-entropy APP_SECRET in production mode', () => {
    const res = EnvSchema.safeParse({
      NODE_ENV: 'production',
      APP_SECRET: 'a_very_random_production_secret_key_with_sufficient_entropy_64chars_long',
      CONTACT_EMAIL: 'admin@example.com',
      PBKDF2_ITERATIONS: 600000,
    });
    expect(res.success).toBe(true);
  });

  it('rejects PBKDF2_ITERATIONS < 600000 in production mode', () => {
    const res = EnvSchema.safeParse({
      NODE_ENV: 'production',
      APP_SECRET: 'a_very_random_production_secret_key_with_sufficient_entropy_64chars_long',
      CONTACT_EMAIL: 'admin@example.com',
      PBKDF2_ITERATIONS: 1000,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const msgs = res.error.issues.map(i => i.message);
      expect(msgs.some(m => m.includes('PBKDF2_ITERATIONS >= 600000'))).toBe(true);
    }
  });

  it('encrypts destination secrets with AES-256-GCM and masks securely', () => {
    const webhook = 'https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz';
    const encrypted = encryptConfig(webhook);
    expect(encrypted).not.toBe(webhook);
    expect(encrypted).toContain(':'); // IV:Ciphertext:Tag format

    const decrypted = decryptConfig<string>(encrypted);
    expect(decrypted).toBe(webhook);

    const masked = maskSecret(webhook);
    expect(masked).not.toBe(webhook);
    expect(masked.endsWith('wxyz')).toBe(true);
  });
});
