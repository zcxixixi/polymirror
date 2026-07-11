import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveCohortTableAccounts,
  selectExactCohortReports,
} from "../src/sim/cohort-table-accounts.js";
import { readCohortOperationalEvidence } from "../src/sim/cohort-operational-evidence.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
let dataDir: string;

function addAccount(accountId: string): void {
  const accountDir = join(dataDir, accountId);
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(join(accountDir, "preview.db"), "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-cohort-table-accounts-"));
  dataDir = join(dir, "accounts");
  addAccount("acct-a");
  addAccount("acct-b");
  addAccount("historical-account");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveCohortTableAccounts", () => {
  it("discovers all account databases only when no explicit selection exists", () => {
    expect(resolveCohortTableAccounts(dataDir, undefined)).toEqual([
      "acct-a",
      "acct-b",
      "historical-account",
    ]);
    expect(resolveCohortTableAccounts(dataDir, " , ")).toEqual([
      "acct-a",
      "acct-b",
      "historical-account",
    ]);
  });

  it("uses the explicit comma-separated selection without scanning historical accounts", () => {
    expect(
      resolveCohortTableAccounts(dataDir, " acct-b,acct-a,acct-b ")
    ).toEqual(["acct-b", "acct-a"]);
  });

  it("keeps a 12-account cohort bounded when the data directory has 60 databases", () => {
    const cohort = Array.from({ length: 12 }, (_, index) => `cohort-${index}`);
    for (const accountId of cohort) addAccount(accountId);
    for (let index = 0; index < 45; index += 1) addAccount(`history-${index}`);

    expect(resolveCohortTableAccounts(dataDir, cohort.join(","))).toEqual(cohort);
  });

  it("fails closed when an explicitly requested account database is missing", () => {
    expect(() => resolveCohortTableAccounts(dataDir, "acct-a,missing")).toThrow(
      /requested cohort account missing is unavailable/
    );
  });

  it("fails closed for path-like account identifiers", () => {
    expect(() => resolveCohortTableAccounts(dataDir, "../acct-a")).toThrow(
      /invalid requested cohort account id/
    );
  });
});

describe("selectExactCohortReports", () => {
  it("reuses one exact report snapshot in requested account order", () => {
    expect(selectExactCohortReports(
      ["acct-b", "acct-a"],
      [{ accountId: "acct-a", value: 1 }, { accountId: "acct-b", value: 2 }]
    )).toEqual([
      { accountId: "acct-b", value: 2 },
      { accountId: "acct-a", value: 1 },
    ]);
  });

  it("fails closed for missing, extra, or duplicate source reports", () => {
    expect(() => selectExactCohortReports(
      ["acct-a", "acct-b"],
      [{ accountId: "acct-a" }]
    )).toThrow(/scope does not match/i);
    expect(() => selectExactCohortReports(
      ["acct-a"],
      [{ accountId: "acct-a" }, { accountId: "extra" }]
    )).toThrow(/scope does not match/i);
    expect(() => selectExactCohortReports(
      ["acct-a"],
      [{ accountId: "acct-a" }, { accountId: "acct-a" }]
    )).toThrow(/duplicate/i);
  });
});

describe("readCohortOperationalEvidence", () => {
  it("counts only the active experiment after build-only failures are carried forward", () => {
    const accountId = "evidence-account";
    addAccount(accountId);
    const dbPath = join(dataDir, accountId, "preview.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    const first = store.startOrResumeExperiment({
      accountId,
      candidateAddresses: [],
      config,
      gitSha: "git-a",
      imageDigest: "image-a",
      lockfileHash: "lock-a",
      trustClass: "candidate",
    }, 1_000);
    store.setExperimentControl({
      experimentId: first.experimentId,
      state: "QUARANTINED",
      reasonCode: "DATA_SETTLEMENT_FAILURE",
      triggeredAt: 1_100,
    });
    store.recordSettlementFailure({
      experimentId: first.experimentId,
      leaderId: "sports",
      conditionId: "condition-a",
      errorCode: "gamma_schema",
      errorMessage: "bad schema",
      observedAt: 1_200,
    });
    const second = store.startOrResumeExperiment({
      accountId,
      candidateAddresses: [],
      config,
      gitSha: "git-b",
      imageDigest: "image-b",
      lockfileHash: "lock-b",
      trustClass: "candidate",
    }, 2_000);
    expect(second.previousExperimentId).toBe(first.experimentId);

    expect(readCohortOperationalEvidence(dbPath)).toEqual({
      controlState: "QUARANTINED",
      settlementFailures: 1,
    });
    store.close();
  });

  it("does not leak historical failures across a new decision experiment", () => {
    const accountId = "fresh-experiment-account";
    addAccount(accountId);
    const dbPath = join(dataDir, accountId, "preview.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    const first = store.startOrResumeExperiment({
      accountId,
      candidateAddresses: [],
      config,
      gitSha: "git-a",
      imageDigest: "image-a",
      lockfileHash: "lock-a",
      trustClass: "candidate",
    }, 1_000);
    store.recordSettlementFailure({
      experimentId: first.experimentId,
      leaderId: "sports",
      conditionId: "condition-a",
      errorCode: "gamma_schema",
      errorMessage: "bad schema",
      observedAt: 1_200,
    });
    const changed = previewRuntimeConfig();
    changed.app.global.risk.maxOrderUsd += 1;
    store.startOrResumeExperiment({
      accountId,
      candidateAddresses: [],
      config: changed,
      gitSha: "git-a",
      imageDigest: "image-a",
      lockfileHash: "lock-a",
      trustClass: "candidate",
    }, 2_000);

    expect(readCohortOperationalEvidence(dbPath)).toEqual({
      controlState: "ACTIVE",
      settlementFailures: 0,
    });
    store.close();
  });
});
