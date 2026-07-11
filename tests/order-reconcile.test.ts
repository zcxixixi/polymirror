import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state/store.js";
import { ClobExecutor } from "../src/executor/clob.js";
import { adoptUntrackedOpenOrders } from "../src/engine/order-reconcile.js";

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
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function recordIntent(createdAt = Date.now()): string {
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
  return intentId;
}

describe("adoptUntrackedOpenOrders", () => {
  it("leaves untracked open CLOB orders unclaimed without a persisted order id", async () => {
    mockListOpenOrders.mockResolvedValue([{ orderId: "manual-1", tokenId: "tok-abc", side: "BUY", price: 0.55, size: 20 }]);

    const result = await adoptUntrackedOpenOrders(new ClobExecutor({} as never, {} as never), store);

    expect(result.adopted).toBe(0);
    expect(result.warnings.some((warning) => warning.includes("left unclaimed"))).toBe(true);
    expect(store.listPendingOrders()).toHaveLength(0);
    expect(mockGetOrderStatus).not.toHaveBeenCalled();
  });

  it("does not bind a fresh live intent to an economically matching open order", async () => {
    const intentId = recordIntent();
    mockListOpenOrders.mockResolvedValue([{ orderId: "old-identical", tokenId: "tok-abc", side: "BUY", price: 0.55, size: 20 }]);

    const result = await adoptUntrackedOpenOrders(new ClobExecutor({} as never, {} as never), store);

    expect(result.adopted).toBe(0);
    expect(store.listLiveOrderIntents().map((row) => row.intentId)).toEqual([intentId]);
    expect(store.hasSeen("source-a")).toBe(false);
    expect(store.getPosition("whale", "tok-abc")).toBe(0);
  });

  it("quarantines a stale intent without claiming an economic completed-fill match", async () => {
    recordIntent(Date.now() - 10 * 60_000);
    mockListOpenOrders.mockResolvedValue([]);

    const result = await adoptUntrackedOpenOrders(new ClobExecutor({} as never, {} as never), store);

    expect(result.adopted).toBe(0);
    expect(result.warnings.some((warning) => warning.includes("quarantined uncertain live order intent"))).toBe(true);
    expect(store.listLiveOrderIntents()).toHaveLength(0);
    expect(store.listLiveOrderIntents({ includeReconciliation: true })).toHaveLength(1);
    expect(store.hasSeen("source-a")).toBe(true);
    expect(store.getPosition("whale", "tok-abc")).toBe(0);
    expect(store.listAuditLog({ action: "COPY" }).items).toHaveLength(0);
    expect(mockListRecentCompletedFills).not.toHaveBeenCalled();
  });

  it("retains intents when open-order lookup is transient", async () => {
    const intentId = recordIntent(Date.now() - 10 * 60_000);
    mockListOpenOrders.mockRejectedValue(new Error("CLOB unavailable"));

    const result = await adoptUntrackedOpenOrders(new ClobExecutor({} as never, {} as never), store);

    expect(result.adopted).toBe(0);
    expect(result.warnings.some((warning) => warning.includes("lookup failed"))).toBe(true);
    expect(store.listLiveOrderIntents().map((row) => row.intentId)).toEqual([intentId]);
  });

  it("ignores exchange orders already tracked by persisted order id", async () => {
    store.upsertPendingOrder({
      orderId: "known-1", leaderId: "whale", tokenId: "tok-abc", side: "BUY",
      price: 0.55, size: 20, filledShares: 0, tradeKey: "source-a", reasoning: "test",
    });
    mockListOpenOrders.mockResolvedValue([{ orderId: "known-1", tokenId: "tok-abc", side: "BUY", price: 0.55, size: 20 }]);

    const result = await adoptUntrackedOpenOrders(new ClobExecutor({} as never, {} as never), store);

    expect(result).toEqual({ adopted: 0, warnings: [] });
    expect(store.listPendingOrders()).toHaveLength(1);
  });
});
