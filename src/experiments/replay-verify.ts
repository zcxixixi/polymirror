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
import { aggregateTrades } from "../engine/aggregate.js";
import { stableSkipReasonCode } from "../state/store.js";
import { calculateCopySlippageLossPct } from "../sim/copy-slippage.js";
import { normalizedPayloadJson } from "./provenance.js";
import { verifyExperimentArchive, type ArchiveVerificationOptions } from "./archive.js";
import type { ExperimentStateSnapshot } from "./manifest.js";

export interface ReplayCoverage { buyPct: number; sellPct: number; totalPct: number }
export interface ReplayPosition { leaderId: string; tokenId: string; shares: number; avgEntryPrice: number }
export interface ReplayEvidenceSummary {
  decisionDigest: string; cashUsd: number; positions: ReplayPosition[];
  realizedPnlUsd: number; coverage: ReplayCoverage;
}
interface StoredDecision { decisionId: string; rawEventId: string; action: string; reasonCode: string; exactTermsJson: string; observationId: number; linkOrder: number }
interface RegeneratedDecision { rawEventId: string; action: string; reasonCode: string; exactTermsJson: string }
interface RawObservationEvidence { rawEventId: string; payloadHash: string; payloadJson: string; sourceTimestamp: number; observedTimestamp: number; observationId: number }
interface RawEvidence { rawEventId: string; sourceId: string | null; payloadHash: string; payloadJson: string; observedTimestamp: number; observationCount: number; rawOrder: number; observations: RawObservationEvidence[] }

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
function replaySkipReasonCode(reason: string): string {
  if (reason === "already seen") return "already_seen";
  if (reason === "recent buy dedup") return "already_seen";
  if (reason.includes("price") || reason.includes("allowlist") || reason.includes("blocked market") || reason.includes("side")) return "price_filter";
  if (reason.includes("cash")) return "cash_limit";
  if (reason.includes("position") || reason.includes("max open")) return "position_limit";
  return "policy_skip";
}
function semanticDigest(rows: Array<{ rawEventId: string; action: string; reasonCode: string; exactTermsJson: string }>): string {
  return createHash("sha256").update(rows.map((row) =>
    [row.rawEventId, row.action, row.reasonCode, row.exactTermsJson].join("\n")
  ).join("\n---\n")).digest("hex");
}
function stateKey(leaderId: string, tokenId: string): string { return `${leaderId}\n${tokenId}`; }
const REPLAY_TERM_KEYS = new Set([
  "leaderId", "tokenId", "side", "size", "price", "leaderPrice", "executablePrice", "slippagePct",
  "feeUsd", "reason", "preview", "orderType", "requestedPrice", "requestedShares", "filledShares",
  "filledUsd", "orderStatus", "pendingRemaining", "quoteBestPrice", "guardedTickSize", "guardedFeeRate",
  "guardedFeeExponent", "quoteEvidence", "settlementSource", "sourceId", "sourceIds", "winnerTokenIds",
  "conditionId", "payoutPerShare", "costBasisUsd", "grossPayoutUsd", "realizedPnlUsd", "transactionHash",
  "outcome", "onChainTxHash",
]);
interface ExpectedSpec { action: string; reasonCode: string; derivedTerms: Record<string, unknown> }
const BASE_DECISION_TERMS: Record<string, unknown> = {
  leaderId: null, tokenId: null, side: null, size: null, price: null, leaderPrice: null,
  executablePrice: null, slippagePct: null, feeUsd: 0, reason: null, preview: true,
};
function normalizedDecisionTerms(terms: Record<string, unknown>): string {
  const replayTerms = Object.fromEntries(Object.entries(terms).filter(([key]) => REPLAY_TERM_KEYS.has(key)));
  return normalizedPayloadJson({ ...BASE_DECISION_TERMS, ...replayTerms });
}
function buildExpectedDecisionSet(rawEventId: string, stored: StoredDecision[], specs: ExpectedSpec[]): RegeneratedDecision[] {
  if (stored.length !== specs.length) throw new Error(`Re-execution decision set mismatch: expected ${specs.length} decisions got ${stored.length}`);
  return specs.map((spec, index) => {
    const comparison = stored[index]!;
    const expected: RegeneratedDecision = {
      rawEventId,
      action: spec.action,
      reasonCode: spec.reasonCode,
      exactTermsJson: normalizedDecisionTerms(spec.derivedTerms),
    };
    const normalizedStored: RegeneratedDecision = {
      rawEventId: comparison.rawEventId,
      action: comparison.action,
      reasonCode: comparison.reasonCode,
      exactTermsJson: normalizedDecisionTerms(JSON.parse(comparison.exactTermsJson) as Record<string, unknown>),
    };
    if (normalizedPayloadJson(expected) !== normalizedPayloadJson(normalizedStored)) {
      throw new Error(`Re-execution decision mismatch at ${rawEventId}#${index}: expected=${expected.exactTermsJson} stored=${normalizedStored.exactTermsJson}`);
    }
    return expected;
  });
}
function normalizeStoredComparison(decision: StoredDecision): RegeneratedDecision {
  const terms = JSON.parse(decision.exactTermsJson) as Record<string, unknown>;
  return { rawEventId: decision.rawEventId, action: decision.action, reasonCode: decision.reasonCode,
    exactTermsJson: normalizedDecisionTerms(terms) };
}
function assertOrderedActions(decisions: StoredDecision[], expected: string[], context: string): void {
  const actual = decisions.map((decision) => decision.action);
  if (actual.length !== expected.length || actual.some((action, index) => action !== expected[index])) {
    throw new Error(`Re-execution decision set mismatch for ${context}: expected ${expected.join(",")} got ${actual.join(",")}`);
  }
}
function expectedSettlementSkip(
  payload: Activity & { resolution?: { closed?: boolean; winnerTokenIds?: string[] } | null },
  observedTimestamp: number, observationCount: number, hasPosition: boolean, maxTradeAgeHours: number,
): { reasonCode: string; reason: string } {
  if ((payload as { type?: string }).type === "AUTO_SETTLEMENT") {
    if (!payload.resolution) return { reasonCode: "settlement_evidence_unavailable", reason: "settlement evidence unavailable" };
    if (!payload.resolution.closed) return { reasonCode: "market_unresolved", reason: "market unresolved" };
    if (!payload.resolution.winnerTokenIds?.length) return { reasonCode: "winner_set_unavailable", reason: "winner set unavailable" };
    return { reasonCode: "no_local_position", reason: "no local position" };
  }
  if (!payload.asset) return { reasonCode: "missing_redeem_token", reason: "missing redeem token" };
  const activityTimestamp = payload.timestamp > 1e12 ? payload.timestamp : payload.timestamp * 1000;
  if (observedTimestamp - activityTimestamp > maxTradeAgeHours * 3_600_000) return { reasonCode: "stale_activity", reason: "stale redeem activity" };
  if ((payload.size ?? 0) < 0.01) return { reasonCode: "below_minimum_activity_size", reason: "below redeem size" };
  if (observationCount > 1) return { reasonCode: "already_seen", reason: "already seen" };
  if (!hasPosition) return { reasonCode: "no_local_position", reason: "no local position" };
  return { reasonCode: "onchain_redeem_failed", reason: "on-chain redeem failed" };
}

