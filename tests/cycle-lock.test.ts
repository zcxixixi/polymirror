import { describe, expect, it, beforeEach } from "vitest";
import {
  tryBeginCycle,
  endCycle,
  withReloadLock,
  resetCycleLockForTests,
  enterMaintenance,
  exitMaintenance,
  isMaintenanceActive,
  waitForCycleIdle,
} from "../src/engine/cycle-lock.js";

describe("cycle-lock", () => {
  beforeEach(() => {
    resetCycleLockForTests();
  });

  it("blocks overlapping cycles", () => {
    expect(tryBeginCycle()).toBe(true);
    expect(tryBeginCycle()).toBe(false);
    endCycle();
    expect(tryBeginCycle()).toBe(true);
    endCycle();
  });

  it("blocks cycles while reload is waiting/running", async () => {
    expect(tryBeginCycle()).toBe(true);

    let reloadStarted = false;
    const reload = withReloadLock(async () => {
      reloadStarted = true;
      return 42;
    });

    // Reload waits for the cycle; new cycles must not start.
    await new Promise((r) => setTimeout(r, 30));
    expect(reloadStarted).toBe(false);
    expect(tryBeginCycle()).toBe(false);

    endCycle();
    await expect(reload).resolves.toBe(42);
    expect(reloadStarted).toBe(true);
  });

  it("serializes concurrent reload sections (single-flight)", async () => {
    const order: number[] = [];
    const a = withReloadLock(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 40));
      order.push(2);
      return "a";
    });
    const b = withReloadLock(async () => {
      order.push(3);
      return "b";
    });
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("maintenance blocks new poll cycles and config reload", async () => {
    enterMaintenance();
    expect(isMaintenanceActive()).toBe(true);
    expect(tryBeginCycle()).toBe(false);
    await expect(withReloadLock(async () => "x")).rejects.toThrow(/maintenance/i);
    exitMaintenance();
    expect(isMaintenanceActive()).toBe(false);
    expect(tryBeginCycle()).toBe(true);
    endCycle();
  });

  it("waitForCycleIdle resolves after endCycle", async () => {
    expect(tryBeginCycle()).toBe(true);
    const waiter = waitForCycleIdle(5_000);
    setTimeout(() => endCycle(), 20);
    await expect(waiter).resolves.toBeUndefined();
  });
});
