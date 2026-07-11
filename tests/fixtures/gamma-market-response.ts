export const gammaMarketResponseFixture = {
  id: "fixture-market-1",
  question: "Will the fixture outcome resolve to Yes?",
  conditionId: `0x${"1".repeat(64)}`,
  slug: "fixture-market",
  endDate: "2026-07-10T00:00:00.000Z",
  closed: true,
  marketMakerAddress: `0x${"2".repeat(40)}`,
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.98","0.02"]',
  clobTokenIds: '["123","456"]',
  umaResolutionStatus: "resolved",
  orderPriceMinTickSize: 0.01,
} as const;
