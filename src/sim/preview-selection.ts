import type { PreviewAccountReport } from "./preview-report.js";

export type PreviewSelectionGrade = "candidate" | "watch" | "reject";

export interface PreviewAccountRanking {
  accountId: string;
  score: number;
  grade: PreviewSelectionGrade;
  reasons: string[];
  liveReady: boolean;
  liveBlockers: string[];
}

export interface RankPreviewAccountOptions {
  minCashUsd?: number;
  highOpenCostUsd?: number;
  minRealizedPnlUsd?: number;
  minLiveRealizedPnlUsd?: number;
  minLiveRedeemCount?: number;
  maxLiveRecentUnmatchedRedeemSkips?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addBlocker(blockers: string[], reason: string): void {
  if (!blockers.includes(reason)) blockers.push(reason);
}

function assessLiveReadiness(
  report: PreviewAccountReport,
  options: Required<
    Pick<
      RankPreviewAccountOptions,
      | "minCashUsd"
      | "highOpenCostUsd"
      | "minLiveRealizedPnlUsd"
      | "minLiveRedeemCount"
      | "maxLiveRecentUnmatchedRedeemSkips"
    >
  >
): { liveReady: boolean; liveBlockers: string[] } {
  const window = report.recentWindow;
  const liveBlockers: string[] = [];
  const errorCount = window?.errorCount ?? report.errorCount;

  if (!report.exists) addBlocker(liveBlockers, "missing db");
  if (report.killSwitch) addBlocker(liveBlockers, "kill switch active");
  if (errorCount > 0) {
    addBlocker(liveBlockers, "errors present");
  }
  if (
    Math.abs(report.cashReplayDeltaUsd) > 0.01 ||
    Math.abs(report.capitalDeltaUsd) > 0.5 ||
    report.missingMarketMetadataCount > 0
  ) {
    addBlocker(liveBlockers, "accounting diagnostics not clean");
  }
  if (report.pendingOrderCount > 0 || report.liveOrderIntentCount > 0) {
    addBlocker(liveBlockers, "pending recovery state present");
  }
  if ((window?.positionCapSkipCount ?? 0) > 0) {
    addBlocker(liveBlockers, "recent position-cap skips");
  }
  if ((window?.maxOpenMarketSkipCount ?? 0) > 0) {
    addBlocker(liveBlockers, "recent max-open-market skips");
  }
  if (
    (window?.unmatchedRedeemSkipCount ?? 0) >
    options.maxLiveRecentUnmatchedRedeemSkips
  ) {
    addBlocker(liveBlockers, "recent unmatched redeem skips");
  }
  if (report.realizedPnlUsd < options.minLiveRealizedPnlUsd) {
    addBlocker(liveBlockers, "live profit gate not met");
  }
  if (report.redeemCount < options.minLiveRedeemCount) {
    addBlocker(liveBlockers, "settled redeem count below live gate");
  }
  if (report.cashUsd < options.minCashUsd) {
    addBlocker(liveBlockers, "low remaining cash");
  }
  if (report.openCostUsd > options.highOpenCostUsd) {
    addBlocker(liveBlockers, "high open cost");
  }
  const qualityIssue = report.copyQuality?.primaryIssue.code;
  if (qualityIssue === "safety_blocker") {
    addBlocker(liveBlockers, "copy quality safety blocker");
  }
  if (qualityIssue === "not_selling") {
    addBlocker(liveBlockers, "sell coverage gap");
  }
  if (qualityIssue === "not_buying" || qualityIssue === "parameter_filtered") {
    addBlocker(liveBlockers, "buy coverage or parameter filter gap");
  }
  if (qualityIssue === "risk_limited") {
    addBlocker(liveBlockers, "copy risk limits constraining coverage");
  }
  if (qualityIssue === "cash_occupied") {
    addBlocker(liveBlockers, "cash occupied by unsettled positions");
  }
  if (qualityIssue === "strategy_losing") {
    addBlocker(liveBlockers, "copy quality indicates losing strategy");
  }
  if (report.profitabilityGate && !report.profitabilityGate.passed) {
    addBlocker(liveBlockers, "profitability gate not passed");
  }

  return {
    liveReady: liveBlockers.length === 0,
    liveBlockers,
  };
}

export function scorePreviewAccount(
  report: PreviewAccountReport,
  options: RankPreviewAccountOptions = {}
): PreviewAccountRanking {
  const minCashUsd = options.minCashUsd ?? 30;
  const highOpenCostUsd = options.highOpenCostUsd ?? 180;
  const minRealizedPnlUsd = options.minRealizedPnlUsd ?? 1;
  const minLiveRealizedPnlUsd = options.minLiveRealizedPnlUsd ?? 20;
  const minLiveRedeemCount = options.minLiveRedeemCount ?? 100;
  const maxLiveRecentUnmatchedRedeemSkips =
    options.maxLiveRecentUnmatchedRedeemSkips ?? 10;
  const window = report.recentWindow;
  const recentUnmatchedRedeemSkips = window?.unmatchedRedeemSkipCount ?? 0;
  const highUnmatchedRedeemSkips = Math.max(
    50,
    (window?.copyCount ?? 0) * 0.75
  );
  const reasons: string[] = [];

  let score =
    report.realizedPnlUsd * 5 +
    (window?.copyCount ?? 0) +
    (window?.redeemCount ?? 0) * 2 -
    (window?.errorCount ?? 0) * 100 -
    Math.abs(report.cashReplayDeltaUsd) * 200 -
    Math.abs(report.capitalDeltaUsd) * 20 -
    report.missingMarketMetadataCount * 50 -
    (report.pendingOrderCount + report.liveOrderIntentCount) * 100 -
    (window?.cashStarvedSkipCount ?? 0) * 0.1 -
    (window?.positionCapSkipCount ?? 0) * 0.25 -
    recentUnmatchedRedeemSkips * 0.5 -
    report.errorCount * 100 -
    Math.max(0, minCashUsd - report.cashUsd) * 0.5 -
    Math.max(0, report.openCostUsd - highOpenCostUsd) * 0.2;
  const quality = report.copyQuality;
  const qualityIssue = quality?.primaryIssue.code;
  if (quality) {
    score += quality.coverage.tradePct * 0.05;
    score -= Math.max(0, 30 - quality.coverage.buyPct) * 0.2;
    score -= Math.max(0, 30 - quality.coverage.sellPct) * 0.2;
    score -= quality.skips.parameterFiltered * 0.05;
    score -= quality.skips.cashBlocked * 0.03;
    score -= quality.skips.exposureBlocked * 0.05;
    score -= quality.skips.sellWithoutLocal * 0.2;
  }

  let grade: PreviewSelectionGrade = "candidate";

  if (!report.exists) {
    reasons.push("missing db");
    score -= 500;
    grade = "reject";
  }
  if (report.killSwitch) {
    reasons.push("kill switch active");
    score -= 500;
    grade = "reject";
  }
  const errorCount = window?.errorCount ?? report.errorCount;
  if (errorCount > 0) {
    reasons.push("errors present");
    score -= 300;
    grade = "reject";
  }
  if (
    Math.abs(report.cashReplayDeltaUsd) > 0.01 ||
    Math.abs(report.capitalDeltaUsd) > 0.5 ||
    report.missingMarketMetadataCount > 0
  ) {
    reasons.push("accounting diagnostics not clean");
    grade = "reject";
  }
  if (report.pendingOrderCount > 0 || report.liveOrderIntentCount > 0) {
    reasons.push("pending recovery state present");
    grade = "reject";
  }
  if ((window?.cashStarvedSkipCount ?? 0) > 0) {
    reasons.push("recent cash-starved skips");
  }
  if (report.realizedPnlUsd < minRealizedPnlUsd) {
    reasons.push("profit gate not met");
    if (grade !== "reject") grade = "watch";
  }
  if (report.realizedPnlUsd < -10) {
    reasons.push("negative realized pnl");
    if (grade !== "reject") grade = "watch";
  }
  if (report.cashUsd < minCashUsd) {
    reasons.push("low remaining cash");
    if (grade !== "reject") grade = "watch";
  }
  if (report.openCostUsd > highOpenCostUsd) {
    reasons.push("high open cost");
    if (grade !== "reject") grade = "watch";
  }
  if ((window?.positionCapSkipCount ?? 0) > 0 && grade === "candidate") {
    reasons.push("recent position-cap skips");
  }
  if (recentUnmatchedRedeemSkips > highUnmatchedRedeemSkips) {
    reasons.push("recent unmatched redeem skips");
    if (grade !== "reject") grade = "watch";
  }
  if (qualityIssue === "safety_blocker") {
    reasons.push("copy quality safety blocker");
    score -= 300;
    grade = "reject";
  }
  if (qualityIssue === "strategy_losing") {
    reasons.push("copy quality indicates losing strategy");
    score -= 120;
    if (grade !== "reject") grade = "watch";
  }
  if (qualityIssue === "not_selling") {
    reasons.push("sell coverage gap");
    score -= 50;
    if (grade !== "reject") grade = "watch";
  }
  if (qualityIssue === "not_buying" || qualityIssue === "parameter_filtered") {
    reasons.push("buy coverage or parameter filter gap");
    score -= 35;
    if (grade !== "reject") grade = "watch";
  }
  if (qualityIssue === "risk_limited") {
    reasons.push("copy risk limits constraining coverage");
    score -= 35;
    if (grade !== "reject") grade = "watch";
  }
  if (qualityIssue === "cash_occupied") {
    reasons.push("cash occupied by unsettled positions");
    if (grade !== "reject") grade = "watch";
  }
  if (report.profitabilityGate) {
    score += report.profitabilityGate.score * 0.05;
    if (report.profitabilityGate.grade === "reject") {
      reasons.push("profitability gate rejected");
      score -= 200;
      grade = "reject";
    } else if (report.profitabilityGate.grade === "watch") {
      reasons.push("profitability gate watch");
      if (grade !== "reject") grade = "watch";
    }
  }

  const live = assessLiveReadiness(report, {
    minCashUsd,
    highOpenCostUsd,
    minLiveRealizedPnlUsd,
    minLiveRedeemCount,
    maxLiveRecentUnmatchedRedeemSkips,
  });

  return {
    accountId: report.accountId,
    score: round2(score),
    grade,
    reasons,
    ...live,
  };
}

export function rankPreviewAccounts(
  reports: PreviewAccountReport[],
  options: RankPreviewAccountOptions = {}
): PreviewAccountRanking[] {
  return reports
    .map((report) => scorePreviewAccount(report, options))
    .sort((a, b) => {
      const gradeRank: Record<PreviewSelectionGrade, number> = {
        candidate: 0,
        watch: 1,
        reject: 2,
      };
      const gradeDiff = gradeRank[a.grade] - gradeRank[b.grade];
      if (gradeDiff !== 0) return gradeDiff;
      return b.score - a.score;
    });
}
