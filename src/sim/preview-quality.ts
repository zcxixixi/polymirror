import type Database from "better-sqlite3";

export type PreviewProfitIssueCode =
  | "healthy"
  | "no_data"
  | "not_buying"
  | "not_selling"
  | "parameter_filtered"
  | "cash_occupied"
  | "risk_limited"
  | "market_unsettled"
  | "strategy_losing"
  | "safety_blocker";

export type PreviewProfitIssueSeverity = "ok" | "info" | "warning" | "danger";

export interface PreviewProfitIssue {
  code: PreviewProfitIssueCode;
  severity: PreviewProfitIssueSeverity;
  label: string;
  detail: string;
}

export interface PreviewCoverageSummary {
  buyPct: number;
  sellPct: number;
  tradePct: number;
}

export interface PreviewSideCounts {
  buy: number;
  sell: number;
  totalTrades: number;
}

export interface PreviewDetectedCounts extends PreviewSideCounts {
  redeem: number;
}

export interface PreviewQualitySkips {
  parameterFiltered: number;
  cashBlocked: number;
  exposureBlocked: number;
  sellWithoutLocal: number;
  noLocalRedeem: number;
  unresolvedRedeem: number;
  alreadySeen: number;
}

export interface PreviewCopyGapSkipped {
  parameterFiltered: number;
  cashBlocked: number;
  exposureBlocked: number;
  sellWithoutLocal: number;
  other: number;
  total: number;
}

export interface PreviewCopyGapUnclassifiedToken {
  tokenId: string;
  detected: number;
  deduped: number;
  copied: number;
  skipped: number;
  unclassified: number;
  lastSkipReason: string | null;
}

export interface PreviewCopyGapSide {
  detected: number;
  deduped: number;
  effectiveDetected: number;
  copied: number;
  skipped: PreviewCopyGapSkipped;
  unclassified: number;
  copyPct: number;
  explainedPct: number;
  topUnclassified: PreviewCopyGapUnclassifiedToken[];
}

export interface PreviewCopyGapSummary {
  buy: PreviewCopyGapSide;
  sell: PreviewCopyGapSide;
}

export interface PreviewQualityRedeem {
  count: number;
  payoutUsd: number;
  pnlUsd: number;
}

export interface PreviewQualityOpen {
  costUsd: number;
  positions: number;
  cashUsd: number;
  exposurePct: number;
}

export interface PreviewMarketPnlSummary {
  conditionId: string | null;
  title: string | null;
  slug: string | null;
  redeemCount: number;
  payoutUsd: number;
  pnlUsd: number;
}

export interface PreviewCopyQualitySummary {
  detected: PreviewDetectedCounts;
  copied: PreviewSideCounts;
  deduped: PreviewSideCounts;
  effectiveDetected: PreviewSideCounts;
  coverage: PreviewCoverageSummary;
  effectiveCoverage: PreviewCoverageSummary;
  skips: PreviewQualitySkips;
  copyGap: PreviewCopyGapSummary;
  redeem: PreviewQualityRedeem;
  open: PreviewQualityOpen;
  primaryIssue: PreviewProfitIssue;
  notes: string[];
  marketPnl: PreviewMarketPnlSummary[];
}

export interface BuildPreviewCopyQualityOptions {
  db: Database.Database;
  hasAuditLog: boolean;
  hasTokenMarkets: boolean;
  cashUsd: number;
  openCostUsd: number;
  openPositions: number;
  realizedPnlUsd: number;
  errorCount: number;
  killSwitch: boolean;
  pendingOrderCount: number;
  liveOrderIntentCount: number;
  cashReplayDeltaUsd: number;
  capitalDeltaUsd: number;
  missingMarketMetadataCount: number;
  sinceMs?: number;
  limit?: number;
}

export const PREVIEW_COPY_DEDUP_REASONS = ["already seen", "recent buy dedup"] as const;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function issue(
  code: PreviewProfitIssueCode,
  severity: PreviewProfitIssueSeverity,
  label: string,
  detail: string
): PreviewProfitIssue {
  return { code, severity, label, detail };
}

function emptySideCounts(): PreviewSideCounts {
  return { buy: 0, sell: 0, totalTrades: 0 };
}

function emptyGapSkipped(): PreviewCopyGapSkipped {
  return {
    parameterFiltered: 0,
    cashBlocked: 0,
    exposureBlocked: 0,
    sellWithoutLocal: 0,
    other: 0,
    total: 0,
  };
}

