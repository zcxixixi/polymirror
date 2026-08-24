import type { PreviewAccountReport } from "./preview-report.js";

export type ProfitabilityGateGrade =
  | "live_candidate"
  | "candidate"
  | "watch"
  | "reject";

export interface ProfitabilityGateThresholds {
  minLiveSettledTrades: number;
  minLiveCopyTrades: number;
  minCandidateSettledTrades: number;
  minLivePnlUsd: number;
  minLiveSharpeRatio: number;
  minLiveProfitFactor: number;
  minLiveWinRatePct: number;
  minLivePayoffRatio: number;
  maxLiveDrawdownPct: number;
  minLiveEquityStabilityPct: number;
  maxLiveTop3WinContributionPct: number;
  maxRejectDrawdownPct: number;
}

export interface ProfitabilityGateAssessment {
  grade: ProfitabilityGateGrade;
  passed: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
  sample: {
    settledTrades: number;
    copyTrades: number;
    recentSettledTrades: number;
  };
  metrics: {
    realizedPnlUsd: number;
    sharpeRatio: number | null;
    profitFactor: number | null;
    winRatePct: number;
    payoffRatio: number | null;
    maxDrawdownPct: number;
    dependencyIssue: string;
    equityStabilityPct: number;
    top3WinningConditionGrossProfitSharePct: number | null;
    conditionMappingCoveragePct: number;
    pnlParseCoveragePct: number;
    recentPnlUsd: number;
    recentProfitFactor: number | null;
  };
  thresholds: ProfitabilityGateThresholds;
}

