import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ExperimentTrustClass } from "./manifest.js";

function sha256File(path: string): string {
  if (!existsSync(path)) return "unavailable";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface RuntimeProvenance {
  gitSha: string;
  imageDigest: string;
  lockfileHash: string;
}

const GIT_SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;

function validateOptionalProvenance(
  name: "POLYMIRROR_GIT_SHA" | "POLYMIRROR_IMAGE_DIGEST",
  value: string | undefined,
  pattern: RegExp
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!pattern.test(normalized)) {
    throw new Error(`${name} has an invalid immutable identifier format`);
  }
  return normalized.toLowerCase();
}

function checkoutGitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function readRuntimeProvenance(): RuntimeProvenance {
  const injectedGitSha = validateOptionalProvenance(
    "POLYMIRROR_GIT_SHA",
    process.env.POLYMIRROR_GIT_SHA,
    GIT_SHA_PATTERN
  );
  const checkoutSha = injectedGitSha ? undefined : checkoutGitSha();
  return {
    gitSha: injectedGitSha
      ?? (GIT_SHA_PATTERN.test(checkoutSha ?? "") ? checkoutSha!.toLowerCase() : "unknown"),
    imageDigest: validateOptionalProvenance(
      "POLYMIRROR_IMAGE_DIGEST",
      process.env.POLYMIRROR_IMAGE_DIGEST,
      IMAGE_DIGEST_PATTERN
    ) ?? "unknown",
    lockfileHash: sha256File("package-lock.json"),
  };
}

export function provenanceTrustClass(
  requested: ExperimentTrustClass,
  provenance: RuntimeProvenance
): ExperimentTrustClass {
  const complete = GIT_SHA_PATTERN.test(provenance.gitSha)
    && IMAGE_DIGEST_PATTERN.test(provenance.imageDigest)
    && /^[a-f0-9]{64}$/i.test(provenance.lockfileHash);
  if (!complete) return requested === "legacy" ? "legacy" : "partial";
  return requested;
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalized(child)])
    );
  }
  return value;
}

export function normalizedPayloadJson(payload: unknown): string {
  return JSON.stringify(normalized(payload));
}

export function payloadSha256(payload: unknown): string {
  return createHash("sha256").update(normalizedPayloadJson(payload)).digest("hex");
}

export type DecisionAction = "DETECT" | "SKIP" | "COPY" | "SELL" | "REDEEM";
export type DecisionReasonCode =
  | "detected"
  | "copy_executed"
  | "sell_executed"
  | "redeem_settled"
  | "stale_activity"
  | "missing_redeem_condition"
  | "unsupported_activity_type"
  | "missing_trade_asset"
  | "missing_trade_side"
  | "below_minimum_activity_size"
  | "poll_rejected_activity"
  | "already_seen"
  | "unsupported_or_incomplete_activity"
  | "no_local_position"
  | "onchain_redeem_failed"
  | "missing_redeem_token"
  | "price_filter"
  | "cash_limit"
  | "position_limit"
  | "policy_skip"
  | "untracked_token"
  | "settlement_evidence_unavailable"
  | "market_unresolved"
  | "winner_set_unavailable";

export interface RawEventRow {
  rawEventId: string;
  experimentId: string;
  sourceId: string | null;
  payloadHash: string;
  payload: unknown;
  sourceTimestamp: number;
  observedTimestamp: number;
}

export interface RawEventObservationRow {
  observationId: number;
  observationKey: string | null;
  rawEventId: string;
  payloadHash: string;
  payload: unknown;
  sourceTimestamp: number;
  observedTimestamp: number;
}

export interface DecisionRow {
  decisionId: string;
  experimentId: string;
  rawEventId: string;
  action: DecisionAction;
  reasonCode: DecisionReasonCode;
  exactTerms: Record<string, unknown>;
  decidedAt: number;
}
