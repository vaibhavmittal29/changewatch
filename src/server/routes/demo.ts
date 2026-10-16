import { Router } from 'express';
import { env } from '../config.js';
import { fixtureState, resetFixtureState, CANONICAL_FIXTURES } from '../demo/fixtures.js';

export const demoRouter = Router();

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
    fixtures: CANONICAL_FIXTURES.map(f => ({
      ...f,
      route: f.path,
      url: `http://localhost:${env.DEMO_PORT}${f.path}`,
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
