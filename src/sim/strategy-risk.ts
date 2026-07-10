import type { PreviewAccountReport } from "./preview-report.js";

export type StrategyRiskLevel = "low" | "medium" | "high" | "hard_stop";
export type StrategyRiskDecision = "scale_up" | "candidate" | "watch" | "retire";

export interface StrategyRiskAssessment {
  accountId: string;
  initialCapitalUsd: number;
  currentCapitalUsd: number;
  realizedPnlUsd: number;
  realizedRoiPct: number;
  pnlOnCurrentCapitalPct: number;
  openExposurePct: number;
  cashPct: number;
  drawdownPct: number;
  riskLevel: StrategyRiskLevel;
  decision: StrategyRiskDecision;
  riskAdjustedScore: number;
  suggestedMaxOrderUsd: number;
  suggestedMaxDailyVolumeUsd: number;
  reasons: string[];
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function inferredInitialCapital(report: PreviewAccountReport): number {
  const initial =
    report.cashUsd + report.openCostUsd - report.realizedPnlUsd - report.capitalDeltaUsd;
  return Math.max(1, round(initial));
}

function recentCashStarved(report: PreviewAccountReport): number {
  return report.recentWindow?.cashStarvedSkipCount ?? report.cashStarvedSkipCount;
}

function recentPositionPressure(report: PreviewAccountReport): number {
  return (
    (report.recentWindow?.positionCapSkipCount ?? 0) +
    (report.recentWindow?.maxOpenMarketSkipCount ?? 0)
  );
}

export function assessStrategyRisk(report: PreviewAccountReport): StrategyRiskAssessment {
  const reasons: string[] = [];
  const initialCapitalUsd = inferredInitialCapital(report);
  const currentCapitalUsd = Math.max(1, round(report.cashUsd + report.openCostUsd));
  const realizedRoiPct = round((report.realizedPnlUsd / initialCapitalUsd) * 100);
  const pnlOnCurrentCapitalPct = round((report.realizedPnlUsd / currentCapitalUsd) * 100);
  const openExposurePct = round((report.openCostUsd / currentCapitalUsd) * 100);
  const cashPct = round((report.cashUsd / currentCapitalUsd) * 100);
  const drawdownPct = round(
    (Math.max(0, -report.realizedPnlUsd) / currentCapitalUsd) * 100
  );

  const errorCount = report.recentWindow?.errorCount ?? report.errorCount;
  if (!report.exists) addReason(reasons, "missing db");
  if (report.killSwitch) addReason(reasons, "kill switch active");
  if (errorCount > 0) {
    addReason(reasons, "errors present");
  }
  if (
    Math.abs(report.cashReplayDeltaUsd) > 0.01 ||
    Math.abs(report.capitalDeltaUsd) > 0.5 ||
    report.missingMarketMetadataCount > 0
  ) {
    addReason(reasons, "accounting diagnostics not clean");
  }
  if (report.pendingOrderCount > 0 || report.liveOrderIntentCount > 0) {
    addReason(reasons, "pending recovery state present");
  }

  const hardStop = reasons.length > 0;
  if (drawdownPct >= 20) addReason(reasons, "large realized drawdown");
  if (openExposurePct >= 80) addReason(reasons, "high open exposure");
  if (report.cashUsd < 1) addReason(reasons, "cash nearly exhausted");
  if (recentCashStarved(report) > 0) addReason(reasons, "recent cash-starved skips");
  if (recentPositionPressure(report) > 0) addReason(reasons, "recent position pressure");

  const matureSample = report.copyCount >= 20 || report.redeemCount >= 5;
  if (report.realizedPnlUsd <= -10 && matureSample) {
    addReason(reasons, "mature negative pnl");
  }
  const qualityIssue = report.copyQuality?.primaryIssue.code;
  if (qualityIssue === "strategy_losing") {
    addReason(reasons, "copy quality indicates losing strategy");
  }
  if (qualityIssue === "not_selling") {
    addReason(reasons, "sell coverage gap");
  }
  if (qualityIssue === "not_buying" || qualityIssue === "parameter_filtered") {
    addReason(reasons, "buy coverage or parameter filter gap");
  }
  if (qualityIssue === "risk_limited") {
    addReason(reasons, "copy risk limits constraining coverage");
  }
  if (qualityIssue === "cash_occupied") {
    addReason(reasons, "cash occupied by unsettled positions");
  }

  const riskLevel: StrategyRiskLevel = hardStop
    ? "hard_stop"
    : drawdownPct >= 20 || openExposurePct >= 80 || report.cashUsd < 1
      ? "high"
      : openExposurePct >= 55 || recentCashStarved(report) > 0 || recentPositionPressure(report) > 0
        ? "medium"
        : "low";

  const decision: StrategyRiskDecision =
    hardStop ||
    reasons.includes("mature negative pnl") ||
    (reasons.includes("copy quality indicates losing strategy") && matureSample)
      ? "retire"
      : report.realizedPnlUsd > 0 && riskLevel === "low" && currentCapitalUsd > initialCapitalUsd
        ? "scale_up"
        : report.realizedPnlUsd >= 1 && riskLevel !== "high"
          ? "candidate"
          : riskLevel === "high" && report.realizedPnlUsd < 0
            ? "retire"
            : "watch";

  const riskPct =
    decision === "scale_up" ? 0.02 : decision === "candidate" ? 0.01 : decision === "watch" ? 0.005 : 0;
  const suggestedMaxOrderUsd =
    riskPct > 0 ? round(Math.max(1, currentCapitalUsd * riskPct)) : 0;
  const suggestedMaxDailyVolumeUsd =
    riskPct > 0 ? round(currentCapitalUsd * (decision === "scale_up" ? 1.5 : 1)) : 0;

  const riskAdjustedScore = round(
    report.realizedPnlUsd +
      (report.recentWindow?.copyCount ?? 0) * 0.02 +
      (report.recentWindow?.redeemCount ?? 0) * 0.5 -
      drawdownPct * 3 -
      openExposurePct * 0.25 -
      recentCashStarved(report) * 0.02 -
      recentPositionPressure(report) * 0.05 -
      (report.copyQuality?.skips.exposureBlocked ?? 0) * 0.03 -
      (hardStop ? 500 : 0)
  );

  return {
    accountId: report.accountId,
    initialCapitalUsd,
    currentCapitalUsd,
    realizedPnlUsd: round(report.realizedPnlUsd),
    realizedRoiPct,
    pnlOnCurrentCapitalPct,
    openExposurePct,
    cashPct,
    drawdownPct,
    riskLevel,
    decision,
    riskAdjustedScore,
    suggestedMaxOrderUsd,
    suggestedMaxDailyVolumeUsd,
    reasons,
  };
}

export function rankStrategyRisks(
  reports: PreviewAccountReport[]
): StrategyRiskAssessment[] {
  return reports
    .map((report) => assessStrategyRisk(report))
    .sort((a, b) => {
      const decisionRank: Record<StrategyRiskDecision, number> = {
        scale_up: 0,
        candidate: 1,
        watch: 2,
        retire: 3,
      };
      const decisionDiff = decisionRank[a.decision] - decisionRank[b.decision];
      if (decisionDiff !== 0) return decisionDiff;
      return b.riskAdjustedScore - a.riskAdjustedScore;
    });
}