function addSideCount(counts: PreviewSideCounts, side: string | null, count: number): void {
  if (side === "BUY") counts.buy += count;
  if (side === "SELL") counts.sell += count;
  counts.totalTrades = counts.buy + counts.sell;
}

function addGapSkipCount(
  counts: PreviewCopyGapSkipped,
  key: keyof Omit<PreviewCopyGapSkipped, "total">,
  count: number
): void {
  counts[key] += count;
  counts.total += count;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return round2((part / total) * 100);
}

function reasonMatchesParameterFilter(reason: string): boolean {
  return (
    (reason.startsWith("price ") && (reason.includes(" < min ") || reason.includes(" > max "))) ||
    reason.includes("below min $") ||
    reason.startsWith("side ") ||
    reason.startsWith("blocked market keyword ") ||
    reason === "not in allowlist" ||
    reason.startsWith("invalid price ") ||
    reason.startsWith("slippage ") ||
    reason === "executable price unavailable" ||
    reason.startsWith("executable depth ") ||
    reason.startsWith("market min order ") ||
    reason.startsWith("guarded max order ")
  );
}

function reasonMatchesCash(reason: string): boolean {
  return reason.startsWith("preview cash ");
}

function reasonMatchesExposure(reason: string): boolean {
  return (
    reason.includes("max position") ||
    reason.includes("position cap") ||
    reason.includes("token exposure") ||
    reason.startsWith("max open markets") ||
    reason.includes("max daily volume")
  );
}

function reasonMatchesSellWithoutLocal(reason: string): boolean {
  return reason.startsWith("SELL held=");
}

function reasonMatchesAlreadySeen(reason: string): boolean {
  return PREVIEW_COPY_DEDUP_REASONS.includes(
    reason as (typeof PREVIEW_COPY_DEDUP_REASONS)[number]
  );
}

function addSideGapSkip(
  sideSkips: { buy: PreviewCopyGapSkipped; sell: PreviewCopyGapSkipped },
  side: string | null,
  reason: string,
  count: number
): void {
  if (side !== "BUY" && side !== "SELL") return;
  if (reasonMatchesAlreadySeen(reason)) return;
  const target = side === "BUY" ? sideSkips.buy : sideSkips.sell;
  if (reasonMatchesParameterFilter(reason)) {
    addGapSkipCount(target, "parameterFiltered", count);
  } else if (reasonMatchesCash(reason)) {
    addGapSkipCount(target, "cashBlocked", count);
  } else if (reasonMatchesExposure(reason)) {
    addGapSkipCount(target, "exposureBlocked", count);
  } else if (reasonMatchesSellWithoutLocal(reason)) {
    addGapSkipCount(target, "sellWithoutLocal", count);
  } else {
    addGapSkipCount(target, "other", count);
  }
}

function parsePnl(reason: string | null): number {
  const match = reason?.match(/pnl \$(-?\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : 0;
}

function dominantCopyBlocker(skips: PreviewQualitySkips):
  | { kind: "parameter"; count: number }
  | { kind: "cash"; count: number }
  | { kind: "risk"; count: number }
  | null {
  const blockers = [
    { kind: "parameter" as const, count: skips.parameterFiltered },
    { kind: "cash" as const, count: skips.cashBlocked },
    { kind: "risk" as const, count: skips.exposureBlocked },
  ].sort((a, b) => b.count - a.count);
  return blockers[0]?.count ? blockers[0] : null;
}

function sinceWhere(sinceMs?: number): { sql: string; params: unknown[] } {
  return Number.isFinite(sinceMs)
    ? { sql: " AND ts >= ?", params: [sinceMs] }
    : { sql: "", params: [] };
}

interface PreviewCopyPathAuditRow {
  tokenId: string;
  action: string;
  reason: string;
  side: string;
  count: number;
  lastTs: number;
}

function readCopyPathAuditRows(
  db: Database.Database,
  sinceMs?: number
): PreviewCopyPathAuditRow[] {
  const since = sinceWhere(sinceMs);
  return db
    .prepare(
      `SELECT COALESCE(token_id, '') AS tokenId,
              action,
              COALESCE(reason, '') AS reason,
              COALESCE(side, '') AS side,
              COUNT(*) AS count,
              MAX(ts) AS lastTs
       FROM audit_log
       WHERE action IN ('DETECT', 'COPY', 'SKIP')
       ${since.sql}
       GROUP BY token_id, action, reason, side`
    )
    .all(...since.params) as PreviewCopyPathAuditRow[];
}

function readActionSideCounts(
  rows: readonly PreviewCopyPathAuditRow[],
  action: "DETECT" | "COPY"
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.action !== action) continue;
    counts[row.side] = (counts[row.side] ?? 0) + row.count;
  }
  return counts;
}

