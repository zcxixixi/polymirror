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
});
