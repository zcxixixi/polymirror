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
      schemaVersion: 5,
      trustClass: "candidate",
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
      dependencyIssue: "diversified",
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
