import { describe, it, expect } from 'vitest';
import {
  captureFingerprint,
  CaptureConfigSchema,
  canonicalStringify,
  DEFAULT_UA,
} from '../../src/server/capture/captureConfig.js';

describe('CaptureConfig and Fingerprint (AF, AG, AI)', () => {
  it('AF: Omitted defaults, explicit defaults, and reordered keys give identical fingerprints', () => {
    // 1. Omitted defaults
    const fromEmpty = captureFingerprint({});

    // 2. Explicit defaults
    const fromExplicit = captureFingerprint({
      engine: 'playwright',
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      jsEnabled: true,
      userAgent: DEFAULT_UA,
      waitStrategy: { timeoutMs: 10000 },
    });

    // 3. Reordered keys
    const fromReordered = captureFingerprint({
      userAgent: DEFAULT_UA,
      jsEnabled: true,
      waitStrategy: { timeoutMs: 10000 },
      viewport: { height: 720, width: 1280 },
      engine: 'playwright',
      deviceScaleFactor: 1,
    });

    expect(fromEmpty.fingerprint).toBe(fromExplicit.fingerprint);
    expect(fromExplicit.fingerprint).toBe(fromReordered.fingerprint);
    expect(fromEmpty.fingerprint).toHaveLength(64);
  });

  it('AG: Material config changes give different fingerprints', () => {
    const base = captureFingerprint({});

    // Change viewport
    const customViewport = captureFingerprint({
      viewport: { width: 1920, height: 1080 },
    });
    expect(customViewport.fingerprint).not.toBe(base.fingerprint);

    // Change jsEnabled
    const noJs = captureFingerprint({ jsEnabled: false });
    expect(noJs.fingerprint).not.toBe(base.fingerprint);

    // Change wait selector
    const withSelector = captureFingerprint({
      waitStrategy: { waitForSelector: '#content', timeoutMs: 10000 },
    });
    expect(withSelector.fingerprint).not.toBe(base.fingerprint);

    // Change userAgent
    const customUa = captureFingerprint({ userAgent: 'CustomBot/1.0' });
    expect(customUa.fingerprint).not.toBe(base.fingerprint);

    // Change locale
    const withLocale = captureFingerprint({ locale: 'en-US' });
    expect(withLocale.fingerprint).not.toBe(base.fingerprint);
  });

  it('AI: Capture config rejects unknown keys', () => {
    // Rejects customHeaders
    expect(() => {
      CaptureConfigSchema.parse({
        customHeaders: { Authorization: 'Bearer token' },
      });
    }).toThrow();

    // Rejects cookies
    expect(() => {
      CaptureConfigSchema.parse({
        cookies: [{ name: 'session', value: '123' }],
      });
    }).toThrow();

    // Rejects arbitrary injected properties
    expect(() => {
      CaptureConfigSchema.parse({
        maliciousField: true,
      });
    }).toThrow();
  });

  it('canonicalStringify handles nested arrays and drops undefined cleanly', () => {
    const obj1 = { a: 1, b: undefined, c: [1, 2, { z: 9, y: 8 }] };
    const obj2 = { c: [1, 2, { y: 8, z: 9 }], a: 1 };
    expect(canonicalStringify(obj1)).toBe(canonicalStringify(obj2));
  });
});
