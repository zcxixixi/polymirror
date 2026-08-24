import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readPreviewAccountReport } from "../src/sim/preview-report.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
let dbPath: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-preview-report-"));
  dbPath = join(dir, "preview.db");
  store = new StateStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function startGuardedExperiment(accountId: string): string {
  const config = previewRuntimeConfig();
  config.app.global.copyPriceMode = "executable_guarded";
  const experiment = store.startOrResumeExperiment({
    accountId,
    candidateAddresses: config.app.leaders.map((leader) => leader.address!),
    config,
    gitSha: "git-native-slip",
    imageDigest: "image-native-slip",
    lockfileHash: "lock-native-slip",
    trustClass: "candidate",
  });
  store.ensureCopyPriceMode("executable_guarded");
  return experiment.experimentId;
}

function recordQuoteDecision(input: {
  sourceId: string;
  action: "COPY" | "SKIP";
  side: "BUY" | "SELL";
  requestedPrice: number;
  quoteBestPrice: number | null;
  quoteEvidence: null | {
    levels: Array<{ price: string; size: string }>;
    minOrderShares: number;
  };
  executablePrice: number | null;
  slippagePct: number | null;
  reason?: string;
  requestedShares?: number;
  exactTermsOverride?: Record<string, unknown>;
}): void {
  const requestedShares = input.requestedShares ?? 2;
  const occurrence = store.recordRawEventOccurrence({
    sourceId: input.sourceId,
    payload: {
      leaderId: "leader-native-slip",
      tokenId: `token-${input.sourceId}`,
      side: input.side,
      price: 0.5,
    },
    sourceTimestamp: Date.now(),
    observedTimestamp: Date.now(),
  });
  store.setDecisionObservationRefs([occurrence.observationRef]);
  store.audit({
    leaderId: "leader-native-slip",
    action: input.action,
    tokenId: `token-${input.sourceId}`,
    side: input.side,
    size: requestedShares,
    price: input.requestedPrice,
    leaderPrice: 0.5,
    executablePrice: input.executablePrice,
    slippagePct: input.slippagePct,
    reason: input.reason ?? (input.action === "COPY" ? "native quote copy" : "native quote skip"),
    preview: true,
    exactTerms: {
      requestedPrice: input.requestedPrice,
      requestedShares,
      quoteBestPrice: input.quoteBestPrice,
      quoteEvidence: input.quoteEvidence === null
        ? null
        : {
            ...input.quoteEvidence,
            tickSize: 0.01,
            feeRate: 0,
            feeExponent: 0,
          },
      ...input.exactTermsOverride,
    },
  });
  store.setDecisionObservationRefs([]);
}

