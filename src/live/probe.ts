import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountDefinition } from "../config/types.js";
import type { GeoblockStatus } from "../executor/geoblock.js";
import { checkLiveBuyCollateralAndAllowance } from "../executor/collateral-check.js";
import type { WalletCollateralSnapshot } from "../executor/balance.js";
import { emptyLiveProbeFundedReason } from "./protected-probe.js";

export type LiveProbeStatus =
  | "not_live"
  | "missing_credentials"
  | "blocked_geoblock"
  | "no_candidate"
  | "collateral_unchecked"
  | "protected_probe_funded"
  | "blocked_collateral"
  | "ready_for_order_attempt";

export interface LiveProbeSnapshot {
  generatedAt: string;
  accountId: string;
  label: string;
  enabled: boolean;
  previewMode: boolean;
  walletEnv: string;
  wallet: {
    address: string;
    signatureType: number;
    hasClobCredentials: boolean;
    hasRelayerCredentials: boolean;
  };
  geoblock: GeoblockStatus | null;
  candidates: {
    count: number;
    error?: string;
  };
  collateral: WalletCollateralSnapshot | null;
  collateralError?: string;
  stage: {
    status: LiveProbeStatus;
    reason: string;
    canAttemptOrder: boolean;
    orderSubmitted: false;
  };
  orderAttempt?: {
    enabled: boolean;
    allowed: boolean;
    submitted: boolean;
    reason: string;
    request?: unknown;
    result?: unknown;
  };
}

export interface CreateLiveProbeSnapshotInput {
  account: AccountDefinition;
  now?: string;
  geoblock: GeoblockStatus | null;
  candidateCount: number;
  candidateError?: string;
  collateral?: WalletCollateralSnapshot | null;
  collateralError?: string;
}

function clobCredentialsReady(account: AccountDefinition): boolean {
  const wallet = account.config.wallet;
  return Boolean(wallet.apiKey && wallet.apiSecret && wallet.apiPassphrase);
}

function relayerCredentialsReady(account: AccountDefinition): boolean {
  const wallet = account.config.wallet;
  return Boolean(wallet.relayerApiKey && wallet.relayerApiKeyAddress);
}

function stageFor(input: CreateLiveProbeSnapshotInput): LiveProbeSnapshot["stage"] {
  const { account, geoblock, candidateCount, collateral, collateralError } = input;
  const global = account.config.app.global;

  if (global.previewMode) {
    return {
      status: "not_live",
      reason: "account is still in preview_mode",
      canAttemptOrder: false,
      orderSubmitted: false,
    };
  }
  if (!clobCredentialsReady(account) || !relayerCredentialsReady(account)) {
    return {
      status: "missing_credentials",
      reason: "CLOB or Relayer credentials missing",
      canAttemptOrder: false,
      orderSubmitted: false,
    };
  }
  if (geoblock?.blocked) {
    return {
      status: "blocked_geoblock",
      reason: `geoblocked ${geoblock.ip} ${geoblock.country}/${geoblock.region}`,
      canAttemptOrder: false,
      orderSubmitted: false,
    };
  }
  if (candidateCount <= 0) {
    return {
      status: "no_candidate",
      reason: "no leader trade candidate in this probe window",
      canAttemptOrder: false,
      orderSubmitted: false,
    };
  }
  if (!collateral) {
    return {
      status: "collateral_unchecked",
      reason: collateralError
        ? `collateral check unavailable: ${collateralError}`
        : "collateral was not checked",
      canAttemptOrder: false,
      orderSubmitted: false,
    };
  }

  const protectedProbeReason = emptyLiveProbeFundedReason(
    account.config.wallet.proxyAddress,
    collateral
  );
  if (protectedProbeReason) {
    return {
      status: "protected_probe_funded",
      reason: protectedProbeReason,
      canAttemptOrder: false,
      orderSubmitted: false,
    };
  }

  const requiredUsd = global.risk.minOrderUsd;
  const balanceUsd =
    (collateral.clobUsd ?? 0) > 0 ? collateral.clobUsd : collateral.cashUsd;
  const allowanceUsd = (collateral.clobUsd ?? 0) > 0
    ? collateral.clobAllowanceUsd
    : collateral.pusdAllowancesReady === true
      ? collateral.chainUsd
      : collateral.clobAllowanceUsd;
  const check = checkLiveBuyCollateralAndAllowance(
    balanceUsd,
    allowanceUsd,
    requiredUsd,
    global.risk.minOrderUsd
  );

  if (!check.allow) {
    return {
      status: "blocked_collateral",
      reason: check.reason ?? "collateral or allowance insufficient",
      canAttemptOrder: false,
      orderSubmitted: false,
    };
  }

  return {
    status: "ready_for_order_attempt",
    reason: "live preflight passed; order submission intentionally not attempted by probe",
    canAttemptOrder: true,
    orderSubmitted: false,
  };
}

export function createLiveProbeSnapshot(
  input: CreateLiveProbeSnapshotInput
): LiveProbeSnapshot {
  const { account, geoblock, candidateCount, candidateError } = input;
  const wallet = account.config.wallet;

  return {
    generatedAt: input.now ?? new Date().toISOString(),
    accountId: account.id,
    label: account.label,
    enabled: account.enabled,
    previewMode: account.config.app.global.previewMode,
    walletEnv: account.walletEnv,
    wallet: {
      address: wallet.proxyAddress,
      signatureType: wallet.signatureType,
      hasClobCredentials: clobCredentialsReady(account),
      hasRelayerCredentials: relayerCredentialsReady(account),
    },
    geoblock,
    candidates: {
      count: candidateCount,
      ...(candidateError ? { error: candidateError } : {}),
    },
    collateral: input.collateral ?? null,
    ...(input.collateralError ? { collateralError: input.collateralError } : {}),
    stage: stageFor(input),
  };
}

export function writeLiveProbeJsonl(path: string, snapshot: LiveProbeSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(snapshot)}\n`);
}