function loadEvidence(db: Database.Database, experimentId: string): { raw: RawEvidence[]; decisions: StoredDecision[] } {
  const rawRows = db.prepare(`SELECT r.raw_event_id AS rawEventId, r.source_id AS sourceId, r.payload_hash AS payloadHash,
    r.normalized_payload_json AS payloadJson, r.observed_timestamp AS observedTimestamp,
    (SELECT COUNT(*) FROM raw_event_observations o WHERE o.raw_event_id=r.raw_event_id) AS observationCount,
    (SELECT MIN(observation_id) FROM raw_event_observations o WHERE o.raw_event_id=r.raw_event_id) AS rawOrder
    FROM raw_events r WHERE r.experiment_id=? ORDER BY rawOrder`).all(experimentId) as Array<Omit<RawEvidence, "observations">>;
  const observationStmt = db.prepare(`SELECT payload_hash AS payloadHash,
    normalized_payload_json AS payloadJson, source_timestamp AS sourceTimestamp,
    observed_timestamp AS observedTimestamp, observation_id AS observationId
    FROM raw_event_observations WHERE raw_event_id=? ORDER BY observation_id`);
  const raw = rawRows.map((row): RawEvidence => ({
    ...row,
    observations: (observationStmt.all(row.rawEventId) as Array<Omit<RawObservationEvidence, "rawEventId">>)
      .map((observation) => ({ ...observation, rawEventId: row.rawEventId })),
  }));
  const canonicalDecisions = db.prepare(`SELECT decision_id AS decisionId, decision_order AS decisionOrder
    FROM decisions WHERE experiment_id=?`).all(experimentId) as Array<{ decisionId: string; decisionOrder: number }>;
  const decisions = db.prepare(`SELECT d.decision_id AS decisionId, d.raw_event_id AS rawEventId, d.action,
    d.reason_code AS reasonCode, d.exact_terms_json AS exactTermsJson,
    l.observation_id AS observationId, l.link_order AS linkOrder, d.experiment_id AS decisionExperimentId
    FROM decision_observation_links l JOIN decisions d ON d.decision_id=l.decision_id
    WHERE l.experiment_id=? ORDER BY l.link_order`).all(experimentId) as Array<StoredDecision & { decisionExperimentId: string }>;
  const firstLinkOrderByDecision = new Map<string, number>();
  for (const decision of decisions) {
    const current = firstLinkOrderByDecision.get(decision.decisionId);
    if (current === undefined || decision.linkOrder < current) firstLinkOrderByDecision.set(decision.decisionId, decision.linkOrder);
  }
  const canonicalOrder = [...canonicalDecisions]
    .sort((a, b) => a.decisionOrder - b.decisionOrder)
    .map((decision) => decision.decisionId);
  const firstLinkOrder = [...firstLinkOrderByDecision.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([decisionId]) => decisionId);
  if (canonicalOrder.length !== firstLinkOrder.length || canonicalOrder.some((decisionId, index) => decisionId !== firstLinkOrder[index])) {
    throw new Error("Re-execution decision set mismatch: global decision order or observation link differs");
  }
  const rawIds = new Set(raw.map((row) => row.rawEventId));
  if (decisions.some((row) => !rawIds.has(row.rawEventId))) throw new Error("Replay evidence has decisions without stored raw events");
  const observations = raw.flatMap((row) => row.observations);
  const observationIds = new Set(observations.map((observation) => observation.observationId));
  if (decisions.some((decision) => decision.decisionExperimentId !== experimentId || !observationIds.has(decision.observationId))) {
    throw new Error("Replay decision observation link crosses its experiment or lacks an observation");
  }
  const linkedObservationIds = new Set(decisions.map((decision) => decision.observationId));
  const unlinked = observations.find((observation) => !linkedObservationIds.has(observation.observationId));
  if (unlinked) {
    throw new Error(`Replay evidence has an unlinked raw observation: ${unlinked.observationId}`);
  }
  for (const row of raw) {
    if (sha256Text(row.payloadJson) !== row.payloadHash) throw new Error("Replay raw observation payload checksum mismatch");
    if (decisions.some((d) => d.rawEventId === row.rawEventId) && row.observations.length === 0) throw new Error("Replay evidence has decisions without stored raw observation evidence");
    for (const observation of row.observations) if (sha256Text(observation.payloadJson) !== observation.payloadHash) throw new Error("Replay raw observation payload checksum mismatch");
  }
  return { raw, decisions };
}
function sha256Text(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function tradeDecisionGroups(raw: RawEvidence, decisions: StoredDecision[]): Array<{ activity: Activity & { leaderId?: string; candidate?: boolean; rejectionReasonCode?: string | null }; decisions: StoredDecision[] }> {
  const observationById = new Map(raw.observations.map((observation) => [observation.observationId, observation]));
  const groups: Array<{ observationId: number; activity: Activity & { leaderId?: string; candidate?: boolean; rejectionReasonCode?: string | null }; decisions: StoredDecision[] }> = [];
  for (const decision of decisions) {
    const observation = observationById.get(decision.observationId);
    if (!observation) throw new Error(`Re-execution decision evidence has no matching raw observation: ${raw.rawEventId}`);
    const current = groups.at(-1);
    if (current?.observationId === decision.observationId) {
      current.decisions.push(decision);
    } else {
      groups.push({
        observationId: decision.observationId,
        activity: JSON.parse(observation.payloadJson) as Activity & { leaderId?: string; candidate?: boolean; rejectionReasonCode?: string | null },
        decisions: [decision],
      });
    }
  }
  return groups;
}

function validateAndApplyTrade(
  config: RuntimeConfig, leader: LeaderConfig, activity: Activity, decisions: StoredDecision[],
  positions: Map<string, ReplayPosition>, cashRef: { value: number }, realizedRef: { value: number }
): { detectedBuy: number; detectedSell: number; copiedBuy: number; copiedSell: number; specs: ExpectedSpec[] } {
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
    assertOrderedActions(decisions, ["DETECT", "SKIP"], "filtered trade");
    if (!decisions.some((d) => d.action === "SKIP" && JSON.parse(d.exactTermsJson).reason === filter.reason)) {
      throw new Error("Re-execution decision digest mismatch: filter decision differs");
    }
    return { detectedBuy: side === "BUY" ? 1 : 0, detectedSell: side === "SELL" ? 1 : 0, copiedBuy: 0, copiedSell: 0,
      specs: [
        { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId: leader.id, tokenId: activity.asset, side, size: activity.size ?? null, price: activity.price ?? null, preview: config.app.global.previewMode } },
        { action: "SKIP", reasonCode: replaySkipReasonCode(filter.reason ?? "filter"), derivedTerms: { leaderId: leader.id, tokenId: activity.asset, side, size: activity.size ?? null, price: activity.price ?? null, reason: filter.reason ?? "filter", preview: config.app.global.previewMode } },
      ] };
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
    assertOrderedActions(decisions, ["DETECT", "SKIP"], "skipped trade");
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
    return { detectedBuy: side === "BUY" ? 1 : 0, detectedSell: side === "SELL" ? 1 : 0, copiedBuy: 0, copiedSell: 0,
      specs: [
        { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId: leader.id, tokenId: activity.asset, side, size: activity.size ?? null, price: activity.price ?? null, preview: config.app.global.previewMode } },
        { action: "SKIP", reasonCode: replaySkipReasonCode(reason), derivedTerms: { leaderId: leader.id, tokenId: activity.asset, side,
          size: activity.size ?? null, price: activity.price ?? null, reason, preview: config.app.global.previewMode } },
      ] };
  }
  const trailingDuplicateSkip = decisions.length === 3 && decisions[2]?.action === "SKIP" && decisions[2]?.reasonCode === "already_seen";
  assertOrderedActions(decisions, trailingDuplicateSkip ? ["DETECT", action, "SKIP"] : ["DETECT", action], "executed trade");
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
  const specs: ExpectedSpec[] = [
    { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId: leader.id, tokenId: activity.asset, side, size: activity.size ?? null, price: activity.price ?? null, preview: config.app.global.previewMode } },
    { action, reasonCode: side === "BUY" ? "copy_executed" : "sell_executed", derivedTerms: {
      leaderId: leader.id, tokenId: activity.asset, side, requestedPrice, requestedShares,
      filledShares, filledUsd, feeUsd, reason: sizing.reasoning, preview: config.app.global.previewMode,
    } },
  ];
  if (trailingDuplicateSkip) specs.push({ action: "SKIP", reasonCode: "already_seen", derivedTerms: {
    leaderId: leader.id, tokenId: activity.asset, side, size: activity.size ?? null, price: activity.price ?? null,
    reason: "already seen", preview: config.app.global.previewMode,
  } });
  return { detectedBuy: side === "BUY" ? 1 : 0, detectedSell: side === "SELL" ? 1 : 0, copiedBuy: side === "BUY" ? 1 : 0, copiedSell: side === "SELL" ? 1 : 0, specs };
}

