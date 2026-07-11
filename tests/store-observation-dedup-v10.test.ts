import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_VERSION,
  StateStore,
} from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
let dbPath: string;
let store: StateStore;
let experimentId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-store-v10-"));
  dbPath = join(dir, "preview.db");
  store = new StateStore(dbPath);
  const config = previewRuntimeConfig();
  experimentId = store.startOrResumeExperiment({
    accountId: "candidate-a",
    candidateAddresses: config.app.leaders.map((leader) => leader.address!),
    config,
    gitSha: "git-a",
    imageDigest: "image-a",
    lockfileHash: "lock-a",
    trustClass: "candidate",
  }, 500).experimentId;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function occurrence(overrides: Partial<{
  payload: unknown;
  sourceTimestamp: number;
  observedTimestamp: number;
}> = {}) {
  return store.recordRawEventOccurrence({
    sourceId: "activity:one",
    payload: overrides.payload ?? { type: "TRADE", price: 0.5 },
    sourceTimestamp: overrides.sourceTimestamp ?? 100,
    observedTimestamp: overrides.observedTimestamp ?? 1_000,
  });
}

describe("schema v10 observation and decision deduplication", () => {
  it("returns NEW, RESUMABLE, and DECIDED for one immutable observation", () => {
    expect(STATE_SCHEMA_VERSION).toBe(10);
    const first = occurrence();
    expect(first.status).toBe("NEW");
    expect(Object.isFrozen(first.observationRef)).toBe(true);

    const resumable = occurrence({ observedTimestamp: 2_000 });
    expect(resumable).toMatchObject({
      status: "RESUMABLE",
      observationRef: first.observationRef,
    });

    store.recordDecision({
      rawEventId: first.rawEvent.rawEventId,
      observationRefs: [first.observationRef],
      action: "DETECT",
      reasonCode: "detected",
      exactTerms: { stage: "detected" },
      decidedAt: 2_100,
    });
    expect(occurrence({ observedTimestamp: 2_200 }).status).toBe("RESUMABLE");

    const terminal = store.recordDecision({
      rawEventId: first.rawEvent.rawEventId,
      observationRefs: [first.observationRef],
      action: "SKIP",
      reasonCode: "policy_skip",
      exactTerms: { stage: "terminal" },
      decidedAt: 2_300,
    });
    expect(occurrence({ observedTimestamp: 2_400 })).toMatchObject({
      status: "DECIDED",
      observationRef: first.observationRef,
      terminalDecisionId: terminal.decisionId,
    });
    expect(store.listRawEventObservations(first.rawEvent.rawEventId)).toHaveLength(1);

    const changed = occurrence({
      payload: { type: "TRADE", price: 0.7 },
      observedTimestamp: 3_000,
    });
    expect(changed.status).toBe("NEW");
    expect(changed.observationRef).not.toEqual(first.observationRef);
  });

  it("allows one DETECT and one terminal decision per observation", () => {
    const raw = occurrence();
    const detect = {
      rawEventId: raw.rawEvent.rawEventId,
      observationRefs: [raw.observationRef],
      action: "DETECT" as const,
      reasonCode: "detected" as const,
      exactTerms: { stage: "detected" },
      decidedAt: 1_100,
    };
    const firstDetect = store.recordDecision(detect);
    expect(store.recordDecision(detect).decisionId).toBe(firstDetect.decisionId);
    expect(() => store.recordDecision({
      ...detect,
      exactTerms: { stage: "changed-detect" },
    })).toThrow(/DETECT decision already exists/i);

    const terminal = {
      rawEventId: raw.rawEvent.rawEventId,
      observationRefs: [raw.observationRef],
      action: "SKIP" as const,
      reasonCode: "policy_skip" as const,
      exactTerms: { stage: "terminal" },
      decidedAt: 1_200,
    };
    const firstTerminal = store.recordDecision(terminal);
    expect(store.recordDecision(terminal).decisionId).toBe(firstTerminal.decisionId);
    expect(() => store.recordDecision({
      ...terminal,
      action: "COPY",
      reasonCode: "copy_executed",
      exactTerms: { stage: "conflicting-terminal" },
    })).toThrow(/terminal decision already exists/i);
    expect(store.listDecisions()).toHaveLength(2);
  });

  it("keeps partial-fill progress resumable until one terminal fill", () => {
    const raw = occurrence();
    for (const filledShares of [1, 2]) {
      store.recordDecision({
        rawEventId: raw.rawEvent.rawEventId,
        observationRefs: [raw.observationRef],
        action: "COPY",
        reasonCode: "copy_executed",
        exactTerms: { requestedShares: 3, filledShares },
        decidedAt: 1_000 + filledShares,
      });
      expect(occurrence({ observedTimestamp: 2_000 + filledShares }).status)
        .toBe("RESUMABLE");
    }
    const terminal = store.recordDecision({
      rawEventId: raw.rawEvent.rawEventId,
      observationRefs: [raw.observationRef],
      action: "COPY",
      reasonCode: "copy_executed",
      exactTerms: { requestedShares: 3, filledShares: 3 },
      decidedAt: 1_003,
    });
    expect(occurrence({ observedTimestamp: 3_000 })).toMatchObject({
      status: "DECIDED",
      terminalDecisionId: terminal.decisionId,
    });
    expect(store.listDecisions()).toHaveLength(3);
  });

  it("links each evidence-backed audit row to one unique decision", () => {
    const raw = occurrence();
    store.setDecisionObservationRefs([raw.observationRef]);
    store.audit({ action: "DETECT", reason: "seen", preview: true });
    store.audit({
      action: "SKIP",
      reason: "policy skip",
      reasonCode: "policy_skip",
      preview: true,
    });
    store.audit({
      action: "SKIP",
      reason: "policy skip",
      reasonCode: "policy_skip",
      preview: true,
    });

    const rows = store.listAuditLog({ limit: 10 }).items;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => typeof row.decisionId === "string")).toBe(true);
    expect(new Set(rows.map((row) => row.decisionId)).size).toBe(2);

    const db = new Database(dbPath, { readonly: true });
    try {
      const linked = db.prepare(
        `SELECT COUNT(*) AS count FROM audit_log a
         JOIN decisions d ON d.decision_id = a.decision_id`
      ).get() as { count: number };
      expect(linked.count).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe("schema v10 compact persistent aggregates", () => {
  it("aggregates poll counters by UTC hour and survives restart", () => {
    store.recordPollHourlyStats({
      observedAt: 3_600_123,
      fetchedOccurrences: 10,
      uniqueObservations: 6,
      resumedObservations: 2,
      duplicateSuppressed: 2,
      pollErrors: 1,
      copied: 3,
      skipped: 4,
    });
    store.recordPollHourlyStats({
      observedAt: 3_699_999,
      fetchedOccurrences: 5,
      uniqueObservations: 1,
      resumedObservations: 1,
      duplicateSuppressed: 3,
      pollErrors: 0,
      copied: 1,
      skipped: 3,
    });

    expect(store.listPollHourlyStats(experimentId)).toEqual([
      expect.objectContaining({
        experimentId,
        accountId: "candidate-a",
        hourStart: 3_600_000,
        pollCount: 2,
        fetchedOccurrences: 15,
        uniqueObservations: 7,
        resumedObservations: 3,
        duplicateSuppressed: 5,
        pollErrors: 1,
        copied: 4,
        skipped: 7,
        firstPollAt: 3_600_123,
        lastPollAt: 3_699_999,
      }),
    ]);

    store.close();
    store = new StateStore(dbPath);
    expect(store.listPollHourlyStats(experimentId)).toHaveLength(1);
  });

  it("persists, aggregates, resolves, and reactivates settlement failures", () => {
    store.recordSettlementFailure({
      leaderId: "sports",
      conditionId: "condition-a",
      slug: "market-a",
      errorCode: "gamma_schema_incompatible",
      errorMessage: "tick size 0.0025",
      observedAt: 1_000,
    });
    store.recordSettlementFailure({
      leaderId: "sports",
      conditionId: "condition-a",
      slug: "market-a",
      errorCode: "gamma_schema_incompatible",
      errorMessage: "still incompatible",
      observedAt: 2_000,
    });
    expect(store.listActiveSettlementFailures(experimentId)).toEqual([
      expect.objectContaining({
        experimentId,
        accountId: "candidate-a",
        leaderId: "sports",
        conditionId: "condition-a",
        firstSeenAt: 1_000,
        lastSeenAt: 2_000,
        count: 2,
        resolvedAt: null,
        errorMessage: "still incompatible",
      }),
    ]);

    store.close();
    store = new StateStore(dbPath);
    expect(store.listActiveSettlementFailures(experimentId)).toHaveLength(1);
    expect(store.resolveSettlementFailure({
      experimentId,
      leaderId: "sports",
      conditionId: "condition-a",
      resolvedAt: 3_000,
    })).toBe(1);
    expect(store.listActiveSettlementFailures(experimentId)).toEqual([]);
    expect(store.listSettlementFailures(experimentId)[0]?.resolvedAt).toBe(3_000);

    const reactivated = store.recordSettlementFailure({
      experimentId,
      leaderId: "sports",
      conditionId: "condition-a",
      slug: "market-a",
      errorCode: "gamma_schema_incompatible",
      errorMessage: "regressed",
      observedAt: 4_000,
    });
    expect(reactivated).toMatchObject({ count: 3, resolvedAt: null, lastSeenAt: 4_000 });
  });

  it("rejects aggregate inserts, updates, and resolution after sealing", () => {
    store.recordPollHourlyStats({
      observedAt: 1_000,
      fetchedOccurrences: 1,
      uniqueObservations: 1,
      resumedObservations: 0,
      duplicateSuppressed: 0,
      pollErrors: 0,
    });
    store.recordSettlementFailure({
      leaderId: "sports",
      conditionId: "condition-a",
      errorCode: "network",
      errorMessage: "timeout",
      observedAt: 1_000,
    });
    store.close();
    const db = new Database(dbPath);
    db.prepare("UPDATE experiments SET sealed_at = ? WHERE experiment_id = ?")
      .run(2_000, experimentId);
    db.close();
    store = new StateStore(dbPath);

    expect(() => store.recordPollHourlyStats({
      experimentId,
      observedAt: 2_001,
      fetchedOccurrences: 1,
      uniqueObservations: 0,
      resumedObservations: 0,
      duplicateSuppressed: 1,
      pollErrors: 0,
    })).toThrow(/sealed experiment aggregates are immutable/i);
    expect(() => store.recordSettlementFailure({
      experimentId,
      leaderId: "sports",
      conditionId: "condition-a",
      errorCode: "network",
      errorMessage: "timeout",
      observedAt: 2_001,
    })).toThrow(/sealed experiment aggregates are immutable/i);
    expect(() => store.resolveSettlementFailure({
      experimentId,
      leaderId: "sports",
      conditionId: "condition-a",
      resolvedAt: 2_001,
    })).toThrow(/sealed experiment aggregates are immutable/i);
  });
});
