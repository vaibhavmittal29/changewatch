import { chromium, type Browser } from 'playwright';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '../config.js';
import { type CaptureConfig } from './captureConfig.js';
import { isPublicIp } from './validateUrl.js';
import { extractText } from './extract.js';

let sharedBrowser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return sharedBrowser;
}

export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}

export interface CaptureResult {
  observationId: string;
  finalUrl: string;
  httpStatus: number;
  sanitizedDom: string;
  rawText: string;
  screenshotPath: string | null;
  subresourceCount: number;
  durationMs: number;
  pageTooLarge: boolean;
  errorMessage?: string;
  isTimeout?: boolean;
}

const TRACKER_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'facebook.net', 'adnxs.com', 'criteo.com', 'hotjar.com'
];

/**
 * Headless Playwright capture engine meeting all Section 9.1 criteria:
 * - Route interception (aborts heavy media/trackers, closes WebSockets)
 * - Service workers blocked
 * - DOM sanitization (removes scripts, styles, iframes, comments, hidden elements)
 * - Full-page PNG screenshot
 * - Unified block-level text extraction
 */
export async function capturePage(
  targetUrl: string,
  config: CaptureConfig,
  observationId?: string
): Promise<CaptureResult> {
  const startTime = Date.now();
  const obsId = observationId || crypto.randomUUID();
  const browser = await getBrowser();

  const context = await browser.newContext({
    viewport: config.viewport,
    deviceScaleFactor: config.deviceScaleFactor,
    javaScriptEnabled: config.jsEnabled,
    userAgent: config.userAgent,
    locale: config.locale,
    timezoneId: config.timezone,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });

  const page = await context.newPage();
  let subresourceCount = 0;
  let finalStatus = 200;
  let finalUrl = targetUrl;
  let pageTooLarge = false;

  try {
    // 1. Intercept and terminate WebSockets
    await page.routeWebSocket('**/*', (ws) => ws.close());

    // 2. Intercept all network routes
    await page.route('**/*', async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const reqUrlStr = request.url();

      let parsed: URL;
      try {
        parsed = new URL(reqUrlStr);
      } catch {
        return route.abort('blockedbyclient');
      }

      // Allow only http, https, data, blob
      if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) {
        return route.abort('blockedbyclient');
      }

      // Abort heavy media for change-detection speed
      if (['media', 'font'].includes(resourceType)) {
        return route.abort('blockedbyclient');
      }

      // Abort known trackers
      const host = parsed.hostname.toLowerCase();
      if (TRACKER_DOMAINS.some(d => host.endsWith(d))) {
        return route.abort('blockedbyclient');
      }

      // If remote host, check against private IP ranges (unless demo server)
      const isDemo = env.ALLOW_LOCAL_DEMO && (
        (host === 'localhost' || host === '127.0.0.1') &&
        parseInt(parsed.port || '80', 10) === env.DEMO_PORT
      );

      if (!isDemo && parsed.protocol.startsWith('http') && parsed.hostname) {
        // Direct IP check
        if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) || parsed.hostname.includes(':')) {
          if (!isPublicIp(parsed.hostname)) {
            return route.abort('blockedbyclient');
          }
        }
      }

      subresourceCount++;
      route.continue();
    });

    // 3. Navigate with 30s timeout
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    if (response) {
      finalStatus = response.status();
      finalUrl = response.url();
    }

    // Wait up to 5s for network idle (timeout here is ignored)
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Optional wait strategy selector
    if (config.waitStrategy?.waitForSelector) {
      await page.waitForSelector(config.waitStrategy.waitForSelector, {
        timeout: config.waitStrategy.timeoutMs || 10000,
      }).catch(() => {});
    }

    // 500ms settle delay
    await page.waitForTimeout(500);

    // 4. In-page DOM sanitization
    await page.evaluate(() => {
      // Remove scripts, styles, noscript, iframes
      const tagsToRemove = ['script', 'style', 'noscript', 'iframe'];
      for (const tag of tagsToRemove) {
        document.querySelectorAll(tag).forEach(el => el.remove());
      }
      // Remove hidden and non-visible elements
      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || el.hasAttribute('hidden')) {
          el.remove();
        }
      });
      // Remove HTML comments
      const iterator = document.createNodeIterator(document.documentElement, NodeFilter.SHOW_COMMENT);
      let curr = iterator.nextNode();
      while (curr) {
        curr.parentNode?.removeChild(curr);
        curr = iterator.nextNode();
      }
    });

    const sanitizedDom = await page.content();

    // Check ~1.5 MB DOM cap
    if (sanitizedDom.length > 1.5 * 1024 * 1024) {
      pageTooLarge = true;
    }

    // 5. Screenshot
    let screenshotPath: string | null = null;
    try {
      const screenshotsDir = path.join(env.DATA_DIR, 'screenshots');
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }
      const fullPath = path.join(screenshotsDir, `${obsId}.png`);
      await page.screenshot({ path: fullPath, fullPage: true });
      screenshotPath = fullPath;
    } catch (ssErr) {
      console.warn(`[capturePage] Screenshot capture failed for ${obsId}:`, ssErr);
    }

    // 6. Text extraction
    const rawText = extractText(sanitizedDom, [], []);

    return {
      observationId: obsId,
      finalUrl,
      httpStatus: finalStatus,
      sanitizedDom,
      rawText,
      screenshotPath,
      subresourceCount,
      durationMs: Date.now() - startTime,
      pageTooLarge,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.toLowerCase().includes('timeout');
    return {
      observationId: obsId,
      finalUrl,
      httpStatus: finalStatus || 0,
      sanitizedDom: '',
      rawText: '',
      screenshotPath: null,
      subresourceCount,
      durationMs: Date.now() - startTime,
      pageTooLarge: false,
      errorMessage: message,
      isTimeout,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
