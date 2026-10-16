import crypto from 'node:crypto';
import { getBrowser } from './playwrightCapture.js';
import { validateUrl } from './validateUrl.js';
import { validateRouteUrl } from './routeValidation.js';
import { ELEMENT_INSPECTOR_SCRIPT, type ElementBox } from './selectorGenerator.js';
import { DEFAULT_CAPTURE_CONFIG, type CaptureConfig } from './captureConfig.js';

export interface PickerRenderResult {
  renderId: string;
  url: string;
  screenshotBase64: string;
  width: number;
  height: number;
  elements: ElementBox[];
  sanitizedDom: string;
}

// In-memory cache for picker sessions to test selectors fast (15m TTL)
interface CacheEntry {
  sanitizedDom: string;
  expiresAt: number;
}
const renderCache = new Map<string, CacheEntry>();

const MAX_CACHE_ENTRIES = 50;
const MAX_DOM_LENGTH = 1024 * 1024; // 1MB DOM cap
let activePickerRenders = 0;
const MAX_CONCURRENT_RENDERS = 3;

export function getCachedDom(renderId: string): string | null {
  const entry = renderCache.get(renderId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    renderCache.delete(renderId);
    return null;
  }
  // Move to end for LRU refresh
  renderCache.delete(renderId);
  renderCache.set(renderId, entry);
  return entry.sanitizedDom;
}

export function cacheDom(renderId: string, sanitizedDom: string): void {
  const cappedDom = sanitizedDom.length > MAX_DOM_LENGTH ? sanitizedDom.slice(0, MAX_DOM_LENGTH) : sanitizedDom;
  const now = Date.now();
  for (const [id, entry] of renderCache.entries()) {
    if (now > entry.expiresAt) renderCache.delete(id);
  }
  if (renderCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = renderCache.keys().next().value;
    if (oldest) renderCache.delete(oldest);
  }
  renderCache.set(renderId, { sanitizedDom: cappedDom, expiresAt: now + 15 * 60 * 1000 });
}

const TRACKER_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'facebook.net', 'adnxs.com', 'criteo.com', 'hotjar.com'
];

/**
 * Headless Playwright renderer specifically for the Visual Selector Picker (Section 9.10).
 * Captures screenshot, calculates bounding boxes, flags fragile selectors, and sanitizes DOM.
 */
export async function renderPicker(
  targetUrl: string,
  userConfig: Partial<CaptureConfig> = {}
): Promise<PickerRenderResult> {
  if (activePickerRenders >= MAX_CONCURRENT_RENDERS) {
    throw new Error('Too many concurrent picker renders in progress. Please retry in a moment.');
  }
  activePickerRenders++;
  try {
    const config = { ...DEFAULT_CAPTURE_CONFIG, ...userConfig };
    await validateUrl(targetUrl);

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

  try {
    // 1. Terminate WebSockets
    await page.routeWebSocket('**/*', (ws) => ws.close());

    // 2. Route interception with SSRF check & tracker block (CW-SEC-01)
    await page.route('**/*', async (route) => {
      const request = route.request();
      const reqUrl = request.url();

      let parsed: URL;
      try {
        parsed = new URL(reqUrl);
      } catch {
        return route.abort('blockedbyclient');
      }

      const hostname = parsed.hostname.toLowerCase();
      if (TRACKER_DOMAINS.some(td => hostname === td || hostname.endsWith(`.${td}`))) {
        return route.abort('blockedbyclient');
      }

      if (['video', 'media'].includes(request.resourceType())) {
        return route.abort('blockedbyclient');
      }

      const validation = await validateRouteUrl(reqUrl);
      if (!validation.allowed) {
        return route.abort('blockedbyclient');
      }

      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const fetched = await route.fetch({ maxRedirects: 0 });
        if (fetched.status() >= 300 && fetched.status() < 400) {
          const loc = fetched.headers()['location'];
          if (loc) {
            const redUrl = new URL(loc, reqUrl);
            const redVal = await validateRouteUrl(redUrl.toString());
            if (!redVal.allowed) {
              return route.fulfill({
                status: 403,
                contentType: 'text/plain',
                body: `SSRF_BLOCKED: Prohibited redirect destination '${redUrl.hostname}' (${redVal.reason})`,
              });
            }
          }
        }
        return route.fulfill({ response: fetched });
      }

      return route.continue();
    });

    // 3. Navigate
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 3000 });
    } catch {
      // Network idle timeout is non-fatal
    }
    await page.waitForTimeout(400);

    // 4. Inspect elements on page
    const elements = await page.evaluate<ElementBox[]>(ELEMENT_INSPECTOR_SCRIPT);

    // 5. Screenshot
    const screenshotBuffer = await page.screenshot({ fullPage: false, type: 'png' });
    const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;

    // 6. Sanitize DOM for single extraction contract
    await page.evaluate(() => {
      const tagsToRemove = ['script', 'style', 'noscript', 'iframe'];
      for (const tag of tagsToRemove) {
        document.querySelectorAll(tag).forEach(el => el.remove());
      }
      // Remove comments
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
      const comments: Comment[] = [];
      while (walker.nextNode()) comments.push(walker.currentNode as Comment);
      comments.forEach(c => c.remove());
    });

    const sanitizedDom = await page.content();
    const renderId = crypto.randomUUID();
    cacheDom(renderId, sanitizedDom);

    const vp = config.viewport;
    return {
      renderId,
      url: targetUrl,
      screenshotBase64,
      width: vp.width,
      height: vp.height,
      elements,
      sanitizedDom,
    };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  } finally {
    activePickerRenders--;
  }
}
