import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatPreviewReportScope,
  generatePreviewAccountsReport,
} from "../src/sim/preview-report-runner.js";
import { StateStore } from "../src/state/store.js";

let dir: string;
let dataDir: string;
let outDir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-preview-runner-"));
  dataDir = join(dir, "accounts");
  outDir = join(dir, "reports");
  store = new StateStore(join(dataDir, "acct-a", "preview.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("generatePreviewAccountsReport", () => {
  it("discovers existing account databases when no explicit account list is provided", () => {
    store.recordCopySuccess({
      tradeKey: "copy-a",
      leaderId: "leader-a",
      tokenId: "token-a",
      side: "BUY",
      filledShares: 2,
      price: 0.5,
      filledUsd: 1,
      auditReason: "Fixed $1.00",
      preview: true,
      cashInitialUsd: 200,
      market: {
        tokenId: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
      },
    });

    const result = generatePreviewAccountsReport({
      dataDir,
      outDir,
      startingCapitalUsd: 200,
    });

    expect(result.reports.map((r) => r.accountId)).toEqual(["acct-a"]);
    expect(result.rows).toHaveLength(1);
    expect(result.summary.accountCount).toBe(1);
  });

  it("summarizes selected accounts, ranks them, and writes JSON output", () => {
    store.recordCopySuccess({
      tradeKey: "copy-a",
      leaderId: "leader-a",
      tokenId: "token-a",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "Fixed $5.00",
      preview: true,
      cashInitialUsd: 200,
      market: {
        tokenId: "token-a",
        conditionId: "condition-a",
        slug: "market-a",
      },
    });
    store.settleCondition({
      leaderId: "leader-a",
      conditionId: "condition-a",
      winnerTokenIds: ["token-a"],
      cashInitialUsd: 200,
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "price-filtered-token",
      side: "BUY",
      reason: "price 0.02 < min 0.05",
      preview: true,
    });

    const generatedAt = new Date("2026-07-06T10:30:00.000Z");
    const result = generatePreviewAccountsReport({
      accounts: ["acct-a", "missing"],
      dataDir,
      outDir,
      startingCapitalUsd: 200,
      limit: 8,
      recentWindowMs: 60_000,
      nowMs: Date.now() + 1_000,
      generatedAt,
    });

    expect(existsSync(result.outPath)).toBe(true);
    expect(result.metadata).toMatchObject({
      recentWindowMs: 60_000,
      auditLogScope: "retained_audit_log",
      skipColumnsScope: "retained_audit_log",
      windowColumnsScope: "recent_window",
    });
    expect(formatPreviewReportScope(result.metadata)).toContain(
      "skips/top skips are retained audit-log counts"
    );
    expect(formatPreviewReportScope(result.metadata)).toContain("win* = last 1m");
    expect(result.rows[0]).toMatchObject({
      account: "acct-a",
      grade: "watch",
      liveReady: false,
      exists: true,
      cash: 205,
      cashDelta: 0,
      capitalDelta: 0,
      missingMarkets: 0,
      pending: 0,
      liveIntents: 0,
      winCopy: 1,
      winPriceSkips: 1,
      winUnmatched: 0,
    });
    expect(result.rankings[0]?.accountId).toBe("acct-a");
    expect(result.rankings[1]).toMatchObject({
      accountId: "missing",
      grade: "reject",
    });
    expect(result.evolution).toMatchObject({
      promoteAccounts: [],
      keepAccounts: [],
      retireAccounts: ["missing"],
      nextActiveAccounts: ["acct-a"],
    });
    expect(result.summary).toMatchObject({
      generatedAt: generatedAt.toISOString(),
      accountCount: 2,
      liveReadyCount: 0,
      evolution: {
        retireAccounts: ["missing"],
        nextActiveCount: 1,
      },
    });
    expect(existsSync(result.summaryPath)).toBe(true);

    const written = JSON.parse(readFileSync(result.outPath, "utf8")) as {
      generatedAt: string;
      metadata: unknown;
      reports: unknown[];
      rankings: Array<{ liveReady?: boolean; liveBlockers?: string[] }>;
      summary?: {
        accountCount?: number;
        evolution?: { retireAccounts?: string[] };
      };
      evolution?: {
        keepAccounts?: string[];
        retireAccounts?: string[];
        nextActiveAccounts?: string[];
      };
    };
    expect(written.generatedAt).toBe(generatedAt.toISOString());
    expect(written.metadata).toMatchObject({
      recentWindowMs: 60_000,
      skipColumnsScope: "retained_audit_log",
    });
    expect(written.reports).toHaveLength(2);
    expect(written.rankings).toHaveLength(2);
    expect(written.rankings[0]).toMatchObject({
      liveReady: false,
      liveBlockers: expect.arrayContaining([
        "settled redeem count below live gate",
      ]),
    });
    expect(written.evolution).toMatchObject({
      keepAccounts: [],
      retireAccounts: ["missing"],
      nextActiveAccounts: ["acct-a"],
    });
    expect(written.summary).toMatchObject({
      accountCount: 2,
      evolution: { retireAccounts: ["missing"] },
    });

    const summaryLines = readFileSync(result.summaryPath, "utf8").trim().split("\n");
    expect(summaryLines).toHaveLength(1);
    const summaryLine = JSON.parse(summaryLines[0]!) as {
      generatedAt?: string;
      riskCounts?: { missingDb?: number };
    };
    expect(summaryLine.generatedAt).toBe(generatedAt.toISOString());
    expect(summaryLine.riskCounts?.missingDb).toBe(1);
  });

  it("uses per-account starting capital when accounts have mixed budgets", () => {
    const storeB = new StateStore(join(dataDir, "acct-b", "preview.db"));
    try {
      storeB.recordCopySuccess({
        tradeKey: "copy-b",
        leaderId: "leader-b",
        tokenId: "token-b",
        side: "BUY",
        filledShares: 10,
        price: 0.5,
        filledUsd: 5,
        auditReason: "Fixed $5.00",
        preview: true,
        cashInitialUsd: 500,
        market: {
          tokenId: "token-b",
          conditionId: "condition-b",
          slug: "market-b",
        },
      });

      const result = generatePreviewAccountsReport({
        accounts: ["acct-b"],
        dataDir,
        outDir,
        startingCapitalUsd: 200,
        startingCapitalByAccount: { "acct-b": 500 },
      });

      expect(result.rows[0]).toMatchObject({
        account: "acct-b",
        cash: 495,
        openCost: 5,
        capitalDelta: 0,
      });
      expect(result.reports[0]).toMatchObject({
        accountId: "acct-b",
        cashReplayDeltaUsd: 0,
        capitalDeltaUsd: 0,
      });
    } finally {
      storeB.close();
    }
  });

  it("separates active account summary from historical discovered accounts", () => {
    const storeB = new StateStore(join(dataDir, "acct-b", "preview.db"));
    try {
      store.recordCopySuccess({
        tradeKey: "copy-a",
        leaderId: "leader-a",
        tokenId: "token-a",
        side: "BUY",
        filledShares: 2,
        price: 0.5,
        filledUsd: 1,
        auditReason: "Fixed $1.00",
        preview: true,
        cashInitialUsd: 200,
      });
      storeB.recordCopySuccess({
        tradeKey: "copy-b",
        leaderId: "leader-b",
        tokenId: "token-b",
        side: "BUY",
        filledShares: 10,
        price: 0.5,
        filledUsd: 5,
        auditReason: "Fixed $5.00",
        preview: true,
        cashInitialUsd: 200,
      });

      const result = generatePreviewAccountsReport({
        dataDir,
        outDir,
        currentActiveAccounts: ["acct-a"],
      });

      expect(result.summary.accountCount).toBe(2);
      expect(result.active?.summary.accountCount).toBe(1);
      expect(result.active?.rows.map((row) => row.account)).toEqual(["acct-a"]);
      expect(result.active?.evolution.targetActiveCount).toBe(1);

      const written = JSON.parse(readFileSync(result.outPath, "utf8")) as {
        active?: {
          accountIds?: string[];
          summary?: { accountCount?: number };
          rows?: Array<{ account?: string }>;
        };
      };
      expect(written.active?.accountIds).toEqual(["acct-a"]);
      expect(written.active?.summary?.accountCount).toBe(1);
      expect(written.active?.rows?.map((row) => row.account)).toEqual(["acct-a"]);
    } finally {
      storeB.close();
    }
  });
});
