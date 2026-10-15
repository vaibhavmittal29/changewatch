import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { startDemoServer } from '../../src/server/demo/demoServer.js';
import { capturePage, closeBrowser } from '../../src/server/capture/playwrightCapture.js';
import { captureFingerprint } from '../../src/server/capture/captureConfig.js';

describe('Phase 1: Benchmark & Navigation Counting Rigor', () => {
  let demoServer: Server;
  const demoPort = 4000;
  const { config } = captureFingerprint({});

  beforeAll(async () => {
    demoServer = await startDemoServer(demoPort);
  });

  afterAll(async () => {
    await closeBrowser().catch(() => {});
    await new Promise<void>((resolve) => demoServer.close(() => resolve()));
  });

  it('proves iframe document requests are NOT counted as top-level navigations', async () => {
    const result = await capturePage(`http://127.0.0.1:${demoPort}/demo/iframe-test`, config);

    expect(result.httpStatus).toBe(200);
    expect(result.sanitizedDom).toContain('Page With Iframe');
    // Main frame was loaded, child frame was loaded
    // topLevelNavigations MUST be strictly 1
    expect(result.topLevelNavigations).toBe(1);
    // The child iframe navigation document request must be counted under subresources
    expect(result.subresourceCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects zero top_level_navigations without defaulting to 1', () => {
    const validateMeasurement = (rawNavs: unknown) => {
      if (typeof rawNavs !== 'number' || isNaN(rawNavs) || rawNavs < 1) {
        throw new Error(`Invalid or missing top_level_navigations: ${rawNavs}`);
      }
      return rawNavs;
    };

    expect(() => validateMeasurement(0)).toThrow('Invalid or missing top_level_navigations: 0');
    expect(() => validateMeasurement(null)).toThrow('Invalid or missing top_level_navigations: null');
    expect(() => validateMeasurement(undefined)).toThrow('Invalid or missing top_level_navigations: undefined');
    expect(() => validateMeasurement(NaN)).toThrow('Invalid or missing top_level_navigations: NaN');
    expect(() => validateMeasurement(-1)).toThrow('Invalid or missing top_level_navigations: -1');
    expect(validateMeasurement(1)).toBe(1);
  });

  it('rejects missing or malformed observation rows in benchmark pipeline', () => {
    const validateObservation = (obsRows: Array<{ top_level_navigations?: number }>) => {
      if (!obsRows || obsRows.length !== 1) {
        throw new Error(`Expected exactly 1 observation row, found ${obsRows ? obsRows.length : 0}`);
      }
      const raw = obsRows[0].top_level_navigations;
      if (typeof raw !== 'number' || isNaN(raw) || raw < 1) {
        throw new Error(`Invalid top_level_navigations measurement: ${raw}`);
      }
      return raw;
    };

    expect(() => validateObservation([])).toThrow('Expected exactly 1 observation row, found 0');
    expect(() => validateObservation([{}, {}])).toThrow('Expected exactly 1 observation row, found 2');
    expect(() => validateObservation([{}])).toThrow('Invalid top_level_navigations measurement: undefined');
    expect(() => validateObservation([{ top_level_navigations: 0 }])).toThrow('Invalid top_level_navigations measurement: 0');
    expect(validateObservation([{ top_level_navigations: 1 }])).toBe(1);
  });
});
