import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { replayPreviewCashFromAudit } from "./preview-cash-reconcile.js";
import {
  buildPreviewCopyQuality,
  emptyPreviewCopyQuality,
  PREVIEW_COPY_DEDUP_REASONS,
  type PreviewCopyQualitySummary,
} from "./preview-quality.js";
import {
  assessProfitabilityGate,
  type ProfitabilityGateAssessment,
} from "./profitability-gate.js";
import {
  assessStabilityGoal,
  type StabilityGoalEvidence,
  type StabilityGoalAssessment,
} from "./stability-goal.js";
import type { CopyPriceMode } from "../config/types.js";
import { quoteExecutableOrderBook, type OrderBookLevelLike } from "../executor/orderbook.js";
import { calculateCopySlippageLossPct } from "./copy-slippage.js";

const STABILITY_GOAL_COPY_PATH_WINDOW_MS = 14 * 24 * 60 * 60_000;
const STABILITY_GOAL_ERROR_WINDOW_MS = 6 * 60 * 60_000;
const REPORT_CACHE_KIB = 64 * 1024;
const REPORT_MMAP_BYTES = 256 * 1024 * 1024;
const NATIVE_SLIPPAGE_MIN_COVERAGE_PCT = 90;

export function configurePreviewReportDatabase(db: Database.Database): void {
  db.pragma("busy_timeout = 5000");
  db.pragma(`cache_size = -${REPORT_CACHE_KIB}`);
  db.pragma(`mmap_size = ${REPORT_MMAP_BYTES}`);
  // Keep high-cardinality GROUP BY spill bounded by the collector's writable /tmp.
  db.pragma("temp_store = FILE");
  db.pragma("query_only = ON");
}

export interface PreviewSkipReason {
  reason: string;
  count: number;
}

export interface PreviewRedeemSummary {
  id: number;
  ts: number;
  conditionId: string | null;
  payoutUsd: number | null;
  reason: string | null;
}

export interface PreviewErrorSummary {
  id: number;
  ts: number;
  tokenId: string | null;
  side: string | null;
  reason: string | null;
}

export interface PreviewOpenMarketSummary {
  slug: string | null;
  title: string | null;
  positions: number;
  costUsd: number;
}

export interface PreviewRecentWindowSummary {
  sinceMs: number;
  copyCount: number;
  redeemCount: number;
  errorCount: number;
  skipCount: number;
  priceFilteredSkipCount: number;
  cashStarvedSkipCount: number;
  positionCapSkipCount: number;
  maxOpenMarketSkipCount: number;
  noLocalRedeemSkipCount: number;
  unmatchedRedeemSkipCount: number;
}

export type PreviewProfitDependencyIssue =
  | "diversified"
  | "concentrated"
  | "no_profit"
  | "insufficient_data";

export interface PreviewPerformanceRecentSummary {
  sinceMs: number | null;
  tradeCount: number;
  pnlUsd: number;
  winRatePct: number;
  profitFactor: number | null;
}

export type PreviewWinningConditionConcentrationStatus =
  | "no_sample"
  | "complete"
  | "incomplete";

/**
 * Profit-concentration evidence at the unique Polymarket condition level.
 *
 * Share denominators are gross positive condition PnL, while the remaining-PnL
 * fields start from net PnL and remove the largest winning conditions in order.
 * Nullable result fields must not be used unless evidenceStatus is `complete`.
 */
export interface PreviewWinningConditionConcentrationSummary {
  evidenceStatus: PreviewWinningConditionConcentrationStatus;
  redeemCount: number;
  conditionMappedRedeemCount: number;
  conditionMappingMissingCount: number;
  conditionMappingCoveragePct: number;
  pnlParsedRedeemCount: number;
  pnlParseFailureCount: number;
  pnlParseCoveragePct: number;
  settledConditionCount: number;
  winningConditionCount: number;
  netConditionPnlUsd: number | null;
  grossWinningConditionPnlUsd: number | null;
  top1WinningConditionGrossProfitSharePct: number | null;
  top2WinningConditionGrossProfitSharePct: number | null;
  top3WinningConditionGrossProfitSharePct: number | null;
  netPnlAfterRemovingTop1WinningConditionUsd: number | null;
  netPnlAfterRemovingTop2WinningConditionsUsd: number | null;
  netPnlAfterRemovingTop3WinningConditionsUsd: number | null;
}

export interface PreviewPerformanceSummary {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  totalPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  winRatePct: number;
  profitFactor: number | null;
  payoffRatio: number | null;
  sharpeRatio: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  largestWinUsd: number;
  largestLossUsd: number;
  /** Legacy REDEEM-row share using net PnL; retained for report compatibility only. */
  largestWinContributionPct: number;
  /** Legacy REDEEM-row share using net PnL; qualification uses condition evidence below. */
  top3WinContributionPct: number;
  winningConditionConcentration: PreviewWinningConditionConcentrationSummary;
  dependencyIssue: PreviewProfitDependencyIssue;
  equityStabilityPct: number;
  recent: PreviewPerformanceRecentSummary;
}

export interface PreviewGoalWindowSummary {
  sinceMs: number;
  marketCount: number;
  pnlUsd: number;
  winRatePct: number;
  profitFactor: number | null;
  grossProfitUsd: number;
  grossLossUsd: number;
}

export interface PreviewGoalRecent20Summary {
  marketCount: number;
  pnlUsd: number;
  winRatePct: number;
  profitFactor: number | null;
  grossProfitUsd: number;
  grossLossUsd: number;
  slippageSampleCount: number;
  slippageCoveragePct: number;
  slippageLossPct: number | null;
  slippageBasis: "preview_guarded_limit_full_fill";
  slippageIsRealizedFill: false;
}

export interface PreviewGoalSlippageSummary {
  basis: "preview_guarded_limit_full_fill";
  isRealizedFill: false;
  observationStartedAtMs: number | null;
  observationDays: number;
  copyCount: number;
  sampleCount: number;
  totalNotionalUsd: number;
  sampledNotionalUsd: number;
  coveragePct: number;
  lossPct: number | null;
}

export interface PreviewDetectionLatencySummary {
  basis: "source_to_first_observation";
  experimentId: string | null;
  status: "not_applicable" | "no_sample" | "valid" | "invalid";
  tradeEventCount: number;
  sampleCount: number;
  payloadParseFailureCount: number;
  invalidTimestampCount: number;
  futureTimestampCount: number;
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  blockers: string[];
}

export type PreviewNativeSlippageStatus =
  | "not_applicable"
  | "no_sample"
  | "valid"
  | "insufficient_coverage"
  | "invalid";

export interface PreviewPollTimeQuoteSlippageSlice {
  status: PreviewNativeSlippageStatus;
  attemptCount: number;
  executedCopyCount: number;
  rejectedSkipCount: number;
  decisionLinkedCount: number;
  decisionLinkMissingCount: number;
  decisionLinkCoveragePct: number;
  actionMismatchCount: number;
  experimentMismatchCount: number;
  jsonParseFailureCount: number;
  fieldMismatchCount: number;
  quoteEvidenceMismatchCount: number;
  unavailableCount: number;
  unfillableCount: number;
  belowMinOrderCount: number;
  sampleCount: number;
  totalNotionalUsd: number;
  sampledNotionalUsd: number;
  coveragePct: number;
  lossPct: number | null;
  blockers: string[];
}

export interface PreviewPollTimeExecutableQuoteSlippageSummary
  extends PreviewPollTimeQuoteSlippageSlice {
  basis: "poll_time_executable_order_book_quote";
  experimentId: string | null;
  observationStartedAtMs: number | null;
  observationDays: number;
  quoteStageErrorCount: number;
  recent20: PreviewPollTimeQuoteSlippageSlice;
}

export interface PreviewSimulatedLimitSlippageSummary {
  basis: "preview_guarded_limit_full_fill";
  isRealizedFill: false;
  status: PreviewNativeSlippageStatus;
  experimentId: string | null;
  copyCount: number;
  decisionLinkedCount: number;
  decisionLinkMissingCount: number;
  decisionLinkCoveragePct: number;
  actionMismatchCount: number;
  experimentMismatchCount: number;
  jsonParseFailureCount: number;
  fieldMismatchCount: number;
  quoteEvidenceMismatchCount: number;
  telemetryMissingCount: number;
  telemetryMismatchCount: number;
  sampleCount: number;
  totalNotionalUsd: number;
  sampledNotionalUsd: number;
  coveragePct: number;
  lossPct: number | null;
  blockers: string[];
}

export interface PreviewGoalMetrics {
  observationDays: number;
  activeTradingDays: number;
  firstCopyAtMs: number | null;
  lastCopyAtMs: number | null;
  settledMarketCount: number;
  copyPnlUsd: number;
  grossCopyVolumeUsd: number;
  pnlVolumePct: number;
  detectionLatency: PreviewDetectionLatencySummary;
  overall: PreviewGoalRecent20Summary;
  recent20: PreviewGoalRecent20Summary;
  pollTimeExecutableQuoteSlippage: PreviewPollTimeExecutableQuoteSlippageSummary;
  simulatedLimitSlippage: PreviewSimulatedLimitSlippageSummary;
  slippage: PreviewGoalSlippageSummary;
  windows: {
    h24: PreviewGoalWindowSummary;
    d7: PreviewGoalWindowSummary;
    d14: PreviewGoalWindowSummary;
  };
}

