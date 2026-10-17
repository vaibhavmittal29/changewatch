/**
 * Static Demo Showcase Adapter (CW-P4-01)
 *
 * Intercepts frontend /api/* fetch requests when deployed to static hosting
 * (e.g. GitHub Pages) where no Express + SQLite + Playwright backend is running.
 * Provides realistic interactive mock data across Dashboard, Timeline, Compare,
 * Visual Picker, and Settings so visitors experience a working showcase.
 */

export const isStaticDemo = typeof window !== 'undefined' && (
  window.location.hostname.endsWith('github.io') ||
  window.location.pathname.startsWith('/changewatch') ||
  window.location.search.includes('demo=true')
);

const MOCK_USER = {
  id: 'usr_demo_showcase',
  email: 'visitor@changewatch.demo',
  displayName: 'Showcase Visitor',
  digestEnabled: 1,
};

const MOCK_MONITORS = [
  {
    id: 'sub_demo_1',
    name: 'Acme Cloud - Pricing & Plans',
    canonical_url: 'https://cloud.acme.example.com/pricing',
    hostname: 'cloud.acme.example.com',
    interval_minutes: 15,
    sensitivity: 'balanced',
    status: 'CHANGED',
    version_count: 3,
    last_checked_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    last_changed_at: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
    is_paused: 0,
    has_alert_destination: 1,
  },
  {
    id: 'sub_demo_2',
    name: 'Status Page - API Health',
    canonical_url: 'https://status.acme.example.com',
    hostname: 'status.acme.example.com',
    interval_minutes: 5,
    sensitivity: 'strict',
    status: 'OK',
    version_count: 8,
    last_checked_at: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
    last_changed_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    is_paused: 0,
    has_alert_destination: 1,
  },
  {
    id: 'sub_demo_3',
    name: 'Competitor Product Catalog',
    canonical_url: 'https://store.rival.example.com/products',
    hostname: 'store.rival.example.com',
    interval_minutes: 30,
    sensitivity: 'balanced',
    status: 'CHECKING',
    version_count: 2,
    last_checked_at: new Date(Date.now() - 30 * 1000).toISOString(),
    last_changed_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    is_paused: 0,
    has_alert_destination: 0,
  },
];

