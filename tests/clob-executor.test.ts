import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClobExecutor, isDefiniteOrderRejection } from "../src/executor/clob.js";
import type { GlobalConfig, WalletConfig } from "../src/config/types.js";

const mockSubmitOrder = vi.fn();
const mockGetOrderStatus = vi.fn();
const mockListOpenOrders = vi.fn(async () => []);

vi.mock("../src/executor/orderbook.js", () => ({
  fetchOrderBookMeta: vi.fn(async () => ({ tickSize: "0.01", negRisk: false })),
  roundToTick: (value: number, tickSize: number) =>
    parseFloat((Math.round(value / tickSize) * tickSize).toFixed(2)),
  toOrderType: vi.fn(() => "GTC"),
}));

vi.mock("../src/executor/trading-backend.js", () => ({
	  createTradingBackend: vi.fn(() => ({
	    kind: "secure",
	    submitOrder: mockSubmitOrder,
	    getOrderStatus: mockGetOrderStatus,
	    cancelOrder: vi.fn(),
	    listOpenOrders: mockListOpenOrders,
	  })),
	}));

const wallet: WalletConfig = {
  privateKey: "0x" + "1".repeat(64),
  proxyAddress: "0x" + "2".repeat(40),
  signatureType: 0,
  chainId: 137,
  clobUrl: "https://clob.polymarket.com",
  dataApiUrl: "https://data-api.polymarket.com",
  tradingBackend: "secure",
};

const global: GlobalConfig = {
  previewMode: false,
  pollIntervalMs: 5000,
  activityLimit: 100,
  copyTradesOnly: true,
  maxTradeAgeHours: 1,
  buyDedupWindowMs: 60_000,
  tradeAggregationWindowMs: 0,
  healthPort: 0,
  risk: {
    enableCopyTrading: true,
    dailyLossCapPct: 20,
    startingCapitalUsd: 500,
    maxDailyVolumeUsd: 500,
    maxOpenMarkets: 15,
    maxOrderUsd: 25,
    minOrderUsd: 1,
    slippageTolerance: 0,
    maxPositionPerTokenUsd: 0,
    syncWalletBalance: false,
  },
  execution: {
    orderType: "GTC",
    retryLimit: 0,
    networkRetryLimit: 0,
    gtcFillTimeoutMs: 0,
    pendingOrderMaxAgeHours: 48,
    autoRedeemOnChain: true,
  },
  conflict: { mode: "priority_leader", priority: [] },
  notify: {
    telegramOnCopy: false,
    telegramOnError: false,
    telegramOnKillSwitch: false,
  },
};

describe("ClobExecutor", () => {
  beforeEach(() => {
    mockSubmitOrder.mockReset();
    mockGetOrderStatus.mockReset();
    mockListOpenOrders.mockReset();
    mockListOpenOrders.mockResolvedValue([]);
  });

  it("returns the tick-rounded execution price when CLOB rejects the order", async () => {
    mockSubmitOrder.mockResolvedValueOnce({
      raw: { ok: false, message: "not enough balance / allowance" },
      error: "not enough balance / allowance",
    });

    const result = await new ClobExecutor(wallet, global).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.124,
      size: 8.34,
    });

    expect(result.error).toContain("not enough balance");
    expect(result.executionPrice).toBe(0.12);
    expect(result.filledShares).toBe(0);
  });

  it("does not resubmit when submit throws and no matching open order can be recovered", async () => {
    mockSubmitOrder.mockRejectedValueOnce(new Error("network timeout"));
    const retryingGlobal: GlobalConfig = {
      ...global,
      execution: { ...global.execution, retryLimit: 3 },
    };

    const result = await new ClobExecutor(wallet, retryingGlobal).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.5,
      size: 2,
    });

    expect(mockSubmitOrder).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("uncertain outcome");
    expect(isDefiniteOrderRejection(result.error!)).toBe(false);
  });

  it("recovers matching open orders after a submit exception", async () => {
    mockSubmitOrder.mockRejectedValueOnce(new Error("network timeout"));
    mockListOpenOrders.mockResolvedValueOnce([
      {
        orderId: "ord-recovered",
        tokenId: "token-abc",
        side: "BUY",
        price: 0.5,
        size: 2,
      },
    ]);
    mockGetOrderStatus.mockResolvedValueOnce({
      kind: "ok",
      status: {
        sizeMatched: 0.5,
        originalSize: 2,
        status: "LIVE",
        terminal: false,
      },
    });
    const retryingGlobal: GlobalConfig = {
      ...global,
      execution: { ...global.execution, retryLimit: 3 },
    };

    const result = await new ClobExecutor(wallet, retryingGlobal).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.5,
      size: 2,
    });

    expect(mockSubmitOrder).toHaveBeenCalledTimes(1);
    expect(result.orderId).toBe("ord-recovered");
    expect(result.pendingRemaining).toBe(1.5);
  });
});
