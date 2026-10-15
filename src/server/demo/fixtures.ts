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

export const DEMO_FIXTURES = [
  { id: 1, name: 'Stable Page', path: '/demo/stable' },
  { id: 2, name: 'Live Clock', path: '/demo/clock' },
  { id: 3, name: 'Visit Counter', path: '/demo/counter' },
  { id: 4, name: 'Rotating Banner', path: '/demo/banner' },
  { id: 5, name: 'Random Nonce/Token', path: '/demo/token' },
  { id: 6, name: 'Headline Change', path: '/demo/headline' },
  { id: 7, name: 'Price Change', path: '/demo/price' },
  { id: 8, name: 'HTTP 503 Outage', path: '/demo/503' },
  { id: 9, name: 'Fake CAPTCHA Page', path: '/demo/captcha' },
  { id: 10, name: '429 Rate Limited', path: '/demo/rate-limit' },
  { id: 11, name: 'Slow Page', path: '/demo/slow' },
  { id: 12, name: 'Flip Flop Page', path: '/demo/flip-flop' },
  { id: 13, name: 'Always Changing Page', path: '/demo/always-changing' },
  { id: 14, name: 'Robots Disallowed', path: '/demo/disallowed' },
  { id: 15, name: 'Redirect to Private IP', path: '/demo/redirect-private' },
  { id: 16, name: 'Empty Content', path: '/demo/empty' },
];
