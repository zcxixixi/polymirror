import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RuntimeConfig, LeaderConfig } from "../config/types.js";
import type { Activity } from "../monitor/data-api.js";
import { passActivityFilters } from "../engine/filters.js";
import { calculateOrderSize } from "../engine/sizing.js";
import { prepareExecutableGuardedOrder, prepareGuardedOrderTerms } from "../engine/execution-price.js";
import { quoteExecutableOrderBook, type OrderBookLevelLike } from "../executor/orderbook.js";
import { normalizedPayloadJson } from "./provenance.js";
import { verifyExperimentArchive, type ArchiveVerificationOptions } from "./archive.js";
import type { ExperimentStateSnapshot } from "./manifest.js";

export interface ReplayCoverage { buyPct: number; sellPct: number; totalPct: number }
export interface ReplayPosition { leaderId: string; tokenId: string; shares: number; avgEntryPrice: number }
export interface ReplayEvidenceSummary {
  decisionDigest: string; cashUsd: number; positions: ReplayPosition[];
  realizedPnlUsd: number; coverage: ReplayCoverage;
}
interface StoredDecision { decisionId: string; rawEventId: string; action: string; reasonCode: string; exactTermsJson: string }
interface RawEvidence { rawEventId: string; sourceId: string | null; payloadHash: string; payloadJson: string; observedTimestamp: number }

function round(value: number): number { return Math.round((value + Number.EPSILON) * 1e8) / 1e8; }
function requiredNumber(terms: Record<string, unknown>, key: string): number {
  const value = terms[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid accounting evidence: ${key} is required and finite`);
  return value;
}
function optionalFinite(terms: Record<string, unknown>, key: string): number | undefined {
  const value = terms[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid accounting evidence: ${key} must be finite`);
  return value;
}
function requiredString(terms: Record<string, unknown>, key: string): string {
  const value = terms[key];
  if (typeof value !== "string" || !value) throw new Error(`Invalid decision evidence: ${key} is required`);
  return value;
}
function pct(copied: number, detected: number): number { return detected === 0 ? 0 : Math.round(copied / detected * 10_000) / 100; }
function semanticDigest(rows: Array<{ rawEventId: string; action: string; reasonCode: string; exactTermsJson: string }>): string {
  return createHash("sha256").update(rows.map((row) =>
    [row.rawEventId, row.action, row.reasonCode, row.exactTermsJson].join("\n")
  ).sort().join("\n---\n")).digest("hex");
}
function stateKey(leaderId: string, tokenId: string): string { return `${leaderId}\n${tokenId}`; }

