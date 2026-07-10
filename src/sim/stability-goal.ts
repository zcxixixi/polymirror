import type { PreviewAccountReport } from "./preview-report.js";

export type StabilityGoalStatus = "qualified" | "collecting" | "not_qualified";

export interface StabilityGoalThresholds {
  minObservationDays: number;
  minRedeemCount: number;
  minSettledMarkets: number;
  minOverallWinRatePct: number;
  minRecent20Markets: number;
  minRecent20WinRatePct: number;
  minProfitFactor: number;
  maxOverallSlipPct: number;
  maxRecent20SlipPct: number;
  targetRecent20SlipPct: number;
  minSlipCoveragePct: number;
  minPnlVolumePct: number;
  minEquityStabilityPct: number;
  maxDrawdownPct: number;
  maxTop3WinContributionPct: number;
}

export interface StabilityGoalCheck {
  key: string;
  label: string;
  passed: boolean;
  actual: number | null;
  target: number;
  comparator: ">=" | "<=" | ">" | "=";
}

export interface StabilityGoalAssessment {
  passed: boolean;
  status: StabilityGoalStatus;
  failedChecks: string[];
  blockers: string[];
  warnings: string[];
  checks: StabilityGoalCheck[];
  thresholds: StabilityGoalThresholds;
}

export interface StabilityGoalEvidence {
  recentErrorCount?: number;
}

const DEFAULT_THRESHOLDS: StabilityGoalThresholds = {
  minObservationDays: 14,
  minRedeemCount: 100,
  minSettledMarkets: 30,
  minOverallWinRatePct: 70,
  minRecent20Markets: 20,
  minRecent20WinRatePct: 70,
  minProfitFactor: 2,
  maxOverallSlipPct: 10,
  maxRecent20SlipPct: 15,
  targetRecent20SlipPct: 10,
  minSlipCoveragePct: 90,
  minPnlVolumePct: 7,
  minEquityStabilityPct: 95,
  maxDrawdownPct: 5,
  maxTop3WinContributionPct: 40,
};

function check(
  key: string,
  label: string,
  actual: number | null,
  target: number,
  comparator: StabilityGoalCheck["comparator"],
  passed: boolean
): StabilityGoalCheck {
  return { key, label, actual, target, comparator, passed };
}

function profitFactorPass(
  value: number | null,
  grossProfitUsd: number,
  grossLossUsd: number,
  minimum: number
): boolean {
  if (value !== null) return value >= minimum;
  return grossProfitUsd > 0 && grossLossUsd === 0;
}

