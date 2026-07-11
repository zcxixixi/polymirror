import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveCohortTableAccounts,
  selectExactCohortReports,
} from "../src/sim/cohort-table-accounts.js";

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