function readSkipDiagnostics(
  rows: readonly PreviewCopyPathAuditRow[]
): {
  skips: PreviewQualitySkips;
  deduped: PreviewSideCounts;
  sideSkips: { buy: PreviewCopyGapSkipped; sell: PreviewCopyGapSkipped };
} {
  const result: PreviewQualitySkips = {
    parameterFiltered: 0,
    cashBlocked: 0,
    exposureBlocked: 0,
    sellWithoutLocal: 0,
    noLocalRedeem: 0,
    unresolvedRedeem: 0,
    alreadySeen: 0,
  };
  const deduped = emptySideCounts();
  const sideSkips = { buy: emptyGapSkipped(), sell: emptyGapSkipped() };

  for (const row of rows) {
    if (row.action !== "SKIP") continue;
    if (reasonMatchesParameterFilter(row.reason)) result.parameterFiltered += row.count;
    if (reasonMatchesCash(row.reason)) result.cashBlocked += row.count;
    if (reasonMatchesExposure(row.reason)) result.exposureBlocked += row.count;
    if (reasonMatchesSellWithoutLocal(row.reason)) result.sellWithoutLocal += row.count;
    if (row.reason === "no local preview position for condition") {
      result.noLocalRedeem += row.count;
    }
    if (row.reason === "market unresolved") result.unresolvedRedeem += row.count;
    if (reasonMatchesAlreadySeen(row.reason)) {
      result.alreadySeen += row.count;
      addSideCount(deduped, row.side, row.count);
    }
    addSideGapSkip(sideSkips, row.side, row.reason, row.count);
  }

  return { skips: result, deduped, sideSkips };
}

function readTopUnclassifiedCopyGapTokens(
  rows: readonly PreviewCopyPathAuditRow[],
  side: "BUY" | "SELL",
  limit: number
): PreviewCopyGapUnclassifiedToken[] {
  const byToken = new Map<
    string,
    {
      detected: number;
      deduped: number;
      copied: number;
      skipped: number;
      lastSkipReason: string | null;
      lastSkipTs: number;
    }
  >();

  for (const row of rows) {
    if (row.side !== side || !row.tokenId) continue;
    const acc =
      byToken.get(row.tokenId) ??
      {
        detected: 0,
        deduped: 0,
        copied: 0,
        skipped: 0,
        lastSkipReason: null,
        lastSkipTs: 0,
      };
    if (row.action === "DETECT") acc.detected += row.count;
    if (row.action === "COPY") acc.copied += row.count;
    if (row.action === "SKIP") {
      if (reasonMatchesAlreadySeen(row.reason)) {
        acc.deduped += row.count;
      } else {
        acc.skipped += row.count;
      }
      if (row.lastTs >= acc.lastSkipTs) {
        acc.lastSkipTs = row.lastTs;
        acc.lastSkipReason = row.reason || null;
      }
    }
    byToken.set(row.tokenId, acc);
  }

  return [...byToken.entries()]
    .map(([tokenId, acc]) => {
      const effectiveDetected = Math.max(0, acc.detected - acc.deduped);
      return {
        tokenId,
        detected: acc.detected,
        deduped: acc.deduped,
        copied: acc.copied,
        skipped: acc.skipped,
        unclassified: Math.max(0, effectiveDetected - acc.copied - acc.skipped),
        lastSkipReason: acc.lastSkipReason,
      };
    })
    .filter((row) => row.unclassified > 0)
    .sort((a, b) => b.unclassified - a.unclassified || b.detected - a.detected)
    .slice(0, limit);
}

function copyGapSide(
  detected: number,
  deduped: number,
  copied: number,
  skipped: PreviewCopyGapSkipped,
  topUnclassified: PreviewCopyGapUnclassifiedToken[] = []
): PreviewCopyGapSide {
  const effectiveDetected = Math.max(0, detected - deduped);
  const explained = Math.min(effectiveDetected, copied + skipped.total);
  return {
    detected,
    deduped,
    effectiveDetected,
    copied,
    skipped,
    unclassified: Math.max(0, effectiveDetected - copied - skipped.total),
    copyPct: pct(copied, effectiveDetected),
    explainedPct: pct(explained, effectiveDetected),
    topUnclassified,
  };
}

