import express from 'express';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { fixtureState, resetFixtureState, DEMO_FIXTURES } from './fixtures.js';

export function createDemoApp(): express.Express {
  const app = express();
  app.use(express.json());

  // robots.txt route
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(`
User-agent: ChangeWatch
Disallow: /demo/disallowed
Allow: /demo/
Allow: /robots-allowed/
    `.trim());
  });

  // Allowed origin demo robots.txt simulation
  app.get('/robots-allowed/page', (_req, res) => {
    res.send(`<!DOCTYPE html><html><body><h1>Allowed Origin Page</h1><p>Accessible by crawler.</p></body></html>`);
  });

  // 1. Stable page (Zero changes across runs)
  app.get('/demo/stable', (_req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><title>Stable Documentation</title></head>
      <body style="font-family:sans-serif; padding:40px; background:#f8fafc;">
        <h1 id="title">ChangeWatch Stable Documentation</h1>
        <p id="desc">This is an immutable public specification document. The content and text remain constant across checks.</p>
        <div id="footer">Copyright &copy; 2026 ChangeWatch Project.</div>
      </body>
      </html>
    `.trim());
  });

  // 2. Live clock (Timestamp noise filter test)
  app.get('/demo/clock', (_req, res) => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US');
    const dateStr = now.toISOString();
    res.send(`
      <!DOCTYPE html>
      <html><body>
        <h1>Server Status Board</h1>
        <p>System operational and functioning within normal parameters.</p>
        <p class="timestamp">Current Server Time: ${timeStr} (UTC: ${dateStr})</p>
        <p>Last heartbeat recorded 2 minutes ago.</p>
      </body></html>
    `.trim());
  });

  // 3. Visit counter (Counter noise filter test)
  app.get('/demo/counter', (_req, res) => {
    fixtureState.visitCount++;
    res.send(`
      <!DOCTYPE html>
      <html><body>
        <h1>Tech Articles Blog</h1>
        <p>Understanding Modern System Observability and Web Monitoring.</p>
        <div class="metrics">
          <span>Views: ${fixtureState.visitCount.toLocaleString()}</span> &bull;
          <span>1.2k likes</span> &bull;
          <span>Online now: ${Math.floor(Math.random() * 50) + 10}</span>
        </div>
      </body></html>
    `.trim());
  });

  // 4. Rotating banner / ad block (Ignore selector test)
  app.get('/demo/banner', (_req, res) => {
    const adId = Math.floor(Math.random() * 10000);
    res.send(`
      <!DOCTYPE html>
      <html><body>
        <div id="ad-banner" style="background:#fee2e2; padding:10px;">
          <strong>SPONSORED PROMOTION #${adId}:</strong> 50% discount on cloud hosting today only!
        </div>
        <main id="main-content">
          <h1 id="headline">${fixtureState.headlineText}</h1>
          <p>This core editorial analysis remains constant, while the ad banner rotates dynamic offers.</p>
        </main>
      </body></html>
    `.trim());
  });

  // 5. Random token / nonce (Token noise filter test)
  app.get('/demo/token', (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csrfToken = crypto.randomUUID();
    res.send(`
      <!DOCTYPE html>
      <html><body>
        <h1>Authentication Gate</h1>
        <p>Public security announcement regarding token rotation policies.</p>
        <input type="hidden" name="csrf_token" value="${csrfToken}" />
        <p class="token-debug">Session nonce: ${nonce}</p>
      </body></html>
    `.trim());
  });

  // 6. Real headline change (Meaningful change detection test)
  app.get('/demo/headline', (_req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><body>
        <h1 id="headline">${fixtureState.headlineText}</h1>
        <p id="summary">Global market indices reflected substantial optimism throughout today's trading session.</p>
      </body></html>
    `.trim());
  });

  // 7. Price change (Numeric monitoring test)
  app.get('/demo/price', (_req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><body>
        <h1 id="product-name">Developer Ergonomic Mechanical Keyboard</h1>
        <div id="price-container">Price: $${fixtureState.priceValue.toFixed(2)} USD</div>
        <p>In stock and ready to ship within 24 hours.</p>
      </body></html>
    `.trim());
  });

  // 8. HTTP 503 (Outage classification test)
  app.get('/demo/503', (_req, res) => {
    res.status(503).send(`
      <!DOCTYPE html>
      <html><body>
        <h1>503 Service Unavailable</h1>
        <p>The backend upstream servers are temporarily undergoing scheduled maintenance.</p>
      </body></html>
    `.trim());
  });

  // 9. Fake CAPTCHA page (BLOCKED classification test)
  app.get('/demo/captcha', (_req, res) => {
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Just a moment...</title></head>
      <body>
        <h1>Verify you are human</h1>
        <p>Please complete the security check to access example.com</p>
        <div class="g-recaptcha" data-sitekey="6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"></div>
      </body>
      </html>
    `.trim());
  });

  // 10. HTTP 429 with Retry-After (Backoff test)
  app.get('/demo/rate-limit', (_req, res) => {
    res.status(429).setHeader('Retry-After', '60').send(`
      <!DOCTYPE html>
      <html><body>
        <h1>429 Too Many Requests</h1>
        <p>You have exceeded your request quota. Please wait before retrying.</p>
      </body></html>
    `.trim());
  });

  // 11. Slow page (Timeout test)
  app.get('/demo/slow', async (_req, res) => {
    // Hangs for 35 seconds (exceeding standard 30s timeout)
    await new Promise(resolve => setTimeout(resolve, 35000));
    res.send(`<!DOCTYPE html><html><body><h1>Slow Page Finished</h1></body></html>`);
  });

  // 12. Flip-flop (Confirmation discarding blip test)
  app.get('/demo/flip-flop', (_req, res) => {
    fixtureState.flipFlopState = !fixtureState.flipFlopState;
    const stateName = fixtureState.flipFlopState ? 'State Alpha' : 'State Beta';
    res.send(`
      <!DOCTYPE html>
      <html><body>
        <h1>Intermittent Flip Flop Page</h1>
        <p>Current active state: <strong>${stateName}</strong></p>
      </body></html>
    `.trim());
  });

  // 13. Always-different page (Noisy flag / cooldown test)
  app.get('/demo/always-changing', (_req, res) => {
    const randomContent = crypto.randomBytes(32).toString('hex');
    res.send(`
      <!DOCTYPE html>
      <html><body>
        <h1>Volatile Feed</h1>
        <p>Random unique content on every load: ${randomContent}</p>
      </body></html>
    `.trim());
  });

  // 14. Robots.txt disallowed page
  app.get('/demo/disallowed', (_req, res) => {
    res.send(`<!DOCTYPE html><html><body><h1>Disallowed Secret Page</h1><p>Robots.txt forbids crawling here.</p></body></html>`);
  });

  // 15. Redirect to private IP (SSRF redirect re-validation test)
  app.get('/demo/redirect-private', (_req, res) => {
    res.redirect(302, 'http://169.254.169.254/latest/meta-data/');
  });

  // 16. Empty body / tiny content (Empty content error test)
  app.get('/demo/empty', (_req, res) => {
    res.send(`<html><body>   </body></html>`);
  });

  // Control APIs for Test Rig & automated testing
  app.get('/demo/fixtures', (_req, res) => {
    res.json({ fixtures: DEMO_FIXTURES, state: fixtureState });
  });

  app.post('/demo/set-headline', (req, res) => {
    const text = req.body?.text || (req.query?.text as string);
    if (text) {
      fixtureState.headlineText = String(text);
    }
    res.json({ ok: true, headline: fixtureState.headlineText });
  });

  app.post('/demo/set-price', (req, res) => {
    const val = parseFloat(req.body?.value || req.query?.value);
    if (!isNaN(val)) {
      fixtureState.priceValue = val;
    }
    res.json({ ok: true, price: fixtureState.priceValue });
  });

  app.post('/demo/reset', (_req, res) => {
    resetFixtureState();
    res.json({ ok: true, state: fixtureState });
  });

  return app;
}

export function startDemoServer(port = 4000): Promise<Server> {
  const app = createDemoApp();
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`[DemoServer] 16 Fixtures listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}
