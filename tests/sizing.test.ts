import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  calculateOrderSize,
  calculateSellSize,
  parseTieredMultipliers,
} from "../src/engine/sizing.js";
import {
  estimateLeaderSharesBeforeSell,
  findTokenPositionSize,
  buildPositionsUrl,
} from "../src/monitor/data-api.js";
import { StateStore } from "../src/state/store.js";
import type { GlobalConfig, LeaderConfig } from "../src/config/types.js";
import type { Activity } from "../src/monitor/data-api.js";

const global: GlobalConfig = {
  pollIntervalMs: 5000,
  activityLimit: 100,
  previewMode: true,
  copyTradesOnly: true,
  maxTradeAgeHours: 1,
  buyDedupWindowMs: 60000,
  tradeAggregationWindowMs: 0,
  healthPort: 0,
  risk: {
    enableCopyTrading: true,
    dailyLossCapPct: 20,
    startingCapitalUsd: 1000,
    maxDailyVolumeUsd: 2000,
    maxOpenMarkets: 30,
    maxOrderUsd: 50,
    minOrderUsd: 1,
    slippageTolerance: 0.03,
    maxPositionPerTokenUsd: 0,
    syncWalletBalance: true,
  },
  execution: {
    orderType: "GTC",
    retryLimit: 3,
    networkRetryLimit: 3,
    gtcFillTimeoutMs: 10000,
    pendingOrderMaxAgeHours: 48,
    autoRedeemOnChain: true,
    sellSizing: "position_fraction",
  },
  conflict: { mode: "priority_leader", priority: [] },
  notify: {
    telegramOnCopy: true,
    telegramOnError: true,
    telegramOnKillSwitch: true,
  },
};

function leader(overrides: Partial<LeaderConfig> = {}): LeaderConfig {
  return {
    id: "whale",
    address: "0x0000000000000000000000000000000000000001",
    enabled: true,
    weight: 1,
    strategy: { type: "PERCENTAGE", copySize: 10 },
    ...overrides,
  };
}

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    type: "TRADE",
    asset: "token123",
    side: "BUY",
    size: 100,
    price: 0.5,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("parseTieredMultipliers", () => {
  it("parses ranges and plus suffix", () => {
    const tiers = parseTieredMultipliers("0-100:1,100-500:0.5,500+:0.25")!;
    expect(tiers).toHaveLength(3);
    expect(tiers[0]!.multiplier).toBe(1);
    expect(tiers[2]!.max).toBeNull();
  });
});

describe("calculateOrderSize", () => {
  it("applies PERCENTAGE sizing", () => {
    const r = calculateOrderSize(leader(), global, activity({ size: 100, price: 0.5 }));
    expect(r.belowMinimum).toBe(false);
    expect(r.finalUsd).toBeCloseTo(5, 1);
  });

  it("caps at max order usd", () => {
    const r = calculateOrderSize(
      leader({ limits: { maxOrderUsd: 3 } }),
      global,
      activity({ size: 1000, price: 0.5 })
    );
    expect(r.finalUsd).toBeLessThanOrEqual(3.01);
  });

  it("returns belowMinimum under min order", () => {
    const r = calculateOrderSize(
      leader({ strategy: { type: "PERCENTAGE", copySize: 0.1 } }),
      global,
      activity({ size: 1, price: 0.1 })
    );
    expect(r.belowMinimum).toBe(true);
  });
});

describe("estimateLeaderSharesBeforeSell", () => {
  it("adds current post-sell size to sell size when current < sell", () => {
    // Clear post-trade remainder: sold 100, still holds 50 → before was 150.
    expect(estimateLeaderSharesBeforeSell(50, 100)).toBe(150);
  });

  it("uses current as before when feed looks pre-sell (lag)", () => {
    // Positions still shows 300 while sell size is 100 → do not add sell again.
    expect(estimateLeaderSharesBeforeSell(300, 100)).toBe(300);
    // Ambiguous equal case: prefer lag interpretation (before=current), not current+sell.
    expect(estimateLeaderSharesBeforeSell(50, 50)).toBe(50);
  });

  it("lag-corrected before yields full exit when leader sold entire visible stack", () => {
    // Lag shows 300; leader sold 300 → before=300 → full exit of our 30.
    const before = estimateLeaderSharesBeforeSell(300, 300)!;
    const r = calculateSellSize({
      mode: "position_fraction",
      ourHeld: 30,
      price: 0.5,
      minOrderUsd: 1,
      leaderSellSize: 300,
      leaderSharesBefore: before,
      strategyShares: 5,
    });
    expect(before).toBe(300);
    expect(r.finalShares).toBe(30);
  });

  it("treats missing position as full exit basis", () => {
    expect(estimateLeaderSharesBeforeSell(0, 120)).toBe(120);
  });

  it("returns null when current unknown", () => {
    expect(estimateLeaderSharesBeforeSell(null, 10)).toBeNull();
  });
});

describe("findTokenPositionSize", () => {
  it("sums matching assets case-insensitively", () => {
    expect(
      findTokenPositionSize(
        [
          { asset: "Token123", size: 10 },
          { asset: "other", size: 5 },
          { asset: "token123", size: 2.5 },
        ],
        "token123"
      )
    ).toBe(12.5);
  });
});

describe("buildPositionsUrl", () => {
  it("includes sizeThreshold=0 when requested", () => {
    const url = buildPositionsUrl("https://data-api.polymarket.com", {
      user: "0xabc",
      sizeThreshold: 0,
    });
    expect(url).toContain("user=0xabc");
    expect(url).toContain("sizeThreshold=0");
  });
});

