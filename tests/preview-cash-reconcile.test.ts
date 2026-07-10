import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcilePreviewCash } from "../src/sim/preview-cash-reconcile.js";
import { StateStore } from "../src/state/store.js";

let dir: string;
let dbPath: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-cash-reconcile-"));
  dbPath = join(dir, "preview.db");
  store = new StateStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("reconcilePreviewCash", () => {
  it("replays audit rows and corrects stale rounded preview cash", () => {
    store.recordCopySuccess({
      tradeKey: "cash-buy-a",
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      filledShares: 1.34,
      price: 0.75,
      filledUsd: 1.005,
      auditReason: "fractional-cent buy",
      preview: true,
      cashInitialUsd: 20,
    });
    store.recordCopySuccess({
      tradeKey: "cash-buy-b",
      leaderId: "whale",
      tokenId: "tok-b",
      side: "BUY",
      filledShares: 1.34,
      price: 0.75,
      filledUsd: 1.005,
      auditReason: "fractional-cent buy",
      preview: true,
      cashInitialUsd: 20,
    });
    store.close();

    const db = new Database(dbPath);
    try {
      db.prepare("UPDATE cash_ledger SET cash_usd = 18 WHERE scope = 'preview'").run();
    } finally {
      db.close();
    }

    const dryRun = reconcilePreviewCash({
      dbPath,
      startingCapitalUsd: 20,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      exists: true,
      auditRows: 2,
      oldCashUsd: 18,
      replayedCashUsd: 17.99,
      deltaUsd: 0.01,
      applied: false,
    });

    const applied = reconcilePreviewCash({
      dbPath,
      startingCapitalUsd: 20,
      dryRun: false,
    });
    expect(applied.applied).toBe(true);

    const check = new Database(dbPath, { readonly: true });
    try {
      const row = check
        .prepare("SELECT cash_usd AS cashUsd FROM cash_ledger WHERE scope = 'preview'")
        .get() as { cashUsd: number };
      expect(row.cashUsd).toBe(17.99);
    } finally {
      check.close();
    }
  });
});
