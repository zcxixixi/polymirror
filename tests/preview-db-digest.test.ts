import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPreviewDbDigest,
  formatPreviewDbDigest,
} from "../src/sim/preview-db-digest.js";
import { StateStore } from "../src/state/store.js";

let dir: string;
let dataDir: string;
let stores: StateStore[];

function makeStore(accountId: string): StateStore {
  const store = new StateStore(join(dataDir, accountId, "preview.db"));
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-preview-db-digest-"));
  dataDir = join(dir, "accounts");
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createPreviewDbDigest", () => {
  it("summarizes account DBs without replaying full cash history", () => {
    const now = Date.now();
    const winner = makeStore("winner");
    winner.recordCopySuccess({
      tradeKey: "buy-win",
      leaderId: "leader-a",
      tokenId: "win-token",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "copy win",
      preview: true,
      cashInitialUsd: 20,
      market: {
        tokenId: "win-token",
        conditionId: "condition-win",
        slug: "market-win",
        title: "Market Win",
        outcome: "Yes",
      },
    });
    winner.settleCondition({
      leaderId: "leader-a",
      conditionId: "condition-win",
      winnerTokenIds: ["win-token"],
      cashInitialUsd: 20,
      preview: true,
    });
    winner.recordCopySuccess({
      tradeKey: "buy-loss",
      leaderId: "leader-a",
      tokenId: "loss-token",
      side: "BUY",
      filledShares: 4,
      price: 0.5,
      filledUsd: 2,
      auditReason: "copy loss",
      preview: true,
      cashInitialUsd: 20,
      market: {
        tokenId: "loss-token",
        conditionId: "condition-loss",
        slug: "market-loss",
        title: "Market Loss",
        outcome: "No",
      },
    });
    winner.settleCondition({
      leaderId: "leader-a",
      conditionId: "condition-loss",
      winnerTokenIds: ["other-token"],
      cashInitialUsd: 20,
      preview: true,
    });
    winner.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "cash-token",
      side: "BUY",
      reason: "preview cash $0.20 < order $1.00",
      preview: true,
    });
    winner.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "cap-token",
      side: "BUY",
      reason: "Fixed $1.00; max position reached",
      preview: true,
    });
    winner.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "market-token",
      side: "BUY",
      reason: "market unresolved",
      preview: true,
    });
    winner.audit({
      leaderId: "leader-a",
      action: "ERROR",
      tokenId: "bad-token",
      side: "BUY",
      reason: "gamma timeout",
      preview: true,
    });

    const stale = makeStore("stale");
    stale.audit({
      leaderId: "leader-b",
      action: "SKIP",
      tokenId: "old-token",
      side: "BUY",
      reason: "market unresolved",
      preview: true,
    });
    const staleDb = new Database(join(dataDir, "stale", "preview.db"));
    try {
      staleDb.prepare("UPDATE audit_log SET ts = ?").run(now - 2 * 60 * 60_000);
    } finally {
      staleDb.close();
    }

    const digest = createPreviewDbDigest({
      dataDir,
      startingCapitalUsd: 20,
      nowMs: now,
      recentWindowMs: 60_000,
      staleAfterMs: 30 * 60_000,
      limit: 3,
    });

    const winnerRow = digest.rows.find((row) => row.accountId === "winner");
    expect(winnerRow).toMatchObject({
      exists: true,
      copyCount: 2,
      redeemCount: 2,
      errorCount: 1,
      stale: false,
      recent: {
        cashStarvedSkipCount: 1,
        positionCapSkipCount: 1,
        marketUnresolvedSkipCount: 1,
        errorCount: 1,
      },
      winStats: {
        settledCount: 2,
        winCount: 1,
        lossCount: 1,
        winRatePct: 50,
      },
    });
    expect(digest.staleCount).toBe(1);
    expect(digest.riskCounts).toMatchObject({
      errors: 1,
      recentErrors: 1,
      recentCashStarved: 1,
      recentPositionCap: 1,
      recentMarketUnresolved: 1,
    });
    expect(digest.smallLiveGate.eligible.map((entry) => entry.accountId)).toEqual([]);
    const winnerGate = digest.smallLiveGate.rejected.find(
      (entry) => entry.accountId === "winner"
    );
    expect(winnerGate?.blockers).toContain("settled sample below gate");
    expect(formatPreviewDbDigest(digest).join("\n")).toContain("Digest:");
  });

  it("keeps reporting when one copied account DB is unreadable", () => {
    const good = makeStore("good");
    good.recordCopySuccess({
      tradeKey: "buy-good",
      leaderId: "leader-a",
      tokenId: "good-token",
      side: "BUY",
      filledShares: 2,
      price: 0.5,
      filledUsd: 1,
      auditReason: "copy good",
      preview: true,
      cashInitialUsd: 20,
    });

    const corruptDir = join(dataDir, "corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "preview.db"), "not sqlite");

    const digest = createPreviewDbDigest({
      dataDir,
      startingCapitalUsd: 20,
      nowMs: Date.now(),
    });

    const corrupt = digest.rows.find((row) => row.accountId === "corrupt");
    expect(corrupt?.exists).toBe(true);
    expect(corrupt?.readError).toEqual(expect.any(String));
    expect(digest.riskCounts.readErrors).toBe(1);
    const corruptGate = digest.smallLiveGate.rejected.find(
      (row) => row.accountId === "corrupt"
    );
    expect(corruptGate?.blockers).toContain("db read error");
    expect(digest.topPnl.map((row) => row.accountId)).toContain("good");
    expect(formatPreviewDbDigest(digest).join("\n")).toContain("readErrors=1");
  });
});
