import { describe, expect, it } from "vitest";
import { calculateCopySlippageLossPct } from "../src/sim/copy-slippage.js";

describe("calculateCopySlippageLossPct", () => {
  it("measures only adverse BUY and SELL movement", () => {
    expect(calculateCopySlippageLossPct("BUY", 0.5, 0.55)).toBe(10);
    expect(calculateCopySlippageLossPct("BUY", 0.5, 0.45)).toBe(0);
    expect(calculateCopySlippageLossPct("SELL", 0.5, 0.45)).toBe(10);
    expect(calculateCopySlippageLossPct("SELL", 0.5, 0.55)).toBe(0);
  });

  it("returns null when either price cannot support a valid observation", () => {
    expect(calculateCopySlippageLossPct("BUY", 0, 0.5)).toBeNull();
    expect(calculateCopySlippageLossPct("BUY", 0.5, null)).toBeNull();
  });
});
