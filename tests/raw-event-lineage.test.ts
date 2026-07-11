import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
  it("deduplicates repeated logical observations while retaining changed evidence", () => {
    const first = store.recordRawEvent({
      sourceId: "tx-logical:token:BUY",
      payload: { type: "TRADE", price: 0.5, nested: { b: 2, a: 1 } },
      sourceTimestamp: 123,
      observedTimestamp: 1000,
    });
    store.recordRawEvent({
      sourceId: "tx-logical:token:BUY",
      payload: { nested: { a: 1, b: 2 }, price: 0.5, type: "TRADE" },
      sourceTimestamp: 123,
      observedTimestamp: 2000,
    });
    store.recordRawEvent({
      sourceId: "tx-logical:token:BUY",
      payload: { type: "TRADE", price: 0.7, nested: { b: 2, a: 1 } },
      sourceTimestamp: 123,
      observedTimestamp: 3000,
    });
    store.recordRawEvent({
      sourceId: "tx-logical:token:BUY",
      payload: { type: "TRADE", price: 0.5, nested: { b: 2, a: 1 } },
      sourceTimestamp: 124,
      observedTimestamp: 4000,
    });

    expect(store.listRawEvents()).toEqual([
      expect.objectContaining({
        rawEventId: first.rawEventId,
        observedTimestamp: 1000,
      }),
    ]);
    expect(store.listRawEventObservations(first.rawEventId)).toEqual([
      expect.objectContaining({
        payload: { type: "TRADE", price: 0.5, nested: { b: 2, a: 1 } },
        sourceTimestamp: 123,
        observedTimestamp: 1000,
      }),
      expect.objectContaining({
        payload: { type: "TRADE", price: 0.7, nested: { b: 2, a: 1 } },
        sourceTimestamp: 123,
        observedTimestamp: 3000,
      }),
      expect.objectContaining({
        payload: { type: "TRADE", price: 0.5, nested: { b: 2, a: 1 } },
        sourceTimestamp: 124,
        observedTimestamp: 4000,
      }),
    ]);
  });

  it("deduplicates against a legacy observation key without rewriting its first timestamp", () => {
    const raw = store.recordRawEvent({
      sourceId: "tx-legacy:token:BUY",
      payload: { type: "TRADE", price: 0.5 },
      sourceTimestamp: 123,
      observedTimestamp: 1000,
    });
    store.close();
    const dbPath = join(dir, "preview.db");
    const db = new Database(dbPath);
    const legacyKey = createHash("sha256")
      .update([raw.rawEventId, raw.payloadHash, raw.sourceTimestamp, raw.observedTimestamp].join("\n"))
      .digest("hex");
    db.exec("DROP TRIGGER raw_event_observations_no_update");
    db.prepare("UPDATE raw_event_observations SET observation_key = ? WHERE raw_event_id = ?")
      .run(legacyKey, raw.rawEventId);
    db.close();

    store = new StateStore(dbPath);
    store.recordRawEvent({
      sourceId: "tx-legacy:token:BUY",
      payload: { price: 0.5, type: "TRADE" },
      sourceTimestamp: 123,
      observedTimestamp: 2000,
    });

    expect(store.listRawEventObservations(raw.rawEventId)).toEqual([
      expect.objectContaining({
        observationKey: legacyKey,
        sourceTimestamp: 123,
        observedTimestamp: 1000,
      }),
    ]);
  });

  it("preserves legacy duplicate observation evidence while deduplicating future logical observations", () => {
    const raw = store.recordRawEvent({
      sourceId: "tx-legacy-duplicates:token:BUY",
      payload: { type: "TRADE", price: 0.5 },
      sourceTimestamp: 123,
      observedTimestamp: 1000,
    });
    store.close();
    const dbPath = join(dir, "preview.db");
    const db = new Database(dbPath);
    const firstLegacyKey = createHash("sha256")
      .update([raw.rawEventId, raw.payloadHash, raw.sourceTimestamp, 1000].join("\n"))
      .digest("hex");
    const secondLegacyKey = createHash("sha256")
      .update([raw.rawEventId, raw.payloadHash, raw.sourceTimestamp, 2000].join("\n"))
      .digest("hex");
    db.exec(`
      DROP TRIGGER raw_event_observations_no_update;
      UPDATE raw_event_observations SET observation_key='${firstLegacyKey}';
      INSERT INTO raw_event_observations
        (observation_key, raw_event_id, payload_hash, normalized_payload_json, source_timestamp, observed_timestamp)
      SELECT '${secondLegacyKey}', raw_event_id, payload_hash, normalized_payload_json, source_timestamp, 2000
      FROM raw_event_observations WHERE observation_id=(SELECT MIN(observation_id) FROM raw_event_observations);
      DROP TRIGGER decision_observation_links_no_update;
      DROP TRIGGER decision_observation_links_no_delete;
      DROP TRIGGER decision_observation_links_sealed_no_insert;
      DROP TABLE decision_observation_links;
      UPDATE schema_metadata SET value='6' WHERE key='schema_version';
    `);
    db.close();

    store = new StateStore(dbPath);
    expect(store.listRawEventObservations(raw.rawEventId)).toEqual([
      expect.objectContaining({
        observationKey: firstLegacyKey,
        sourceTimestamp: 123,
        observedTimestamp: 1000,
      }),
      expect.objectContaining({
        observationKey: secondLegacyKey,
        sourceTimestamp: 123,
        observedTimestamp: 2000,
      }),
    ]);

    store.recordRawEvent({
      sourceId: "tx-legacy-duplicates:token:BUY",
      payload: { type: "TRADE", price: 0.5 },
      sourceTimestamp: 123,
      observedTimestamp: 3000,
    });
    expect(store.listRawEventObservations(raw.rawEventId)).toHaveLength(2);
  });

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
    store.recordRawEvent({
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

  it("rolls back audit when linked decision persistence fails", () => {
    store.setDecisionRawEventIds(["missing-raw-event"]);
    expect(() => store.audit({ action: "SKIP", reason: "already seen", preview: true })).toThrow();
    expect(store.listAuditLog({ action: "SKIP" }).total).toBe(0);
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
      reasonCode: "copy_executed",
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
        reasonCode: "copy_executed",
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

  it("links a delayed pending fill to the accepted observation after restart and a payload change", () => {
    const dbPath = join(dir, "preview.db");
    const raw = store.recordRawEvent({
      sourceId: "tx-pending-versioned:token:BUY",
      payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token", price: 0.5, candidate: true },
      sourceTimestamp: 400,
      observedTimestamp: 1000,
    });
    store.setDecisionRawEventIds([raw.rawEventId]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token", side: "BUY", price: 0.5, preview: false });
    store.recordLiveOrderAccepted({
      tradeKeys: ["tx-pending-versioned:token:BUY"],
      leaderId: "whale",
      tokenId: "token",
      side: "BUY",
      price: 0.5,
      orderSize: 2,
      filledShares: 0,
      filledUsd: 0,
      auditReason: "fixed order",
      orderId: "order-versioned",
      pendingRemaining: 2,
      trackPendingGtc: true,
    });
    store.setDecisionRawEventIds([]);
    store.close();

    store = new StateStore(dbPath);
    const changed = store.recordRawEvent({
      sourceId: "tx-pending-versioned:token:BUY",
      payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token", price: 0.7, candidate: false },
      sourceTimestamp: 401,
      observedTimestamp: 2000,
    });
    store.setDecisionRawEventIds([changed.rawEventId]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token", side: "BUY", price: 0.7, preview: false });
    store.audit({ leaderId: "whale", action: "SKIP", tokenId: "token", side: "BUY", price: 0.7,
      reason: "price_filter", reasonCode: "price_filter", preview: false });
    store.setDecisionRawEventIds([]);
    store.commitPendingOrderProgress({
      orderId: "order-versioned",
      matchedFilledShares: 2,
      matchedFilledUsd: 1,
      fill: {
        leaderId: "whale", tokenId: "token", side: "BUY", delta: 2, price: 0.5,
        auditReason: "fixed order", preview: false,
      },
      remove: true,
    });

    const db = new Database(dbPath, { readonly: true });
    const copyLink = db.prepare(`SELECT l.observation_id AS observationId
      FROM decision_observation_links l JOIN decisions d ON d.decision_id=l.decision_id
      WHERE d.action='COPY' ORDER BY l.link_order DESC LIMIT 1`).get() as { observationId: number };
    const firstObservation = db.prepare("SELECT MIN(observation_id) AS observationId FROM raw_event_observations")
      .get() as { observationId: number };
    db.close();
    expect(copyLink.observationId).toBe(firstObservation.observationId);
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
