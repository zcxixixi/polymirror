import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state/store.js";
import { runCopyCycle } from "../src/engine/copy-cycle.js";
import type { RuntimeConfig } from "../src/config/types.js";
import { pollLeaders } from "../src/monitor/poll.js";
import { tradeEventKey } from "../src/monitor/data-api.js";
import { testActivity, testLeader } from "./helpers/fixtures.js";

vi.mock("../src/monitor/data-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/monitor/data-api.js")>();
  return {
    ...actual,
    getActivity: vi.fn(async () => []),
  };
});

vi.mock("../src/monitor/poll.js", () => ({
  pollLeaders: vi.fn(async () => []),
}));

const mockGetOrderStatus = vi.fn();
const mockCancelOrder = vi.fn();
const mockListOpenOrders = vi.fn(async () => []);
const mockPlaceLimitOrder = vi.fn();

vi.mock("../src/executor/clob.js", () => ({
  ClobExecutor: class {
    getOrderStatus = mockGetOrderStatus;
    cancelOrder = mockCancelOrder;
    listOpenOrders = mockListOpenOrders;
    placeLimitOrder = mockPlaceLimitOrder;
    recoverOrderAfterFailure = vi.fn(async () => null);
  },
  isDefiniteOrderRejection: () => false,
}));

vi.mock("../src/executor/orderbook.js", () => ({
  fetchBestExecutablePrice: vi.fn(async () => 0.5),
}));

vi.mock("../src/executor/geoblock.js", () => ({
  getCachedGeoblockStatus: vi.fn(async () => null),
  formatGeoblockMessage: vi.fn(() => "geoblocked"),
}));

vi.mock("../src/executor/balance.js", () => ({
  checkWalletDrifts: vi.fn(async () => []),
  fetchWalletTokenBalance: vi.fn(async () => null),
  fetchWalletCollateralUsdc: vi.fn(async () => 500),
  fetchWalletCollateral: vi.fn(async () => ({
    clobUsd: 500,
    clobAllowanceUsd: 500,
    chainUsd: 0,
  })),
  checkLiveBuyCollateralAndAllowance: vi.fn(() => ({ allow: true })),
  checkLiveSellTokenAllowance: vi.fn(async () => ({ allow: true })),
  canTradeWithChainFallback: vi.fn(() => false),
  proportionalSellable: vi.fn((held: number) => held),
}));

vi.mock("../src/executor/redeem.js", () => ({
  listRedeemablePositions: vi.fn(async () => []),
  redeemConditionOnChain: vi.fn(async () => ({ ok: true, txHash: "0xredeem" })),
}));

vi.mock("../src/util/fetch.js", () => ({
  fetchJsonWithRetry: vi.fn(async () => []),
}));

let dir: string;
let store: StateStore;
const mockPollLeaders = vi.mocked(pollLeaders);

