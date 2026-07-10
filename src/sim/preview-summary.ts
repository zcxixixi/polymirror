import type { PreviewEvolutionPlan } from "./preview-evolution.js";
import type { PreviewAccountReport } from "./preview-report.js";
import type { PreviewAccountRanking } from "./preview-selection.js";

export interface PreviewReportSummaryAccount {
  accountId: string;
  value: number;
  action?: string;
  riskCategory?: string;
}

export interface PreviewReportSummary {
  generatedAt: string;
  accountCount: number;
  liveReadyCount: number;
  totals: {
    realizedPnlUsd: number;
    cashUsd: number;
    openCostUsd: number;
    copies: number;
    redeems: number;
  };
  riskCounts: {
    missingDb: number;
    killSwitch: number;
    errors: number;
    accountingDiagnostics: number;
    pendingRecovery: number;
    cashStarved: number;
    positionCap: number;
    highOpenCost: number;
  };
  evolution: {
    promoteAccounts: string[];
    retireAccounts: string[];
    addAccounts: string[];
    nextActiveCount: number;
  };
  topPnl: PreviewReportSummaryAccount[];
  bottomPnl: PreviewReportSummaryAccount[];
  topOpenCost: PreviewReportSummaryAccount[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function countReports(
  reports: PreviewAccountReport[],
  predicate: (report: PreviewAccountReport) => boolean
): number {
  return reports.filter(predicate).length;
}

function hasRecentOrTotal(
  report: PreviewAccountReport,
  totalKey: "cashStarvedSkipCount" | "positionCapSkipCount",
  windowKey: "cashStarvedSkipCount" | "positionCapSkipCount"
): boolean {
  return report[totalKey] > 0 || (report.recentWindow?.[windowKey] ?? 0) > 0;
}

function accountRows(
  reports: PreviewAccountReport[],
  evolution: PreviewEvolutionPlan,
  field: "realizedPnlUsd" | "openCostUsd",
  order: "asc" | "desc"
): PreviewReportSummaryAccount[] {
  const decisionByAccount = new Map(
    evolution.decisions.map((decision) => [decision.accountId, decision])
  );
  return [...reports]
    .sort((a, b) =>
      order === "desc" ? b[field] - a[field] : a[field] - b[field]
    )
    .slice(0, 5)
    .map((report) => {
      const decision = decisionByAccount.get(report.accountId);
      return {
        accountId: report.accountId,
        value: round2(report[field]),
        action: decision?.action,
        riskCategory: decision?.riskCategory,
      };
    });
}

export function createPreviewReportSummary(
  generatedAt: string,
  reports: PreviewAccountReport[],
  rankings: PreviewAccountRanking[],
  evolution: PreviewEvolutionPlan
): PreviewReportSummary {
  const rankingByAccount = new Map(rankings.map((ranking) => [ranking.accountId, ranking]));

  return {
    generatedAt,
    accountCount: reports.length,
    liveReadyCount: rankings.filter((ranking) => ranking.liveReady).length,
    totals: {
      realizedPnlUsd: round2(
        reports.reduce((sum, report) => sum + report.realizedPnlUsd, 0)
      ),
      cashUsd: round2(reports.reduce((sum, report) => sum + report.cashUsd, 0)),
      openCostUsd: round2(
        reports.reduce((sum, report) => sum + report.openCostUsd, 0)
      ),
      copies: reports.reduce((sum, report) => sum + report.copyCount, 0),
      redeems: reports.reduce((sum, report) => sum + report.redeemCount, 0),
    },
    riskCounts: {
      missingDb: countReports(reports, (report) => !report.exists),
      killSwitch: countReports(reports, (report) => report.killSwitch),
      errors: countReports(
        reports,
        (report) => report.errorCount > 0 || (report.recentWindow?.errorCount ?? 0) > 0
      ),
      accountingDiagnostics: countReports(
        reports,
        (report) =>
          Math.abs(report.cashReplayDeltaUsd) > 0.01 ||
          Math.abs(report.capitalDeltaUsd) > 0.5 ||
          report.missingMarketMetadataCount > 0
      ),
      pendingRecovery: countReports(
        reports,
        (report) => report.pendingOrderCount > 0 || report.liveOrderIntentCount > 0
      ),
      cashStarved: countReports(reports, (report) =>
        hasRecentOrTotal(report, "cashStarvedSkipCount", "cashStarvedSkipCount")
      ),
      positionCap: countReports(reports, (report) =>
        hasRecentOrTotal(report, "positionCapSkipCount", "positionCapSkipCount")
      ),
      highOpenCost: countReports(reports, (report) => {
        const ranking = rankingByAccount.get(report.accountId);
        return ranking?.liveBlockers.includes("high open cost") ?? false;
      }),
    },
    evolution: {
      promoteAccounts: evolution.promoteAccounts,
      retireAccounts: evolution.retireAccounts,
      addAccounts: evolution.addAccounts,
      nextActiveCount: evolution.nextActiveAccounts.length,
    },
    topPnl: accountRows(reports, evolution, "realizedPnlUsd", "desc"),
    bottomPnl: accountRows(reports, evolution, "realizedPnlUsd", "asc"),
    topOpenCost: accountRows(reports, evolution, "openCostUsd", "desc"),
  };
}

export function formatPreviewSummaryDigest(summary: PreviewReportSummary): string[] {
  return [
    `Summary: liveReady=${summary.liveReadyCount}/${summary.accountCount} pnl=${summary.totals.realizedPnlUsd}U openCost=${summary.totals.openCostUsd}U`,
    `Risks: kill=${summary.riskCounts.killSwitch} errors=${summary.riskCounts.errors} accounting=${summary.riskCounts.accountingDiagnostics} cash=${summary.riskCounts.cashStarved} cap=${summary.riskCounts.positionCap}`,
    `Evolution: promote=${summary.evolution.promoteAccounts.join(", ") || "none"} retire=${summary.evolution.retireAccounts.join(", ") || "none"} next=${summary.evolution.nextActiveCount}`,
  ];
}
