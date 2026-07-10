import type { PreviewReportSummary } from "./preview-summary.js";

export interface PreviewSummaryReview {
  sampleCount: number;
  firstGeneratedAt: string;
  lastGeneratedAt: string;
  delta: {
    realizedPnlUsd: number;
    openCostUsd: number;
    copies: number;
    redeems: number;
  };
  latest: {
    accountCount: number;
    liveReadyCount: number;
    realizedPnlUsd: number;
    openCostUsd: number;
    promoteAccounts: string[];
    retireAccounts: string[];
    nextActiveCount: number;
    riskCounts: PreviewReportSummary["riskCounts"];
    topPnl: PreviewReportSummary["topPnl"];
    bottomPnl: PreviewReportSummary["bottomPnl"];
    topOpenCost: PreviewReportSummary["topOpenCost"];
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createPreviewSummaryReview(
  summaries: PreviewReportSummary[]
): PreviewSummaryReview {
  if (summaries.length === 0) {
    throw new Error("No preview summary samples to review");
  }

  const ordered = [...summaries].sort((a, b) =>
    a.generatedAt.localeCompare(b.generatedAt)
  );
  const first = ordered[0]!;
  const latest = ordered[ordered.length - 1]!;

  return {
    sampleCount: ordered.length,
    firstGeneratedAt: first.generatedAt,
    lastGeneratedAt: latest.generatedAt,
    delta: {
      realizedPnlUsd: round2(
        latest.totals.realizedPnlUsd - first.totals.realizedPnlUsd
      ),
      openCostUsd: round2(latest.totals.openCostUsd - first.totals.openCostUsd),
      copies: latest.totals.copies - first.totals.copies,
      redeems: latest.totals.redeems - first.totals.redeems,
    },
    latest: {
      accountCount: latest.accountCount,
      liveReadyCount: latest.liveReadyCount,
      realizedPnlUsd: latest.totals.realizedPnlUsd,
      openCostUsd: latest.totals.openCostUsd,
      promoteAccounts: latest.evolution.promoteAccounts,
      retireAccounts: latest.evolution.retireAccounts,
      nextActiveCount: latest.evolution.nextActiveCount,
      riskCounts: latest.riskCounts,
      topPnl: latest.topPnl,
      bottomPnl: latest.bottomPnl,
      topOpenCost: latest.topOpenCost,
    },
  };
}

function names(rows: PreviewReportSummary["topPnl"]): string {
  return rows.map((row) => `${row.accountId}:${row.value}U`).join(", ") || "none";
}

export function formatPreviewSummaryReview(review: PreviewSummaryReview): string[] {
  const risk = review.latest.riskCounts;
  return [
    `Review: samples=${review.sampleCount} window=${review.firstGeneratedAt}..${review.lastGeneratedAt}`,
    `Delta: pnl=${review.delta.realizedPnlUsd}U openCost=${review.delta.openCostUsd}U copies=${review.delta.copies} redeems=${review.delta.redeems}`,
    `Latest: liveReady=${review.latest.liveReadyCount}/${review.latest.accountCount} pnl=${review.latest.realizedPnlUsd}U openCost=${review.latest.openCostUsd}U nextActive=${review.latest.nextActiveCount}`,
    `Risks: kill=${risk.killSwitch} errors=${risk.errors} accounting=${risk.accountingDiagnostics} cash=${risk.cashStarved} cap=${risk.positionCap} highOpen=${risk.highOpenCost}`,
    `Promote: ${review.latest.promoteAccounts.join(", ") || "none"}`,
    `Retire: ${review.latest.retireAccounts.join(", ") || "none"}`,
    `Top PnL: ${names(review.latest.topPnl)}`,
    `Bottom PnL: ${names(review.latest.bottomPnl)}`,
    `Top open cost: ${names(review.latest.topOpenCost)}`,
  ];
}
