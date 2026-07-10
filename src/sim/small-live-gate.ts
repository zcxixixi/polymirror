import type { PreviewDbDigestAccount } from "./preview-db-digest.js";

export interface SmallLiveGateOptions {
  minRealizedPnlUsd?: number;
  minSettledCount?: number;
  minWinRatePct?: number;
  minRedeemCount?: number;
  minCashUsd?: number;
  maxOpenCostUsd?: number;
  maxRecentNoLocalRedeemSkips?: number;
  maxRecentMarketUnresolvedSkips?: number;
  maxEligible?: number;
}

export type SmallLiveGateThresholds = Required<SmallLiveGateOptions>;

export interface SmallLiveGateEntry {
  accountId: string;
  realizedPnlUsd: number;
  winRatePct: number | null;
  settledCount: number;
  cashUsd: number;
  openCostUsd: number;
  score: number;
  blockers: string[];
  warnings: string[];
}

export interface SmallLiveGateResult {
  thresholds: SmallLiveGateThresholds;
  eligible: SmallLiveGateEntry[];
  rejected: SmallLiveGateEntry[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function toEntry(
  row: PreviewDbDigestAccount,
  options: Required<SmallLiveGateOptions>
): SmallLiveGateEntry {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const winRatePct = row.winStats.winRatePct;

  if (!row.exists) addUnique(blockers, "missing db");
  if (row.readError) addUnique(blockers, "db read error");
  if (row.stale) addUnique(blockers, "stale data");
  if (row.killSwitch) addUnique(blockers, "kill switch active");
  if (row.recent.errorCount > 0) {
    addUnique(blockers, "errors present");
  }
  if (row.pendingOrderCount > 0 || row.liveOrderIntentCount > 0) {
    addUnique(blockers, "pending recovery state present");
  }
  if (row.missingMarketMetadataCount > 0) {
    addUnique(blockers, "missing market metadata");
  }
  if (row.realizedPnlUsd < options.minRealizedPnlUsd) {
    addUnique(blockers, "profit gate not met");
  }
  if (row.winStats.settledCount < options.minSettledCount) {
    addUnique(blockers, "settled sample below gate");
  }
  if (winRatePct === null || winRatePct < options.minWinRatePct) {
    addUnique(blockers, "win-rate gate not met");
  }
  if (row.redeemCount < options.minRedeemCount) {
    addUnique(blockers, "redeem count below gate");
  }
  if (row.cashUsd < options.minCashUsd) {
    addUnique(blockers, "low remaining cash");
  }
  if (row.openCostUsd > options.maxOpenCostUsd) {
    addUnique(blockers, "high open cost");
  }
  if (row.recent.positionCapSkipCount > 0) {
    addUnique(blockers, "recent position-cap skips");
  }
  if (row.recent.noLocalRedeemSkipCount > options.maxRecentNoLocalRedeemSkips) {
    addUnique(blockers, "recent no-local-redeem skips");
  }
  if (row.recent.marketUnresolvedSkipCount > options.maxRecentMarketUnresolvedSkips) {
    addUnique(blockers, "recent market-unresolved skips");
  }

  if (row.recent.cashStarvedSkipCount > 0) {
    addUnique(warnings, "recent cash-starved skips");
  }
  if (row.openPositions > 0) {
    addUnique(warnings, "open positions present");
  }

  const score = round2(
    row.realizedPnlUsd * 3 +
      (winRatePct ?? 0) * 2 +
      row.winStats.settledCount * 0.1 +
      row.recent.redeemCount * 0.5 -
      row.openCostUsd * 0.2 -
      warnings.length * 5
  );

  return {
    accountId: row.accountId,
    realizedPnlUsd: row.realizedPnlUsd,
    winRatePct,
    settledCount: row.winStats.settledCount,
    cashUsd: row.cashUsd,
    openCostUsd: row.openCostUsd,
    score,
    blockers,
    warnings,
  };
}

export function assessSmallLiveCandidates(
  rows: PreviewDbDigestAccount[],
  options: SmallLiveGateOptions = {}
): SmallLiveGateResult {
  const resolved: SmallLiveGateThresholds = {
    minRealizedPnlUsd: options.minRealizedPnlUsd ?? 20,
    minSettledCount: options.minSettledCount ?? 50,
    minWinRatePct: options.minWinRatePct ?? 55,
    minRedeemCount: options.minRedeemCount ?? 50,
    minCashUsd: options.minCashUsd ?? 30,
    maxOpenCostUsd: options.maxOpenCostUsd ?? 180,
    maxRecentNoLocalRedeemSkips: options.maxRecentNoLocalRedeemSkips ?? 25,
    maxRecentMarketUnresolvedSkips: options.maxRecentMarketUnresolvedSkips ?? 500,
    maxEligible: options.maxEligible ?? 5,
  };

  const entries = rows.map((row) => toEntry(row, resolved));
  const eligible = entries
    .filter((entry) => entry.blockers.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, resolved.maxEligible);
  const rejected = entries
    .filter((entry) => entry.blockers.length > 0)
    .sort((a, b) => b.score - a.score);

  return { thresholds: resolved, eligible, rejected };
}

export function formatSmallLiveGate(result: SmallLiveGateResult): string[] {
  const eligible =
    result.eligible
      .map(
        (entry) =>
          `${entry.accountId}:pnl=${entry.realizedPnlUsd}U win=${entry.winRatePct ?? "n/a"}% settled=${entry.settledCount}`
      )
      .join(", ") || "none";
  const topRejected =
    result.rejected
      .slice(0, 5)
      .map((entry) => `${entry.accountId}:${entry.blockers.join("|")}`)
      .join(", ") || "none";
  return [
    `Small-live eligible: ${eligible}`,
    `Small-live rejected: ${topRejected}`,
  ];
}