function liveConfig(enableCopy: boolean): RuntimeConfig {
  return {
    wallet: {
      privateKey: "0x" + "1".repeat(64),
      proxyAddress: "0x" + "2".repeat(40),
      clobUrl: "https://clob.polymarket.com",
      chainId: 137,
      dataApiUrl: "https://data-api.polymarket.com",
      signatureType: 0,
      tradingBackend: "secure",
    },
    app: {
      global: {
        previewMode: false,
        pollIntervalMs: 5000,
        activityLimit: 100,
        copyTradesOnly: true,
        maxTradeAgeHours: 1,
        buyDedupWindowMs: 60_000,
        tradeAggregationWindowMs: 0,
        healthPort: 8080,
        risk: {
          enableCopyTrading: enableCopy,
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
          gtcFillTimeoutMs: 10_000,
          pendingOrderMaxAgeHours: 48,
          autoRedeemOnChain: true,
        },
        conflict: { mode: "priority_leader", priority: [] },
        notify: {
          telegramOnCopy: false,
          telegramOnError: false,
          telegramOnKillSwitch: false,
        },
      },
      leaders: [testLeader()],
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-cycle-"));
  store = new StateStore(join(dir, "test.db"));
  mockGetOrderStatus.mockReset();
  mockCancelOrder.mockReset();
  mockListOpenOrders.mockReset();
  mockPlaceLimitOrder.mockReset();
  mockPollLeaders.mockReset();
  mockListOpenOrders.mockResolvedValue([]);
  mockCancelOrder.mockResolvedValue({ ok: true });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("runCopyCycle pending reconciliation", () => {
  it("reconciles pending even when copy trading is disabled", async () => {
    store.upsertPendingOrder({
      orderId: "ord-live-1",
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      tradeKey: "k1",
      reasoning: "10%",
    });
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 10,
        originalSize: 10,
        status: "MATCHED",
        terminal: true,
      },
    });

    const result = await runCopyCycle(liveConfig(false), store);
    expect(result.pendingFilled).toBe(1);
    expect(result.copied).toBe(0);
    expect(store.countPendingOrders()).toBe(0);
    expect(result.errors.some((e) => e.includes("copy trading disabled"))).toBe(true);
  });

  it("records a live order intent before submitting to CLOB", async () => {
    const activity = testActivity({
      transactionHash: "0xliveintent",
      asset: "tok-live-intent",
      side: "BUY",
      size: 100,
      price: 0.5,
    });
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [activity] },
    ]);
    mockPlaceLimitOrder.mockResolvedValue({
      preview: false,
      error: "network timeout",
      filledShares: 0,
      filledUsd: 0,
      pendingRemaining: 0,
    });

    const result = await runCopyCycle(liveConfig(true), store);

    expect(result.copied).toBe(0);
    expect(result.errors.some((e) => e.includes("network timeout"))).toBe(true);
    const [intent] = store.listLiveOrderIntents();
    expect(intent?.leaderId).toBe("whale");
    expect(intent?.tradeKeys).toEqual([tradeEventKey(activity)]);
    expect(mockPlaceLimitOrder).toHaveBeenCalledTimes(1);
  });

  it("records the filled portion when CLOB reports a partial fill error without order id", async () => {
    const activity = testActivity({
      transactionHash: "0xpartialfill",
      asset: "tok-partial-fill",
      side: "BUY",
      size: 100,
      price: 0.5,
    });
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [activity] },
    ]);
    mockPlaceLimitOrder.mockResolvedValue({
      preview: false,
      error: "Partial fill without order ID - cannot track remaining GTC",
      filledShares: 4,
      filledUsd: 2,
      orderStatus: "matched",
      pendingRemaining: 0,
    });

    const result = await runCopyCycle(liveConfig(true), store);

    expect(result.copied).toBe(1);
    expect(result.errors).toEqual([]);
    expect(store.getPosition("whale", activity.asset!)).toBe(4);
    expect(store.hasSeen(tradeEventKey(activity))).toBe(true);
    expect(store.countPendingOrders()).toBe(0);
    expect(store.listLiveOrderIntents()).toEqual([]);
    expect(
      store
        .listAuditLog({ action: "ERROR" })
        .items.some((row) => row.reason?.includes("filled portion will be recorded"))
    ).toBe(true);
  });

  it("records live fills with the executor execution price instead of the leader quote", async () => {
    const activity = testActivity({
      transactionHash: "0xexecutionprice",
      asset: "tok-execution-price",
      side: "BUY",
      size: 100,
      price: 0.5,
    });
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [activity] },
    ]);
    mockPlaceLimitOrder.mockResolvedValue({
      preview: false,
      orderId: "ord-execution-price",
      filledShares: 2,
      filledUsd: 1.02,
      executionPrice: 0.51,
      orderStatus: "matched",
      pendingRemaining: 0,
    });

    const result = await runCopyCycle(liveConfig(true), store);

    expect(result.copied).toBe(1);
    expect(store.getPositionCostUsd("whale", activity.asset!)).toBeCloseTo(1.02);
    const [copy] = store.listAuditLog({ action: "COPY" }).items;
    expect(copy?.price).toBe(0.51);
  });
});
