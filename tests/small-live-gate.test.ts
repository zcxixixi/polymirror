import { describe, expect, it } from "vitest";
import type { PreviewDbDigestAccount } from "../src/sim/preview-db-digest.js";
import { assessSmallLiveCandidates } from "../src/sim/small-live-gate.js";

function row(
  accountId: string,
  overrides: Partial<PreviewDbDigestAccount> = {}
): PreviewDbDigestAccount {
  return {
    accountId,
    dbPath: `/tmp/${accountId}/preview.db`,
    exists: true,
    readError: null,
    lastAuditAt: "2026-07-07T10:00:00.000Z",
    lastAuditAgeMinutes: 5,
    stale: false,
    cashUsd: 180,
    openCostUsd: 40,
    equityCostBasisUsd: 220,
    realizedPnlUsd: 60,
    roiPct: 30,
    openPositions: 4,
    copyCount: 500,
    redeemCount: 160,
    errorCount: 0,
    skipCount: 2000,
    pendingOrderCount: 0,
    liveOrderIntentCount: 0,
    missingMarketMetadataCount: 0,
    killSwitch: false,
    recent: {
      copyCount: 80,
      redeemCount: 24,
      errorCount: 0,
      skipCount: 500,
      cashStarvedSkipCount: 0,
      positionCapSkipCount: 0,
      noLocalRedeemSkipCount: 0,
      marketUnresolvedSkipCount: 10,
    },
    winStats: {
      settledCount: 160,
      winCount: 96,
      lossCount: 64,
      flatCount: 0,
      winRatePct: 60,
      parsedPnlUsd: 60,
    },
    recentWinStats: {
      settledCount: 24,
      winCount: 15,
      lossCount: 9,
      flatCount: 0,
      winRatePct: 62.5,
      parsedPnlUsd: 8,
    },
    topSkipReasons: [],
    topErrorReasons: [],
    ...overrides,
  };
}

describe("assessSmallLiveCandidates", () => {
  it("accepts clean high-sample winners and keeps cash-starved as a warning", () => {
    const result = assessSmallLiveCandidates([
      row("winner", {
        recent: {
          ...row("winner").recent,
          cashStarvedSkipCount: 42,
        },
      }),
      row("low_sample", {
        winStats: {
          settledCount: 12,
          winCount: 10,
          lossCount: 2,
          flatCount: 0,
          winRatePct: 83.33,
          parsedPnlUsd: 8,
        },
      }),
    ]);

    expect(result.eligible.map((entry) => entry.accountId)).toEqual(["winner"]);
    expect(result.eligible[0]?.warnings).toContain("recent cash-starved skips");
    expect(result.rejected.find((entry) => entry.accountId === "low_sample")).toMatchObject({
      blockers: expect.arrayContaining(["settled sample below gate"]),
    });
  });

  it("blocks hard safety and accounting issues before ranking by PnL", () => {
    const result = assessSmallLiveCandidates(
      [
        row("high_pnl_bad", {
          realizedPnlUsd: 300,
          errorCount: 1,
          recent: {
            ...row("high_pnl_bad").recent,
            errorCount: 1,
          },
          topErrorReasons: [{ reason: "gamma timeout", count: 1 }],
        }),
        row("clean_lower_pnl", {
          realizedPnlUsd: 70,
          winStats: {
            settledCount: 170,
            winCount: 102,
            lossCount: 68,
            flatCount: 0,
            winRatePct: 60,
            parsedPnlUsd: 70,
          },
        }),
        row("stale", { stale: true }),
        row("bad_db", { readError: "database disk image is malformed" }),
        row("pending", { pendingOrderCount: 1 }),
      ],
      { maxEligible: 2 }
    );

    expect(result.eligible.map((entry) => entry.accountId)).toEqual([
      "clean_lower_pnl",
    ]);
    expect(result.rejected.find((entry) => entry.accountId === "high_pnl_bad")).toMatchObject({
      blockers: expect.arrayContaining(["errors present"]),
    });
    expect(result.rejected.find((entry) => entry.accountId === "stale")).toMatchObject({
      blockers: expect.arrayContaining(["stale data"]),
    });
    expect(result.rejected.find((entry) => entry.accountId === "bad_db")).toMatchObject({
      blockers: expect.arrayContaining(["db read error"]),
    });
    expect(result.rejected.find((entry) => entry.accountId === "pending")).toMatchObject({
      blockers: expect.arrayContaining(["pending recovery state present"]),
    });
  });

  it("returns resolved thresholds so candidate decisions are auditable", () => {
    const result = assessSmallLiveCandidates([row("winner")], {
      minWinRatePct: 58,
      minSettledCount: 120,
      maxEligible: 3,
    });

    expect(result.thresholds).toMatchObject({
      minRealizedPnlUsd: 20,
      minWinRatePct: 58,
      minSettledCount: 120,
      minRedeemCount: 50,
      minCashUsd: 30,
      maxOpenCostUsd: 180,
      maxEligible: 3,
    });
  });
});