export interface PreviewAccountReport {
  accountId: string;
  dbPath: string;
  copyPriceMode: CopyPriceMode;
  exists: boolean;
  cashUsd: number;
  openCostUsd: number;
  openPositions: number;
  realizedPnlUsd: number;
  cashReplayDeltaUsd: number;
  capitalDeltaUsd: number;
  missingMarketMetadataCount: number;
  pendingOrderCount: number;
  liveOrderIntentCount: number;
  copyCount: number;
  redeemCount: number;
  errorCount: number;
  skipCount: number;
  priceFilteredSkipCount: number;
  cashStarvedSkipCount: number;
  positionCapSkipCount: number;
  maxOpenMarketSkipCount: number;
  noLocalRedeemSkipCount: number;
  unmatchedRedeemSkipCount: number;
  killSwitch: boolean;
  skipReasons: PreviewSkipReason[];
  recentRedeems: PreviewRedeemSummary[];
  recentErrors: PreviewErrorSummary[];
  openMarkets: PreviewOpenMarketSummary[];
  recentWindow?: PreviewRecentWindowSummary;
  copyQuality: PreviewCopyQualitySummary;
  performance: PreviewPerformanceSummary;
  goalMetrics?: PreviewGoalMetrics;
  stabilityGoal?: StabilityGoalAssessment;
  profitabilityGate?: ProfitabilityGateAssessment;
  provenance?: PreviewExperimentProvenance;
}

export interface PreviewExperimentProvenance {
  experimentId: string;
  configHash: string;
  gitSha: string;
  imageDigest: string;
  lockfileHash: string;
  schemaVersion: number;
  trustClass: string;
}

