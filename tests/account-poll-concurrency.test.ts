import { describe, expect, it } from "vitest";
import { resolveAccountPollConcurrency, runWithConcurrency } from "../src/engine/copy-cycle.js";

describe("mass account poll concurrency", () => {
  it("defaults to one and validates the bounded environment override", () => {
    expect(resolveAccountPollConcurrency(undefined)).toBe(1);
    expect(resolveAccountPollConcurrency("6")).toBe(6);
    expect(() => resolveAccountPollConcurrency("0")).toThrow(/integer from 1 to 32/);
    expect(() => resolveAccountPollConcurrency("33")).toThrow(/integer from 1 to 32/);
  });

  it("never exceeds the requested worker count", async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      completed.push(value);
      active -= 1;
    });
    expect(peak).toBe(3);
    expect(completed.sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
