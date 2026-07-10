import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_PREVIEW_TEST_ACCOUNTS } from "./preview-accounts.js";
import {
  formatPreviewEvolutionPlan,
  planPreviewEvolution,
  type PreviewEvolutionPlan,
} from "./preview-evolution.js";
import type { PreviewAccountReport } from "./preview-report.js";
import { readPreviewAccountReport } from "./preview-report.js";
import type { PreviewAccountRanking } from "./preview-selection.js";
import { rankPreviewAccounts } from "./preview-selection.js";
import {
  createPreviewReportSummary,
  formatPreviewSummaryDigest,
  type PreviewReportSummary,
} from "./preview-summary.js";
import {
  rankStrategyRisks,
  type StrategyRiskAssessment,
} from "./strategy-risk.js";

export interface GeneratePreviewAccountsReportOptions {
  accounts?: readonly string[];
  currentActiveAccounts?: readonly string[];
  dataDir?: string;
  outDir?: string;
  startingCapitalUsd?: number;
  startingCapitalByAccount?: ReadonlyMap<string, number> | Record<string, number>;
  limit?: number;
  recentWindowMs?: number;
  nowMs?: number;
  generatedAt?: Date;
}

export interface PreviewReportRow {
  account: string;
  grade: PreviewAccountRanking["grade"];
  score: number;
  liveReady: boolean;
  liveBlockers: string;
  exists: boolean;
  cash: number;
  openCost: number;
  pnl: number;
  cashDelta: number;
  capitalDelta: number;
  missingMarkets: number;
  pending: number;
  liveIntents: number;
  copies: number;
  redeems: number;
  skips: number;
  priceSkips: number;
  cashSkips: number;
  capSkips: number;
  marketSkips: number;
  noLocalRedeems: number;
  unmatchedRedeems: number;
  errors: number;
  kill: boolean;
  winCopy: number;
  winRedeem: number;
  winSkip: number;
  winErr: number;
  winPriceSkips: number;
  winCashSkip: number;
  winCapSkip: number;
  winNoLocal: number;
  winUnmatched: number;
}

export interface PreviewReportMetadata {
  recentWindowMs?: number;
  auditLogScope: "retained_audit_log";
  skipColumnsScope: "retained_audit_log";
  windowColumnsScope: "recent_window" | "none";
}

export interface PreviewAccountsReportSlice {
  accountIds: string[];
  summary: PreviewReportSummary;
  reports: PreviewAccountReport[];
  rankings: PreviewAccountRanking[];
  strategyRisks: StrategyRiskAssessment[];
  evolution: PreviewEvolutionPlan;
  rows: PreviewReportRow[];
}

export interface PreviewAccountsReportResult {
  generatedAt: string;
  metadata: PreviewReportMetadata;
  outPath: string;
  summaryPath: string;
  summary: PreviewReportSummary;
  reports: PreviewAccountReport[];
  rankings: PreviewAccountRanking[];
  strategyRisks: StrategyRiskAssessment[];
  evolution: PreviewEvolutionPlan;
  rows: PreviewReportRow[];
  active?: PreviewAccountsReportSlice;
}

export function parsePreviewReportAccounts(value: string | undefined): string[] | undefined {
  const parsed = value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function discoverPreviewAccounts(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((name) => {
      const dir = join(dataDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "preview.db"));
    })
    .sort();
}