function applyTokenRedeems(
  decisions: StoredDecision[], positions: Map<string, ReplayPosition>, cash: { value: number },
  realized: { value: number }, expectedTokenId?: string
): void {
  for (const decision of decisions.filter((candidate) => candidate.action === "REDEEM")) {
    if (decision.reasonCode !== "redeem_settled") throw new Error("Re-execution decision set mismatch: REDEEM reason");
    const terms = JSON.parse(decision.exactTermsJson) as Record<string, unknown>;
    const leaderId = requiredString(terms, "leaderId");
    const tokenId = requiredString(terms, "tokenId");
    if (expectedTokenId && tokenId !== expectedTokenId) throw new Error("Settlement token identity mismatch");
    const payoutPerShare = requiredNumber(terms, "payoutPerShare");
    const payout = requiredNumber(terms, "grossPayoutUsd");
    const cost = requiredNumber(terms, "costBasisUsd");
    const key = stateKey(leaderId, tokenId); const position = positions.get(key);
    if (!position) throw new Error("Settlement attempts to close a missing position");
    const actualCost = position.shares * position.avgEntryPrice;
    const actualPayout = position.shares * payoutPerShare;
    if (Math.abs(actualCost - cost) > 1e-6 || Math.abs(actualPayout - payout) > 1e-6) throw new Error("Settlement accounting evidence mismatch");
    positions.delete(key); cash.value += payout; realized.value += payout - cost;
  }
}

