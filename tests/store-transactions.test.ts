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
  it("orders audit rows by newest id when timestamps are equal", () => {
    store.audit({ action: "COPY", reason: "first", preview: true });
    store.audit({ action: "COPY", reason: "second", preview: true });
    store.close();

    const db = new Database(dbPath);
    try {
      db.prepare("UPDATE audit_log SET ts = 123").run();
    } finally {
      db.close();
    }
    store = new StateStore(dbPath);

    expect(store.listAuditLog({ action: "COPY" }).items.map((row) => row.reason)).toEqual([
      "second",
      "first",
    ]);
  });

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

  it("includes fees in position cost and realized pnl without changing execution price", () => {
    store.recordCopySuccess({
      tradeKey: "fee-buy",
      leaderId: "whale",
      tokenId: "tok-fee",
      side: "BUY",
      filledShares: 10,
      price: 0.5,
      filledUsd: 5,
      feeUsd: 0.1,
      auditReason: "fee buy",
      preview: true,
      cashInitialUsd: 200,
    });

    expect(store.getPositionCostUsd("whale", "tok-fee")).toBe(5.1);
    expect(store.getCashBalance(200)).toBe(194.9);
    expect(store.getDailyVolumeUsd()).toBe(5);

    store.recordCopySuccess({
      tradeKey: "fee-sell",
      leaderId: "whale",
      tokenId: "tok-fee",
      side: "SELL",
      filledShares: 10,
      price: 0.6,
      filledUsd: 6,
      feeUsd: 0.12,
      auditReason: "fee sell",
      preview: true,
      cashInitialUsd: 200,
    });

    expect(store.getCashBalance(200)).toBe(200.78);
    expect(store.getDailyRealizedPnl()).toBe(0.78);
    const [sell, buy] = store.listAuditLog({ action: "COPY" }).items;
    expect(buy).toMatchObject({ price: 0.5, feeUsd: 0.1 });
    expect(sell).toMatchObject({ price: 0.6, feeUsd: 0.12 });
  });

  it("preserves precise shares and sub-cent fees in realized pnl", () => {
    store.recordCopySuccess({
      tradeKey: "precise-buy",
      leaderId: "whale",
      tokenId: "tok-precise",
      side: "BUY",
      filledShares: 4.9475,
      price: 0.5,
      filledUsd: 2.47375,
      auditReason: "precise buy",
      preview: true,
      cashInitialUsd: 200,
    });

    expect(store.getPosition("whale", "tok-precise")).toBe(4.9475);

    store.recordCopySuccess({
      tradeKey: "precise-sell",
      leaderId: "whale",
      tokenId: "tok-precise",
      side: "SELL",
      filledShares: 4.9475,
      price: 0.6,
      filledUsd: 2.9685,
      feeUsd: 0.004,
      auditReason: "precise sell",
      preview: true,
      cashInitialUsd: 200,
    });

    expect(store.getPosition("whale", "tok-precise")).toBe(0);
    expect(store.getDailyRealizedPnl()).toBeCloseTo(0.49075, 8);
    expect(store.getCashBalance(200)).toBe(200.49075);
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

  it("preserves cumulative pending notional when a legacy caller omits it", () => {
    store.upsertPendingOrder({
      orderId: "ord-legacy-progress",
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 2,
      filledUsd: 1,
      tradeKey: "key-legacy-progress",
      reasoning: "legacy",
    });

    store.commitPendingOrderProgress({
      orderId: "ord-legacy-progress",
      matchedFilledShares: 2,
      remove: false,
    });

    expect(store.listPendingOrders()[0]?.filledUsd).toBe(1);
  });

  it("recordLiveOrderAccepted marks seen, pending, and fill atomically", () => {
    store.recordLiveOrderAccepted({
      tradeKeys: ["key-a", "key-b"],
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      price: 0.5,
      leaderPrice: 0.49,
      executablePrice: 0.5,
      slippagePct: 2.0408,
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
    expect(store.listPendingOrders()[0]).toMatchObject({
      filledShares: 4,
      filledUsd: 2,
      leaderPrice: 0.49,
      executablePrice: 0.5,
      slippagePct: 2.0408,
    });
    expect(store.getDailyVolumeUsd()).toBe(2);
    expect(store.listAuditLog({ action: "COPY" }).items[0]).toMatchObject({
      price: 0.5,
      leaderPrice: 0.49,
      executablePrice: 0.5,
      slippagePct: 2.0408,
    });
  });
});
