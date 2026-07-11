import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { archiveExperimentEvidence } from "../src/experiments/archive.js";
import { verifyExperimentReplay } from "../src/experiments/replay-verify.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "pm-replay-verify-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("sealed deterministic replay", () => {
  it("fails closed for a schema-v7 experiment without observation-context decision identities", async () => {
    const dbPath = join(dir, "legacy-links.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "legacy-links", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "legacy" });
    store.close();
    const db = new Database(dbPath);
    db.exec("DROP TRIGGER experiments_immutable_core");
    db.prepare("UPDATE experiments SET schema_version=7 WHERE experiment_id=?").run(exp.experimentId);
    db.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "legacy-links-archive") })).rejects.toThrow(/legacy|observation-context decision identities/i);
  });

  it("replays the exact production TOKEN_SETTLEMENT payload without leaderId", async () => {
    const dbPath = join(dir, "token-settlement.db"); const store = new StateStore(dbPath);
    const config = previewRuntimeConfig(); config.app.global.risk.startingCapitalUsd = 10;
    store.applyCopyFill("whale", "winner", "BUY", 3, 0.333333); store.adjustCash(-1, 10);
    const exp = store.startOrResumeExperiment({ accountId: "token-settlement", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "token-settlement-observation:winner",
      payload: { type: "TOKEN_SETTLEMENT", tokenId: "winner", settlement: { settled: true, payoutPerShare: 0.333333, conditionId: "condition" } },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionRawEventIds([raw.rawEventId]);
    store.audit({ action: "DETECT", tokenId: "winner", side: "REDEEM", price: 0.333333, reason: "token settlement detected", preview: true });
    store.recordTokenSettlement("winner", 0.333333, true, 10, { settlementSource: "token_resolution", conditionId: "condition" });
    store.setDecisionRawEventIds([]); store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "token-settlement-archive") });
    expect(verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath }).match).toBe(true);
  });
  it("reconstructs a known BUY, SELL, and REDEEM sequence", async () => {
    const dbPath = join(dir, "source.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 2 };
    const exp = store.startOrResumeExperiment({
      accountId: "candidate-a", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate",
    }, 100);
    const raw = [
      { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-a", price: 0.5, size: 10, timestamp: 1 },
      { leaderId: "whale", type: "TRADE", side: "SELL", asset: "token-a", price: 0.75, size: 10, timestamp: 2 },
      { leaderId: "whale", type: "REDEEM", conditionId: "condition-a", timestamp: 3 },
    ].map((payload, index) => store.recordRawEvent({ sourceId: ["buy", "sell", "redeem"][index], payload, sourceTimestamp: index + 1, observedTimestamp: index + 1 }));
    store.upsertTokenMarket({ tokenId: "token-a", conditionId: "condition-a" });
    store.recordDecision({ rawEventId: raw[0]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY", size: 10, price: 0.5, preview: true }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw[0]!.rawEventId, action: "COPY", reasonCode: "copy_executed", exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY", requestedShares: 4, requestedPrice: 0.5, filledShares: 4, filledUsd: 2, feeUsd: 0, reason: "Fixed $2.00", preview: true }, decidedAt: 2 });
    store.applyCopyFill("whale", "token-a", "BUY", 4, 0.5);
    store.adjustCash(-2, 10);
    store.recordDecision({ rawEventId: raw[1]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "token-a", side: "SELL", size: 10, price: 0.75, preview: true }, decidedAt: 3 });
    store.recordDecision({ rawEventId: raw[1]!.rawEventId, action: "SELL", reasonCode: "sell_executed", exactTerms: { leaderId: "whale", tokenId: "token-a", side: "SELL", requestedShares: 2.67, requestedPrice: 0.75, filledShares: 2, filledUsd: 1.5, feeUsd: 0, reason: "Fixed $2.00", preview: true }, decidedAt: 4 });
    const sell = store.applyCopyFill("whale", "token-a", "SELL", 2, 0.75);
    expect(sell.realizedPnl).toBe(0.5);
    store.adjustCash(1.5, 10);
    store.recordDecision({ rawEventId: raw[2]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "condition-a", side: "REDEEM" }, decidedAt: 5 });
    store.recordDecision({ rawEventId: raw[2]!.rawEventId, action: "REDEEM", reasonCode: "redeem_settled", exactTerms: { leaderId: "whale", tokenId: "condition-a", side: "REDEEM", size: 2, price: 1, reason: "settled 1 position(s); pnl $1.00", conditionId: "condition-a", settlementSource: "condition_resolution", winnerTokenIds: ["token-a"], grossPayoutUsd: 2, costBasisUsd: 1, realizedPnlUsd: 1, preview: true }, decidedAt: 6 });
    store.applyCopyFill("whale", "token-a", "SELL", 2, 1);
    store.adjustCash(2, 10);
    store.close();

    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "archive"), sealedAt: 200 });
    const result = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(result.match, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.actual).toMatchObject({ cashUsd: 11.5, realizedPnlUsd: 1.5, coverage: { buyPct: 100, sellPct: 100, totalPct: 100 } });
    expect(result.actual.positions).toEqual([]);
    expect(result.actual.decisionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("suppresses an identical observation after its terminal decision", async () => {
    const dbPath = join(dir, "deduplicated-observation.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({
      accountId: "candidate-deduplicated", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate",
    }, 100);
    const payload = {
      leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-a",
      price: 0.5, size: 10, timestamp: 1,
    };
    const raw = store.recordRawEvent({
      sourceId: "buy", payload, sourceTimestamp: 1, observedTimestamp: 1,
    });
    const repeated = store.recordRawEventOccurrence({
      sourceId: "buy", payload, sourceTimestamp: 1, observedTimestamp: 2,
    });
    expect(store.listRawEventObservations(raw.rawEventId)).toHaveLength(1);
    store.recordDecision({
      rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected",
      exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY", size: 10, price: 0.5, preview: true },
      decidedAt: 1,
    });
    store.recordDecision({
      rawEventId: raw.rawEventId, action: "COPY", reasonCode: "copy_executed",
      exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY", requestedShares: 2,
        requestedPrice: 0.5, filledShares: 2, filledUsd: 1, feeUsd: 0, reason: "Fixed $1.00", preview: true },
      decidedAt: 2,
    });
    store.applyCopyFill("whale", "token-a", "BUY", 2, 0.5);
    store.adjustCash(-1, 10);
    expect(store.recordRawEventOccurrence({
      sourceId: "buy", payload, sourceTimestamp: 1, observedTimestamp: 3,
    })).toMatchObject({ status: "DECIDED", terminalDecisionId: expect.any(String) });
    expect(repeated.status).toBe("RESUMABLE");
    store.close();

    const archived = await archiveExperimentEvidence({
      dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "deduplicated-observation-archive"),
    });
    const result = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(result.match, JSON.stringify(result, null, 2)).toBe(true);
  });

  it("replays ordered decisions for changed payload observations sharing one raw event", async () => {
    const dbPath = join(dir, "changed-observation.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({
      accountId: "candidate-changed", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate",
    }, 100);
    const first = store.recordRawEvent({
      sourceId: "buy", payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-a",
        price: 0.5, size: 10, timestamp: 1 },
      sourceTimestamp: 1, observedTimestamp: 1,
    });
    store.recordDecision({
      rawEventId: first.rawEventId, action: "DETECT", reasonCode: "detected",
      exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY", size: 10, price: 0.5, preview: true },
      decidedAt: 1,
    });
    store.recordDecision({
      rawEventId: first.rawEventId, action: "COPY", reasonCode: "copy_executed",
      exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY", requestedShares: 2,
        requestedPrice: 0.5, filledShares: 2, filledUsd: 1, feeUsd: 0, reason: "Fixed $1.00", preview: true },
      decidedAt: 2,
    });
    store.applyCopyFill("whale", "token-a", "BUY", 2, 0.5);
    store.adjustCash(-1, 10);
    store.recordRawEvent({
      sourceId: "buy", payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-a",
        price: 0.6, size: 10, timestamp: 1 },
      sourceTimestamp: 1, observedTimestamp: 2,
    });
    store.setDecisionRawEventIds([first.rawEventId]);
    store.audit({
      leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.6, preview: true,
    });
    store.audit({
      leaderId: "whale", action: "SKIP", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.6, reason: "already seen", preview: true,
    });
    store.setDecisionRawEventIds([]);
    store.close();

    const archived = await archiveExperimentEvidence({
      dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "changed-observation-archive"),
    });
    const result = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(result.match, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.actual.coverage).toEqual({ buyPct: 50, sellPct: 0, totalPct: 50 });
  });

  it("replays candidate rejection and A-B-A decisions through explicit observation links", async () => {
    const dbPath = join(dir, "linked-occurrences.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({
      accountId: "candidate-linked", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate",
    }, 100);
    const acceptedPayload = {
      leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-a",
      price: 0.5, size: 10, timestamp: 1, candidate: true, rejectionReasonCode: null,
    };
    const accepted = store.recordRawEvent({
      sourceId: "buy", payload: acceptedPayload, sourceTimestamp: 1, observedTimestamp: 1,
    });
    store.setDecisionRawEventIds([accepted.rawEventId]);
    store.audit({
      leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, preview: true,
    });
    store.recordDecision({
      rawEventId: accepted.rawEventId, action: "COPY", reasonCode: "copy_executed",
      exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY", requestedShares: 2,
        requestedPrice: 0.5, filledShares: 2, filledUsd: 1, feeUsd: 0, reason: "Fixed $1.00", preview: true },
      decidedAt: 2,
    });
    store.applyCopyFill("whale", "token-a", "BUY", 2, 0.5);
    store.adjustCash(-1, 10);

    const rejected = store.recordRawEvent({
      sourceId: "buy", payload: { ...acceptedPayload, candidate: false, rejectionReasonCode: "stale_activity" },
      sourceTimestamp: 1, observedTimestamp: 2,
    });
    store.setDecisionRawEventIds([rejected.rawEventId]);
    store.audit({
      leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY", size: 10,
      price: 0.5, reason: "raw activity detected", preview: true,
    });
    store.audit({
      leaderId: "whale", action: "SKIP", tokenId: "token-a", side: "BUY", size: 10,
      price: 0.5, reason: "stale_activity", reasonCode: "stale_activity", preview: true,
    });

    expect(store.recordRawEventOccurrence({
      sourceId: "buy", payload: acceptedPayload, sourceTimestamp: 1, observedTimestamp: 3,
    })).toMatchObject({ status: "DECIDED" });

    store.recordRawEvent({
      sourceId: "buy", payload: acceptedPayload, sourceTimestamp: 2, observedTimestamp: 4,
    });
    store.setDecisionRawEventIds([accepted.rawEventId]);
    store.audit({
      leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, preview: true,
    });
    store.audit({
      leaderId: "whale", action: "SKIP", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, reason: "already seen", preview: true,
    });

    store.recordRawEvent({
      sourceId: "buy", payload: { ...acceptedPayload, price: 0.7, candidate: false, rejectionReasonCode: "price_filter" },
      sourceTimestamp: 3, observedTimestamp: 5,
    });
    store.setDecisionRawEventIds([accepted.rawEventId]);
    store.audit({
      leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.7, reason: "raw activity detected", preview: true,
    });
    store.audit({
      leaderId: "whale", action: "SKIP", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.7, reason: "price_filter", reasonCode: "price_filter", preview: true,
    });

    expect(store.recordRawEventOccurrence({
      sourceId: "buy", payload: { ...acceptedPayload, price: 0.7, candidate: false, rejectionReasonCode: "price_filter" },
      sourceTimestamp: 3, observedTimestamp: 6,
    })).toMatchObject({ status: "DECIDED" });
    store.setDecisionRawEventIds([]);
    store.close();

    const db = new Database(dbPath, { readonly: true });
    const links = db.prepare(`SELECT l.observation_id AS observationId, d.action, d.reason_code AS reasonCode
      FROM decision_observation_links l JOIN decisions d ON d.decision_id=l.decision_id
      ORDER BY l.link_order`).all() as Array<{ observationId: number; action: string; reasonCode: string }>;
    const observationCount = (db.prepare("SELECT COUNT(*) AS count FROM raw_event_observations").get() as { count: number }).count;
    db.close();
    expect(observationCount).toBe(4);
    expect(links.map((link) => [link.observationId, link.action, link.reasonCode])).toEqual([
      [1, "DETECT", "detected"],
      [1, "COPY", "copy_executed"],
      [2, "DETECT", "detected"],
      [2, "SKIP", "stale_activity"],
      [3, "DETECT", "detected"],
      [3, "SKIP", "already_seen"],
      [4, "DETECT", "detected"],
      [4, "SKIP", "price_filter"],
    ]);

    const archived = await archiveExperimentEvidence({
      dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "linked-occurrences-archive"),
    });
    const result = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(result.match, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.actual.coverage).toEqual({ buyPct: 50, sellPct: 0, totalPct: 50 });
  });

  it("replays globally interleaved raw-event occurrences in immutable link order", async () => {
    const dbPath = join(dir, "interleaved.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-interleaved", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const first = store.recordRawEvent({ sourceId: "event-a", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token-a", price: 0.5, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionObservationRefs([store.latestObservationRef(first.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, preview: true });
    store.recordCopySuccess({ tradeKey: "event-a", leaderId: "whale", tokenId: "token-a", side: "BUY",
      filledShares: 2, price: 0.5, filledUsd: 1, auditReason: "Fixed $1.00", preview: true,
      cashInitialUsd: 10, decisionTerms: { requestedPrice: 0.5, requestedShares: 2, filledShares: 2,
        filledUsd: 1, feeUsd: 0 } });

    const second = store.recordRawEvent({ sourceId: "event-b", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token-b", price: 0.4, size: 5, timestamp: 2, candidate: false,
      rejectionReasonCode: "price_filter" }, sourceTimestamp: 2, observedTimestamp: 2 });
    store.setDecisionObservationRefs([store.latestObservationRef(second.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token-b", side: "BUY", size: 5,
      price: 0.4, reason: "raw activity detected", preview: true });
    store.audit({ leaderId: "whale", action: "SKIP", tokenId: "token-b", side: "BUY", size: 5,
      price: 0.4, reason: "price_filter", reasonCode: "price_filter", preview: true });

    store.recordRawEvent({ sourceId: "event-a", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token-a", price: 0.6, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 3 });
    store.setDecisionObservationRefs([store.latestObservationRef(first.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.6, preview: true });
    store.audit({ leaderId: "whale", action: "SKIP", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.6, reason: "already seen", preview: true });
    store.setDecisionRawEventIds([]);
    store.close();

    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "interleaved-archive") });
    const replay = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(replay.match, JSON.stringify(replay, null, 2)).toBe(true);
  });

  it("refuses to seal when a changed raw observation has no decision chain", async () => {
    const dbPath = join(dir, "unlinked-observation.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "candidate-unlinked", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const first = store.recordRawEvent({ sourceId: "event-a", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token-a", price: 0.5, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionObservationRefs([store.latestObservationRef(first.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, preview: true });
    store.audit({ leaderId: "whale", action: "SKIP", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, reason: "position limit", preview: true });
    store.recordRawEvent({ sourceId: "event-a", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token-a", price: 0.6, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 2 });
    store.close();

    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "unlinked-observation-archive") })).rejects.toThrow(/observation|complete|decision/i);
  });

  it("replays cumulative immediate and pending partial fills from persisted production lineage", async () => {
    const dbPath = join(dir, "partial-fills.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.previewMode = false;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1.5 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-partials", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const sourceId = "partial-trade";
    const raw = store.recordRawEvent({ sourceId, payload: { leaderId: "whale", type: "TRADE", side: "BUY",
      asset: "token-a", price: 0.5, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionObservationRefs([store.latestObservationRef(raw.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, preview: false });
    store.recordLiveOrderAccepted({ tradeKeys: [sourceId], leaderId: "whale", tokenId: "token-a", side: "BUY",
      price: 0.5, orderSize: 3, filledShares: 1, filledUsd: 0.5, auditReason: "Fixed $1.50",
      orderId: "order-partial", pendingRemaining: 2, trackPendingGtc: true });
    store.setDecisionRawEventIds([]);
    store.commitPendingOrderProgress({ orderId: "order-partial", matchedFilledShares: 2, matchedFilledUsd: 1,
      fill: { leaderId: "whale", tokenId: "token-a", side: "BUY", delta: 1, price: 0.5,
        auditReason: "Fixed $1.50", preview: false }, remove: false });
    store.commitPendingOrderProgress({ orderId: "order-partial", matchedFilledShares: 3, matchedFilledUsd: 1.5,
      fill: { leaderId: "whale", tokenId: "token-a", side: "BUY", delta: 1, price: 0.5,
        auditReason: "Fixed $1.50", preview: false }, remove: true });
    expect(store.getPosition("whale", "token-a")).toBe(3);
    expect(store.countPendingOrders()).toBe(0);
    expect(store.listDecisions().map((decision) => decision.action)).toEqual(["DETECT", "COPY", "COPY", "COPY"]);
    store.close();

    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "partial-fills-archive") });
    const replay = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(replay.match, JSON.stringify(replay, null, 2)).toBe(true);
  });

  it("persists guarded quote evidence until a zero-immediate-fill GTC order later fills", async () => {
    const dbPath = join(dir, "guarded-pending.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.previewMode = false;
    config.app.global.copyPriceMode = "executable_guarded";
    config.app.global.risk.slippageTolerance = 0.02;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-guarded-pending", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "guarded-pending", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token-a", price: 0.5, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionObservationRefs([store.latestObservationRef(raw.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, preview: false });
    store.recordLiveOrderAccepted({ tradeKeys: ["guarded-pending"], leaderId: "whale", tokenId: "token-a",
      side: "BUY", price: 0.52, leaderPrice: 0.5, executablePrice: 0.51, slippagePct: 2,
      orderSize: 1.93, filledShares: 0, filledUsd: 0, auditReason: "Fixed $1.00",
      orderId: "guarded-order", pendingRemaining: 1.93, trackPendingGtc: true,
      decisionTerms: { orderType: "GTC", requestedPrice: 0.52, requestedShares: 1.93,
        quoteBestPrice: 0.51, guardedTickSize: 0.01, guardedFeeRate: 0, guardedFeeExponent: 0,
        quoteEvidence: { levels: [{ price: "0.51", size: "10" }], tickSize: 0.01,
          minOrderShares: 1, feeRate: 0, feeExponent: 0 } } });
    store.setDecisionRawEventIds([]);
    store.commitPendingOrderProgress({ orderId: "guarded-order", matchedFilledShares: 1.93,
      matchedFilledUsd: 1.0036, fill: { leaderId: "whale", tokenId: "token-a", side: "BUY",
        delta: 1.93, price: 0.52, leaderPrice: 0.5, executablePrice: 0.52, slippagePct: 4,
        auditReason: "Fixed $1.00; pending fill", preview: false }, remove: true });
    expect(store.getPosition("whale", "token-a")).toBe(1.93);
    store.close();

    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "guarded-pending-archive") });
    const replay = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(replay.match, JSON.stringify(replay, null, 2)).toBe(true);
  });

  it("keeps the guarded requested limit distinct from immediate and later fill prices", async () => {
    const dbPath = join(dir, "guarded-partial-prices.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.previewMode = false;
    config.app.global.copyPriceMode = "executable_guarded";
    config.app.global.risk.slippageTolerance = 0.02;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-guarded-prices", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "guarded-prices", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token-a", price: 0.5, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionObservationRefs([store.latestObservationRef(raw.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token-a", side: "BUY",
      size: 10, price: 0.5, preview: false });
    const quoteTerms = { orderType: "GTC", requestedPrice: 0.52, requestedShares: 1.93,
      quoteBestPrice: 0.51, guardedTickSize: 0.01, guardedFeeRate: 0, guardedFeeExponent: 0,
      quoteEvidence: { levels: [{ price: "0.51", size: "10" }], tickSize: 0.01,
        minOrderShares: 1, feeRate: 0, feeExponent: 0 } };
    store.recordLiveOrderAccepted({ tradeKeys: ["guarded-prices"], leaderId: "whale", tokenId: "token-a",
      side: "BUY", price: 0.51, leaderPrice: 0.5, executablePrice: 0.51, slippagePct: 2,
      orderSize: 1.93, filledShares: 1, filledUsd: 0.51, auditReason: "Fixed $1.00",
      orderId: "guarded-partial", pendingRemaining: 0.93, trackPendingGtc: true, decisionTerms: quoteTerms });
    store.setDecisionRawEventIds([]);
    expect(store.listPendingOrders()[0]).toMatchObject({ price: 0.52, size: 1.93 });
    store.commitPendingOrderProgress({ orderId: "guarded-partial", matchedFilledShares: 1.93,
      matchedFilledUsd: 0.9936, fill: { leaderId: "whale", tokenId: "token-a", side: "BUY",
        delta: 0.93, price: 0.52, leaderPrice: 0.5, executablePrice: 0.52, slippagePct: 4,
        auditReason: "Fixed $1.00; pending fill", preview: false }, remove: true });
    expect(store.listDecisions().at(-1)?.exactTerms).toMatchObject({
      requestedPrice: 0.52, price: 0.52, executablePrice: 0.52, slippagePct: 4,
    });
    store.close();

    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "guarded-partial-prices-archive") });
    const replay = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(replay.match, JSON.stringify(replay, null, 2)).toBe(true);
  });

  it("detects when stored outcomes diverge from the decision evidence", async () => {
    const dbPath = join(dir, "diverged.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-b", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "buy", payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token", price: 0.5, size: 10, timestamp: 1 }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY", size: 10, price: 0.5, preview: true }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "COPY", reasonCode: "copy_executed",
      exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY", requestedShares: 2, requestedPrice: 0.5, filledShares: 2, filledUsd: 1, feeUsd: 0, reason: "Fixed $1.00", preview: true }, decidedAt: 2 });
    // Deliberately omit the corresponding cash/position outcome writes.
    store.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "diverged-archive") })).rejects.toThrow(/replay diverges/i);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT sealed_at AS sealedAt, archive_status AS archiveStatus FROM experiments WHERE experiment_id=?")
      .get(exp.experimentId) as { sealedAt: number | null; archiveStatus: string };
    db.close();
    expect(row).toEqual({ sealedAt: null, archiveStatus: "FAILED" });
  });

  it("rejects a correctly classified dynamic SKIP without replayable policy inputs", async () => {
    const dbPath = join(dir, "fabricated-policy-skip.db"); const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "candidate-policy-skip", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "policy-skip", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token", price: 0.5, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionObservationRefs([store.latestObservationRef(raw.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token", side: "BUY",
      size: 10, price: 0.5, preview: true });
    store.audit({ leaderId: "whale", action: "SKIP", tokenId: "token", side: "BUY",
      size: 10, price: 0.5, reason: "global max daily volume", reasonCode: "policy_skip", preview: true });
    store.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "fabricated-policy-skip-archive") })).rejects.toThrow(/cannot prove production SKIP/i);
  });

  it("rejects a pre-seal decision identity rewrite even when its link is remapped", async () => {
    const dbPath = join(dir, "decision-id-tamper.db"); const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "candidate-id-tamper", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "incomplete", payload: { leaderId: "whale", type: "TRADE",
      timestamp: 1, candidate: true }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionObservationRefs([store.latestObservationRef(raw.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", preview: true });
    store.audit({ leaderId: "whale", action: "SKIP", reason: "unsupported or incomplete activity", preview: true });
    store.close();
    const db = new Database(dbPath); db.exec(`PRAGMA foreign_keys=OFF;
      DROP TRIGGER decisions_no_update; DROP TRIGGER decision_observation_links_no_update;
      UPDATE decision_observation_links SET decision_id='${"0".repeat(64)}' WHERE link_id=(SELECT MAX(link_id) FROM decision_observation_links);
      UPDATE decisions SET decision_id='${"0".repeat(64)}' WHERE decision_order=(SELECT MAX(decision_order) FROM decisions);`); db.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "decision-id-tamper-archive") })).rejects.toThrow(/identity hash/i);
  });

  it("replays a partial fill followed by stale GTC remainder cancellation", async () => {
    const dbPath = join(dir, "partial-stale-cancel.db"); const store = new StateStore(dbPath);
    const config = previewRuntimeConfig(); config.app.global.previewMode = false;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1.5 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-stale-cancel", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "stale-cancel", payload: { leaderId: "whale", type: "TRADE",
      side: "BUY", asset: "token", price: 0.5, size: 10, timestamp: 1, candidate: true },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionObservationRefs([store.latestObservationRef(raw.rawEventId)]);
    store.audit({ leaderId: "whale", action: "DETECT", tokenId: "token", side: "BUY",
      size: 10, price: 0.5, preview: false });
    store.recordLiveOrderAccepted({ tradeKeys: ["stale-cancel"], leaderId: "whale", tokenId: "token", side: "BUY",
      price: 0.5, orderSize: 3, filledShares: 0, filledUsd: 0, auditReason: "Fixed $1.50",
      orderId: "stale-order", pendingRemaining: 3, trackPendingGtc: true });
    store.setDecisionRawEventIds([]);
    store.commitPendingOrderProgress({ orderId: "stale-order", matchedFilledShares: 1, matchedFilledUsd: 0.5,
      fill: { leaderId: "whale", tokenId: "token", side: "BUY", delta: 1, price: 0.5,
        auditReason: "Fixed $1.50; pending fill", preview: false }, remove: false,
      reconciliationOnly: true, staleSkipAudit: { leaderId: "whale", tokenId: "token", side: "BUY",
        size: 2, price: 0.5, preview: false } });
    // The cancellation evidence remains append-only, but sealing waits until the
    // bounded confirmed-fill reconciliation tombstone has been retired.
    store.removePendingOrder("stale-order");
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "partial-stale-cancel-archive") });
    expect(verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath }).match).toBe(true);
  });

  it("uses stored market outcomes so REDEEM closes only its condition", async () => {
    const dbPath = join(dir, "conditions.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig(); config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-c", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    store.upsertTokenMarket({ tokenId: "token-a", conditionId: "condition-a" });
    store.upsertTokenMarket({ tokenId: "token-b", conditionId: "condition-b" });
    const raws = [
      { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-a", price: 0.5, size: 10, timestamp: 1 },
      { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-b", price: 0.5, size: 10, timestamp: 2 },
      { leaderId: "whale", type: "REDEEM", conditionId: "condition-a", timestamp: 3 },
    ].map((payload, index) => store.recordRawEvent({ sourceId: ["a", "b", "redeem-a"][index], payload, sourceTimestamp: index, observedTimestamp: index }));
    for (const [index, tokenId] of ["token-a", "token-b"].entries()) {
      store.recordDecision({ rawEventId: raws[index]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId, side: "BUY", size: 10, price: 0.5, preview: true }, decidedAt: index * 2 + 1 });
      store.recordDecision({ rawEventId: raws[index]!.rawEventId, action: "COPY", reasonCode: "copy_executed", exactTerms: { leaderId: "whale", tokenId, side: "BUY", requestedShares: 2, requestedPrice: 0.5, filledShares: 2, filledUsd: 1, feeUsd: 0, reason: "Fixed $1.00", preview: true }, decidedAt: index * 2 + 2 });
      store.applyCopyFill("whale", tokenId, "BUY", 2, 0.5); store.adjustCash(-1, 10);
    }
    store.recordDecision({ rawEventId: raws[2]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "condition-a", side: "REDEEM" }, decidedAt: 5 });
    store.recordDecision({ rawEventId: raws[2]!.rawEventId, action: "REDEEM", reasonCode: "redeem_settled",
      exactTerms: { leaderId: "whale", tokenId: "condition-a", side: "REDEEM", size: 2, price: 1, reason: "settled 1 position(s); pnl $1.00", conditionId: "condition-a", settlementSource: "condition_resolution", winnerTokenIds: ["token-a"], grossPayoutUsd: 2, costBasisUsd: 1, realizedPnlUsd: 1, preview: true }, decidedAt: 6 });
    store.applyCopyFill("whale", "token-a", "SELL", 2, 1); store.adjustCash(2, 10);
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "conditions-archive") });
    const result = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(result.match, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.actual.positions).toEqual([{ leaderId: "whale", tokenId: "token-b", shares: 2, avgEntryPrice: 0.5 }]);
  });

  it("refuses replay when the archived snapshot no longer matches its checksum manifest", async () => {
    const dbPath = join(dir, "tampered.db");
    const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "candidate-d", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "tampered-archive") });
    appendFileSync(archived.snapshotPath, "tampered");
    expect(() => verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath })).toThrow(/checksum|trust/i);
  });

  it("rejects a fabricated COPY decision even when the fabricated ledger matches", async () => {
    const dbPath = join(dir, "fabricated.db"); const store = new StateStore(dbPath);
    const config = previewRuntimeConfig(); config.app.global.risk.startingCapitalUsd = 10;
    const exp = store.startOrResumeExperiment({ accountId: "candidate-e", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "fake", payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token", price: 0.5, size: 10, timestamp: 1 }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", side: "BUY", tokenId: "token", size: 10, price: 0.5, preview: true }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "COPY", reasonCode: "copy_executed", exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY", filledShares: 20, filledUsd: 10, feeUsd: 0, requestedPrice: 0.5, requestedShares: 20, orderType: "GTC", orderStatus: "PREVIEW", preview: true }, decidedAt: 2 });
    store.applyCopyFill("whale", "token", "BUY", 20, 0.5); store.adjustCash(-10, 10); store.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "fabricated-archive") }))
      .rejects.toThrow(/decision digest|re-execution/i);
  });

  it("fails closed on missing accounting fields and oversells", async () => {
    const dbPath = join(dir, "invalid.db"); const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "candidate-f", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "bad", payload: { leaderId: "whale", type: "TRADE", side: "SELL", asset: "token", price: 0.5, size: 2, timestamp: 1 }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "token", side: "SELL", size: 2, price: 0.5, preview: true }, decidedAt: 0 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "SELL", reasonCode: "sell_executed", exactTerms: { leaderId: "whale", tokenId: "token", side: "SELL", filledShares: 2 }, decidedAt: 1 });
    store.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "invalid-archive") }))
      .rejects.toThrow(/filledUsd|oversell|accounting/i);
  });

  it("rejects extra decisions on a rejected candidate and swapped global decision order", async () => {
    const dbPath = join(dir, "ordered.db"); const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "ordered", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    for (const [index, tokenId] of ["a", "b"].entries()) {
      const raw = store.recordRawEvent({ sourceId: `rejected-${tokenId}`,
        payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: tokenId, price: 0.5, size: 1,
          timestamp: index + 1, candidate: false, rejectionReasonCode: "poll_rejected_activity" },
        sourceTimestamp: index + 1, observedTimestamp: index + 1 });
      store.setDecisionRawEventIds([raw.rawEventId]);
      store.audit({ leaderId: "whale", action: "DETECT", tokenId, side: "BUY", size: 1, price: 0.5, reason: "raw activity detected", preview: true });
      store.audit({ leaderId: "whale", action: "SKIP", tokenId, side: "BUY", size: 1, price: 0.5,
        reason: "poll rejected activity", reasonCode: "poll_rejected_activity", preview: true });
      store.setDecisionRawEventIds([]);
    }
    store.close();
    const db = new Database(dbPath); db.exec("DROP TRIGGER decisions_no_update");
    db.exec(`UPDATE decisions SET decision_order=decision_order+10;
      UPDATE decisions SET decision_order=decision_order-12 WHERE raw_event_id=(SELECT raw_event_id FROM raw_events ORDER BY observed_timestamp DESC LIMIT 1)`);
    db.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "ordered-archive") }))
      .rejects.toThrow(/global decision order|decision set mismatch/i);
  });

  it("rejects an extra COPY at write time after an incomplete activity", async () => {
    const dbPath = join(dir, "extra.db"); const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "extra", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "incomplete",
      payload: { leaderId: "whale", type: "TRADE", timestamp: 1, candidate: true }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected",
      exactTerms: { leaderId: "whale", tokenId: null, side: null, size: null, price: null, preview: true }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "SKIP", reasonCode: "unsupported_or_incomplete_activity",
      exactTerms: { leaderId: "whale", tokenId: null, side: null, reason: "fabricated reason", requestedPrice: 0.99 }, decidedAt: 1 });
    expect(() => store.recordDecision({ rawEventId: raw.rawEventId, action: "COPY", reasonCode: "copy_executed",
      exactTerms: { leaderId: "whale", tokenId: "fake", side: "BUY", requestedShares: 1, requestedPrice: 0.5,
        filledShares: 1, filledUsd: 0.5, feeUsd: 0 }, decidedAt: 2 }))
      .toThrow(/terminal decision already exists/i);
    store.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "extra-archive") }))
      .rejects.toThrow(/incomplete trade|decision set mismatch/i);
  });

  it("rejects an extra decision after the exact rejected-candidate pair", async () => {
    const dbPath = join(dir, "rejected-extra.db"); const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "rejected-extra", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "rejected",
      payload: { leaderId: "whale", type: "TRADE", asset: "token", side: "BUY", size: 1, price: 0.5,
        timestamp: 1, candidate: false, rejectionReasonCode: "poll_rejected_activity" },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected",
      exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY", size: 1, price: 0.5,
        reason: "raw activity detected", preview: true }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "SKIP", reasonCode: "poll_rejected_activity",
      exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY", size: 1, price: 0.5,
        reason: "poll rejected activity", preview: true }, decidedAt: 2 });
    expect(() => store.recordDecision({ rawEventId: raw.rawEventId, action: "COPY", reasonCode: "copy_executed",
      exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY" }, decidedAt: 3 }))
      .toThrow(/terminal decision already exists/i);
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "rejected-extra-archive") });
    expect(verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath }).match).toBe(true);
  });

  it("rejects a fabricated AUTO_SETTLEMENT skip reason", async () => {
    const dbPath = join(dir, "auto-skip.db"); const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "auto-skip", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "auto-settle-observation:whale:condition",
      payload: { type: "AUTO_SETTLEMENT", leaderId: "whale", conditionId: "condition", slug: "market",
        resolution: null, resolutionError: "network" }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected",
      exactTerms: { leaderId: "whale", tokenId: "condition", side: "REDEEM", reason: "auto settlement detected" }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "SKIP", reasonCode: "market_unresolved",
      exactTerms: { leaderId: "whale", tokenId: "condition", side: "REDEEM", reason: "settlement evidence unavailable" }, decidedAt: 2 });
    store.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId,
      archiveDir: join(dir, "auto-skip-archive") })).rejects.toThrow(/decision mismatch|settlement/i);
  });
});
