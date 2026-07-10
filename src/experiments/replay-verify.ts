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
interface RegeneratedDecision { rawEventId: string; action: string; reasonCode: string; exactTermsJson: string }
interface RawEvidence { rawEventId: string; sourceId: string | null; payloadHash: string; payloadJson: string; observedTimestamp: number; observationCount: number; rawOrder: number }

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
  const raw = db.prepare(`SELECT r.raw_event_id AS rawEventId, r.source_id AS sourceId, r.payload_hash AS payloadHash,
    r.normalized_payload_json AS payloadJson, r.observed_timestamp AS observedTimestamp,
    (SELECT COUNT(*) FROM raw_event_observations o WHERE o.raw_event_id=r.raw_event_id) AS observationCount,
    (SELECT MIN(observation_id) FROM raw_event_observations o WHERE o.raw_event_id=r.raw_event_id) AS rawOrder
    FROM raw_events r WHERE r.experiment_id=? ORDER BY rawOrder`).all(experimentId) as RawEvidence[];
  const decisions = db.prepare(`SELECT decision_id AS decisionId, raw_event_id AS rawEventId, action,
    reason_code AS reasonCode, exact_terms_json AS exactTermsJson FROM decisions
    WHERE experiment_id=? ORDER BY decision_order, decided_at, decision_id`).all(experimentId) as StoredDecision[];
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
        { action: "SKIP", reasonCode: replaySkipReasonCode(reason), derivedTerms: { leaderId: leader.id, tokenId: activity.asset, side, reason, preview: config.app.global.previewMode } },
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
    leaderId: leader.id, tokenId: activity.asset, side, reason: "already seen", preview: config.app.global.previewMode,
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

export function replayEvidence(dbPath: string, experimentId: string): ReplayEvidenceSummary {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const experiment = db.prepare(`SELECT canonical_config_json AS configJson, sealed_at AS sealedAt,
      start_state_json AS startStateJson, schema_version AS schemaVersion FROM experiments WHERE experiment_id=?`).get(experimentId) as
      { configJson: string; sealedAt: number | null; startStateJson: string; schemaVersion: number } | undefined;
    if (!experiment || experiment.sealedAt === null) throw new Error("Deterministic replay requires sealed experiment evidence");
    if (experiment.schemaVersion < 6) throw new Error("Legacy experiment lacks trustworthy scoped replay ordering");
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
      if ((payload as Activity & { candidate?: boolean }).candidate === false) {
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
        if (!payload.asset || !payload.side) {
          if (!decisions.some((decision) => decision.action === "SKIP" && decision.reasonCode === "unsupported_or_incomplete_activity")) {
            throw new Error("Re-execution decision digest mismatch: incomplete activity decision differs");
          }
          assertOrderedActions(decisions, ["DETECT", "SKIP"], "incomplete trade");
          regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, decisions, [
            { action: "DETECT", reasonCode: "detected", derivedTerms: { leaderId, tokenId: payload.asset ?? null, side: payload.side ?? null, size: payload.size ?? null, price: payload.price ?? null, preview: config.app.global.previewMode } },
            { action: "SKIP", reasonCode: "unsupported_or_incomplete_activity", derivedTerms: { leaderId, tokenId: payload.asset ?? null, side: payload.side ?? null, reason: "unsupported or incomplete activity" } },
          ])); continue;
        }
        const result = validateAndApplyTrade(config, leader, payload, decisions, positions, cash, realized);
        detectedBuy += result.detectedBuy; detectedSell += result.detectedSell;
        copiedBuy += result.copiedBuy; copiedSell += result.copiedSell;
        regenerated.push(...buildExpectedDecisionSet(raw.rawEventId, decisions, result.specs));
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