export function assessStabilityGoal(
  report: PreviewAccountReport,
  thresholds: Partial<StabilityGoalThresholds> = {},
  evidence: StabilityGoalEvidence = {}
): StabilityGoalAssessment {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const goal = report.goalMetrics;
  if (!goal) {
    return {
      passed: false,
      status: "collecting",
      failedChecks: ["goal_metrics"],
      blockers: ["Goal 指标尚未生成"],
      warnings: [],
      checks: [check("goal_metrics", "Goal 指标可用", 0, 1, "=", false)],
      thresholds: t,
    };
  }

  const recentErrorCount =
    evidence.recentErrorCount ?? report.recentWindow?.errorCount ?? report.errorCount;
  const unclassifiedCopyGap =
    report.copyQuality.copyGap.buy.unclassified +
    report.copyQuality.copyGap.sell.unclassified;
  const copyPathComplete =
    report.copyQuality.copied.buy > 0 &&
    report.copyQuality.copied.sell > 0 &&
    report.copyQuality.redeem.count > 0 &&
    unclassifiedCopyGap === 0;
  const accountingClean =
    Math.abs(report.cashReplayDeltaUsd) <= 0.01 &&
    Math.abs(report.capitalDeltaUsd) <= 0.5 &&
    report.missingMarketMetadataCount === 0;
  const pendingClean =
    report.pendingOrderCount === 0 && report.liveOrderIntentCount === 0;
  const executableGuarded = report.copyPriceMode === "executable_guarded";
  const overallSlip = goal.slippage.lossPct;
  const recent20Slip = goal.recent20.slippageLossPct;

  const checks: StabilityGoalCheck[] = [
    check(
      "execution_mode",
      "执行价模式为 executable_guarded",
      executableGuarded ? 1 : 0,
      1,
      "=",
      executableGuarded
    ),
    check(
      "observation_days",
      `观察期 >= ${t.minObservationDays} 天`,
      goal.observationDays,
      t.minObservationDays,
      ">=",
      goal.observationDays >= t.minObservationDays
    ),
    check(
      "slippage_observation_days",
      `真实 Slip 观察期 >= ${t.minObservationDays} 天`,
      goal.slippage.observationDays,
      t.minObservationDays,
      ">=",
      goal.slippage.observationDays >= t.minObservationDays
    ),
    check(
      "redeem_sample",
      `REDEEM >= ${t.minRedeemCount}`,
      report.redeemCount,
      t.minRedeemCount,
      ">=",
      report.redeemCount >= t.minRedeemCount
    ),
    check(
      "settled_markets",
      `已结算市场 >= ${t.minSettledMarkets}`,
      goal.settledMarketCount,
      t.minSettledMarkets,
      ">=",
      goal.settledMarketCount >= t.minSettledMarkets
    ),
    check("copy_pnl", "COPY PnL > 0", goal.copyPnlUsd, 0, ">", goal.copyPnlUsd > 0),
    check(
      "overall_win_rate",
      `整体胜率 >= ${t.minOverallWinRatePct}%`,
      goal.overall.winRatePct,
      t.minOverallWinRatePct,
      ">=",
      goal.overall.winRatePct >= t.minOverallWinRatePct
    ),
    check(
      "profit_factor",
      `Profit Factor >= ${t.minProfitFactor}`,
      goal.overall.profitFactor,
      t.minProfitFactor,
      ">=",
      profitFactorPass(
        goal.overall.profitFactor,
        goal.overall.grossProfitUsd,
        goal.overall.grossLossUsd,
        t.minProfitFactor
      )
    ),
    check(
      "recent20_sample",
      `最近样本 >= ${t.minRecent20Markets} 个市场`,
      goal.recent20.marketCount,
      t.minRecent20Markets,
      ">=",
      goal.recent20.marketCount >= t.minRecent20Markets
    ),
    check(
      "recent20_pnl",
      "最近 20 市场 PnL > 0",
      goal.recent20.pnlUsd,
      0,
      ">",
      goal.recent20.pnlUsd > 0
    ),
    check(
      "recent20_win_rate",
      `最近 20 市场胜率 >= ${t.minRecent20WinRatePct}%`,
      goal.recent20.winRatePct,
      t.minRecent20WinRatePct,
      ">=",
      goal.recent20.winRatePct >= t.minRecent20WinRatePct
    ),
    check(
      "overall_slip_coverage",
      `整体 Slip 覆盖率 >= ${t.minSlipCoveragePct}%`,
      goal.slippage.coveragePct,
      t.minSlipCoveragePct,
      ">=",
      goal.slippage.coveragePct >= t.minSlipCoveragePct
    ),
    check(
      "overall_slip",
      `整体 Slip <= ${t.maxOverallSlipPct}%`,
      overallSlip,
      t.maxOverallSlipPct,
      "<=",
      overallSlip !== null && overallSlip <= t.maxOverallSlipPct
    ),
    check(
      "recent20_slip_coverage",
      `最近 20 Slip 覆盖率 >= ${t.minSlipCoveragePct}%`,
      goal.recent20.slippageCoveragePct,
      t.minSlipCoveragePct,
      ">=",
      goal.recent20.slippageCoveragePct >= t.minSlipCoveragePct
    ),
    check(
      "recent20_slip",
      `最近 20 Slip <= ${t.maxRecent20SlipPct}%`,
      recent20Slip,
      t.maxRecent20SlipPct,
      "<=",
      recent20Slip !== null && recent20Slip <= t.maxRecent20SlipPct
    ),
    check(
      "pnl_volume",
      `PnL/Volume >= ${t.minPnlVolumePct}%`,
      goal.pnlVolumePct,
      t.minPnlVolumePct,
      ">=",
      goal.pnlVolumePct >= t.minPnlVolumePct
    ),
    check(
      "equity_stability",
      `权益稳定率 >= ${t.minEquityStabilityPct}%`,
      report.performance.equityStabilityPct,
      t.minEquityStabilityPct,
      ">=",
      report.performance.equityStabilityPct >= t.minEquityStabilityPct
    ),
    check(
      "max_drawdown",
      `最大回撤 <= ${t.maxDrawdownPct}%`,
      report.performance.maxDrawdownPct,
      t.maxDrawdownPct,
      "<=",
      report.performance.maxDrawdownPct <= t.maxDrawdownPct
    ),
    check(
      "top3_contribution",
      `Top 3 盈利贡献 <= ${t.maxTop3WinContributionPct}%`,
      report.performance.top3WinContributionPct,
      t.maxTop3WinContributionPct,
      "<=",
      report.performance.top3WinContributionPct <= t.maxTop3WinContributionPct
    ),
    check(
      "pnl_24h",
      "24h PnL > 0",
      goal.windows.h24.pnlUsd,
      0,
      ">",
      goal.windows.h24.pnlUsd > 0
    ),
    check(
      "pnl_7d",
      "7d PnL > 0",
      goal.windows.d7.pnlUsd,
      0,
      ">",
      goal.windows.d7.pnlUsd > 0
    ),
    check(
      "pnl_14d",
      "14d PnL > 0",
      goal.windows.d14.pnlUsd,
      0,
      ">",
      goal.windows.d14.pnlUsd > 0
    ),
    check("copy_path", "COPY/SELL/REDEEM 路径完整", copyPathComplete ? 1 : 0, 1, "=", copyPathComplete),
    check("accounting", "账本对账干净", accountingClean ? 1 : 0, 1, "=", accountingClean),
    check("pending_state", "无 pending 恢复状态", pendingClean ? 1 : 0, 1, "=", pendingClean),
    check("errors", "无近期 ERROR", recentErrorCount, 0, "=", recentErrorCount === 0),
    check("kill_switch", "Kill switch 关闭", report.killSwitch ? 1 : 0, 0, "=", !report.killSwitch),
    check(
      "profit_dependency",
      "收益不依赖少数大单",
      report.performance.dependencyIssue === "diversified" ? 1 : 0,
      1,
      "=",
      report.performance.dependencyIssue === "diversified"
    ),
  ];

  const failed = checks.filter((entry) => !entry.passed);
  const failedChecks = failed.map((entry) => entry.key);
  const evidenceChecks = new Set([
    "observation_days",
    "slippage_observation_days",
    "redeem_sample",
    "settled_markets",
    "recent20_sample",
    "overall_slip_coverage",
    "recent20_slip_coverage",
  ]);
  const sampleEvidenceIncomplete = failed.some(
    (entry) =>
      evidenceChecks.has(entry.key) ||
      (entry.key === "overall_slip" && overallSlip === null) ||
      (entry.key === "recent20_slip" && recent20Slip === null)
  );
  const matureOverall = goal.settledMarketCount >= t.minSettledMarkets;
  const matureRecent20 = goal.recent20.marketCount >= t.minRecent20Markets;
  const hasHardFailure =
    !executableGuarded ||
    !accountingClean ||
    !pendingClean ||
    recentErrorCount > 0 ||
    report.killSwitch ||
    report.copyQuality.primaryIssue.code === "safety_blocker" ||
    unclassifiedCopyGap > 0 ||
    goal.copyPnlUsd < 0 ||
    (matureOverall && goal.copyPnlUsd <= 0) ||
    (matureOverall && goal.overall.winRatePct < t.minOverallWinRatePct) ||
    (matureOverall &&
      !profitFactorPass(
        goal.overall.profitFactor,
        goal.overall.grossProfitUsd,
        goal.overall.grossLossUsd,
        t.minProfitFactor
      )) ||
    (matureOverall && goal.pnlVolumePct < t.minPnlVolumePct) ||
    (matureOverall && report.performance.equityStabilityPct < t.minEquityStabilityPct) ||
    (report.performance.tradeCount > 0 &&
      report.performance.maxDrawdownPct > t.maxDrawdownPct) ||
    (matureOverall &&
      report.performance.top3WinContributionPct > t.maxTop3WinContributionPct) ||
    (matureOverall && report.performance.dependencyIssue === "concentrated") ||
    (matureRecent20 && goal.recent20.pnlUsd <= 0) ||
    (matureRecent20 && goal.recent20.winRatePct < t.minRecent20WinRatePct) ||
    (goal.slippage.coveragePct >= t.minSlipCoveragePct &&
      overallSlip !== null &&
      overallSlip > t.maxOverallSlipPct) ||
    (goal.recent20.slippageCoveragePct >= t.minSlipCoveragePct &&
      recent20Slip !== null &&
      recent20Slip > t.maxRecent20SlipPct) ||
    (goal.windows.h24.marketCount > 0 && goal.windows.h24.pnlUsd < 0) ||
    (goal.windows.d7.marketCount > 0 && goal.windows.d7.pnlUsd < 0) ||
    (goal.windows.d14.marketCount > 0 && goal.windows.d14.pnlUsd < 0);
  const passed = failed.length === 0;
  const warnings: string[] = [];
  if (
    recent20Slip !== null &&
    recent20Slip > t.targetRecent20SlipPct &&
    recent20Slip <= t.maxRecent20SlipPct
  ) {
    warnings.push(`最近 20 Slip 已过硬门槛，但仍高于 ${t.targetRecent20SlipPct}% 目标`);
  }

  return {
    passed,
    status:
      passed
        ? "qualified"
        : sampleEvidenceIncomplete && !hasHardFailure
          ? "collecting"
          : "not_qualified",
    failedChecks,
    blockers: failed.map((entry) => entry.label),
    warnings,
    checks,
    thresholds: t,
  };
}