function legacyReplayEvidence(dbPath: string, experimentId: string): ReplayEvidenceSummary {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const experiment = db.prepare(`SELECT canonical_config_json AS configJson, sealed_at AS sealedAt,
      start_state_json AS startStateJson, schema_version AS schemaVersion FROM experiments WHERE experiment_id=?`).get(experimentId) as
      { configJson: string; sealedAt: number | null; startStateJson: string; schemaVersion: number } | undefined;
    if (!experiment || experiment.sealedAt === null) throw new Error("Deterministic replay requires sealed experiment evidence");
    if (experiment.schemaVersion < 7) throw new Error("Legacy experiment lacks explicit decision observation links");
    const config = JSON.parse(experiment.configJson) as RuntimeConfig;
    const start = JSON.parse(experiment.startStateJson) as ExperimentStateSnapshot;
    const cash = { value: start.cashUsd }; const realized = { value: start.realizedPnlUsd };
    const positions = new Map(start.positions.map((p) => [stateKey(p.leaderId, p.tokenId), { ...p }]));
    const evidence = loadEvidence(db, experimentId);
    const regenerated: RegeneratedDecision[] = [];
    const handledOnchain = new Set<string>();
    let detectedBuy = 0, detectedSell = 0, copiedBuy = 0, copiedSell = 0;
    for (const raw of evidence.raw) {
      const decisions = evidence.decisions.filter((decision) => decision.rawEventId === raw.rawEventId);
      if (decisions.length === 0) throw new Error(`Re-execution decision set mismatch: raw event ${raw.rawEventId} has no decision`);
      const payload = JSON.parse(raw.payloadJson) as Activity & { leaderId?: string; tokenId?: string; settlement?: { settled?: boolean; payoutPerShare?: number; conditionId?: string } | null };
      const rawType = String(payload.type ?? "");
      if (rawType === "TOKEN_SETTLEMENT") {
        const tokenId = requiredString(payload as unknown as Record<string, unknown>, "tokenId");
        const tokenPositions = [...positions.values()].filter((position) => position.tokenId === tokenId).length;
        let specs: ExpectedSpec[];
        if (!payload.settlement) {
          assertOrderedActions(decisions, ["DETECT", "SKIP"], "missing token settlement");
          specs = [
            { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId: null, tokenId, side: "REDEEM", price: null, reason: "token settlement detected" } },
            { action: "SKIP", reasonCode: "settlement_evidence_unavailable", derivedTerms: { leaderId: null, tokenId, side: "REDEEM", reason: "settlement evidence unavailable" } },
          ];
        } else if (!payload.settlement.settled) {
          assertOrderedActions(decisions, ["DETECT", "SKIP"], "unresolved token settlement");
          specs = [
            { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId: null, tokenId, side: "REDEEM", price: payload.settlement.payoutPerShare, reason: "token settlement detected" } },
            { action: "SKIP", reasonCode: "market_unresolved", derivedTerms: { leaderId: null, tokenId, side: "REDEEM", reason: "market unresolved" } },
          ];
        }
        else {
          const settlement = payload.settlement;
          assertOrderedActions(decisions, ["DETECT", ...Array(tokenPositions).fill("REDEEM")], "token settlement");
          const tokenRows = [...positions.values()].filter((position) => position.tokenId === tokenId).sort((a, b) => a.leaderId.localeCompare(b.leaderId));
          specs = [
            { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId: null, tokenId, side: "REDEEM", price: settlement.payoutPerShare, reason: "token settlement detected" } },
            ...tokenRows.map((position) => { const gross = Math.round(position.shares * settlement.payoutPerShare! * 1e6) / 1e6;
              const cost = Math.round(position.shares * position.avgEntryPrice * 1e6) / 1e6; const pnl = Math.round((gross - cost) * 1e6) / 1e6;
              return { action: "REDEEM", reasonCode: "redeem_settled", derivedTerms: {
              leaderId: position.leaderId, tokenId, side: "REDEEM", size: gross, price: position.shares,
              reason: `token settlement payout ${settlement.payoutPerShare}; pnl $${pnl.toFixed(2)}`,
              payoutPerShare: settlement.payoutPerShare, winnerTokenIds: settlement.payoutPerShare! > 0 ? [tokenId] : [],
              costBasisUsd: cost, grossPayoutUsd: gross, realizedPnlUsd: pnl,
              conditionId: settlement.conditionId, settlementSource: "token_resolution",
            } }; }),
          ];
          applyTokenRedeems(decisions, positions, cash, realized, tokenId);
        }
        regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, decisions, specs!)); continue;
      }
      if (rawType === "ONCHAIN_REDEEMABLE") {
        const row = payload as unknown as { tokenId?: string; conditionId?: string; payoutPerShare?: number };
        if (!row.tokenId || !row.conditionId || typeof row.payoutPerShare !== "number") throw new Error("Malformed on-chain redeemable evidence");
        if (handledOnchain.has(raw.rawEventId)) continue;
        const group = evidence.raw.flatMap((candidate) => {
          const value = JSON.parse(candidate.payloadJson) as { type?: string; tokenId?: string; conditionId?: string; payoutPerShare?: number; size?: number };
          return value.type === "ONCHAIN_REDEEMABLE" && value.conditionId === row.conditionId
            ? [{ raw: candidate, row: value }] : [];
        });
        group.forEach((item) => handledOnchain.add(item.raw.rawEventId));
        const tracked = group.filter((item) => [...positions.values()].some((position) => position.tokenId === item.row.tokenId));
        const failed = tracked.some((item) => evidence.decisions.some((decision) => decision.rawEventId === item.raw.rawEventId && decision.action === "SKIP"));
        const localExpected = new Map<string, RegeneratedDecision[]>();
        const redemptionSpecs: ExpectedSpec[] = [];
        if (!failed) for (const item of tracked) {
          const tokenId = item.row.tokenId!; const payoutPerShare = item.row.payoutPerShare!;
          const tokenPositions = [...positions.values()].filter((position) => position.tokenId === tokenId).sort((a, b) => a.leaderId.localeCompare(b.leaderId));
          for (const position of tokenPositions) {
            const gross = round(position.shares * payoutPerShare); const cost = round(position.shares * position.avgEntryPrice); const pnl = round(gross - cost);
            redemptionSpecs.push({ action: "REDEEM", reasonCode: "redeem_settled", derivedTerms: {
              leaderId: position.leaderId, tokenId, side: "REDEEM", size: gross, price: position.shares,
              reason: `token settlement payout ${payoutPerShare}; pnl $${pnl.toFixed(2)}`,
              payoutPerShare, winnerTokenIds: payoutPerShare > 0 ? [tokenId] : [], costBasisUsd: cost,
              grossPayoutUsd: gross, realizedPnlUsd: pnl, settlementSource: "onchain_redeemable",
              conditionId: row.conditionId, onChainTxHash: null, preview: config.app.global.previewMode,
            } });
          }
        }
        for (const item of group) {
          const itemDecisions = evidence.decisions.filter((decision) => decision.rawEventId === item.raw.rawEventId);
          const isTracked = tracked.includes(item);
          const specs: ExpectedSpec[] = [{ action: "DETECT", reasonCode: "detected", derivedTerms: {
            leaderId: null, tokenId: item.row.tokenId!, side: "REDEEM", size: item.row.size ?? null,
            price: item.row.payoutPerShare!, reason: "on-chain redeemable detected", preview: config.app.global.previewMode,
          } }];
          if (!isTracked) specs.push({ action: "SKIP", reasonCode: "untracked_token", derivedTerms: {
            leaderId: null, tokenId: item.row.tokenId!, side: "REDEEM", reason: "untracked token", preview: config.app.global.previewMode,
          } });
          else if (failed) specs.push({ action: "SKIP", reasonCode: "onchain_redeem_failed", derivedTerms: {
            leaderId: null, tokenId: row.conditionId, side: "REDEEM", reason: "on-chain redeem failed", preview: config.app.global.previewMode,
          } });
          else specs.push(...redemptionSpecs);
          assertOrderedActions(itemDecisions, specs.map((spec) => spec.action), "on-chain condition");
          localExpected.set(item.raw.rawEventId, buildExpectedDecisionSet(item.raw.rawEventId, itemDecisions, specs));
        }
        for (const item of group) regenerated.push(localExpected.get(item.raw.rawEventId)![0]!, ...(!tracked.includes(item) ? localExpected.get(item.raw.rawEventId)!.slice(1) : []));
        if (failed) for (const item of tracked) regenerated.push(localExpected.get(item.raw.rawEventId)![1]!);
        else for (let index = 0; index < redemptionSpecs.length; index++) for (const item of tracked) regenerated.push(localExpected.get(item.raw.rawEventId)![index + 1]!);
        if (!failed) for (const spec of redemptionSpecs) {
          const position = positions.get(stateKey(String(spec.derivedTerms.leaderId), String(spec.derivedTerms.tokenId)))!;
          const gross = Number(spec.derivedTerms.grossPayoutUsd); const cost = Number(spec.derivedTerms.costBasisUsd);
          positions.delete(stateKey(position.leaderId, position.tokenId));
          if (config.app.global.previewMode) cash.value += gross;
          realized.value += gross - cost;
        }
        continue;
      }
      const leaderId = payload.leaderId;
      if (!leaderId) throw new Error("Re-execution requires immutable raw leaderId context");
      const leader = config.app.leaders.find((candidate) => candidate.id === leaderId);
      if (!leader) throw new Error(`Re-execution leader is absent from canonical config: ${leaderId}`);
      if (payload.type !== "TRADE" && (payload as Activity & { candidate?: boolean }).candidate === false) {
        const rejection = (payload as Activity & { rejectionReasonCode?: string | null }).rejectionReasonCode ?? "poll_rejected_activity";
        if (!decisions.some((decision) => decision.action === "DETECT") ||
          !decisions.some((decision) => decision.action === "SKIP" && decision.reasonCode === rejection)) {
          throw new Error("Re-execution decision digest mismatch: poll rejection differs");
        }
        assertOrderedActions(decisions, ["DETECT", "SKIP"], "poll rejection");
        regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, decisions, [
          { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId, tokenId: payload.asset ?? payload.conditionId ?? null, side: payload.side ?? payload.type, size: payload.size ?? null, price: payload.price ?? null, reason: "raw activity detected" } },
          { action: "SKIP", reasonCode: rejection, derivedTerms: { leaderId, tokenId: payload.asset ?? payload.conditionId ?? null, side: payload.side ?? payload.type, size: payload.size ?? null, price: payload.price ?? null, reason: "poll rejected activity" } },
        ])); continue;
      }
      if (payload.type === "TRADE") {
        for (const group of tradeDecisionGroups(raw, decisions)) {
          const groupLeaderId = group.activity.leaderId;
          const groupLeader = groupLeaderId
            ? config.app.leaders.find((candidate) => candidate.id === groupLeaderId)
            : undefined;
          if (!groupLeader) throw new Error(`Re-execution leader is absent from canonical config: ${groupLeaderId ?? "missing"}`);
          if (group.decisions[0]?.action !== "DETECT") {
            if (group.decisions.length !== 1 || group.decisions[0]?.action !== "SKIP" || group.decisions[0]?.reasonCode !== "already_seen") {
              throw new Error("Re-execution decision set mismatch: unanchored terminal decision");
            }
            const terms = JSON.parse(group.decisions[0].exactTermsJson) as Record<string, unknown>;
            if (terms.reason !== "already seen") throw new Error("Re-execution decision digest mismatch: fabricated repeated-observation SKIP");
            regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, group.decisions, [
              { action: "SKIP", reasonCode: "already_seen", derivedTerms: {
                leaderId: groupLeader.id, tokenId: group.activity.asset ?? null, side: group.activity.side ?? null,
                size: group.activity.size ?? null, price: group.activity.price ?? null,
                reason: "already seen", preview: config.app.global.previewMode,
              } },
            ]));
            continue;
          }
          if (group.activity.candidate === false) {
            const rejection = group.activity.rejectionReasonCode ?? "poll_rejected_activity";
            assertOrderedActions(group.decisions, ["DETECT", "SKIP"], "poll rejection");
            if (group.decisions[1]?.reasonCode !== rejection) {
              throw new Error("Re-execution decision digest mismatch: poll rejection differs");
            }
            regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, group.decisions, [
              { action: "DETECT", reasonCode: "detected", derivedTerms: {
                leaderId: groupLeader.id, tokenId: group.activity.asset ?? group.activity.conditionId ?? null,
                side: group.activity.side ?? group.activity.type, size: group.activity.size ?? null,
                price: group.activity.price ?? null, reason: "raw activity detected",
              } },
              { action: "SKIP", reasonCode: rejection, derivedTerms: {
                leaderId: groupLeader.id, tokenId: group.activity.asset ?? group.activity.conditionId ?? null,
                side: group.activity.side ?? group.activity.type, size: group.activity.size ?? null,
                price: group.activity.price ?? null, reason: rejection,
              } },
            ]));
            continue;
          }
          if (!group.activity.asset || !group.activity.side) {
            assertOrderedActions(group.decisions, ["DETECT", "SKIP"], "incomplete trade");
            if (group.decisions[1]?.reasonCode !== "unsupported_or_incomplete_activity") {
              throw new Error("Re-execution decision digest mismatch: incomplete activity decision differs");
            }
            regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, group.decisions, [
              { action: "DETECT", reasonCode: "detected", derivedTerms: {
                leaderId: groupLeader.id, tokenId: group.activity.asset ?? null, side: group.activity.side ?? null,
                size: group.activity.size ?? null, price: group.activity.price ?? null, preview: config.app.global.previewMode,
              } },
              { action: "SKIP", reasonCode: "unsupported_or_incomplete_activity", derivedTerms: {
                leaderId: groupLeader.id, tokenId: group.activity.asset ?? null, side: group.activity.side ?? null,
                size: group.activity.size ?? null, price: group.activity.price ?? null,
                reason: "unsupported or incomplete activity", preview: config.app.global.previewMode,
              } },
            ]));
            continue;
          }
          const result = validateAndApplyTrade(config, groupLeader, group.activity, group.decisions, positions, cash, realized);
          detectedBuy += result.detectedBuy; detectedSell += result.detectedSell;
          copiedBuy += result.copiedBuy; copiedSell += result.copiedSell;
          regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, group.decisions, result.specs));
        }
      } else if (payload.type === "REDEEM" || (payload as { type?: string }).type === "AUTO_SETTLEMENT") {
        const redeem = decisions.find((decision) => decision.action === "REDEEM");
        if (!redeem) {
          const skip = expectedSettlementSkip(payload, raw.observedTimestamp, raw.observationCount,
            payload.asset ? positions.has(stateKey(leaderId, payload.asset)) : false, config.app.global.maxTradeAgeHours);
          const auto = (payload as { type?: string }).type === "AUTO_SETTLEMENT";
          assertOrderedActions(decisions, ["DETECT", "SKIP"], `${rawType} skip`);
          regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, decisions, [
            { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId, tokenId: payload.asset ?? payload.conditionId ?? null, side: "REDEEM", size: auto ? null : payload.size ?? null, price: auto ? null : payload.price ?? null, reason: auto ? "auto settlement detected" : "leader redeem detected" } },
            { action: "SKIP", reasonCode: skip.reasonCode, derivedTerms: { leaderId, tokenId: payload.asset ?? payload.conditionId ?? null, side: "REDEEM", reason: skip.reason } },
          ])); continue;
        }
        assertOrderedActions(decisions, ["DETECT", "REDEEM"], `${rawType} settlement`);
        if (redeem.reasonCode !== "redeem_settled") throw new Error("Re-execution decision digest mismatch: REDEEM reason code differs");
        const terms = JSON.parse(redeem.exactTermsJson) as Record<string, unknown>;
        if (terms.settlementSource === "leader_redeem") {
          applyTokenRedeems([redeem], positions, cash, realized);
          regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, decisions, [
            { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId, tokenId: payload.asset ?? payload.conditionId ?? null, side: "REDEEM" } },
            { action: "REDEEM", reasonCode: "redeem_settled", derivedTerms: { leaderId, tokenId: payload.asset ?? null, side: "REDEEM", settlementSource: "leader_redeem" } },
          ])); continue;
        }
        const payout = requiredNumber(terms, "grossPayoutUsd"); const cost = requiredNumber(terms, "costBasisUsd");
        const conditionId = requiredString(terms, "conditionId");
        const winnerTokenIds = terms.winnerTokenIds;
        if (!Array.isArray(winnerTokenIds) || winnerTokenIds.some((token) => typeof token !== "string")) {
          throw new Error("Outcome evidence requires winnerTokenIds");
        }
        const winners = new Set(winnerTokenIds as string[]);
        let actualCost = 0;
        let actualPayout = 0;
        let closedPositions = 0;
        const markets = new Map((db.prepare("SELECT token_id AS tokenId, condition_id AS conditionId FROM token_markets").all() as { tokenId: string; conditionId: string }[]).map((m) => [m.tokenId, m.conditionId]));
        for (const [key, position] of positions) if (position.leaderId === leaderId && markets.get(position.tokenId) === conditionId) {
          actualCost += position.shares * position.avgEntryPrice;
          if (winners.has(position.tokenId)) actualPayout += position.shares;
          closedPositions++;
          positions.delete(key);
        }
        if (Math.abs(actualCost - cost) > 1e-6) throw new Error("Outcome evidence cost basis mismatch");
        if (Math.abs(actualPayout - payout) > 1e-6) throw new Error("Outcome evidence payout mismatch");
        cash.value += payout; realized.value += payout - cost;
        regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, decisions, [
          { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId, tokenId: payload.conditionId ?? null, side: "REDEEM" } },
          { action: "REDEEM", reasonCode: "redeem_settled", derivedTerms: { leaderId, tokenId: conditionId,
            conditionId, side: "REDEEM", size: actualPayout, price: closedPositions,
            reason: `settled ${closedPositions} position(s); pnl $${(actualPayout - actualCost).toFixed(2)}`,
            winnerTokenIds: [...winners].sort(), costBasisUsd: actualCost,
            grossPayoutUsd: actualPayout, realizedPnlUsd: actualPayout - actualCost,
            settlementSource: "condition_resolution" } },
        ]));
      } else throw new Error(`Re-execution decision set mismatch: unsupported raw type ${rawType}`);
    }
    if (regenerated.length !== evidence.decisions.length) throw new Error("Re-execution decision set mismatch: stored extra decision");
    const storedGlobalOrder = evidence.decisions.map(normalizeStoredComparison);
    if (storedGlobalOrder.some((stored, index) => normalizedPayloadJson(stored) !== normalizedPayloadJson(regenerated[index]))) {
      throw new Error("Re-execution decision set mismatch: global decision order or terms differ");
    }
    const recomputedRows = regenerated;
    return {
      decisionDigest: semanticDigest(recomputedRows), cashUsd: round(cash.value), realizedPnlUsd: round(realized.value),
      positions: [...positions.values()].map((p) => ({ ...p, shares: round(p.shares), avgEntryPrice: round(p.avgEntryPrice) }))
        .sort((a, b) => stateKey(a.leaderId, a.tokenId).localeCompare(stateKey(b.leaderId, b.tokenId))),
      coverage: { buyPct: pct(copiedBuy, detectedBuy), sellPct: pct(copiedSell, detectedSell), totalPct: pct(copiedBuy + copiedSell, detectedBuy + detectedSell) },
    };
  } finally { db.close(); }
}

