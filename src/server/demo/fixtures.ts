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
