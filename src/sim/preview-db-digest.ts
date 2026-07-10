import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assessSmallLiveCandidates,
  type SmallLiveGateResult,
} from "./small-live-gate.js";

export interface PreviewDbDigestOptions {
  dataDir: string;
  accounts?: string[];
  startingCapitalUsd?: number;
  recentWindowMs?: number;
  staleAfterMs?: number;
  limit?: number;
  nowMs?: number;
}

export interface PreviewDbDigestReason {
  reason: string;
  count: number;
}

export interface PreviewDbDigestWinStats {
  settledCount: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  winRatePct: number | null;
  parsedPnlUsd: number;
}

export interface PreviewDbDigestAccount {
  accountId: string;
  dbPath: string;
  exists: boolean;
  readError: string | null;
  lastAuditAt: string | null;
  lastAuditAgeMinutes: number | null;
  stale: boolean;
  cashUsd: number;
  openCostUsd: number;
  equityCostBasisUsd: number;
  realizedPnlUsd: number;
  roiPct: number;
  openPositions: number;
  copyCount: number;
  redeemCount: number;
  errorCount: number;
  skipCount: number;
  pendingOrderCount: number;
  liveOrderIntentCount: number;
  missingMarketMetadataCount: number;
  killSwitch: boolean;
  recent: {
    copyCount: number;
    redeemCount: number;
    errorCount: number;
    skipCount: number;
    cashStarvedSkipCount: number;
    positionCapSkipCount: number;
    noLocalRedeemSkipCount: number;
    marketUnresolvedSkipCount: number;
  };
  winStats: PreviewDbDigestWinStats;
  recentWinStats: PreviewDbDigestWinStats;
  topSkipReasons: PreviewDbDigestReason[];
  topErrorReasons: PreviewDbDigestReason[];
}