const DEFAULT_THRESHOLDS: ProfitabilityGateThresholds = {
  minLiveSettledTrades: 100,
  minLiveCopyTrades: 100,
  minCandidateSettledTrades: 10,
  minLivePnlUsd: 0.01,
  minLiveSharpeRatio: 1.5,
  minLiveProfitFactor: 1.5,
  minLiveWinRatePct: 60,
  minLivePayoffRatio: 1,
  maxLiveDrawdownPct: 5,
  minLiveEquityStabilityPct: 95,
  maxLiveTop3WinContributionPct: 75,
  maxRejectDrawdownPct: 15,
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function below(value: number | null, threshold: number): boolean {
  return value === null || value < threshold;
}

function canTolerateLowPayoff(
  performance: PreviewAccountReport["performance"],
  thresholds: ProfitabilityGateThresholds
): boolean {
  const concentration = performance.winningConditionConcentration;
  const top3Share = concentration?.top3WinningConditionGrossProfitSharePct;
  return (
    !below(performance.sharpeRatio, thresholds.minLiveSharpeRatio) &&
    !below(performance.profitFactor, thresholds.minLiveProfitFactor) &&
    performance.winRatePct >= thresholds.minLiveWinRatePct &&
    performance.maxDrawdownPct <= thresholds.maxLiveDrawdownPct &&
    performance.equityStabilityPct >= thresholds.minLiveEquityStabilityPct &&
    concentration?.evidenceStatus === "complete" &&
    top3Share !== null &&
    top3Share !== undefined &&
    top3Share <= thresholds.maxLiveTop3WinContributionPct &&
    performance.dependencyIssue === "diversified"
  );
}

function safetyBlockers(report: PreviewAccountReport): string[] {
  const blockers: string[] = [];
  const errorCount = report.recentWindow?.errorCount ?? report.errorCount;
  if (!report.exists) addReason(blockers, "missing db");
  if (report.killSwitch) addReason(blockers, "kill switch active");
  if (errorCount > 0) {
    addReason(blockers, "errors present");
  }
  if (
    Math.abs(report.cashReplayDeltaUsd) > 0.01 ||
    Math.abs(report.capitalDeltaUsd) > 0.5 ||
    report.missingMarketMetadataCount > 0
  ) {
    addReason(blockers, "accounting diagnostics not clean");
  }
  if (report.pendingOrderCount > 0 || report.liveOrderIntentCount > 0) {
    addReason(blockers, "pending recovery state present");
  }
  if (report.copyQuality.primaryIssue.code === "safety_blocker") {
    addReason(blockers, "copy quality safety blocker");
  }
  const concentration = report.performance.winningConditionConcentration;
  if (
    report.redeemCount > 0 &&
    concentration?.conditionMappingCoveragePct !== 100
  ) {
    addReason(blockers, "redeem condition mapping coverage below 100%");
  }
  if (
    report.redeemCount > 0 &&
    concentration?.pnlParseCoveragePct !== 100
  ) {
    addReason(blockers, "redeem pnl parse coverage below 100%");
  }
  return blockers;
}

function qualityBlocker(report: PreviewAccountReport): string | null {
  const code = report.copyQuality.primaryIssue.code;
  if (code === "no_data") return "copy quality has no effective sample";
  if (code === "strategy_losing") return "copy quality indicates losing strategy";
  if (code === "not_selling") return "sell coverage gap";
  if (code === "not_buying" || code === "parameter_filtered") {
    return "buy coverage or parameter filter gap";
  }
  if (code === "risk_limited") return "copy risk limits constraining coverage";
  if (code === "cash_occupied") return "cash occupied by unsettled positions";
  return null;
}

export function assessProfitabilityGate(
  report: PreviewAccountReport,
  thresholds: Partial<ProfitabilityGateThresholds> = {}
): ProfitabilityGateAssessment {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const performance = report.performance;
  const concentration = performance.winningConditionConcentration;
  const top3ConditionShare =
    concentration?.top3WinningConditionGrossProfitSharePct ?? null;
  const recent = performance.recent;
  const blockers = safetyBlockers(report);
  const warnings: string[] = [];
  const settledTrades = performance.tradeCount || report.redeemCount;
  const copyTrades = report.copyCount;
  const recentSettledTrades = recent.tradeCount;
  const qBlocker = qualityBlocker(report);

  if (qBlocker) addReason(warnings, qBlocker);

  if (
    settledTrades >= t.minCandidateSettledTrades &&
    performance.totalPnlUsd <= 0
  ) {
    addReason(blockers, "mature sample is not profitable");
  }
  if (performance.maxDrawdownPct >= t.maxRejectDrawdownPct) {
    addReason(blockers, "max drawdown above reject gate");
  }
  if (performance.dependencyIssue === "concentrated") {
    addReason(blockers, "profit depends on too few large wins");
  }
  if (report.copyQuality.primaryIssue.code === "strategy_losing") {
    addReason(blockers, "copy quality indicates losing strategy");
  }

  const liveBlockers: string[] = [];
  if (settledTrades < t.minLiveSettledTrades) {
    addReason(liveBlockers, "settled trade sample below live gate");
  }
  if (copyTrades < t.minLiveCopyTrades) {
    addReason(liveBlockers, "copy trade sample below live gate");
  }
  if (performance.totalPnlUsd < t.minLivePnlUsd) {
    addReason(liveBlockers, "profit below live gate");
  }
  if (below(performance.sharpeRatio, t.minLiveSharpeRatio)) {
    addReason(liveBlockers, "sharpe below live gate");
  }
  if (below(performance.profitFactor, t.minLiveProfitFactor)) {
    addReason(liveBlockers, "profit factor below live gate");
  }
  if (performance.winRatePct < t.minLiveWinRatePct) {
    addReason(liveBlockers, "win rate below live gate");
  }
  if (below(performance.payoffRatio, t.minLivePayoffRatio)) {
    if (canTolerateLowPayoff(performance, t)) {
      addReason(warnings, "payoff ratio below live gate");
    } else {
      addReason(liveBlockers, "payoff ratio below live gate");
    }
  }
  if (performance.maxDrawdownPct > t.maxLiveDrawdownPct) {
    addReason(liveBlockers, "max drawdown above live gate");
  }
  if (performance.equityStabilityPct < t.minLiveEquityStabilityPct) {
    addReason(liveBlockers, "equity stability below live gate");
  }
  if (
    concentration?.evidenceStatus !== "complete" ||
    top3ConditionShare === null ||
    top3ConditionShare > t.maxLiveTop3WinContributionPct
  ) {
    addReason(liveBlockers, "top winners contribute too much profit");
  }
  if (performance.dependencyIssue !== "diversified") {
    addReason(liveBlockers, "profit diversification below live gate");
  }
  if (recent.sinceMs !== null) {
    if (recent.pnlUsd < 0) addReason(liveBlockers, "recent pnl is negative");
    if (recent.tradeCount >= 10 && below(recent.profitFactor, 1)) {
      addReason(liveBlockers, "recent profit factor below 1");
    }
  }
  if (qBlocker) addReason(liveBlockers, qBlocker);

  let grade: ProfitabilityGateGrade;
  if (blockers.length > 0) {
    grade = "reject";
  } else if (liveBlockers.length === 0) {
    grade = "live_candidate";
  } else if (
    settledTrades < t.minLiveSettledTrades &&
    settledTrades >= t.minCandidateSettledTrades &&
    performance.totalPnlUsd > 0 &&
    performance.maxDrawdownPct <= 10 &&
    performance.dependencyIssue !== "concentrated" &&
    report.copyQuality.primaryIssue.code !== "safety_blocker"
  ) {
    grade = "candidate";
  } else {
    grade = "watch";
  }

  const allBlockers = grade === "live_candidate" ? blockers : [...blockers, ...liveBlockers];
  const score = round2(
    performance.totalPnlUsd +
      (performance.sharpeRatio ?? 0) * 10 +
      (performance.profitFactor ?? 0) * 8 +
      performance.winRatePct * 0.1 +
      (performance.payoffRatio ?? 0) * 4 -
      performance.maxDrawdownPct * 5 -
      (top3ConditionShare ?? 100) * 0.1 -
      (grade === "reject" ? 100 : 0)
  );

  return {
    grade,
    passed: grade === "live_candidate",
    score,
    blockers: allBlockers,
    warnings,
    sample: {
      settledTrades,
      copyTrades,
      recentSettledTrades,
    },
    metrics: {
      realizedPnlUsd: round2(performance.totalPnlUsd),
      sharpeRatio: performance.sharpeRatio,
      profitFactor: performance.profitFactor,
      winRatePct: performance.winRatePct,
      payoffRatio: performance.payoffRatio,
      maxDrawdownPct: performance.maxDrawdownPct,
      dependencyIssue: performance.dependencyIssue,
      equityStabilityPct: performance.equityStabilityPct,
      top3WinningConditionGrossProfitSharePct: top3ConditionShare,
      conditionMappingCoveragePct: concentration?.conditionMappingCoveragePct ?? 0,
      pnlParseCoveragePct: concentration?.pnlParseCoveragePct ?? 0,
      recentPnlUsd: recent.pnlUsd,
      recentProfitFactor: recent.profitFactor,
    },
    thresholds: t,
  };
}
