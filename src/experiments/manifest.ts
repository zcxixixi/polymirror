import { createHash, randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config/types.js";

const REDACTED_KEYS = new Set([
  "privateKey",
  "apiKey",
  "apiSecret",
  "apiPassphrase",
  "relayerApiKey",
]);

function canonicalValue(value: unknown, key?: string): unknown {
  if (key && REDACTED_KEYS.has(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([childKey, child]) => [childKey, canonicalValue(child, childKey)])
    );
  }
  return value;
}

export function canonicalRedactedConfig(config: RuntimeConfig): string {
  return JSON.stringify(canonicalValue(config));
}

export function configSha256(config: RuntimeConfig): string {
  return createHash("sha256").update(canonicalRedactedConfig(config)).digest("hex");
}

export function newExperimentId(accountId: string, configHash: string): string {
  return `${accountId}-${configHash.slice(0, 12)}-${randomUUID()}`;
}

export type ExperimentTrustClass = "candidate" | "legacy" | "partial" | "verified";

export interface ExperimentManifestInput {
  accountId: string;
  candidateAddresses: string[];
  config: RuntimeConfig;
  gitSha: string;
  imageDigest: string;
  lockfileHash: string;
  trustClass: ExperimentTrustClass;
}

export interface ExperimentManifestRow {
  experimentId: string;
  accountId: string;
  candidateAddresses: string[];
  canonicalConfigJson: string;
  configHash: string;
  gitSha: string;
  imageDigest: string;
  lockfileHash: string;
  schemaVersion: number;
  startedAt: number;
  endedAt: number | null;
  sealedAt: number | null;
  trustClass: ExperimentTrustClass;
}