function readMarketMetadata(
  db: Database.Database,
  hasTokenMarkets: boolean
): Map<string, { title: string | null; slug: string | null }> {
  if (!hasTokenMarkets) return new Map();
  const rows = db
    .prepare(
      `SELECT condition_id AS key, MAX(title) AS title, MAX(slug) AS slug
       FROM token_markets
       GROUP BY condition_id
       UNION ALL
       SELECT token_id AS key, MAX(title) AS title, MAX(slug) AS slug
       FROM token_markets
       GROUP BY token_id`
    )
    .all() as { key: string | null; title: string | null; slug: string | null }[];

  const byKey = new Map<string, { title: string | null; slug: string | null }>();
  for (const row of rows) {
    if (!row.key || byKey.has(row.key)) continue;
    byKey.set(row.key, { title: row.title, slug: row.slug });
  }
  return byKey;
}

function readRedeemAndMarketPnl(
  db: Database.Database,
  hasTokenMarkets: boolean,
  limit: number,
  sinceMs?: number
): { redeem: PreviewQualityRedeem; marketPnl: PreviewMarketPnlSummary[] } {
  const since = sinceWhere(sinceMs);
  const rows = db
    .prepare(
      `SELECT token_id AS conditionId, COALESCE(size, 0) AS payoutUsd, reason
       FROM audit_log
       WHERE action = 'REDEEM'
       ${since.sql}
       ORDER BY id ASC`
    )
    .all(...since.params) as { conditionId: string | null; payoutUsd: number; reason: string | null }[];

  const metadata = readMarketMetadata(db, hasTokenMarkets);
  const byMarket = new Map<string, PreviewMarketPnlSummary>();
  let payoutUsd = 0;
  let pnlUsd = 0;

  for (const row of rows) {
    const key = row.conditionId ?? "(unknown)";
    const meta = row.conditionId ? metadata.get(row.conditionId) : undefined;
    const pnl = parsePnl(row.reason);
    payoutUsd += row.payoutUsd;
    pnlUsd += pnl;

    const current =
      byMarket.get(key) ??
      {
        conditionId: row.conditionId,
        title: meta?.title ?? null,
        slug: meta?.slug ?? null,
        redeemCount: 0,
        payoutUsd: 0,
        pnlUsd: 0,
      };
    current.redeemCount += 1;
    current.payoutUsd = round2(current.payoutUsd + row.payoutUsd);
    current.pnlUsd = round2(current.pnlUsd + pnl);
    byMarket.set(key, current);
  }

  return {
    redeem: {
      count: rows.length,
      payoutUsd: round2(payoutUsd),
      pnlUsd: round2(pnlUsd),
    },
    marketPnl: [...byMarket.values()]
      .sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd))
      .slice(0, limit),
  };
}

