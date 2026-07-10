import { createHash, randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config/types.js";

const REDACTED_KEYS = new Set([
  "privateKey",
  "apiKey",
  "apiSecret",
  "apiPassphrase",
  "relayerApiKey",
]);

const SENSITIVE_KEY = /(?:password|secret|credential|private.?key|api.?key|passphrase|access.?token|refresh.?token|auth.?token|bearer)/i;
const PUBLIC_SENSITIVE_LOOKALIKE_KEYS = new Set(["relayerApiKeyAddress"]);

function sensitiveKey(key: string): boolean {
  if (PUBLIC_SENSITIVE_LOOKALIKE_KEYS.has(key)) return false;
  return REDACTED_KEYS.has(key) || SENSITIVE_KEY.test(key);
}

function canonicalValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey(key)) return "[REDACTED]";
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

export function decisionConfigProjection(config: RuntimeConfig): unknown {
  const { global, leaders } = config.app;
  return {
    app: {
      global: {
        previewMode: global.previewMode,
        copyPriceMode: global.copyPriceMode,
        copyTradesOnly: global.copyTradesOnly,
        maxTradeAgeHours: global.maxTradeAgeHours,
        buyDedupWindowMs: global.buyDedupWindowMs,
        tradeAggregationWindowMs: global.tradeAggregationWindowMs,
        risk: global.risk,
        execution: global.execution,
        conflict: global.conflict,
      },
      leaders,
    },
    wallet: {
      proxyAddress: config.wallet.proxyAddress,
      signatureType: config.wallet.signatureType,
      chainId: config.wallet.chainId,
      clobUrl: config.wallet.clobUrl,
      dataApiUrl: config.wallet.dataApiUrl,
      tradingBackend: config.wallet.tradingBackend,
      relayerApiKeyAddress: config.wallet.relayerApiKeyAddress,
    },
  };
}

export function configSha256(config: RuntimeConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(decisionConfigProjection(config))))
    .digest("hex");
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