interface DecisionOccurrence {
  decisionId: string;
  rawEventId: string;
  action: string;
  reasonCode: string;
  exactTermsJson: string;
  observationIds: number[];
  firstLinkOrder: number;
}

interface ReplayDecisionGroup {
  key: string;
  observations: RawObservationEvidence[];
  activity?: Activity & { leaderId?: string; candidate?: boolean; rejectionReasonCode?: string | null };
  sizing?: ReturnType<typeof calculateOrderSize>;
  filterReason?: string;
  cumulativeFilledShares: number;
  cumulativeFilledUsd: number;
  copied: boolean;
}

function decisionOccurrences(rows: StoredDecision[]): DecisionOccurrence[] {
  const byId = new Map<string, DecisionOccurrence>();
  for (const row of rows) {
    const existing = byId.get(row.decisionId);
    if (existing) {
      if (existing.action !== row.action || existing.reasonCode !== row.reasonCode ||
        existing.exactTermsJson !== row.exactTermsJson) {
        throw new Error("Replay decision identity has inconsistent immutable fields");
      }
      existing.observationIds.push(row.observationId);
      existing.firstLinkOrder = Math.min(existing.firstLinkOrder, row.linkOrder);
    } else {
      byId.set(row.decisionId, {
        decisionId: row.decisionId,
        rawEventId: row.rawEventId,
        action: row.action,
        reasonCode: row.reasonCode,
        exactTermsJson: row.exactTermsJson,
        observationIds: [row.observationId],
        firstLinkOrder: row.linkOrder,
      });
    }
  }
  return [...byId.values()]
    .map((decision) => ({ ...decision, observationIds: [...decision.observationIds].sort((a, b) => a - b) }))
    .sort((a, b) => a.firstLinkOrder - b.firstLinkOrder);
}

function observationContextKey(observationIds: number[]): string {
  return [...observationIds].sort((a, b) => a - b).join(",");
}

function decisionTerms(decision: DecisionOccurrence): Record<string, unknown> {
  return JSON.parse(decision.exactTermsJson) as Record<string, unknown>;
}

function sameEvidenceValue(actual: unknown, expected: unknown): boolean {
  return normalizedPayloadJson(actual ?? null) === normalizedPayloadJson(expected ?? null);
}

function requireEvidenceValue(terms: Record<string, unknown>, key: string, expected: unknown, context: string): void {
  if (!sameEvidenceValue(terms[key], expected)) {
    throw new Error(`Re-execution decision mismatch for ${context}: ${key}`);
  }
}

function activityForObservations(
  observations: RawObservationEvidence[], config: RuntimeConfig
): Activity & { leaderId?: string; candidate?: boolean; rejectionReasonCode?: string | null } {
  const payloads = observations.map((observation) => JSON.parse(observation.payloadJson) as
    Activity & { leaderId?: string; candidate?: boolean; rejectionReasonCode?: string | null });
  if (payloads.length === 0) throw new Error("Replay decision context has no raw observations");
  if (payloads.every((payload) => payload.type === "TRADE" && payload.candidate !== false)) {
    const leaders = new Set(payloads.map((payload) => payload.leaderId));
    if (leaders.size !== 1 || leaders.has(undefined)) throw new Error("Aggregated replay context has mixed leaders");
    const aggregated = aggregateTrades(payloads.map((activity) => ({ leaderId: activity.leaderId!, activity })),
      config.app.global.tradeAggregationWindowMs);
    if (aggregated.length !== 1) throw new Error("Replay observation context does not form one production aggregate");
    return { ...aggregated[0]!.activity, leaderId: payloads[0]!.leaderId, candidate: true, rejectionReasonCode: null };
  }
  if (payloads.length !== 1) throw new Error("Non-trade or rejected replay decisions require one concrete observation");
  return payloads[0]!;
}