describe("calculateSellSize position_fraction", () => {
  it("mirrors multi-buy then full exit for FIXED-style inventory", () => {
    // Accumulated held from 3× FIXED buys; leader sells entire stack.
    const r = calculateSellSize({
      mode: "position_fraction",
      ourHeld: 30,
      price: 0.5,
      minOrderUsd: 1,
      leaderSellSize: 300,
      leaderSharesBefore: 300,
      strategyShares: 20, // legacy FIXED would only sell one clip
    });
    expect(r.belowMinimum).toBe(false);
    expect(r.finalShares).toBe(30);
    expect(r.reasoning).toMatch(/full exit/i);
  });

  it("sells proportional fraction on partial leader exit", () => {
    const r = calculateSellSize({
      mode: "position_fraction",
      ourHeld: 30,
      price: 0.5,
      minOrderUsd: 1,
      leaderSellSize: 100,
      leaderSharesBefore: 300,
      strategyShares: 10,
    });
    expect(r.finalShares).toBe(10); // 30 * (100/300)
    expect(r.reasoning).toMatch(/33\.3%/);
  });

  it("clamps when fraction would exceed held", () => {
    const r = calculateSellSize({
      mode: "position_fraction",
      ourHeld: 5,
      price: 0.5,
      minOrderUsd: 1,
      leaderSellSize: 200,
      leaderSharesBefore: 100, // noisy estimate → fraction > 1 → full exit path
      strategyShares: 50,
    });
    expect(r.finalShares).toBe(5);
  });

  it("falls back to strategy+clamp when leader position unknown", () => {
    const r = calculateSellSize({
      mode: "position_fraction",
      ourHeld: 12,
      price: 0.5,
      minOrderUsd: 1,
      leaderSellSize: 100,
      leaderSharesBefore: null,
      strategyShares: 40, // would have skipped under old held<need
    });
    expect(r.belowMinimum).toBe(false);
    expect(r.finalShares).toBe(12);
    expect(r.reasoning).toMatch(/clamped|fallback/i);
  });

  it("fallback sells all held when strategyShares is 0 but inventory is sellable", () => {
    const r = calculateSellSize({
      mode: "position_fraction",
      ourHeld: 12,
      price: 0.5,
      minOrderUsd: 1,
      leaderSellSize: 1, // tiny leader sell → strategy below min
      leaderSharesBefore: null,
      strategyShares: 0,
    });
    expect(r.belowMinimum).toBe(false);
    expect(r.finalShares).toBe(12);
    expect(r.reasoning).toMatch(/fallback sell all held/i);
  });

  it("trade_notional does not sell-all when strategyShares is 0", () => {
    const r = calculateSellSize({
      mode: "trade_notional",
      ourHeld: 12,
      price: 0.5,
      minOrderUsd: 1,
      leaderSellSize: 1,
      leaderSharesBefore: null,
      strategyShares: 0,
    });
    expect(r.belowMinimum).toBe(true);
    expect(r.finalShares).toBe(0);
  });

  it("marks dust below min order", () => {
    const r = calculateSellSize({
      mode: "position_fraction",
      ourHeld: 0.5,
      price: 0.1,
      minOrderUsd: 1,
      leaderSellSize: 10,
      leaderSharesBefore: 10,
      strategyShares: 1,
    });
    // 0.5 * 0.1 = $0.05 < $1
    expect(r.belowMinimum).toBe(true);
  });
});

describe("calculateSellSize trade_notional", () => {
  it("uses strategy size but still clamps to held", () => {
    const r = calculateSellSize({
      mode: "trade_notional",
      ourHeld: 8,
      price: 0.5,
      minOrderUsd: 1,
      leaderSellSize: 100,
      leaderSharesBefore: 100,
      strategyShares: 20,
    });
    expect(r.finalShares).toBe(8);
  });
});

describe("calculateOrderSize position cap basis", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-sizing-"));
    store = new StateStore(join(dir, "test.db"));
    // 200 shares bought at 0.5 → cost basis $100, mark-to-market at 0.9 = $180.
    store.applyCopyFill("whale", "token123", "BUY", 200, 0.5);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const capLeader = leader({ limits: { maxPositionUsd: 150 } });
  const priceUp = activity({ side: "BUY", size: 1000, price: 0.9 });

  it("market basis blocks when mark-to-market exceeds cap", () => {
    const marketGlobal: GlobalConfig = {
      ...global,
      risk: { ...global.risk, positionCapBasis: "market" },
    };
    const r = calculateOrderSize(capLeader, marketGlobal, priceUp, store);
    expect(r.belowMinimum).toBe(true);
    expect(r.reasoning).toContain("max position reached");
  });

  it("cost basis allows buy when capital deployed is under cap", () => {
    const costGlobal: GlobalConfig = {
      ...global,
      risk: { ...global.risk, positionCapBasis: "cost" },
    };
    const r = calculateOrderSize(capLeader, costGlobal, priceUp, store);
    expect(r.belowMinimum).toBe(false);
    // cost room = 150 - 100 = $50; global max_order_usd also caps at $50.
    expect(r.finalUsd).toBeLessThanOrEqual(50.01);
    expect(r.finalUsd).toBeGreaterThan(0);
  });

  it("defaults to market basis when unset", () => {
    const r = calculateOrderSize(capLeader, global, priceUp, store);
    expect(r.belowMinimum).toBe(true);
  });
});