export function installStaticMockFetch(): void {
  if (!isStaticDemo || typeof window === 'undefined') return;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (urlStr.startsWith('/api/') || urlStr.includes('/api/')) {
      const url = new URL(urlStr, window.location.origin);
      const path = url.pathname.replace(/^\/changewatch/, '');

      // Auth endpoints
      if (path === '/api/auth/me') {
        return createJsonResponse({ user: MOCK_USER, csrfToken: 'demo-static-csrf-token' });
      }
      if (path === '/api/auth/login' || path === '/api/auth/register') {
        return createJsonResponse({ ok: true, user: MOCK_USER, csrfToken: 'demo-static-csrf-token' });
      }
      if (path === '/api/auth/logout') {
        return createJsonResponse({ ok: true });
      }

      // Dashboard
      if (path === '/api/dashboard') {
        return createJsonResponse({
          monitors: MOCK_MONITORS,
          stats: { totalMonitors: 3, activeJobs: 1, changesToday: 2, okRate: '100%' },
        });
      }

      // Subscriptions
      if (path.startsWith('/api/subscriptions')) {
        if (path.includes('/timeline')) {
          return createJsonResponse({
            subscription: MOCK_MONITORS[0],
            versions: [
              { id: 'v3', version_number: 3, content_hash: 'h3', change_summary: 'Starter tier lowered to $19/mo', created_at: new Date(Date.now() - 42 * 60 * 1000).toISOString() },
              { id: 'v2', version_number: 2, content_hash: 'h2', change_summary: 'Enterprise SLA updated to 99.99%', created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString() },
              { id: 'v1', version_number: 1, content_hash: 'h1', change_summary: 'Baseline version', created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
            ],
            events: [
              { id: 'ev1', event_type: 'CHANGE', summary: 'Starter tier price lowered from $29 to $19/mo', suppressed: 0, created_at: new Date(Date.now() - 42 * 60 * 1000).toISOString() },
            ],
            recent_checks: [
              { id: 'cr1', outcome: 'OK', reason: null, http_status: 200, duration_ms: 412, created_at: new Date().toISOString() },
            ],
          });
        }
        if (path.includes('/numeric-history')) {
          return createJsonResponse({
            subscriptionId: 'sub_demo_1',
            points: [
              { versionNumber: 1, timestamp: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), value: 29.00 },
              { versionNumber: 2, timestamp: new Date(Date.now() - 5 * 3600 * 1000).toISOString(), value: 29.00 },
              { versionNumber: 3, timestamp: new Date(Date.now() - 42 * 60 * 1000).toISOString(), value: 19.00 },
            ],
          });
        }
        return createJsonResponse({ ok: true, subscription: MOCK_MONITORS[0] });
      }

      // Diff
      if (path.startsWith('/api/diff/text')) {
        return createJsonResponse({
          summary: 'Starter tier price dropped from $29/mo to $19/mo',
          previousText: 'Acme Cloud Platform\nStarter Tier: $29/mo\nIncludes 5 projects\nSupport: 24/7',
          currentText: 'Acme Cloud Platform\nStarter Tier: $19/mo (Sale)\nIncludes 5 projects\nSupport: 24/7',
          diffs: [
            { count: 1, value: 'Acme Cloud Platform\n' },
            { count: 1, removed: true, value: 'Starter Tier: $29/mo\n' },
            { count: 1, added: true, value: 'Starter Tier: $19/mo (Sale)\n' },
            { count: 2, value: 'Includes 5 projects\nSupport: 24/7' },
          ],
        });
      }
      if (path.startsWith('/api/diff/image')) {
        return createJsonResponse({ hasDiff: true, diffPixelCount: 1840, totalPixels: 921600, percentage: 0.2 });
      }

      // Destinations
      if (path === '/api/destinations') {
        return createJsonResponse([
          { id: 'd1', channel: 'discord', enabled: 1, config: { webhookUrl: 'https://discord.com/api/webhooks/••••••••••••/••••••••••••' } },
          { id: 'd2', channel: 'email', enabled: 1, config: { toEmail: 'team-alerts@acme.example.com' } },
        ]);
      }
      if (path === '/api/destinations/test') {
        return createJsonResponse({ ok: true, message: 'Test alert simulated successfully in static demo!' });
      }

      // Visual picker
      if (path === '/api/picker/render') {
        return createJsonResponse({
          renderId: 'picker_demo_render',
          url: 'https://cloud.acme.example.com/pricing',
          screenshotBase64: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="%230f172a"/><text x="40" y="80" fill="%2338bdf8" font-size="28" font-family="sans-serif">Acme Cloud Pricing</text><rect x="40" y="120" width="220" height="180" rx="8" fill="%231e293b" stroke="%23334155"/><text x="60" y="160" fill="%23f8fafc" font-size="20">Starter</text><text x="60" y="200" fill="%2310b981" font-size="24">$19/mo</text></svg>',
          width: 800,
          height: 400,
          elements: [
            { selector: 'h1.title', tagName: 'H1', textSnippet: 'Acme Cloud Pricing', x: 40, y: 50, width: 300, height: 40, isFragile: false },
            { selector: '.pricing-card.starter', tagName: 'DIV', textSnippet: 'Starter $19/mo', x: 40, y: 120, width: 220, height: 180, isFragile: false },
          ],
          sanitizedDom: '<div><h1>Acme Cloud Pricing</h1><div class="pricing-card starter"><h2>Starter</h2><span>$19/mo</span></div></div>',
        });
      }
      if (path === '/api/picker/test-selectors') {
        return createJsonResponse({ extractedText: 'Starter\n$19/mo\nIncludes 5 projects', lineCount: 3 });
      }

      // Demo fixtures
      if (path.startsWith('/api/demo/fixtures')) {
        return createJsonResponse({
          fixtures: [
            { id: 1, name: 'stable', title: 'Stable Documentation' },
            { id: 2, name: 'clock', title: 'Live Ticking Clock' },
            { id: 3, name: 'counter', title: 'Dynamic Visit Counter' },
            { id: 4, name: 'price', title: 'E-Commerce Price Tracker' },
          ],
        });
      }

      return createJsonResponse({ ok: true });
    }

    return originalFetch(input, init);
  };
}

function createJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
