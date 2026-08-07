import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateStore } from "../src/state/store.js";
import { runCopyCycle } from "../src/engine/copy-cycle.js";
import { processSettlements } from "../src/engine/settlement.js";
import { pollLeaders } from "../src/monitor/poll.js";
import { tradeEventKey, fetchLeaderSharesBeforeSell } from "../src/monitor/data-api.js";
import { previewRuntimeConfig, testActivity, testLeader } from "./helpers/fixtures.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/monitor/poll.js", () => ({
  pollLeaders: vi.fn(),
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
    fetchLeaderSharesBeforeSell: vi.fn(),
  };
});

const mockProcessSettlements = vi.mocked(processSettlements);
const mockPollLeaders = vi.mocked(pollLeaders);
const mockFetchLeaderBefore = vi.mocked(fetchLeaderSharesBeforeSell);

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-copy-cycle-"));
  store = new StateStore(join(dir, "test.db"));
  mockPollLeaders.mockReset();
  mockProcessSettlements.mockClear();
  mockFetchLeaderBefore.mockReset();
  mockFetchLeaderBefore.mockResolvedValue(null);
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
    expect(store.getPreviewCashUsd()).toBe(495);
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

  it("runs settlement even when copy trading is disabled", async () => {
    const config = previewRuntimeConfig();
    config.app.global.risk.enableCopyTrading = false;
    mockPollLeaders.mockResolvedValue([]);

    await runCopyCycle(config, store);

    expect(mockProcessSettlements).toHaveBeenCalledTimes(1);
  });

  it("runs settlement when kill switch is active", async () => {
    const config = previewRuntimeConfig();
    store.triggerKillSwitch();
    mockPollLeaders.mockResolvedValue([]);

    await runCopyCycle(config, store);

    expect(mockProcessSettlements).toHaveBeenCalledTimes(1);
  });

  it("SELL position_fraction closes accumulated inventory on leader full exit", async () => {
    const token = "token-sell-full";
    store.applyCopyFill("whale", token, "BUY", 10, 0.5);
    store.applyCopyFill("whale", token, "BUY", 10, 0.5);
    store.applyCopyFill("whale", token, "BUY", 10, 0.5);
    expect(store.getPosition("whale", token)).toBe(30);

    const sell = testActivity({
      asset: token,
      side: "SELL",
      size: 300,
      price: 0.5,
      transactionHash: "0xsell-full",
    });
    const config = previewRuntimeConfig([
      testLeader({ strategy: { type: "FIXED", copySize: 5 } }),
    ]);
    mockFetchLeaderBefore.mockResolvedValue(300);
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    expect(store.getPosition("whale", token)).toBe(0);
  });

  it("SELL clamps instead of skipping when strategy size exceeds held", async () => {
    const token = "token-sell-clamp";
    store.applyCopyFill("whale", token, "BUY", 4, 0.5);
    const sell = testActivity({
      asset: token,
      side: "SELL",
      size: 200,
      price: 0.5,
      transactionHash: "0xsell-clamp",
    });
    const config = previewRuntimeConfig([
      testLeader({ strategy: { type: "PERCENTAGE", copySize: 10 } }),
    ]);
    // Force fallback path: unknown leader inventory + oversized strategy
    mockFetchLeaderBefore.mockResolvedValue(null);
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    expect(store.getPosition("whale", token)).toBe(0);
  });

  it("SELL fallback exits held when leader position unknown and strategy below min", async () => {
    const token = "token-sell-fallback-zero";
    store.applyCopyFill("whale", token, "BUY", 8, 0.5);
    const sell = testActivity({
      asset: token,
      side: "SELL",
      size: 0.5, // tiny notional → strategy below minOrderUsd
      price: 0.5,
      transactionHash: "0xsell-fallback-zero",
    });
    const config = previewRuntimeConfig([
      testLeader({ strategy: { type: "PERCENTAGE", copySize: 10 } }),
    ]);
    mockFetchLeaderBefore.mockResolvedValue(null);
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    expect(store.getPosition("whale", token)).toBe(0);
  });

  it("SELL without leader address uses fallback and does not call positions API", async () => {
    const token = "token-sell-no-addr";
    store.applyCopyFill("whale", token, "BUY", 10, 0.5);
    const sell = testActivity({
      asset: token,
      side: "SELL",
      size: 100,
      price: 0.5,
      transactionHash: "0xsell-no-addr",
    });
    const config = previewRuntimeConfig([
      testLeader({
        address: undefined,
        username: "whale_user",
        strategy: { type: "PERCENTAGE", copySize: 10 },
      }),
    ]);
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(mockFetchLeaderBefore).not.toHaveBeenCalled();
    expect(result.copied).toBe(1);
    // 10% of 100 shares @ 0.5 → 10 shares; clamp to held 10
    expect(store.getPosition("whale", token)).toBe(0);
  });

  it("FIXED fallback with API miss sells strategy clip not all held", async () => {
    const token = "token-sell-fixed-partial";
    store.applyCopyFill("whale", token, "BUY", 10, 0.5);
    store.applyCopyFill("whale", token, "BUY", 10, 0.5);
    store.applyCopyFill("whale", token, "BUY", 10, 0.5);
    expect(store.getPosition("whale", token)).toBe(30);

    const sell = testActivity({
      asset: token,
      side: "SELL",
      size: 300,
      price: 0.5,
      transactionHash: "0xsell-fixed-partial",
    });
    const config = previewRuntimeConfig([
      testLeader({ strategy: { type: "FIXED", copySize: 5 } }),
    ]);
    mockFetchLeaderBefore.mockResolvedValue(null);
    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [sell] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(1);
    // FIXED $5 @ 0.5 = 10 shares — residual 20 remains when leader inventory unknown
    expect(store.getPosition("whale", token)).toBe(20);
  });
});
