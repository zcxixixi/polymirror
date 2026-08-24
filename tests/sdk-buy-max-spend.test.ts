import { describe, expect, it } from "vitest";
import { prepareSdkMarketBuyWithinMaxSpend } from "../src/executor/fees.js";

describe("official SDK BUY maxSpend preview contract", () => {
  it("reduces maker amount so platform fees remain inside the all-in cap", () => {
    expect(prepareSdkMarketBuyWithinMaxSpend({
      requestedAmountUsd: 1,
      maxSpendUsd: 1,
      price: 0.52,
      tickSize: 0.01,
      platformFeeRate: 0.25,
      platformFeeExponent: 2,
    })).toEqual({
      makerAmountUsd: 0.97,
      requestedShares: 1.8654,
      feeUsd: 0.02905368,
      allInSpendUsd: 0.99905368,
    });
  });

  it("keeps fee-free BUYs at the requested amount with SDK tick rounding", () => {
    expect(prepareSdkMarketBuyWithinMaxSpend({
      requestedAmountUsd: 1,
      maxSpendUsd: 1,
      price: 0.52,
      tickSize: 0.01,
      platformFeeRate: 0,
      platformFeeExponent: 0,
    })).toEqual({
      makerAmountUsd: 1,
      requestedShares: 1.9231,
      feeUsd: 0,
      allInSpendUsd: 1,
    });
  });

  it("matches official SDK floating-point rounding at a fee-adjusted cent boundary", () => {
    expect(prepareSdkMarketBuyWithinMaxSpend({
      requestedAmountUsd: 2,
      maxSpendUsd: 2,
      price: 0.15,
      tickSize: 0.01,
      platformFeeRate: 0.25,
      platformFeeExponent: 0,
    })).toEqual({
      makerAmountUsd: 0.74,
      requestedShares: 4.9334,
      feeUsd: 1.23335,
      allInSpendUsd: 1.97335,
    });
  });

  it("fails closed for unsupported tick sizes or an impossible spend", () => {
    expect(() => prepareSdkMarketBuyWithinMaxSpend({
      requestedAmountUsd: 1,
      maxSpendUsd: 1,
      price: 0.52,
      tickSize: 0.003,
      platformFeeRate: 0.25,
      platformFeeExponent: 2,
    })).toThrow(/unsupported tick/i);
    expect(() => prepareSdkMarketBuyWithinMaxSpend({
      requestedAmountUsd: 1,
      maxSpendUsd: 0.001,
      price: 0.52,
      tickSize: 0.01,
      platformFeeRate: 0.25,
      platformFeeExponent: 2,
    })).toThrow(/maker amount/i);
  });
});
