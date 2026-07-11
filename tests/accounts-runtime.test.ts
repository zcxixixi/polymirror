import { describe, expect, it } from "vitest";
import type { CopyCycleResult } from "../src/engine/copy-cycle.js";
import {
  updateAccountHealthAfterPoll,
  type AccountHealthSlice,
} from "../src/accounts/runtime.js";

function health(): AccountHealthSlice {
  return {
    previewMode: true,
    lastPollAt: null,
    lastPollResult: null,
    killSwitchActive: false,
    enabledLeaders: ["leader-1"],
    lastError: "old poll error",
    pendingOrders: 0,
    walletDrifts: [],
  };
}

function result(errors: string[]): CopyCycleResult {
  return {
    fetched: 1,
    copied: 0,
    skipped: 0,
    pendingFilled: 0,
    errors,
    walletDrifts: [],
    pendingOrders: 0,
  };
}

describe("updateAccountHealthAfterPoll", () => {
  it("clears stale lastError after a successful poll", () => {
    const accountHealth = health();

    updateAccountHealthAfterPoll(accountHealth, result([]), false, 0, []);

    expect(accountHealth.lastError).toBeNull();
  });

  it("warms up DB growth for 15 minutes and keeps a rolling rate instead of adjacent deltas", () => {
    const accountHealth = health();
    const minute = 60_000;
    const updateSize = (dbSizeBytes: number, sampledAt: number) => {
      updateAccountHealthAfterPoll(accountHealth, result([]), false, 0, [], {
        experimentState: "ACTIVE",
        experimentReason: null,
        settlementFailures: 0,
        closedMarketOpenPositions: 0,
        liquidationEquityUsd: null,
        liquidationDrawdownPct: null,
        quoteCoveragePct: null,
        dbSizeBytes,
        sampledAt,
      });
    };

    updateSize(100, 0);
    updateSize(114, 14 * minute);
    expect(accountHealth.dbGrowthBytesPerHour).toBeNull();

    updateSize(115, 15 * minute);
    expect(accountHealth.dbGrowthBytesPerHour).toBe(60);

    updateSize(115, 30 * minute);
    expect(accountHealth.dbGrowthBytesPerHour).toBe(30);

    updateSize(121, 61 * minute);
    expect(accountHealth.dbGrowthBytesPerHour).toBeCloseTo(7 * 60 / 47);
  });
});
