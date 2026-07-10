import type { PreviewAccountReport } from "./preview-report.js";
import type { PreviewAccountRanking } from "./preview-selection.js";

export type PreviewEvolutionAction = "promote" | "keep" | "watch" | "retire";
export type PreviewEvolutionConfidence = "high" | "medium" | "low";
export type PreviewEvolutionRiskCategory =
  | "profit_winner"
  | "hard_safety"
  | "accounting_diagnostics"
  | "mature_loss"
  | "rejected"
  | "cash_pressure"
  | "position_pressure"
  | "watch"
  | "neutral";

export interface PreviewEvolutionDecision {
  accountId: string;
  action: PreviewEvolutionAction;
  score: number;
  grade: PreviewAccountRanking["grade"];
  liveReady: boolean;
  currentlyActive: boolean;
  inNextActive: boolean;
  realizedPnlUsd: number;
  cashUsd: number;
  openCostUsd: number;
  confidence: PreviewEvolutionConfidence;
  riskCategory: PreviewEvolutionRiskCategory;
  reasons: string[];
}

export interface PreviewEvolutionPlan {
  targetActiveCount: number;
  promoteAccounts: string[];
  keepAccounts: string[];
  watchAccounts: string[];
  retireAccounts: string[];
  addAccounts: string[];
  nextActiveAccounts: string[];
  decisions: PreviewEvolutionDecision[];
}

export interface PlanPreviewEvolutionOptions {
  currentActiveAccounts?: readonly string[];
  targetActiveCount?: number;
  maxPromotions?: number;
  minPromoteRealizedPnlUsd?: number;
  minRetireRealizedPnlUsd?: number;
  minRetireCopyCount?: number;
  minRetireRedeemCount?: number;
}

const HARD_SAFETY_REASONS = new Set([
  "missing db",
  "kill switch active",
  "errors present",
  "accounting diagnostics not clean",
  "pending recovery state present",
]);

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function hasHardSafetyBlocker(ranking: PreviewAccountRanking): boolean {
  return [...ranking.reasons, ...ranking.liveBlockers].some((reason) =>
    HARD_SAFETY_REASONS.has(reason)
  );
}

function hasReason(ranking: PreviewAccountRanking, reason: string): boolean {
  return [...ranking.reasons, ...ranking.liveBlockers].includes(reason);
}

function hasMatureSample(
  report: PreviewAccountReport,
  minCopyCount: number,
  minRedeemCount: number
): boolean {
  return report.copyCount >= minCopyCount || report.redeemCount >= minRedeemCount;
}

function decideAction(
  report: PreviewAccountReport,
  ranking: PreviewAccountRanking,
  options: Required<
    Pick<
      PlanPreviewEvolutionOptions,
      | "minPromoteRealizedPnlUsd"
      | "minRetireRealizedPnlUsd"
      | "minRetireCopyCount"
      | "minRetireRedeemCount"
    >
  >
): {
  action: PreviewEvolutionAction;
  confidence: PreviewEvolutionConfidence;
  riskCategory: PreviewEvolutionRiskCategory;
  reasons: string[];
} {
  const reasons = [...ranking.reasons];

  if (hasReason(ranking, "accounting diagnostics not clean")) {
    return {
      action: "retire",
      confidence: "medium",
      riskCategory: "accounting_diagnostics",
      reasons: uniq([...reasons, "hard safety blocker"]),
    };
  }

  if (hasHardSafetyBlocker(ranking)) {
    return {
      action: "retire",
      confidence: "high",
      riskCategory: "hard_safety",
      reasons: uniq([...reasons, "hard safety blocker"]),
    };
  }

  if (ranking.grade === "reject") {
    return {
      action: "retire",
      confidence: "medium",
      riskCategory: "rejected",
      reasons: uniq([...reasons, "rejected by preview ranking"]),
    };
  }

  if (
    report.realizedPnlUsd <= options.minRetireRealizedPnlUsd &&
    hasMatureSample(report, options.minRetireCopyCount, options.minRetireRedeemCount)
  ) {
    return {
      action: "retire",
      confidence: "high",
      riskCategory: "mature_loss",
      reasons: uniq([...reasons, "mature negative pnl"]),
    };
  }

  if (
    ranking.liveReady &&
    report.realizedPnlUsd >= options.minPromoteRealizedPnlUsd
  ) {
    return {
      action: "promote",
      confidence: "high",
      riskCategory: "profit_winner",
      reasons,
    };
  }

  if (ranking.grade === "candidate") {
    if (hasReason(ranking, "recent cash-starved skips")) {
      return {
        action: "keep",
        confidence: "medium",
        riskCategory: "cash_pressure",
        reasons,
      };
    }
    if (hasReason(ranking, "recent position-cap skips")) {
      return {
        action: "keep",
        confidence: "medium",
        riskCategory: "position_pressure",
        reasons,
      };
    }
    return {
      action: "keep",
      confidence: "medium",
      riskCategory: "neutral",
      reasons,
    };
  }

  return {
    action: "watch",
    confidence: "low",
    riskCategory: "watch",
    reasons,
  };
}