function loadEvidence(db: Database.Database, experimentId: string): { raw: RawEvidence[]; decisions: StoredDecision[] } {
  const raw = db.prepare(`SELECT raw_event_id AS rawEventId, source_id AS sourceId, payload_hash AS payloadHash,
    normalized_payload_json AS payloadJson, observed_timestamp AS observedTimestamp
    FROM raw_events WHERE experiment_id=? ORDER BY observed_timestamp, raw_event_id`).all(experimentId) as RawEvidence[];
  const decisions = db.prepare(`SELECT decision_id AS decisionId, raw_event_id AS rawEventId, action,
    reason_code AS reasonCode, exact_terms_json AS exactTermsJson FROM decisions
    WHERE experiment_id=? ORDER BY decided_at, decision_id`).all(experimentId) as StoredDecision[];
  const rawIds = new Set(raw.map((row) => row.rawEventId));
  if (decisions.some((row) => !rawIds.has(row.rawEventId))) throw new Error("Replay evidence has decisions without stored raw events");
  for (const row of raw) {
    if (sha256Text(row.payloadJson) !== row.payloadHash) throw new Error("Replay raw observation payload checksum mismatch");
    const observations = db.prepare(`SELECT payload_hash AS payloadHash, normalized_payload_json AS payloadJson
      FROM raw_event_observations WHERE raw_event_id=?`).all(row.rawEventId) as { payloadHash: string; payloadJson: string }[];
    if (decisions.some((d) => d.rawEventId === row.rawEventId) && observations.length === 0) throw new Error("Replay evidence has decisions without stored raw observation evidence");
    for (const observation of observations) if (sha256Text(observation.payloadJson) !== observation.payloadHash) throw new Error("Replay raw observation payload checksum mismatch");
  }
  return { raw, decisions };
}
function sha256Text(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function validateAndApplyTrade(
  config: RuntimeConfig, leader: LeaderConfig, activity: Activity, decisions: StoredDecision[],
  positions: Map<string, ReplayPosition>, cashRef: { value: number }, realizedRef: { value: number }
): { detectedBuy: number; detectedSell: number; copiedBuy: number; copiedSell: number } {
  const side = activity.side;
  if (!activity.asset || !side || (side !== "BUY" && side !== "SELL")) throw new Error("Re-execution requires complete TRADE asset and side evidence");
  const detected = decisions.find((d) => d.action === "DETECT");
  if (!detected) throw new Error("Re-execution decision digest mismatch: missing DETECT");
  if (detected.reasonCode !== "detected") throw new Error("Re-execution decision digest mismatch: DETECT reason code differs");
  const detectTerms = JSON.parse(detected.exactTermsJson) as Record<string, unknown>;
  if (requiredString(detectTerms, "leaderId") !== leader.id || requiredString(detectTerms, "tokenId") !== activity.asset ||
    requiredString(detectTerms, "side") !== side) throw new Error("Re-execution decision digest mismatch: fabricated DETECT terms");
  const filter = passActivityFilters(leader, activity);
  if (!filter.pass) {
    if (!decisions.some((d) => d.action === "SKIP" && JSON.parse(d.exactTermsJson).reason === filter.reason)) {
      throw new Error("Re-execution decision digest mismatch: filter decision differs");
    }
    return { detectedBuy: side === "BUY" ? 1 : 0, detectedSell: side === "SELL" ? 1 : 0, copiedBuy: 0, copiedSell: 0 };
  }
  const readModel = {
    getPosition: (leaderId: string, tokenId: string) => positions.get(stateKey(leaderId, tokenId))?.shares ?? 0,
    getPositionCostUsd: (leaderId: string, tokenId: string) => {
      const position = positions.get(stateKey(leaderId, tokenId)); return position ? position.shares * position.avgEntryPrice : 0;
    },
  };
  const sizing = calculateOrderSize(leader, config.app.global, activity, readModel);
  const action = side === "BUY" ? "COPY" : "SELL";
  const copied = decisions.find((d) => d.action === action);
  if (!copied) {
    const skipped = decisions.find((d) => d.action === "SKIP");
    if (!skipped) throw new Error("Re-execution decision digest mismatch: missing terminal decision");
    const skipTerms = JSON.parse(skipped.exactTermsJson) as Record<string, unknown>;
    const reason = typeof skipTerms.reason === "string" ? skipTerms.reason : "";
    const permitted = sizing.belowMinimum
      ? reason === sizing.reasoning
      : side === "BUY" && sizing.finalUsd > cashRef.value
        ? reason === `preview cash $${cashRef.value.toFixed(2)} < order $${sizing.finalUsd.toFixed(2)}`
        : reason === "already seen" || reason === "recent buy dedup";
    if (!permitted) throw new Error("Re-execution decision digest mismatch: fabricated SKIP decision");
    return { detectedBuy: side === "BUY" ? 1 : 0, detectedSell: side === "SELL" ? 1 : 0, copiedBuy: 0, copiedSell: 0 };
  }
  if (copied.reasonCode !== (side === "BUY" ? "copy_executed" : "sell_executed")) {
    throw new Error("Re-execution decision digest mismatch: execution reason code differs");
  }
  const terms = JSON.parse(copied.exactTermsJson) as Record<string, unknown>;
  const requestedShares = requiredNumber(terms, "requestedShares");
  const requestedPrice = requiredNumber(terms, "requestedPrice");
  const filledShares = requiredNumber(terms, "filledShares");
  const filledUsd = requiredNumber(terms, "filledUsd");
  const feeUsd = requiredNumber(terms, "feeUsd");
  if (requiredString(terms, "leaderId") !== leader.id || requiredString(terms, "tokenId") !== activity.asset || requiredString(terms, "side") !== side) {
    throw new Error("Re-execution decision digest mismatch: leader/token/side differs");
  }
  if (config.app.global.copyPriceMode === "leader_limit") {
    if (Math.abs(requestedShares - sizing.finalShares) > 1e-8 || Math.abs(requestedPrice - (activity.price ?? NaN)) > 1e-8) {
      throw new Error("Re-execution decision digest mismatch: sizing/order terms differ");
    }
    if (Math.abs(filledUsd - filledShares * requestedPrice) > 1e-6) throw new Error("Quote/order terms do not match leader-limit evidence");
  } else {
    const evidence = terms.quoteEvidence;
    if (!evidence || typeof evidence !== "object") throw new Error("Guarded replay requires stored quote evidence");
    const quoteEvidence = evidence as Record<string, unknown>;
    if (!Array.isArray(quoteEvidence.levels)) throw new Error("Guarded replay quote levels are required");
    const tickSize = requiredNumber(quoteEvidence, "tickSize");
    const minOrderShares = requiredNumber(quoteEvidence, "minOrderShares");
    const feeRate = requiredNumber(quoteEvidence, "feeRate");
    const feeExponent = requiredNumber(quoteEvidence, "feeExponent");
    const leaderPrice = requiredNumber(terms, "leaderPrice");
    const prepared = prepareGuardedOrderTerms({ side, leaderPrice, targetUsd: sizing.finalUsd,
      targetShares: sizing.finalShares, minOrderUsd: config.app.global.risk.minOrderUsd,
      absoluteTolerance: config.app.global.risk.slippageTolerance, tickSize });
    if (!prepared.allow || prepared.orderPrice === null) throw new Error("Stored quote evidence cannot produce a guarded order");
    const quote = quoteExecutableOrderBook(quoteEvidence.levels as OrderBookLevelLike[], side,
      prepared.orderShares, prepared.orderPrice, minOrderShares,
      side === "BUY" ? Math.round(prepared.orderUsd * 100) / 100 : undefined);
    const guarded = prepareExecutableGuardedOrder({ side, leaderPrice,
      executablePrice: quote.fullyFillable ? quote.averagePrice : quote.bestPrice,
      targetUsd: sizing.finalUsd, targetShares: sizing.finalShares,
      minOrderUsd: config.app.global.risk.minOrderUsd,
      absoluteTolerance: config.app.global.risk.slippageTolerance, tickSize });
    if (!quote.fullyFillable || !quote.meetsMinOrderSize || !guarded.allow || guarded.orderPrice === null) throw new Error("Stored quote evidence rejects guarded execution");
    if (Math.abs(requestedPrice - guarded.orderPrice) > 1e-8 || Math.abs(requestedShares - guarded.orderShares) > 1e-8) throw new Error("Quote/order terms mismatch during guarded re-execution");
    if (optionalFinite(terms, "quoteBestPrice") !== quote.averagePrice || optionalFinite(terms, "guardedTickSize") !== tickSize ||
      optionalFinite(terms, "guardedFeeRate") !== feeRate || optionalFinite(terms, "guardedFeeExponent") !== feeExponent) {
      throw new Error("Stored quote metadata mismatch during guarded re-execution");
    }
    if (Math.abs(filledUsd - filledShares * requestedPrice) > 1e-6) throw new Error("Quote/order fill notional mismatch");
  }
  if (filledShares <= 0 || filledShares - requestedShares > 1e-8 || filledUsd < 0 || feeUsd < 0) throw new Error("Invalid accounting evidence: fill bounds");
  const key = stateKey(leader.id, activity.asset);
  const current = positions.get(key) ?? { leaderId: leader.id, tokenId: activity.asset, shares: 0, avgEntryPrice: 0 };
  if (side === "BUY") {
    const cost = filledUsd + feeUsd; const next = current.shares + filledShares;
    current.avgEntryPrice = (current.shares * current.avgEntryPrice + cost) / next; current.shares = next;
    positions.set(key, current); cashRef.value -= cost;
  } else {
    if (filledShares - current.shares > 1e-8) throw new Error("Invalid accounting evidence: oversell");
    const proceeds = filledUsd - feeUsd; const cost = filledShares * current.avgEntryPrice;
    current.shares -= filledShares; cashRef.value += proceeds; realizedRef.value += proceeds - cost;
    if (current.shares <= 1e-12) positions.delete(key); else positions.set(key, current);
  }
  return { detectedBuy: side === "BUY" ? 1 : 0, detectedSell: side === "SELL" ? 1 : 0, copiedBuy: side === "BUY" ? 1 : 0, copiedSell: side === "SELL" ? 1 : 0 };
}

export function replayEvidence(dbPath: string, experimentId: string): ReplayEvidenceSummary {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const experiment = db.prepare(`SELECT canonical_config_json AS configJson, sealed_at AS sealedAt,
      start_state_json AS startStateJson, schema_version AS schemaVersion FROM experiments WHERE experiment_id=?`).get(experimentId) as
      { configJson: string; sealedAt: number | null; startStateJson: string; schemaVersion: number } | undefined;
    if (!experiment || experiment.sealedAt === null) throw new Error("Deterministic replay requires sealed experiment evidence");
    if (experiment.schemaVersion < 5) throw new Error("Legacy experiment lacks a trustworthy scoped start baseline");
    const config = JSON.parse(experiment.configJson) as RuntimeConfig;
    const start = JSON.parse(experiment.startStateJson) as ExperimentStateSnapshot;
    const cash = { value: start.cashUsd }; const realized = { value: start.realizedPnlUsd };
    const positions = new Map(start.positions.map((p) => [stateKey(p.leaderId, p.tokenId), { ...p }]));
    const evidence = loadEvidence(db, experimentId);
    let detectedBuy = 0, detectedSell = 0, copiedBuy = 0, copiedSell = 0;
    for (const raw of evidence.raw) {
      const decisions = evidence.decisions.filter((decision) => decision.rawEventId === raw.rawEventId);
      if (decisions.length === 0) continue;
      const payload = JSON.parse(raw.payloadJson) as Activity & { leaderId?: string };
      const leaderId = payload.leaderId;
      if (!leaderId) throw new Error("Re-execution requires immutable raw leaderId context");
      const leader = config.app.leaders.find((candidate) => candidate.id === leaderId);
      if (!leader) throw new Error(`Re-execution leader is absent from canonical config: ${leaderId}`);
      if ((payload as Activity & { candidate?: boolean }).candidate === false) {
        const rejection = (payload as Activity & { rejectionReasonCode?: string | null }).rejectionReasonCode ?? "poll_rejected_activity";
        if (!decisions.some((decision) => decision.action === "DETECT") ||
          !decisions.some((decision) => decision.action === "SKIP" && decision.reasonCode === rejection)) {
          throw new Error("Re-execution decision digest mismatch: poll rejection differs");
        }
        continue;
      }
      if (payload.type === "TRADE") {
        if (!payload.asset || !payload.side) {
          if (!decisions.some((decision) => decision.action === "SKIP" && decision.reasonCode === "unsupported_or_incomplete_activity")) {
            throw new Error("Re-execution decision digest mismatch: incomplete activity decision differs");
          }
          continue;
        }
        const result = validateAndApplyTrade(config, leader, payload, decisions, positions, cash, realized);
        detectedBuy += result.detectedBuy; detectedSell += result.detectedSell;
        copiedBuy += result.copiedBuy; copiedSell += result.copiedSell;
      } else if (payload.type === "REDEEM" || (payload as { type?: string }).type === "AUTO_SETTLEMENT") {
        const redeem = decisions.find((decision) => decision.action === "REDEEM");
        if (!redeem) continue;
        if (redeem.reasonCode !== "redeem_settled") throw new Error("Re-execution decision digest mismatch: REDEEM reason code differs");
        const terms = JSON.parse(redeem.exactTermsJson) as Record<string, unknown>;
        const payout = requiredNumber(terms, "grossPayoutUsd"); const cost = requiredNumber(terms, "costBasisUsd");
        const conditionId = requiredString(terms, "conditionId");
        const winnerTokenIds = terms.winnerTokenIds;
        if (!Array.isArray(winnerTokenIds) || winnerTokenIds.some((token) => typeof token !== "string")) {
          throw new Error("Outcome evidence requires winnerTokenIds");
        }
        const winners = new Set(winnerTokenIds as string[]);
        let actualCost = 0;
        let actualPayout = 0;
        const markets = new Map((db.prepare("SELECT token_id AS tokenId, condition_id AS conditionId FROM token_markets").all() as { tokenId: string; conditionId: string }[]).map((m) => [m.tokenId, m.conditionId]));
        for (const [key, position] of positions) if (position.leaderId === leaderId && markets.get(position.tokenId) === conditionId) {
          actualCost += position.shares * position.avgEntryPrice;
          if (winners.has(position.tokenId)) actualPayout += position.shares;
          positions.delete(key);
        }
        if (Math.abs(actualCost - cost) > 1e-6) throw new Error("Outcome evidence cost basis mismatch");
        if (Math.abs(actualPayout - payout) > 1e-6) throw new Error("Outcome evidence payout mismatch");
        cash.value += payout; realized.value += payout - cost;
      }
    }
    const recomputedRows = evidence.decisions.map(({ rawEventId, action, reasonCode, exactTermsJson }) => ({ rawEventId, action, reasonCode, exactTermsJson }));
    return {
      decisionDigest: semanticDigest(recomputedRows), cashUsd: round(cash.value), realizedPnlUsd: round(realized.value),
      positions: [...positions.values()].map((p) => ({ ...p, shares: round(p.shares), avgEntryPrice: round(p.avgEntryPrice) }))
        .sort((a, b) => stateKey(a.leaderId, a.tokenId).localeCompare(stateKey(b.leaderId, b.tokenId))),
      coverage: { buyPct: pct(copiedBuy, detectedBuy), sellPct: pct(copiedSell, detectedSell), totalPct: pct(copiedBuy + copiedSell, detectedBuy + detectedSell) },
    };
  } finally { db.close(); }
}

