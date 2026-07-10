import { describe, expect, it } from "vitest";
import type { PreviewAccountReport } from "../src/sim/preview-report.js";
import { assessStrategyRisk } from "../src/sim/strategy-risk.js";
import { emptyPreviewCopyQuality } from "../src/sim/preview-quality.js";

function report(overrides: Partial<PreviewAccountReport>): PreviewAccountReport {
  return {
    accountId: "acct",
    dbPath: "/tmp/acct.db",
    exists: true,
    cashUsd: 160,
    openCostUsd: 40,
    openPositions: 4,
    realizedPnlUsd: 0,
    cashReplayDeltaUsd: 0,
    capitalDeltaUsd: 0,
    missingMarketMetadataCount: 0,
    pendingOrderCount: 0,
    liveOrderIntentCount: 0,
    copyCount: 20,
    redeemCount: 10,
    errorCount: 0,
    skipCount: 0,
    priceFilteredSkipCount: 0,
    cashStarvedSkipCount: 0,
    positionCapSkipCount: 0,
    maxOpenMarketSkipCount: 0,
    noLocalRedeemSkipCount: 0,
    unmatchedRedeemSkipCount: 0,
    killSwitch: false,
    skipReasons: [],
    recentRedeems: [],
    recentErrors: [],
    openMarkets: [],
    recentWindow: {
      sinceMs: 1,
      copyCount: 20,
      redeemCount: 10,
      errorCount: 0,
      skipCount: 0,
      priceFilteredSkipCount: 0,
      cashStarvedSkipCount: 0,
      positionCapSkipCount: 0,
      maxOpenMarketSkipCount: 0,
      noLocalRedeemSkipCount: 0,
      unmatchedRedeemSkipCount: 0,
    },
    ...overrides,
  };
}

describe("assessStrategyRisk", () => {
  it("uses current cost-basis equity for compounding risk budgets", () => {
    const result = assessStrategyRisk(
      report({
        cashUsd: 700,
        openCostUsd: 300,
        realizedPnlUsd: 800,
      })
    );

    expect(result.initialCapitalUsd).toBe(200);
    expect(result.currentCapitalUsd).toBe(1000);
    expect(result.suggestedMaxOrderUsd).toBe(20);
    expect(result.decision).toBe("scale_up");
  });

  it("hard-retires accounts with safety blockers regardless of profit", () => {
    const result = assessStrategyRisk(
      report({
        realizedPnlUsd: 120,
        killSwitch: true,
        pendingOrderCount: 1,
      })
    );

    expect(result.riskLevel).toBe("hard_stop");
    expect(result.decision).toBe("retire");
    expect(result.suggestedMaxOrderUsd).toBe(0);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["kill switch active", "pending recovery state present"])
    );
  });

  it("penalizes mature negative strategies even when accounting is clean", () => {
    const result = assessStrategyRisk(
      report({
        realizedPnlUsd: -60,
        copyCount: 120,
        redeemCount: 25,
      })
    );

    expect(result.riskLevel).toBe("high");
    expect(result.decision).toBe("retire");
    expect(result.reasons).toContain("mature negative pnl");
  });

  it("retires mature accounts marked as losing by copy quality", () => {
    const result = assessStrategyRisk(
      report({
        realizedPnlUsd: -2,
        copyCount: 120,
        redeemCount: 25,
        copyQuality: {
          ...emptyPreviewCopyQuality(140, 60, 8),
          primaryIssue: {
            code: "strategy_losing",
            severity: "danger",
            label: "该策略本身亏",
            detail: "settled sample is negative",
          },
        },
      })
    );

    expect(result.decision).toBe("retire");
    expect(result.reasons).toContain("copy quality indicates losing strategy");
  });
});
