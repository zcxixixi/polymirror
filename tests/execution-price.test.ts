import { describe, expect, it } from "vitest";
import { globalYamlSchema } from "../src/config/document.js";
import { validateRuntime } from "../src/config/load.js";
import {
  prepareExecutableGuardedOrder,
  prepareGuardedOrderTerms,
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
      orderShares: 1.93,
      slippagePct: 2,
    });
    expect(result.orderUsd).toBeCloseTo(1.0036, 4);
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
    ).toMatchObject({ allow: true, orderPrice: 0.52, orderShares: 1.93 });
    expect(
      prepareGuardedOrderTerms({
        side: "SELL",
        leaderPrice: 0.5,
        targetUsd: 1,
        minOrderUsd: 1,
        absoluteTolerance: 0.025,
        tickSize: 0.01,
      })
    ).toMatchObject({ allow: true, orderPrice: 0.48, orderShares: 2.09 });
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
