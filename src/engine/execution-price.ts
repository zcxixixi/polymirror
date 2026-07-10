import type { TradeSide } from "../config/types.js";
import { calculateCopySlippageLossPct } from "../sim/copy-slippage.js";

export interface ExecutableGuardedOrderInput {
  side: TradeSide;
  leaderPrice: number;
  executablePrice: number | null;
  targetUsd: number;
  minOrderUsd: number;
  absoluteTolerance: number;
  tickSize?: number;
}

export type GuardedOrderTermsInput = Omit<
  ExecutableGuardedOrderInput,
  "executablePrice"
>;

export interface GuardedOrderTerms {
  allow: boolean;
  reason?: string;
  orderPrice: number | null;
  orderShares: number;
  orderUsd: number;
}

export interface ExecutableGuardedOrder {
  allow: boolean;
  reason?: string;
  orderPrice: number | null;
  orderShares: number;
  orderUsd: number;
  slippagePct: number | null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function refused(reason: string, slippagePct: number | null): ExecutableGuardedOrder {
  return {
    allow: false,
    reason,
    orderPrice: null,
    orderShares: 0,
    orderUsd: 0,
    slippagePct,
  };
}

function refusedTerms(reason: string): GuardedOrderTerms {
  return {
    allow: false,
    reason,
    orderPrice: null,
    orderShares: 0,
    orderUsd: 0,
  };
}

function guardedLimitPrice(
  side: TradeSide,
  leaderPrice: number,
  absoluteTolerance: number,
  tickSize?: number
): number {
  const raw = side === "BUY"
    ? leaderPrice + absoluteTolerance
    : leaderPrice - absoluteTolerance;
  if (!Number.isFinite(tickSize) || tickSize === undefined || tickSize <= 0) {
    return round4(Math.max(0.0001, Math.min(0.9999, raw)));
  }
  const ticks = side === "BUY"
    ? Math.floor((raw + 1e-12) / tickSize)
    : Math.ceil((raw - 1e-12) / tickSize);
  const aligned = ticks * tickSize;
  return round4(Math.max(tickSize, Math.min(1 - tickSize, aligned)));
}

export function prepareGuardedOrderTerms(
  input: GuardedOrderTermsInput
): GuardedOrderTerms {
  const { side, leaderPrice, targetUsd, minOrderUsd, absoluteTolerance, tickSize } = input;
  if (!Number.isFinite(leaderPrice) || leaderPrice <= 0 || leaderPrice >= 1) {
    return refusedTerms("invalid leader price");
  }
  if (!Number.isFinite(targetUsd) || targetUsd <= 0 || absoluteTolerance <= 0) {
    return refusedTerms("invalid guarded order parameters");
  }

  const orderPrice = guardedLimitPrice(side, leaderPrice, absoluteTolerance, tickSize);
  let orderShares = Math.max(0.01, Math.round((targetUsd / orderPrice) * 100) / 100);
  if (orderShares * orderPrice < minOrderUsd) {
    orderShares = Math.max(0.01, Math.ceil((minOrderUsd / orderPrice) * 100) / 100);
  }
  const orderUsd = round4(orderShares * orderPrice);

  return {
    allow: true,
    orderPrice,
    orderShares,
    orderUsd,
  };
}

export function prepareExecutableGuardedOrder(
  input: ExecutableGuardedOrderInput
): ExecutableGuardedOrder {
  const {
    side,
    leaderPrice,
    executablePrice,
    targetUsd,
    minOrderUsd,
    absoluteTolerance,
    tickSize,
  } = input;
  const terms = prepareGuardedOrderTerms({
    side,
    leaderPrice,
    targetUsd,
    minOrderUsd,
    absoluteTolerance,
    tickSize,
  });
  if (!terms.allow || terms.orderPrice === null) {
    return refused(terms.reason ?? "invalid guarded order parameters", null);
  }
  if (
    executablePrice === null ||
    !Number.isFinite(executablePrice) ||
    executablePrice <= 0 ||
    executablePrice >= 1
  ) {
    return refused("executable price unavailable", null);
  }

  const slippagePct = calculateCopySlippageLossPct(side, leaderPrice, executablePrice);
  const adverseDelta = side === "BUY"
    ? executablePrice - leaderPrice
    : leaderPrice - executablePrice;
  if (adverseDelta - absoluteTolerance > 1e-9) {
    return refused(
      `slippage ${Math.max(0, adverseDelta).toFixed(4)} > ${absoluteTolerance}`,
      slippagePct
    );
  }

  return {
    allow: true,
    orderPrice: terms.orderPrice,
    orderShares: terms.orderShares,
    orderUsd: terms.orderUsd,
    slippagePct,
  };
}
