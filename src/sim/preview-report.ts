import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { replayPreviewCashFromAudit } from "./preview-cash-reconcile.js";
import {
  buildPreviewCopyQuality,
  emptyPreviewCopyQuality,
  type PreviewCopyQualitySummary,
} from "./preview-quality.js";
import {
  assessProfitabilityGate,
  type ProfitabilityGateAssessment,
} from "./profitability-gate.js";

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
  largestWinContributionPct: number;
  top3WinContributionPct: number;
  dependencyIssue: PreviewProfitDependencyIssue;
  equityStabilityPct: number;
  recent: PreviewPerformanceRecentSummary;
}

export interface PreviewAccountReport {
  accountId: string;
  dbPath: string;
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
  profitabilityGate?: ProfitabilityGateAssessment;
}

export interface ReadPreviewAccountReportOptions {
  accountId: string;
  dbPath: string;
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

function emptyReport(options: ReadPreviewAccountReportOptions): PreviewAccountReport {
  const report: PreviewAccountReport = {
    accountId: options.accountId,
    dbPath: options.dbPath,
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
  };
  return {
    ...report,
    profitabilityGate: assessProfitabilityGate(report),
  };
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
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

function parseAuditPnl(reason: string | null): number {
  const match = reason?.match(/pnl\s+(-?)\$?(-?\d[\d,]*(?:\.\d+)?)/i);
  if (!match) return 0;
  const sign = match[1] === "-" || match[2].startsWith("-") ? -1 : 1;
  const amount = Math.abs(Number(match[2].replace(/,/g, "")));
  return sign * amount;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return round2((part / total) * 100);
}

function ratioOrNull(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round2(numerator / denominator);
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
  sinceMs: number | null
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
  if (values.length >= 3) {
    if (totalPnlUsd <= 0 || grossProfitUsd <= 0) {
      dependencyIssue = "no_profit";
    } else if (largestWinContributionPct >= 80 || (values.length >= 10 && top3WinContributionPct >= 90)) {
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
    dependencyIssue,
    equityStabilityPct: Math.max(0, round2(100 - pct(maxDdUsd, startingCapitalUsd))),
  };
}

function readPreviewPerformance(
  db: Database.Database,
  hasAuditLog: boolean,
  startingCapitalUsd: number,
  sinceMs?: number
): PreviewPerformanceSummary {
  if (!hasAuditLog) return emptyPerformance(sinceMs ?? null);
  const rows = db
    .prepare(
      `SELECT ts, reason
       FROM audit_log
       WHERE action = 'REDEEM'
       ORDER BY ts ASC, id ASC`
    )
    .all() as { ts: number; reason: string | null }[];
  const values = rows.map((row) => parseAuditPnl(row.reason));
  const recentValues =
    sinceMs == null
      ? []
      : rows
          .filter((row) => row.ts >= sinceMs)
          .map((row) => parseAuditPnl(row.reason));
  const summary = summarizePerformanceSlice(values, startingCapitalUsd, null);
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
  if (!existsSync(options.dbPath)) return emptyReport(options);

  const db = new Database(options.dbPath, { readonly: true });
  try {
    const hasCashLedger = tableExists(db, "cash_ledger");
    const hasAuditLog = tableExists(db, "audit_log");
    const hasDailyStats = tableExists(db, "daily_stats");
    const hasTokenMarkets = tableExists(db, "token_markets");
    const hasPendingOrders = tableExists(db, "pending_orders");
    const hasLiveOrderIntents = tableExists(db, "live_order_intents");

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
        ? (options.nowMs ?? Date.now()) - options.recentWindowMs
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
    const copyQuality = buildPreviewCopyQuality({
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
      sinceMs: recentSinceMs,
      limit,
    });
    const performance = readPreviewPerformance(
      db,
      hasAuditLog,
      initial,
      recentSinceMs
    );

    const report: PreviewAccountReport = {
      accountId: options.accountId,
      dbPath: options.dbPath,
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
    };
    return {
      ...report,
      profitabilityGate: assessProfitabilityGate(report),
    };
  } finally {
    db.close();
  }
}