function classifyQuality(input: {
  detected: PreviewDetectedCounts;
  effectiveDetected: PreviewSideCounts;
  copied: PreviewSideCounts;
  coverage: PreviewCoverageSummary;
  skips: PreviewQualitySkips;
  redeem: PreviewQualityRedeem;
  open: PreviewQualityOpen;
  realizedPnlUsd: number;
  errorCount: number;
  killSwitch: boolean;
  pendingOrderCount: number;
  liveOrderIntentCount: number;
  cashReplayDeltaUsd: number;
  capitalDeltaUsd: number;
  missingMarketMetadataCount: number;
}): PreviewProfitIssue {
  if (
    input.killSwitch ||
    input.errorCount > 0 ||
    input.pendingOrderCount > 0 ||
    input.liveOrderIntentCount > 0 ||
    Math.abs(input.cashReplayDeltaUsd) > 0.01 ||
    Math.abs(input.capitalDeltaUsd) > 0.5 ||
    input.missingMarketMetadataCount > 0
  ) {
    return issue(
      "safety_blocker",
      "danger",
      "安全或账本异常",
      "先处理 kill switch、ERROR、pending 或账本不一致，不能用这条线判断盈利。"
    );
  }

  if (input.effectiveDetected.totalTrades === 0 && input.detected.redeem === 0) {
    return issue(
      "no_data",
      "info",
      "暂无样本",
      "还没有检测到可评估的跟单事件。"
    );
  }

  if (input.realizedPnlUsd < 0 && (input.redeem.count > 0 || input.copied.totalTrades >= 10)) {
    return issue(
      "strategy_losing",
      "danger",
      "该策略本身亏",
      "已有结算样本为负，继续放大只会放大亏损。"
    );
  }

  const dominantBlocker = dominantCopyBlocker(input.skips);
  if (
    dominantBlocker &&
    dominantBlocker.count >= 3 &&
    dominantBlocker.count >= input.copied.totalTrades
  ) {
    if (dominantBlocker.kind === "risk") {
      return issue(
        "risk_limited",
        "warning",
        "风控挡住",
        "仓位、市场数、token exposure 或日额度限制是当前复制覆盖率低的主因。"
      );
    }
    if (dominantBlocker.kind === "cash") {
      return issue(
        "cash_occupied",
        "warning",
        "现金不足/占用",
        "可用现金不足或资金被未结算持仓占用，后续买入被现金限制挡住。"
      );
    }
    return issue(
      "parameter_filtered",
      "warning",
      "参数过滤太多",
      "大量交易被价格、最小金额、方向或市场过滤拦住，复制覆盖率被压低。"
    );
  }

  if (
    input.effectiveDetected.sell >= 5 &&
    (input.coverage.sellPct < 25 || input.skips.sellWithoutLocal > 0)
  ) {
    return issue(
      "not_selling",
      "warning",
      "没卖到",
      "卖出覆盖率低，常见原因是前面的买入没复制到，导致本地没有可卖仓位。"
    );
  }

  if (input.effectiveDetected.buy >= 5 && input.coverage.buyPct < 20) {
    return issue(
      "not_buying",
      "warning",
      "没买到",
      "检测到很多买入，但实际 COPY 很少，需要看 min order、现金和过滤条件。"
    );
  }

  if (input.open.exposurePct >= 60 && input.skips.cashBlocked > 0) {
    return issue(
      "cash_occupied",
      "warning",
      "现金不足/占用",
      "模拟资金大多压在未结算持仓里，后续买入会被现金不足挡住。"
    );
  }

  if (input.open.costUsd > 0 && input.redeem.count === 0) {
    return issue(
      "market_unsettled",
      "info",
      "市场未结算",
      "已有持仓但还没结算，短期 PnL 不能代表最终结果。"
    );
  }

  return issue(
    "healthy",
    "ok",
    "复制质量正常",
    "没有明显覆盖率、风控或账本问题。"
  );
}

export function emptyPreviewCopyQuality(
  cashUsd: number,
  openCostUsd: number,
  openPositions: number
): PreviewCopyQualitySummary {
  const open = {
    costUsd: round2(openCostUsd),
    positions: openPositions,
    cashUsd: round2(cashUsd),
    exposurePct: pct(openCostUsd, cashUsd + openCostUsd),
  };
  return {
    detected: { buy: 0, sell: 0, redeem: 0, totalTrades: 0 },
    copied: { buy: 0, sell: 0, totalTrades: 0 },
    deduped: { buy: 0, sell: 0, totalTrades: 0 },
    effectiveDetected: { buy: 0, sell: 0, totalTrades: 0 },
    coverage: { buyPct: 0, sellPct: 0, tradePct: 0 },
    effectiveCoverage: { buyPct: 0, sellPct: 0, tradePct: 0 },
    skips: {
      parameterFiltered: 0,
      cashBlocked: 0,
      exposureBlocked: 0,
      sellWithoutLocal: 0,
      noLocalRedeem: 0,
      unresolvedRedeem: 0,
      alreadySeen: 0,
    },
    copyGap: {
      buy: copyGapSide(0, 0, 0, emptyGapSkipped()),
      sell: copyGapSide(0, 0, 0, emptyGapSkipped()),
    },
    redeem: { count: 0, payoutUsd: 0, pnlUsd: 0 },
    open,
    primaryIssue: issue("no_data", "info", "暂无样本", "还没有检测到可评估的跟单事件。"),
    notes: [],
    marketPnl: [],
  };
}

