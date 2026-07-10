import { describe, expect, it } from "vitest";
import type { PreviewAccountReport } from "../src/sim/preview-report.js";
import { rankPreviewAccounts } from "../src/sim/preview-selection.js";
import { emptyPreviewCopyQuality } from "../src/sim/preview-quality.js";
import type { PreviewCopyQualitySummary } from "../src/sim/preview-quality.js";
import type { ProfitabilityGateAssessment } from "../src/sim/profitability-gate.js";

function quality(
  overrides: Partial<PreviewCopyQualitySummary>
): PreviewCopyQualitySummary {
  return {
    ...emptyPreviewCopyQuality(120, 40, 4),
    primaryIssue: {
      code: "healthy",
      severity: "ok",
      label: "复制质量正常",
      detail: "test",
    },
    ...overrides,
  };
}

function report(
  accountId: string,
  overrides: Partial<PreviewAccountReport>
): PreviewAccountReport {
  return {
    accountId,
    dbPath: `/tmp/${accountId}.db`,
    exists: true,
    cashUsd: 100,
    openCostUsd: 80,
    openPositions: 10,
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
    recentWindow: {
      sinceMs: 1,
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
    },
    ...overrides,
  };
}

function gate(
  overrides: Partial<ProfitabilityGateAssessment>
): ProfitabilityGateAssessment {
  return {
    grade: "watch",
    passed: false,
    score: 0,
    blockers: ["profit factor below live gate"],
    warnings: [],
    sample: {
      settledTrades: 120,
      copyTrades: 160,
      recentSettledTrades: 20,
    },
    metrics: {
      realizedPnlUsd: 80,
      sharpeRatio: 0.9,
      profitFactor: 1.1,
      winRatePct: 62,
      payoffRatio: 1.1,
      maxDrawdownPct: 4,
      dependencyIssue: "diversified",
      equityStabilityPct: 96,
      recentPnlUsd: 4,
      recentProfitFactor: 1.2,
    },
    thresholds: {
      minLiveSettledTrades: 100,
      minLiveCopyTrades: 100,
      minCandidateSettledTrades: 10,
      minLivePnlUsd: 0.01,
      minLiveSharpeRatio: 1.5,
      minLiveProfitFactor: 1.5,
      minLiveWinRatePct: 60,
      minLivePayoffRatio: 1,
      maxLiveDrawdownPct: 5,
      minLiveEquityStabilityPct: 95,
      maxLiveTop3WinContributionPct: 75,
      maxRejectDrawdownPct: 15,
    },
    ...overrides,
  };
}

