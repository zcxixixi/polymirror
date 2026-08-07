import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GlobalConfig, WalletConfig } from "../src/config/types.js";
import { ClobExecutor } from "../src/executor/clob.js";
import type { TradingBackend } from "../src/executor/trading-backend.js";

vi.mock("../src/executor/orderbook.js", () => ({
  fetchOrderBookMeta: vi.fn(async () => ({
    tickSize: "0.01",
    negRisk: false,
  })),
  roundToTick: (price: number) => Math.round(price * 100) / 100,
  toOrderType: () => "GTC",
  fetchBestExecutablePrice: vi.fn(),
}));

vi.mock("../src/executor/trading-backend.js", () => ({
  createTradingBackend: vi.fn(),
}));

import { createTradingBackend } from "../src/executor/trading-backend.js";

const wallet: WalletConfig = {
  privateKey: "0x" + "1".repeat(64),
  proxyAddress: "0x" + "2".repeat(40),
  signatureType: 0,
  chainId: 137,
  clobUrl: "https://clob.polymarket.com",
  dataApiUrl: "https://data-api.polymarket.com",
  tradingBackend: "secure",
  builderCode: "0x" + "9".repeat(64),
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
    slippageTolerance: 0.03,
    maxPositionPerTokenUsd: 0,
    syncWalletBalance: false,
  },
  execution: {
    orderType: "GTC",
    retryLimit: 3,
    networkRetryLimit: 3,
    gtcFillTimeoutMs: 0,
    pendingOrderMaxAgeHours: 48,
    autoRedeemOnChain: true,
    sellSizing: "position_fraction",
  },
  conflict: { mode: "priority_leader", priority: [] },
  notify: {
    telegramOnCopy: false,
    telegramOnError: false,
    telegramOnKillSwitch: false,
  },
  proxy: { mode: "none", staticUrl: "", dynamicUrl: "", dynamicRotateSession: true },
};

describe("ambiguous submit safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not re-submit after a thrown error when recovery finds nothing", async () => {
    const submitOrder = vi.fn().mockRejectedValue(new Error("network timeout"));
    const backend: TradingBackend = {
      kind: "secure",
      submitOrder,
      getOrderStatus: vi.fn(),
      cancelOrder: vi.fn(),
      listOpenOrders: vi.fn().mockResolvedValue([]),
      findRecentMatchingFill: vi.fn().mockResolvedValue(null),
    };
    vi.mocked(createTradingBackend).mockReturnValue(backend);

    const executor = new ClobExecutor(wallet, global);
    const result = await executor.placeLimitOrder({
      tokenId: "tok-" + "a".repeat(40),
      side: "BUY",
      price: 0.5,
      size: 10,
    });

    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(result.error).toMatch(/Ambiguous order submit failure/);
    expect(result.filledShares).toBe(0);
  });

  it("records immediate partial fill without order id (no error)", async () => {
    const backend: TradingBackend = {
      kind: "secure",
      submitOrder: vi.fn().mockResolvedValue({
        raw: { success: true },
        takingAmount: "4",
        makingAmount: "2",
        status: "matched",
      }),
      getOrderStatus: vi.fn(),
      cancelOrder: vi.fn(),
      listOpenOrders: vi.fn().mockResolvedValue([]),
      findRecentMatchingFill: vi.fn().mockResolvedValue(null),
    };
    vi.mocked(createTradingBackend).mockReturnValue(backend);

    const executor = new ClobExecutor(wallet, global);
    const result = await executor.placeLimitOrder({
      tokenId: "tok-" + "b".repeat(40),
      side: "BUY",
      price: 0.5,
      size: 10,
    });

    expect(result.error).toBeUndefined();
    expect(result.filledShares).toBe(4);
    expect(result.pendingRemaining).toBe(0);
    expect(result.orderStatus).toMatch(/remainder untracked|matched/);
  });

  it("recovers via recent trade fill after throw", async () => {
    const submitOrder = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const backend: TradingBackend = {
      kind: "secure",
      submitOrder,
      getOrderStatus: vi.fn(),
      cancelOrder: vi.fn(),
      listOpenOrders: vi.fn().mockResolvedValue([]),
      findRecentMatchingFill: vi.fn().mockResolvedValue({
        orderId: "0xrecovered",
        filledShares: 10,
        filledUsd: 5,
        price: 0.5,
        status: "CONFIRMED",
      }),
    };
    vi.mocked(createTradingBackend).mockReturnValue(backend);

    const executor = new ClobExecutor(wallet, global);
    const result = await executor.placeLimitOrder({
      tokenId: "tok-" + "c".repeat(40),
      side: "BUY",
      price: 0.5,
      size: 10,
    });

    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(result.error).toBeUndefined();
    expect(result.orderId).toBe("0xrecovered");
    expect(result.filledShares).toBe(10);
  });
});
