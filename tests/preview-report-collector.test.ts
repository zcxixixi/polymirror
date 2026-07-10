import { describe, expect, it } from "vitest";
import {
  parsePreviewReportCollectorEnv,
  runPreviewReportCollector,
} from "../src/sim/preview-report-collector.js";
import type { PreviewAccountsReportResult } from "../src/sim/preview-report-runner.js";

function result(outPath: string): PreviewAccountsReportResult {
  return {
    generatedAt: "2026-07-07T12:00:00.000Z",
    metadata: {
      auditLogScope: "retained_audit_log",
      skipColumnsScope: "retained_audit_log",
      windowColumnsScope: "none",
    },
    outPath,
    summaryPath: "reports/preview-live/preview-summary-2026-07-07.jsonl",
    summary: {
      generatedAt: "2026-07-07T12:00:00.000Z",
      accountCount: 1,
      liveReadyCount: 0,
      totals: {
        realizedPnlUsd: 0,
        cashUsd: 200,
        openCostUsd: 0,
        copies: 0,
        redeems: 0,
      },
      riskCounts: {
        missingDb: 0,
        killSwitch: 0,
        errors: 0,
        accountingDiagnostics: 0,
        pendingRecovery: 0,
        cashStarved: 0,
        positionCap: 0,
        highOpenCost: 0,
      },
      evolution: {
        promoteAccounts: [],
        retireAccounts: [],
        addAccounts: [],
        nextActiveCount: 1,
      },
      topPnl: [],
      bottomPnl: [],
      topOpenCost: [],
    },
    reports: [],
    rankings: [],
    evolution: {
      decisions: [],
      promoteAccounts: [],
      keepAccounts: [],
      retireAccounts: [],
      addAccounts: [],
      nextActiveAccounts: [],
    },
    rows: [],
  };
}

describe("runPreviewReportCollector", () => {
  it("runs the existing preview report generator on a fixed interval", async () => {
    const outPaths: string[] = [];

    const summary = await runPreviewReportCollector({
      intervalMs: 1,
      maxRuns: 3,
      runImmediately: true,
      generate: () => {
        const outPath = `report-${outPaths.length + 1}.json`;
        outPaths.push(outPath);
        return result(outPath);
      },
    });

    expect(outPaths).toEqual([
      "report-1.json",
      "report-2.json",
      "report-3.json",
    ]);
    expect(summary).toMatchObject({
      runs: 3,
      errors: 0,
      stoppedBy: "maxRuns",
      lastOutPath: "report-3.json",
    });
  });

  it("parses collector env without changing report generator defaults", () => {
    expect(
      parsePreviewReportCollectorEnv({
        REPORT_COLLECT_INTERVAL_MINUTES: "2",
        REPORT_COLLECT_RUNS: "5",
        REPORT_COLLECT_RUN_TIMEOUT_MS: "7500",
        REPORT_WINDOW_MINUTES: "30",
      })
    ).toMatchObject({
      intervalMs: 120_000,
      maxRuns: 5,
      runTimeoutMs: 7_500,
      reportOptions: {
        recentWindowMs: 1_800_000,
      },
    });
  });

  it("records a timed-out report run as an error and continues", async () => {
    let calls = 0;

    const summary = await runPreviewReportCollector({
      intervalMs: 1,
      maxRuns: 2,
      runImmediately: true,
      runTimeoutMs: 5,
      generate: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<PreviewAccountsReportResult>(() => {});
        }
        return result("report-2.json");
      },
    });

    expect(calls).toBe(2);
    expect(summary).toMatchObject({
      runs: 2,
      errors: 1,
      lastOutPath: "report-2.json",
    });
    expect(summary.lastError).toContain("timed out");
  });
});
