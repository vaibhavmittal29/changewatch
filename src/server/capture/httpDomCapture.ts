import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import { safeFetch } from './safeFetch.js';
import { extractText } from './extract.js';
import type { CaptureConfig } from './captureConfig.js';
import type { CaptureResult } from './playwrightCapture.js';

/**
 * Lightweight alternative capture engine using Cheerio (STRETCH requirement X1).
 * Fetches HTML with safeFetch IP-pinning and parses DOM without Chromium overhead.
 * Note: Does not render screenshots or execute client-side JavaScript.
 */
export async function captureHttpDom(
  targetUrl: string,
  _config: CaptureConfig,
  observationId?: string
): Promise<CaptureResult> {
  const startTime = Date.now();
  const obsId = observationId || crypto.randomUUID();

  try {
    const fetchRes = await safeFetch(targetUrl, { timeoutMs: 15000, maxBytes: 1.5 * 1024 * 1024 });

    const $ = cheerio.load(fetchRes.body);
    // Sanitize DOM: remove scripts, styles, noscript, iframes
    $('script, style, noscript, iframe').remove();

    const sanitizedDom = $.html();
    const rawText = extractText(sanitizedDom, [], []);

    return {
      observationId: obsId,
      finalUrl: fetchRes.finalUrl,
      httpStatus: fetchRes.status,
      sanitizedDom,
      rawText,
      screenshotPath: null,
      subresourceCount: 0,
      topLevelNavigations: 1,
      durationMs: Date.now() - startTime,
      pageTooLarge: fetchRes.body.length > 1.5 * 1024 * 1024,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      observationId: obsId,
      finalUrl: targetUrl,
      httpStatus: 0,
      sanitizedDom: '',
      rawText: '',
      screenshotPath: null,
      subresourceCount: 0,
      topLevelNavigations: 1,
      durationMs: Date.now() - startTime,
      pageTooLarge: false,
      errorMessage: message,
      isTimeout: message.toLowerCase().includes('timeout'),
    };
  }
}