function actionRank(action: PreviewEvolutionAction): number {
  switch (action) {
    case "promote":
      return 0;
    case "keep":
      return 1;
    case "watch":
      return 2;
    case "retire":
      return 3;
  }
}

export function planPreviewEvolution(
  reports: PreviewAccountReport[],
  rankings: PreviewAccountRanking[],
  options: PlanPreviewEvolutionOptions = {}
): PreviewEvolutionPlan {
  const maxPromotions = options.maxPromotions ?? 4;
  const thresholds = {
    minPromoteRealizedPnlUsd: options.minPromoteRealizedPnlUsd ?? 20,
    minRetireRealizedPnlUsd: options.minRetireRealizedPnlUsd ?? -10,
    minRetireCopyCount: options.minRetireCopyCount ?? 20,
    minRetireRedeemCount: options.minRetireRedeemCount ?? 5,
  };
  const reportByAccount = new Map(reports.map((r) => [r.accountId, r]));
  const currentActiveAccounts = [
    ...(options.currentActiveAccounts ?? reports.map((r) => r.accountId)),
  ];
  const currentActive = new Set(currentActiveAccounts);
  const targetActiveCount =
    options.targetActiveCount ?? Math.max(1, currentActiveAccounts.length);

  const rankedDecisions: PreviewEvolutionDecision[] = [];
  for (const ranking of rankings) {
    const report = reportByAccount.get(ranking.accountId);
    if (!report) continue;
    const decision = decideAction(report, ranking, thresholds);
    rankedDecisions.push({
      accountId: ranking.accountId,
      action: decision.action,
      score: ranking.score,
      grade: ranking.grade,
      liveReady: ranking.liveReady,
      currentlyActive: currentActive.has(ranking.accountId),
      inNextActive: false,
      realizedPnlUsd: report.realizedPnlUsd,
      cashUsd: report.cashUsd,
      openCostUsd: report.openCostUsd,
      confidence: decision.confidence,
      riskCategory: decision.riskCategory,
      reasons: decision.reasons,
    });
  }

  const promotions = rankedDecisions
    .filter((decision) => decision.action === "promote")
    .sort((a, b) => b.score - a.score);
  for (const decision of promotions.slice(maxPromotions)) {
    decision.action = "keep";
    decision.reasons = uniq([...decision.reasons, "promotion cap"]);
  }

  const decisionByAccount = new Map(rankedDecisions.map((d) => [d.accountId, d]));
  const nonRetiredActive = currentActiveAccounts.filter(
    (accountId) => decisionByAccount.get(accountId)?.action !== "retire"
  );
  const orderedSurvivors = nonRetiredActive
    .map((accountId) => decisionByAccount.get(accountId))
    .filter((decision): decision is PreviewEvolutionDecision => Boolean(decision))
    .sort((a, b) => actionRank(a.action) - actionRank(b.action) || b.score - a.score);

  const nextActiveAccounts: string[] = [];
  for (const decision of orderedSurvivors) {
    if (nextActiveAccounts.length >= targetActiveCount) break;
    nextActiveAccounts.push(decision.accountId);
  }

  const addAccounts: string[] = [];
  for (const decision of rankedDecisions) {
    if (nextActiveAccounts.length >= targetActiveCount) break;
    if (decision.action !== "promote") continue;
    if (nextActiveAccounts.includes(decision.accountId)) continue;
    nextActiveAccounts.push(decision.accountId);
    addAccounts.push(decision.accountId);
  }

  const nextActive = new Set(nextActiveAccounts);
  for (const decision of rankedDecisions) {
    decision.inNextActive = nextActive.has(decision.accountId);
  }

  return {
    targetActiveCount,
    promoteAccounts: rankedDecisions
      .filter((decision) => decision.action === "promote")
      .map((decision) => decision.accountId),
    keepAccounts: rankedDecisions
      .filter((decision) => decision.action === "keep")
      .map((decision) => decision.accountId),
    watchAccounts: rankedDecisions
      .filter((decision) => decision.action === "watch")
      .map((decision) => decision.accountId),
    retireAccounts: [
      ...currentActiveAccounts.filter(
        (accountId) => decisionByAccount.get(accountId)?.action === "retire"
      ),
      ...rankedDecisions
        .filter(
          (decision) =>
            decision.action === "retire" && !currentActive.has(decision.accountId)
        )
        .map((decision) => decision.accountId),
    ],
    addAccounts,
    nextActiveAccounts,
    decisions: rankedDecisions,
  };
}

export function formatPreviewEvolutionPlan(plan: PreviewEvolutionPlan): string[] {
  return [
    `Target active accounts: ${plan.nextActiveAccounts.length}/${plan.targetActiveCount}`,
    `Promote: ${plan.promoteAccounts.join(", ") || "none"}`,
    `Add: ${plan.addAccounts.join(", ") || "none"}`,
    `Retire: ${plan.retireAccounts.join(", ") || "none"}`,
    `Watch: ${plan.watchAccounts.join(", ") || "none"}`,
    `Next active: ${plan.nextActiveAccounts.join(", ") || "none"}`,
  ];
}
