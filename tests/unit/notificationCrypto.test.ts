import { describe, it, expect } from 'vitest';
import {
  encryptConfig,
  decryptConfig,
  maskSecret,
  maskDestinationConfig,
} from '../../src/server/notifications/crypto.js';

describe('Phase 7 Unit: Notification Crypto & Secret Masking (Acceptance Matrix A2)', () => {
  it('encrypts and decrypts structured destination configuration objects with AES-256-GCM', () => {
    const originalConfig = {
      webhookUrl: 'https://discord.com/api/webhooks/123456789/secure-token-abcdef',
      botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      chatId: '-1001234567890',
      port: 587,
    };

    const encrypted = encryptConfig(originalConfig);
    expect(encrypted).not.toContain('https://');
    expect(encrypted).not.toContain('secure-token');

    // Matches iv:ciphertext:tag structure
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);

    const decrypted = decryptConfig<typeof originalConfig>(encrypted);
    expect(decrypted).toEqual(originalConfig);
  });

  it('fails decryption cleanly when ciphertext or authentication tag is tampered with', () => {
    const encrypted = encryptConfig({ secret: 'my-secret-key' });
    const parts = encrypted.split(':');

    // Tamper with ciphertext
    const tamperedCipher = parts[1].slice(0, -2) + (parts[1].endsWith('0') ? '1' : '0');
    const tampered = `${parts[0]}:${tamperedCipher}:${parts[2]}`;

    expect(() => decryptConfig(tampered)).toThrow();
  });

  it('masks sensitive strings to reveal only the final 4 characters', () => {
    expect(maskSecret('super-secret-discord-token-1234')).toMatch(/•+1234$/);
    expect(maskSecret('1234')).toBe('••••');
    expect(maskSecret('')).toBe('');
  });

  it('recursively masks sensitive keys in destination configurations for safe API responses', () => {
    const raw = {
      channel: 'discord',
      webhookUrl: 'https://discord.com/api/webhooks/123/token-wxyz',
      botToken: '987654:my-telegram-bot-token-9999',
      unrelatedField: 'safe-public-name',
      nested: {
        apiKey: 'sk-1234567890abcdef',
        count: 42,
      },
    };

    const masked = maskDestinationConfig(raw);

    expect(masked.webhookUrl).toMatch(/•+wxyz$/);
    expect(masked.botToken).toMatch(/•+9999$/);
    expect(masked.unrelatedField).toBe('safe-public-name');

    const nested = masked.nested as Record<string, unknown>;
    expect(nested.apiKey).toMatch(/•+cdef$/);
    expect(nested.count).toBe(42);
  });
});
