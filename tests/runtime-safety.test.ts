import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state/store.js";
import { evaluateRuntimeSafety } from "../src/engine/runtime-safety.js";
import { assessLiquidationEquity } from "../src/engine/liquidation-equity.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

vi.mock("../src/engine/liquidation-equity.js", () => ({
  assessLiquidationEquity: vi.fn(),
}));

const mockEquity = vi.mocked(assessLiquidationEquity);
let dir: string;
let store: StateStore;

function start() {
  const config = previewRuntimeConfig();
  config.app.global.risk.startingCapitalUsd = 200;
  store.startOrResumeExperiment({
    accountId: "safety",
    candidateAddresses: [],
    config,
    gitSha: "git",
    imageDigest: "image",
    lockfileHash: "lock",
    trustClass: "candidate",
  }, 1);
  return config;
}

function equity(equityUsd = 200, drawdownPct = 0) {
  return {
    cashUsd: equityUsd,
    liquidationValueUsd: 0,
    equityUsd,
    openCostUsd: 0,
    quoteCoverage: 1,
    missingTokenIds: [],
    drawdownPct,
    peakEquityUsd: 200,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-runtime-safety-"));
  store = new StateStore(join(dir, "preview.db"));
  mockEquity.mockReset();
  mockEquity.mockResolvedValue(equity());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("evaluateRuntimeSafety", () => {
  it("quarantines a capital invariant drift above one cent", async () => {
    const config = start();
    store.adjustCash(-1, 200);

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(result.capitalDeltaUsd).toBe(-1);
    expect(result.control).toMatchObject({
      state: "QUARANTINED",
      reasonCode: "DATA_LEDGER_DRIFT",
    });
  });

  it("quarantines a settlement failure after three observations", async () => {
    const config = start();
    for (let index = 0; index < 3; index++) {
      store.recordSettlementFailure({
        leaderId: "leader",
        conditionId: "condition",
        errorCode: "gamma_schema",
        errorMessage: "bad schema",
        observedAt: 100 + index,
      });
    }

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(result.control).toMatchObject({
      state: "QUARANTINED",
      reasonCode: "DATA_SETTLEMENT_FAILURE",
    });
  });

  it("makes a ten-percent liquidation drawdown sticky settle-only", async () => {
    const config = start();
    mockEquity.mockResolvedValue(equity(180, 10));

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(result.control).toMatchObject({
      state: "SETTLE_ONLY",
      reasonCode: "RISK_MAX_LIQUIDATION_DRAWDOWN",
    });
    expect(store.isKillSwitchActive()).toBe(true);
  });

  it("starts a reviewed healthy window only after data issues clear", async () => {
    const config = start();
    store.setExperimentControl({
      state: "QUARANTINED",
      reasonCode: "DATA_PENDING_STALE",
      triggeredAt: 1_000,
    });

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(result.control).toMatchObject({ state: "QUARANTINED", healthySince: 10_000 });
  });

  it("does not mark a capacity quarantine healthy without an OK capacity sample", async () => {
    const config = start();
    store.setExperimentControl({
      state: "QUARANTINED",
      reasonCode: "DATA_CAPACITY_LOW",
      triggeredAt: 1_000,
    });

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(result.control).toMatchObject({
      state: "QUARANTINED",
      reasonCode: "DATA_CAPACITY_LOW",
      healthySince: null,
    });
  });

  it("reuses a persisted equity snapshot for sixty seconds", async () => {
    const config = start();
    await evaluateRuntimeSafety(config, store, { nowMs: 10_000, forceEquityRefresh: true });
    await evaluateRuntimeSafety(config, store, { nowMs: 40_000 });

    expect(mockEquity).toHaveBeenCalledTimes(1);
    expect(store.listEquitySnapshots()).toHaveLength(1);
  });
});
