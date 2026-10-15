import { chromium, type Browser } from 'playwright';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns/promises';
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
  topLevelNavigations: number;
  durationMs: number;
  pageTooLarge: boolean;
  errorMessage?: string;
  isTimeout?: boolean;
}

const TRACKER_DOMAINS = ['google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'facebook.net', 'adnxs.com', 'criteo.com', 'hotjar.com'];

async function isSafeRouteHost(host: string, port: number, isDemo: boolean): Promise<boolean> {
  if (isDemo) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.arpa') ||
      h.endsWith('.test') || h.endsWith('.example')) return false;
  if (port !== 80 && port !== 443) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return isPublicIp(h);
  try {
    const records = await dns.lookup(h, { all: true });
    return Boolean(records && records.length > 0 && records.every(r => isPublicIp(r.address)));
  } catch {
    return false;
  }
}

export async function capturePage(targetUrl: string, config: CaptureConfig, observationId?: string): Promise<CaptureResult> {
  const startTime = Date.now();
  const obsId = observationId || crypto.randomUUID();
  const browser = await getBrowser();

  const context = await browser.newContext({
    viewport: config.viewport, deviceScaleFactor: config.deviceScaleFactor,
    javaScriptEnabled: config.jsEnabled, userAgent: config.userAgent,
    locale: config.locale, timezoneId: config.timezone,
    serviceWorkers: 'block', acceptDownloads: false,
  });

  const page = await context.newPage();
  let subresourceCount = 0;
  let topLevelNavigations = 0;
  let finalStatus = 0;
  let finalUrl = targetUrl;
  let pageTooLarge = false;

  try {
    // 1. Intercept and terminate WebSockets
    await page.routeWebSocket('**/*', (ws) => ws.close());

    // 2. Intercept and validate all network routes (SSRF & egress control)
    await page.route('**/*', async (route) => {
      try {
        const req = route.request();
        const resType = req.resourceType();
        let parsed: URL;
        try { parsed = new URL(req.url()); } catch { return await route.abort('blockedbyclient'); }

        if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) {
          return await route.abort('blockedbyclient');
        }
        if (['media', 'font'].includes(resType)) return await route.abort('blockedbyclient');

        const host = parsed.hostname.toLowerCase();
        if (TRACKER_DOMAINS.some(d => host.endsWith(d))) return await route.abort('blockedbyclient');

        const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
        const isDemo = env.ALLOW_LOCAL_DEMO &&
          (host === 'localhost' || host === '127.0.0.1' || host === '::1') &&
          port === env.DEMO_PORT;

        if (parsed.protocol.startsWith('http') && host) {
          const safe = await isSafeRouteHost(host, port, isDemo);
          if (!safe) return await route.abort('blockedbyclient');
        }

        if (req.isNavigationRequest() && resType === 'document' && req.frame() === page.mainFrame()) {
          topLevelNavigations++;
          const fetched = await route.fetch({ maxRedirects: 0 });
          if (fetched.status() >= 300 && fetched.status() < 400) {
            const loc = fetched.headers()['location'];
            if (loc) {
              const redUrl = new URL(loc, req.url());
              const redHost = redUrl.hostname.toLowerCase();
              const redPort = parseInt(redUrl.port || (redUrl.protocol === 'https:' ? '443' : '80'), 10);
              const redDemo = env.ALLOW_LOCAL_DEMO && (redHost === 'localhost' || redHost === '127.0.0.1' || redHost === '::1') && redPort === env.DEMO_PORT;
              if (!(await isSafeRouteHost(redHost, redPort, redDemo))) {
                return await route.fulfill({
                  status: 403,
                  contentType: 'text/plain',
                  body: `SSRF_BLOCKED: Prohibited redirect destination '${redHost}'`,
                });
              }
            }
          }
          return await route.fulfill({ response: fetched });
        } else {
          subresourceCount++;
        }
        return await route.continue();
      } catch {
        return await route.abort('blockedbyclient').catch(() => {});
      }
    });

    // Validate target URL before navigation
    const targetParsed = new URL(targetUrl);
    const targetHost = targetParsed.hostname.toLowerCase();
    const targetPort = parseInt(targetParsed.port || (targetParsed.protocol === 'https:' ? '443' : '80'), 10);
    const targetIsDemo = env.ALLOW_LOCAL_DEMO && (targetHost === 'localhost' || targetHost === '127.0.0.1' || targetHost === '::1') && targetPort === env.DEMO_PORT;
    if (!targetIsDemo && !(await isSafeRouteHost(targetHost, targetPort, false))) {
      throw new Error(`SSRF guard blocked navigation to disallowed host '${targetHost}'`);
    }

    // 3. Navigate with 30s timeout
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    if (response) {
      finalStatus = response.status();
      finalUrl = response.url();
    }

    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    if (config.waitStrategy?.waitForSelector) {
      await page.waitForSelector(config.waitStrategy.waitForSelector, {
        timeout: config.waitStrategy.timeoutMs || 10000,
      }).catch(() => {});
    }

    await page.waitForTimeout(500);

    // 4. Capture screenshot FIRST while styles, fonts, and layout are intact
    let screenshotPath: string | null = null;
    if (config.captureScreenshot) {
      try {
        const screenshotsDir = path.join(env.DATA_DIR, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
        const fullPath = path.join(screenshotsDir, `${obsId}.png`);
        await page.screenshot({ path: fullPath, fullPage: true });
        screenshotPath = fullPath;
      } catch (ssErr) {
        console.warn(`[capturePage] Screenshot capture failed for ${obsId}:`, ssErr);
      }
    }

    // 5. In-page DOM sanitization: remove hidden elements while computed styles are intact
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach(el => {
        try {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || el.hasAttribute('hidden')) {
            el.remove();
          }
        } catch {}
      });
      ['script', 'style', 'noscript', 'iframe'].forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove());
      });
      const it = document.createNodeIterator(document.documentElement, NodeFilter.SHOW_COMMENT);
      let curr = it.nextNode();
      while (curr) {
        curr.parentNode?.removeChild(curr);
        curr = it.nextNode();
      }
    });

    const sanitizedDom = await page.content();
    if (sanitizedDom.length > 1.5 * 1024 * 1024) pageTooLarge = true;

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
      topLevelNavigations,
      durationMs: Date.now() - startTime,
      pageTooLarge,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      observationId: obsId,
      finalUrl,
      httpStatus: finalStatus || 0,
      sanitizedDom: '',
      rawText: '',
      screenshotPath: null,
      subresourceCount,
      topLevelNavigations,
      durationMs: Date.now() - startTime,
      pageTooLarge: false,
      errorMessage: message,
      isTimeout: message.toLowerCase().includes('timeout'),
    };
  } finally {
    await context.close().catch(() => {});
  }
}
