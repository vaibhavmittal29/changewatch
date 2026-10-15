import { describe, it, expect } from 'vitest';
import {
  CaptureConfigSchema,
  captureFingerprint,
} from '../../src/server/capture/captureConfig.js';
import { captureHttpDom } from '../../src/server/capture/httpDomCapture.js';

describe('Phase 3: Capture Engine Config & Cross-Field Validation (engine × screenshot)', () => {
  it('defaults engine to playwright and captureScreenshot to true when omitted', () => {
    const config = CaptureConfigSchema.parse({});
    expect(config.engine).toBe('playwright');
    expect(config.captureScreenshot).toBe(true);
  });

  it('allows engine: playwright with captureScreenshot: false', () => {
    const config = CaptureConfigSchema.parse({ engine: 'playwright', captureScreenshot: false });
    expect(config.engine).toBe('playwright');
    expect(config.captureScreenshot).toBe(false);
  });

  it('defaults captureScreenshot to false when engine is http_dom', () => {
    const config = CaptureConfigSchema.parse({ engine: 'http_dom' });
    expect(config.engine).toBe('http_dom');
    expect(config.captureScreenshot).toBe(false);
  });

  it('allows engine: http_dom with explicit captureScreenshot: false', () => {
    const config = CaptureConfigSchema.parse({ engine: 'http_dom', captureScreenshot: false });
    expect(config.engine).toBe('http_dom');
    expect(config.captureScreenshot).toBe(false);
  });

  it('REJECTS invalid combination: engine: http_dom with captureScreenshot: true', () => {
    expect(() => {
      CaptureConfigSchema.parse({ engine: 'http_dom', captureScreenshot: true });
    }).toThrow(/Screenshots require 'playwright' engine/);
  });

  it('rejects unsupported engine types', () => {
    expect(() => {
      CaptureConfigSchema.parse({ engine: 'selenium' });
    }).toThrow();
  });

  it('rejects unknown fields (strict schema enforcement)', () => {
    expect(() => {
      CaptureConfigSchema.parse({ engine: 'playwright', customHeaders: { 'X-Secret': '123' } });
    }).toThrow();
  });

  it('httpDomCapture rejects any configuration requesting screenshots', async () => {
    // Construct a config object with captureScreenshot: true (bypassing Zod to test runtime defense)
    const invalidConfig = {
      engine: 'http_dom' as const,
      captureScreenshot: true,
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      jsEnabled: false,
      userAgent: 'test',
      waitStrategy: { timeoutMs: 5000 },
    };

    await expect(captureHttpDom('http://127.0.0.1:4000/demo/stable', invalidConfig)).rejects.toThrow(
      "Invalid capture configuration: 'http_dom' engine cannot capture screenshots"
    );
  });

  it('fingerprint changes when captureScreenshot is altered', () => {
    const withScreenshot = captureFingerprint({ engine: 'playwright', captureScreenshot: true });
    const withoutScreenshot = captureFingerprint({ engine: 'playwright', captureScreenshot: false });

    expect(withScreenshot.fingerprint).not.toBe(withoutScreenshot.fingerprint);
  });
});
