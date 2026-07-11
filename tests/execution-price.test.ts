import { describe, expect, it } from "vitest";
import { globalYamlSchema } from "../src/config/document.js";
import { validateRuntime } from "../src/config/load.js";
import {
  prepareExecutableGuardedOrder,
  prepareGuardedOrderTerms,
  resolveAbsoluteSlippageTolerance,
  submittedBuyOrderUsd,
} from "../src/engine/execution-price.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

describe("prepareExecutableGuardedOrder", () => {
  it("uses a conservative marketable BUY limit while preserving fixed notional", () => {
    const result = prepareExecutableGuardedOrder({
      side: "BUY",
      leaderPrice: 0.5,
      executablePrice: 0.51,
      targetUsd: 1,
      minOrderUsd: 1,
      absoluteTolerance: 0.02,
    });

    expect(result).toMatchObject({
      allow: true,
      orderPrice: 0.52,
      orderShares: 1.92,
      slippagePct: 2,
    });
    expect(result.orderUsd).toBe(1);
  });

  it("preserves SELL target shares instead of resizing at the guarded limit", () => {
    const result = prepareExecutableGuardedOrder({
      side: "SELL",
      leaderPrice: 0.5,
      executablePrice: 0.49,
      targetUsd: 1,
      targetShares: 2,
      minOrderUsd: 1,
      absoluteTolerance: 0.02,
      tickSize: 0.01,
    });

    expect(result).toMatchObject({
      allow: true,
      orderPrice: 0.48,
      orderShares: 2,
      orderUsd: 0.96,
    });
  });

  it("allows favorable movement and rejects only adverse movement beyond tolerance", () => {
    expect(
      prepareExecutableGuardedOrder({
        side: "BUY",
        leaderPrice: 0.5,
        executablePrice: 0.45,
        targetUsd: 1,
        minOrderUsd: 1,
        absoluteTolerance: 0.02,
      })
    ).toMatchObject({ allow: true, orderPrice: 0.52, slippagePct: 0 });

    expect(
      prepareExecutableGuardedOrder({
        side: "BUY",
        leaderPrice: 0.5,
        executablePrice: 0.53,
        targetUsd: 1,
        minOrderUsd: 1,
        absoluteTolerance: 0.02,
      })
    ).toMatchObject({ allow: false, slippagePct: 6 });
  });

  it("refuses guarded execution when the order book quote is unavailable", () => {
    expect(
      prepareExecutableGuardedOrder({
        side: "SELL",
        leaderPrice: 0.5,
        executablePrice: null,
        targetUsd: 1,
        targetShares: 2,
        minOrderUsd: 1,
        absoluteTolerance: 0.02,
      })
    ).toMatchObject({ allow: false, reason: "executable price unavailable" });
  });

  it("refuses an out-of-range order book quote", () => {
    expect(
      prepareExecutableGuardedOrder({
        side: "SELL",
        leaderPrice: 0.5,
        executablePrice: 1.1,
        targetUsd: 1,
        targetShares: 2,
        minOrderUsd: 1,
        absoluteTolerance: 0.02,
      })
    ).toMatchObject({ allow: false, reason: "executable price unavailable" });
  });

  it("aligns guarded limits to the market tick without crossing tolerance", () => {
    expect(
      prepareGuardedOrderTerms({
        side: "BUY",
        leaderPrice: 0.5,
        targetUsd: 1,
        minOrderUsd: 1,
        absoluteTolerance: 0.025,
        tickSize: 0.01,
      })
    ).toMatchObject({ allow: true, orderPrice: 0.52, orderShares: 1.92 });
    expect(
      prepareGuardedOrderTerms({
        side: "SELL",
        leaderPrice: 0.5,
        targetUsd: 1,
        targetShares: 2,
        minOrderUsd: 1,
        absoluteTolerance: 0.025,
        tickSize: 0.01,
      })
    ).toMatchObject({ allow: true, orderPrice: 0.48, orderShares: 2 });
  });

  it("caps BUY share quantization at the immutable max order", () => {
    expect(prepareGuardedOrderTerms({
      side: "BUY",
      leaderPrice: 0.5,
      targetUsd: 1,
      minOrderUsd: 1,
      maxOrderUsd: 1,
      absoluteTolerance: 0.02,
      tickSize: 0.01,
    })).toMatchObject({
      allow: true,
      orderPrice: 0.52,
      orderShares: 1.92,
      orderUsd: 1,
    });
  });

  it("enforces min and max against the exact BUY cents submitted to the SDK", () => {
    const halfCent = prepareGuardedOrderTerms({
      side: "BUY",
      leaderPrice: 0.5,
      targetUsd: 1,
      minOrderUsd: 1,
      maxOrderUsd: 1,
      absoluteTolerance: 0.0155,
      tickSize: 0.0001,
    });
    expect(halfCent).toMatchObject({
      allow: true,
      orderPrice: 0.5155,
      orderShares: 1.94,
      orderUsd: 1,
    });
    expect(submittedBuyOrderUsd(halfCent.orderPrice!, halfCent.orderShares)).toBe(1);

    const nonCentMax = prepareGuardedOrderTerms({
      side: "BUY",
      leaderPrice: 0.0475,
      targetUsd: 1.005,
      minOrderUsd: 1,
      maxOrderUsd: 1.005,
      absoluteTolerance: 0.0025,
      tickSize: 0.0025,
    });
    expect(nonCentMax).toMatchObject({ allow: true, orderPrice: 0.05, orderUsd: 1 });
    expect(nonCentMax.orderShares).toBeLessThan(20.1);
    expect(submittedBuyOrderUsd(nonCentMax.orderPrice!, nonCentMax.orderShares))
      .toBeLessThanOrEqual(1.005);
  });

  it("fails closed when no submitted cent amount can satisfy min and max", () => {
    expect(prepareGuardedOrderTerms({
      side: "BUY",
      leaderPrice: 0.0475,
      targetUsd: 1.003,
      minOrderUsd: 1.001,
      maxOrderUsd: 1.005,
      absoluteTolerance: 0.0025,
      tickSize: 0.0025,
    })).toMatchObject({ allow: false, reason: "guarded order has no feasible cent amount" });
  });

  it("keeps legacy absolute points distinct from relative percent tolerance", () => {
    expect(resolveAbsoluteSlippageTolerance(0.2, 0.04, "absolute_price"))
      .toBe(0.04);
    expect(resolveAbsoluteSlippageTolerance(0.2, 0.04, "relative_pct"))
      .toBeCloseTo(0.008, 8);
  });
});

