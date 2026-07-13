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

  it("does not quarantine balanced fractional settlements after repeated sub-cent payouts", async () => {
    const config = start();
    for (let index = 0; index < 4; index++) {
      const tokenId = `fractional-${index}`;
      store.applyCopyFill("leader", tokenId, "BUY", 1, 0.333333);
      store.adjustCash(-0.333333, 200);
      store.recordTokenSettlement(tokenId, 0.333333, true, 200, {
        settlementSource: "token_resolution",
        conditionId: `condition-${index}`,
      });
    }

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(result.capitalDeltaUsd).toBe(0);
    expect(result.control?.state).toBe("ACTIVE");
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

  it("allows an isolated preview experiment to continue until total simulated loss", async () => {
    const config = start();
    config.app.global.risk.maxLiquidationDrawdownPct = 100;
    mockEquity.mockResolvedValue(equity(2, 99));

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(result.control?.state).toBe("ACTIVE");
  });

  it("preserves the starting-capital fallback on the first equity assessment", async () => {
    const config = start();
    mockEquity.mockResolvedValue({
      ...equity(160, 20),
      peakEquityUsd: 200,
    });

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(mockEquity).toHaveBeenCalledWith(config, store, undefined);
    expect(result.control).toMatchObject({
      state: "SETTLE_ONLY",
      reasonCode: "RISK_MAX_LIQUIDATION_DRAWDOWN",
    });
  });

  it("keeps the liquidation high-water mark across repeated build upgrades", async () => {
    const config = start();
    const first = store.getActiveExperiment("safety")!;
    store.recordEquitySnapshot({
      experimentId: first.experimentId,
      observedAt: 1_000,
      cashUsd: 250,
      liquidationValueUsd: 0,
      equityUsd: 250,
      openCostUsd: 0,
      quoteCoverage: 1,
      drawdownPct: 0,
      peakEquityUsd: 250,
      missingTokenCount: 0,
    });
    const second = store.startOrResumeExperiment({
      accountId: "safety",
      candidateAddresses: [],
      config,
      gitSha: "git-2",
      imageDigest: "image-2",
      lockfileHash: "lock-2",
      trustClass: "candidate",
    }, 2_000);
    const third = store.startOrResumeExperiment({
      accountId: "safety",
      candidateAddresses: [],
      config,
      gitSha: "git-3",
      imageDigest: "image-3",
      lockfileHash: "lock-3",
      trustClass: "candidate",
    }, 3_000);
    expect(second.previousExperimentId).toBe(first.experimentId);
    expect(third.previousExperimentId).toBe(second.experimentId);
    mockEquity.mockResolvedValue({
      ...equity(225, 10),
      peakEquityUsd: 250,
    });

    const result = await evaluateRuntimeSafety(config, store, {
      nowMs: 10_000,
      forceEquityRefresh: true,
    });

    expect(mockEquity).toHaveBeenCalledWith(config, store, 250);
    expect(result.control).toMatchObject({
      state: "SETTLE_ONLY",
      reasonCode: "RISK_MAX_LIQUIDATION_DRAWDOWN",
    });
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