function resolveReportAccounts(
  dataDir: string,
  accounts: readonly string[] | undefined,
  currentActiveAccounts: readonly string[] | undefined
): string[] {
  return uniq([...(accounts ?? discoverPreviewAccounts(dataDir)), ...(currentActiveAccounts ?? [])]);
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function parseLegacyPreviewReportAccounts(value: string | undefined): string[] {
  return (value ?? DEFAULT_PREVIEW_TEST_ACCOUNTS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createPreviewReportRows(
  reports: PreviewAccountReport[],
  rankings: PreviewAccountRanking[]
): PreviewReportRow[] {
  const rankingByAccount = new Map(rankings.map((r) => [r.accountId, r]));

  return reports.map((r) => {
    const ranking = rankingByAccount.get(r.accountId);

    return {
      account: r.accountId,
      grade: ranking?.grade ?? "reject",
      score: ranking?.score ?? 0,
      liveReady: ranking?.liveReady ?? false,
      liveBlockers: ranking?.liveBlockers.join("; ") ?? "missing ranking",
      exists: r.exists,
      cash: r.cashUsd,
      openCost: r.openCostUsd,
      pnl: r.realizedPnlUsd,
      cashDelta: r.cashReplayDeltaUsd,
      capitalDelta: r.capitalDeltaUsd,
      missingMarkets: r.missingMarketMetadataCount,
      pending: r.pendingOrderCount,
      liveIntents: r.liveOrderIntentCount,
      copies: r.copyCount,
      redeems: r.redeemCount,
      skips: r.skipCount,
      priceSkips: r.priceFilteredSkipCount,
      cashSkips: r.cashStarvedSkipCount,
      capSkips: r.positionCapSkipCount,
      marketSkips: r.maxOpenMarketSkipCount,
      noLocalRedeems: r.noLocalRedeemSkipCount,
      unmatchedRedeems: r.unmatchedRedeemSkipCount,
      errors: r.errorCount,
      kill: r.killSwitch,
      winCopy: r.recentWindow?.copyCount ?? 0,
      winRedeem: r.recentWindow?.redeemCount ?? 0,
      winSkip: r.recentWindow?.skipCount ?? 0,
      winErr: r.recentWindow?.errorCount ?? 0,
      winPriceSkips: r.recentWindow?.priceFilteredSkipCount ?? 0,
      winCashSkip: r.recentWindow?.cashStarvedSkipCount ?? 0,
      winCapSkip: r.recentWindow?.positionCapSkipCount ?? 0,
      winNoLocal: r.recentWindow?.noLocalRedeemSkipCount ?? 0,
      winUnmatched: r.recentWindow?.unmatchedRedeemSkipCount ?? 0,
    };
  });
}

function isStartingCapitalMap(
  value: GeneratePreviewAccountsReportOptions["startingCapitalByAccount"]
): value is ReadonlyMap<string, number> {
  return typeof (value as { get?: unknown } | undefined)?.get === "function";
}

function startingCapitalForAccount(
  accountId: string,
  options: GeneratePreviewAccountsReportOptions
): number {
  const byAccount = options.startingCapitalByAccount;
  if (!byAccount) return options.startingCapitalUsd ?? 200;
  if (isStartingCapitalMap(byAccount)) {
    return byAccount.get(accountId) ?? options.startingCapitalUsd ?? 200;
  }
  return byAccount[accountId] ?? options.startingCapitalUsd ?? 200;
}

export function generatePreviewAccountsReport(
  options: GeneratePreviewAccountsReportOptions = {}
): PreviewAccountsReportResult {
  const dataDir = options.dataDir ?? "data/accounts";
  const outDir = options.outDir ?? "reports/preview-live";
  const currentActiveAccounts = options.currentActiveAccounts
    ? uniq([...options.currentActiveAccounts])
    : undefined;
  const accounts = resolveReportAccounts(dataDir, options.accounts, currentActiveAccounts);
  const generatedAt = options.generatedAt ?? new Date();
  const reports = accounts.map((accountId) =>
    readPreviewAccountReport({
      accountId,
      dbPath: join(dataDir, accountId, "preview.db"),
      startingCapitalUsd: startingCapitalForAccount(accountId, options),
      limit: options.limit ?? 8,
      recentWindowMs: options.recentWindowMs,
      nowMs: options.nowMs,
    })
  );
  const rankings = rankPreviewAccounts(reports);
  const strategyRisks = rankStrategyRisks(reports);
  const evolution = planPreviewEvolution(reports, rankings, {
    currentActiveAccounts: currentActiveAccounts ?? accounts,
    targetActiveCount: currentActiveAccounts?.length ?? accounts.length,
  });
  const generatedAtIso = generatedAt.toISOString();
  const summary = createPreviewReportSummary(generatedAtIso, reports, rankings, evolution);
  const rows = createPreviewReportRows(reports, rankings);
  const active = currentActiveAccounts
    ? createPreviewAccountsReportSlice(
        generatedAtIso,
        reports,
        currentActiveAccounts
      )
    : undefined;
  const metadata: PreviewReportMetadata = {
    recentWindowMs: options.recentWindowMs,
    auditLogScope: "retained_audit_log",
    skipColumnsScope: "retained_audit_log",
    windowColumnsScope: options.recentWindowMs ? "recent_window" : "none",
  };

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(
    outDir,
    `preview-report-${generatedAt.toISOString().replace(/[:.]/g, "-")}.json`
  );
  const summaryPath = join(
    outDir,
    `preview-summary-${generatedAtIso.slice(0, 10)}.jsonl`
  );
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: generatedAtIso,
        metadata,
        summary,
        reports,
        rankings,
        strategyRisks,
        evolution,
        active,
      },
      null,
      2
    )
  );
  appendFileSync(summaryPath, JSON.stringify(summary) + "\n", "utf-8");

  return {
    generatedAt: generatedAtIso,
    metadata,
    outPath,
    summaryPath,
    summary,
    reports,
    rankings,
    strategyRisks,
    evolution,
    rows,
    active,
  };
}

