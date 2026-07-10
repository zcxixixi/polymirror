import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClobExecutor, isDefiniteOrderRejection } from "../src/executor/clob.js";
import { fetchOrderBookMeta } from "../src/executor/orderbook.js";
import type { GlobalConfig, WalletConfig } from "../src/config/types.js";

const mockSubmitOrder = vi.fn();
const mockGetOrderStatus = vi.fn();
const mockListOpenOrders = vi.fn(async () => []);
const mockListRecentCompletedFills = vi.fn(async () => []);

vi.mock("../src/executor/orderbook.js", () => ({
  fetchOrderBookMeta: vi.fn(),
  roundToTick: (value: number, tickSize: number) =>
    parseFloat((Math.round(value / tickSize) * tickSize).toFixed(2)),
  toOrderType: vi.fn((type: string) => type),
}));

vi.mock("../src/executor/trading-backend.js", () => ({
	  createTradingBackend: vi.fn(() => ({
	    kind: "secure",
	    submitOrder: mockSubmitOrder,
	    getOrderStatus: mockGetOrderStatus,
	    cancelOrder: vi.fn(),
	    listOpenOrders: mockListOpenOrders,
	    listRecentCompletedFills: mockListRecentCompletedFills,
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

const mockFetchOrderBookMeta = vi.mocked(fetchOrderBookMeta);

describe("ClobExecutor", () => {
  beforeEach(() => {
    mockSubmitOrder.mockReset();
    mockGetOrderStatus.mockReset();
    mockListOpenOrders.mockReset();
    mockListOpenOrders.mockResolvedValue([]);
    mockListRecentCompletedFills.mockReset();
    mockListRecentCompletedFills.mockResolvedValue([]);
    mockFetchOrderBookMeta.mockReset();
    mockFetchOrderBookMeta.mockResolvedValue({ tickSize: "0.01", negRisk: false });
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
        filledUsd: 0.225,
        averagePrice: 0.45,
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
    expect(result.executionPrice).toBe(0.45);
    expect(result.filledUsd).toBe(0.225);
    expect(result.pendingRemaining).toBe(1.5);
  });

  it("rejects a guarded request if the market tick changed after quoting", async () => {
    const result = await new ClobExecutor(wallet, global).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.525,
      size: 1.91,
      expectedTickSize: 0.001,
    });

    expect(result.error).toMatch(/tick changed/);
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it("returns the actual FOK average fill price instead of the limit", async () => {
    mockFetchOrderBookMeta.mockResolvedValueOnce({
      tickSize: "0.01",
      negRisk: false,
      feeRate: 0.25,
      feeExponent: 2,
    });
    mockSubmitOrder.mockResolvedValueOnce({
      raw: { ok: true },
      orderId: "ord-fok",
      takingAmount: "2",
      makingAmount: "1",
      status: "matched",
    });
    mockGetOrderStatus.mockResolvedValueOnce({
      kind: "ok",
      status: {
        sizeMatched: 2,
        originalSize: 2,
        status: "CONFIRMED",
        terminal: true,
        filledUsd: 1,
        averagePrice: 0.5,
        feeUsd: 0.03125,
      },
    });
    const fokGlobal: GlobalConfig = {
      ...global,
      execution: { ...global.execution, orderType: "FOK" },
    };

    const result = await new ClobExecutor(wallet, fokGlobal).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.52,
      size: 1.93,
      expectedTickSize: 0.01,
    });

    expect(result).toMatchObject({
      executionPrice: 0.5,
      filledShares: 2,
      filledUsd: 1,
      feeUsd: 0.03125,
      pendingRemaining: 0,
    });
  });

  it("waits for confirmed trade evidence instead of booking matched response amounts", async () => {
    mockSubmitOrder.mockResolvedValueOnce({
      raw: { ok: true },
      orderId: "ord-confirm-later",
      takingAmount: "2",
      makingAmount: "1",
      status: "matched",
    });
    mockGetOrderStatus
      .mockResolvedValueOnce({
        kind: "ok",
        status: {
          sizeMatched: 0,
          originalSize: 2,
          status: "MATCHED",
          terminal: false,
        },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        status: {
          sizeMatched: 2,
          originalSize: 2,
          status: "CONFIRMED",
          terminal: true,
          filledUsd: 0.98,
          averagePrice: 0.49,
          feeUsd: 0.01,
        },
      });
    const fokGlobal: GlobalConfig = {
      ...global,
      execution: { ...global.execution, orderType: "FOK" },
    };

    const result = await new ClobExecutor(wallet, fokGlobal).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.52,
      size: 2,
      expectedTickSize: 0.01,
    });

    expect(mockGetOrderStatus).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      executionPrice: 0.49,
      filledShares: 2,
      filledUsd: 0.98,
      feeUsd: 0.01,
      pendingRemaining: 0,
    });
  });

  it("does not book matched response amounts when the order id is missing", async () => {
    mockSubmitOrder.mockResolvedValueOnce({
      raw: { ok: true },
      takingAmount: "2",
      makingAmount: "1",
      status: "matched",
    });
    const fokGlobal: GlobalConfig = {
      ...global,
      execution: { ...global.execution, orderType: "FOK" },
    };

    const result = await new ClobExecutor(wallet, fokGlobal).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.52,
      size: 2,
      expectedTickSize: 0.01,
    });

    expect(result).toMatchObject({
      filledShares: 0,
      filledUsd: 0,
      pendingRemaining: 0,
    });
    expect(result.error).toMatch(/confirmation.*order id/i);
  });

  it("returns an uncertain result while an accepted immediate order awaits confirmation", async () => {
    mockSubmitOrder.mockResolvedValueOnce({
      raw: { ok: true },
      orderId: "ord-await-confirmation",
      takingAmount: "2",
      makingAmount: "1",
      status: "matched",
    });
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 0,
        originalSize: 2,
        status: "MATCHED",
        terminal: false,
      },
    });
    const fokGlobal: GlobalConfig = {
      ...global,
      execution: { ...global.execution, orderType: "FOK" },
    };

    const result = await new ClobExecutor(wallet, fokGlobal).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.52,
      size: 2,
      expectedTickSize: 0.01,
    });

    expect(result).toMatchObject({
      orderId: "ord-await-confirmation",
      filledShares: 0,
      filledUsd: 0,
      pendingRemaining: 0,
    });
    expect(result.error).toMatch(/confirmation pending/i);
  });

  it("uses actual trade notional when an immediate fill must be polled", async () => {
    mockSubmitOrder.mockResolvedValueOnce({
      raw: { ok: true },
      orderId: "ord-polled",
      status: "matched",
    });
    mockGetOrderStatus.mockResolvedValueOnce({
      kind: "ok",
      status: {
        sizeMatched: 2,
        originalSize: 2,
        status: "CONFIRMED",
        terminal: true,
        filledUsd: 1,
        averagePrice: 0.5,
      },
    });
    const fokGlobal: GlobalConfig = {
      ...global,
      execution: { ...global.execution, orderType: "FOK" },
    };

    const result = await new ClobExecutor(wallet, fokGlobal).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.52,
      size: 2,
      expectedTickSize: 0.01,
    });

    expect(result).toMatchObject({
      executionPrice: 0.5,
      filledShares: 2,
      filledUsd: 1,
      pendingRemaining: 0,
    });
  });

  it("preserves sub-cent share precision for confirmed partial fills", async () => {
    mockSubmitOrder.mockResolvedValueOnce({
      raw: { ok: true },
      orderId: "ord-precise",
      status: "live",
    });
    mockGetOrderStatus.mockResolvedValueOnce({
      kind: "ok",
      status: {
        sizeMatched: 4.9475,
        originalSize: 10,
        status: "CONFIRMED",
        terminal: false,
        filledUsd: 2.47375,
        averagePrice: 0.5,
        feeUsd: 0,
      },
    });
    const pollingGlobal: GlobalConfig = {
      ...global,
      execution: { ...global.execution, gtcFillTimeoutMs: 1_000 },
    };

    const result = await new ClobExecutor(wallet, pollingGlobal).placeLimitOrder({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.5,
      size: 10,
    });

    expect(result.filledShares).toBe(4.9475);
    expect(result.pendingRemaining).toBe(5.0525);
    expect(result.filledUsd).toBe(2.47375);
  });

  it("reports completed fill lookup failures as transient", async () => {
    mockListRecentCompletedFills.mockRejectedValueOnce(new Error("CLOB unavailable"));

    const result = await new ClobExecutor(wallet, global).listRecentCompletedFills(
      Date.now() - 60_000
    );

    expect(result).toEqual({ kind: "transient", message: "CLOB unavailable" });
  });

  it("propagates open order lookup failures to recovery", async () => {
    mockListOpenOrders.mockRejectedValueOnce(new Error("open orders unavailable"));

    await expect(new ClobExecutor(wallet, global).listOpenOrders()).rejects.toThrow(
      "open orders unavailable"
    );
  });
});