export function buildPreviewCopyQuality(
  options: BuildPreviewCopyQualityOptions
): PreviewCopyQualitySummary {
  const limit = Math.min(50, Math.max(1, options.limit ?? 8));
  if (!options.hasAuditLog) {
    return emptyPreviewCopyQuality(
      options.cashUsd,
      options.openCostUsd,
      options.openPositions
    );
  }

  const copyPathRows = readCopyPathAuditRows(options.db, options.sinceMs);
  const detectedCounts = readActionSideCounts(copyPathRows, "DETECT");
  const copiedCounts = readActionSideCounts(copyPathRows, "COPY");
  const detected: PreviewDetectedCounts = {
    buy: detectedCounts.BUY ?? 0,
    sell: detectedCounts.SELL ?? 0,
    redeem: detectedCounts.REDEEM ?? 0,
    totalTrades: (detectedCounts.BUY ?? 0) + (detectedCounts.SELL ?? 0),
  };
  const copied: PreviewSideCounts = {
    buy: copiedCounts.BUY ?? 0,
    sell: copiedCounts.SELL ?? 0,
    totalTrades: (copiedCounts.BUY ?? 0) + (copiedCounts.SELL ?? 0),
  };
  const { skips, deduped, sideSkips } = readSkipDiagnostics(copyPathRows);
  const { redeem, marketPnl } = readRedeemAndMarketPnl(
    options.db,
    options.hasTokenMarkets,
    limit,
    options.sinceMs
  );
  const open: PreviewQualityOpen = {
    costUsd: round2(options.openCostUsd),
    positions: options.openPositions,
    cashUsd: round2(options.cashUsd),
    exposurePct: pct(options.openCostUsd, options.cashUsd + options.openCostUsd),
  };
  const coverage: PreviewCoverageSummary = {
    buyPct: pct(copied.buy, detected.buy),
    sellPct: pct(copied.sell, detected.sell),
    tradePct: pct(copied.totalTrades, detected.totalTrades),
  };
  const effectiveDetected: PreviewSideCounts = {
    buy: Math.max(0, detected.buy - deduped.buy),
    sell: Math.max(0, detected.sell - deduped.sell),
    totalTrades: Math.max(0, detected.totalTrades - deduped.totalTrades),
  };
  const effectiveCoverage: PreviewCoverageSummary = {
    buyPct: pct(copied.buy, effectiveDetected.buy),
    sellPct: pct(copied.sell, effectiveDetected.sell),
    tradePct: pct(copied.totalTrades, effectiveDetected.totalTrades),
  };
  const copyGap: PreviewCopyGapSummary = {
    buy: copyGapSide(
      detected.buy,
      deduped.buy,
      copied.buy,
      sideSkips.buy,
      readTopUnclassifiedCopyGapTokens(copyPathRows, "BUY", limit)
    ),
    sell: copyGapSide(
      detected.sell,
      deduped.sell,
      copied.sell,
      sideSkips.sell,
      readTopUnclassifiedCopyGapTokens(copyPathRows, "SELL", limit)
    ),
  };
  const notes: string[] = [];
  if (options.openCostUsd > 0) {
    notes.push("市场还没结算，当前盈利只按已结算口径");
  }
  if (skips.sellWithoutLocal > 0 || skips.noLocalRedeem > 0) {
    notes.push("卖出/赎回没跟上通常说明前面的买入没有复制到");
  }
  if (skips.cashBlocked > 0) {
    notes.push("现金不足是模拟资金约束，不一定是系统 bug");
  }
  if (skips.exposureBlocked > 0) {
    notes.push("仓位、市场数或日额度风控正在限制复制覆盖率");
  }
  if (skips.alreadySeen > 0) {
    notes.push("重复或已见交易已去重，不代表真实漏跟");
  }

  return {
    detected,
    copied,
    deduped,
    effectiveDetected,
    coverage,
    effectiveCoverage,
    skips,
    copyGap,
    redeem,
    open,
    primaryIssue: classifyQuality({
      detected,
      effectiveDetected,
      copied,
      coverage: effectiveCoverage,
      skips,
      redeem,
      open,
      realizedPnlUsd: options.realizedPnlUsd,
      errorCount: options.errorCount,
      killSwitch: options.killSwitch,
      pendingOrderCount: options.pendingOrderCount,
      liveOrderIntentCount: options.liveOrderIntentCount,
      cashReplayDeltaUsd: options.cashReplayDeltaUsd,
      capitalDeltaUsd: options.capitalDeltaUsd,
      missingMarketMetadataCount: options.missingMarketMetadataCount,
    }),
    notes,
    marketPnl,
  };
}
