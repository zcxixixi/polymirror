import { describe, expect, it } from "vitest";
import type { PreviewAccountReport } from "../src/sim/preview-report.js";
import { rankPreviewAccounts } from "../src/sim/preview-selection.js";
import { planPreviewEvolution } from "../src/sim/preview-evolution.js";

function report(
  accountId: string,
  overrides: Partial<PreviewAccountReport>
): PreviewAccountReport {
  return {
    accountId,
    dbPath: `/tmp/${accountId}.db`,
    exists: true,
    cashUsd: 120,
    openCostUsd: 60,
    openPositions: 4,
    realizedPnlUsd: 0,
    cashReplayDeltaUsd: 0,
    capitalDeltaUsd: 0,
    missingMarketMetadataCount: 0,
    pendingOrderCount: 0,
    liveOrderIntentCount: 0,
    copyCount: 120,
    redeemCount: 120,
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
    recentWindow: {
      sinceMs: 1,
      copyCount: 120,
      redeemCount: 120,
      errorCount: 0,
      skipCount: 0,
      priceFilteredSkipCount: 0,
      cashStarvedSkipCount: 0,
      positionCapSkipCount: 0,
      maxOpenMarketSkipCount: 0,
      noLocalRedeemSkipCount: 0,
      unmatchedRedeemSkipCount: 0,
    },
    ...overrides,
  };
}

describe("planPreviewEvolution", () => {
  it("retires hard-risk accounts and promotes live-ready winners", () => {
    const reports = [
      report("good", { realizedPnlUsd: 80 }),
      report("bad_error", {
        realizedPnlUsd: 120,
        errorCount: 1,
        recentWindow: {
          ...report("bad_error", {}).recentWindow!,
          errorCount: 1,
        },
      }),
      report("bad_loss", { realizedPnlUsd: -18 }),
      report("borderline", { realizedPnlUsd: 4, redeemCount: 12 }),
    ];
    const rankings = rankPreviewAccounts(reports);

    const plan = planPreviewEvolution(reports, rankings, {
      currentActiveAccounts: ["good", "bad_error", "bad_loss", "borderline"],
      targetActiveCount: 3,
      maxPromotions: 2,
    });

    expect(plan.promoteAccounts).toEqual(["good"]);
    expect(plan.retireAccounts).toEqual(["bad_error", "bad_loss"]);
    expect(plan.nextActiveAccounts).toEqual(["good", "borderline"]);
    expect(plan.decisions.find((d) => d.accountId === "bad_error")).toMatchObject({
      action: "retire",
      confidence: "high",
      riskCategory: "hard_safety",
      reasons: expect.arrayContaining(["hard safety blocker"]),
    });
    expect(plan.decisions.find((d) => d.accountId === "bad_loss")).toMatchObject({
      action: "retire",
      confidence: "high",
      riskCategory: "mature_loss",
    });
    expect(plan.decisions.find((d) => d.accountId === "good")).toMatchObject({
      action: "promote",
      confidence: "high",
      riskCategory: "profit_winner",
    });
  });

  it("fills freed active slots with inactive live-ready winners first", () => {
    const reports = [
      report("old_bad", { realizedPnlUsd: -25 }),
      report("old_keep", { realizedPnlUsd: 10 }),
      report("new_winner", { realizedPnlUsd: 55 }),
      report("new_second", { realizedPnlUsd: 35 }),
    ];
    const rankings = rankPreviewAccounts(reports);

    const plan = planPreviewEvolution(reports, rankings, {
      currentActiveAccounts: ["old_bad", "old_keep"],
      targetActiveCount: 2,
      maxPromotions: 2,
    });

    expect(plan.retireAccounts).toEqual(["old_bad"]);
    expect(plan.addAccounts).toEqual(["new_winner"]);
    expect(plan.nextActiveAccounts).toEqual(["old_keep", "new_winner"]);
  });
});