function validateDetect(
  decision: DecisionOccurrence,
  group: ReplayDecisionGroup,
  config: RuntimeConfig,
  positions: Map<string, ReplayPosition>,
  cash: number
): { detectedBuy: number; detectedSell: number } {
  if (decision.reasonCode !== "detected") throw new Error("Re-execution DETECT reason code differs");
  const terms = decisionTerms(decision);
  const activity = activityForObservations(group.observations, config);
  group.activity = activity;
  const type = String(activity.type ?? "");
  if (activity.candidate === false) {
    requireEvidenceValue(terms, "leaderId", activity.leaderId ?? null, "rejected DETECT");
    requireEvidenceValue(terms, "tokenId", activity.asset ?? activity.conditionId ?? null, "rejected DETECT");
    requireEvidenceValue(terms, "side", activity.side ?? activity.type, "rejected DETECT");
    requireEvidenceValue(terms, "size", activity.size ?? null, "rejected DETECT");
    requireEvidenceValue(terms, "price", activity.price ?? null, "rejected DETECT");
    requireEvidenceValue(terms, "reason", "raw activity detected", "rejected DETECT");
    return { detectedBuy: 0, detectedSell: 0 };
  }
  if (type === "TRADE") {
    requireEvidenceValue(terms, "leaderId", activity.leaderId ?? null, "TRADE DETECT");
    requireEvidenceValue(terms, "tokenId", activity.asset ?? null, "TRADE DETECT");
    requireEvidenceValue(terms, "side", activity.side ?? null, "TRADE DETECT");
    requireEvidenceValue(terms, "size", activity.size ?? null, "TRADE DETECT");
    requireEvidenceValue(terms, "price", activity.price ?? null, "TRADE DETECT");
    const leader = config.app.leaders.find((candidate) => candidate.id === activity.leaderId);
    if (!leader) throw new Error(`Re-execution leader is absent from canonical config: ${activity.leaderId ?? "missing"}`);
    if (activity.asset && (activity.side === "BUY" || activity.side === "SELL")) {
      const filter = passActivityFilters(leader, activity);
      group.filterReason = filter.pass ? undefined : filter.reason ?? "filter";
      group.sizing = calculateOrderSize(leader, config.app.global, activity, {
        getPosition: (leaderId: string, tokenId: string) => positions.get(stateKey(leaderId, tokenId))?.shares ?? 0,
        getPositionCostUsd: (leaderId: string, tokenId: string) => {
          const position = positions.get(stateKey(leaderId, tokenId));
          return position ? position.shares * position.avgEntryPrice : 0;
        },
      });
      if (activity.side === "BUY" && group.sizing.finalUsd > cash && terms.preview === false) {
        throw new Error("Live replay cannot use preview cash sizing evidence");
      }
    }
    return { detectedBuy: activity.side === "BUY" ? 1 : 0, detectedSell: activity.side === "SELL" ? 1 : 0 };
  }
  if (type === "REDEEM") {
    const leaderShape = sameEvidenceValue(terms.tokenId, activity.asset ?? null)
      && sameEvidenceValue(terms.size, activity.size ?? null)
      && sameEvidenceValue(terms.price, activity.price ?? null)
      && sameEvidenceValue(terms.reason, "leader redeem detected");
    const copyCycleShape = sameEvidenceValue(terms.tokenId, activity.conditionId ?? null)
      && sameEvidenceValue(terms.size, activity.usdcSize ?? null)
      && sameEvidenceValue(terms.price, null)
      && sameEvidenceValue(terms.reason, activity.title ?? null);
    requireEvidenceValue(terms, "leaderId", activity.leaderId ?? null, "REDEEM DETECT");
    requireEvidenceValue(terms, "side", "REDEEM", "REDEEM DETECT");
    if (!leaderShape && !copyCycleShape) throw new Error("Re-execution production REDEEM DETECT terms differ");
    return { detectedBuy: 0, detectedSell: 0 };
  }
  if (type === "AUTO_SETTLEMENT") {
    requireEvidenceValue(terms, "leaderId", activity.leaderId ?? null, "AUTO_SETTLEMENT DETECT");
    requireEvidenceValue(terms, "tokenId", activity.conditionId ?? null, "AUTO_SETTLEMENT DETECT");
    requireEvidenceValue(terms, "side", "REDEEM", "AUTO_SETTLEMENT DETECT");
    requireEvidenceValue(terms, "reason", "auto settlement detected", "AUTO_SETTLEMENT DETECT");
    return { detectedBuy: 0, detectedSell: 0 };
  }
  if (type === "TOKEN_SETTLEMENT") {
    const settlement = (activity as unknown as { settlement?: { payoutPerShare?: number } | null }).settlement;
    requireEvidenceValue(terms, "leaderId", null, "TOKEN_SETTLEMENT DETECT");
    requireEvidenceValue(terms, "tokenId", (activity as unknown as { tokenId?: string }).tokenId ?? null, "TOKEN_SETTLEMENT DETECT");
    requireEvidenceValue(terms, "side", "REDEEM", "TOKEN_SETTLEMENT DETECT");
    requireEvidenceValue(terms, "price", settlement?.payoutPerShare ?? null, "TOKEN_SETTLEMENT DETECT");
    requireEvidenceValue(terms, "reason", "token settlement detected", "TOKEN_SETTLEMENT DETECT");
    return { detectedBuy: 0, detectedSell: 0 };
  }
  if (type === "ONCHAIN_REDEEMABLE") {
    const row = activity as unknown as { tokenId?: string; size?: number; payoutPerShare?: number };
    requireEvidenceValue(terms, "leaderId", null, "ONCHAIN_REDEEMABLE DETECT");
    requireEvidenceValue(terms, "tokenId", row.tokenId ?? null, "ONCHAIN_REDEEMABLE DETECT");
    requireEvidenceValue(terms, "side", "REDEEM", "ONCHAIN_REDEEMABLE DETECT");
    requireEvidenceValue(terms, "size", row.size ?? null, "ONCHAIN_REDEEMABLE DETECT");
    requireEvidenceValue(terms, "price", row.payoutPerShare ?? null, "ONCHAIN_REDEEMABLE DETECT");
    requireEvidenceValue(terms, "reason", "on-chain redeemable detected", "ONCHAIN_REDEEMABLE DETECT");
    return { detectedBuy: 0, detectedSell: 0 };
  }
  throw new Error(`Re-execution decision set mismatch: unsupported raw type ${type}`);
}

function validateSkip(decision: DecisionOccurrence, group: ReplayDecisionGroup, config: RuntimeConfig): void {
  const terms = decisionTerms(decision);
  const reason = typeof terms.reason === "string" ? terms.reason : "";
  if (!reason) throw new Error("Re-execution SKIP requires an immutable reason");
  const activity = group.activity ?? activityForObservations(group.observations, config);
  if (activity.candidate === false) {
    const expected = activity.rejectionReasonCode ?? "poll_rejected_activity";
    if (decision.reasonCode !== expected || (reason !== expected && reason !== "poll rejected activity")) {
      throw new Error("Re-execution poll rejection differs");
    }
    return;
  }
  if (group.filterReason !== undefined) {
    if (reason !== group.filterReason || decision.reasonCode !== stableSkipReasonCode(reason)) {
      throw new Error("Re-execution static filter SKIP differs");
    }
    return;
  }
  const type = String(activity.type ?? "");
  if (type === "AUTO_SETTLEMENT") {
    const expected = expectedSettlementSkip(activity, group.observations[0]!.observedTimestamp, 1, false,
      config.app.global.maxTradeAgeHours);
    if (decision.reasonCode !== expected.reasonCode || reason !== expected.reason) {
      throw new Error("Re-execution AUTO_SETTLEMENT SKIP differs");
    }
    return;
  }
  if (type === "TOKEN_SETTLEMENT") {
    const settlement = (activity as unknown as { settlement?: { settled?: boolean } | null }).settlement;
    const expected = !settlement ? { reasonCode: "settlement_evidence_unavailable", reason: "settlement evidence unavailable" }
      : !settlement.settled ? { reasonCode: "market_unresolved", reason: "market unresolved" }
        : null;
    if (!expected || decision.reasonCode !== expected.reasonCode || reason !== expected.reason) {
      throw new Error("Re-execution TOKEN_SETTLEMENT SKIP differs");
    }
    return;
  }
  if (decision.reasonCode !== stableSkipReasonCode(reason) &&
    !["untracked_token", "settlement_evidence_unavailable", "market_unresolved", "winner_set_unavailable"].includes(decision.reasonCode)) {
    throw new Error("Re-execution production SKIP reason code differs");
  }
}