export interface ReadPreviewAccountReportOptions {
  accountId: string;
  dbPath: string;
  copyPriceMode?: CopyPriceMode;
  startingCapitalUsd?: number;
  limit?: number;
  recentWindowMs?: number;
  nowMs?: number;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyWinningConditionConcentration(): PreviewWinningConditionConcentrationSummary {
  return {
    evidenceStatus: "no_sample",
    redeemCount: 0,
    conditionMappedRedeemCount: 0,
    conditionMappingMissingCount: 0,
    conditionMappingCoveragePct: 0,
    pnlParsedRedeemCount: 0,
    pnlParseFailureCount: 0,
    pnlParseCoveragePct: 0,
    settledConditionCount: 0,
    winningConditionCount: 0,
    netConditionPnlUsd: null,
    grossWinningConditionPnlUsd: null,
    top1WinningConditionGrossProfitSharePct: null,
    top2WinningConditionGrossProfitSharePct: null,
    top3WinningConditionGrossProfitSharePct: null,
    netPnlAfterRemovingTop1WinningConditionUsd: null,
    netPnlAfterRemovingTop2WinningConditionsUsd: null,
    netPnlAfterRemovingTop3WinningConditionsUsd: null,
  };
}

function emptyPollTimeQuoteSlice(
  status: PreviewNativeSlippageStatus = "no_sample",
  blockers: string[] = []
): PreviewPollTimeQuoteSlippageSlice {
  return {
    status,
    attemptCount: 0,
    executedCopyCount: 0,
    rejectedSkipCount: 0,
    decisionLinkedCount: 0,
    decisionLinkMissingCount: 0,
    decisionLinkCoveragePct: 0,
    actionMismatchCount: 0,
    experimentMismatchCount: 0,
    jsonParseFailureCount: 0,
    fieldMismatchCount: 0,
    quoteEvidenceMismatchCount: 0,
    unavailableCount: 0,
    unfillableCount: 0,
    belowMinOrderCount: 0,
    sampleCount: 0,
    totalNotionalUsd: 0,
    sampledNotionalUsd: 0,
    coveragePct: 0,
    lossPct: null,
    blockers,
  };
}

function emptyPollTimeQuoteSlippage(
  status: PreviewNativeSlippageStatus = "no_sample",
  experimentId: string | null = null,
  blockers: string[] = []
): PreviewPollTimeExecutableQuoteSlippageSummary {
  return {
    basis: "poll_time_executable_order_book_quote",
    experimentId,
    observationStartedAtMs: null,
    observationDays: 0,
    quoteStageErrorCount: 0,
    ...emptyPollTimeQuoteSlice(status, blockers),
    recent20: emptyPollTimeQuoteSlice(status, blockers),
  };
}

function emptySimulatedLimitSlippage(
  status: PreviewNativeSlippageStatus = "no_sample",
  experimentId: string | null = null,
  blockers: string[] = []
): PreviewSimulatedLimitSlippageSummary {
  return {
    basis: "preview_guarded_limit_full_fill",
    isRealizedFill: false,
    status,
    experimentId,
    copyCount: 0,
    decisionLinkedCount: 0,
    decisionLinkMissingCount: 0,
    decisionLinkCoveragePct: 0,
    actionMismatchCount: 0,
    experimentMismatchCount: 0,
    jsonParseFailureCount: 0,
    fieldMismatchCount: 0,
    quoteEvidenceMismatchCount: 0,
    telemetryMissingCount: 0,
    telemetryMismatchCount: 0,
    sampleCount: 0,
    totalNotionalUsd: 0,
    sampledNotionalUsd: 0,
    coveragePct: 0,
    lossPct: null,
    blockers,
  };
}

function emptyPerformance(sinceMs: number | null = null): PreviewPerformanceSummary {
  return {
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    flatCount: 0,
    totalPnlUsd: 0,
    grossProfitUsd: 0,
    grossLossUsd: 0,
    winRatePct: 0,
    profitFactor: null,
    payoffRatio: null,
    sharpeRatio: null,
    maxDrawdownUsd: 0,
    maxDrawdownPct: 0,
    largestWinUsd: 0,
    largestLossUsd: 0,
    largestWinContributionPct: 0,
    top3WinContributionPct: 0,
    winningConditionConcentration: emptyWinningConditionConcentration(),
    dependencyIssue: "insufficient_data",
    equityStabilityPct: 0,
    recent: {
      sinceMs,
      tradeCount: 0,
      pnlUsd: 0,
      winRatePct: 0,
      profitFactor: null,
    },
  };
}

function emptyGoalWindow(sinceMs: number): PreviewGoalWindowSummary {
  return {
    sinceMs,
    marketCount: 0,
    pnlUsd: 0,
    winRatePct: 0,
    profitFactor: null,
    grossProfitUsd: 0,
    grossLossUsd: 0,
  };
}

function emptyGoalMetrics(nowMs: number): PreviewGoalMetrics {
  return {
    observationDays: 0,
    activeTradingDays: 0,
    firstCopyAtMs: null,
    lastCopyAtMs: null,
    settledMarketCount: 0,
    copyPnlUsd: 0,
    grossCopyVolumeUsd: 0,
    pnlVolumePct: 0,
    detectionLatency: emptyDetectionLatency("not_applicable"),
    overall: {
      marketCount: 0,
      pnlUsd: 0,
      winRatePct: 0,
      profitFactor: null,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      slippageSampleCount: 0,
      slippageCoveragePct: 0,
      slippageLossPct: null,
      slippageBasis: "preview_guarded_limit_full_fill",
      slippageIsRealizedFill: false,
    },
    recent20: {
      marketCount: 0,
      pnlUsd: 0,
      winRatePct: 0,
      profitFactor: null,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      slippageSampleCount: 0,
      slippageCoveragePct: 0,
      slippageLossPct: null,
      slippageBasis: "preview_guarded_limit_full_fill",
      slippageIsRealizedFill: false,
    },
    pollTimeExecutableQuoteSlippage: emptyPollTimeQuoteSlippage("not_applicable"),
    simulatedLimitSlippage: emptySimulatedLimitSlippage("not_applicable"),
    slippage: {
      basis: "preview_guarded_limit_full_fill",
      isRealizedFill: false,
      observationStartedAtMs: null,
      observationDays: 0,
      copyCount: 0,
      sampleCount: 0,
      totalNotionalUsd: 0,
      sampledNotionalUsd: 0,
      coveragePct: 0,
      lossPct: null,
    },
    windows: {
      h24: emptyGoalWindow(nowMs - 24 * 60 * 60_000),
      d7: emptyGoalWindow(nowMs - 7 * 24 * 60 * 60_000),
      d14: emptyGoalWindow(nowMs - 14 * 24 * 60 * 60_000),
    },
  };
}

function emptyReport(options: ReadPreviewAccountReportOptions): PreviewAccountReport {
  const report: PreviewAccountReport = {
    accountId: options.accountId,
    dbPath: options.dbPath,
    copyPriceMode: options.copyPriceMode ?? "leader_limit",
    exists: false,
    cashUsd: options.startingCapitalUsd ?? 0,
    openCostUsd: 0,
    openPositions: 0,
    realizedPnlUsd: 0,
    cashReplayDeltaUsd: 0,
    capitalDeltaUsd: 0,
    missingMarketMetadataCount: 0,
    pendingOrderCount: 0,
    liveOrderIntentCount: 0,
    copyCount: 0,
    redeemCount: 0,
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
    copyQuality: emptyPreviewCopyQuality(options.startingCapitalUsd ?? 0, 0, 0),
    performance: emptyPerformance(null),
    goalMetrics: emptyGoalMetrics(options.nowMs ?? Date.now()),
  };
  return {
    ...report,
    profitabilityGate: assessProfitabilityGate(report),
    stabilityGoal: assessStabilityGoal(report),
  };
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((entry) => entry.name === column);
}

function readCopyPriceMode(
  db: Database.Database,
  hasAuditLog: boolean,
  requested: CopyPriceMode | undefined
): CopyPriceMode {
  if (tableExists(db, "runtime_metadata")) {
    const row = db
      .prepare("SELECT value FROM runtime_metadata WHERE key = 'copy_price_mode'")
      .get() as { value: string } | undefined;
    if (row?.value === "leader_limit" || row?.value === "executable_guarded") {
      return row.value;
    }
  }
  if (hasAuditLog) {
    const history = db
      .prepare("SELECT 1 FROM audit_log WHERE action IN ('COPY', 'REDEEM') LIMIT 1")
      .get();
    if (history) return "leader_limit";
  }
  return requested ?? "leader_limit";
}

function skipCountMatching(
  skipReasons: PreviewSkipReason[],
  matches: (reason: string) => boolean
): number {
  return skipReasons.reduce(
    (sum, row) => sum + (matches(row.reason) ? row.count : 0),
    0
  );
}

function isPriceFilteredSkip(reason: string): boolean {
  return reason.startsWith("price ") && reason.includes(" < min ");
}

function isNoLocalRedeemSkip(reason: string): boolean {
  return reason === "no local preview position for condition";
}

function isSuspiciousRedeemSkip(reason: string): boolean {
  return (
    reason.startsWith("REDEEM ") &&
    reason !== "REDEEM settlement is preview-only"
  );
}

function summarizeRecentWindow(
  db: Database.Database,
  sinceMs: number
): PreviewRecentWindowSummary {
  const counts = db
    .prepare(
      `SELECT action, COUNT(*) AS count
       FROM audit_log
       WHERE ts >= ?
       GROUP BY action`
    )
    .all(sinceMs) as { action: string; count: number }[];
  const byAction = new Map(counts.map((row) => [row.action, row.count]));
  const skipReasons = db
    .prepare(
      `SELECT COALESCE(reason, '') AS reason, COUNT(*) AS count
       FROM audit_log
       WHERE action = 'SKIP' AND ts >= ?
       GROUP BY reason`
    )
    .all(sinceMs) as PreviewSkipReason[];

  return {
    sinceMs,
    copyCount: byAction.get("COPY") ?? 0,
    redeemCount: byAction.get("REDEEM") ?? 0,
    errorCount: byAction.get("ERROR") ?? 0,
    skipCount: byAction.get("SKIP") ?? 0,
    priceFilteredSkipCount: skipCountMatching(skipReasons, isPriceFilteredSkip),
    cashStarvedSkipCount: skipCountMatching(skipReasons, (reason) =>
      reason.startsWith("preview cash ")
    ),
    positionCapSkipCount: skipCountMatching(
      skipReasons,
      (reason) =>
        reason.includes("max position") ||
        reason.includes("position cap") ||
        reason.includes("token exposure")
    ),
    maxOpenMarketSkipCount: skipCountMatching(skipReasons, (reason) =>
      reason.startsWith("max open markets")
    ),
    noLocalRedeemSkipCount: skipCountMatching(
      skipReasons,
      isNoLocalRedeemSkip
    ),
    unmatchedRedeemSkipCount: skipCountMatching(
      skipReasons,
      isSuspiciousRedeemSkip
    ),
  };
}

export function readStabilityGoalEvidence(
  db: Database.Database,
  copyPathSinceMs: number,
  errorSinceMs: number
): StabilityGoalEvidence {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'DETECT' AND side = 'BUY' THEN 1 ELSE 0 END), 0) AS detectedBuy,
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'DETECT' AND side = 'SELL' THEN 1 ELSE 0 END), 0) AS detectedSell,
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'COPY' AND side = 'BUY' THEN 1 ELSE 0 END), 0) AS copiedBuy,
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'COPY' AND side = 'SELL' THEN 1 ELSE 0 END), 0) AS copiedSell,
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'SKIP' AND side = 'BUY'
           AND COALESCE(reason, '') IN (@dedupReason0, @dedupReason1) THEN 1 ELSE 0 END), 0) AS dedupedBuy,
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'SKIP' AND side = 'SELL'
           AND COALESCE(reason, '') IN (@dedupReason0, @dedupReason1) THEN 1 ELSE 0 END), 0) AS dedupedSell,
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'SKIP' AND side = 'BUY'
           AND COALESCE(reason, '') NOT IN (@dedupReason0, @dedupReason1) THEN 1 ELSE 0 END), 0) AS skippedBuy,
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'SKIP' AND side = 'SELL'
           AND COALESCE(reason, '') NOT IN (@dedupReason0, @dedupReason1) THEN 1 ELSE 0 END), 0) AS skippedSell,
         COALESCE(SUM(CASE WHEN ts >= @copyPathSinceMs AND action = 'REDEEM' THEN 1 ELSE 0 END), 0) AS redeemCount,
         COALESCE(SUM(CASE WHEN ts >= @errorSinceMs AND action = 'ERROR' THEN 1 ELSE 0 END), 0) AS recentErrorCount
       FROM audit_log
       WHERE ts >= @minimumSinceMs
         AND action IN ('DETECT', 'COPY', 'SKIP', 'REDEEM', 'ERROR')`
    )
    .get({
      copyPathSinceMs,
      errorSinceMs,
      minimumSinceMs: Math.min(copyPathSinceMs, errorSinceMs),
      dedupReason0: PREVIEW_COPY_DEDUP_REASONS[0],
      dedupReason1: PREVIEW_COPY_DEDUP_REASONS[1],
    }) as {
      detectedBuy: number;
      detectedSell: number;
      copiedBuy: number;
      copiedSell: number;
      dedupedBuy: number;
      dedupedSell: number;
      skippedBuy: number;
      skippedSell: number;
      redeemCount: number;
      recentErrorCount: number;
    };

  const unclassified = (
    detected: number,
    deduped: number,
    copied: number,
    skipped: number
  ): number => Math.max(0, Math.max(0, detected - deduped) - copied - skipped);
  return {
    recentErrorCount: row.recentErrorCount,
    copyPath: {
      copiedBuy: row.copiedBuy,
      copiedSell: row.copiedSell,
      redeemCount: row.redeemCount,
      unclassifiedGap:
        unclassified(row.detectedBuy, row.dedupedBuy, row.copiedBuy, row.skippedBuy) +
        unclassified(row.detectedSell, row.dedupedSell, row.copiedSell, row.skippedSell),
    },
  };
}

function tryParseAuditPnl(reason: string | null): number | null {
  const match = reason?.match(/pnl\s+(-?)\$?(-?\d[\d,]*(?:\.\d+)?)/i);
  if (!match) return null;
  const sign = match[1] === "-" || match[2].startsWith("-") ? -1 : 1;
  const amount = Math.abs(Number(match[2].replace(/,/g, "")));
  return Number.isFinite(amount) ? sign * amount : null;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return round2((part / total) * 100);
}

function ratioOrNull(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round2(numerator / denominator);
}

function emptyDetectionLatency(
  status: PreviewDetectionLatencySummary["status"] = "no_sample",
  experimentId: string | null = null,
  blockers: string[] = []
): PreviewDetectionLatencySummary {
  return {
    basis: "source_to_first_observation",
    experimentId,
    status,
    tradeEventCount: 0,
    sampleCount: 0,
    payloadParseFailureCount: 0,
    invalidTimestampCount: 0,
    futureTimestampCount: 0,
    p50Ms: null,
    p90Ms: null,
    p99Ms: null,
    maxMs: null,
    blockers,
  };
}

function normalizeSourceTimestampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const milliseconds = value > 1e12 ? value : value * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentile * values.length) - 1);
  return values[Math.min(index, values.length - 1)] ?? null;
}

function readDetectionLatency(
  db: Database.Database,
  hasRawEvents: boolean,
  experimentId: string | null,
  nowMs: number
): PreviewDetectionLatencySummary {
  if (!hasRawEvents || experimentId === null) {
    return emptyDetectionLatency("not_applicable", experimentId);
  }
  const rows = db.prepare(
    `SELECT source_timestamp AS sourceTimestamp,
            observed_timestamp AS observedTimestamp,
            normalized_payload_json AS payloadJson
     FROM raw_events
     WHERE experiment_id = ?
     ORDER BY observed_timestamp ASC, raw_event_id ASC`
  ).all(experimentId) as Array<{
    sourceTimestamp: number;
    observedTimestamp: number;
    payloadJson: string;
  }>;
  const latencies: number[] = [];
  let tradeEventCount = 0;
  let payloadParseFailureCount = 0;
  let invalidTimestampCount = 0;
  let futureTimestampCount = 0;
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      payloadParseFailureCount++;
      continue;
    }
    if (!payload || typeof payload !== "object"
      || (payload as Record<string, unknown>).type !== "TRADE") {
      continue;
    }
    tradeEventCount++;
    const sourceTimestampMs = normalizeSourceTimestampMs(row.sourceTimestamp);
    if (sourceTimestampMs === null
      || !Number.isSafeInteger(row.observedTimestamp)
      || row.observedTimestamp <= 1e12) {
      invalidTimestampCount++;
      continue;
    }
    const latencyMs = row.observedTimestamp - sourceTimestampMs;
    if (sourceTimestampMs > nowMs || row.observedTimestamp > nowMs || latencyMs < 0) {
      futureTimestampCount++;
      continue;
    }
    latencies.push(latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const blockers: string[] = [];
  if (payloadParseFailureCount > 0) blockers.push("raw event payload parse failures");
  if (invalidTimestampCount > 0) blockers.push("invalid source or observation timestamps");
  if (futureTimestampCount > 0) {
    blockers.push("future or source-after-observation timestamps");
  }
  const status: PreviewDetectionLatencySummary["status"] = blockers.length > 0
    ? "invalid"
    : latencies.length > 0
      ? "valid"
      : "no_sample";
  return {
    basis: "source_to_first_observation",
    experimentId,
    status,
    tradeEventCount,
    sampleCount: latencies.length,
    payloadParseFailureCount,
    invalidTimestampCount,
    futureTimestampCount,
    p50Ms: nearestRank(latencies, 0.5),
    p90Ms: nearestRank(latencies, 0.9),
    p99Ms: nearestRank(latencies, 0.99),
    maxMs: latencies.at(-1) ?? null,
    blockers,
  };
}

interface SettledMarketPnl {
  marketId: string;
  ts: number;
  pnlUsd: number;
}

interface RedeemPnlEvidenceRow {
  ts: number;
  conditionId: string | null;
  pnlUsd: number | null;
}

interface RedeemPnlEvidence {
  rows: RedeemPnlEvidenceRow[];
  markets: SettledMarketPnl[];
  concentration: PreviewWinningConditionConcentrationSummary;
}

function readRedeemPnlEvidence(
  db: Database.Database,
  hasAuditLog: boolean,
  hasTokenMarkets: boolean
): RedeemPnlEvidence {
  if (!hasAuditLog) {
    return {
      rows: [],
      markets: [],
      concentration: emptyWinningConditionConcentration(),
    };
  }

  const rawRows = db
    .prepare(
      hasTokenMarkets
        ? `WITH known_conditions AS (
             SELECT condition_id AS conditionId
             FROM token_markets
             GROUP BY condition_id
           )
           SELECT a.ts,
                  COALESCE(token_market.condition_id, known_condition.conditionId) AS conditionId,
                  a.reason
           FROM audit_log a
           LEFT JOIN token_markets token_market ON token_market.token_id = a.token_id
           LEFT JOIN known_conditions known_condition ON known_condition.conditionId = a.token_id
           WHERE a.action = 'REDEEM'
           ORDER BY a.ts ASC, a.id ASC`
        : `SELECT ts, NULL AS conditionId, reason
           FROM audit_log
           WHERE action = 'REDEEM'
           ORDER BY ts ASC, id ASC`
    )
    .all() as { ts: number; conditionId: string | null; reason: string | null }[];
  const rows = rawRows.map((row) => ({
    ts: row.ts,
    conditionId: row.conditionId,
    pnlUsd: tryParseAuditPnl(row.reason),
  }));

  const byCondition = new Map<string, SettledMarketPnl>();
  for (const row of rows) {
    if (row.conditionId === null || row.pnlUsd === null) continue;
    const current = byCondition.get(row.conditionId);
    byCondition.set(row.conditionId, {
      marketId: row.conditionId,
      ts: Math.max(current?.ts ?? 0, row.ts),
      pnlUsd: round2((current?.pnlUsd ?? 0) + row.pnlUsd),
    });
  }
  const markets = [...byCondition.values()].sort((a, b) => a.ts - b.ts);
  const redeemCount = rows.length;
  const conditionMappedRedeemCount = rows.filter((row) => row.conditionId !== null).length;
  const pnlParsedRedeemCount = rows.filter((row) => row.pnlUsd !== null).length;
  const evidenceComplete =
    redeemCount > 0 &&
    conditionMappedRedeemCount === redeemCount &&
    pnlParsedRedeemCount === redeemCount;

  let concentration = emptyWinningConditionConcentration();
  concentration = {
    ...concentration,
    evidenceStatus: redeemCount === 0 ? "no_sample" : evidenceComplete ? "complete" : "incomplete",
    redeemCount,
    conditionMappedRedeemCount,
    conditionMappingMissingCount: redeemCount - conditionMappedRedeemCount,
    conditionMappingCoveragePct: pct(conditionMappedRedeemCount, redeemCount),
    pnlParsedRedeemCount,
    pnlParseFailureCount: redeemCount - pnlParsedRedeemCount,
    pnlParseCoveragePct: pct(pnlParsedRedeemCount, redeemCount),
    settledConditionCount: markets.length,
    winningConditionCount: markets.filter((market) => market.pnlUsd > 0).length,
  };

  if (evidenceComplete) {
    const netConditionPnlUsd = round2(
      markets.reduce((sum, market) => sum + market.pnlUsd, 0)
    );
    const winningPnl = markets
      .map((market) => market.pnlUsd)
      .filter((pnlUsd) => pnlUsd > 0)
      .sort((a, b) => b - a);
    const grossWinningConditionPnlUsd = round2(
      winningPnl.reduce((sum, pnlUsd) => sum + pnlUsd, 0)
    );
    const topWinningSum = (count: number): number =>
      round2(winningPnl.slice(0, count).reduce((sum, pnlUsd) => sum + pnlUsd, 0));
    const top1 = topWinningSum(1);
    const top2 = topWinningSum(2);
    const top3 = topWinningSum(3);
    concentration = {
      ...concentration,
      netConditionPnlUsd,
      grossWinningConditionPnlUsd,
      top1WinningConditionGrossProfitSharePct: pct(top1, grossWinningConditionPnlUsd),
      top2WinningConditionGrossProfitSharePct: pct(top2, grossWinningConditionPnlUsd),
      top3WinningConditionGrossProfitSharePct: pct(top3, grossWinningConditionPnlUsd),
      netPnlAfterRemovingTop1WinningConditionUsd: round2(netConditionPnlUsd - top1),
      netPnlAfterRemovingTop2WinningConditionsUsd: round2(netConditionPnlUsd - top2),
      netPnlAfterRemovingTop3WinningConditionsUsd: round2(netConditionPnlUsd - top3),
    };
  }

  return { rows, markets, concentration };
}

interface CopySlippageRow {
  ts: number;
  marketId: string;
  size: number | null;
  price: number | null;
  leaderPrice: number | null;
  executablePrice: number | null;
  slippagePct: number | null;
}

function summarizeSlippage(rows: CopySlippageRow[]): Omit<
  PreviewGoalSlippageSummary,
  "basis" | "isRealizedFill" | "observationStartedAtMs" | "observationDays"
> {
  let totalNotionalUsd = 0;
  let sampledNotionalUsd = 0;
  let weightedLoss = 0;
  let sampleCount = 0;

  for (const row of rows) {
    const referencePrice = row.leaderPrice ?? row.price ?? 0;
    const notional = Math.abs((row.size ?? 0) * referencePrice);
    totalNotionalUsd += notional;
    if (
      row.executablePrice !== null &&
      row.slippagePct !== null &&
      Number.isFinite(row.slippagePct)
    ) {
      sampleCount++;
      sampledNotionalUsd += notional;
      weightedLoss += row.slippagePct * notional;
    }
  }

  return {
    copyCount: rows.length,
    sampleCount,
    totalNotionalUsd: round2(totalNotionalUsd),
    sampledNotionalUsd: round2(sampledNotionalUsd),
    coveragePct: totalNotionalUsd > 0 ? round2((sampledNotionalUsd / totalNotionalUsd) * 100) : 0,
    lossPct: sampledNotionalUsd > 0 ? round2(weightedLoss / sampledNotionalUsd) : null,
  };
}

interface NativeSlippageDbRow {
  id: number;
  ts: number;
  experimentId: string | null;
  action: "COPY" | "SKIP";
  leaderId: string | null;
  tokenId: string | null;
  side: string | null;
  size: number | null;
  price: number | null;
  leaderPrice: number | null;
  executablePrice: number | null;
  slippagePct: number | null;
  reason: string | null;
  auditDecisionId: string | null;
  decisionId: string | null;
  decisionExperimentId: string | null;
  decisionAction: string | null;
  exactTermsJson: string | null;
}

type QuoteDisposition =
  | "sampled"
  | "unavailable"
  | "unfillable"
  | "below_min_order"
  | "invalid";

interface AnalyzedQuoteAttempt {
  row: NativeSlippageDbRow;
  notionalUsd: number;
  linked: boolean;
  actionMismatch: boolean;
  experimentMismatch: boolean;
  jsonParseFailure: boolean;
  fieldMismatch: boolean;
  quoteEvidenceMismatch: boolean;
  disposition: QuoteDisposition;
  quoteLossPct: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numbersMatch(left: number | null, right: number | null, tolerance = 1e-8): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= tolerance;
}

function expectedDecisionAction(row: NativeSlippageDbRow): "COPY" | "SELL" | "SKIP" | null {
  if (row.action === "SKIP") return "SKIP";
  if (row.side === "BUY") return "COPY";
  if (row.side === "SELL") return "SELL";
  return null;
}

function analyzeQuoteAttempt(
  row: NativeSlippageDbRow,
  activeExperimentId: string
): AnalyzedQuoteAttempt {
  const leaderPrice = row.leaderPrice;
  const notionalUsd =
    leaderPrice !== null && Number.isFinite(leaderPrice) && row.size !== null
      ? Math.abs(row.size * leaderPrice)
      : 0;
  const linked = row.auditDecisionId !== null && row.decisionId !== null;
  const expectedAction = expectedDecisionAction(row);
  const actionMismatch = linked && row.decisionAction !== expectedAction;
  const experimentMismatch =
    linked &&
    (row.experimentId !== activeExperimentId ||
      row.decisionExperimentId !== activeExperimentId ||
      row.decisionExperimentId !== row.experimentId);
  let jsonParseFailure = false;
  let terms: Record<string, unknown> | null = null;
  if (linked && row.exactTermsJson !== null) {
    try {
      const parsed = JSON.parse(row.exactTermsJson) as unknown;
      if (isRecord(parsed)) terms = parsed;
      else jsonParseFailure = true;
    } catch {
      jsonParseFailure = true;
    }
  } else if (linked) {
    jsonParseFailure = true;
  }

  let fieldMismatch = false;
  let quoteEvidenceMismatch = false;
  let disposition: QuoteDisposition = "invalid";
  let quoteLossPct: number | null = null;

  if (terms) {
    const side = terms.side;
    const requestedPrice = finiteNumber(terms.requestedPrice);
    const requestedShares = finiteNumber(terms.requestedShares);
    const termsLeaderPrice = finiteNumber(terms.leaderPrice);
    const termsSize = finiteNumber(terms.size);
    const termsPrice = finiteNumber(terms.price);
    const hasReason = Object.prototype.hasOwnProperty.call(terms, "reason");
    const termsReason = terms.reason === null || typeof terms.reason === "string"
      ? terms.reason
      : undefined;
    const hasExecutablePrice = Object.prototype.hasOwnProperty.call(terms, "executablePrice");
    const termsExecutablePrice = terms.executablePrice === null
      ? null
      : finiteNumber(terms.executablePrice);
    const hasSlippagePct = Object.prototype.hasOwnProperty.call(terms, "slippagePct");
    const termsSlippagePct = terms.slippagePct === null
      ? null
      : finiteNumber(terms.slippagePct);
    const hasQuoteBestPrice = Object.prototype.hasOwnProperty.call(terms, "quoteBestPrice");
    const hasQuoteEvidence = Object.prototype.hasOwnProperty.call(terms, "quoteEvidence");
    const quoteBestPrice = terms.quoteBestPrice === null
      ? null
      : finiteNumber(terms.quoteBestPrice);
    if (
      (side !== "BUY" && side !== "SELL") ||
      side !== row.side ||
      row.leaderId !== (terms.leaderId ?? null) ||
      row.tokenId !== (terms.tokenId ?? null) ||
      terms.preview !== true ||
      leaderPrice === null ||
      leaderPrice <= 0 ||
      requestedPrice === null ||
      requestedPrice <= 0 ||
      requestedPrice >= 1 ||
      requestedShares === null ||
      requestedShares <= 0 ||
      termsLeaderPrice === null ||
      !numbersMatch(termsLeaderPrice, leaderPrice) ||
      termsSize === null ||
      !numbersMatch(termsSize, row.size) ||
      termsPrice === null ||
      !numbersMatch(termsPrice, row.price) ||
      !numbersMatch(requestedPrice, row.price) ||
      !numbersMatch(requestedShares, row.size) ||
      !hasReason ||
      termsReason === undefined ||
      termsReason !== row.reason ||
      !hasExecutablePrice ||
      (terms.executablePrice !== null && termsExecutablePrice === null) ||
      !numbersMatch(termsExecutablePrice, row.executablePrice) ||
      !hasSlippagePct ||
      (terms.slippagePct !== null && termsSlippagePct === null) ||
      !numbersMatch(termsSlippagePct, row.slippagePct) ||
      !hasQuoteBestPrice ||
      !hasQuoteEvidence ||
      (terms.quoteBestPrice !== null && quoteBestPrice === null)
    ) {
      fieldMismatch = true;
    }

    if (!fieldMismatch) {
      const evidence = terms.quoteEvidence;
      if (evidence === null) {
        if (quoteBestPrice !== null) quoteEvidenceMismatch = true;
        else disposition = "unavailable";
      } else if (!isRecord(evidence) || !Array.isArray(evidence.levels)) {
        fieldMismatch = true;
      } else {
        const minOrderShares = finiteNumber(evidence.minOrderShares);
        const tickSize = finiteNumber(evidence.tickSize);
        const levelsValid = evidence.levels.every((level) => {
          if (!isRecord(level)) return false;
          const price = Number(level.price);
          const size = Number(level.size);
          return Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(size) && size > 0;
        });
        if (
          minOrderShares === null ||
          minOrderShares < 0 ||
          tickSize === null ||
          tickSize <= 0 ||
          !levelsValid
        ) {
          fieldMismatch = true;
        } else {
          const requiredUsd = side === "BUY"
            ? finiteNumber(terms.sdkExpectedMakerAmountUsd)
            : null;
          const quote = quoteExecutableOrderBook(
            evidence.levels as OrderBookLevelLike[],
            side as "BUY" | "SELL",
            requestedShares!,
            requestedPrice!,
            minOrderShares,
            requiredUsd === null || requiredUsd <= 0 ? undefined : requiredUsd
          );
          const expectedQuotePrice = quote.fullyFillable ? quote.averagePrice : quote.bestPrice;
          if (!numbersMatch(expectedQuotePrice, quoteBestPrice)) {
            quoteEvidenceMismatch = true;
          } else if (quote.bestPrice === null) {
            disposition = "unavailable";
          } else if (!quote.fullyFillable) {
            // The guarded limit is an execution policy, not a sampling boundary.
            // Recompute every incomplete guarded quote against the same full
            // visible side so high-price depth is not removed by survivor bias.
            const unrestricted = quoteExecutableOrderBook(
              evidence.levels as OrderBookLevelLike[],
              side as "BUY" | "SELL",
              requestedShares!,
              side === "BUY" ? 1 - Number.EPSILON : Number.MIN_VALUE,
              minOrderShares,
              requiredUsd === null || requiredUsd <= 0 ? undefined : requiredUsd
            );
            if (!unrestricted.fullyFillable || unrestricted.averagePrice === null) {
              disposition = "unfillable";
            } else if (!unrestricted.meetsMinOrderSize) {
              disposition = "below_min_order";
            } else {
              quoteLossPct = calculateCopySlippageLossPct(
                side as "BUY" | "SELL",
                leaderPrice!,
                unrestricted.averagePrice
              );
              disposition = quoteLossPct === null ? "invalid" : "sampled";
              if (quoteLossPct === null) fieldMismatch = true;
            }
          } else if (!quote.meetsMinOrderSize) {
            disposition = "below_min_order";
          } else if (quote.averagePrice !== null) {
            quoteLossPct = calculateCopySlippageLossPct(
              side as "BUY" | "SELL",
              leaderPrice!,
              quote.averagePrice
            );
            disposition = quoteLossPct === null ? "invalid" : "sampled";
            if (quoteLossPct === null) fieldMismatch = true;
          }
        }
      }
    }
  }

  if (
    !linked ||
    actionMismatch ||
    experimentMismatch ||
    jsonParseFailure ||
    fieldMismatch ||
    quoteEvidenceMismatch
  ) {
    disposition = "invalid";
  }
  return {
    row,
    notionalUsd,
    linked,
    actionMismatch,
    experimentMismatch,
    jsonParseFailure,
    fieldMismatch,
    quoteEvidenceMismatch,
    disposition,
    quoteLossPct,
  };
}

function summarizePollTimeQuoteAttempts(
  attempts: AnalyzedQuoteAttempt[]
): PreviewPollTimeQuoteSlippageSlice {
  const attemptCount = attempts.length;
  const decisionLinkedCount = attempts.filter((entry) => entry.linked).length;
  const actionMismatchCount = attempts.filter((entry) => entry.actionMismatch).length;
  const experimentMismatchCount = attempts.filter((entry) => entry.experimentMismatch).length;
  const jsonParseFailureCount = attempts.filter((entry) => entry.jsonParseFailure).length;
  const fieldMismatchCount = attempts.filter((entry) => entry.fieldMismatch).length;
  const quoteEvidenceMismatchCount = attempts.filter((entry) => entry.quoteEvidenceMismatch).length;
  const totalNotionalUsd = attempts.reduce((sum, entry) => sum + entry.notionalUsd, 0);
  const sampled = attempts.filter(
    (entry) => entry.disposition === "sampled" && entry.quoteLossPct !== null
  );
  const sampledNotionalUsd = sampled.reduce((sum, entry) => sum + entry.notionalUsd, 0);
  const weightedLoss = sampled.reduce(
    (sum, entry) => sum + entry.quoteLossPct! * entry.notionalUsd,
    0
  );
  const decisionLinkMissingCount = attemptCount - decisionLinkedCount;
  const blockers: string[] = [];
  if (decisionLinkMissingCount > 0) blockers.push("quote-stage decision link coverage below 100%");
  if (actionMismatchCount > 0) blockers.push("quote-stage decision action mismatch");
  if (experimentMismatchCount > 0) blockers.push("quote-stage decision experiment mismatch");
  if (jsonParseFailureCount > 0) blockers.push("quote-stage exact terms JSON invalid");
  if (fieldMismatchCount > 0) blockers.push("quote-stage exact terms fields mismatch audit");
  if (quoteEvidenceMismatchCount > 0) blockers.push("quote-stage order-book quote recomputation mismatch");
  const coveragePct = totalNotionalUsd > 0
    ? round2((sampledNotionalUsd / totalNotionalUsd) * 100)
    : 0;
  const status: PreviewNativeSlippageStatus =
    attemptCount === 0
      ? "no_sample"
      : blockers.length > 0
        ? "invalid"
        : coveragePct < NATIVE_SLIPPAGE_MIN_COVERAGE_PCT
          ? "insufficient_coverage"
          : "valid";
  return {
    status,
    attemptCount,
    executedCopyCount: attempts.filter((entry) => entry.row.action === "COPY").length,
    rejectedSkipCount: attempts.filter((entry) => entry.row.action === "SKIP").length,
    decisionLinkedCount,
    decisionLinkMissingCount,
    decisionLinkCoveragePct: pct(decisionLinkedCount, attemptCount),
    actionMismatchCount,
    experimentMismatchCount,
    jsonParseFailureCount,
    fieldMismatchCount,
    quoteEvidenceMismatchCount,
    unavailableCount: attempts.filter((entry) => entry.disposition === "unavailable").length,
    unfillableCount: attempts.filter((entry) => entry.disposition === "unfillable").length,
    belowMinOrderCount: attempts.filter((entry) => entry.disposition === "below_min_order").length,
    sampleCount: sampled.length,
    totalNotionalUsd: round2(totalNotionalUsd),
    sampledNotionalUsd: round2(sampledNotionalUsd),
    coveragePct,
    lossPct: sampledNotionalUsd > 0 ? round2(weightedLoss / sampledNotionalUsd) : null,
    blockers,
  };
}

function summarizeSimulatedLimitSlippage(
  attempts: AnalyzedQuoteAttempt[],
  experimentId: string
): PreviewSimulatedLimitSlippageSummary {
  const copies = attempts.filter((entry) => entry.row.action === "COPY");
  const decisionLinkedCount = copies.filter((entry) => entry.linked).length;
  const actionMismatchCount = copies.filter((entry) => entry.actionMismatch).length;
  const experimentMismatchCount = copies.filter((entry) => entry.experimentMismatch).length;
  const jsonParseFailureCount = copies.filter((entry) => entry.jsonParseFailure).length;
  const fieldMismatchCount = copies.filter((entry) => entry.fieldMismatch).length;
  const quoteEvidenceMismatchCount = copies.filter((entry) => entry.quoteEvidenceMismatch).length;
  let telemetryMissingCount = 0;
  let telemetryMismatchCount = 0;
  let sampledNotionalUsd = 0;
  let weightedLoss = 0;
  const totalNotionalUsd = copies.reduce((sum, entry) => sum + entry.notionalUsd, 0);
  for (const entry of copies) {
    const { row } = entry;
    if (
      row.side !== "BUY" && row.side !== "SELL" ||
      row.leaderPrice === null ||
      row.executablePrice === null ||
      row.slippagePct === null ||
      !Number.isFinite(row.slippagePct)
    ) {
      telemetryMissingCount++;
      continue;
    }
    const recomputed = calculateCopySlippageLossPct(
      row.side,
      row.leaderPrice,
      row.executablePrice
    );
    if (recomputed === null || !numbersMatch(recomputed, row.slippagePct, 1e-4)) {
      telemetryMismatchCount++;
      continue;
    }
    sampledNotionalUsd += entry.notionalUsd;
    weightedLoss += recomputed * entry.notionalUsd;
  }
  const decisionLinkMissingCount = copies.length - decisionLinkedCount;
  const blockers: string[] = [];
  if (decisionLinkMissingCount > 0) blockers.push("simulated COPY decision link coverage below 100%");
  if (actionMismatchCount > 0) blockers.push("simulated COPY decision action mismatch");
  if (experimentMismatchCount > 0) blockers.push("simulated COPY decision experiment mismatch");
  if (jsonParseFailureCount > 0) blockers.push("simulated COPY exact terms JSON invalid");
  if (fieldMismatchCount > 0) blockers.push("simulated COPY exact terms fields mismatch audit");
  if (quoteEvidenceMismatchCount > 0) blockers.push("simulated COPY quote recomputation mismatch");
  if (telemetryMismatchCount > 0) blockers.push("simulated COPY slippage telemetry mismatch");
  const coveragePct = totalNotionalUsd > 0
    ? round2((sampledNotionalUsd / totalNotionalUsd) * 100)
    : 0;
  const status: PreviewNativeSlippageStatus =
    copies.length === 0
      ? "no_sample"
      : blockers.length > 0
        ? "invalid"
        : coveragePct < NATIVE_SLIPPAGE_MIN_COVERAGE_PCT
          ? "insufficient_coverage"
          : "valid";
  return {
    basis: "preview_guarded_limit_full_fill",
    isRealizedFill: false,
    status,
    experimentId,
    copyCount: copies.length,
    decisionLinkedCount,
    decisionLinkMissingCount,
    decisionLinkCoveragePct: pct(decisionLinkedCount, copies.length),
    actionMismatchCount,
    experimentMismatchCount,
    jsonParseFailureCount,
    fieldMismatchCount,
    quoteEvidenceMismatchCount,
    telemetryMissingCount,
    telemetryMismatchCount,
    sampleCount: copies.length - telemetryMissingCount - telemetryMismatchCount,
    totalNotionalUsd: round2(totalNotionalUsd),
    sampledNotionalUsd: round2(sampledNotionalUsd),
    coveragePct,
    lossPct: sampledNotionalUsd > 0 ? round2(weightedLoss / sampledNotionalUsd) : null,
    blockers,
  };
}

function readNativeSlippageMetrics(input: {
  db: Database.Database;
  hasAuditLog: boolean;
  hasSlippageTelemetry: boolean;
  hasDecisionEvidence: boolean;
  copyPriceMode: CopyPriceMode;
  experimentId: string | null;
  nowMs: number;
}): {
  pollTime: PreviewPollTimeExecutableQuoteSlippageSummary;
  simulated: PreviewSimulatedLimitSlippageSummary;
} {
  const { db, hasAuditLog, hasSlippageTelemetry, hasDecisionEvidence, copyPriceMode,
    experimentId, nowMs } = input;
  if (copyPriceMode !== "executable_guarded") {
    return {
      pollTime: emptyPollTimeQuoteSlippage("not_applicable", experimentId),
      simulated: emptySimulatedLimitSlippage("not_applicable", experimentId),
    };
  }
  if (!hasAuditLog || !hasSlippageTelemetry) {
    const blockers = ["native slippage audit columns unavailable"];
    return {
      pollTime: emptyPollTimeQuoteSlippage("invalid", experimentId, blockers),
      simulated: emptySimulatedLimitSlippage("invalid", experimentId, blockers),
    };
  }
  if (experimentId === null) {
    const count = (
      db.prepare(
        `SELECT COUNT(*) AS count FROM audit_log
         WHERE preview = 1 AND (action = 'COPY' OR (action = 'SKIP' AND leader_price IS NOT NULL))`
      ).get() as { count: number }
    ).count;
    const status: PreviewNativeSlippageStatus = count === 0 ? "no_sample" : "invalid";
    const blockers = count === 0 ? [] : ["active experiment unavailable for native slippage scope"];
    return {
      pollTime: emptyPollTimeQuoteSlippage(status, null, blockers),
      simulated: emptySimulatedLimitSlippage(status, null, blockers),
    };
  }
  if (!hasDecisionEvidence) {
    const blockers = ["decision evidence schema unavailable"];
    return {
      pollTime: emptyPollTimeQuoteSlippage("invalid", experimentId, blockers),
      simulated: emptySimulatedLimitSlippage("invalid", experimentId, blockers),
    };
  }

  const rows = db.prepare(
    `SELECT a.id, a.ts, a.experiment_id AS experimentId, a.action,
            a.leader_id AS leaderId, a.token_id AS tokenId, a.side, a.size, a.price,
            a.leader_price AS leaderPrice, a.executable_price AS executablePrice,
            a.slippage_pct AS slippagePct, a.reason, a.decision_id AS auditDecisionId,
            d.decision_id AS decisionId, d.experiment_id AS decisionExperimentId,
            d.action AS decisionAction, d.exact_terms_json AS exactTermsJson
     FROM audit_log a
     LEFT JOIN decisions d ON d.decision_id = a.decision_id
     WHERE a.experiment_id = ? AND a.preview = 1
       AND (a.action = 'COPY' OR (a.action = 'SKIP' AND a.leader_price IS NOT NULL))
     ORDER BY a.ts ASC, a.id ASC`
  ).all(experimentId) as NativeSlippageDbRow[];
  const attempts = rows.map((row) => analyzeQuoteAttempt(row, experimentId));
  let overall = summarizePollTimeQuoteAttempts(attempts);
  const quoteStageErrorCount = (
    db.prepare(
      `SELECT COUNT(*) AS count FROM audit_log
       WHERE experiment_id = ? AND preview = 1 AND action = 'ERROR' AND leader_price IS NOT NULL`
    ).get(experimentId) as { count: number }
  ).count;
  if (quoteStageErrorCount > 0) {
    overall = {
      ...overall,
      status: "invalid",
      blockers: [...overall.blockers, "quote-stage ERROR rows present without terminal decision evidence"],
    };
  }
  const observationStartedAtMs = rows[0]?.ts ?? null;
  return {
    pollTime: {
      basis: "poll_time_executable_order_book_quote",
      experimentId,
      observationStartedAtMs,
      observationDays: observationStartedAtMs === null
        ? 0
        : round2(Math.max(0, nowMs - observationStartedAtMs) / (24 * 60 * 60_000)),
      quoteStageErrorCount,
      ...overall,
      recent20: summarizePollTimeQuoteAttempts(attempts.slice(-20)),
    },
    simulated: summarizeSimulatedLimitSlippage(attempts, experimentId),
  };
}

function summarizeGoalMarketSlice(
  rows: SettledMarketPnl[],
  sinceMs?: number
): Omit<PreviewGoalWindowSummary, "sinceMs"> {
  const selected = sinceMs == null ? rows : rows.filter((row) => row.ts >= sinceMs);
  const values = selected.map((row) => row.pnlUsd);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const grossProfitUsd = round2(wins.reduce((sum, value) => sum + value, 0));
  const grossLossUsd = round2(Math.abs(losses.reduce((sum, value) => sum + value, 0)));
  return {
    marketCount: values.length,
    pnlUsd: round2(values.reduce((sum, value) => sum + value, 0)),
    winRatePct: pct(wins.length, values.length),
    profitFactor: ratioOrNull(grossProfitUsd, grossLossUsd),
    grossProfitUsd,
    grossLossUsd,
  };
}

function readGoalMetrics(
  db: Database.Database,
  hasAuditLog: boolean,
  hasTokenMarkets: boolean,
  hasSlippageTelemetry: boolean,
  nowMs: number,
  settledMarkets: SettledMarketPnl[],
  detectionLatency: PreviewDetectionLatencySummary,
  nativeSlippage: {
    pollTime: PreviewPollTimeExecutableQuoteSlippageSummary;
    simulated: PreviewSimulatedLimitSlippageSummary;
  }
): PreviewGoalMetrics {
  if (!hasAuditLog) return emptyGoalMetrics(nowMs);

  const copy = db
    .prepare(
      `SELECT MIN(ts) AS firstCopyAtMs,
              MAX(ts) AS lastCopyAtMs,
              COUNT(DISTINCT date(ts / 1000, 'unixepoch')) AS activeTradingDays,
              COALESCE(SUM(ABS(COALESCE(size, 0) * COALESCE(price, 0))), 0) AS volumeUsd
       FROM audit_log
       WHERE action = 'COPY'`
    )
    .get() as {
    firstCopyAtMs: number | null;
    lastCopyAtMs: number | null;
    activeTradingDays: number;
    volumeUsd: number;
  };
  const markets = settledMarkets;
  const copySlippageRows = hasSlippageTelemetry
    ? (db
        .prepare(
          hasTokenMarkets
            ? `SELECT a.ts,
                      COALESCE(m.condition_id, a.token_id, 'audit:' || a.id) AS marketId,
                      a.size, a.price, a.leader_price AS leaderPrice,
                      a.executable_price AS executablePrice,
                      a.slippage_pct AS slippagePct
               FROM audit_log a
               LEFT JOIN token_markets m ON m.token_id = a.token_id
               WHERE a.action = 'COPY'
               ORDER BY a.ts ASC, a.id ASC`
            : `SELECT ts,
                      COALESCE(token_id, 'audit:' || id) AS marketId,
                      size, price, leader_price AS leaderPrice,
                      executable_price AS executablePrice,
                      slippage_pct AS slippagePct
               FROM audit_log
               WHERE action = 'COPY'
               ORDER BY ts ASC, id ASC`
        )
        .all() as CopySlippageRow[])
    : [];
  const observationStartedAtMs =
    copySlippageRows.find((row) => row.leaderPrice !== null)?.ts ?? null;
  const observedEraRows =
    observationStartedAtMs === null
      ? []
      : copySlippageRows.filter((row) => row.ts >= observationStartedAtMs);
  const slippage = summarizeSlippage(observedEraRows);
  const all = summarizeGoalMarketSlice(markets);
  const recent20Markets = markets.slice(-20);
  const recent20 = summarizeGoalMarketSlice(recent20Markets);
  const recent20MarketIds = new Set(recent20Markets.map((row) => row.marketId));
  const recent20Slippage = summarizeSlippage(
    copySlippageRows.filter((row) => recent20MarketIds.has(row.marketId))
  );
  const grossCopyVolumeUsd = round2(copy.volumeUsd);
  const window = (durationMs: number): PreviewGoalWindowSummary => {
    const sinceMs = nowMs - durationMs;
    return { sinceMs, ...summarizeGoalMarketSlice(markets, sinceMs) };
  };

  return {
    observationDays:
      copy.firstCopyAtMs == null
        ? 0
        : round2(Math.max(0, nowMs - copy.firstCopyAtMs) / (24 * 60 * 60_000)),
    activeTradingDays: copy.activeTradingDays,
    firstCopyAtMs: copy.firstCopyAtMs,
    lastCopyAtMs: copy.lastCopyAtMs,
    settledMarketCount: markets.length,
    copyPnlUsd: all.pnlUsd,
    grossCopyVolumeUsd,
    pnlVolumePct:
      grossCopyVolumeUsd > 0 ? round2((all.pnlUsd / grossCopyVolumeUsd) * 100) : 0,
    detectionLatency,
    overall: {
      marketCount: all.marketCount,
      pnlUsd: all.pnlUsd,
      winRatePct: all.winRatePct,
      profitFactor: all.profitFactor,
      grossProfitUsd: all.grossProfitUsd,
      grossLossUsd: all.grossLossUsd,
      slippageSampleCount: slippage.sampleCount,
      slippageCoveragePct: slippage.coveragePct,
      slippageLossPct: slippage.lossPct,
      slippageBasis: "preview_guarded_limit_full_fill",
      slippageIsRealizedFill: false,
    },
    recent20: {
      marketCount: recent20.marketCount,
      pnlUsd: recent20.pnlUsd,
      winRatePct: recent20.winRatePct,
      profitFactor: recent20.profitFactor,
      grossProfitUsd: recent20.grossProfitUsd,
      grossLossUsd: recent20.grossLossUsd,
      slippageSampleCount: recent20Slippage.sampleCount,
      slippageCoveragePct: recent20Slippage.coveragePct,
      slippageLossPct: recent20Slippage.lossPct,
      slippageBasis: "preview_guarded_limit_full_fill",
      slippageIsRealizedFill: false,
    },
    pollTimeExecutableQuoteSlippage: nativeSlippage.pollTime,
    simulatedLimitSlippage: nativeSlippage.simulated,
    slippage: {
      basis: "preview_guarded_limit_full_fill",
      isRealizedFill: false,
      observationStartedAtMs,
      observationDays:
        observationStartedAtMs === null
          ? 0
          : round2(Math.max(0, nowMs - observationStartedAtMs) / (24 * 60 * 60_000)),
      ...slippage,
    },
    windows: {
      h24: window(24 * 60 * 60_000),
      d7: window(7 * 24 * 60 * 60_000),
      d14: window(14 * 24 * 60 * 60_000),
    },
  };
}

function sharpeRatio(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  return round2((mean / stdDev) * Math.sqrt(values.length));
}

function maxDrawdown(values: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }
  return round2(maxDrawdownUsd);
}

function summarizePerformanceSlice(
  values: number[],
  startingCapitalUsd: number,
  sinceMs: number | null,
  winningConditionConcentration = emptyWinningConditionConcentration()
): Omit<PreviewPerformanceSummary, "recent"> & { recent?: never } {
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const grossProfitUsd = round2(wins.reduce((sum, value) => sum + value, 0));
  const grossLossUsd = round2(Math.abs(losses.reduce((sum, value) => sum + value, 0)));
  const totalPnlUsd = round2(values.reduce((sum, value) => sum + value, 0));
  const maxDdUsd = maxDrawdown(values);
  const largestWinUsd = wins.length ? Math.max(...wins) : 0;
  const largestLossUsd = losses.length ? Math.min(...losses) : 0;
  const top3WinsUsd = wins
    .slice()
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, value) => sum + value, 0);
  const largestWinContributionPct =
    totalPnlUsd > 0 ? Math.min(100, pct(largestWinUsd, totalPnlUsd)) : 0;
  const top3WinContributionPct =
    totalPnlUsd > 0 ? Math.min(100, pct(top3WinsUsd, totalPnlUsd)) : 0;
  let dependencyIssue: PreviewProfitDependencyIssue = "insufficient_data";
  if (
    winningConditionConcentration.evidenceStatus === "complete" &&
    winningConditionConcentration.settledConditionCount >= 3
  ) {
    const conditionNetPnl = winningConditionConcentration.netConditionPnlUsd ?? 0;
    const conditionGrossProfit =
      winningConditionConcentration.grossWinningConditionPnlUsd ?? 0;
    const top1Share =
      winningConditionConcentration.top1WinningConditionGrossProfitSharePct ?? 0;
    const top3Share =
      winningConditionConcentration.top3WinningConditionGrossProfitSharePct ?? 0;
    const remainsProfitableWithoutTopWinners =
      (winningConditionConcentration.netPnlAfterRemovingTop1WinningConditionUsd ?? 0) > 0 &&
      (winningConditionConcentration.netPnlAfterRemovingTop2WinningConditionsUsd ?? 0) > 0 &&
      (winningConditionConcentration.netPnlAfterRemovingTop3WinningConditionsUsd ?? 0) > 0;
    if (conditionNetPnl <= 0 || conditionGrossProfit <= 0) {
      dependencyIssue = "no_profit";
    } else if (
      !remainsProfitableWithoutTopWinners ||
      top1Share >= 80 ||
      (winningConditionConcentration.settledConditionCount >= 10 && top3Share >= 90)
    ) {
      dependencyIssue = "concentrated";
    } else {
      dependencyIssue = "diversified";
    }
  }

  return {
    tradeCount: values.length,
    winCount: wins.length,
    lossCount: losses.length,
    flatCount: values.length - wins.length - losses.length,
    totalPnlUsd,
    grossProfitUsd,
    grossLossUsd,
    winRatePct: pct(wins.length, values.length),
    profitFactor: ratioOrNull(grossProfitUsd, grossLossUsd),
    payoffRatio: ratioOrNull(
      wins.length ? grossProfitUsd / wins.length : 0,
      losses.length ? grossLossUsd / losses.length : 0
    ),
    sharpeRatio: sharpeRatio(values),
    maxDrawdownUsd: maxDdUsd,
    maxDrawdownPct: pct(maxDdUsd, startingCapitalUsd),
    largestWinUsd: round2(largestWinUsd),
    largestLossUsd: round2(largestLossUsd),
    largestWinContributionPct,
    top3WinContributionPct,
    winningConditionConcentration,
    dependencyIssue,
    equityStabilityPct: Math.max(0, round2(100 - pct(maxDdUsd, startingCapitalUsd))),
  };
}

function readPreviewPerformance(
  redeemEvidence: RedeemPnlEvidence,
  startingCapitalUsd: number,
  sinceMs?: number
): PreviewPerformanceSummary {
  const rows = redeemEvidence.rows;
  if (rows.length === 0) return emptyPerformance(sinceMs ?? null);
  // Keep the legacy row-level performance fields backward compatible. Unknown
  // PnL remains zero only there; the new concentration evidence marks it
  // incomplete and all qualification gates fail closed.
  const values = rows.map((row) => row.pnlUsd ?? 0);
  const recentValues =
    sinceMs == null
      ? []
      : rows
          .filter((row) => row.ts >= sinceMs)
          .map((row) => row.pnlUsd ?? 0);
  const summary = summarizePerformanceSlice(
    values,
    startingCapitalUsd,
    null,
    redeemEvidence.concentration
  );
  const recent = summarizePerformanceSlice(recentValues, startingCapitalUsd, sinceMs ?? null);
  return {
    ...summary,
    recent: {
      sinceMs: sinceMs ?? null,
      tradeCount: recent.tradeCount,
      pnlUsd: recent.totalPnlUsd,
      winRatePct: recent.winRatePct,
      profitFactor: recent.profitFactor,
    },
  };
}

export function readPreviewAccountReport(
  options: ReadPreviewAccountReportOptions
): PreviewAccountReport {
  const limit = Math.min(50, Math.max(1, options.limit ?? 8));
  const initial = options.startingCapitalUsd ?? 200;
  const nowMs = options.nowMs ?? Date.now();
  if (!existsSync(options.dbPath)) return emptyReport(options);

  const db = new Database(options.dbPath, { readonly: true });
  try {
    configurePreviewReportDatabase(db);
    const hasCashLedger = tableExists(db, "cash_ledger");
    const hasAuditLog = tableExists(db, "audit_log");
    const copyPriceMode = readCopyPriceMode(db, hasAuditLog, options.copyPriceMode);
    const hasDailyStats = tableExists(db, "daily_stats");
    const hasTokenMarkets = tableExists(db, "token_markets");
    const hasPendingOrders = tableExists(db, "pending_orders");
    const hasLiveOrderIntents = tableExists(db, "live_order_intents");
    const provenance = tableExists(db, "experiments")
      ? db.prepare(
          `SELECT experiment_id AS experimentId, config_hash AS configHash,
                  git_sha AS gitSha, image_digest AS imageDigest,
                  lockfile_hash AS lockfileHash, schema_version AS schemaVersion,
                  trust_class AS trustClass
           FROM experiments
           WHERE account_id = ? AND ended_at IS NULL${columnExists(db, "experiments", "state") ? " AND state = 'ACTIVE'" : ""}
           ORDER BY started_at DESC LIMIT 1`
        ).get(options.accountId) as PreviewExperimentProvenance | undefined
      : undefined;
    const hasSlippageTelemetry =
      hasAuditLog &&
      columnExists(db, "audit_log", "leader_price") &&
      columnExists(db, "audit_log", "executable_price") &&
      columnExists(db, "audit_log", "slippage_pct");
    const hasDecisionEvidence =
      hasAuditLog &&
      tableExists(db, "decisions") &&
      columnExists(db, "audit_log", "experiment_id") &&
      columnExists(db, "audit_log", "decision_id") &&
      columnExists(db, "decisions", "experiment_id") &&
      columnExists(db, "decisions", "action") &&
      columnExists(db, "decisions", "exact_terms_json");

    const cash = hasCashLedger
      ? (db
          .prepare("SELECT cash_usd AS cashUsd FROM cash_ledger WHERE scope = 'preview'")
          .get() as { cashUsd: number } | undefined)
      : undefined;
    const positions = db
      .prepare(
        `SELECT COUNT(*) AS openPositions,
                COALESCE(SUM(shares * avg_entry_price), 0) AS openCostUsd
         FROM positions
         WHERE shares > 0`
      )
      .get() as { openPositions: number; openCostUsd: number };
    const missingMarketMetadataCount = hasTokenMarkets
      ? (
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM positions p
               LEFT JOIN token_markets m ON m.token_id = p.token_id
               WHERE p.shares > 0 AND m.token_id IS NULL`
            )
            .get() as { count: number }
        ).count
      : positions.openPositions;
    const pendingOrderCount = hasPendingOrders
      ? (
          db
            .prepare("SELECT COUNT(*) AS count FROM pending_orders")
            .get() as { count: number }
        ).count
      : 0;
    const liveOrderIntentCount = hasLiveOrderIntents
      ? (
          db
            .prepare("SELECT COUNT(*) AS count FROM live_order_intents")
            .get() as { count: number }
        ).count
      : 0;
    const stats = hasDailyStats
      ? (db
          .prepare(
            `SELECT COALESCE(SUM(realized_pnl), 0) AS realizedPnlUsd,
                    COALESCE(SUM(copy_count), 0) AS copyCount
             FROM daily_stats`
          )
          .get() as
          | { realizedPnlUsd: number; copyCount: number }
          | undefined)
      : undefined;
    const latestStats = hasDailyStats
      ? (db
          .prepare(
            `SELECT kill_switch AS killSwitch
             FROM daily_stats
             ORDER BY date DESC
             LIMIT 1`
          )
          .get() as { killSwitch: number } | undefined)
      : undefined;
    const counts = hasAuditLog
      ? (db
          .prepare(
            `SELECT action, COUNT(*) AS count
             FROM audit_log
             GROUP BY action`
          )
          .all() as { action: string; count: number }[])
      : [];
    const byAction = new Map(counts.map((row) => [row.action, row.count]));

    const skipReasons = hasAuditLog
      ? (db
          .prepare(
            `SELECT COALESCE(reason, '') AS reason, COUNT(*) AS count
             FROM audit_log
             WHERE action = 'SKIP'
             GROUP BY reason
             ORDER BY count DESC, reason ASC
             LIMIT ?`
          )
          .all(limit) as PreviewSkipReason[])
      : [];
    const allSkipReasons = hasAuditLog
      ? (db
          .prepare(
            `SELECT COALESCE(reason, '') AS reason, COUNT(*) AS count
             FROM audit_log
             WHERE action = 'SKIP'
             GROUP BY reason`
          )
          .all() as PreviewSkipReason[])
      : [];
    const recentRedeems = hasAuditLog
      ? (db
          .prepare(
            `SELECT id, ts, token_id AS conditionId, size AS payoutUsd, reason
             FROM audit_log
             WHERE action = 'REDEEM'
             ORDER BY id DESC
             LIMIT ?`
          )
          .all(limit) as PreviewRedeemSummary[])
      : [];
    const recentErrors = hasAuditLog
      ? (db
          .prepare(
            `SELECT id, ts, token_id AS tokenId, side, reason
             FROM audit_log
             WHERE action = 'ERROR'
             ORDER BY id DESC
             LIMIT ?`
          )
          .all(limit) as PreviewErrorSummary[])
      : [];
    const openMarkets = db
      .prepare(
        hasTokenMarkets
          ? `SELECT m.slug, MAX(m.title) AS title, COUNT(*) AS positions,
                    COALESCE(SUM(p.shares * p.avg_entry_price), 0) AS costUsd
             FROM positions p
             LEFT JOIN token_markets m ON m.token_id = p.token_id
             WHERE p.shares > 0
             GROUP BY COALESCE(m.slug, p.token_id)
             ORDER BY costUsd DESC
             LIMIT ?`
          : `SELECT NULL AS slug, NULL AS title, COUNT(*) AS positions,
                    COALESCE(SUM(p.shares * p.avg_entry_price), 0) AS costUsd
             FROM positions p
             WHERE p.shares > 0
             GROUP BY p.token_id
             ORDER BY costUsd DESC
             LIMIT ?`
      )
      .all(limit) as PreviewOpenMarketSummary[];
    const recentSinceMs =
      hasAuditLog && options.recentWindowMs && options.recentWindowMs > 0
        ? nowMs - options.recentWindowMs
        : undefined;
    const recentWindow =
      recentSinceMs != null ? summarizeRecentWindow(db, recentSinceMs) : undefined;
    const cashUsd = round4(cash?.cashUsd ?? initial);
    const openCostUsd = round4(positions.openCostUsd);
    const realizedPnlUsd = round4(stats?.realizedPnlUsd ?? 0);
    const replayedCashUsd = hasAuditLog
      ? replayPreviewCashFromAudit(db, initial).cashUsd
      : round4(initial);
    const cashReplayDeltaUsd = round4(cashUsd - replayedCashUsd);
    const capitalDeltaUsd = round4(cashUsd + openCostUsd - initial - realizedPnlUsd);
    const errorCount = byAction.get("ERROR") ?? 0;
    const killSwitch = Boolean(latestStats?.killSwitch ?? 0);
    const copyQualityContext = {
      db,
      hasAuditLog,
      hasTokenMarkets,
      cashUsd,
      openCostUsd,
      openPositions: positions.openPositions,
      realizedPnlUsd,
      errorCount: recentWindow?.errorCount ?? errorCount,
      killSwitch,
      pendingOrderCount,
      liveOrderIntentCount,
      cashReplayDeltaUsd,
      capitalDeltaUsd,
      missingMarketMetadataCount,
      limit,
    };
    const copyQuality = buildPreviewCopyQuality({
      ...copyQualityContext,
      sinceMs: recentSinceMs,
    });
    const stabilityEvidence = hasAuditLog
      ? readStabilityGoalEvidence(
          db,
          nowMs - STABILITY_GOAL_COPY_PATH_WINDOW_MS,
          nowMs - STABILITY_GOAL_ERROR_WINDOW_MS
        )
      : {
          recentErrorCount: 0,
          copyPath: {
            copiedBuy: 0,
            copiedSell: 0,
            redeemCount: 0,
            unclassifiedGap: 0,
          },
        };
    const redeemPnlEvidence = readRedeemPnlEvidence(
      db,
      hasAuditLog,
      hasTokenMarkets
    );
    const performance = readPreviewPerformance(
      redeemPnlEvidence,
      initial,
      recentSinceMs
    );
    const nativeSlippage = readNativeSlippageMetrics({
      db,
      hasAuditLog,
      hasSlippageTelemetry,
      hasDecisionEvidence,
      copyPriceMode,
      experimentId: provenance?.experimentId ?? null,
      nowMs,
    });
    const detectionLatency = readDetectionLatency(
      db,
      tableExists(db, "raw_events"),
      provenance?.experimentId ?? null,
      nowMs
    );
    const goalMetrics = readGoalMetrics(
      db,
      hasAuditLog,
      hasTokenMarkets,
      hasSlippageTelemetry,
      nowMs,
      redeemPnlEvidence.markets,
      detectionLatency,
      nativeSlippage
    );

    const report: PreviewAccountReport = {
      accountId: options.accountId,
      dbPath: options.dbPath,
      copyPriceMode,
      exists: true,
      cashUsd,
      openCostUsd,
      openPositions: positions.openPositions,
      realizedPnlUsd,
      cashReplayDeltaUsd,
      capitalDeltaUsd,
      missingMarketMetadataCount,
      pendingOrderCount,
      liveOrderIntentCount,
      copyCount: byAction.get("COPY") ?? stats?.copyCount ?? 0,
      redeemCount: byAction.get("REDEEM") ?? 0,
      errorCount,
      skipCount: byAction.get("SKIP") ?? 0,
      priceFilteredSkipCount: skipCountMatching(allSkipReasons, isPriceFilteredSkip),
      cashStarvedSkipCount: skipCountMatching(allSkipReasons, (reason) =>
        reason.startsWith("preview cash ")
      ),
      positionCapSkipCount: skipCountMatching(
        allSkipReasons,
        (reason) =>
          reason.includes("max position") ||
          reason.includes("position cap") ||
          reason.includes("token exposure")
      ),
      maxOpenMarketSkipCount: skipCountMatching(allSkipReasons, (reason) =>
        reason.startsWith("max open markets")
      ),
      noLocalRedeemSkipCount: skipCountMatching(
        allSkipReasons,
        isNoLocalRedeemSkip
      ),
      unmatchedRedeemSkipCount: skipCountMatching(
        allSkipReasons,
        isSuspiciousRedeemSkip
      ),
      killSwitch,
      skipReasons,
      recentRedeems: recentRedeems.map((r) => ({
        ...r,
        payoutUsd: r.payoutUsd === null ? null : round4(r.payoutUsd),
      })),
      recentErrors,
      openMarkets: openMarkets.map((m) => ({ ...m, costUsd: round4(m.costUsd) })),
      recentWindow,
      copyQuality,
      performance,
      goalMetrics,
      provenance,
    };
    return {
      ...report,
      profitabilityGate: assessProfitabilityGate(report),
      stabilityGoal: assessStabilityGoal(report, {}, stabilityEvidence),
    };
  } finally {
    db.close();
  }
}
