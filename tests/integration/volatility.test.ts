import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { startDemoServer } from '../../src/server/demo/demoServer.js';
import { probeTargetVolatility } from '../../src/server/engine/volatility.js';
import { applyNoiseFilters } from '../../src/server/engine/noiseFilters.js';
import { normalizeWhitespace } from '../../src/server/engine/normalize.js';
import { captureFingerprint } from '../../src/server/capture/captureConfig.js';
import { closeBrowser } from '../../src/server/capture/playwrightCapture.js';

describe('Phase D: Volatility Probe (Acceptance Matrix O)', () => {
  let demoServer: Server;
  const { config } = captureFingerprint({});

  beforeAll(async () => {
    demoServer = await startDemoServer(4000);
  });

  afterAll(async () => {
    await closeBrowser().catch(() => {});
    await new Promise<void>((resolve) => demoServer.close(() => resolve()));
  });

  it('probes volatile counter fixture, identifies unstable lines, and generates ignore patterns', async () => {
    const probeResult = await probeTargetVolatility('http://127.0.0.1:4000/demo/counter', config, 100);

    expect(probeResult.capturesCount).toBe(2);
    expect(probeResult.unstableLines.length).toBeGreaterThan(0);
    expect(probeResult.suggestedPatterns.length).toBeGreaterThan(0);

    // Verify unstable line contains counter metric
    const hasCounter = probeResult.unstableLines.some(l => {
      const lower = l.toLowerCase();
      return lower.includes('views') || lower.includes('online now');
    });
    expect(hasCounter).toBe(true);

    // Verify that applying the suggested patterns suppresses the volatile line
    const sampleText = `Header\n${probeResult.unstableLines[0]}\nFooter`;
    const filtered = applyNoiseFilters(sampleText, { timestamps: false, counters: false, tokens: false }, probeResult.suggestedPatterns);
    const normalized = normalizeWhitespace(filtered);

    expect(normalized.includes(probeResult.unstableLines[0])).toBe(false);
    expect(normalized).toBe('Header\nFooter');
  });
});
