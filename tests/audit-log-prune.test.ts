import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prunePreviewAuditLog } from "../src/sim/audit-log-prune.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
let dbPath: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-audit-prune-"));
  dbPath = join(dir, "preview.db");
  store = new StateStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function audit(action: "DETECT" | "SKIP" | "COPY" | "REDEEM" | "ERROR", reason: string): void {
  store.audit({
    leaderId: "leader-a",
    action,
    tokenId: `${action.toLowerCase()}-token`,
    side: action === "REDEEM" ? "REDEEM" : "BUY",
    reason,
    preview: true,
  });
}

function setReasonTs(reason: string, ts: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE audit_log SET ts = ? WHERE reason = ?").run(ts, reason);
  } finally {
    db.close();
  }
}

function setAllAuditTs(ts: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE audit_log SET ts = ?").run(ts);
  } finally {
    db.close();
  }
}

function countByReason(reason: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE reason = ?")
        .get(reason) as { c: number }
    ).c;
  } finally {
    db.close();
  }
}

describe("prunePreviewAuditLog", () => {
  it("refuses to prune while experiment evidence is unsealed", () => {
    const config = previewRuntimeConfig();
    store.startOrResumeExperiment({
      accountId: "candidate-a",
      candidateAddresses: [],
      config,
      gitSha: "git-a",
      imageDigest: "image-a",
      lockfileHash: "lock-a",
      trustClass: "candidate",
    });
    audit("SKIP", "old unsealed evidence");
    setAllAuditTs(1);

    expect(() => prunePreviewAuditLog({
      dbPath,
      keepRecentMs: 1,
      nowMs: 10,
      dryRun: false,
    })).toThrow(/unsealed experiment evidence/i);
    expect(countByReason("old unsealed evidence")).toBe(1);
  });

  it("refuses a manually sealed experiment that has no verified archive record", () => {
    const config = previewRuntimeConfig();
    store.startOrResumeExperiment({ accountId: "candidate-a", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const db = new Database(dbPath);
    db.prepare("UPDATE experiments SET sealed_at=10, ended_at=10, state='ENDED'").run();
    db.close();
    audit("SKIP", "old sealed but unarchived evidence");
    setAllAuditTs(1);
    expect(() => prunePreviewAuditLog({ dbPath, keepRecentMs: 1, nowMs: 10, dryRun: false }))
      .toThrow(/verified archive/i);
    expect(countByReason("old sealed but unarchived evidence")).toBe(1);
  });

  it("dry-runs and prunes only old DETECT/SKIP noise rows", () => {
    const nowMs = Date.parse("2026-07-06T12:00:00.000Z");
    const oldMs = nowMs - 72 * 3600_000;
    const recentMs = nowMs - 10 * 60_000;

    audit("DETECT", "old detect");
    audit("SKIP", "old skip");
    audit("COPY", "old copy");
    audit("REDEEM", "old redeem");
    audit("ERROR", "old error");
    audit("SKIP", "recent skip");

    for (const reason of ["old detect", "old skip", "old copy", "old redeem", "old error"]) {
      setReasonTs(reason, oldMs);
    }
    setReasonTs("recent skip", recentMs);

    const dryRun = prunePreviewAuditLog({
      dbPath,
      keepRecentMs: 24 * 3600_000,
      nowMs,
      dryRun: true,
    });

    expect(dryRun).toMatchObject({
      matchedRows: 2,
      deletedRows: 0,
      dryRun: true,
    });
    expect(countByReason("old detect")).toBe(1);
    expect(countByReason("old skip")).toBe(1);

    const pruned = prunePreviewAuditLog({
      dbPath,
      keepRecentMs: 24 * 3600_000,
      nowMs,
      dryRun: false,
    });

    expect(pruned).toMatchObject({
      matchedRows: 2,
      deletedRows: 2,
      dryRun: false,
    });
    expect(countByReason("old detect")).toBe(0);
    expect(countByReason("old skip")).toBe(0);
    expect(countByReason("old copy")).toBe(1);
    expect(countByReason("old redeem")).toBe(1);
    expect(countByReason("old error")).toBe(1);
    expect(countByReason("recent skip")).toBe(1);
  });

  it("optionally vacuums after pruning old noise rows to reclaim sqlite space", () => {
    const nowMs = Date.parse("2026-07-06T12:00:00.000Z");
    const oldMs = nowMs - 72 * 3600_000;
    const largeReason = "old skip " + "x".repeat(4_000);

    for (let i = 0; i < 300; i += 1) {
      audit("SKIP", `${largeReason} ${i}`);
    }
    setAllAuditTs(oldMs);

    const pruned = prunePreviewAuditLog({
      dbPath,
      keepRecentMs: 24 * 3600_000,
      nowMs,
      dryRun: false,
      vacuum: true,
    });

    expect(pruned).toMatchObject({
      matchedRows: 300,
      deletedRows: 300,
      dryRun: false,
      vacuumed: true,
    });
    expect(countByReason(`${largeReason} 0`)).toBe(0);
  });
});
