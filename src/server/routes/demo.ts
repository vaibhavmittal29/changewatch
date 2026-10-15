import { Router } from 'express';
import { env } from '../config.js';
import { fixtureState, resetFixtureState } from '../demo/fixtures.js';

export const demoRouter = Router();

const FIXTURES = [
  { id: 1, route: '/demo/stable', name: 'Stable Page', description: 'Zero versions across 5 runs' },
  { id: 2, route: '/demo/clock', name: 'Live Clock', description: 'Timestamp noise filter test' },
  { id: 3, route: '/demo/counter', name: 'Visit Counter', description: 'Counter noise filter test' },
  { id: 4, route: '/demo/banner', name: 'Rotating Ad Banner', description: 'Ignore selectors test' },
  { id: 5, route: '/demo/token', name: 'Random Token / Nonce', description: 'Token noise filter test' },
  { id: 6, route: '/demo/headline', name: 'Real Headline Change', description: 'Meaningful change -> new version' },
  { id: 7, route: '/demo/price', name: 'Price Change', description: 'Numeric change tracking' },
  { id: 8, route: '/demo/503', name: 'HTTP 503 Service Unavailable', description: 'ERROR outcome, baseline untouched' },
  { id: 9, route: '/demo/captcha', name: 'Fake CAPTCHA Challenge', description: 'BLOCKED outcome, baseline untouched' },
  { id: 10, route: '/demo/429', name: 'HTTP 429 Too Many Requests', description: 'Rate limit backoff test' },
  { id: 11, route: '/demo/slow', name: 'Slow Page (> timeout)', description: 'Timeout and retry test' },
  { id: 12, route: '/demo/flip-flop', name: 'Flip-Flop (Reverts back)', description: 'Confirmation discards one-off blip' },
  { id: 13, route: '/demo/always-different', name: 'Always Different', description: 'Noisy flag and cooldown test' },
  { id: 14, route: '/demo/disallowed', name: 'Robots.txt Disallowed', description: 'Origin-scoped robots disallow' },
  { id: 15, route: '/demo/redirect-private', name: 'SSRF Private IP Redirect', description: 'SSRF redirect defense test' },
  { id: 16, route: '/demo/empty', name: 'Empty / Tiny Content', description: 'empty_content classification' },
];

demoRouter.use((_req, res, next) => {
  if (!env.ALLOW_LOCAL_DEMO) {
    res.status(403).json({ error: 'Demo control is only enabled when ALLOW_LOCAL_DEMO=true' });
    return;
  }
  next();
});

// GET /api/demo/fixtures
demoRouter.get('/fixtures', (_req, res) => {
  res.json({
    fixtures: FIXTURES.map(f => ({
      ...f,
      url: `http://localhost:${env.DEMO_PORT}${f.route}`,
    })),
    state: fixtureState,
  });
});

// POST /api/demo/fixtures/:name
demoRouter.post('/fixtures/:name', (req, res) => {
  const { name } = req.params;
  const { value, headline, price } = req.body;

  if (name === 'reset') {
    resetFixtureState();
    res.json({ ok: true, state: fixtureState });
    return;
  }

  if (name === 'headline') {
    if (typeof headline === 'string' && headline.trim()) {
      fixtureState.headlineText = headline.trim();
    } else if (typeof value === 'string' && value.trim()) {
      fixtureState.headlineText = value.trim();
    }
  } else if (name === 'price') {
    const num = Number(price ?? value);
    if (!Number.isNaN(num)) {
      fixtureState.priceValue = num;
    }
  } else if (name === 'flip-flop') {
    fixtureState.flipFlopState = !fixtureState.flipFlopState;
  }

  res.json({ ok: true, state: fixtureState });
});
