import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state/store.js";
import { ClobExecutor } from "../src/executor/clob.js";
import {
  adoptUntrackedOpenOrders,
  RECOVERED_ORDER_LEADER,
} from "../src/engine/order-reconcile.js";

const mockListOpenOrders = vi.fn();
const mockGetOrderStatus = vi.fn();
const mockListRecentCompletedFills = vi.fn();

vi.mock("../src/executor/clob.js", () => ({
  ClobExecutor: class {
    listOpenOrders = mockListOpenOrders;
    getOrderStatus = mockGetOrderStatus;
    listRecentCompletedFills = mockListRecentCompletedFills;
  },
}));

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-orphan-"));
  store = new StateStore(join(dir, "test.db"));
  mockListOpenOrders.mockReset();
  mockGetOrderStatus.mockReset();
  mockListRecentCompletedFills.mockReset();
  mockListRecentCompletedFills.mockResolvedValue({ kind: "ok", fills: [] });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("adoptUntrackedOpenOrders", () => {
  it("adopts open CLOB orders into pending_orders", async () => {
    mockListOpenOrders.mockResolvedValue([
      {
        orderId: "clob-orphan-1",
        tokenId: "tok-abc",
        side: "BUY",
        price: 0.55,
        size: 20,
      },
    ]);
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 5,
        originalSize: 20,
        status: "LIVE",
        terminal: false,
      },
    });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(1);
    const rows = store.listPendingOrders();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderId).toBe("clob-orphan-1");
    expect(rows[0]?.leaderId).toBe(RECOVERED_ORDER_LEADER);
    expect(rows[0]?.filledShares).toBe(5);
  });

  it("uses live order intents to preserve source trade keys when adopting orphans", async () => {
    const intentId = store.recordLiveOrderIntent({
      tradeKeys: ["source-a", "source-b"],
      leaderId: "whale",
      tokenId: "tok-abc",
      side: "BUY",
      price: 0.55,
      orderSize: 20,
      auditReason: "10% copy",
    });
    mockListOpenOrders.mockResolvedValue([
      {
        orderId: "clob-orphan-1",
        tokenId: "tok-abc",
        side: "BUY",
        price: 0.55,
        size: 20,
      },
    ]);
    mockGetOrderStatus.mockResolvedValue({
      kind: "ok",
      status: {
        sizeMatched: 5,
        originalSize: 20,
        status: "LIVE",
        terminal: false,
      },
    });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(1);
    expect(store.hasSeen("source-a")).toBe(true);
    expect(store.hasSeen("source-b")).toBe(true);
    expect(store.listLiveOrderIntents().some((r) => r.intentId === intentId)).toBe(false);
    const [row] = store.listPendingOrders();
    expect(row?.leaderId).toBe("whale");
    expect(row?.tradeKey).toBe("source-a");
    expect(row?.filledShares).toBe(5);
    expect(store.getPosition("whale", "tok-abc")).toBe(5);
  });

  it("recovers a completed immediate fill after submit succeeded but local commit crashed", async () => {
    const createdAt = Date.now() - 10 * 60_000;
    const intentId = store.recordLiveOrderIntent({
      tradeKeys: ["source-a", "source-b"],
      leaderId: "whale",
      tokenId: "tok-abc",
      side: "BUY",
      price: 0.55,
      orderSize: 20,
      auditReason: "10% copy",
    });
    store.setLiveOrderIntentTimestamps(intentId, createdAt);
    mockListOpenOrders.mockResolvedValue([]);
    mockListRecentCompletedFills.mockResolvedValue({
      kind: "ok",
      fills: [
        {
          orderId: "clob-fok-1",
          tokenId: "tok-abc",
          side: "BUY",
          averagePrice: 0.54,
          shares: 20,
          usd: 10.8,
          matchedAt: createdAt + 1_000,
        },
      ],
    });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted, warnings } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(1);
    expect(warnings).toEqual([]);
    expect(store.getPosition("whale", "tok-abc")).toBe(20);
    expect(store.hasSeen("source-a")).toBe(true);
    expect(store.hasSeen("source-b")).toBe(true);
    expect(store.listLiveOrderIntents()).toHaveLength(0);
    expect(store.countPendingOrders()).toBe(0);
    expect(store.listAuditLog({ action: "COPY" }).items[0]).toMatchObject({
      leaderId: "whale",
      tokenId: "tok-abc",
      side: "BUY",
      size: 20,
      price: 0.54,
    });
  });

  it("recovers a unique partial immediate fill after submit succeeded but local commit crashed", async () => {
    const createdAt = Date.now() - 10 * 60_000;
    const intentId = store.recordLiveOrderIntent({
      tradeKeys: ["source-partial"],
      leaderId: "whale",
      tokenId: "tok-partial",
      side: "BUY",
      price: 0.55,
      leaderPrice: 0.5,
      executablePrice: 0.52,
      slippagePct: 4,
      orderSize: 20,
      auditReason: "10% copy",
    });
    store.setLiveOrderIntentTimestamps(intentId, createdAt);
    mockListOpenOrders.mockResolvedValue([]);
    mockListRecentCompletedFills.mockResolvedValue({
      kind: "ok",
      fills: [
        {
          orderId: "clob-fak-partial",
          tokenId: "tok-partial",
          side: "BUY",
          averagePrice: 0.54,
          shares: 4,
          usd: 2.16,
          feeUsd: 999,
          cashDeltaUsd: -2.18,
          matchedAt: createdAt + 1_000,
        },
      ],
    });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted, warnings } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(1);
    expect(warnings).toEqual([]);
    expect(store.getPosition("whale", "tok-partial")).toBe(4);
    expect(store.getPositionCostUsd("whale", "tok-partial")).toBe(2.18);
    expect(store.hasSeen("source-partial")).toBe(true);
    expect(store.listLiveOrderIntents()).toHaveLength(0);
    expect(store.listAuditLog({ action: "COPY" }).items[0]).toMatchObject({
      leaderId: "whale",
      tokenId: "tok-partial",
      side: "BUY",
      size: 4,
      price: 0.54,
      leaderPrice: 0.5,
      executablePrice: 0.54,
      slippagePct: 8,
      feeUsd: 0.02,
    });
  });

  it("keeps a stale intent when completed fill matching is ambiguous", async () => {
    const createdAt = Date.now() - 10 * 60_000;
    const intentId = store.recordLiveOrderIntent({
      tradeKeys: ["source-a"],
      leaderId: "whale",
      tokenId: "tok-abc",
      side: "BUY",
      price: 0.55,
      orderSize: 20,
      auditReason: "10% copy",
    });
    store.setLiveOrderIntentTimestamps(intentId, createdAt);
    mockListOpenOrders.mockResolvedValue([]);
    mockListRecentCompletedFills.mockResolvedValue({
      kind: "ok",
      fills: [
        {
          orderId: "clob-fok-1",
          tokenId: "tok-abc",
          side: "BUY",
          averagePrice: 0.54,
          shares: 20,
          usd: 10.8,
          matchedAt: createdAt + 1_000,
        },
        {
          orderId: "clob-fok-2",
          tokenId: "tok-abc",
          side: "BUY",
          averagePrice: 0.53,
          shares: 20.5,
          usd: 10.87,
          matchedAt: createdAt + 2_000,
        },
      ],
    });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted, warnings } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(0);
    expect(warnings.some((w) => w.includes("ambiguous completed fill recovery"))).toBe(true);
    expect(store.hasSeen("source-a")).toBe(false);
    expect(store.listLiveOrderIntents().map((r) => r.intentId)).toEqual([intentId]);
    expect(store.getPosition("whale", "tok-abc")).toBe(0);
  });

  it("does not adopt a completed BUY fill above the intent limit", async () => {
    const createdAt = Date.now() - 10 * 60_000;
    store.recordLiveOrderIntent({
      tradeKeys: ["source-a"],
      leaderId: "whale",
      tokenId: "tok-abc",
      side: "BUY",
      price: 0.55,
      orderSize: 20,
      auditReason: "10% copy",
    });
    const [intent] = store.listLiveOrderIntents();
    store.setLiveOrderIntentTimestamps(intent!.intentId, createdAt);
    mockListOpenOrders.mockResolvedValue([]);
    mockListRecentCompletedFills.mockResolvedValue({
      kind: "ok",
      fills: [
        {
          orderId: "clob-other-1",
          tokenId: "tok-abc",
          side: "BUY",
          averagePrice: 0.555,
          shares: 19.64,
          usd: 10.9,
          matchedAt: createdAt + 1_000,
        },
      ],
    });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted, warnings } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(0);
    expect(warnings.some((w) => w.includes("quarantined uncertain live order intent"))).toBe(true);
    expect(store.getPosition("whale", "tok-abc")).toBe(0);
    expect(store.listLiveOrderIntents()).toHaveLength(0);
    expect(store.listLiveOrderIntents({ includeReconciliation: true })).toHaveLength(1);
  });

  it("does not match a low-price BUY fill that exceeds intended shares", async () => {
    const createdAt = Date.now() - 10 * 60_000;
    const intentId = store.recordLiveOrderIntent({
      tradeKeys: ["source-low-price"],
      leaderId: "whale",
      tokenId: "tok-low-price",
      side: "BUY",
      price: 0.5,
      orderSize: 10,
      auditReason: "fixed $5",
    });
    store.setLiveOrderIntentTimestamps(intentId, createdAt);
    mockListOpenOrders.mockResolvedValue([]);
    mockListRecentCompletedFills.mockResolvedValue({
      kind: "ok",
      fills: [
        {
          orderId: "unrelated-large-fill",
          tokenId: "tok-low-price",
          side: "BUY",
          averagePrice: 0.2,
          shares: 20,
          usd: 4,
          feeUsd: 0,
          matchedAt: createdAt + 1_000,
        },
      ],
    });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(0);
    expect(store.getPosition("whale", "tok-low-price")).toBe(0);
  });

  it("keeps a stale intent when completed fill lookup is transient", async () => {
    const intentId = store.recordLiveOrderIntent({
      tradeKeys: ["source-a"],
      leaderId: "whale",
      tokenId: "tok-abc",
      side: "BUY",
      price: 0.55,
      orderSize: 20,
      auditReason: "10% copy",
    });
    store.setLiveOrderIntentTimestamps(intentId, Date.now() - 10 * 60_000);
    mockListOpenOrders.mockResolvedValue([]);
    mockListRecentCompletedFills.mockResolvedValue({
      kind: "transient",
      message: "CLOB unavailable",
    });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted, warnings } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(0);
    expect(warnings.some((w) => w.includes("completed fill recovery lookup failed"))).toBe(true);
    expect(store.hasSeen("source-a")).toBe(false);
    expect(store.listLiveOrderIntents().map((r) => r.intentId)).toEqual([intentId]);
  });

  it("keeps a stale intent when open order lookup is transient", async () => {
    const intentId = store.recordLiveOrderIntent({
      tradeKeys: ["source-a"],
      leaderId: "whale",
      tokenId: "tok-abc",
      side: "BUY",
      price: 0.55,
      orderSize: 20,
      auditReason: "10% copy",
    });
    store.setLiveOrderIntentTimestamps(intentId, Date.now() - 10 * 60_000);
    mockListOpenOrders.mockRejectedValue(new Error("open orders unavailable"));

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted, warnings } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(0);
    expect(warnings.some((w) => w.includes("open order recovery lookup failed"))).toBe(true);
    expect(mockListRecentCompletedFills).not.toHaveBeenCalled();
    expect(store.hasSeen("source-a")).toBe(false);
    expect(store.listLiveOrderIntents().map((r) => r.intentId)).toEqual([intentId]);
  });

  it("quarantines stale intents while retaining delayed confirmed-fill recovery", async () => {
    const intentId = store.recordLiveOrderIntent({
      tradeKeys: ["source-a", "source-b"],
      leaderId: "whale",
      tokenId: "tok-abc",
      side: "BUY",
      price: 0.55,
      orderSize: 20,
      auditReason: "10% copy",
    });
    store.setLiveOrderIntentTimestamps(intentId, Date.now() - 10 * 60_000);
    mockListOpenOrders.mockResolvedValue([]);
    mockListRecentCompletedFills
      .mockResolvedValueOnce({ kind: "ok", fills: [] })
      .mockResolvedValueOnce({
        kind: "ok",
        fills: [{
          orderId: "late-confirmed-order",
          tokenId: "tok-abc",
          side: "BUY",
          averagePrice: 0.5,
          shares: 20,
          usd: 10,
          feeUsd: 0.1,
          cashDeltaUsd: -10.1,
          matchedAt: Date.now(),
        }],
      });

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted, warnings } = await adoptUntrackedOpenOrders(executor, store);

    expect(adopted).toBe(0);
    expect(warnings.some((w) => w.includes("quarantined uncertain live order intent"))).toBe(true);
    expect(store.hasSeen("source-a")).toBe(true);
    expect(store.hasSeen("source-b")).toBe(true);
    expect(store.listLiveOrderIntents()).toHaveLength(0);
    expect(store.listLiveOrderIntents({ includeReconciliation: true })).toHaveLength(1);
    expect(store.countPendingOrders()).toBe(0);
    const audit = store.listAuditLog({ action: "ERROR" }).items[0];
    expect(audit?.reason).toContain("uncertain live order intent quarantined");

    const recovered = await adoptUntrackedOpenOrders(executor, store);
    expect(recovered.adopted).toBe(1);
    expect(store.getPosition("whale", "tok-abc")).toBe(20);
    expect(store.listLiveOrderIntents({ includeReconciliation: true })).toHaveLength(0);
  });

  it("skips orders already tracked", async () => {
    store.upsertPendingOrder({
      orderId: "clob-known",
      leaderId: "whale",
      tokenId: "tok-a",
      side: "BUY",
      price: 0.5,
      size: 10,
      filledShares: 0,
      tradeKey: "k1",
      reasoning: "test",
    });
    mockListOpenOrders.mockResolvedValue([
      {
        orderId: "clob-known",
        tokenId: "tok-a",
        side: "BUY",
        price: 0.5,
        size: 10,
      },
    ]);

    const executor = new ClobExecutor({} as never, {} as never);
    const { adopted } = await adoptUntrackedOpenOrders(executor, store);
    expect(adopted).toBe(0);
  });
});
