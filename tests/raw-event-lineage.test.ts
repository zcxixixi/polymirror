import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-lineage-"));
  store = new StateStore(join(dir, "preview.db"));
  const config = previewRuntimeConfig();
  store.startOrResumeExperiment({
    accountId: "candidate-a",
    candidateAddresses: config.app.leaders.map((leader) => leader.address!),
    config,
    gitSha: "git-a",
    imageDigest: "image-a",
    lockfileHash: "lock-a",
    trustClass: "candidate",
  }, 500);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("raw event lineage", () => {
  it("deduplicates source IDs without overwriting source or first-observed timestamps", () => {
    const payload = { type: "TRADE", price: 0.5, nested: { b: 2, a: 1 } };
    const first = store.recordRawEvent({
      sourceId: "tx-1:token:BUY",
      payload,
      sourceTimestamp: 123,
      observedTimestamp: 1000,
    });
    const duplicate = store.recordRawEvent({
      sourceId: "tx-1:token:BUY",
      payload: { ...payload, price: 0.7 },
      sourceTimestamp: 999,
      observedTimestamp: 2000,
    });

    expect(duplicate.rawEventId).toBe(first.rawEventId);
    expect(store.listRawEvents()).toEqual([
      expect.objectContaining({
        rawEventId: first.rawEventId,
        sourceId: "tx-1:token:BUY",
        sourceTimestamp: 123,
        observedTimestamp: 1000,
      }),
    ]);
    expect(store.listRawEventObservations(first.rawEventId)).toEqual([
      expect.objectContaining({ sourceTimestamp: 123, observedTimestamp: 1000 }),
      expect.objectContaining({ sourceTimestamp: 999, observedTimestamp: 2000 }),
    ]);
  });

  it("deduplicates source-less events by the full normalized payload hash", () => {
    const first = store.recordRawEvent({
      payload: { type: "TRADE", nested: { b: 2, a: 1 }, price: 0.5 },
      sourceTimestamp: 123,
      observedTimestamp: 1000,
    });
    const duplicate = store.recordRawEvent({
      payload: { price: 0.5, nested: { a: 1, b: 2 }, type: "TRADE" },
      sourceTimestamp: 123,
      observedTimestamp: 2000,
    });
    expect(duplicate.rawEventId).toBe(first.rawEventId);
    expect(store.listRawEvents()).toHaveLength(1);
  });

  it("links deterministic structured decisions to one raw event", () => {
    const raw = store.recordRawEvent({
      sourceId: "tx-2:token:BUY",
      payload: { type: "TRADE", price: 0.5 },
      sourceTimestamp: 321,
      observedTimestamp: 1000,
    });
    const decision = {
      rawEventId: raw.rawEventId,
      action: "COPY" as const,
      reasonCode: "fixed_order",
      exactTerms: { side: "BUY", price: 0.5, size: 2, feeUsd: 0.01 },
      decidedAt: 1100,
    };
    const first = store.recordDecision(decision);
    const duplicate = store.recordDecision(decision);

    expect(duplicate.decisionId).toBe(first.decisionId);
    expect(store.listDecisions()).toEqual([
      expect.objectContaining({
        rawEventId: raw.rawEventId,
        action: "COPY",
        reasonCode: "fixed_order",
        exactTerms: decision.exactTerms,
      }),
    ]);
  });

  it("links a delayed pending fill back to its original raw event", () => {
    const raw = store.recordRawEvent({
      sourceId: "tx-pending:token:BUY",
      payload: { type: "TRADE", side: "BUY", asset: "token", price: 0.5 },
      sourceTimestamp: 400,
      observedTimestamp: 1000,
    });
    store.recordLiveOrderAccepted({
      tradeKeys: ["tx-pending:token:BUY"],
      leaderId: "leader-a",
      tokenId: "token",
      side: "BUY",
      price: 0.5,
      orderSize: 2,
      filledShares: 0,
      filledUsd: 0,
      auditReason: "fixed order",
      orderId: "order-pending",
      pendingRemaining: 2,
      trackPendingGtc: true,
    });
    store.setDecisionRawEventIds([]);

    store.commitPendingOrderProgress({
      orderId: "order-pending",
      matchedFilledShares: 2,
      matchedFilledUsd: 1,
      fill: {
        leaderId: "leader-a",
        tokenId: "token",
        side: "BUY",
        delta: 2,
        price: 0.5,
        auditReason: "fixed order",
        preview: false,
      },
      remove: true,
    });

    expect(store.listDecisions()).toEqual([
      expect.objectContaining({
        rawEventId: raw.rawEventId,
        action: "COPY",
        exactTerms: expect.objectContaining({
          orderId: "order-pending",
          orderType: "GTC",
          requestedPrice: 0.5,
          requestedShares: 2,
          filledShares: 2,
          filledUsd: 1,
        }),
      }),
    ]);
  });

  it("links a recovered copy success by persisted trade key", () => {
    const raw = store.recordRawEvent({
      sourceId: "tx-recovered:token:SELL",
      payload: { type: "TRADE", side: "SELL", asset: "token", price: 0.6 },
      sourceTimestamp: 500,
      observedTimestamp: 1000,
    });
    store.setDecisionRawEventIds([]);

    store.recordCopySuccess({
      tradeKey: "tx-recovered:token:SELL",
      leaderId: "leader-a",
      tokenId: "token",
      side: "SELL",
      filledShares: 1,
      price: 0.6,
      filledUsd: 0.6,
      auditReason: "recovered confirmed fill",
      preview: false,
    });

    expect(store.listDecisions()).toEqual([
      expect.objectContaining({
        rawEventId: raw.rawEventId,
        action: "SELL",
        exactTerms: expect.objectContaining({
          requestedPrice: 0.6,
          requestedShares: 1,
          filledShares: 1,
          filledUsd: 0.6,
        }),
      }),
    ]);
  });
});
