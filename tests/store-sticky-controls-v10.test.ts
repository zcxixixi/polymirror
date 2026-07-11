import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

const HOUR_MS = 60 * 60_000;

let dir: string;
let dbPath: string;
let store: StateStore;
let experimentId: string;

function startExperiment(): string {
  const config = previewRuntimeConfig();
  return store.startOrResumeExperiment({
    accountId: "candidate-sticky",
    candidateAddresses: config.app.leaders.map((leader) => leader.address!),
    config,
    gitSha: "git-sticky",
    imageDigest: "image-sticky",
    lockfileHash: "lock-sticky",
    trustClass: "candidate",
  }, Date.now()).experimentId;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T23:59:00.000Z"));
  dir = mkdtempSync(join(tmpdir(), "pm-store-sticky-v10-"));
  dbPath = join(dir, "preview.db");
  store = new StateStore(dbPath);
  experimentId = startExperiment();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("sticky experiment controls", () => {
  it("keeps a daily-loss stop across UTC rollover and process restart", () => {
    store.triggerKillSwitch();
    expect(store.getExperimentControl()).toMatchObject({
      experimentId,
      state: "SETTLE_ONLY",
      reasonCode: "DAILY_LOSS_CAP",
    });
    expect(store.isKillSwitchActive()).toBe(true);

    vi.setSystemTime(new Date("2026-07-12T00:01:00.000Z"));
    expect(store.isKillSwitchActive()).toBe(true);
    store.close();
    store = new StateStore(dbPath);
    expect(store.isKillSwitchActive()).toBe(true);
    expect(store.getExperimentControl()?.state).toBe("SETTLE_ONLY");
  });

  it("retains the daily fallback only for a legacy database without experiments", () => {
    store.close();
    dbPath = join(dir, "legacy.db");
    store = new StateStore(dbPath);
    store.triggerKillSwitch();
    expect(store.getExperimentControl()).toBeNull();
    expect(store.isKillSwitchActive()).toBe(true);
    store.resetKillSwitch();
    expect(store.isKillSwitchActive()).toBe(false);
  });

  it("backfills a historical no-experiment kill when the first experiment starts", () => {
    store.close();
    dbPath = join(dir, "legacy-first-experiment.db");
    store = new StateStore(dbPath);
    store.triggerKillSwitch();
    vi.setSystemTime(new Date("2026-07-13T00:01:00.000Z"));
    experimentId = startExperiment();
    expect(store.getExperimentControl(experimentId)).toMatchObject({
      state: "SETTLE_ONLY",
      reasonCode: "LEGACY_KILL_SWITCH",
      details: expect.objectContaining({ migratedFrom: "daily_stats" }),
    });
    expect(store.isKillSwitchActive()).toBe(true);
  });

  it("backfills any historical kill on an existing first-generation legacy experiment", () => {
    store.close();
    const db = new Database(dbPath);
    db.exec("DROP TRIGGER experiments_immutable_core");
    db.prepare("UPDATE experiments SET schema_version = 9 WHERE experiment_id = ?")
      .run(experimentId);
    db.prepare("UPDATE schema_metadata SET value = '9' WHERE key = 'schema_version'").run();
    db.prepare("INSERT INTO daily_stats (date, kill_switch) VALUES ('2026-07-01', 1)").run();
    db.close();
    store = new StateStore(dbPath);
    expect(store.getExperimentControl(experimentId)).toMatchObject({
      state: "SETTLE_ONLY",
      reasonCode: "LEGACY_KILL_SWITCH",
      triggeredAt: Date.parse("2026-07-01T00:00:00.000Z"),
    });
  });

  it("backfills a historical kill on a rotated active legacy experiment", () => {
    const rotatedConfig = previewRuntimeConfig();
    rotatedConfig.app.global.risk.maxOrderUsd += 1;
    const rotated = store.startOrResumeExperiment({
      accountId: "candidate-sticky",
      candidateAddresses: rotatedConfig.app.leaders.map((leader) => leader.address!),
      config: rotatedConfig,
      gitSha: "git-sticky",
      imageDigest: "image-sticky",
      lockfileHash: "lock-sticky",
      trustClass: "candidate",
    }, Date.now() + 1);
    expect(rotated.previousExperimentId).toBe(experimentId);
    store.close();
    const db = new Database(dbPath);
    db.exec("DROP TRIGGER experiments_immutable_core");
    db.prepare("UPDATE experiments SET schema_version = 9 WHERE experiment_id = ?")
      .run(rotated.experimentId);
    db.prepare("UPDATE schema_metadata SET value = '9' WHERE key = 'schema_version'").run();
    db.prepare("INSERT INTO daily_stats (date, kill_switch) VALUES ('2026-07-02', 1)").run();
    db.close();

    store = new StateStore(dbPath);

    expect(store.getExperimentControl(rotated.experimentId)).toMatchObject({
      state: "SETTLE_ONLY",
      reasonCode: "LEGACY_KILL_SWITCH",
      triggeredAt: Date.parse("2026-07-02T00:00:00.000Z"),
    });
    expect(store.isKillSwitchActive()).toBe(true);
  });

  it("keeps previous experiment lineage immutable with NULL-safe comparison", () => {
    store.close();
    const db = new Database(dbPath);
    expect(() => db.prepare(
      "UPDATE experiments SET previous_experiment_id = 'fabricated' WHERE experiment_id = ?"
    ).run(experimentId)).toThrow(/manifest.*immutable/i);
    db.close();
    store = new StateStore(dbPath);
  });

  it("reports realized PnL across UTC daily buckets", () => {
    store.addRealizedPnl(-5);
    vi.setSystemTime(new Date("2026-07-12T00:01:00.000Z"));
    store.addRealizedPnl(2);
    expect(store.getDailyRealizedPnl()).toBe(2);
    expect(store.getTotalRealizedPnl()).toBe(-3);
  });

  it("fails closed when reset or data reactivation targets a sticky risk state", () => {
    store.triggerKillSwitch("MAX_DRAWDOWN");
    expect(() => store.resetKillSwitch()).toThrow(/sticky|new experiment|cannot reset/i);
    expect(() => store.reactivateQuarantinedExperiment({
      experimentId,
      reviewedAt: Date.now() + HOUR_MS,
    })).toThrow(/QUARANTINED/i);

    const freshConfig = previewRuntimeConfig();
    freshConfig.app.global.risk.maxOrderUsd += 1;
    const next = store.startOrResumeExperiment({
      accountId: "candidate-sticky",
      candidateAddresses: freshConfig.app.leaders.map((leader) => leader.address!),
      config: freshConfig,
      gitSha: "git-sticky",
      imageDigest: "image-sticky",
      lockfileHash: "lock-sticky",
      trustClass: "candidate",
    }, Date.now() + 1);
    expect(next.experimentId).not.toBe(experimentId);
    expect(store.getExperimentControl(next.experimentId)?.state).toBe("ACTIVE");
  });

  it("reactivates only a DATA quarantine after 60 healthy minutes and review", () => {
    store.setExperimentControl({
      experimentId,
      state: "QUARANTINED",
      reasonCode: "DATA_GAMMA_SCHEMA",
      details: { endpoint: "gamma" },
      triggeredAt: 1_000,
    });
    expect(() => store.setExperimentControl({
      experimentId,
      state: "SETTLE_ONLY",
      reasonCode: "MANUAL_OVERRIDE",
      triggeredAt: 1_001,
    })).toThrow(/ACTIVE.*non-active|transition/i);
    expect(store.markExperimentDataHealthy({ experimentId, healthyAt: 2_000 }))
      .toMatchObject({ healthySince: 2_000 });
    store.recordSettlementFailure({
      experimentId,
      leaderId: "sports",
      conditionId: "condition-a",
      errorCode: "gamma_schema_incompatible",
      errorMessage: "tick size changed",
      observedAt: 2_500,
    });
    expect(store.getExperimentControl(experimentId)?.healthySince).toBeNull();
    expect(store.markExperimentDataHealthy({ experimentId, healthyAt: 3_000 }))
      .toMatchObject({ healthySince: 3_000 });
    expect(store.markExperimentDataUnhealthy({ experimentId, observedAt: 3_500 }))
      .toMatchObject({ healthySince: null, reviewedAt: null });
    expect(store.markExperimentDataHealthy({ experimentId, healthyAt: 4_000 }))
      .toMatchObject({ healthySince: 4_000 });
    expect(() => store.reactivateQuarantinedExperiment({
      experimentId,
      reviewedAt: 4_000 + HOUR_MS - 1,
    })).toThrow(/60.*minute|healthy/i);

    const active = store.reactivateQuarantinedExperiment({
      experimentId,
      reviewedAt: 4_000 + HOUR_MS,
      details: { reviewer: "operator" },
    });
    expect(active).toMatchObject({
      state: "ACTIVE",
      reasonCode: "DATA_GAMMA_SCHEMA",
      healthySince: 4_000,
      reviewedAt: 4_000 + HOUR_MS,
    });
    expect(store.isKillSwitchActive()).toBe(false);
    expect(store.listExperimentControlAudit(experimentId).map((row) => [
      row.fromState,
      row.toState,
    ])).toEqual([
      ["ACTIVE", "QUARANTINED"],
      ["QUARANTINED", "QUARANTINED"],
      ["QUARANTINED", "QUARANTINED"],
      ["QUARANTINED", "ACTIVE"],
    ]);
  });

  it("refuses health/review recovery for a non-DATA quarantine", () => {
    store.setExperimentControl({
      experimentId,
      state: "QUARANTINED",
      reasonCode: "ACCOUNTING_DRIFT",
      triggeredAt: 1_000,
    });
    expect(() => store.markExperimentDataHealthy({ experimentId, healthyAt: 2_000 }))
      .toThrow(/DATA_/i);
    expect(() => store.markExperimentDataUnhealthy({ experimentId, observedAt: 2_000 }))
      .toThrow(/DATA_/i);
    expect(() => store.reactivateQuarantinedExperiment({
      experimentId,
      reviewedAt: 2_000 + HOUR_MS,
    })).toThrow(/DATA_/i);
  });
});

describe("hourly liquidation equity snapshots", () => {
  it("keeps the latest gauge in each hour and persists across restart", () => {
    store.recordEquitySnapshot({
      experimentId,
      observedAt: HOUR_MS + 1_000,
      cashUsd: 100,
      liquidationValueUsd: 80,
      equityUsd: 180,
      openCostUsd: 90,
      quoteCoverage: 0.5,
      drawdownPct: 10,
      peakEquityUsd: 200,
      missingTokenCount: 2,
    });
    store.recordEquitySnapshot({
      experimentId,
      observedAt: HOUR_MS + 2_000,
      cashUsd: 105,
      liquidationValueUsd: 85,
      equityUsd: 190,
      openCostUsd: 88,
      quoteCoverage: 0.75,
      drawdownPct: 5,
      peakEquityUsd: 205,
      missingTokenCount: 1,
    });
    store.recordEquitySnapshot({
      experimentId,
      observedAt: 2 * HOUR_MS + 1_000,
      cashUsd: 110,
      liquidationValueUsd: 90,
      equityUsd: 200,
      openCostUsd: 85,
      quoteCoverage: 1,
      drawdownPct: 2.5,
      peakEquityUsd: 205,
      missingTokenCount: 0,
    });

    expect(store.listEquitySnapshots(experimentId)).toEqual([
      expect.objectContaining({
        hourStart: HOUR_MS,
        observedAt: HOUR_MS + 2_000,
        cashUsd: 105,
        liquidationValueUsd: 85,
        equityUsd: 190,
        openCostUsd: 88,
        quoteCoverage: 0.75,
        drawdownPct: 5,
        peakEquityUsd: 205,
        missingTokenCount: 1,
      }),
      expect.objectContaining({
        hourStart: 2 * HOUR_MS,
        observedAt: 2 * HOUR_MS + 1_000,
        equityUsd: 200,
      }),
    ]);
    store.close();
    store = new StateStore(dbPath);
    expect(store.listEquitySnapshots(experimentId)).toHaveLength(2);
  });

  it("rejects snapshot updates and deletion after sealing", () => {
    store.recordEquitySnapshot({
      experimentId,
      observedAt: HOUR_MS + 1_000,
      cashUsd: 100,
      liquidationValueUsd: 80,
      equityUsd: 180,
      openCostUsd: 90,
      quoteCoverage: 0.5,
      drawdownPct: 10,
      peakEquityUsd: 200,
      missingTokenCount: 2,
    });
    store.close();
    const db = new Database(dbPath);
    db.prepare("UPDATE experiments SET sealed_at = ? WHERE experiment_id = ?")
      .run(2 * HOUR_MS, experimentId);
    db.close();
    store = new StateStore(dbPath);
    expect(() => store.recordEquitySnapshot({
      experimentId,
      observedAt: HOUR_MS + 2_000,
      cashUsd: 101,
      liquidationValueUsd: 81,
      equityUsd: 182,
      openCostUsd: 89,
      quoteCoverage: 0.6,
      drawdownPct: 9,
      peakEquityUsd: 200,
      missingTokenCount: 1,
    })).toThrow(/sealed experiment snapshots are immutable/i);

    const raw = new Database(dbPath);
    try {
      expect(() => raw.prepare("DELETE FROM equity_snapshots").run())
        .toThrow(/equity snapshots are persistent/i);
    } finally {
      raw.close();
    }
  });
});
