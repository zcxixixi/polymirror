import { describe, expect, it } from "vitest";
import {
  createCohortQualityRows,
  formatCohortQualityMarkdown,
} from "../src/sim/cohort-quality-table.js";
import { emptyPreviewCopyQuality } from "../src/sim/preview-quality.js";
import type { PreviewAccountReport } from "../src/sim/preview-report.js";

function report(
  accountId: string,
  overrides: Partial<PreviewAccountReport> = {}
): PreviewAccountReport {
  return {
    accountId,
    dbPath: `/tmp/${accountId}/preview.db`,
    copyPriceMode: "executable_guarded",
    exists: true,
    cashUsd: 200,
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
    copyQuality: emptyPreviewCopyQuality(0, 0, 0),
    performance: {
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
        sinceMs: 1,
        tradeCount: 0,
        pnlUsd: 0,
        winRatePct: 0,
        profitFactor: null,
      },
    },
    ...overrides,
  };
}

describe("operator cohort quality table", () => {
  it("assigns roles deterministically without promoting a single profitable sample", () => {
    const rows = createCohortQualityRows(
      [
        report("watch", { redeemCount: 10 }),
        report("single-profit", {
          realizedPnlUsd: 50,
          redeemCount: 1,
          performance: {
            ...report("base").performance,
            tradeCount: 1,
            winCount: 1,
            totalPnlUsd: 50,
            grossProfitUsd: 50,
            winRatePct: 100,
          },
        }),
        report("qualified", {
          stabilityGoal: { passed: true } as never,
        }),
        report("killed", {
          killSwitch: true,
          stabilityGoal: { passed: true } as never,
        }),
        report("quarantined"),
      ],
      {
        labels: { qualified: "Qualified A" },
        controlStates: { quarantined: "QUARANTINED" },
      }
    );

    expect(rows.map((row) => [row.accountId, row.role])).toEqual([
      ["killed", "settle-only"],
      ["qualified", "qualified"],
      ["quarantined", "settle-only"],
      ["single-profit", "collecting"],
      ["watch", "watch"],
    ]);
    expect(rows.find((row) => row.accountId === "qualified")?.account).toBe("Qualified A");
    expect(rows.find((row) => row.accountId === "single-profit")?.performance)
      .toContain("Sharpe=样本不足");
  });

  it("renders explicit quality, performance, and 24h evidence", () => {
    const maturePerformance = {
      ...report("base").performance,
      tradeCount: 20,
      winCount: 13,
      lossCount: 7,
      totalPnlUsd: 12,
      grossProfitUsd: 21,
      grossLossUsd: 9,
      winRatePct: 65,
      profitFactor: 2.3333,
      payoffRatio: 1.5,
      sharpeRatio: 1.2345,
      maxDrawdownPct: 4.2,
      equityStabilityPct: 96.7,
      recent: {
        sinceMs: 1,
        tradeCount: 3,
        pnlUsd: 1.25,
        winRatePct: 66.67,
        profitFactor: 2,
      },
    };
    const [row] = createCohortQualityRows(
      [
        report("account-a", {
          cashUsd: 210.76,
          openCostUsd: 8.24,
          realizedPnlUsd: 10.8,
          copyCount: 35,
          redeemCount: 17,
          pendingOrderCount: 2,
          liveOrderIntentCount: 1,
          cashReplayDeltaUsd: 0.2,
          capitalDeltaUsd: -0.3,
          recentWindow: {
            ...report("base").recentWindow!,
            copyCount: 4,
            redeemCount: 2,
          },
          performance: maturePerformance,
        }),
      ],
      {
        controlStates: { "account-a": "ACTIVE" },
        walletDrifts: { "account-a": ["token drift"] },
        settlementFailures: { "account-a": 3 },
      }
    );

    expect(row).toEqual({
      accountId: "account-a",
      account: "account-a",
      role: "watch",
      cumulative: "+10.80U / 35 / 17",
      cashOpenCost: "210.76U / 8.24U",
      quality:
        "state=ACTIVE; pending=2; intents=1; walletDrift=1; settlement=3; accountingDelta=+0.20/-0.30U",
      performance:
        "Sharpe=1.23 / PF=2.33 / 胜率=65.00% / Payoff=1.50 / 回撤=4.20% / 稳定度=96.70%",
      recent24h: "6 / +1.25U",
    });
  });

  it("emits fixed Markdown columns and escapes labels", () => {
    const rows = createCohortQualityRows(
      [report("account-a", { redeemCount: 10 })],
      { labels: { "account-a": "A|label" } }
    );
    const markdown = formatCohortQualityMarkdown(rows);

    expect(markdown.split("\n")[0]).toBe(
      "| 账户 | 角色 | 累计PnL/COPY/REDEEM | Cash/OpenCost | 质量 | 绩效 | 近24h交易/PnL |"
    );
    expect(markdown).toContain("| A\\|label | watch |");
    expect(markdown).toContain("walletDrift=未提供");
    expect(markdown).toContain("settlement=未提供");
  });
});
