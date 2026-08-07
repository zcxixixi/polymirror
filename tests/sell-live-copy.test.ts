import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state/store.js";
import type { RuntimeConfig } from "../src/config/types.js";
import { testActivity, testLeader } from "./helpers/fixtures.js";

const mockPlaceLimitOrder = vi.fn();
const mockFetchLeaderBefore = vi.fn();
const mockFetchConditional = vi.fn();
const mockPollLeaders = vi.fn();

vi.mock("../src/monitor/poll.js", () => ({
  pollLeaders: (...args: unknown[]) => mockPollLeaders(...args),
}));

vi.mock("../src/engine/settlement.js", () => ({
  processSettlements: vi.fn(async () => ({
    leaderRedeems: 0,
    autoSettled: 0,
    onChainRedeems: 0,
    errors: [],
  })),
}));

vi.mock("../src/monitor/data-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/monitor/data-api.js")>();
  return {
    ...actual,
    fetchLeaderSharesBeforeSell: (...args: unknown[]) => mockFetchLeaderBefore(...args),
  };
});

vi.mock("../src/executor/clob.js", () => ({
  ClobExecutor: class {
    placeLimitOrder = mockPlaceLimitOrder;
    getOrderStatus = vi.fn();
    cancelOrder = vi.fn(async () => ({ ok: true }));
    listOpenOrders = vi.fn(async () => []);
    recoverOrderAfterFailure = vi.fn(async () => null);
  },
  isDefiniteOrderRejection: () => false,
}));

vi.mock("../src/executor/orderbook.js", () => ({
  fetchBestExecutablePrice: vi.fn(async () => 0.5),
}));

vi.mock("../src/executor/geoblock.js", () => ({
  getCachedGeoblockStatus: vi.fn(async () => ({ blocked: false })),
  formatGeoblockMessage: () => "geoblock",
}));

vi.mock("../src/executor/balance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/executor/balance.js")>();
  return {
    ...actual,
    fetchConditionalTokenSnapshot: (...args: unknown[]) => mockFetchConditional(...args),
    checkWalletDrifts: vi.fn(async () => []),
    fetchWalletCollateral: vi.fn(async () => ({
      cashUsd: 100,
      clobUsd: 100,
      clobAllowanceUsd: 100,
      chainUsd: 100,
      source: "clob" as const,
    })),
    fetchWalletCollateralUsdc: vi.fn(async () => 100),
  };
});

import { runCopyCycle } from "../src/engine/copy-cycle.js";

function liveConfig(leaders = [testLeader()]): RuntimeConfig {
  return {
    wallet: {
      privateKey: "0x" + "1".repeat(64),
      proxyAddress: "0x" + "2".repeat(40),
      signatureType: 0,
      chainId: 137,
      clobUrl: "https://clob.polymarket.com",
      dataApiUrl: "https://data-api.polymarket.com",
      tradingBackend: "secure",
      builderCode: "0x" + "9".repeat(64),
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
          syncWalletBalance: true,
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
      },
      leaders,
    },
  };
}

describe("Live SELL with sync_wallet_balance", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-sell-live-"));
    store = new StateStore(join(dir, "test.db"));
    mockPlaceLimitOrder.mockReset();
    mockFetchLeaderBefore.mockReset();
    mockFetchConditional.mockReset();
    mockPollLeaders.mockReset();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("clamps full exit to proportionalSellable wallet allocation", async () => {
    const token = "token-live-prop";
    // Local tracked 20; wallet only has 10 → sellable = 10
    store.applyCopyFill("whale", token, "BUY", 20, 0.5);

    const sell = testActivity({
      asset: token,
      side: "SELL",
      size: 200,
      price: 0.5,
      transactionHash: "0xlive-prop",
    });

    mockFetchLeaderBefore.mockResolvedValue(200); // full exit
    mockFetchConditional.mockResolvedValue({ balance: 10, allowance: 100 });
    mockPlaceLimitOrder.mockResolvedValue({
      preview: false,
      orderId: "ord-live-1",
      filledShares: 10,
      filledUsd: 5,
      pendingRemaining: 0,
      orderStatus: "MATCHED",
    });
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(liveConfig(), store);

    expect(result.copied).toBe(1);
    expect(mockPlaceLimitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "SELL",
        size: 10,
        tokenId: token,
      })
    );
    // Filled 10 of 20 tracked
    expect(store.getPosition("whale", token)).toBe(10);
  });

  it("skips when wallet token allowance check fails after sizing", async () => {
    const token = "token-live-allow";
    store.applyCopyFill("whale", token, "BUY", 8, 0.5);

    const sell = testActivity({
      asset: token,
      side: "SELL",
      size: 80,
      price: 0.5,
      transactionHash: "0xlive-allow",
    });

    mockFetchLeaderBefore.mockResolvedValue(80);
    mockFetchConditional.mockResolvedValue({ balance: 8, allowance: 1 });
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(liveConfig(), store);

    expect(result.copied).toBe(0);
    expect(mockPlaceLimitOrder).not.toHaveBeenCalled();
    expect(store.getPosition("whale", token)).toBe(8);
  });
});