function validateAndApplyFill(
  decision: DecisionOccurrence,
  group: ReplayDecisionGroup,
  config: RuntimeConfig,
  positions: Map<string, ReplayPosition>,
  cash: { value: number },
  realized: { value: number }
): { copiedBuy: number; copiedSell: number } {
  const activity = group.activity ?? activityForObservations(group.observations, config);
  if (activity.type !== "TRADE" || !activity.asset || (activity.side !== "BUY" && activity.side !== "SELL")) {
    throw new Error("Re-execution fill lacks a complete TRADE observation context");
  }
  const side = activity.side;
  const expectedAction = side === "BUY" ? "COPY" : "SELL";
  if (decision.action !== expectedAction || decision.reasonCode !== (side === "BUY" ? "copy_executed" : "sell_executed")) {
    throw new Error("Re-execution fill action or reason differs");
  }
  const terms = decisionTerms(decision);
  requireEvidenceValue(terms, "leaderId", activity.leaderId ?? null, "fill");
  requireEvidenceValue(terms, "tokenId", activity.asset, "fill");
  requireEvidenceValue(terms, "side", side, "fill");
  const sizing = group.sizing;
  if (!sizing) throw new Error("Re-execution fill has no prior sizing evidence");
  const requestedShares = requiredNumber(terms, "requestedShares");
  const requestedPrice = requiredNumber(terms, "requestedPrice");
  const cumulativeShares = requiredNumber(terms, "filledShares");
  const cumulativeUsd = requiredNumber(terms, "filledUsd");
  const feeUsd = requiredNumber(terms, "feeUsd");
  if (config.app.global.copyPriceMode === "leader_limit") {
    if (Math.abs(requestedShares - sizing.finalShares) > 1e-8 || Math.abs(requestedPrice - (activity.price ?? NaN)) > 1e-8) {
      throw new Error("Re-execution sizing/order terms differ");
    }
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
    if (!quote.fullyFillable || !quote.meetsMinOrderSize || !guarded.allow || guarded.orderPrice === null ||
      Math.abs(requestedPrice - guarded.orderPrice) > 1e-8 || Math.abs(requestedShares - guarded.orderShares) > 1e-8 ||
      optionalFinite(terms, "quoteBestPrice") !== quote.averagePrice || optionalFinite(terms, "guardedTickSize") !== tickSize ||
      optionalFinite(terms, "guardedFeeRate") !== feeRate || optionalFinite(terms, "guardedFeeExponent") !== feeExponent) {
      throw new Error("Guarded quote/order metadata differs during re-execution");
    }
  }
  const deltaShares = cumulativeShares - group.cumulativeFilledShares;
  const deltaUsd = cumulativeUsd - group.cumulativeFilledUsd;
  if (deltaShares <= 0 || deltaUsd < 0 || cumulativeShares - requestedShares > 1e-8 || feeUsd < 0) {
    throw new Error("Invalid accounting evidence: cumulative fill bounds");
  }
  const executionPrice = optionalFinite(terms, "price") ?? requestedPrice;
  if (Math.abs(deltaUsd - deltaShares * executionPrice) > 1e-6) {
    throw new Error("Execution-price evidence does not match the cumulative fill delta");
  }
  const leaderPrice = optionalFinite(terms, "leaderPrice");
  const executablePrice = optionalFinite(terms, "executablePrice");
  const slippagePct = optionalFinite(terms, "slippagePct");
  if (leaderPrice !== undefined && Math.abs(leaderPrice - (activity.price ?? NaN)) > 1e-8) {
    throw new Error("Stored leader price differs from raw activity");
  }
  if (leaderPrice !== undefined && executablePrice !== undefined && slippagePct !== undefined) {
    const recomputedSlippage = calculateCopySlippageLossPct(side, leaderPrice, executablePrice);
    if (recomputedSlippage === null || Math.abs(recomputedSlippage - slippagePct) > 1e-6) {
      throw new Error("Stored execution slippage differs");
    }
  }
  const key = stateKey(activity.leaderId!, activity.asset);
  const current = positions.get(key) ?? { leaderId: activity.leaderId!, tokenId: activity.asset, shares: 0, avgEntryPrice: 0 };
  if (side === "BUY") {
    const cost = deltaUsd + feeUsd;
    const nextShares = current.shares + deltaShares;
    current.avgEntryPrice = (current.shares * current.avgEntryPrice + cost) / nextShares;
    current.shares = nextShares;
    positions.set(key, current);
    if (config.app.global.previewMode) cash.value -= cost;
  } else {
    if (deltaShares - current.shares > 1e-8) throw new Error("Invalid accounting evidence: oversell");
    const proceeds = deltaUsd - feeUsd;
    const cost = deltaShares * current.avgEntryPrice;
    current.shares -= deltaShares;
    if (config.app.global.previewMode) cash.value += proceeds;
    realized.value += proceeds - cost;
    if (current.shares <= 1e-12) positions.delete(key); else positions.set(key, current);
  }
  group.cumulativeFilledShares = cumulativeShares;
  group.cumulativeFilledUsd = cumulativeUsd;
  const first = !group.copied;
  group.copied = true;
  return { copiedBuy: first && side === "BUY" ? 1 : 0, copiedSell: first && side === "SELL" ? 1 : 0 };
}

function validateAndApplyRedeem(
  decision: DecisionOccurrence,
  group: ReplayDecisionGroup,
  config: RuntimeConfig,
  positions: Map<string, ReplayPosition>,
  cash: { value: number },
  realized: { value: number },
  markets: Map<string, string>
): void {
  if (decision.reasonCode !== "redeem_settled") throw new Error("Re-execution REDEEM reason differs");
  const terms = decisionTerms(decision);
  const leaderId = requiredString(terms, "leaderId");
  const settlementSource = requiredString(terms, "settlementSource");
  const payout = requiredNumber(terms, "grossPayoutUsd");
  const cost = requiredNumber(terms, "costBasisUsd");
  const realizedPnl = requiredNumber(terms, "realizedPnlUsd");
  if (Math.abs(realizedPnl - (payout - cost)) > 1e-6) {
    throw new Error("Settlement realized PnL evidence differs");
  }
  requireEvidenceValue(terms, "preview", config.app.global.previewMode, "REDEEM");
  const payloads = group.observations.map((observation) => JSON.parse(observation.payloadJson) as Record<string, unknown>);
  if (settlementSource === "condition_resolution") {
    const conditionId = requiredString(terms, "conditionId");
    if (payloads.length !== 1 || !["REDEEM", "AUTO_SETTLEMENT"].includes(String(payloads[0]!.type)) ||
      payloads[0]!.conditionId !== conditionId) {
      throw new Error("Condition settlement decision is not bound to its immutable raw event");
    }
    const winnerTokenIds = terms.winnerTokenIds;
    if (!Array.isArray(winnerTokenIds) || winnerTokenIds.some((token) => typeof token !== "string")) {
      throw new Error("Outcome evidence requires winnerTokenIds");
    }
    const winners = new Set(winnerTokenIds as string[]);
    let actualCost = 0, actualPayout = 0, closedPositions = 0;
    for (const [key, position] of [...positions]) {
      if (position.leaderId !== leaderId || markets.get(position.tokenId) !== conditionId) continue;
      actualCost += position.shares * position.avgEntryPrice;
      if (winners.has(position.tokenId)) actualPayout += position.shares;
      closedPositions++;
      positions.delete(key);
    }
    if (Math.abs(actualCost - cost) > 1e-6 || Math.abs(actualPayout - payout) > 1e-6) {
      throw new Error("Outcome evidence accounting differs");
    }
    requireEvidenceValue(terms, "tokenId", conditionId, "condition REDEEM");
    requireEvidenceValue(terms, "size", round(actualPayout), "condition REDEEM");
    requireEvidenceValue(terms, "price", closedPositions, "condition REDEEM");
  } else if (["leader_redeem", "token_resolution", "token_settlement", "onchain_redeemable"].includes(settlementSource)) {
    const tokenId = requiredString(terms, "tokenId");
    const payoutPerShare = requiredNumber(terms, "payoutPerShare");
    const sourceMatches = settlementSource === "leader_redeem"
      ? payloads.length === 1 && payloads[0]!.type === "REDEEM" && payloads[0]!.asset === tokenId
      : settlementSource === "onchain_redeemable"
        ? payloads.length > 0 && payloads.every((payload) => payload.type === "ONCHAIN_REDEEMABLE") &&
          payloads.some((payload) => payload.tokenId === tokenId) &&
          payloads.every((payload) => payload.conditionId === terms.conditionId)
        : payloads.length === 1 && payloads[0]!.type === "TOKEN_SETTLEMENT" && payloads[0]!.tokenId === tokenId;
    if (!sourceMatches) throw new Error("Token settlement decision is not bound to its immutable raw event");
    const key = stateKey(leaderId, tokenId);
    const position = positions.get(key);
    if (!position) throw new Error("Settlement attempts to close a missing position");
    const actualCost = position.shares * position.avgEntryPrice;
    const actualPayout = position.shares * payoutPerShare;
    if (Math.abs(actualCost - cost) > 1e-6 || Math.abs(actualPayout - payout) > 1e-6) {
      throw new Error("Settlement accounting evidence differs");
    }
    requireEvidenceValue(terms, "size", round(actualPayout), "token REDEEM");
    requireEvidenceValue(terms, "price", position.shares, "token REDEEM");
    positions.delete(key);
  } else {
    throw new Error(`Unsupported immutable settlement source: ${settlementSource}`);
  }
  if (config.app.global.previewMode) cash.value += payout;
  realized.value += payout - cost;
}

