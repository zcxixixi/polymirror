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
    expect(healthSnapshot.enabledAccountCount).toBe(1);
    expect(healthSnapshot.polledAccountCount).toBe(0);
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

  it("keeps an error from any enabled account even when a later account is healthy", () => {
    const accounts = [
      {
        enabled: true,
        health: health(["errored"], {
          lastPollAt: 100,
          lastError: "leader poll failed",
        }),
      },
      {
        enabled: true,
        health: health(["healthy"], {
          lastPollAt: 200,
          lastError: null,
        }),
      },
    ];

    syncAggregateHealth(accounts);

    expect(healthSnapshot.lastPollAt).toBe(200);
    expect(healthSnapshot.lastError).toBe("leader poll failed");
    expect(healthSnapshot.enabledAccountCount).toBe(2);
    expect(healthSnapshot.polledAccountCount).toBe(2);
  });
});
