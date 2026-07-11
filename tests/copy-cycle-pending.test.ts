import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
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
const { mockFetchExecutableOrderBookSnapshot } = vi.hoisted(() => ({
  mockFetchExecutableOrderBookSnapshot: vi.fn(async () => null),
}));

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

vi.mock("../src/executor/orderbook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/executor/orderbook.js")>();
  return {
    ...actual,
    fetchBestExecutablePrice: vi.fn(async () => 0.5),
    fetchExecutableOrderBookSnapshot: mockFetchExecutableOrderBookSnapshot,
  };
});

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
  mockFetchExecutableOrderBookSnapshot.mockReset();
  mockPollLeaders.mockReset();
  mockListOpenOrders.mockResolvedValue([]);
  mockCancelOrder.mockResolvedValue({ ok: true });
  mockFetchExecutableOrderBookSnapshot.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
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
      filledUsd: 0,
      leaderPrice: 0.5,
      executablePrice: 0.5,
      slippagePct: 0,
      tradeKey: "k1",
      reasoning: "10%",
    });
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 10,
        originalSize: 10,
        status: "CONFIRMED",
        terminal: true,
        filledUsd: 4.8,
        averagePrice: 0.48,
        feeUsd: 0.048,
      },
    });

    const result = await runCopyCycle(liveConfig(false), store);
    expect(result.pendingFilled).toBe(1);
    expect(result.copied).toBe(0);
    expect(store.countPendingOrders()).toBe(0);
    expect(store.getPositionCostUsd("whale", "tok-a")).toBe(4.848);
    expect(store.getDailyVolumeUsd()).toBe(4.8);
    expect(store.listAuditLog({ action: "COPY" }).items[0]).toMatchObject({
      price: 0.48,
      leaderPrice: 0.5,
      executablePrice: 0.48,
      slippagePct: 0,
      feeUsd: 0.048,
    });
    expect(result.errors.some((e) => e.includes("copy trading disabled"))).toBe(true);
  });

  it("keeps the final one percent of a confirmed partial order pending", async () => {
    store.upsertPendingOrder({
      orderId: "ord-live-99",
      leaderId: "whale",
      tokenId: "tok-99",
      side: "BUY",
      price: 0.5,
      size: 100,
      filledShares: 0,
      filledUsd: 0,
      tradeKey: "k99",
      reasoning: "fixed",
    });
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 99,
        originalSize: 100,
        status: "CONFIRMED",
        terminal: false,
        filledUsd: 49.5,
        averagePrice: 0.5,
        feeUsd: 0,
      },
    });

    await runCopyCycle(liveConfig(false), store);

    expect(store.getPosition("whale", "tok-99")).toBe(99);
    expect(store.listPendingOrders()).toEqual([
      expect.objectContaining({
        orderId: "ord-live-99",
        filledShares: 99,
        filledUsd: 49.5,
      }),
    ]);
  });

  it("applies confirmed pending deltas without rounding shares to cents", async () => {
    store.upsertPendingOrder({
      orderId: "ord-live-precise",
      leaderId: "whale",
      tokenId: "tok-precise",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      filledUsd: 0,
      tradeKey: "k-precise",
      reasoning: "fixed",
    });
    mockGetOrderStatus.mockResolvedValue({
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

    await runCopyCycle(liveConfig(false), store);

    expect(store.getPosition("whale", "tok-precise")).toBe(4.9475);
    expect(store.listPendingOrders()[0]).toMatchObject({
      filledShares: 4.9475,
      filledUsd: 2.47375,
    });
  });

  it("waits when matched shares advance before cumulative trade notional", async () => {
    store.recordPendingFill({
      leaderId: "whale",
      tokenId: "tok-lagged",
      side: "BUY",
      delta: 4,
      price: 0.5,
      auditReason: "initial confirmed fill",
      preview: false,
    });
    store.upsertPendingOrder({
      orderId: "ord-live-lagged",
      leaderId: "whale",
      tokenId: "tok-lagged",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 4,
      filledUsd: 2,
      feeUsd: 0,
      tradeKey: "k-lagged",
      reasoning: "fixed",
    });
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 6,
        originalSize: 10,
        status: "CONFIRMED",
        terminal: false,
        filledUsd: 2,
        averagePrice: 0.5,
        feeUsd: 0,
      },
    });

    const result = await runCopyCycle(liveConfig(false), store);

    expect(store.getPosition("whale", "tok-lagged")).toBe(4);
    expect(store.listPendingOrders()[0]).toMatchObject({
      filledShares: 4,
      filledUsd: 2,
    });
    expect(result.errors.some((error) => error.includes("cumulative fill evidence lagged"))).toBe(
      true
    );
  });

  it("retires a missing order after a bounded confirmed-fill reconciliation window", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-11T00:00:00.000Z");
    vi.setSystemTime(now);
    store.upsertPendingOrder({
      orderId: "ord-live-disappeared",
      leaderId: "whale",
      tokenId: "tok-disappeared",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      filledUsd: 0,
      tradeKey: "k-disappeared",
      reasoning: "fixed",
    });
    mockGetOrderStatus.mockResolvedValue({ kind: "not_found" });

    const result = await runCopyCycle(liveConfig(false), store);

    expect(store.listPendingOrders()).toHaveLength(0);
    expect(store.listPendingOrders({ includeReconciliation: true })).toEqual([
      expect.objectContaining({ reconciliationOnly: true, reconciliationStartedAt: now }),
    ]);
    expect(result.errors.some((error) => error.includes("confirmation unavailable"))).toBe(true);

    vi.setSystemTime(now + 25 * 60 * 60_000);
    const retired = await runCopyCycle(liveConfig(false), store);
    expect(retired.pendingFilled).toBe(0);
    expect(store.listPendingOrders({ includeReconciliation: true })).toHaveLength(0);
  });

  it("moves cancelled GTC orders to reconciliation without losing delayed confirmed fills", async () => {
    store.upsertPendingOrder({
      orderId: "ord-live-cancelled-late-fill",
      leaderId: "whale",
      tokenId: "tok-cancelled-late-fill",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      filledUsd: 0,
      tradeKey: "k-cancelled-late-fill",
      reasoning: "fixed",
    });
    mockGetOrderStatus
      .mockResolvedValueOnce({
        kind: "ok",
        status: {
          sizeMatched: 0,
          originalSize: 10,
          status: "CANCELLED",
          terminal: true,
        },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        status: {
          sizeMatched: 4,
          originalSize: 0,
          status: "CONFIRMED_CLOSED",
          terminal: false,
          filledUsd: 1.96,
          averagePrice: 0.49,
          feeUsd: 0.04,
        },
      });

    await runCopyCycle(liveConfig(false), store);
    expect(store.countPendingOrders()).toBe(0);
    expect(store.listPendingOrders({ includeReconciliation: true })).toHaveLength(1);

    await runCopyCycle(liveConfig(false), store);
    expect(store.getPosition("whale", "tok-cancelled-late-fill")).toBe(4);
    expect(store.listAuditLog({ action: "COPY" }).items).toHaveLength(1);
  });

  it("applies a final closed-order delta once and retires the reconciliation tombstone", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-10T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    store.upsertPendingOrder({
      orderId: "ord-closed-partial-final",
      leaderId: "whale",
      tokenId: "tok-closed-partial-final",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      filledUsd: 0,
      tradeKey: "k-closed-partial-final",
      reasoning: "fixed",
    });
    mockGetOrderStatus
      .mockResolvedValueOnce({
        kind: "ok",
        status: { sizeMatched: 0, originalSize: 10, status: "CANCELLED", terminal: true },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        status: {
          sizeMatched: 4,
          originalSize: 0,
          status: "CONFIRMED_CLOSED",
          terminal: false,
          filledUsd: 1.96,
          feeUsd: 0.04,
        },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        status: {
          sizeMatched: 6,
          originalSize: 0,
          status: "CONFIRMED_CLOSED",
          terminal: false,
          filledUsd: 2.94,
          feeUsd: 0.06,
        },
      });

    await runCopyCycle(liveConfig(false), store);
    expect(store.countReconcilingOrders()).toBe(1);
    vi.setSystemTime(startedAt + 60 * 60_000);
    await runCopyCycle(liveConfig(false), store);
    expect(store.getPosition("whale", "tok-closed-partial-final")).toBe(4);

    vi.setSystemTime(startedAt + 25 * 60 * 60_000);
    await runCopyCycle(liveConfig(false), store);
    await runCopyCycle(liveConfig(false), store);

    expect(store.getPosition("whale", "tok-closed-partial-final")).toBe(6);
    expect(store.listPendingOrders({ includeReconciliation: true })).toHaveLength(0);
    expect(store.countReconcilingOrders()).toBe(0);
    expect(mockGetOrderStatus).toHaveBeenCalledTimes(3);
    expect(store.listAuditLog({ action: "COPY" }).items).toHaveLength(2);
    vi.useRealTimers();
  });

  it("keeps a stale-cancelled GTC reconciliation tombstone", async () => {
    store.upsertPendingOrder({
      orderId: "ord-live-stale-cancel",
      leaderId: "whale",
      tokenId: "tok-stale-cancel",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      filledUsd: 0,
      tradeKey: "k-stale-cancel",
      reasoning: "fixed",
    });
    store.setPendingOrderTimestamps("ord-live-stale-cancel", Date.now() - 49 * 3600_000);
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 0,
        originalSize: 10,
        status: "LIVE",
        terminal: false,
      },
    });
    mockCancelOrder.mockResolvedValue({ ok: true });

    await runCopyCycle(liveConfig(false), store);

    expect(mockCancelOrder).toHaveBeenCalledWith("ord-live-stale-cancel");
    expect(store.countPendingOrders()).toBe(0);
    expect(store.listPendingOrders({ includeReconciliation: true })).toHaveLength(1);
  });

  it("backfills a legacy reconciliation timestamp and retires a not-found tombstone", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    vi.setSystemTime(now);
    const dbPath = join(dir, "test.db");
    store.close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE pending_orders;
      CREATE TABLE pending_orders (
        order_id TEXT PRIMARY KEY,
        leader_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        filled_shares REAL NOT NULL DEFAULT 0,
        filled_usd REAL NOT NULL DEFAULT 0,
        fee_usd REAL NOT NULL DEFAULT 0,
        leader_price REAL,
        executable_price REAL,
        slippage_pct REAL,
        trade_key TEXT NOT NULL,
        reasoning TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reconciliation_only INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacy.prepare(
      `INSERT INTO pending_orders
       (order_id, leader_id, token_id, side, price, size, filled_shares, filled_usd,
        fee_usd, trade_key, reasoning, created_at, updated_at, reconciliation_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      "legacy-reconciliation",
      "whale",
      "tok-legacy-reconciliation",
      "BUY",
      0.5,
      10,
      0,
      0,
      0,
      "legacy-key",
      "legacy closed order",
      now - 26 * 60 * 60_000,
      now - 25 * 60 * 60_000
    );
    legacy.close();
    store = new StateStore(dbPath);
    mockGetOrderStatus.mockResolvedValue({ kind: "not_found" });

    const [migrated] = store.listPendingOrders({ includeReconciliation: true });
    expect(migrated?.reconciliationStartedAt).toBe(now - 25 * 60 * 60_000);

    await runCopyCycle(liveConfig(false), store);
    await runCopyCycle(liveConfig(false), store);

    expect(store.listPendingOrders({ includeReconciliation: true })).toHaveLength(0);
    expect(mockGetOrderStatus).toHaveBeenCalledTimes(1);
  });

  it("resolves a closed order only when its exact requested size is confirmed", async () => {
    store.upsertPendingOrder({
      orderId: "ord-live-closed-full",
      leaderId: "whale",
      tokenId: "tok-closed-full",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      filledUsd: 0,
      tradeKey: "k-closed-full",
      reasoning: "fixed",
    });
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 10,
        originalSize: 0,
        status: "CONFIRMED_CLOSED",
        terminal: false,
        filledUsd: 5,
        averagePrice: 0.5,
        feeUsd: 0,
      },
    });

    await runCopyCycle(liveConfig(false), store);

    expect(store.getPosition("whale", "tok-closed-full")).toBe(10);
    expect(store.listPendingOrders()).toHaveLength(0);
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

  it("persists an exact accepted order id for confirmed-fill reconciliation", async () => {
    const activity = testActivity({
      transactionHash: "0xacceptedpending",
      asset: "tok-accepted-pending",
      side: "BUY",
      size: 100,
      price: 0.5,
    });
    mockPollLeaders.mockResolvedValue([{ leaderId: "whale", fetched: 1, candidates: [activity] }]);
    mockPlaceLimitOrder.mockResolvedValue({
      preview: false,
      orderId: "ord-accepted-pending",
      error: "Order accepted; fill confirmation pending",
      filledShares: 0,
      filledUsd: 0,
      orderStatus: "MATCHED",
      pendingRemaining: 0,
    });

    const result = await runCopyCycle(liveConfig(true), store);

    expect(result.copied).toBe(0);
    expect(store.listPendingOrders()).toEqual([
      expect.objectContaining({
        orderId: "ord-accepted-pending",
        tokenId: activity.asset,
        filledShares: 0,
      }),
    ]);
    expect(store.hasSeen(tradeEventKey(activity))).toBe(true);
    expect(store.listLiveOrderIntents()).toHaveLength(0);
    expect(store.getPosition("whale", activity.asset!)).toBe(0);
  });

  it("keeps an unconfirmed partial response unbooked when the order id is missing", async () => {
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

    expect(result.copied).toBe(0);
    expect(result.errors.some((error) => error.includes("cannot track remaining GTC"))).toBe(true);
    expect(store.getPosition("whale", activity.asset!)).toBe(0);
    expect(store.hasSeen(tradeEventKey(activity))).toBe(false);
    expect(store.countPendingOrders()).toBe(0);
    expect(store.listLiveOrderIntents()).toHaveLength(1);
  });

  it("records guarded live COPY audit from the actual fill price", async () => {
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
    mockFetchExecutableOrderBookSnapshot.mockResolvedValue({
      levels: [{ price: "0.50", size: "100" }],
      tickSize: 0.01,
      minOrderShares: 1,
    });
    mockPlaceLimitOrder.mockResolvedValue({
      preview: false,
      orderId: "ord-execution-price",
      filledShares: 2,
      filledUsd: 1.04,
      executionPrice: 0.52,
      orderStatus: "matched",
      pendingRemaining: 0,
    });

    const config = liveConfig(true);
    config.app.global.copyPriceMode = "executable_guarded";
    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    expect(store.getPositionCostUsd("whale", activity.asset!)).toBeCloseTo(1.04);
    const [copy] = store.listAuditLog({ action: "COPY" }).items;
    expect(copy).toMatchObject({
      price: 0.52,
      leaderPrice: 0.5,
      executablePrice: 0.52,
      slippagePct: 4,
    });
  });
});