function linkedDecisionDigest(rows: StoredDecision[]): string {
  return createHash("sha256").update(rows.map((row) => [
    row.linkOrder, row.observationId, row.decisionId, row.rawEventId,
    row.action, row.reasonCode, normalizedPayloadJson(JSON.parse(row.exactTermsJson)),
  ].join("\n")).join("\n---\n")).digest("hex");
}

export function replayEvidence(dbPath: string, experimentId: string): ReplayEvidenceSummary {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const experiment = db.prepare(`SELECT canonical_config_json AS configJson, sealed_at AS sealedAt,
      start_state_json AS startStateJson, schema_version AS schemaVersion FROM experiments WHERE experiment_id=?`).get(experimentId) as
      { configJson: string; sealedAt: number | null; startStateJson: string; schemaVersion: number } | undefined;
    if (!experiment || experiment.sealedAt === null) throw new Error("Deterministic replay requires sealed experiment evidence");
    if (experiment.schemaVersion < 7) throw new Error("Legacy experiment lacks explicit decision observation links");
    const config = JSON.parse(experiment.configJson) as RuntimeConfig;
    const start = JSON.parse(experiment.startStateJson) as ExperimentStateSnapshot;
    const cash = { value: start.cashUsd };
    const realized = { value: start.realizedPnlUsd };
    const positions = new Map(start.positions.map((position) => [stateKey(position.leaderId, position.tokenId), { ...position }]));
    const evidence = loadEvidence(db, experimentId);
    const observations = evidence.raw.flatMap((raw) => raw.observations);
    const observationById = new Map(observations.map((observation) => [observation.observationId, observation]));
    const occurrences = decisionOccurrences(evidence.decisions);
    const groups = new Map<string, ReplayDecisionGroup>();
    for (const decision of occurrences) {
      const key = observationContextKey(decision.observationIds);
      if (!groups.has(key)) {
        const context = decision.observationIds.map((observationId) => observationById.get(observationId));
        if (context.some((observation) => !observation)) throw new Error("Replay decision context lacks raw evidence");
        groups.set(key, { key, observations: context as RawObservationEvidence[],
          cumulativeFilledShares: 0, cumulativeFilledUsd: 0, copied: false });
      }
    }
    for (const observation of observations) {
      const linked = occurrences.filter((decision) => decision.observationIds.includes(observation.observationId));
      const actions = linked.map((decision) => decision.action);
      if (!actions.includes("DETECT") || !actions.some((action) => ["SKIP", "COPY", "SELL", "REDEEM"].includes(action))) {
        throw new Error(`Replay observation ${observation.observationId} lacks a complete DETECT-to-terminal chain`);
      }
      const skipDecisions = linked.filter((decision) => decision.action === "SKIP");
      const hasEconomicTerminal = actions.some((action) => ["COPY", "SELL", "REDEEM"].includes(action));
      const isTransientOrderSkip = (decision: DecisionOccurrence): boolean => {
        const reason = decisionTerms(decision).reason;
        return typeof reason === "string" && (reason.startsWith("GTC pending (") || reason === "order submitted — no fill");
      };
      if (hasEconomicTerminal && skipDecisions.some((decision) =>
        decision.reasonCode !== "already_seen" && !isTransientOrderSkip(decision))) {
        throw new Error("Re-execution decision set mismatch: economic terminal mixed with a non-dedup SKIP");
      }
    }
    const markets = new Map((db.prepare("SELECT token_id AS tokenId, condition_id AS conditionId FROM token_markets").all() as
      Array<{ tokenId: string; conditionId: string }>).map((market) => [market.tokenId, market.conditionId]));
    let detectedBuy = 0, detectedSell = 0, copiedBuy = 0, copiedSell = 0;
    for (const decision of occurrences) {
      const group = groups.get(observationContextKey(decision.observationIds))!;
      if (decision.action === "DETECT") {
        if (group.activity) throw new Error("Replay observation context has more than one DETECT");
        const detected = validateDetect(decision, group, config, positions, cash.value);
        detectedBuy += detected.detectedBuy;
        detectedSell += detected.detectedSell;
      } else if (decision.action === "SKIP") {
        validateSkip(decision, group, config);
      } else if (decision.action === "COPY" || decision.action === "SELL") {
        const copied = validateAndApplyFill(decision, group, config, positions, cash, realized);
        copiedBuy += copied.copiedBuy;
        copiedSell += copied.copiedSell;
      } else if (decision.action === "REDEEM") {
        validateAndApplyRedeem(decision, group, config, positions, cash, realized, markets);
      } else {
        throw new Error(`Unsupported replay decision action: ${decision.action}`);
      }
    }
    return {
      decisionDigest: linkedDecisionDigest(evidence.decisions),
      cashUsd: round(cash.value),
      realizedPnlUsd: round(realized.value),
      positions: [...positions.values()].map((position) => ({ ...position,
        shares: round(position.shares), avgEntryPrice: round(position.avgEntryPrice) }))
        .sort((a, b) => stateKey(a.leaderId, a.tokenId).localeCompare(stateKey(b.leaderId, b.tokenId))),
      coverage: { buyPct: pct(copiedBuy, detectedBuy), sellPct: pct(copiedSell, detectedSell),
        totalPct: pct(copiedBuy + copiedSell, detectedBuy + detectedSell) },
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
function replayPositionsMatch(actual: ReplayPosition[], expected: ReplayPosition[]): boolean {
  return actual.length === expected.length && actual.every((position, index) => {
    const comparison = expected[index];
    return comparison !== undefined && position.leaderId === comparison.leaderId && position.tokenId === comparison.tokenId
      && Math.abs(position.shares - comparison.shares) <= 1e-8
      && Math.abs(position.avgEntryPrice - comparison.avgEntryPrice) <= 1e-8;
  });
}
export function verifyExperimentReplay(manifestPath: string, options: ArchiveVerificationOptions): ReplayVerificationResult {
  const archive = verifyExperimentArchive(manifestPath, options);
  if (!archive.valid) throw new Error(`Archive trust verification failed: ${archive.errors.join("; ")}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { experimentId: string; files: { path: string }[]; replayBaseline: ReplayEvidenceSummary };
  const snapshotPath = resolve(dirname(manifestPath), manifest.files[0]!.path);
  const actual = replayEvidence(snapshotPath, manifest.experimentId); const expected = manifest.replayBaseline;
  const mismatches: string[] = [];
  if (actual.decisionDigest !== expected.decisionDigest) mismatches.push("decisionDigest");
  if (Math.abs(actual.cashUsd - expected.cashUsd) > 1e-6) mismatches.push("cashUsd");
  if (!replayPositionsMatch(actual.positions, expected.positions)) mismatches.push("positions");
  if (Math.abs(actual.realizedPnlUsd - expected.realizedPnlUsd) > 1e-6) mismatches.push("realizedPnlUsd");
  if (normalizedPayloadJson(actual.coverage) !== normalizedPayloadJson(expected.coverage)) mismatches.push("coverage");
  return { match: mismatches.length === 0, expected, actual, mismatches };
}