export function captureStoredEvidenceBaseline(dbPath: string, experimentId: string): ReplayEvidenceSummary {
  const derived = replayEvidence(dbPath, experimentId);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT end_state_json AS endStateJson FROM experiments WHERE experiment_id=?")
      .get(experimentId) as { endStateJson: string | null };
    if (!row.endStateJson) throw new Error("Sealed experiment is missing scoped end baseline");
    const end = JSON.parse(row.endStateJson) as ExperimentStateSnapshot;
    return { ...derived, cashUsd: round(end.cashUsd), positions: end.positions, realizedPnlUsd: round(end.realizedPnlUsd) };
  } finally { db.close(); }
}

export interface ReplayVerificationResult { match: boolean; expected: ReplayEvidenceSummary; actual: ReplayEvidenceSummary; mismatches: string[] }
export function verifyExperimentReplay(manifestPath: string, options: ArchiveVerificationOptions): ReplayVerificationResult {
  const archive = verifyExperimentArchive(manifestPath, options);
  if (!archive.valid) throw new Error(`Archive trust verification failed: ${archive.errors.join("; ")}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { experimentId: string; files: { path: string }[]; replayBaseline: ReplayEvidenceSummary };
  const snapshotPath = resolve(dirname(manifestPath), manifest.files[0]!.path);
  const actual = replayEvidence(snapshotPath, manifest.experimentId); const expected = manifest.replayBaseline;
  const mismatches = (["decisionDigest", "cashUsd", "positions", "realizedPnlUsd", "coverage"] as const)
    .filter((key) => normalizedPayloadJson(actual[key]) !== normalizedPayloadJson(expected[key]));
  return { match: mismatches.length === 0, expected, actual, mismatches };
}