function createPreviewAccountsReportSlice(
  generatedAtIso: string,
  reports: PreviewAccountReport[],
  accountIds: readonly string[]
): PreviewAccountsReportSlice {
  const activeSet = new Set(accountIds);
  const activeReports = reports.filter((report) => activeSet.has(report.accountId));
  const activeRankings = rankPreviewAccounts(activeReports);
  const activeStrategyRisks = rankStrategyRisks(activeReports);
  const activeEvolution = planPreviewEvolution(activeReports, activeRankings, {
    currentActiveAccounts: accountIds,
    targetActiveCount: accountIds.length,
  });
  return {
    accountIds: [...accountIds],
    summary: createPreviewReportSummary(
      generatedAtIso,
      activeReports,
      activeRankings,
      activeEvolution
    ),
    reports: activeReports,
    rankings: activeRankings,
    strategyRisks: activeStrategyRisks,
    evolution: activeEvolution,
    rows: createPreviewReportRows(activeReports, activeRankings),
  };
}

export function formatPreviewAccountRanking(
  ranking: PreviewAccountRanking
): string {
  const live = ranking.liveReady
    ? "live=ready"
    : `live=blocked: ${ranking.liveBlockers.join("; ") || "none"}`;
  return (
    `- ${ranking.accountId}: ${ranking.grade} score=${ranking.score} ${live}` +
    (ranking.reasons.length ? ` (${ranking.reasons.join("; ")})` : "")
  );
}

export function formatStrategyRiskAssessment(
  assessment: StrategyRiskAssessment
): string {
  return (
    `- ${assessment.accountId}: ${assessment.decision} risk=${assessment.riskLevel} ` +
    `score=${assessment.riskAdjustedScore} capital=${assessment.currentCapitalUsd}U ` +
    `pnl=${assessment.realizedPnlUsd}U roi=${assessment.realizedRoiPct}% ` +
    `exposure=${assessment.openExposurePct}% nextOrder=${assessment.suggestedMaxOrderUsd}U` +
    (assessment.reasons.length ? ` (${assessment.reasons.join("; ")})` : "")
  );
}

export function formatPreviewReportScope(metadata: PreviewReportMetadata): string {
  const window =
    metadata.windowColumnsScope === "recent_window" && metadata.recentWindowMs
      ? `win* = last ${Math.round(metadata.recentWindowMs / 60_000)}m`
      : "win* disabled";
  return (
    "Scope: skips/top skips are retained audit-log counts; " +
    "COPY/REDEEM/ERROR are retained audit-log counts; " +
    `${window}.`
  );
}

export { formatPreviewEvolutionPlan };
export { formatPreviewSummaryDigest };

export function formatPreviewAccountDetails(report: PreviewAccountReport): string[] {
  return [
    `\n${report.accountId}`,
    `top skips (retained audit): ${
      report.skipReasons.map((r) => `${r.count}x ${r.reason}`).join(" | ") ||
      "none"
    }`,
    `redeems: ${
      report.recentRedeems
        .map((r) => `${r.payoutUsd ?? 0}U ${r.reason ?? ""}`)
        .join(" | ") || "none"
    }`,
    `open: ${
      report.openMarkets
        .map((m) => `${m.costUsd}U ${m.slug ?? "(no slug)"}`)
        .join(" | ") || "none"
    }`,
  ];
}
