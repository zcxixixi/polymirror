import type { AccountDefinition, GlobalConfig, LeaderConfig } from "../config/types.js";
import { calculateOrderSize } from "../engine/sizing.js";
import type { PlaceOrderRequest, PlaceOrderResult } from "../executor/clob.js";
import type { WalletCollateralSnapshot } from "../executor/balance.js";
import type { Activity } from "../monitor/data-api.js";
import type { LiveProbeSnapshot } from "./probe.js";
import {
  isEmptyLiveProbeAddress,
  walletCollateralUsd,
} from "./protected-probe.js";

export interface LiveProbeSubmitOptions {
  enabled: boolean;
  allowInsufficientCollateral: boolean;
  maxNotionalUsd: number;
  maxCollateralUsd: number;
}

export interface LiveProbeSubmitAttempt {
  enabled: boolean;
  allowed: boolean;
  submitted: boolean;
  reason: string;
  request?: PlaceOrderRequest & {
    leaderId: string;
    notionalUsd: number;
  };
  result?: PlaceOrderResult;
}

export type LiveProbeSubmitGuard =
  | { allow: true; reason: string }
  | { allow: false; reason: string };

export function serializeLiveProbeOrderResult(
  result: PlaceOrderResult
): PlaceOrderResult {
  return {
    preview: result.preview,
    orderId: result.orderId,
    executionPrice: result.executionPrice,
    error: result.error,
    filledShares: result.filledShares,
    filledUsd: result.filledUsd,
    orderStatus: result.orderStatus,
    pendingRemaining: result.pendingRemaining,
  };
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseLiveProbeSubmitEnv(
  env: NodeJS.ProcessEnv = process.env
): LiveProbeSubmitOptions {
  return {
    enabled: truthy(env.LIVE_PROBE_SUBMIT_ORDER),
    allowInsufficientCollateral: truthy(
      env.LIVE_PROBE_ALLOW_INSUFFICIENT_COLLATERAL
    ),
    maxNotionalUsd: positiveNumber(env.LIVE_PROBE_MAX_ORDER_USD, 1),
    maxCollateralUsd: positiveNumber(
      env.LIVE_PROBE_MAX_COLLATERAL_USD ??
        env.POLYMIRROR_EMPTY_LIVE_PROBE_MAX_COLLATERAL_USD,
      0.99
    ),
  };
}

export function assessLiveProbeSubmitGuard(input: {
  account: AccountDefinition;
  snapshot: LiveProbeSnapshot;
  collateral: WalletCollateralSnapshot | null;
  options: LiveProbeSubmitOptions;
  env?: NodeJS.ProcessEnv;
}): LiveProbeSubmitGuard {
  const { account, snapshot, collateral, options, env } = input;
  const minOrderUsd = account.config.app.global.risk.minOrderUsd;

  if (!options.enabled) return { allow: false, reason: "submit disabled" };
  if (account.config.app.global.previewMode) {
    return { allow: false, reason: "account is still in preview_mode" };
  }
  if (snapshot.geoblock?.blocked) {
    return { allow: false, reason: snapshot.stage.reason };
  }
  if (snapshot.candidates.count <= 0) {
    return { allow: false, reason: "no candidate" };
  }
  if (!isEmptyLiveProbeAddress(account.config.wallet.proxyAddress, env)) {
    return {
      allow: false,
      reason: "wallet is not in POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES",
    };
  }
  if (!collateral) {
    return { allow: false, reason: "collateral unavailable" };
  }

  const collateralUsd = walletCollateralUsd(collateral);
  if (collateralUsd + 0.01 >= minOrderUsd) {
    return {
      allow: false,
      reason: `protected wallet can fund min order $${minOrderUsd.toFixed(2)}`,
    };
  }
  if (collateralUsd > options.maxCollateralUsd) {
    return {
      allow: false,
      reason: `collateral $${collateralUsd.toFixed(2)} > submit max $${options.maxCollateralUsd.toFixed(2)}`,
    };
  }
  if (!snapshot.stage.canAttemptOrder && !options.allowInsufficientCollateral) {
    return {
      allow: false,
      reason: `preflight blocked: ${snapshot.stage.reason}`,
    };
  }

  return {
    allow: true,
    reason: "protected underfunded wallet submit probe allowed",
  };
}

export function buildLiveProbeOrderRequest(input: {
  leader: LeaderConfig;
  global: GlobalConfig;
  activity: Activity;
  maxNotionalUsd: number;
}):
  | {
      allow: true;
      order: PlaceOrderRequest & { notionalUsd: number };
      reasoning: string;
    }
  | { allow: false; reason: string } {
  const { leader, global, activity, maxNotionalUsd } = input;
  if (activity.type !== "TRADE" || activity.side !== "BUY") {
    return { allow: false, reason: "submit probe only supports BUY trades" };
  }
  if (!activity.asset || !activity.price || activity.price <= 0) {
    return { allow: false, reason: "candidate missing token or price" };
  }

  const sizing = calculateOrderSize(leader, global, activity);
  if (sizing.belowMinimum) return { allow: false, reason: sizing.reasoning };
  if (sizing.finalUsd > maxNotionalUsd + 0.01) {
    return {
      allow: false,
      reason: `candidate order $${sizing.finalUsd.toFixed(2)} exceeds submit max $${maxNotionalUsd.toFixed(2)}`,
    };
  }

  return {
    allow: true,
    order: {
      tokenId: activity.asset,
      side: "BUY",
      price: activity.price,
      size: sizing.finalShares,
      notionalUsd: Math.round(sizing.finalUsd * 100) / 100,
    },
    reasoning: sizing.reasoning,
  };
}
