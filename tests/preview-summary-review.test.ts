import { describe, expect, it } from "vitest";
import {
  createPreviewSummaryReview,
  formatPreviewSummaryReview,
} from "../src/sim/preview-summary-review.js";
import type { PreviewReportSummary } from "../src/sim/preview-summary.js";

function summary(
  generatedAt: string,
  overrides: Partial<PreviewReportSummary> = {}
): PreviewReportSummary {
  return {
    generatedAt,
    accountCount: 2,
    liveReadyCount: 1,
    totals: {
      realizedPnlUsd: 10,
      cashUsd: 350,
      openCostUsd: 80,
      copies: 100,
      redeems: 20,
    },
    riskCounts: {
      missingDb: 0,
      killSwitch: 0,
      errors: 0,
      accountingDiagnostics: 0,
      pendingRecovery: 0,
      cashStarved: 1,
      positionCap: 0,
      highOpenCost: 0,
    },
    evolution: {
      promoteAccounts: ["winner"],
      retireAccounts: [],
      addAccounts: [],
      nextActiveCount: 2,
    },
    topPnl: [{ accountId: "winner", value: 10 }],
    bottomPnl: [{ accountId: "laggard", value: -1 }],
    topOpenCost: [{ accountId: "winner", value: 80 }],
    ...overrides,
  };
}

describe("createPreviewSummaryReview", () => {
  it("summarizes trend from compact JSONL samples", () => {
    const review = createPreviewSummaryReview([
      summary("2026-07-07T01:00:00.000Z", {
        totals: {
          realizedPnlUsd: 10,
          cashUsd: 350,
          openCostUsd: 80,
          copies: 100,
          redeems: 20,
        },
      }),
      summary("2026-07-07T02:00:00.000Z", {
        totals: {
          realizedPnlUsd: 18,
          cashUsd: 330,
          openCostUsd: 95,
          copies: 130,
          redeems: 25,
        },
        riskCounts: {
          missingDb: 0,
          killSwitch: 1,
          errors: 0,
          accountingDiagnostics: 1,
          pendingRecovery: 0,
          cashStarved: 2,
          positionCap: 1,
          highOpenCost: 0,
        },
        evolution: {
          promoteAccounts: ["winner"],
          retireAccounts: ["bad"],
          addAccounts: [],
          nextActiveCount: 1,
        },
      }),
    ]);

    expect(review).toMatchObject({
      sampleCount: 2,
      firstGeneratedAt: "2026-07-07T01:00:00.000Z",
      lastGeneratedAt: "2026-07-07T02:00:00.000Z",
      delta: {
        realizedPnlUsd: 8,
        openCostUsd: 15,
        copies: 30,
        redeems: 5,
      },
      latest: {
        promoteAccounts: ["winner"],
        retireAccounts: ["bad"],
        riskCounts: {
          killSwitch: 1,
          accountingDiagnostics: 1,
          cashStarved: 2,
          positionCap: 1,
        },
      },
    });
    expect(formatPreviewSummaryReview(review).join("\n")).toContain("samples=2");
  });
});
