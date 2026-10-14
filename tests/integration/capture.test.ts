import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import { startDemoServer } from '../../src/server/demo/demoServer.js';
import { capturePage, closeBrowser } from '../../src/server/capture/playwrightCapture.js';
import { captureFingerprint } from '../../src/server/capture/captureConfig.js';
import { classifyCheck } from '../../src/server/capture/classifier.js';
import { extractText } from '../../src/server/capture/extract.js';
import { safeFetch } from '../../src/server/capture/safeFetch.js';

describe('Secure Capture, Classifier, and Demo Server (Criteria B, C, H, Y)', () => {
  let demoServer: Server;
  const demoPort = 4000;
  const { config } = captureFingerprint({});

  beforeAll(async () => {
    demoServer = await startDemoServer(demoPort);
  });

  afterAll(async () => {
    await closeBrowser();
    await new Promise<void>((resolve) => demoServer.close(() => resolve()));
  });

  it('Y: Demo server lists all 16 fixtures', async () => {
    const res = await fetch(`http://127.0.0.1:${demoPort}/demo/fixtures`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fixtures).toHaveLength(16);
    expect(data.fixtures.map((f: { id: number }) => f.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
    ]);
  });

  it('H: Stable page captures sanitized DOM, text, screenshot, and classifies as OK', async () => {
    const url = `http://127.0.0.1:${demoPort}/demo/stable`;
    const result = await capturePage(url, config);

    expect(result.httpStatus).toBe(200);
    expect(result.sanitizedDom).toContain('ChangeWatch Stable Documentation');
    expect(result.rawText).toContain('ChangeWatch Stable Documentation');
    expect(result.rawText).toContain('This is an immutable public specification document.');

    // Screenshot file should exist
    expect(result.screenshotPath).not.toBeNull();
    expect(fs.existsSync(result.screenshotPath!)).toBe(true);

    const classification = classifyCheck({
      httpStatus: result.httpStatus,
      rawText: result.rawText,
      sanitizedDom: result.sanitizedDom,
    });
    expect(classification.outcome).toBe('OK');
    expect(classification.reason).toBe('success');
  });

  it('H: 503 Service Unavailable fixture classifies as ERROR (http_503)', async () => {
    const url = `http://127.0.0.1:${demoPort}/demo/503`;
    const result = await capturePage(url, config);

    expect(result.httpStatus).toBe(503);
    const classification = classifyCheck({
      httpStatus: result.httpStatus,
      rawText: result.rawText,
      sanitizedDom: result.sanitizedDom,
    });
    expect(classification.outcome).toBe('ERROR');
    expect(classification.reason).toBe('http_503');
  });

  it('H: Fake CAPTCHA fixture classifies as BLOCKED (captcha_challenge)', async () => {
    const url = `http://127.0.0.1:${demoPort}/demo/captcha`;
    const result = await capturePage(url, config);

    const classification = classifyCheck({
      httpStatus: result.httpStatus,
      rawText: result.rawText,
      sanitizedDom: result.sanitizedDom,
    });
    expect(classification.outcome).toBe('BLOCKED');
    expect(classification.reason).toBe('captcha_challenge');
  });

  it('H: 429 Rate-Limited fixture classifies as BLOCKED (rate_limited_429)', async () => {
    const url = `http://127.0.0.1:${demoPort}/demo/rate-limit`;
    const result = await capturePage(url, config);

    expect(result.httpStatus).toBe(429);
    const classification = classifyCheck({
      httpStatus: result.httpStatus,
      rawText: result.rawText,
      sanitizedDom: result.sanitizedDom,
    });
    expect(classification.outcome).toBe('BLOCKED');
    expect(classification.reason).toBe('rate_limited_429');
  });

  it('H: Empty content fixture classifies as ERROR (empty_content)', async () => {
    const url = `http://127.0.0.1:${demoPort}/demo/empty`;
    const result = await capturePage(url, config);

    const classification = classifyCheck({
      httpStatus: result.httpStatus,
      rawText: result.rawText,
      sanitizedDom: result.sanitizedDom,
    });
    expect(classification.outcome).toBe('ERROR');
    expect(classification.reason).toBe('empty_content');
  });

  it('C: Single extraction contract honors includeSelectors and ignoreSelectors', () => {
    const html = `
      <div>
        <div id="banner">Ad Banner Buy Now</div>
        <main id="content">
          <h1>Product Title</h1>
          <p>Product Description text here.</p>
        </main>
      </div>
    `;

    // 1. Without selectors
    const allText = extractText(html, [], []);
    expect(allText).toContain('Ad Banner Buy Now');
    expect(allText).toContain('Product Title');

    // 2. With ignore selector on #banner
    const ignoredText = extractText(html, [], ['#banner']);
    expect(ignoredText).not.toContain('Ad Banner');
    expect(ignoredText).toContain('Product Title');

    // 3. With include selector on #content
    const includedText = extractText(html, ['#content'], []);
    expect(includedText).not.toContain('Ad Banner');
    expect(includedText).toContain('Product Title');
  });

  it('B: safeFetch blocks redirect to private IP metadata address (SSRF re-validation)', async () => {
    const url = `http://127.0.0.1:${demoPort}/demo/redirect-private`;
    await expect(safeFetch(url)).rejects.toThrow('SSRF guard blocked');
  });
});
