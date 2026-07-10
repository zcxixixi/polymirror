import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../src/state/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

let dir: string;
let store: StateStore;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-store-txn-"));
  dbPath = join(dir, "test.db");
  store = new StateStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("StateStore transactions", () => {
  it("creates audit-log indexes needed by long-running preview reports", () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const indexes = db
        .prepare("PRAGMA index_list(audit_log)")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_audit_log_action",
          "idx_audit_log_action_reason",
          "idx_audit_log_action_id",
          "idx_audit_log_ts_action",
        ])
      );
    } finally {
      db.close();
    }
  });

  it("reads preview cash for dashboard summaries without creating a ledger row", () => {
    expect(store.readCashBalance(200)).toBe(200);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM cash_ledger WHERE scope = 'preview'")
        .get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("recordCopySuccess updates seen, position, volume, and audit together", () => {
    store.recordCopySuccess({
      tradeKey: "trade-1",
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "10% copy",
      preview: false,
    });

    expect(store.hasSeen("trade-1")).toBe(true);
    expect(store.getPosition("whale", "tok-a")).toBe(10);
    expect(store.getDailyVolumeUsd()).toBe(5);
    expect(store.getLeaderDailyVolumeUsd("whale")).toBe(5);

    const audit = store.listAuditLog({ action: "COPY" });
    expect(audit.total).toBe(1);
    expect(audit.items[0]?.size).toBe(10);
  });

  it("persists preview slippage observations without changing the accounting price", () => {
    store.recordCopySuccess({
      tradeKey: "observed-slip",
      leaderId: "whale",
      tokenId: "tok-slip",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "observed quote",
      preview: true,
      cashInitialUsd: 200,
      leaderPrice: 0.5,
      executablePrice: 0.55,
      slippagePct: 10,
    });

    const [audit] = store.listAuditLog({ action: "COPY" }).items;
    expect(audit).toMatchObject({
      price: 0.5,
      leaderPrice: 0.5,
      executablePrice: 0.55,
      slippagePct: 10,
    });
    expect(store.getPosition("whale", "tok-slip")).toBe(10);
    expect(store.getCashBalance(200)).toBe(195);
  });

  it("moves preview cash on BUY and SELL without treating SELL as buy volume", () => {
    store.recordCopySuccess({
      tradeKey: "cash-buy",
      leaderId: "whale",
      tokenId: "tok-cash",
      side: "BUY",
      filledShares: 100,
      price: 0.5,
      filledUsd: 50,
      auditReason: "cash buy",
      preview: true,
      cashInitialUsd: 200,
    });

    expect(store.getCashBalance(200)).toBe(150);
    expect(store.getDailyVolumeUsd()).toBe(50);
    expect(store.getLeaderDailyVolumeUsd("whale")).toBe(50);

    store.recordCopySuccess({
      tradeKey: "cash-sell",
      leaderId: "whale",
      tokenId: "tok-cash",
      side: "SELL",
      filledShares: 40,
      price: 0.5,
      filledUsd: 20,
      auditReason: "cash sell",
      preview: true,
      cashInitialUsd: 200,
    });

    expect(store.getCashBalance(200)).toBe(170);
    expect(store.getDailyVolumeUsd()).toBe(50);
    expect(store.getLeaderDailyVolumeUsd("whale")).toBe(50);
  });

  it("caps preview SELL cash, pnl, and audit size to actual held shares", () => {
    store.recordCopySuccess({
      tradeKey: "oversell-buy",
      leaderId: "whale",
      tokenId: "tok-oversell",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "buy",
      preview: true,
      cashInitialUsd: 200,
    });

    store.recordCopySuccess({
      tradeKey: "oversell-sell",
      leaderId: "whale",
      tokenId: "tok-oversell",
      side: "SELL",
      filledShares: 15,
      price: 0.6,
      filledUsd: 9,
      auditReason: "oversell",
      preview: true,
      cashInitialUsd: 200,
    });

    expect(store.getPosition("whale", "tok-oversell")).toBe(0);
    expect(store.getCashBalance(200)).toBe(201);
    expect(store.getDailyRealizedPnl()).toBe(1);
    const sellAudit = store
      .listAuditLog({ action: "COPY" })
      .items.find((row) => row.side === "SELL");
    expect(sellAudit?.size).toBe(10);
  });

  it("keeps normal preview SELL cash behavior when held shares cover the fill", () => {
    store.recordCopySuccess({
      tradeKey: "normal-sell-buy",
      leaderId: "whale",
      tokenId: "tok-normal-sell",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      auditReason: "buy",
      preview: true,
      cashInitialUsd: 200,
    });

    store.recordCopySuccess({
      tradeKey: "normal-sell",
      leaderId: "whale",
      tokenId: "tok-normal-sell",
      side: "SELL",
      filledShares: 4,
      price: 0.6,
      filledUsd: 2.4,
      auditReason: "sell",
      preview: true,
      cashInitialUsd: 200,
    });

    expect(store.getPosition("whale", "tok-normal-sell")).toBe(6);
    expect(store.getCashBalance(200)).toBe(197.4);
    expect(store.getDailyRealizedPnl()).toBe(0.4);
  });

  it("keeps preview cash precision across many fractional-cent fills", () => {
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

    expect(store.getCashBalance(20)).toBe(17.99);
  });

  it("recordPendingFill applies partial fill atomically", () => {
    store.recordPendingFill({
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      delta: 4,
      price: 0.5,
      auditReason: "pending fill",
      preview: false,
    });

    expect(store.getPosition("whale", "tok-a")).toBe(4);
    expect(store.getDailyVolumeUsd()).toBe(2);
    expect(store.listAuditLog({ action: "COPY" }).total).toBe(1);
  });

  it("commitPendingOrderProgress updates filled_shares with fill in one transaction", () => {
    store.upsertPendingOrder({
      orderId: "ord-txn",
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      tradeKey: "key-txn",
      reasoning: "10%",
    });

    store.commitPendingOrderProgress({
      orderId: "ord-txn",
      matchedFilledShares: 4,
      fill: {
        leaderId: "whale",
        tokenId: "tok-a",
        side: "BUY",
        delta: 4,
        price: 0.5,
        auditReason: "pending fill",
        preview: false,
      },
      remove: false,
    });

    expect(store.getPosition("whale", "tok-a")).toBe(4);
    expect(store.listPendingOrders()[0]?.filledShares).toBe(4);
  });

  it("recordLiveOrderAccepted marks seen, pending, and fill atomically", () => {
    store.recordLiveOrderAccepted({
      tradeKeys: ["key-a", "key-b"],
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      price: 0.5,
      orderSize: 10,
      filledShares: 4,
      filledUsd: 2,
      auditReason: "10% copy",
      orderId: "ord-live-1",
      pendingRemaining: 6,
      trackPendingGtc: true,
    });

    expect(store.hasSeen("key-a")).toBe(true);
    expect(store.hasSeen("key-b")).toBe(true);
    expect(store.getPosition("whale", "tok-a")).toBe(4);
    expect(store.countPendingOrders()).toBe(1);
    expect(store.listPendingOrders()[0]?.filledShares).toBe(4);
    expect(store.getDailyVolumeUsd()).toBe(2);
  });
});
