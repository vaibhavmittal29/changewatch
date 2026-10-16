export interface DemoFixtureState {
  headlineText: string;
  priceValue: number;
  visitCount: number;
  flipFlopState: boolean;
}

export const fixtureState: DemoFixtureState = {
  headlineText: 'Breaking News: Markets Reach Historic All-Time Highs',
  priceValue: 99.99,
  visitCount: 1420,
  flipFlopState: false,
};

export function resetFixtureState(): void {
  fixtureState.headlineText = 'Breaking News: Markets Reach Historic All-Time Highs';
  fixtureState.priceValue = 99.99;
  fixtureState.visitCount = 1420;
  fixtureState.flipFlopState = false;
}

export interface CanonicalFixture {
  id: number;
  name: string;
  path: string;
  description: string;
}

export const CANONICAL_FIXTURES: CanonicalFixture[] = [
  { id: 1, name: 'Stable Page', path: '/demo/stable', description: 'Zero versions across multiple runs' },
  { id: 2, name: 'Live Clock', path: '/demo/clock', description: 'Timestamp noise filter test' },
  { id: 3, name: 'Visit Counter', path: '/demo/counter', description: 'Counter noise filter test' },
  { id: 4, name: 'Rotating Banner', path: '/demo/banner', description: 'Ignore selectors test' },
  { id: 5, name: 'Random Nonce/Token', path: '/demo/token', description: 'Token noise filter test' },
  { id: 6, name: 'Headline Change', path: '/demo/headline', description: 'Meaningful change -> new version' },
  { id: 7, name: 'Price Change', path: '/demo/price', description: 'Numeric change tracking' },
  { id: 8, name: 'HTTP 503 Outage', path: '/demo/503', description: 'ERROR outcome, baseline untouched' },
  { id: 9, name: 'Fake CAPTCHA Page', path: '/demo/captcha', description: 'BLOCKED outcome, baseline untouched' },
  { id: 10, name: '429 Rate Limited', path: '/demo/rate-limit', description: 'HTTP 429 Too Many Requests rate limit test' },
  { id: 11, name: 'Slow Page', path: '/demo/slow', description: 'Slow page exceeding timeout test' },
  { id: 12, name: 'Flip Flop Page', path: '/demo/flip-flop', description: 'Confirmation discards one-off blip' },
  { id: 13, name: 'Always Changing Page', path: '/demo/always-changing', description: 'Noisy flag and cooldown test' },
  { id: 14, name: 'Robots Disallowed', path: '/demo/disallowed', description: 'Origin-scoped robots disallow' },
  { id: 15, name: 'Redirect to Private IP', path: '/demo/redirect-private', description: 'SSRF redirect defense test' },
  { id: 16, name: 'Empty Content', path: '/demo/empty', description: 'Empty or tiny content classification' },
];

export const DEMO_FIXTURES = CANONICAL_FIXTURES;
