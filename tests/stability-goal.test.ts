import { describe, expect, it } from "vitest";
import type { PreviewAccountReport, PreviewGoalMetrics } from "../src/sim/preview-report.js";
import { emptyPreviewCopyQuality } from "../src/sim/preview-quality.js";
import { assessStabilityGoal } from "../src/sim/stability-goal.js";

function goalMetrics(): PreviewGoalMetrics {
  const window = (sinceMs: number, pnlUsd: number) => ({
    sinceMs,
    marketCount: 10,
    pnlUsd,
    winRatePct: 80,
    profitFactor: 2.5,
    grossProfitUsd: 5,
    grossLossUsd: 2,
  });
  return {
    observationDays: 16,
    activeTradingDays: 15,
    firstCopyAtMs: 1,
    lastCopyAtMs: Date.now() - 60 * 60_000,
    settledMarketCount: 40,
    copyPnlUsd: 20,
    grossCopyVolumeUsd: 200,
    pnlVolumePct: 10,
    overall: {
      marketCount: 40,
      pnlUsd: 20,
      winRatePct: 75,
      profitFactor: 2.5,
      grossProfitUsd: 50,
      grossLossUsd: 20,
      slippageSampleCount: 190,
      slippageCoveragePct: 95,
      slippageLossPct: 5,
    },
    recent20: {
      marketCount: 20,
      pnlUsd: 8,
      winRatePct: 75,
      profitFactor: 2.2,
      grossProfitUsd: 11,
      grossLossUsd: 5,
      slippageSampleCount: 35,
      slippageCoveragePct: 95,
      slippageLossPct: 8,
    },
    slippage: {
      observationStartedAtMs: 1,
      observationDays: 15,
      copyCount: 200,
      sampleCount: 190,
      totalNotionalUsd: 200,
      sampledNotionalUsd: 190,
      coveragePct: 95,
      lossPct: 5,
    },
    windows: {
      h24: window(1, 1),
      d7: window(1, 5),
      d14: window(1, 10),
    },
  };
}

function report(): PreviewAccountReport {
  const copyQuality = emptyPreviewCopyQuality(180, 0, 0);
  return {
    accountId: "goal-pass",
    dbPath: "/tmp/goal-pass.db",
    copyPriceMode: "executable_guarded",
    exists: true,
    cashUsd: 180,
    openCostUsd: 0,
    openPositions: 0,
    realizedPnlUsd: 20,
    cashReplayDeltaUsd: 0,
    capitalDeltaUsd: 0,
    missingMarketMetadataCount: 0,
    pendingOrderCount: 0,
    liveOrderIntentCount: 0,
    copyCount: 200,
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
    copyQuality: {
      ...copyQuality,
      detected: { buy: 100, sell: 100, redeem: 110, totalTrades: 200 },
      copied: { buy: 100, sell: 100, totalTrades: 200 },
      effectiveDetected: { buy: 100, sell: 100, totalTrades: 200 },
      coverage: { buyPct: 100, sellPct: 100, tradePct: 100 },
      effectiveCoverage: { buyPct: 100, sellPct: 100, tradePct: 100 },
      redeem: { count: 110, payoutUsd: 100, pnlUsd: 20 },
      primaryIssue: {
        code: "healthy",
        severity: "ok",
        label: "healthy",
        detail: "test",
      },
    },
    performance: {
      tradeCount: 110,
      winCount: 83,
      lossCount: 27,
      flatCount: 0,
      totalPnlUsd: 20,
      grossProfitUsd: 50,
      grossLossUsd: 20,
      winRatePct: 75,
      profitFactor: 2.5,
      payoffRatio: 1.2,
      sharpeRatio: 2,
      maxDrawdownUsd: 8,
      maxDrawdownPct: 4,
      largestWinUsd: 2,
      largestLossUsd: -1,
      largestWinContributionPct: 10,
      top3WinContributionPct: 35,
      dependencyIssue: "diversified",
      equityStabilityPct: 96,
      recent: {
        sinceMs: 1,
        tradeCount: 20,
        pnlUsd: 8,
        winRatePct: 75,
        profitFactor: 2.2,
      },
    },
    goalMetrics: goalMetrics(),
  };
}

