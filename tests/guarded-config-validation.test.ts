import { describe, expect, it } from "vitest";
import { validateRuntime } from "../src/config/load.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

describe("executable_guarded runtime validation", () => {
  it("requires FOK execution", () => {
    const config = previewRuntimeConfig();
    config.wallet.signatureType = 1;
    config.app.global.copyPriceMode = "executable_guarded";
    config.app.global.risk.slippageTolerance = 0.02;
    config.app.global.execution.orderType = "FAK";

    expect(validateRuntime(config)).toBe(
      "copy_price_mode executable_guarded requires execution.order_type=FOK"
    );
  });

  it("accepts guarded execution with positive tolerance and FOK", () => {
    const config = previewRuntimeConfig();
    config.wallet.signatureType = 1;
    config.app.global.copyPriceMode = "executable_guarded";
    config.app.global.risk.slippageTolerance = 0.02;
    config.app.global.execution.orderType = "FOK";

    expect(validateRuntime(config)).toBeNull();
  });

  it("leaves legacy execution settings unchanged", () => {
    const config = previewRuntimeConfig();
    config.wallet.signatureType = 1;
    config.app.global.execution.orderType = "GTC";

    expect(validateRuntime(config)).toBeNull();
  });
});