describe("rankPreviewAccounts", () => {
  it("keeps accounts below the profit gate out of candidate grade", () => {
    const ranked = rankPreviewAccounts([
      report("flat_clean", {
        realizedPnlUsd: 0,
        cashUsd: 160,
        openCostUsd: 80,
        recentWindow: {
          sinceMs: 1,
          copyCount: 50,
          redeemCount: 10,
          errorCount: 0,
          skipCount: 0,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 0,
        },
      }),
      report("profitable_clean", {
        realizedPnlUsd: 8,
        cashUsd: 160,
        openCostUsd: 80,
        recentWindow: {
          sinceMs: 1,
          copyCount: 40,
          redeemCount: 8,
          errorCount: 0,
          skipCount: 0,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 0,
        },
      }),
    ]);

    expect(ranked[0]).toMatchObject({
      accountId: "profitable_clean",
      grade: "candidate",
    });
    expect(ranked[1]).toMatchObject({
      accountId: "flat_clean",
      grade: "watch",
    });
    expect(ranked[1]?.reasons).toContain("profit gate not met");
  });

  it("prefers profitable clean accounts over high-activity losing accounts", () => {
    const ranked = rankPreviewAccounts([
      report("high_activity_loser", {
        realizedPnlUsd: -45,
        cashUsd: 40,
        openCostUsd: 115,
        recentWindow: {
          sinceMs: 1,
          copyCount: 360,
          redeemCount: 50,
          errorCount: 0,
          skipCount: 3300,
          priceFilteredSkipCount: 2100,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 360,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 210,
        },
      }),
      report("profitable_clean", {
        realizedPnlUsd: 102,
        cashUsd: 145,
        openCostUsd: 158,
        recentWindow: {
          sinceMs: 1,
          copyCount: 206,
          redeemCount: 41,
          errorCount: 0,
          skipCount: 10700,
          priceFilteredSkipCount: 7500,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 424,
        },
      }),
    ]);

    expect(ranked[0]?.accountId).toBe("profitable_clean");
    expect(ranked[1]).toMatchObject({
      accountId: "high_activity_loser",
      grade: "watch",
    });
    expect(ranked[1]?.reasons).toContain("negative realized pnl");
  });

  it("keeps cash-starved profitable accounts eligible while warning about missed copies", () => {
    const ranked = rankPreviewAccounts([
      report("fixed1_cap10", {
        realizedPnlUsd: 5,
        cashUsd: 108.79,
        openCostUsd: 77.98,
        recentWindow: {
          sinceMs: 1,
          copyCount: 180,
          redeemCount: 14,
          errorCount: 0,
          skipCount: 442,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 20,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 73,
        },
      }),
      report("pct10_cap20", {
        realizedPnlUsd: 50,
        cashUsd: 98.41,
        openCostUsd: 129.04,
        redeemCount: 120,
        recentWindow: {
          sinceMs: 1,
          copyCount: 94,
          redeemCount: 10,
          errorCount: 0,
          skipCount: 611,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 63,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 0,
        },
      }),
    ]);

    const cashStarved = ranked.find((r) => r.accountId === "pct10_cap20");
    expect(cashStarved).toMatchObject({
      grade: "candidate",
      liveReady: true,
    });
    expect(cashStarved?.reasons).toContain("recent cash-starved skips");
    expect(cashStarved?.liveBlockers).not.toContain("recent cash-starved skips");
  });

  it("rejects accounts with errors or kill switch even if they copied trades", () => {
    const ranked = rankPreviewAccounts([
      report("bad", {
        cashUsd: 150,
        errorCount: 1,
        killSwitch: true,
        recentWindow: {
          sinceMs: 1,
          copyCount: 200,
          redeemCount: 20,
          errorCount: 1,
          skipCount: 0,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 0,
        },
      }),
    ]);

    expect(ranked[0]).toMatchObject({
      accountId: "bad",
      grade: "reject",
    });
    expect(ranked[0]?.score).toBeLessThan(0);
    expect(ranked[0]?.reasons).toEqual(
      expect.arrayContaining(["kill switch active", "errors present"])
    );
  });

  it("downgrades accounts that recently miss many redeem matches", () => {
    const ranked = rankPreviewAccounts([
      report("clean_fixed", {
        realizedPnlUsd: 5,
        cashUsd: 80,
        openCostUsd: 120,
        recentWindow: {
          sinceMs: 1,
          copyCount: 120,
          redeemCount: 20,
          errorCount: 0,
          skipCount: 100,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 20,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 5,
        },
      }),
      report("missed_redeems", {
        cashUsd: 120,
        openCostUsd: 100,
        recentWindow: {
          sinceMs: 1,
          copyCount: 100,
          redeemCount: 20,
          errorCount: 0,
          skipCount: 500,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 90,
        },
      }),
    ]);

    expect(ranked[0]?.accountId).toBe("clean_fixed");
    expect(ranked[0]?.grade).toBe("candidate");
    expect(ranked[1]).toMatchObject({
      accountId: "missed_redeems",
      grade: "watch",
    });
    expect(ranked[1]?.reasons).toContain("recent unmatched redeem skips");
  });

  it("marks profitable settled low-risk accounts as live ready", () => {
    const ranked = rankPreviewAccounts([
      report("pct5_cap20", {
        realizedPnlUsd: 160.94,
        cashUsd: 200.09,
        openCostUsd: 161.07,
        redeemCount: 136,
        recentWindow: {
          sinceMs: 1,
          copyCount: 65,
          redeemCount: 13,
          errorCount: 0,
          skipCount: 275,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 5,
          unmatchedRedeemSkipCount: 5,
        },
      }),
    ]);

    expect(ranked[0]).toMatchObject({
      accountId: "pct5_cap20",
      grade: "candidate",
      liveReady: true,
      liveBlockers: [],
    });
  });

  it("blocks live promotion when profitability gate is not passed", () => {
    const ranked = rankPreviewAccounts([
      report("old_rules_profitable", {
        realizedPnlUsd: 80,
        cashUsd: 150,
        openCostUsd: 80,
        copyCount: 160,
        redeemCount: 120,
        profitabilityGate: gate({
          grade: "watch",
          passed: false,
          blockers: ["profit factor below live gate"],
        }),
      }),
    ]);

    expect(ranked[0]).toMatchObject({
      accountId: "old_rules_profitable",
      liveReady: false,
      liveBlockers: expect.arrayContaining(["profitability gate not passed"]),
    });
  });

  it("blocks live promotion for high exposure, cap skips, or too few settlements", () => {
    const ranked = rankPreviewAccounts([
      report("high_open_cost", {
        realizedPnlUsd: 386.44,
        cashUsd: 265.76,
        openCostUsd: 320.78,
        redeemCount: 178,
        recentWindow: {
          sinceMs: 1,
          copyCount: 96,
          redeemCount: 19,
          errorCount: 0,
          skipCount: 243,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 0,
        },
      }),
      report("recent_cap_skips", {
        realizedPnlUsd: 55.62,
        cashUsd: 127.99,
        openCostUsd: 127.7,
        redeemCount: 80,
        recentWindow: {
          sinceMs: 1,
          copyCount: 80,
          redeemCount: 12,
          errorCount: 0,
          skipCount: 200,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 1,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 0,
        },
      }),
      report("too_few_settlements", {
        realizedPnlUsd: 46.51,
        cashUsd: 163.58,
        openCostUsd: 82.99,
        redeemCount: 56,
        recentWindow: {
          sinceMs: 1,
          copyCount: 42,
          redeemCount: 8,
          errorCount: 0,
          skipCount: 100,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 0,
        },
      }),
    ]);

    const byAccount = new Map(ranked.map((r) => [r.accountId, r]));

    expect(byAccount.get("high_open_cost")).toMatchObject({
      liveReady: false,
      liveBlockers: expect.arrayContaining(["high open cost"]),
    });
    expect(byAccount.get("recent_cap_skips")).toMatchObject({
      liveReady: false,
      liveBlockers: expect.arrayContaining(["recent position-cap skips"]),
    });
    expect(byAccount.get("too_few_settlements")).toMatchObject({
      liveReady: false,
      liveBlockers: expect.arrayContaining([
        "settled redeem count below live gate",
      ]),
    });
  });

  it("blocks live promotion when accounting diagnostics are not clean", () => {
    const ranked = rankPreviewAccounts([
      report("dirty_accounting", {
        realizedPnlUsd: 50,
        cashUsd: 120,
        openCostUsd: 40,
        redeemCount: 120,
        cashReplayDeltaUsd: 0.02,
        capitalDeltaUsd: 0,
      }),
      report("pending_state", {
        realizedPnlUsd: 50,
        cashUsd: 120,
        openCostUsd: 40,
        redeemCount: 120,
        pendingOrderCount: 1,
      }),
      report("clean", {
        realizedPnlUsd: 50,
        cashUsd: 120,
        openCostUsd: 40,
        redeemCount: 120,
      }),
    ]);

    expect(ranked.find((r) => r.accountId === "dirty_accounting")).toMatchObject({
      liveReady: false,
      liveBlockers: expect.arrayContaining(["accounting diagnostics not clean"]),
    });
    expect(ranked.find((r) => r.accountId === "pending_state")).toMatchObject({
      liveReady: false,
      liveBlockers: expect.arrayContaining(["pending recovery state present"]),
    });
    expect(ranked.find((r) => r.accountId === "clean")).toMatchObject({
      liveReady: true,
    });
  });

  it("does not block live promotion for redeem skips from markets the strategy never copied", () => {
    const ranked = rankPreviewAccounts([
      report("no_local_only", {
        realizedPnlUsd: 80,
        cashUsd: 150,
        openCostUsd: 80,
        redeemCount: 120,
        recentWindow: {
          sinceMs: 1,
          copyCount: 90,
          redeemCount: 20,
          errorCount: 0,
          skipCount: 80,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 80,
          unmatchedRedeemSkipCount: 0,
        },
      }),
    ]);

    expect(ranked[0]).toMatchObject({
      accountId: "no_local_only",
      liveReady: true,
      liveBlockers: [],
    });
  });

  it("still blocks live promotion for suspicious redeem skips", () => {
    const ranked = rankPreviewAccounts([
      report("missing_redeem_data", {
        realizedPnlUsd: 80,
        cashUsd: 150,
        openCostUsd: 80,
        redeemCount: 120,
        recentWindow: {
          sinceMs: 1,
          copyCount: 90,
          redeemCount: 20,
          errorCount: 0,
          skipCount: 12,
          priceFilteredSkipCount: 0,
          cashStarvedSkipCount: 0,
          positionCapSkipCount: 0,
          maxOpenMarketSkipCount: 0,
          noLocalRedeemSkipCount: 0,
          unmatchedRedeemSkipCount: 12,
        },
      }),
    ]);

    expect(ranked[0]).toMatchObject({
      accountId: "missing_redeem_data",
      liveReady: false,
      liveBlockers: expect.arrayContaining(["recent unmatched redeem skips"]),
    });
  });

  it("blocks live promotion when copy quality shows sell coverage gap", () => {
    const ranked = rankPreviewAccounts([
      report("sell_gap", {
        realizedPnlUsd: 80,
        cashUsd: 150,
        openCostUsd: 40,
        redeemCount: 120,
        copyQuality: quality({
          coverage: { buyPct: 85, sellPct: 10, tradePct: 45 },
          primaryIssue: {
            code: "not_selling",
            severity: "warning",
            label: "没卖到",
            detail: "sell gap",
          },
        }),
      }),
    ]);

    expect(ranked[0]).toMatchObject({
      accountId: "sell_gap",
      grade: "watch",
      liveReady: false,
      reasons: expect.arrayContaining(["sell coverage gap"]),
      liveBlockers: expect.arrayContaining(["sell coverage gap"]),
    });
  });
});