describe("assessStabilityGoal", () => {
  it("qualifies only a report that meets every screenshot-aligned goal", () => {
    expect(assessStabilityGoal(report())).toMatchObject({
      passed: true,
      status: "qualified",
      failedChecks: [],
    });
  });

  it("does not qualify a 14-day observation with only one active trading day", () => {
    const input = report();
    input.goalMetrics!.activeTradingDays = 1;

    const result = assessStabilityGoal(input);

    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("active_trading_days");
    expect(result.blockers).toContain("活跃交易日 >= 10 天");
    expect(result.thresholds.minActiveTradingDays).toBe(10);
  });

  it("does not qualify enough active days when the last copy is stale", () => {
    const input = report();
    input.goalMetrics!.activeTradingDays = 10;
    input.goalMetrics!.lastCopyAtMs = Date.now() - 25 * 60 * 60_000;

    const result = assessStabilityGoal(input);

    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("last_copy_age");
    expect(result.blockers).toContain("最近 COPY <= 24 小时");
    expect(result.thresholds.maxLastCopyAgeHours).toBe(24);
  });

  it("keeps the goal collecting when the last copy timestamp is missing", () => {
    const input = report();
    input.goalMetrics!.lastCopyAtMs = null;

    const result = assessStabilityGoal(input);

    expect(result.passed).toBe(false);
    expect(result.status).toBe("collecting");
    expect(result.failedChecks).toContain("last_copy_age");
  });

  it("treats unavailable slippage as missing evidence instead of zero loss", () => {
    const input = report();
    input.goalMetrics.slippage = {
      observationStartedAtMs: null,
      observationDays: 0,
      copyCount: 0,
      sampleCount: 0,
      totalNotionalUsd: 0,
      sampledNotionalUsd: 0,
      coveragePct: 0,
      lossPct: null,
    };
    input.goalMetrics.overall.slippageCoveragePct = 0;
    input.goalMetrics.overall.slippageLossPct = null;
    input.goalMetrics.recent20.slippageCoveragePct = 0;
    input.goalMetrics.recent20.slippageLossPct = null;

    const result = assessStabilityGoal(input);

    expect(result.passed).toBe(false);
    expect(result.status).toBe("collecting");
    expect(result.failedChecks).toEqual(
      expect.arrayContaining([
        "slippage_observation_days",
        "overall_slip_coverage",
        "overall_slip",
        "recent20_slip_coverage",
        "recent20_slip",
      ])
    );
  });

  it("keeps exact goal boundaries hard instead of averaging failures away", () => {
    const input = report();
    input.goalMetrics.pnlVolumePct = 6.99;
    input.goalMetrics.overall.profitFactor = 1.99;
    input.goalMetrics.recent20.winRatePct = 69.99;
    input.goalMetrics.windows.d7.pnlUsd = 0;
    input.performance.top3WinContributionPct = 40.01;

    const result = assessStabilityGoal(input);

    expect(result.passed).toBe(false);
    expect(result.status).toBe("not_qualified");
    expect(result.failedChecks).toEqual(
      expect.arrayContaining([
        "profit_factor",
        "recent20_win_rate",
        "pnl_volume",
        "pnl_7d",
        "top3_contribution",
      ])
    );
  });

  it("does not qualify legacy leader-price accounting", () => {
    const input = report();
    input.copyPriceMode = "leader_limit";
    input.redeemCount = 0;
    input.goalMetrics!.observationDays = 0;
    input.goalMetrics!.slippage.observationDays = 0;
    input.goalMetrics!.settledMarketCount = 0;
    input.goalMetrics!.recent20.marketCount = 0;

    const result = assessStabilityGoal(input);

    expect(result.passed).toBe(false);
    expect(result.status).toBe("not_qualified");
    expect(result.failedChecks).toContain("execution_mode");
  });
});