describe("readPreviewAccountReport", () => {
  it("exposes active experiment provenance", () => {
    const config = previewRuntimeConfig();
    const experiment = store.startOrResumeExperiment({
      accountId: "candidate-a",
      candidateAddresses: config.app.leaders.map((leader) => leader.address!),
      config,
      gitSha: "git-report",
      imageDigest: "sha256:image-report",
      lockfileHash: "lock-report",
      trustClass: "candidate",
    }, 1000);

    const report = readPreviewAccountReport({
      accountId: "candidate-a",
      dbPath,
      copyPriceMode: "executable_guarded",
      startingCapitalUsd: 200,
    });

    expect(report.provenance).toEqual({
      experimentId: experiment.experimentId,
      configHash: experiment.configHash,
      gitSha: "git-report",
      imageDigest: "sha256:image-report",
      lockfileHash: "lock-report",
      schemaVersion: 10,
      trustClass: "candidate",
    });
  });

  it("reports source-to-first-observation latency percentiles with seconds normalized to ms", () => {
    const nowMs = 1_800_000_010_000;
    startGuardedExperiment("latency-valid");
    const rows = [
      { sourceId: "latency-1s", sourceTimestamp: (nowMs - 1_000) / 1_000 },
      { sourceId: "latency-4s", sourceTimestamp: nowMs - 4_000 },
      { sourceId: "latency-9s", sourceTimestamp: (nowMs - 9_000) / 1_000 },
    ];
    for (const row of rows) {
      store.recordRawEventOccurrence({
        ...row,
        payload: { type: "TRADE", side: "BUY" },
        observedTimestamp: nowMs,
      });
    }
    store.recordRawEventOccurrence({
      sourceId: "latency-redeem",
      payload: { type: "REDEEM" },
      sourceTimestamp: nowMs - 50_000,
      observedTimestamp: nowMs,
    });

    const report = readPreviewAccountReport({
      accountId: "latency-valid",
      dbPath,
      nowMs,
    });

    expect(report.goalMetrics?.detectionLatency).toEqual({
      basis: "source_to_first_observation",
      experimentId: report.provenance?.experimentId,
      status: "valid",
      tradeEventCount: 3,
      sampleCount: 3,
      payloadParseFailureCount: 0,
      invalidTimestampCount: 0,
      futureTimestampCount: 0,
      p50Ms: 4_000,
      p90Ms: 9_000,
      p99Ms: 9_000,
      maxMs: 9_000,
      blockers: [],
    });
  });

  it("fails detection-latency evidence closed for invalid or future trade timestamps", () => {
    const nowMs = 1_800_000_010_000;
    startGuardedExperiment("latency-invalid");
    for (const row of [
      { sourceId: "valid", sourceTimestamp: nowMs - 1_000 },
      { sourceId: "invalid", sourceTimestamp: 0 },
      { sourceId: "future", sourceTimestamp: nowMs + 1_000 },
    ]) {
      store.recordRawEventOccurrence({
        ...row,
        payload: { type: "TRADE", side: "BUY" },
        observedTimestamp: nowMs,
      });
    }
    store.recordRawEventOccurrence({
      sourceId: "future-pair",
      payload: { type: "TRADE", side: "BUY" },
      sourceTimestamp: nowMs + 1_000,
      observedTimestamp: nowMs + 2_000,
    });

    expect(readPreviewAccountReport({
      accountId: "latency-invalid",
      dbPath,
      nowMs,
    }).goalMetrics?.detectionLatency).toMatchObject({
      status: "invalid",
      tradeEventCount: 4,
      sampleCount: 1,
      invalidTimestampCount: 1,
      futureTimestampCount: 2,
      p50Ms: 1_000,
      blockers: [
        "invalid source or observation timestamps",
        "future or source-after-observation timestamps",
      ],
    });
  });

  it("scopes detection latency to the current active experiment", () => {
    const nowMs = 1_800_000_010_000;
    startGuardedExperiment("latency-scoped");
    store.recordRawEventOccurrence({
      sourceId: "old-experiment-trade",
      payload: { type: "TRADE", side: "BUY" },
      sourceTimestamp: nowMs - 50_000,
      observedTimestamp: nowMs,
    });

    const nextConfig = previewRuntimeConfig();
    nextConfig.app.global.copyPriceMode = "executable_guarded";
    nextConfig.app.global.risk.maxOrderUsd += 1;
    const active = store.startOrResumeExperiment({
      accountId: "latency-scoped",
      candidateAddresses: nextConfig.app.leaders.map((leader) => leader.address!),
      config: nextConfig,
      gitSha: "git-latency-next",
      imageDigest: "image-latency-next",
      lockfileHash: "lock-latency-next",
      trustClass: "candidate",
    }, nowMs + 1);
    store.recordRawEventOccurrence({
      sourceId: "active-experiment-trade",
      payload: { type: "TRADE", side: "BUY" },
      sourceTimestamp: nowMs - 1_000,
      observedTimestamp: nowMs,
    });

    expect(readPreviewAccountReport({
      accountId: "latency-scoped",
      dbPath,
      nowMs,
    }).goalMetrics?.detectionLatency).toMatchObject({
      experimentId: active.experimentId,
      status: "valid",
      tradeEventCount: 1,
      sampleCount: 1,
      p50Ms: 1_000,
      p90Ms: 1_000,
      p99Ms: 1_000,
    });
  });

  it("does not expose a prepared experiment before batch finalization", () => {
    const config = previewRuntimeConfig();
    const base = store.startOrResumeExperiment({
      accountId: "candidate-a",
      candidateAddresses: ["0xaaa"],
      config,
      gitSha: "git-a",
      imageDigest: "image-a",
      lockfileHash: "a".repeat(64),
      trustClass: "verified",
    }, 1000);
    const changed = structuredClone(config);
    changed.app.global.risk.maxOrderUsd += 1;
    store.beginExperimentBatch();
    store.startOrResumeExperiment({
      accountId: "candidate-a",
      candidateAddresses: ["0xaaa"],
      config: changed,
      gitSha: "git-b",
      imageDigest: "image-b",
      lockfileHash: "b".repeat(64),
      trustClass: "verified",
    }, 2000);
    store.commitExperimentBatch();
    const report = readPreviewAccountReport({ accountId: "candidate-a", dbPath });
    expect(report.provenance?.experimentId).toBe(base.experimentId);
  });

  it("keeps a fresh zero-sample strategy in collecting state", () => {
    const report = readPreviewAccountReport({
      accountId: "fresh-goal",
      dbPath,
      copyPriceMode: "executable_guarded",
      startingCapitalUsd: 200,
    });

    expect(report.stabilityGoal).toMatchObject({
      passed: false,
      status: "collecting",
    });
    expect(report.performance.winningConditionConcentration).toEqual({
      evidenceStatus: "no_sample",
      redeemCount: 0,
      conditionMappedRedeemCount: 0,
      conditionMappingMissingCount: 0,
      conditionMappingCoveragePct: 0,
      pnlParsedRedeemCount: 0,
      pnlParseFailureCount: 0,
      pnlParseCoveragePct: 0,
      settledConditionCount: 0,
      winningConditionCount: 0,
      netConditionPnlUsd: null,
      grossWinningConditionPnlUsd: null,
      top1WinningConditionGrossProfitSharePct: null,
      top2WinningConditionGrossProfitSharePct: null,
      top3WinningConditionGrossProfitSharePct: null,
      netPnlAfterRemovingTop1WinningConditionUsd: null,
      netPnlAfterRemovingTop2WinningConditionsUsd: null,
      netPnlAfterRemovingTop3WinningConditionsUsd: null,
    });
  });

  it("keeps the stability copy-path gate on a fixed 14-day window", () => {
    const nowMs = Date.now() + 1_000;
    const dayMs = 24 * 60 * 60_000;

    store.recordCopySuccess({
      tradeKey: "goal-path-buy",
      leaderId: "leader-a",
      tokenId: "goal-path-token",
      side: "BUY",
      filledShares: 2,
      price: 0.5,
      filledUsd: 1,
      auditReason: "Fixed $1.00",
      preview: true,
      cashInitialUsd: 200,
      market: {
        tokenId: "goal-path-token",
        conditionId: "goal-path-condition",
        slug: "goal-path-market",
        title: "Goal path market",
      },
    });
    store.recordCopySuccess({
      tradeKey: "goal-path-sell",
      leaderId: "leader-a",
      tokenId: "goal-path-token",
      side: "SELL",
      filledShares: 1,
      price: 0.6,
      filledUsd: 0.6,
      auditReason: "Fixed $0.60",
      preview: true,
      cashInitialUsd: 200,
    });
    store.audit({
      leaderId: "leader-a",
      action: "REDEEM",
      tokenId: "goal-path-condition",
      side: "REDEEM",
      reason: "settled; pnl $0.10",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "DETECT",
      tokenId: "goal-path-unclassified-1",
      side: "BUY",
      size: 1,
      price: 0.5,
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "DETECT",
      tokenId: "goal-path-unclassified-2",
      side: "BUY",
      size: 1,
      price: 0.5,
      preview: true,
    });

    const db = new Database(dbPath);
    try {
      db.prepare("UPDATE audit_log SET ts = ? WHERE token_id LIKE 'goal-path-unclassified-%'").run(
        nowMs - 2 * dayMs
      );
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "fixed-goal-path-window",
      dbPath,
      startingCapitalUsd: 200,
      recentWindowMs: 60 * 60_000,
      nowMs,
    });

    expect(report.copyQuality.copyGap.buy.unclassified).toBe(0);
    expect(report.stabilityGoal?.failedChecks).toContain("copy_path");
  });

  it("keeps the stability error gate on a fixed six-hour window", () => {
    const nowMs = Date.now() + 1_000;
    store.audit({
      leaderId: "leader-a",
      action: "ERROR",
      tokenId: "fixed-error-window",
      side: "REDEEM",
      reason: "temporary upstream timeout",
      preview: true,
    });

    const db = new Database(dbPath);
    try {
      db.prepare("UPDATE audit_log SET ts = ? WHERE token_id = ?").run(
        nowMs - 2 * 60 * 60_000,
        "fixed-error-window"
      );
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "fixed-error-window",
      dbPath,
      startingCapitalUsd: 200,
      recentWindowMs: 60 * 60_000,
      nowMs,
    });

    expect(report.recentWindow?.errorCount).toBe(0);
    expect(report.stabilityGoal?.checks).toContainEqual(
      expect.objectContaining({ key: "errors", actual: 1, passed: false })
    );
  });

  it("summarizes cash, open positions, realized pnl, errors, and skip reasons", () => {
    store.recordCopySuccess({
      tradeKey: "buy-a",
      leaderId: "leader-a",
      tokenId: "winner-token",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "Fixed $5.00",
      preview: true,
      cashInitialUsd: 20,
      market: {
        tokenId: "winner-token",
        conditionId: "condition-a",
        slug: "market-a",
        title: "Market A",
        outcome: "Yes",
      },
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "skip-token",
      side: "BUY",
      reason: "price 0.01 < min 0.05",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "cash-token",
      side: "BUY",
      reason: "preview cash $0.00 < order $1.00",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "cap-token",
      side: "BUY",
      reason: "Fixed $1.00; max position reached",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "market-token",
      side: "BUY",
      reason: "max open markets 15",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "condition-token",
      side: "REDEEM",
      reason: "no local preview position for condition",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "ERROR",
      tokenId: "bad-token",
      side: "BUY",
      reason: "bad state",
      preview: true,
    });
    store.settleCondition({
      leaderId: "leader-a",
      conditionId: "condition-a",
      winnerTokenIds: ["winner-token"],
      cashInitialUsd: 20,
      preview: true,
    });

    const report = readPreviewAccountReport({
      accountId: "acct-a",
      dbPath,
      startingCapitalUsd: 20,
    });

    expect(report.accountId).toBe("acct-a");
    expect(report.cashUsd).toBe(25);
    expect(report.openCostUsd).toBe(0);
    expect(report.realizedPnlUsd).toBe(5);
    expect(report.copyCount).toBe(1);
    expect(report.redeemCount).toBe(1);
    expect(report.errorCount).toBe(1);
    expect(report.priceFilteredSkipCount).toBe(1);
    expect(report.cashStarvedSkipCount).toBe(1);
    expect(report.positionCapSkipCount).toBe(1);
    expect(report.maxOpenMarketSkipCount).toBe(1);
    expect(report.noLocalRedeemSkipCount).toBe(1);
    expect(report.unmatchedRedeemSkipCount).toBe(0);
    expect(report.skipReasons.find((r) => r.reason === "price 0.01 < min 0.05")).toEqual({
      reason: "price 0.01 < min 0.05",
      count: 1,
    });
    expect(report.recentRedeems[0]?.payoutUsd).toBe(10);
    expect(report.recentErrors[0]?.reason).toBe("bad state");
  });

  it("explains copy quality with buy/sell coverage and profit attribution", () => {
    for (let i = 0; i < 4; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: "winner-token",
        side: "BUY",
        size: 10,
        price: 0.5,
        preview: true,
      });
    }
    for (let i = 0; i < 5; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: "winner-token",
        side: "SELL",
        size: 1,
        price: 0.7,
        preview: true,
      });
    }
    store.recordCopySuccess({
      tradeKey: "quality-buy",
      leaderId: "leader-a",
      tokenId: "winner-token",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "Fixed $5.00",
      preview: true,
      cashInitialUsd: 20,
      market: {
        tokenId: "winner-token",
        conditionId: "quality-condition",
        slug: "quality-market",
        title: "Quality market",
        outcome: "Yes",
      },
    });
    store.recordCopySuccess({
      tradeKey: "quality-sell",
      leaderId: "leader-a",
      tokenId: "winner-token",
      side: "SELL",
      filledShares: 2,
      price: 0.75,
      filledUsd: 1.5,
      auditReason: "Fixed $1.50",
      preview: true,
      cashInitialUsd: 20,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "winner-token",
      side: "SELL",
      reason: "SELL held=0 need=2",
      preview: true,
    });
    store.settleCondition({
      leaderId: "leader-a",
      conditionId: "quality-condition",
      winnerTokenIds: ["winner-token"],
      cashInitialUsd: 20,
      preview: true,
    });

    const report = readPreviewAccountReport({
      accountId: "quality",
      dbPath,
      startingCapitalUsd: 20,
    });

    expect(report.copyQuality).toMatchObject({
      detected: { buy: 4, sell: 5, redeem: 0, totalTrades: 9 },
      copied: { buy: 1, sell: 1, totalTrades: 2 },
      coverage: {
        buyPct: 25,
        sellPct: 20,
        tradePct: 22.22,
      },
      redeem: {
        count: 1,
        payoutUsd: 8,
        pnlUsd: 4,
      },
      skips: {
        sellWithoutLocal: 1,
      },
      primaryIssue: {
        code: "not_selling",
        severity: "warning",
      },
    });
    expect(report.copyQuality.marketPnl[0]).toMatchObject({
      conditionId: "quality-condition",
      title: "Quality market",
      slug: "quality-market",
      payoutUsd: 8,
      pnlUsd: 4,
      redeemCount: 1,
    });
  });

  it("reports risk and stability metrics from settled pnl sequence", () => {
    const db = new Database(dbPath);
    try {
      const base = 1_700_000_000_000;
      const rows = [
        { offset: 0, pnl: 4, payout: 9 },
        { offset: 1_000, pnl: -2, payout: 0 },
        { offset: 2_000, pnl: 3, payout: 6 },
        { offset: 3_000, pnl: -1, payout: 0 },
        { offset: 4_000, pnl: 6, payout: 11 },
      ];
      for (const row of rows) {
        db.prepare(
          `INSERT INTO token_markets (token_id, condition_id, title, slug, outcome)
           VALUES (?, ?, NULL, NULL, 'Yes')`
        ).run(`condition-${row.offset}`, `condition-${row.offset}`);
        db.prepare(
          `INSERT INTO audit_log (ts, leader_id, action, token_id, side, size, price, reason, preview)
           VALUES (?, 'leader-a', 'REDEEM', ?, 'REDEEM', ?, 1, ?, 1)`
        ).run(
          base + row.offset,
          `condition-${row.offset}`,
          row.payout,
          `settled 1 position(s); pnl $${row.pnl.toFixed(2)}`
        );
      }
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "metrics",
      dbPath,
      startingCapitalUsd: 100,
      recentWindowMs: 1_500,
      nowMs: 1_700_000_005_000,
    });

    expect(report.performance).toMatchObject({
      tradeCount: 5,
      winCount: 3,
      lossCount: 2,
      totalPnlUsd: 10,
      winRatePct: 60,
      profitFactor: 4.33,
      payoffRatio: 2.89,
      maxDrawdownUsd: 2,
      maxDrawdownPct: 2,
      largestWinContributionPct: 60,
      top3WinContributionPct: 100,
      dependencyIssue: "concentrated",
      recent: {
        tradeCount: 1,
        pnlUsd: 6,
        winRatePct: 100,
      },
    });
    expect(report.performance.sharpeRatio).toBeGreaterThan(1);
    expect(report.performance.equityStabilityPct).toBeGreaterThan(60);
    expect(report.profitabilityGate).toMatchObject({
      grade: "reject",
      passed: false,
      sample: {
        settledTrades: 5,
        copyTrades: 0,
      },
    });
    expect(report.profitabilityGate.blockers).toContain(
      "accounting diagnostics not clean"
    );
  });

  it("aggregates duplicate redeems and multiple tokens by unique condition", () => {
    const db = new Database(dbPath);
    try {
      const tokenMarkets = [
        ["alpha-yes", "condition-alpha"],
        ["alpha-no", "condition-alpha"],
        ["beta-yes", "condition-beta"],
        ["gamma-yes", "condition-gamma"],
      ];
      for (const [tokenId, conditionId] of tokenMarkets) {
        db.prepare(
          `INSERT INTO token_markets (token_id, condition_id, title, slug, outcome)
           VALUES (?, ?, NULL, NULL, 'Yes')`
        ).run(tokenId, conditionId);
      }
      const redeems = [
        ["alpha-yes", 8],
        ["alpha-no", -2],
        ["alpha-yes", 1],
        ["beta-yes", 3],
        ["gamma-yes", -4],
      ] as const;
      for (const [index, [tokenId, pnlUsd]] of redeems.entries()) {
        db.prepare(
          `INSERT INTO audit_log (ts, leader_id, action, token_id, side, size, price, reason, preview)
           VALUES (?, 'leader-a', 'REDEEM', ?, 'REDEEM', 0, 1, ?, 1)`
        ).run(index + 1, tokenId, `settled; pnl $${pnlUsd.toFixed(2)}`);
      }
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "condition-concentration",
      dbPath,
      startingCapitalUsd: 100,
    });

    expect(report.performance.winningConditionConcentration).toEqual({
      evidenceStatus: "complete",
      redeemCount: 5,
      conditionMappedRedeemCount: 5,
      conditionMappingMissingCount: 0,
      conditionMappingCoveragePct: 100,
      pnlParsedRedeemCount: 5,
      pnlParseFailureCount: 0,
      pnlParseCoveragePct: 100,
      settledConditionCount: 3,
      winningConditionCount: 2,
      netConditionPnlUsd: 6,
      grossWinningConditionPnlUsd: 10,
      top1WinningConditionGrossProfitSharePct: 70,
      top2WinningConditionGrossProfitSharePct: 100,
      top3WinningConditionGrossProfitSharePct: 100,
      netPnlAfterRemovingTop1WinningConditionUsd: -1,
      netPnlAfterRemovingTop2WinningConditionsUsd: -4,
      netPnlAfterRemovingTop3WinningConditionsUsd: -4,
    });
    expect(report.performance).toMatchObject({
      largestWinContributionPct: 100,
      top3WinContributionPct: 100,
      dependencyIssue: "concentrated",
    });
    expect(report.goalMetrics).toMatchObject({
      settledMarketCount: 3,
      copyPnlUsd: 6,
    });
  });

  it("reports complete zero-gross-win concentration evidence for a losing sample", () => {
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO token_markets (token_id, condition_id, title, slug, outcome)
         VALUES ('loser-token', 'loser-condition', NULL, NULL, 'Yes')`
      ).run();
      db.prepare(
        `INSERT INTO audit_log (ts, leader_id, action, token_id, side, size, price, reason, preview)
         VALUES (1, 'leader-a', 'REDEEM', 'loser-token', 'REDEEM', 0, 1,
                 'settled; pnl -$5.00', 1)`
      ).run();
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "losing-concentration",
      dbPath,
      startingCapitalUsd: 100,
    });

    expect(report.performance.winningConditionConcentration).toMatchObject({
      evidenceStatus: "complete",
      netConditionPnlUsd: -5,
      grossWinningConditionPnlUsd: 0,
      top1WinningConditionGrossProfitSharePct: 0,
      top2WinningConditionGrossProfitSharePct: 0,
      top3WinningConditionGrossProfitSharePct: 0,
      netPnlAfterRemovingTop1WinningConditionUsd: -5,
      netPnlAfterRemovingTop2WinningConditionsUsd: -5,
      netPnlAfterRemovingTop3WinningConditionsUsd: -5,
    });
  });

  it("fails concentration gates closed when condition mapping or pnl parsing is incomplete", () => {
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO token_markets (token_id, condition_id, title, slug, outcome)
         VALUES ('mapped-valid', 'condition-valid', NULL, NULL, 'Yes'),
                ('mapped-invalid', 'condition-invalid', NULL, NULL, 'No')`
      ).run();
      const rows = [
        ["mapped-valid", "settled; pnl $1.00"],
        ["unmapped-token", "settled; pnl $2.00"],
        ["mapped-invalid", "settled without pnl evidence"],
      ] as const;
      for (const [index, [tokenId, reason]] of rows.entries()) {
        db.prepare(
          `INSERT INTO audit_log (ts, leader_id, action, token_id, side, size, price, reason, preview)
           VALUES (?, 'leader-a', 'REDEEM', ?, 'REDEEM', 0, 1, ?, 1)`
        ).run(index + 1, tokenId, reason);
      }
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "incomplete-concentration",
      dbPath,
      startingCapitalUsd: 100,
    });

    expect(report.performance.winningConditionConcentration).toMatchObject({
      evidenceStatus: "incomplete",
      redeemCount: 3,
      conditionMappedRedeemCount: 2,
      conditionMappingMissingCount: 1,
      conditionMappingCoveragePct: 66.67,
      pnlParsedRedeemCount: 2,
      pnlParseFailureCount: 1,
      pnlParseCoveragePct: 66.67,
      netConditionPnlUsd: null,
      grossWinningConditionPnlUsd: null,
      top1WinningConditionGrossProfitSharePct: null,
      netPnlAfterRemovingTop3WinningConditionsUsd: null,
    });
    expect(report.performance.dependencyIssue).toBe("insufficient_data");
    expect(report.profitabilityGate?.blockers).toEqual(
      expect.arrayContaining([
        "redeem condition mapping coverage below 100%",
        "redeem pnl parse coverage below 100%",
      ])
    );
    expect(report.stabilityGoal).toMatchObject({
      passed: false,
      status: "not_qualified",
      failedChecks: expect.arrayContaining([
        "redeem_condition_mapping_coverage",
        "redeem_pnl_parse_coverage",
      ]),
    });
  });

  it("reports the exact time-window and recent-20 metrics used by the stability goal", () => {
    const nowMs = 1_800_000_000_000;
    const dayMs = 24 * 60 * 60_000;
    const db = new Database(dbPath);
    try {
      for (let index = 0; index < 21; index++) {
        const ageMs =
          index === 0
            ? 15 * dayMs
            : Math.floor(((20 - index) * 13 * dayMs) / 19);
        const ts = nowMs - ageMs;
        const pnl = index === 0 ? -5 : index % 5 === 1 ? -0.25 : 1;
        const tokenId = `goal-token-${index}`;
        const conditionId = `goal-condition-${index}`;

        db.prepare(
          `INSERT INTO token_markets (token_id, condition_id, title, slug, outcome)
           VALUES (?, ?, ?, ?, 'Yes')`
        ).run(tokenId, conditionId, `Goal market ${index}`, `goal-market-${index}`);
        db.prepare(
          `INSERT INTO audit_log (ts, leader_id, action, token_id, side, size, price, reason, preview)
           VALUES (?, 'leader-a', 'COPY', ?, 'BUY', 10, 0.5, 'Fixed $5.00', 1)`
        ).run(ts, tokenId);
        db.prepare(
          `INSERT INTO audit_log (ts, leader_id, action, token_id, side, size, price, reason, preview)
           VALUES (?, 'leader-a', 'REDEEM', ?, 'REDEEM', 1, 1, ?, 1)`
        ).run(ts + 1, conditionId, `settled 1 position(s); pnl $${pnl.toFixed(2)}`);
      }
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "goal-metrics",
      dbPath,
      startingCapitalUsd: 200,
      nowMs,
    });

    expect(report.goalMetrics).toMatchObject({
      observationDays: 15,
      settledMarketCount: 21,
      copyPnlUsd: 10,
      grossCopyVolumeUsd: 105,
      pnlVolumePct: 9.52,
      overall: {
        marketCount: 21,
        pnlUsd: 10,
        winRatePct: 76.19,
        profitFactor: 2.67,
      },
      recent20: {
        marketCount: 20,
        pnlUsd: 15,
        winRatePct: 80,
        profitFactor: 16,
      },
      windows: {
        h24: { pnlUsd: 2 },
        d7: { pnlUsd: 8.5 },
        d14: { pnlUsd: 15 },
      },
    });
  });

  it("separates poll-time BUY/SELL and rejected high-slippage quotes from simulated fills", () => {
    startGuardedExperiment("native-slip-separated");
    recordQuoteDecision({
      sourceId: "buy-copy",
      action: "COPY",
      side: "BUY",
      requestedPrice: 0.52,
      quoteBestPrice: 0.51,
      quoteEvidence: { levels: [{ price: "0.51", size: "10" }], minOrderShares: 1 },
      executablePrice: 0.52,
      slippagePct: 4,
    });
    recordQuoteDecision({
      sourceId: "sell-copy",
      action: "COPY",
      side: "SELL",
      requestedPrice: 0.48,
      quoteBestPrice: 0.49,
      quoteEvidence: { levels: [{ price: "0.49", size: "10" }], minOrderShares: 1 },
      executablePrice: 0.48,
      slippagePct: 4,
    });
    recordQuoteDecision({
      sourceId: "high-slip-skip",
      action: "SKIP",
      side: "BUY",
      requestedPrice: 0.52,
      quoteBestPrice: 0.7,
      quoteEvidence: { levels: [{ price: "0.70", size: "10" }], minOrderShares: 1 },
      executablePrice: 0.7,
      slippagePct: 40,
      reason: "slippage 0.2000 > 0.02",
    });

    const report = readPreviewAccountReport({
      accountId: "native-slip-separated",
      dbPath,
      nowMs: Date.now() + 1_000,
    });

    expect(report.goalMetrics?.pollTimeExecutableQuoteSlippage).toMatchObject({
      basis: "poll_time_executable_order_book_quote",
      status: "valid",
      attemptCount: 3,
      executedCopyCount: 2,
      rejectedSkipCount: 1,
      decisionLinkedCount: 3,
      decisionLinkCoveragePct: 100,
      unavailableCount: 0,
      unfillableCount: 0,
      belowMinOrderCount: 0,
      sampleCount: 3,
      totalNotionalUsd: 3,
      sampledNotionalUsd: 3,
      coveragePct: 100,
      lossPct: 14.67,
      blockers: [],
    });
    expect(report.goalMetrics?.simulatedLimitSlippage).toMatchObject({
      basis: "preview_guarded_limit_full_fill",
      isRealizedFill: false,
      status: "valid",
      copyCount: 2,
      sampleCount: 2,
      coveragePct: 100,
      lossPct: 4,
    });
    expect(report.goalMetrics?.slippage).toMatchObject({
      basis: "preview_guarded_limit_full_fill",
      isRealizedFill: false,
    });
  });

  it("samples full-book depth beyond the guard and classifies true gaps without zero slippage", () => {
    startGuardedExperiment("native-slip-coverage");
    recordQuoteDecision({
      sourceId: "guarded-depth-skip",
      action: "SKIP",
      side: "BUY",
      requestedPrice: 0.52,
      quoteBestPrice: 0.51,
      quoteEvidence: {
        levels: [
          { price: "0.51", size: "0.5" },
          { price: "0.70", size: "10" },
        ],
        minOrderShares: 1,
      },
      executablePrice: 0.51,
      slippagePct: 2,
      reason: "executable depth 0.5 < 2 shares",
    });
    recordQuoteDecision({
      sourceId: "true-depth-skip",
      action: "SKIP",
      side: "BUY",
      requestedPrice: 0.52,
      quoteBestPrice: 0.51,
      quoteEvidence: { levels: [{ price: "0.51", size: "0.5" }], minOrderShares: 1 },
      executablePrice: 0.51,
      slippagePct: 2,
      reason: "executable depth 0.5 < 2 shares",
    });
    recordQuoteDecision({
      sourceId: "minimum-skip",
      action: "SKIP",
      side: "BUY",
      requestedPrice: 0.52,
      quoteBestPrice: 0.51,
      quoteEvidence: { levels: [{ price: "0.51", size: "10" }], minOrderShares: 5 },
      executablePrice: 0.51,
      slippagePct: 2,
      reason: "market min order 5 > 2 shares",
    });
    recordQuoteDecision({
      sourceId: "missing-snapshot",
      action: "SKIP",
      side: "BUY",
      requestedPrice: 0.52,
      quoteBestPrice: null,
      quoteEvidence: null,
      executablePrice: null,
      slippagePct: null,
      reason: "executable price unavailable",
    });

    const quote = readPreviewAccountReport({
      accountId: "native-slip-coverage",
      dbPath,
    }).goalMetrics?.pollTimeExecutableQuoteSlippage;

    expect(quote).toMatchObject({
      status: "insufficient_coverage",
      attemptCount: 4,
      decisionLinkCoveragePct: 100,
      unavailableCount: 1,
      unfillableCount: 1,
      belowMinOrderCount: 1,
      sampleCount: 1,
      totalNotionalUsd: 4,
      sampledNotionalUsd: 1,
      coveragePct: 25,
      lossPct: 30.5,
      blockers: [],
    });
  });

  it("fails closed when immutable exact terms differ from audit quote fields", () => {
    startGuardedExperiment("native-slip-field-mismatch");
    recordQuoteDecision({
      sourceId: "tampered-fields",
      action: "COPY",
      side: "BUY",
      requestedPrice: 0.52,
      quoteBestPrice: 0.51,
      quoteEvidence: { levels: [{ price: "0.51", size: "10" }], minOrderShares: 1 },
      executablePrice: 0.52,
      slippagePct: 4,
      reason: "audit quote copy",
      exactTermsOverride: {
        requestedPrice: 0.53,
        reason: "tampered reason",
        executablePrice: null,
        slippagePct: null,
      },
    });

    const goal = readPreviewAccountReport({
      accountId: "native-slip-field-mismatch",
      dbPath,
    }).goalMetrics!;
    expect(goal.pollTimeExecutableQuoteSlippage).toMatchObject({
      status: "invalid",
      attemptCount: 1,
      decisionLinkCoveragePct: 100,
      fieldMismatchCount: 1,
      blockers: expect.arrayContaining([
        "quote-stage exact terms fields mismatch audit",
      ]),
    });
    expect(goal.simulatedLimitSlippage).toMatchObject({
      status: "invalid",
      copyCount: 1,
      fieldMismatchCount: 1,
    });
  });

  it("fails native quote evidence closed on orphan decisions and quote recomputation mismatch", () => {
    const experimentId = startGuardedExperiment("native-slip-invalid");
    recordQuoteDecision({
      sourceId: "mismatch-copy",
      action: "COPY",
      side: "BUY",
      requestedPrice: 0.52,
      quoteBestPrice: 0.6,
      quoteEvidence: { levels: [{ price: "0.51", size: "10" }], minOrderShares: 1 },
      executablePrice: 0.52,
      slippagePct: 4,
    });
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO audit_log
         (ts, leader_id, action, token_id, side, size, price, leader_price,
          executable_price, slippage_pct, reason, preview, experiment_id, decision_id)
         VALUES (?, 'leader-native-slip', 'COPY', 'token-orphan', 'BUY', 2, 0.52,
                 0.5, 0.52, 4, 'orphan quote copy', 1, ?, NULL)`
      ).run(Date.now(), experimentId);
    } finally {
      db.close();
    }

    const goal = readPreviewAccountReport({
      accountId: "native-slip-invalid",
      dbPath,
    }).goalMetrics!;

    expect(goal.pollTimeExecutableQuoteSlippage).toMatchObject({
      status: "invalid",
      attemptCount: 2,
      decisionLinkMissingCount: 1,
      decisionLinkCoveragePct: 50,
      quoteEvidenceMismatchCount: 1,
      blockers: expect.arrayContaining([
        "quote-stage decision link coverage below 100%",
        "quote-stage order-book quote recomputation mismatch",
      ]),
    });
    expect(goal.simulatedLimitSlippage).toMatchObject({
      status: "invalid",
      copyCount: 2,
      decisionLinkMissingCount: 1,
      quoteEvidenceMismatchCount: 1,
    });
    expect(readPreviewAccountReport({
      accountId: "native-slip-invalid",
      dbPath,
    }).stabilityGoal).toMatchObject({
      passed: false,
      status: "not_qualified",
      failedChecks: expect.arrayContaining(["poll_time_quote_integrity"]),
    });
  });

  it("fails native quote evidence closed on decision action and experiment mismatch", () => {
    startGuardedExperiment("native-slip-link-mismatch");
    const oldOccurrence = store.recordRawEventOccurrence({
      sourceId: "old-skip",
      payload: { sourceId: "old-skip", side: "BUY", price: 0.5 },
      sourceTimestamp: Date.now(),
      observedTimestamp: Date.now(),
    });
    const oldDecisionId = store.recordDecision({
      rawEventId: oldOccurrence.rawEvent.rawEventId,
      action: "SKIP",
      reasonCode: "policy_skip",
      observationRefs: [oldOccurrence.observationRef],
      exactTerms: {
        leaderId: "leader-native-slip",
        tokenId: "token-old-skip",
        side: "BUY",
        size: 2,
        price: 0.52,
        leaderPrice: 0.5,
        executablePrice: 0.52,
        slippagePct: 4,
        feeUsd: 0,
        reason: "old skip",
        preview: true,
        requestedPrice: 0.52,
        requestedShares: 2,
        quoteBestPrice: 0.51,
        quoteEvidence: {
          levels: [{ price: "0.51", size: "10" }],
          tickSize: 0.01,
          minOrderShares: 1,
          feeRate: 0,
          feeExponent: 0,
        },
      },
    }).decisionId;

    const config = previewRuntimeConfig();
    config.app.global.copyPriceMode = "executable_guarded";
    config.app.global.risk.maxOrderUsd += 1;
    const active = store.startOrResumeExperiment({
      accountId: "native-slip-link-mismatch",
      candidateAddresses: config.app.leaders.map((leader) => leader.address!),
      config,
      gitSha: "git-native-slip",
      imageDigest: "image-native-slip",
      lockfileHash: "lock-native-slip",
      trustClass: "candidate",
    });
    store.ensureCopyPriceMode("executable_guarded");

    const activeDb = new Database(dbPath);
    try {
      activeDb.prepare(
        `INSERT INTO audit_log
         (ts, leader_id, action, token_id, side, size, price, leader_price,
          executable_price, slippage_pct, reason, preview, experiment_id, decision_id)
         VALUES (?, 'leader-native-slip', 'COPY', 'token-old-skip', 'BUY', 2, 0.52,
                 0.5, 0.52, 4, 'cross-experiment action mismatch', 1, ?, ?)`
      ).run(Date.now(), active.experimentId, oldDecisionId);
    } finally {
      activeDb.close();
    }

    expect(readPreviewAccountReport({
      accountId: "native-slip-link-mismatch",
      dbPath,
    }).goalMetrics?.pollTimeExecutableQuoteSlippage).toMatchObject({
      status: "invalid",
      attemptCount: 1,
      decisionLinkCoveragePct: 100,
      actionMismatchCount: 1,
      experimentMismatchCount: 1,
      blockers: expect.arrayContaining([
        "quote-stage decision action mismatch",
        "quote-stage decision experiment mismatch",
      ]),
    });
  });

  it("counts one aggregated quote decision once while preserving both observation links", () => {
    startGuardedExperiment("native-slip-aggregated");
    const refs = ["aggregate-a", "aggregate-b"].map((sourceId, index) =>
      store.recordRawEventOccurrence({
        sourceId,
        payload: { sourceId, side: "BUY", price: 0.5 },
        sourceTimestamp: 1_000 + index,
        observedTimestamp: 2_000 + index,
      }).observationRef
    );
    store.setDecisionObservationRefs(refs);
    store.audit({
      leaderId: "leader-native-slip",
      action: "COPY",
      tokenId: "token-aggregate",
      side: "BUY",
      size: 2,
      price: 0.52,
      leaderPrice: 0.5,
      executablePrice: 0.52,
      slippagePct: 4,
      reason: "aggregated quote copy",
      preview: true,
      exactTerms: {
        requestedPrice: 0.52,
        requestedShares: 2,
        quoteBestPrice: 0.51,
        quoteEvidence: {
          levels: [{ price: "0.51", size: "10" }],
          tickSize: 0.01,
          minOrderShares: 1,
          feeRate: 0,
          feeExponent: 0,
        },
      },
    });

    const report = readPreviewAccountReport({
      accountId: "native-slip-aggregated",
      dbPath,
    });
    const db = new Database(dbPath, { readonly: true });
    const linkCount = (
      db.prepare("SELECT COUNT(*) AS count FROM decision_observation_links").get() as { count: number }
    ).count;
    db.close();

    expect(linkCount).toBe(2);
    expect(report.goalMetrics?.pollTimeExecutableQuoteSlippage).toMatchObject({
      status: "valid",
      attemptCount: 1,
      sampleCount: 1,
      decisionLinkedCount: 1,
      coveragePct: 100,
      lossPct: 2,
    });
  });

  it("reports volume-weighted slippage and refuses to treat missing quotes as zero", () => {
    const nowMs = 1_800_000_000_000;
    const db = new Database(dbPath);
    try {
      const rows = [
        { token: "slip-buy", condition: "slip-condition-buy", side: "BUY", size: 10, slip: 10 },
        { token: "slip-sell", condition: "slip-condition-sell", side: "SELL", size: 10, slip: 10 },
        { token: "slip-missing", condition: "slip-condition-missing", side: "BUY", size: 20, slip: null },
      ] as const;
      for (const [index, row] of rows.entries()) {
        db.prepare(
          `INSERT INTO token_markets (token_id, condition_id, title, slug, outcome)
           VALUES (?, ?, ?, ?, 'Yes')`
        ).run(row.token, row.condition, row.condition, row.condition);
        db.prepare(
          `INSERT INTO audit_log
           (ts, leader_id, action, token_id, side, size, price, leader_price,
            executable_price, slippage_pct, reason, preview)
           VALUES (?, 'leader-a', 'COPY', ?, ?, ?, 0.5, 0.5, ?, ?, 'observed', 1)`
        ).run(
          nowMs - (3 - index) * 60_000,
          row.token,
          row.side,
          row.size,
          row.slip === null ? null : row.side === "BUY" ? 0.55 : 0.45,
          row.slip
        );
        db.prepare(
          `INSERT INTO audit_log (ts, leader_id, action, token_id, side, reason, preview)
           VALUES (?, 'leader-a', 'REDEEM', ?, 'REDEEM', 'settled; pnl $1.00', 1)`
        ).run(nowMs - (3 - index) * 30_000, row.condition);
      }
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "slippage-metrics",
      dbPath,
      startingCapitalUsd: 200,
      nowMs,
    });

    expect(report.goalMetrics.slippage).toMatchObject({
      copyCount: 3,
      sampleCount: 2,
      totalNotionalUsd: 20,
      sampledNotionalUsd: 10,
      coveragePct: 50,
      lossPct: 10,
    });
    expect(report.goalMetrics.recent20).toMatchObject({
      slippageSampleCount: 2,
      slippageCoveragePct: 50,
      slippageLossPct: 10,
    });
    expect(report.stabilityGoal).toMatchObject({
      passed: false,
      failedChecks: expect.arrayContaining([
        "slippage_observation_days",
        "redeem_sample",
        "settled_markets",
        "overall_slip_coverage",
      ]),
    });
  });

  it("parses common settled pnl audit formats without corrupting performance metrics", () => {
    store.close();
    const db = new Database(dbPath);
    try {
      const rows = [
        { token: "positive-comma", reason: "settled 1 position(s); pnl $1,234.56" },
        { token: "negative-prefix", reason: "settled 1 position(s); pnl -$12.34" },
        { token: "negative-after-dollar", reason: "settled 1 position(s); pnl $-5.66" },
      ];
      for (const row of rows) {
        db.prepare(
          `INSERT INTO audit_log (ts, leader_id, action, token_id, side, size, price, reason, preview)
           VALUES (1, 'leader-a', 'REDEEM', ?, 'REDEEM', 1, 1, ?, 1)`
        ).run(row.token, row.reason);
      }
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "pnl-formats",
      dbPath,
      startingCapitalUsd: 2_000,
    });

    expect(report.performance).toMatchObject({
      tradeCount: 3,
      winCount: 1,
      lossCount: 2,
      totalPnlUsd: 1216.56,
      grossProfitUsd: 1234.56,
      grossLossUsd: 18,
      largestWinUsd: 1234.56,
      largestLossUsd: -12.34,
      profitFactor: 68.59,
    });
  });

  it("classifies parameter filters and unsettled capital as explicit profit issues", () => {
    for (let i = 0; i < 8; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `filtered-${i}`,
        side: "BUY",
        size: 1,
        price: 0.02,
        preview: true,
      });
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `filtered-${i}`,
        side: "BUY",
        size: 1,
        price: 0.02,
        reason: "price 0.02 < min 0.05",
        preview: true,
      });
    }
    store.recordCopySuccess({
      tradeKey: "open-buy",
      leaderId: "leader-a",
      tokenId: "open-token",
      side: "BUY",
      filledShares: 20,
      price: 0.5,
      filledUsd: 10,
      auditReason: "Fixed $10.00",
      preview: true,
      cashInitialUsd: 20,
      market: {
        tokenId: "open-token",
        conditionId: "open-condition",
        slug: "open-market",
        title: "Open market",
      },
    });

    const report = readPreviewAccountReport({
      accountId: "filtered",
      dbPath,
      startingCapitalUsd: 20,
    });

    expect(report.copyQuality.primaryIssue).toMatchObject({
      code: "parameter_filtered",
      severity: "warning",
    });
    expect(report.copyQuality.skips.parameterFiltered).toBe(8);
    expect(report.copyQuality.open.costUsd).toBe(10);
    expect(report.copyQuality.notes).toEqual(
      expect.arrayContaining(["市场还没结算，当前盈利只按已结算口径"])
    );
  });

  it("classifies guarded execution skips as explained parameter filters", () => {
    const reasons = [
      "slippage 0.2000 > 0.02",
      "executable price unavailable",
      "executable depth 0.5 < 1.93 shares",
      "market min order 5 > 1.93 shares",
    ];
    reasons.forEach((reason, index) => {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `guarded-${index}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        preview: true,
      });
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `guarded-${index}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        reason,
        preview: true,
      });
    });

    const report = readPreviewAccountReport({
      accountId: "guarded-skips",
      dbPath,
      startingCapitalUsd: 200,
    });

    expect(report.copyQuality.skips.parameterFiltered).toBe(4);
    expect(report.copyQuality.copyGap.buy).toMatchObject({
      effectiveDetected: 4,
      copied: 0,
      unclassified: 0,
      explainedPct: 100,
      skipped: { parameterFiltered: 4, total: 4 },
    });
  });

  it("prioritizes risk-limit skips over parameter filters when risk limits dominate", () => {
    for (let i = 0; i < 20; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `risk-token-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        preview: true,
      });
    }
    for (let i = 0; i < 2; i++) {
      store.recordCopySuccess({
        tradeKey: `risk-copy-${i}`,
        leaderId: "leader-a",
        tokenId: `risk-token-${i}`,
        side: "BUY",
        filledShares: 2,
        price: 0.5,
        filledUsd: 1,
        auditReason: "Fixed $1.00",
        preview: true,
        cashInitialUsd: 200,
        market: {
          tokenId: `risk-token-${i}`,
          conditionId: `risk-condition-${i}`,
          slug: `risk-market-${i}`,
          title: `Risk market ${i}`,
        },
      });
    }
    for (let i = 0; i < 4; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `price-filter-${i}`,
        side: "BUY",
        size: 1,
        price: 0.02,
        reason: "price 0.02 < min 0.05",
        preview: true,
      });
    }
    for (let i = 0; i < 12; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `risk-blocked-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        reason: "max daily volume 50.00 reached",
        preview: true,
      });
    }

    const report = readPreviewAccountReport({
      accountId: "risk-limited",
      dbPath,
      startingCapitalUsd: 200,
    });

    expect(report.copyQuality.skips.parameterFiltered).toBe(4);
    expect(report.copyQuality.skips.exposureBlocked).toBe(12);
    expect(report.copyQuality.primaryIssue).toMatchObject({
      code: "risk_limited",
      severity: "warning",
    });
  });

  it("counts recent buy dedup skips as already-seen diagnostics", () => {
    for (let i = 0; i < 10; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `dedup-token-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        preview: true,
      });
    }
    store.recordCopySuccess({
      tradeKey: "dedup-copy",
      leaderId: "leader-a",
      tokenId: "dedup-token-0",
      side: "BUY",
      filledShares: 2,
      price: 0.5,
      filledUsd: 1,
      auditReason: "Fixed $1.00",
      preview: true,
      cashInitialUsd: 200,
      market: {
        tokenId: "dedup-token-0",
        conditionId: "dedup-condition",
        slug: "dedup-market",
        title: "Dedup market",
      },
    });
    for (let i = 0; i < 7; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `dedup-skip-${i}`,
        side: "BUY",
        reason: "recent buy dedup",
        preview: true,
      });
    }

    const report = readPreviewAccountReport({
      accountId: "dedup-heavy",
      dbPath,
      startingCapitalUsd: 200,
    });

    expect(report.copyQuality.skips.alreadySeen).toBe(7);
    expect(report.copyQuality.deduped).toMatchObject({
      buy: 7,
      sell: 0,
      totalTrades: 7,
    });
    expect(report.copyQuality.effectiveDetected).toMatchObject({
      buy: 3,
      sell: 0,
      totalTrades: 3,
    });
    expect(report.copyQuality.coverage.buyPct).toBe(10);
    expect(report.copyQuality.effectiveCoverage.buyPct).toBe(33.33);
    expect(report.copyQuality.notes).toEqual(
      expect.arrayContaining(["重复或已见交易已去重，不代表真实漏跟"])
    );
  });

  it("does not classify all-dedup buy detections as missing buys", () => {
    for (let i = 0; i < 10; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `all-dedup-token-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        preview: true,
      });
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `all-dedup-token-${i}`,
        side: "BUY",
        reason: "recent buy dedup",
        preview: true,
      });
    }

    const report = readPreviewAccountReport({
      accountId: "all-dedup",
      dbPath,
      startingCapitalUsd: 200,
    });

    expect(report.copyQuality.skips.alreadySeen).toBe(10);
    expect(report.copyQuality.effectiveDetected).toMatchObject({
      buy: 0,
      sell: 0,
      totalTrades: 0,
    });
    expect(report.copyQuality.copyGap.buy).toMatchObject({
      detected: 10,
      deduped: 10,
      effectiveDetected: 0,
      copied: 0,
      unclassified: 0,
      copyPct: 0,
      explainedPct: 0,
    });
    expect(report.copyQuality.primaryIssue.code).not.toBe("not_buying");
    expect(report.copyQuality.primaryIssue).toMatchObject({
      code: "no_data",
      severity: "info",
    });
  });

  it("explains effective buy copy gaps with side-aware skip buckets", () => {
    for (let i = 0; i < 10; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `gap-buy-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        preview: true,
      });
    }
    for (let i = 0; i < 2; i++) {
      store.recordCopySuccess({
        tradeKey: `gap-copy-${i}`,
        leaderId: "leader-a",
        tokenId: `gap-buy-${i}`,
        side: "BUY",
        filledShares: 2,
        price: 0.5,
        filledUsd: 1,
        auditReason: "Fixed $1.00",
        preview: true,
        cashInitialUsd: 200,
        market: {
          tokenId: `gap-buy-${i}`,
          conditionId: `gap-condition-${i}`,
          slug: `gap-market-${i}`,
          title: `Gap market ${i}`,
        },
      });
    }
    for (let i = 0; i < 2; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `gap-buy-${i + 2}`,
        side: "BUY",
        reason: "recent buy dedup",
        preview: true,
      });
    }
    for (let i = 0; i < 3; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `gap-buy-${i + 4}`,
        side: "BUY",
        reason: "price 0.02 < min 0.05",
        preview: true,
      });
    }
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "gap-buy-7",
      side: "BUY",
      reason: "preview cash $0.20 < order $1.00",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "gap-buy-8",
      side: "BUY",
      reason: "max daily volume 50.00 reached",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "gap-sell",
      side: "SELL",
      reason: "price 0.02 < min 0.05",
      preview: true,
    });

    const report = readPreviewAccountReport({
      accountId: "gap",
      dbPath,
      startingCapitalUsd: 200,
    });

    expect(report.copyQuality.copyGap.buy).toMatchObject({
      detected: 10,
      deduped: 2,
      effectiveDetected: 8,
      copied: 2,
      unclassified: 1,
      copyPct: 25,
      explainedPct: 87.5,
      skipped: {
        parameterFiltered: 3,
        cashBlocked: 1,
        exposureBlocked: 1,
        other: 0,
        total: 5,
      },
    });
    expect(report.copyQuality.copyGap.buy.topUnclassified).toEqual([
      {
        tokenId: "gap-buy-9",
        detected: 1,
        deduped: 0,
        copied: 0,
        skipped: 0,
        unclassified: 1,
        lastSkipReason: null,
      },
    ]);
    expect(report.copyQuality.copyGap.sell.skipped.parameterFiltered).toBe(1);
  });

  it("prioritizes cash-blocked skips when cash limits dominate low buy coverage", () => {
    for (let i = 0; i < 20; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `cash-token-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        preview: true,
      });
    }
    store.recordCopySuccess({
      tradeKey: "cash-copy",
      leaderId: "leader-a",
      tokenId: "cash-token-0",
      side: "BUY",
      filledShares: 2,
      price: 0.5,
      filledUsd: 1,
      auditReason: "Fixed $1.00",
      preview: true,
      cashInitialUsd: 200,
      market: {
        tokenId: "cash-token-0",
        conditionId: "cash-condition",
        slug: "cash-market",
        title: "Cash market",
      },
    });
    for (let i = 0; i < 10; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `cash-blocked-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        reason: "preview cash $0.20 < order $1.00",
        preview: true,
      });
    }
    for (let i = 0; i < 2; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "SKIP",
        tokenId: `cash-price-filter-${i}`,
        side: "BUY",
        size: 1,
        price: 0.02,
        reason: "price 0.02 < min 0.05",
        preview: true,
      });
    }

    const report = readPreviewAccountReport({
      accountId: "cash-limited",
      dbPath,
      startingCapitalUsd: 200,
    });

    expect(report.copyQuality.skips.cashBlocked).toBe(10);
    expect(report.copyQuality.primaryIssue).toMatchObject({
      code: "cash_occupied",
      severity: "warning",
    });
  });

  it("summarizes recent audit activity inside a requested window", () => {
    const now = Date.now();
    store.recordCopySuccess({
      tradeKey: "recent-buy",
      leaderId: "leader-a",
      tokenId: "recent-token",
      side: "BUY",
      filledShares: 2,
      price: 0.5,
      filledUsd: 1,
      auditReason: "recent copy",
      preview: true,
      cashInitialUsd: 20,
      market: {
        tokenId: "recent-token",
        conditionId: "recent-condition",
        slug: "recent-market",
        title: "Recent market",
        outcome: "Yes",
      },
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "recent-cash",
      side: "BUY",
      reason: "preview cash $0.20 < order $1.00",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "recent-cap",
      side: "BUY",
      reason: "Fixed $1.00; max position reached",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "recent-price-filter",
      side: "BUY",
      reason: "price 0.02 < min 0.05",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "ERROR",
      tokenId: "recent-error",
      side: "BUY",
      reason: "recent bad state",
      preview: true,
    });

    const db = new Database(dbPath);
    try {
      db.prepare(
        "INSERT INTO audit_log (ts, leader_id, action, token_id, side, reason, preview) VALUES (?, ?, ?, ?, ?, ?, 1)"
      ).run(
        now - 3_600_000,
        "leader-a",
        "SKIP",
        "old-cash",
        "BUY",
        "preview cash $0.10 < order $1.00"
      );
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "acct-window",
      dbPath,
      startingCapitalUsd: 20,
      recentWindowMs: 60_000,
      nowMs: now + 1_000,
    });

    expect(report.recentWindow).toMatchObject({
      sinceMs: now + 1_000 - 60_000,
      copyCount: 1,
      skipCount: 3,
      errorCount: 1,
      priceFilteredSkipCount: 1,
      cashStarvedSkipCount: 1,
      positionCapSkipCount: 1,
      maxOpenMarketSkipCount: 0,
      noLocalRedeemSkipCount: 0,
      unmatchedRedeemSkipCount: 0,
    });
  });

  it("limits copy quality diagnostics to the requested recent window", () => {
    const now = Date.now();
    const oldTs = now - 3_600_000;
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO audit_log (ts, leader_id, action, token_id, side, size, price, reason, preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
      );
      for (let i = 0; i < 8; i++) {
        insert.run(oldTs, "leader-a", "DETECT", `old-filtered-${i}`, "BUY", 1, 0.02, null);
        insert.run(
          oldTs,
          "leader-a",
          "SKIP",
          `old-filtered-${i}`,
          "BUY",
          1,
          0.02,
          "price 0.02 < min 0.05"
        );
      }
      insert.run(
        oldTs,
        "leader-a",
        "ERROR",
        "old-redeem-timeout",
        "REDEEM",
        null,
        null,
        "Request timed out: GET https://gamma-api.polymarket.com/markets/slug/example"
      );
    } finally {
      db.close();
    }

    store.audit({
      leaderId: "leader-a",
      action: "DETECT",
      tokenId: "recent-token",
      side: "BUY",
      size: 2,
      price: 0.5,
      preview: true,
    });
    store.recordCopySuccess({
      tradeKey: "recent-window-buy",
      leaderId: "leader-a",
      tokenId: "recent-token",
      side: "BUY",
      filledShares: 2,
      price: 0.5,
      filledUsd: 1,
      auditReason: "recent copy",
      preview: true,
      cashInitialUsd: 20,
      market: {
        tokenId: "recent-token",
        conditionId: "recent-condition",
        slug: "recent-market",
        title: "Recent market",
        outcome: "Yes",
      },
    });

    const report = readPreviewAccountReport({
      accountId: "quality-window",
      dbPath,
      startingCapitalUsd: 20,
      recentWindowMs: 60_000,
      nowMs: now + 1_000,
    });

    expect(report.copyQuality.detected.buy).toBe(1);
    expect(report.copyQuality.copied.buy).toBe(1);
    expect(report.copyQuality.coverage.buyPct).toBe(100);
    expect(report.copyQuality.skips.parameterFiltered).toBe(0);
    expect(report.errorCount).toBe(1);
    expect(report.recentWindow?.errorCount).toBe(0);
    expect(report.copyQuality.primaryIssue.code).not.toBe("safety_blocker");
  });

  it("reports accounting and recovery diagnostics", () => {
    store.recordCopySuccess({
      tradeKey: "buy-diag",
      leaderId: "leader-a",
      tokenId: "diag-token",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "diagnostic buy",
      preview: true,
      cashInitialUsd: 20,
      market: {
        tokenId: "diag-token",
        conditionId: "condition-diag",
        slug: "diag-market",
      },
    });
    store.recordCopySuccess({
      tradeKey: "sell-diag",
      leaderId: "leader-a",
      tokenId: "diag-token",
      side: "SELL",
      filledShares: 4,
      price: 0.75,
      filledUsd: 3,
      auditReason: "diagnostic sell",
      preview: true,
      cashInitialUsd: 20,
    });
    store.upsertPendingOrder({
      orderId: "pending-diag",
      leaderId: "leader-a",
      tokenId: "diag-token",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      tradeKey: "pending-key",
      reasoning: "pending diagnostic",
    });
    store.recordLiveOrderIntent({
      tradeKeys: ["intent-key"],
      leaderId: "leader-a",
      tokenId: "diag-token",
      side: "BUY",
      price: 0.5,
      orderSize: 2,
      auditReason: "intent diagnostic",
    });

    const report = readPreviewAccountReport({
      accountId: "acct-diag",
      dbPath,
      startingCapitalUsd: 20,
    });

    expect(report.cashReplayDeltaUsd).toBe(0);
    expect(report.capitalDeltaUsd).toBe(0);
    expect(report.missingMarketMetadataCount).toBe(0);
    expect(report.pendingOrderCount).toBe(1);
    expect(report.liveOrderIntentCount).toBe(1);
  });

  it("uses cumulative realized pnl across days for capital diagnostics", () => {
    store.close();
    const db = new Database(dbPath);
    try {
      db.exec(`
        DELETE FROM daily_stats;
        INSERT INTO cash_ledger (scope, cash_usd, updated_at)
        VALUES ('preview', 28, 1)
        ON CONFLICT(scope) DO UPDATE SET cash_usd = excluded.cash_usd;
        INSERT INTO daily_stats (date, realized_pnl, copy_count, kill_switch)
        VALUES
          ('2026-07-06', 3, 1, 0),
          ('2026-07-07', 5, 1, 0);
      `);
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "multi-day",
      dbPath,
      startingCapitalUsd: 20,
    });

    expect(report.realizedPnlUsd).toBe(8);
    expect(report.capitalDeltaUsd).toBe(0);
  });

  it("separates harmless no-local redeem skips from suspicious redeem skips", () => {
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "condition-not-copied",
      side: "REDEEM",
      reason: "no local preview position for condition",
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "condition-missing-slug",
      side: "REDEEM",
      reason: "REDEEM missing market slug",
      preview: true,
    });

    const report = readPreviewAccountReport({
      accountId: "acct-redeem",
      dbPath,
      startingCapitalUsd: 20,
      recentWindowMs: 60_000,
    });

    expect(report.noLocalRedeemSkipCount).toBe(1);
    expect(report.unmatchedRedeemSkipCount).toBe(1);
    expect(report.recentWindow).toMatchObject({
      noLocalRedeemSkipCount: 1,
      unmatchedRedeemSkipCount: 1,
    });
  });

  it("reads old preview dbs that do not have cash or market metadata tables", () => {
    store.close();
    rmSync(dbPath, { force: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE positions (
          leader_id TEXT NOT NULL,
          token_id TEXT NOT NULL,
          shares REAL NOT NULL DEFAULT 0,
          avg_entry_price REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (leader_id, token_id)
        );
        CREATE TABLE daily_stats (
          date TEXT PRIMARY KEY,
          volume_usd REAL NOT NULL DEFAULT 0,
          realized_pnl REAL NOT NULL DEFAULT 0,
          copy_count INTEGER NOT NULL DEFAULT 0,
          kill_switch INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          leader_id TEXT,
          action TEXT NOT NULL,
          token_id TEXT,
          side TEXT,
          size REAL,
          price REAL,
          reason TEXT,
          preview INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO positions VALUES ('leader-a', 'legacy-token', 10, 0.5);
        INSERT INTO daily_stats VALUES ('2026-07-06', 5, 1.5, 1, 0);
      `);
    } finally {
      db.close();
    }

    const report = readPreviewAccountReport({
      accountId: "legacy",
      dbPath,
      startingCapitalUsd: 20,
    });

    expect(report.exists).toBe(true);
    expect(report.cashUsd).toBe(20);
    expect(report.openCostUsd).toBe(5);
    expect(report.openMarkets[0]).toMatchObject({
      slug: null,
      positions: 1,
      costUsd: 5,
    });
  });
});