describe("copy price mode config", () => {
  it("defaults to legacy mode and accepts executable_guarded explicitly", () => {
    const requiredSections = { risk: {}, execution: {}, conflict: {} };

    expect((globalYamlSchema.parse(requiredSections) as Record<string, unknown>).copy_price_mode).toBe(
      "leader_limit"
    );
    expect(
      (globalYamlSchema.parse({
        ...requiredSections,
        copy_price_mode: "executable_guarded",
      }) as Record<string, unknown>)
        .copy_price_mode
    ).toBe("executable_guarded");
    expect(globalYamlSchema.parse(requiredSections).risk.slippage_tolerance_mode)
      .toBe("absolute_price");
    expect(globalYamlSchema.parse({
      ...requiredSections,
      risk: { slippage_tolerance_mode: "relative_pct" },
    }).risk.slippage_tolerance_mode).toBe("relative_pct");
  });

  it("requires a positive tolerance for executable_guarded", () => {
    const config = previewRuntimeConfig();
    config.wallet.signatureType = 1;
    config.app.global.copyPriceMode = "executable_guarded";
    config.app.global.risk.slippageTolerance = 0;

    expect(validateRuntime(config)).toBe(
      "copy_price_mode executable_guarded requires a positive slippage_tolerance"
    );
  });
});
