import { describe, expect, it } from "vitest";
import { healthSnapshot, syncAggregateHealth } from "../src/notify/health.js";

function health(
  enabledLeaders: string[],
  overrides: Partial<ReturnType<typeof health>> = {}
) {
  return {
    previewMode: true,
    lastPollAt: null,
    lastPollResult: null,
    killSwitchActive: false,
    enabledLeaders,
    lastError: null,
    pendingOrders: 0,
    walletDrifts: [],
    ...overrides,
  };
}

describe("syncAggregateHealth", () => {
  it("excludes leaders from disabled accounts", () => {
    const accounts = [
      { enabled: true, health: health(["active-leader"]) },
      { enabled: false, health: health(["disabled-leader"]) },
    ];

    syncAggregateHealth(accounts);

    expect(healthSnapshot.enabledLeaders).toEqual(["active-leader"]);
  });

  it("excludes disabled accounts from aggregate health state", () => {
    const activePoll = {
      fetched: 1,
      copied: 0,
      skipped: 0,
      pendingFilled: 0,
      errors: [],
      walletDrifts: [],
      pendingOrders: 0,
    };
    const disabledPoll = {
      ...activePoll,
      errors: ["disabled error"],
    };
    const accounts = [
      {
        enabled: true,
        health: health(["active-leader"], {
          previewMode: true,
          lastPollAt: 100,
          lastPollResult: activePoll,
          killSwitchActive: false,
          pendingOrders: 1,
          walletDrifts: ["active drift"],
        }),
      },
      {
        enabled: false,
        health: health(["disabled-leader"], {
          previewMode: false,
          lastPollAt: 200,
          lastPollResult: disabledPoll,
          killSwitchActive: true,
          lastError: "disabled error",
          pendingOrders: 9,
          walletDrifts: ["disabled drift"],
        }),
      },
    ];

    syncAggregateHealth(accounts);

    expect(healthSnapshot.previewMode).toBe(true);
    expect(healthSnapshot.killSwitchActive).toBe(false);
    expect(healthSnapshot.pendingOrders).toBe(1);
    expect(healthSnapshot.walletDrifts).toEqual(["active drift"]);
    expect(healthSnapshot.lastPollAt).toBe(100);
    expect(healthSnapshot.lastError).toBeNull();
  });
});
