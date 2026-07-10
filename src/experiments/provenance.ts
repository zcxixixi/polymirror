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
  return {
    gitSha: process.env.POLYMIRROR_GIT_SHA?.trim() || checkoutGitSha(),
    imageDigest: process.env.POLYMIRROR_IMAGE_DIGEST?.trim() || "unknown",
    lockfileHash: sha256File("package-lock.json"),
  };
}

export function provenanceTrustClass(
  requested: ExperimentTrustClass,
  provenance: RuntimeProvenance
): ExperimentTrustClass {
  const complete = provenance.gitSha !== "unknown"
    && provenance.imageDigest !== "unknown"
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
  reasonCode: string;
  exactTerms: Record<string, unknown>;
  decidedAt: number;
}
