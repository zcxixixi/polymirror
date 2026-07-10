import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_TEST_ACCOUNTS } from "../src/sim/preview-accounts.js";

describe("DEFAULT_PREVIEW_TEST_ACCOUNTS", () => {
  it("covers the full active ceshi parameter sweep", () => {
    expect(DEFAULT_PREVIEW_TEST_ACCOUNTS).toEqual([
      "ceshi",
      "ceshi_fixed1_cap8",
      "ceshi_fixed2_cap12",
      "ceshi_pct5_cap20",
      "ceshi_fixed1_cap6",
      "ceshi_fixed1_cap10",
      "ceshi_fixed15_cap10",
      "ceshi_pct10_cap20",
      "ceshi_pct3_cap20",
      "ceshi_pct5_cap12",
      "ceshi_pct2_cap10",
      "ceshi_pct2_tight8",
      "ceshi_pct1_cap6",
      "ceshi_pct15_cap8",
      "ceshi_pct2_pos8",
      "ceshi_pct1_fresh30s",
      "ceshi_pct3_cap30",
      "ceshi_pct4_cap20",
      "ceshi_pct3_age72_cap30",
      "ceshi_pct4_age72_cap20",
    ]);
  });

  it("does not contain duplicate account ids", () => {
    expect(new Set(DEFAULT_PREVIEW_TEST_ACCOUNTS).size).toBe(
      DEFAULT_PREVIEW_TEST_ACCOUNTS.length
    );
  });
});
