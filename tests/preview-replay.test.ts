import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Activity } from "../src/monitor/data-api.js";
import { replayPreviewActivities } from "../src/sim/preview-replay.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig, testActivity, testLeader } from "./helpers/fixtures.js";

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-preview-replay-"));
  store = new StateStore(join(dir, "preview.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("replayPreviewActivities", () => {
  it("replays fixed-size buys through the same cash ledger", async () => {
    const config = previewRuntimeConfig([
      testLeader({
        strategy: { type: "FIXED", copySize: 1 },
        limits: { maxOrderUsd: 1 },
      }),
    ]);
    config.app.global.risk.startingCapitalUsd = 3;
    config.app.global.risk.maxOrderUsd = 1;

    const activities = [
      testActivity({
        transactionHash: "0x1",
        asset: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
        size: 100,
        price: 0.5,
      }),
      testActivity({
        transactionHash: "0x2",
        asset: "token-b",
        conditionId: "condition-b",
        slug: "market-b",
        size: 100,
        price: 0.5,
      }),
      testActivity({
        transactionHash: "0x3",
        asset: "token-c",
        conditionId: "condition-c",
        slug: "market-c",
        size: 100,
        price: 0.5,
      }),
      testActivity({
        transactionHash: "0x4",
        asset: "token-d",
        conditionId: "condition-d",
        slug: "market-d",
        size: 100,
        price: 0.5,
      }),
    ];

    const result = await replayPreviewActivities({
      store,
      leader: config.app.leaders[0]!,
      global: config.app.global,
      activities,
      resolveMarket: async () => ({ closed: false, winnerTokenIds: [] }),
    });

    expect(result.copyTrades).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.cashUsd).toBe(0);
    expect(result.openCostUsd).toBe(3);
    expect(result.skipReasons["preview cash $0.00 < order $1.00"]).toBe(1);
  });

  it("audits already-seen trade skips during replay", async () => {
    const config = previewRuntimeConfig([
      testLeader({
        strategy: { type: "FIXED", copySize: 1 },
        limits: { maxOrderUsd: 1 },
      }),
    ]);
    config.app.global.risk.startingCapitalUsd = 3;

    const activity = testActivity({
      transactionHash: "0xseen",
      asset: "seen-token",
      conditionId: "seen-condition",
      slug: "seen-market",
      size: 100,
      price: 0.5,
    });

    const result = await replayPreviewActivities({
      store,
      leader: config.app.leaders[0]!,
      global: config.app.global,
      activities: [activity, activity],
      resolveMarket: async () => ({ closed: false, winnerTokenIds: [] }),
    });

    expect(result.copyTrades).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skipReasons["already seen"]).toBe(1);
    expect(
      store
        .listAuditLog({ action: "SKIP" })
        .items.some((item) => item.reason === "already seen" && item.side === "BUY")
    ).toBe(true);
  });

  it("auto-settles ended markets during replay without requiring REDEEM", async () => {
    const config = previewRuntimeConfig([
      testLeader({
        strategy: { type: "FIXED", copySize: 1 },
        limits: { maxOrderUsd: 1 },
      }),
    ]);
    config.app.global.risk.startingCapitalUsd = 10;
    const buy = testActivity({
      timestamp: 1_000,
      transactionHash: "0xbuy",
      asset: "winner-token",
      conditionId: "condition-win",
      slug: "market-win",
      outcome: "Yes",
      size: 100,
      price: 0.5,
    });
    const later: Activity = {
      type: "REWARD",
      timestamp: 2_000,
    };

    const result = await replayPreviewActivities({
      store,
      leader: config.app.leaders[0]!,
      global: config.app.global,
      activities: [buy, later],
      resolveMarket: async (slug, atMs) =>
        slug === "market-win" && atMs >= 2_000
          ? { closed: true, winnerTokenIds: ["winner-token"] }
          : { closed: false, winnerTokenIds: [] },
    });

    expect(result.copyTrades).toBe(1);
    expect(result.settlements).toBe(1);
    expect(result.cashUsd).toBe(11);
    expect(result.realizedPnlUsd).toBe(1);
    expect(store.getPosition("whale", "winner-token")).toBe(0);
  });

  it("tracks cash starvation and peak exposure risk during replay", async () => {
    const config = previewRuntimeConfig([
      testLeader({
        strategy: { type: "FIXED", copySize: 1 },
        limits: { maxOrderUsd: 1, maxPositionUsd: 2 },
      }),
    ]);
    config.app.global.risk.startingCapitalUsd = 4;
    config.app.global.risk.maxOrderUsd = 1;
    config.app.global.buyDedupWindowMs = 0;

    const activities = [
      testActivity({
        timestamp: 1_000,
        transactionHash: "0xa1",
        asset: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
        size: 100,
        price: 0.5,
      }),
      testActivity({
        timestamp: 2_000,
        transactionHash: "0xa2",
        asset: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
        size: 100,
        price: 0.5,
      }),
      testActivity({
        timestamp: 3_000,
        transactionHash: "0xa3",
        asset: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
        size: 100,
        price: 0.5,
      }),
      testActivity({
        timestamp: 4_000,
        transactionHash: "0xb1",
        asset: "token-b",
        conditionId: "condition-b",
        slug: "market-b",
        size: 100,
        price: 0.5,
      }),
      testActivity({
        timestamp: 5_000,
        transactionHash: "0xc1",
        asset: "token-c",
        conditionId: "condition-c",
        slug: "market-c",
        size: 100,
        price: 0.5,
      }),
      testActivity({
        timestamp: 6_000,
        transactionHash: "0xd1",
        asset: "token-d",
        conditionId: "condition-d",
        slug: "market-d",
        size: 100,
        price: 0.5,
      }),
    ];

    const result = await replayPreviewActivities({
      store,
      leader: config.app.leaders[0]!,
      global: config.app.global,
      activities,
      resolveMarket: async () => ({ closed: false, winnerTokenIds: [] }),
    });

    expect(result.copyTrades).toBe(4);
    expect(result.skipped).toBe(2);
    expect(result.cashUsd).toBe(0);
    expect(result.minCashUsd).toBe(0);
    expect(result.peakOpenCostUsd).toBe(4);
    expect(result.peakMarketCostUsd).toBe(2);
    expect(result.cashStarvedSkips).toBe(1);
    expect(result.positionCapSkips).toBe(1);
    expect(result.detectedBuyTrades).toBe(6);
    expect(result.copiedBuyTrades).toBe(4);
    expect(result.buyCoveragePct).toBe(66.67);
    expect(result.tradeCoveragePct).toBe(66.67);
  });

  it("reports buy and sell coverage from the same replayed trade stream", async () => {
    const config = previewRuntimeConfig([
      testLeader({
        strategy: { type: "FIXED", copySize: 1 },
        limits: { maxOrderUsd: 1 },
      }),
    ]);
    config.app.global.risk.startingCapitalUsd = 10;
    config.app.global.buyDedupWindowMs = 0;

    const activities = [
      testActivity({
        timestamp: 1_000,
        transactionHash: "0xbuy",
        asset: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
        side: "BUY",
        size: 10,
        price: 0.5,
      }),
      testActivity({
        timestamp: 2_000,
        transactionHash: "0xsell-copy",
        asset: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
        side: "SELL",
        size: 1,
        price: 0.8,
      }),
      testActivity({
        timestamp: 3_000,
        transactionHash: "0xsell-miss",
        asset: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
        side: "SELL",
        size: 100,
        price: 0.8,
      }),
    ];

    const result = await replayPreviewActivities({
      store,
      leader: config.app.leaders[0]!,
      global: config.app.global,
      activities,
      resolveMarket: async () => ({ closed: false, winnerTokenIds: [] }),
    });

    expect(result.detectedBuyTrades).toBe(1);
    expect(result.detectedSellTrades).toBe(2);
    expect(result.copiedBuyTrades).toBe(1);
    expect(result.copiedSellTrades).toBe(1);
    expect(result.buyCoveragePct).toBe(100);
    expect(result.sellCoveragePct).toBe(50);
    expect(result.tradeCoveragePct).toBe(66.67);
    expect(result.skipReasons).toHaveProperty("SELL held=0.75 need=1.25");
  });

  it("tracks unmatched redeem skips separately from risk-control skips", async () => {
    const config = previewRuntimeConfig([
      testLeader({
        strategy: { type: "FIXED", copySize: 1 },
        limits: { maxOrderUsd: 1 },
      }),
    ]);
    const redeem: Activity = {
      type: "REDEEM",
      timestamp: 1_000,
      transactionHash: "0xredeem",
      conditionId: "condition-without-local-position",
      slug: "market-without-local-position",
    };

    const result = await replayPreviewActivities({
      store,
      leader: config.app.leaders[0]!,
      global: config.app.global,
      activities: [redeem],
      resolveMarket: async () => ({ closed: true, winnerTokenIds: ["winner-token"] }),
    });

    expect(result.skipped).toBe(1);
    expect(result.unmatchedRedeemSkips).toBe(1);
    expect(result.cashStarvedSkips).toBe(0);
    expect(result.positionCapSkips).toBe(0);
  });
});
