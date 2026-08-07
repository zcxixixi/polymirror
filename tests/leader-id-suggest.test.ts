import { describe, expect, it } from "vitest";
import { suggestLeaderId } from "../src/api/discover.js";

describe("suggestLeaderId", () => {
  it("prefers sanitized username", () => {
    expect(suggestLeaderId("@Cool Whale!", "0x" + "a".repeat(40))).toBe("Cool_Whale_");
  });

  it("falls back to address prefix", () => {
    const address = "0xAbCdEf1234567890abcdef1234567890abcdef12";
    expect(suggestLeaderId(undefined, address)).toBe("trader_abcdef12");
    expect(suggestLeaderId("", address)).toBe("trader_abcdef12");
    expect(suggestLeaderId("x", address)).toBe("trader_abcdef12");
  });
});
