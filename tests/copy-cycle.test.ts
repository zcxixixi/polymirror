import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateStore } from "../src/state/store.js";
import { runCopyCycle } from "../src/engine/copy-cycle.js";
import { pollLeaders } from "../src/monitor/poll.js";
import { tradeEventKey, type Activity } from "../src/monitor/data-api.js";
import { fetchResolvedMarketOutcome } from "../src/monitor/market-resolve.js";
import { previewRuntimeConfig, testActivity, testLeader } from "./helpers/fixtures.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/monitor/poll.js", () => ({
  pollLeaders: vi.fn(),
}));

vi.mock("../src/monitor/market-resolve.js", () => ({
  fetchResolvedMarketOutcome: vi.fn(),
}));

const mockPollLeaders = vi.mocked(pollLeaders);
const mockFetchResolvedMarketOutcome = vi.mocked(fetchResolvedMarketOutcome);

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-copy-cycle-"));
  store = new StateStore(join(dir, "test.db"));
  mockPollLeaders.mockReset();
  mockFetchResolvedMarketOutcome.mockReset();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("runCopyCycle", () => {
  it("copies a preview trade from mocked Data API poll", async () => {
    const activity = testActivity();
    const config = previewRuntimeConfig();

    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [activity] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    expect(result.errors).toEqual([]);
    expect(store.getPosition("whale", activity.asset!)).toBe(10);
    expect(store.hasSeen(tradeEventKey(activity))).toBe(true);
    expect(store.getDailyVolumeUsd()).toBe(5);
  });

  it("skips already-seen trades on the next cycle", async () => {
    const activity = testActivity();
    const config = previewRuntimeConfig();

    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [activity] },
    ]);

    await runCopyCycle(config, store);
    const second = await runCopyCycle(config, store);

    expect(second.copied).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(
      store
        .listAuditLog({ action: "SKIP" })
        .items.some((item) => item.reason === "already seen")
    ).toBe(true);
  });

  it("skips trades that fail leader filters", async () => {
    const activity = testActivity({ price: 0.01 });
    const config = previewRuntimeConfig();

    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [activity] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(store.getPosition("whale", activity.asset!)).toBe(0);
  });

  it("records poll errors without crashing", async () => {
    const config = previewRuntimeConfig();

    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 0, candidates: [], error: "network timeout" },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(0);
    expect(result.errors.some((e) => e.includes("network timeout"))).toBe(true);
  });

  it("respects disabled leader config", async () => {
    const activity = testActivity();
    const config = previewRuntimeConfig([testLeader({ enabled: false })]);

    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [activity] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(0);
  });

  it("lets SELL exits bypass buy-spend caps", async () => {
    const config = previewRuntimeConfig();
    config.app.global.risk.maxDailyVolumeUsd = 5;
    const tokenId = "token-sell-cap";

    store.recordCopySuccess({
      tradeKey: "seed-buy",
      leaderId: "whale",
      tokenId,
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "seed position",
      preview: true,
    });

    const sell = testActivity({
      transactionHash: "0xsellcap",
      asset: tokenId,
      side: "SELL",
      size: 100,
      price: 0.5,
    });

    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    expect(result.errors).toEqual([]);
    expect(store.getPosition("whale", tokenId)).toBe(0);
    expect(store.getDailyVolumeUsd()).toBe(5);
  });

  it("skips unmatched SELL exits without marking the cycle as errored", async () => {
    const config = previewRuntimeConfig();
    const sell = testActivity({
      transactionHash: "0xunmatchedsell",
      asset: "token-not-held",
      side: "SELL",
      size: 100,
      price: 0.5,
    });

    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([]);
    expect(store.getPosition("whale", "token-not-held")).toBe(0);
    expect(store.hasSeen(tradeEventKey(sell))).toBe(true);
  });

  it("settles resolved REDEEM events into preview cash", async () => {
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 200;
    const tokenId = "winner-token";
    const conditionId = "condition-1";
    const slug = "binary-market";
    const buy = testActivity({
      transactionHash: "0xbuywinner",
      asset: tokenId,
      conditionId,
      slug,
      outcome: "Yes",
      size: 100,
      price: 0.5,
    });
    const redeem: Activity = {
      type: "REDEEM",
      timestamp: Date.now(),
      transactionHash: "0xredeemwinner",
      conditionId,
      slug,
      usdcSize: 10,
      title: "Binary market",
    };

    mockPollLeaders.mockResolvedValueOnce([
      { leaderId: "whale", fetched: 1, candidates: [buy] },
    ]);
    await runCopyCycle(config, store);

    mockFetchResolvedMarketOutcome
      .mockResolvedValueOnce({
        closed: false,
        winnerTokenIds: [],
      })
      .mockResolvedValueOnce({
        closed: true,
        winnerTokenIds: [tokenId],
      });
    mockPollLeaders.mockResolvedValueOnce([
      { leaderId: "whale", fetched: 1, candidates: [redeem] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    expect(store.getPosition("whale", tokenId)).toBe(0);
    expect(store.getCashBalance(200)).toBe(205);
    expect(store.getDailyRealizedPnl()).toBe(5);
    expect(store.listAuditLog({ action: "REDEEM" }).total).toBe(1);
    expect(store.hasSeen(tradeEventKey(redeem))).toBe(true);
  });

  it("audits unmatched preview REDEEM once, then audits repeated REDEEM as already seen", async () => {
    const config = previewRuntimeConfig();
    const redeem: Activity = {
      type: "REDEEM",
      timestamp: Date.now(),
      transactionHash: "0xredeemmissinglocal",
      conditionId: "condition-missing-local",
      slug: "missing-local-market",
      usdcSize: 10,
      title: "Missing local market",
    };

    mockPollLeaders.mockResolvedValueOnce([
      { leaderId: "whale", fetched: 1, candidates: [redeem] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(store.hasSeen(tradeEventKey(redeem))).toBe(true);

    mockPollLeaders.mockResolvedValueOnce([
      { leaderId: "whale", fetched: 1, candidates: [redeem] },
    ]);
    const second = await runCopyCycle(config, store);

    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(1);
    const skips = store.listAuditLog({ action: "SKIP" });
    expect(skips.total).toBe(2);
    expect(skips.items.map((item) => item.reason).sort()).toEqual([
      "already seen",
      "no local preview position for condition",
    ]);
  });

  it("auto-settles resolved preview positions without a REDEEM activity", async () => {
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 200;
    const tokenId = "auto-winner-token";
    const conditionId = "condition-auto";
    const slug = "auto-resolved-market";
    const buy = testActivity({
      transactionHash: "0xbuyautowinner",
      asset: tokenId,
      conditionId,
      slug,
      outcome: "Yes",
      size: 100,
      price: 0.5,
    });

    mockPollLeaders.mockResolvedValueOnce([
      { leaderId: "whale", fetched: 1, candidates: [buy] },
    ]);
    await runCopyCycle(config, store);

    mockFetchResolvedMarketOutcome.mockResolvedValue({
      closed: true,
      winnerTokenIds: [tokenId],
    });
    mockPollLeaders.mockResolvedValueOnce([
      { leaderId: "whale", fetched: 0, candidates: [] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    expect(store.getPosition("whale", tokenId)).toBe(0);
    expect(store.getCashBalance(200)).toBe(205);
    expect(store.getDailyRealizedPnl()).toBe(5);
    expect(store.listAuditLog({ action: "REDEEM" }).total).toBe(1);
    expect(mockFetchResolvedMarketOutcome).toHaveBeenCalledWith(slug);
  });

  it("does not throttle auto-settlement across separate stores", async () => {
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 200;
    const tokenId = "shared-pending-token";
    const conditionId = "shared-condition";
    const slug = "shared-pending-market";
    const secondStore = new StateStore(join(dir, "second.db"));
    try {
      for (const targetStore of [store, secondStore]) {
        targetStore.recordCopySuccess({
          tradeKey: `seed-${targetStore === store ? "a" : "b"}`,
          leaderId: "whale",
          tokenId,
          side: "BUY",
          filledShares: 10,
          price: 0.5,
          filledUsd: 5,
          auditReason: "seed position",
          preview: true,
          cashInitialUsd: 200,
          market: {
            tokenId,
            conditionId,
            slug,
            title: "Shared pending market",
            outcome: "Yes",
          },
        });
      }

      mockFetchResolvedMarketOutcome.mockResolvedValue({
        closed: false,
        winnerTokenIds: [],
      });
      mockPollLeaders.mockResolvedValue([
        { leaderId: "whale", fetched: 0, candidates: [] },
      ]);

      await runCopyCycle(config, store);
      await runCopyCycle(config, secondStore);

      expect(mockFetchResolvedMarketOutcome).toHaveBeenCalledTimes(2);
    } finally {
      secondStore.close();
    }
  });
});
