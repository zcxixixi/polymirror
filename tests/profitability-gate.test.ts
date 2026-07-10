import { describe, expect, it } from "vitest";
import type { PreviewAccountReport } from "../src/sim/preview-report.js";
import { emptyPreviewCopyQuality } from "../src/sim/preview-quality.js";
import { assessProfitabilityGate } from "../src/sim/profitability-gate.js";

function report(
  overrides: Partial<PreviewAccountReport> = {}
): PreviewAccountReport {
  return {
    accountId: "stable",
    dbPath: "/tmp/stable.db",
    exists: true,
    cashUsd: 170,
    openCostUsd: 25,
    openPositions: 6,
    realizedPnlUsd: 19.21,
    cashReplayDeltaUsd: 0,
    capitalDeltaUsd: 0,
    missingMarketMetadataCount: 0,
    pendingOrderCount: 0,
    liveOrderIntentCount: 0,
    copyCount: 162,
    redeemCount: 110,
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
      copyCount: 42,
      redeemCount: 24,
      errorCount: 0,
      skipCount: 0,
      priceFilteredSkipCount: 0,
      cashStarvedSkipCount: 0,
      positionCapSkipCount: 0,
      maxOpenMarketSkipCount: 0,
      noLocalRedeemSkipCount: 0,
      unmatchedRedeemSkipCount: 0,
    },
    copyQuality: {
      ...emptyPreviewCopyQuality(170, 25, 6),
      primaryIssue: {
        code: "healthy",
        severity: "ok",
        label: "复制质量正常",
        detail: "test",
      },
    },
    performance: {
      tradeCount: 110,
      winCount: 88,
      lossCount: 22,
      flatCount: 0,
      totalPnlUsd: 19.21,
      grossProfitUsd: 48,
      grossLossUsd: 28.79,
      winRatePct: 80,
      profitFactor: 1.67,
      payoffRatio: 1.2,
      sharpeRatio: 1.84,
      maxDrawdownUsd: 6.48,
      maxDrawdownPct: 3.24,
      largestWinUsd: 2.4,
      largestLossUsd: -1.8,
      largestWinContributionPct: 12.49,
      top3WinContributionPct: 28,
      dependencyIssue: "diversified",
      equityStabilityPct: 96.76,
      recent: {
        sinceMs: 1,
        tradeCount: 24,
        pnlUsd: 5.4,
        winRatePct: 75,
        profitFactor: 1.55,
      },
    },
    ...overrides,
  };
}

describe("assessProfitabilityGate", () => {
  it("promotes mature stable profit metrics to live_candidate", () => {
    expect(assessProfitabilityGate(report())).toMatchObject({
      grade: "live_candidate",
      passed: true,
      sample: {
        settledTrades: 110,
        copyTrades: 162,
      },
      blockers: [],
    });
  });

  it("treats low payoff as a warning when aggregate profit quality is strong", () => {
    const gate = assessProfitabilityGate(
      report({
        performance: {
          ...report().performance,
          payoffRatio: 0.46,
          profitFactor: 1.78,
          winRatePct: 79.66,
          sharpeRatio: 2.19,
          maxDrawdownPct: 3.24,
          equityStabilityPct: 96.76,
        },
      })
    );

    expect(gate.grade).toBe("live_candidate");
    expect(gate.passed).toBe(true);
    expect(gate.blockers).not.toContain("payoff ratio below live gate");
    expect(gate.warnings).toContain("payoff ratio below live gate");
  });

  it("blocks live promotion when the quality window has no effective copy sample", () => {
    const gate = assessProfitabilityGate(
      report({
        copyQuality: {
          ...emptyPreviewCopyQuality(170, 25, 6),
          primaryIssue: {
            code: "no_data",
            severity: "info",
            label: "暂无样本",
            detail: "test",
          },
        },
      })
    );

    expect(gate.grade).toBe("watch");
    expect(gate.passed).toBe(false);
    expect(gate.blockers).toContain("copy quality has no effective sample");
  });

  it("keeps profitable but immature samples below live_candidate", () => {
    const gate = assessProfitabilityGate(
      report({
        redeemCount: 18,
        copyCount: 35,
        performance: {
          ...report().performance,
          tradeCount: 18,
          recent: {
            sinceMs: 1,
            tradeCount: 8,
            pnlUsd: 3,
            winRatePct: 75,
            profitFactor: 1.7,
          },
        },
      })
    );

    expect(gate.grade).toBe("candidate");
    expect(gate.passed).toBe(false);
    expect(gate.blockers).toContain("settled trade sample below live gate");
  });

  it("rejects accounts with safety or accounting blockers before metric scoring", () => {
    const gate = assessProfitabilityGate(
      report({
        errorCount: 1,
        recentWindow: {
          ...report().recentWindow!,
          errorCount: 1,
        },
        pendingOrderCount: 1,
        copyQuality: {
          ...report().copyQuality,
          primaryIssue: {
            code: "safety_blocker",
            severity: "danger",
            label: "安全或账本异常",
            detail: "test",
          },
        },
      })
    );

    expect(gate.grade).toBe("reject");
    expect(gate.passed).toBe(false);
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        "errors present",
        "pending recovery state present",
        "copy quality safety blocker",
      ])
    );
  });

  it("does not block live promotion on old errors outside the quality window", () => {
    const gate = assessProfitabilityGate(
      report({
        errorCount: 1,
        recentWindow: {
          ...report().recentWindow!,
          errorCount: 0,
        },
      })
    );

    expect(gate.grade).toBe("live_candidate");
    expect(gate.passed).toBe(true);
    expect(gate.blockers).not.toContain("errors present");
  });

  it("rejects profit that depends on a few large wins", () => {
    const gate = assessProfitabilityGate(
      report({
        performance: {
          ...report().performance,
          largestWinContributionPct: 82,
          top3WinContributionPct: 94,
          dependencyIssue: "concentrated",
        },
      })
    );

    expect(gate.grade).toBe("reject");
    expect(gate.blockers).toContain("profit depends on too few large wins");
  });

  it("blocks live promotion when risk-adjusted metrics miss thresholds", () => {
    const gate = assessProfitabilityGate(
      report({
        performance: {
          ...report().performance,
          sharpeRatio: 0.9,
          profitFactor: 1.12,
          winRatePct: 54,
          payoffRatio: 0.82,
          maxDrawdownPct: 8.5,
          equityStabilityPct: 91.5,
          recent: {
            sinceMs: 1,
            tradeCount: 18,
            pnlUsd: -1.2,
            winRatePct: 44,
            profitFactor: 0.7,
          },
        },
      })
    );

    expect(gate.grade).toBe("watch");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        "sharpe below live gate",
        "profit factor below live gate",
        "win rate below live gate",
        "payoff ratio below live gate",
        "max drawdown above live gate",
        "recent pnl is negative",
      ])
    );
  });
});
