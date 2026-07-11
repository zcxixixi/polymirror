import { beforeEach, describe, expect, it, vi } from "vitest";
import { assessLiquidationEquity } from "../src/engine/liquidation-equity.js";
import { fetchExecutableOrderBookSnapshot } from "../src/executor/orderbook.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

vi.mock("../src/executor/orderbook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/executor/orderbook.js")>()),
  fetchExecutableOrderBookSnapshot: vi.fn(),
}));

const mockFetchSnapshot = vi.mocked(fetchExecutableOrderBookSnapshot);

function config200() {
  const config = previewRuntimeConfig();
  config.app.global.risk.startingCapitalUsd = 200;
  return config;
}

function mockStore(
  cashUsd: number,
  positions: Array<{
    leaderId: string;
    tokenId: string;
    shares: number;
    avgEntryPrice: number;
  }>
) {
  return {
    readCashBalance: vi.fn().mockReturnValue(cashUsd),
    listPositions: vi.fn().mockReturnValue(positions),
  };
}

function snapshot(
  levels: Array<{ price: string; size: string }>,
  feeRate = 0,
  feeExponent = 0
) {
  return {
    levels,
    tickSize: 0.01,
    minOrderShares: 1,
    feeRate,
    feeExponent,
  };
}

describe("assessLiquidationEquity", () => {
  beforeEach(() => {
    mockFetchSnapshot.mockReset();
  });

  it("aggregates positions by token and values complete SELL depth at weighted price", async () => {
    const store = mockStore(197.9, [
      { leaderId: "a", tokenId: "token-a", shares: 2, avgEntryPrice: 0.4 },
      { leaderId: "b", tokenId: "token-a", shares: 3, avgEntryPrice: 0.6 },
    ]);
    mockFetchSnapshot.mockResolvedValue(
      snapshot([
        { price: "0.40", size: "4" },
        { price: "0.50", size: "1" },
      ])
    );

    await expect(assessLiquidationEquity(config200(), store as never)).resolves.toEqual({
      cashUsd: 197.9,
      liquidationValueUsd: 2.1,
      equityUsd: 200,
      openCostUsd: 2.6,
      quoteCoverage: 1,
      missingTokenIds: [],
      drawdownPct: 0,
      peakEquityUsd: 200,
    });
    expect(mockFetchSnapshot).toHaveBeenCalledTimes(1);
    expect(mockFetchSnapshot).toHaveBeenCalledWith(
      config200().wallet.clobUrl,
      config200().wallet.chainId,
      "token-a",
      "SELL"
    );
  });

  it("values only executable shares when SELL depth is partial", async () => {
    const store = mockStore(150, [
      { leaderId: "a", tokenId: "token-a", shares: 10, avgEntryPrice: 0.5 },
    ]);
    mockFetchSnapshot.mockResolvedValue(
      snapshot([
        { price: "0.30", size: "1" },
        { price: "0.40", size: "4" },
      ])
    );

    const result = await assessLiquidationEquity(config200(), store as never);

    expect(result).toMatchObject({
      cashUsd: 150,
      liquidationValueUsd: 1.9,
      equityUsd: 151.9,
      openCostUsd: 5,
      quoteCoverage: 0.5,
      missingTokenIds: ["token-a"],
      peakEquityUsd: 200,
    });
    expect(result.drawdownPct).toBeCloseTo(24.05, 8);
  });

  it("values a position at zero when no executable quote is available", async () => {
    const store = mockStore(190, [
      { leaderId: "a", tokenId: "token-missing", shares: 10, avgEntryPrice: 0.5 },
    ]);
    mockFetchSnapshot.mockResolvedValue(null);

    await expect(assessLiquidationEquity(config200(), store as never)).resolves.toEqual({
      cashUsd: 190,
      liquidationValueUsd: 0,
      equityUsd: 190,
      openCostUsd: 5,
      quoteCoverage: 0,
      missingTokenIds: ["token-missing"],
      drawdownPct: 5,
      peakEquityUsd: 200,
    });
  });

  it("subtracts the existing platform fee formula from executable proceeds", async () => {
    const store = mockStore(0, [
      { leaderId: "a", tokenId: "token-fee", shares: 10, avgEntryPrice: 0.5 },
    ]);
    mockFetchSnapshot.mockResolvedValue(
      snapshot([{ price: "0.50", size: "10" }], 0.25, 2)
    );

    const result = await assessLiquidationEquity(config200(), store as never);

    expect(result.liquidationValueUsd).toBe(4.84375);
    expect(result.equityUsd).toBe(4.84375);
    expect(result.quoteCoverage).toBe(1);
  });

  it("calculates high-water drawdown against a 200U peak", async () => {
    const store = mockStore(180, []);

    await expect(assessLiquidationEquity(config200(), store as never, 200)).resolves.toEqual({
      cashUsd: 180,
      liquidationValueUsd: 0,
      equityUsd: 180,
      openCostUsd: 0,
      quoteCoverage: 1,
      missingTokenIds: [],
      drawdownPct: 10,
      peakEquityUsd: 200,
    });
    expect(mockFetchSnapshot).not.toHaveBeenCalled();
  });
});