export interface PreviewDbDigest {
  generatedAt: string;
  dataDir: string;
  accountCount: number;
  missingDbCount: number;
  staleCount: number;
  totals: {
    cashUsd: number;
    openCostUsd: number;
    equityCostBasisUsd: number;
    realizedPnlUsd: number;
    copies: number;
    redeems: number;
    errors: number;
    skips: number;
  };
  riskCounts: {
    killSwitch: number;
    errors: number;
    recentErrors: number;
    pendingRecovery: number;
    missingMarketMetadata: number;
    recentCashStarved: number;
    recentPositionCap: number;
    recentNoLocalRedeem: number;
    recentMarketUnresolved: number;
    readErrors: number;
  };
  topPnl: PreviewDbDigestAccount[];
  topWinRate: PreviewDbDigestAccount[];
  smallLiveGate: SmallLiveGateResult;
  rows: PreviewDbDigestAccount[];
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function accountIds(dataDir: string, accounts?: string[]): string[] {
  if (accounts?.length) return [...accounts].sort();
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((name) => {
      const path = join(dataDir, name);
      return statSync(path).isDirectory();
    })
    .sort();
}

function countMatching(
  rows: PreviewDbDigestReason[],
  predicate: (reason: string) => boolean
): number {
  return rows.reduce((sum, row) => sum + (predicate(row.reason) ? row.count : 0), 0);
}

function isCashStarved(reason: string): boolean {
  return reason.startsWith("preview cash ");
}

function isPositionCap(reason: string): boolean {
  return (
    reason.includes("max position") ||
    reason.includes("position cap") ||
    reason.includes("token exposure")
  );
}

function isNoLocalRedeem(reason: string): boolean {
  return reason === "no local preview position for condition";
}

function isMarketUnresolved(reason: string): boolean {
  return reason === "market unresolved";
}

function actionCounts(
  db: Database.Database,
  where = "",
  params: unknown[] = []
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT action, COUNT(*) AS count
       FROM audit_log
       ${where}
       GROUP BY action`
    )
    .all(...params) as { action: string; count: number }[];
  return new Map(rows.map((row) => [row.action, row.count]));
}

function groupedReasons(
  db: Database.Database,
  action: "SKIP" | "ERROR",
  limit: number,
  where = "",
  params: unknown[] = []
): PreviewDbDigestReason[] {
  return db
    .prepare(
      `SELECT COALESCE(reason, '') AS reason, COUNT(*) AS count
       FROM audit_log
       WHERE action = ? ${where}
       GROUP BY reason
       ORDER BY count DESC, reason ASC
       LIMIT ?`
    )
    .all(action, ...params, limit) as PreviewDbDigestReason[];
}

function allGroupedSkipReasons(
  db: Database.Database,
  where = "",
  params: unknown[] = []
): PreviewDbDigestReason[] {
  return db
    .prepare(
      `SELECT COALESCE(reason, '') AS reason, COUNT(*) AS count
       FROM audit_log
       WHERE action = 'SKIP' ${where}
       GROUP BY reason`
    )
    .all(...params) as PreviewDbDigestReason[];
}

const PNL_REASON_RE = /pnl \$(-?\d+(?:\.\d+)?)/i;

function readWinStats(
  db: Database.Database,
  where = "",
  params: unknown[] = []
): PreviewDbDigestWinStats {
  const rows = db
    .prepare(
      `SELECT reason
       FROM audit_log
       WHERE action = 'REDEEM' ${where}`
    )
    .all(...params) as { reason: string | null }[];

  let winCount = 0;
  let lossCount = 0;
  let flatCount = 0;
  let parsedPnlUsd = 0;
  for (const row of rows) {
    const match = PNL_REASON_RE.exec(row.reason ?? "");
    if (!match) continue;
    const pnl = Number(match[1]);
    if (!Number.isFinite(pnl)) continue;
    parsedPnlUsd += pnl;
    if (pnl > 0) winCount += 1;
    else if (pnl < 0) lossCount += 1;
    else flatCount += 1;
  }

  const settledCount = winCount + lossCount + flatCount;
  return {
    settledCount,
    winCount,
    lossCount,
    flatCount,
    winRatePct: settledCount > 0 ? round((winCount / settledCount) * 100, 2) : null,
    parsedPnlUsd: round(parsedPnlUsd, 2),
  };
}

function emptyAccount(
  accountId: string,
  dbPath: string,
  initial: number,
  nowMs: number,
  staleAfterMs: number
): PreviewDbDigestAccount {
  return {
    accountId,
    dbPath,
    exists: false,
    readError: null,
    lastAuditAt: null,
    lastAuditAgeMinutes: null,
    stale: true,
    cashUsd: initial,
    openCostUsd: 0,
    equityCostBasisUsd: initial,
    realizedPnlUsd: 0,
    roiPct: 0,
    openPositions: 0,
    copyCount: 0,
    redeemCount: 0,
    errorCount: 0,
    skipCount: 0,
    pendingOrderCount: 0,
    liveOrderIntentCount: 0,
    missingMarketMetadataCount: 0,
    killSwitch: false,
    recent: {
      copyCount: 0,
      redeemCount: 0,
      errorCount: 0,
      skipCount: 0,
      cashStarvedSkipCount: 0,
      positionCapSkipCount: 0,
      noLocalRedeemSkipCount: 0,
      marketUnresolvedSkipCount: 0,
    },
    winStats: {
      settledCount: 0,
      winCount: 0,
      lossCount: 0,
      flatCount: 0,
      winRatePct: null,
      parsedPnlUsd: 0,
    },
    recentWinStats: {
      settledCount: 0,
      winCount: 0,
      lossCount: 0,
      flatCount: 0,
      winRatePct: null,
      parsedPnlUsd: 0,
    },
    topSkipReasons: [],
    topErrorReasons: [],
  };
}

function unreadableAccount(
  accountId: string,
  dbPath: string,
  initial: number,
  nowMs: number,
  staleAfterMs: number,
  error: unknown
): PreviewDbDigestAccount {
  return {
    ...emptyAccount(accountId, dbPath, initial, nowMs, staleAfterMs),
    exists: true,
    readError: error instanceof Error ? error.message : String(error),
  };
}

function readAccountDigest(
  accountId: string,
  dbPath: string,
  options: Required<Pick<
    PreviewDbDigestOptions,
    "startingCapitalUsd" | "recentWindowMs" | "staleAfterMs" | "limit" | "nowMs"
  >>
): PreviewDbDigestAccount {
  const initial = options.startingCapitalUsd;
  if (!existsSync(dbPath)) {
    return emptyAccount(accountId, dbPath, initial, options.nowMs, options.staleAfterMs);
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const hasAuditLog = tableExists(db, "audit_log");
    const hasCashLedger = tableExists(db, "cash_ledger");
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
    const stats = hasDailyStats
      ? (db
          .prepare(
            `SELECT COALESCE(SUM(realized_pnl), 0) AS realizedPnlUsd
             FROM daily_stats`
          )
          .get() as { realizedPnlUsd: number } | undefined)
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
    const latestAudit = hasAuditLog
      ? (db.prepare("SELECT MAX(ts) AS ts FROM audit_log").get() as { ts: number | null })
      : { ts: null };
    const lastAuditAgeMinutes =
      latestAudit.ts === null ? null : round((options.nowMs - latestAudit.ts) / 60_000, 2);
    const recentSince = options.nowMs - options.recentWindowMs;
    const counts = hasAuditLog ? actionCounts(db) : new Map<string, number>();
    const recentCounts = hasAuditLog
      ? actionCounts(db, "WHERE ts >= ?", [recentSince])
      : new Map<string, number>();
    const recentSkipReasons = hasAuditLog
      ? allGroupedSkipReasons(db, "AND ts >= ?", [recentSince])
      : [];

    const cashUsd = round(cash?.cashUsd ?? initial);
    const openCostUsd = round(positions.openCostUsd);
    const realizedPnlUsd = round(stats?.realizedPnlUsd ?? 0);
    const equityCostBasisUsd = round(cashUsd + openCostUsd);
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

    return {
      accountId,
      dbPath,
      exists: true,
      readError: null,
      lastAuditAt:
        latestAudit.ts === null ? null : new Date(latestAudit.ts).toISOString(),
      lastAuditAgeMinutes,
      stale: latestAudit.ts === null || options.nowMs - latestAudit.ts > options.staleAfterMs,
      cashUsd,
      openCostUsd,
      equityCostBasisUsd,
      realizedPnlUsd,
      roiPct: round((realizedPnlUsd / initial) * 100, 2),
      openPositions: positions.openPositions,
      copyCount: counts.get("COPY") ?? 0,
      redeemCount: counts.get("REDEEM") ?? 0,
      errorCount: counts.get("ERROR") ?? 0,
      skipCount: counts.get("SKIP") ?? 0,
      pendingOrderCount: hasPendingOrders
        ? (
            db.prepare("SELECT COUNT(*) AS count FROM pending_orders").get() as {
              count: number;
            }
          ).count
        : 0,
      liveOrderIntentCount: hasLiveOrderIntents
        ? (
            db.prepare("SELECT COUNT(*) AS count FROM live_order_intents").get() as {
              count: number;
            }
          ).count
        : 0,
      missingMarketMetadataCount,
      killSwitch: Boolean(latestStats?.killSwitch ?? 0),
      recent: {
        copyCount: recentCounts.get("COPY") ?? 0,
        redeemCount: recentCounts.get("REDEEM") ?? 0,
        errorCount: recentCounts.get("ERROR") ?? 0,
        skipCount: recentCounts.get("SKIP") ?? 0,
        cashStarvedSkipCount: countMatching(recentSkipReasons, isCashStarved),
        positionCapSkipCount: countMatching(recentSkipReasons, isPositionCap),
        noLocalRedeemSkipCount: countMatching(recentSkipReasons, isNoLocalRedeem),
        marketUnresolvedSkipCount: countMatching(recentSkipReasons, isMarketUnresolved),
      },
      winStats: hasAuditLog ? readWinStats(db) : emptyAccount(accountId, dbPath, initial, options.nowMs, options.staleAfterMs).winStats,
      recentWinStats: hasAuditLog
        ? readWinStats(db, "AND ts >= ?", [recentSince])
        : emptyAccount(accountId, dbPath, initial, options.nowMs, options.staleAfterMs)
            .recentWinStats,
      topSkipReasons: hasAuditLog
        ? groupedReasons(db, "SKIP", options.limit)
        : [],
      topErrorReasons: hasAuditLog
        ? groupedReasons(db, "ERROR", options.limit)
        : [],
    };
  } catch (error) {
    return unreadableAccount(
      accountId,
      dbPath,
      initial,
      options.nowMs,
      options.staleAfterMs,
      error
    );
  } finally {
    db?.close();
  }
}

export function createPreviewDbDigest(options: PreviewDbDigestOptions): PreviewDbDigest {
  const nowMs = options.nowMs ?? Date.now();
  const resolved = {
    startingCapitalUsd: options.startingCapitalUsd ?? 200,
    recentWindowMs: options.recentWindowMs ?? 60 * 60_000,
    staleAfterMs: options.staleAfterMs ?? 45 * 60_000,
    limit: Math.min(20, Math.max(1, options.limit ?? 5)),
    nowMs,
  };
  const rows = accountIds(options.dataDir, options.accounts).map((accountId) =>
    readAccountDigest(accountId, join(options.dataDir, accountId, "preview.db"), resolved)
  );
  const existing = rows.filter((row) => row.exists);
  const totals = {
    cashUsd: round(existing.reduce((sum, row) => sum + row.cashUsd, 0), 2),
    openCostUsd: round(existing.reduce((sum, row) => sum + row.openCostUsd, 0), 2),
    equityCostBasisUsd: round(
      existing.reduce((sum, row) => sum + row.equityCostBasisUsd, 0),
      2
    ),
    realizedPnlUsd: round(existing.reduce((sum, row) => sum + row.realizedPnlUsd, 0), 2),
    copies: existing.reduce((sum, row) => sum + row.copyCount, 0),
    redeems: existing.reduce((sum, row) => sum + row.redeemCount, 0),
    errors: existing.reduce((sum, row) => sum + row.errorCount, 0),
    skips: existing.reduce((sum, row) => sum + row.skipCount, 0),
  };

  const topPnl = [...existing]
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)
    .slice(0, resolved.limit);
  const topWinRate = [...existing]
    .filter((row) => row.winStats.settledCount >= 5)
    .sort((a, b) => {
      const winDelta = (b.winStats.winRatePct ?? -1) - (a.winStats.winRatePct ?? -1);
      return winDelta !== 0 ? winDelta : b.realizedPnlUsd - a.realizedPnlUsd;
    })
    .slice(0, resolved.limit);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    dataDir: options.dataDir,
    accountCount: rows.length,
    missingDbCount: rows.filter((row) => !row.exists).length,
    staleCount: rows.filter((row) => row.stale).length,
    totals,
    riskCounts: {
      killSwitch: existing.filter((row) => row.killSwitch).length,
      errors: existing.filter((row) => row.errorCount > 0).length,
      recentErrors: existing.filter((row) => row.recent.errorCount > 0).length,
      pendingRecovery: existing.filter(
        (row) => row.pendingOrderCount > 0 || row.liveOrderIntentCount > 0
      ).length,
      missingMarketMetadata: existing.filter(
        (row) => row.missingMarketMetadataCount > 0
      ).length,
      recentCashStarved: existing.filter((row) => row.recent.cashStarvedSkipCount > 0)
        .length,
      recentPositionCap: existing.filter((row) => row.recent.positionCapSkipCount > 0)
        .length,
      recentNoLocalRedeem: existing.filter(
        (row) => row.recent.noLocalRedeemSkipCount > 0
      ).length,
      recentMarketUnresolved: existing.filter(
        (row) => row.recent.marketUnresolvedSkipCount > 0
      ).length,
      readErrors: existing.filter((row) => row.readError !== null).length,
    },
    topPnl,
    topWinRate,
    smallLiveGate: assessSmallLiveCandidates(rows, {
      maxEligible: resolved.limit,
    }),
    rows,
  };
}

function accountList(rows: PreviewDbDigestAccount[], field: "realizedPnlUsd" | "win"): string {
  if (rows.length === 0) return "none";
  return rows
    .map((row) => {
      if (field === "win") {
        return `${row.accountId}:${row.winStats.winRatePct ?? "n/a"}%/${row.winStats.settledCount}`;
      }
      return `${row.accountId}:${row.realizedPnlUsd}U`;
    })
    .join(", ");
}

export function formatPreviewDbDigest(digest: PreviewDbDigest): string[] {
  const risk = digest.riskCounts;
  return [
    `Digest: accounts=${digest.accountCount} missingDb=${digest.missingDbCount} stale=${digest.staleCount} generated=${digest.generatedAt}`,
    `Totals: pnl=${digest.totals.realizedPnlUsd}U cash=${digest.totals.cashUsd}U openCost=${digest.totals.openCostUsd}U copies=${digest.totals.copies} redeems=${digest.totals.redeems}`,
    `Risks: kill=${risk.killSwitch} errors=${risk.errors} recentErrors=${risk.recentErrors} pending=${risk.pendingRecovery} metadata=${risk.missingMarketMetadata} readErrors=${risk.readErrors} cash=${risk.recentCashStarved} cap=${risk.recentPositionCap} noLocalRedeem=${risk.recentNoLocalRedeem} unresolved=${risk.recentMarketUnresolved}`,
    `Top PnL: ${accountList(digest.topPnl, "realizedPnlUsd")}`,
    `Top win-rate: ${accountList(digest.topWinRate, "win")}`,
  ];
}

export function writePreviewDbDigest(digest: PreviewDbDigest, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const safeTs = digest.generatedAt.replace(/[:.]/g, "-");
  const outPath = join(outDir, `preview-db-digest-${safeTs}.json`);
  writeFileSync(outPath, `${JSON.stringify(digest, null, 2)}\n`);
  return outPath;
}
