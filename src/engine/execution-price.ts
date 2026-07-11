import type { TradeSide } from "../config/types.js";
import { calculateCopySlippageLossPct } from "../sim/copy-slippage.js";

export interface ExecutableGuardedOrderInput {
  side: TradeSide;
  leaderPrice: number;
  executablePrice: number | null;
  targetUsd: number;
  targetShares?: number;
  minOrderUsd: number;
  maxOrderUsd?: number;
  buyNotionalMode?: "raw_legacy" | "submitted_cents";
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

function roundShares(value: number): number {
  return Math.round(value * 100) / 100;
}

function submittedBuyOrderCents(orderPrice: number, orderShares: number): number {
  return Math.round(orderPrice * orderShares * 100);
}

/** Exact cent amount passed to the official SDK for a FOK/FAK BUY. */
export function submittedBuyOrderUsd(
  orderPrice: number,
  orderShares: number
): number {
  return submittedBuyOrderCents(orderPrice, orderShares) / 100;
}

export function resolveAbsoluteSlippageTolerance(
  leaderPrice: number,
  tolerance: number,
  mode: "absolute_price" | "relative_pct" = "absolute_price"
): number {
  return mode === "relative_pct" ? leaderPrice * tolerance : tolerance;
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
  const {
    side,
    leaderPrice,
    targetUsd,
    targetShares,
    minOrderUsd,
    maxOrderUsd,
    buyNotionalMode = "submitted_cents",
    absoluteTolerance,
    tickSize,
  } = input;
  if (!Number.isFinite(leaderPrice) || leaderPrice <= 0 || leaderPrice >= 1) {
    return refusedTerms("invalid leader price");
  }
  if (
    !Number.isFinite(targetUsd) ||
    targetUsd <= 0 ||
    !Number.isFinite(minOrderUsd) ||
    minOrderUsd <= 0 ||
    !Number.isFinite(absoluteTolerance) ||
    absoluteTolerance <= 0
  ) {
    return refusedTerms("invalid guarded order parameters");
  }

  const orderPrice = guardedLimitPrice(side, leaderPrice, absoluteTolerance, tickSize);
  let orderShares: number;
  if (side === "SELL") {
    if (targetShares === undefined || !Number.isFinite(targetShares) || targetShares <= 0) {
      return refusedTerms("invalid SELL target shares");
    }
    orderShares = Math.max(0.01, Math.round(targetShares * 100) / 100);
  } else {
    if (buyNotionalMode === "raw_legacy") {
      orderShares = Math.max(0.01, roundShares(targetUsd / orderPrice));
      if (orderShares * orderPrice < minOrderUsd) {
        orderShares = Math.max(
          0.01,
          Math.ceil((minOrderUsd / orderPrice) * 100) / 100
        );
      }
      return {
        allow: true,
        orderPrice,
        orderShares,
        orderUsd: round4(orderShares * orderPrice),
      };
    }
    const minSubmittedCents = Math.ceil(minOrderUsd * 100 - 1e-9);
    let maxSubmittedCents = Number.POSITIVE_INFINITY;
    if (maxOrderUsd !== undefined) {
      if (!Number.isFinite(maxOrderUsd) || maxOrderUsd <= 0) {
        return refusedTerms("invalid guarded max order");
      }
      maxSubmittedCents = Math.floor(maxOrderUsd * 100 + 1e-9);
    }
    if (minSubmittedCents > maxSubmittedCents) {
      return refusedTerms("guarded order has no feasible cent amount");
    }

    orderShares = Math.max(0.01, roundShares(targetUsd / orderPrice));
    let submittedCents = submittedBuyOrderCents(orderPrice, orderShares);
    if (submittedCents < minSubmittedCents) {
      const lowerRawUsd = (minSubmittedCents - 0.5) / 100;
      orderShares = Math.max(
        0.01,
        Math.ceil((lowerRawUsd / orderPrice) * 100 - 1e-9) / 100
      );
      while (submittedBuyOrderCents(orderPrice, orderShares) < minSubmittedCents) {
        orderShares = roundShares(orderShares + 0.01);
      }
      submittedCents = submittedBuyOrderCents(orderPrice, orderShares);
    }
    if (submittedCents > maxSubmittedCents) {
      const upperRawUsd = (maxSubmittedCents + 0.5) / 100;
      orderShares = Math.floor((upperRawUsd / orderPrice) * 100 - 1e-9) / 100;
      while (
        orderShares >= 0.01 &&
        submittedBuyOrderCents(orderPrice, orderShares) > maxSubmittedCents
      ) {
        orderShares = roundShares(orderShares - 0.01);
      }
      submittedCents = submittedBuyOrderCents(orderPrice, orderShares);
    }
    if (
      orderShares < 0.01 ||
      submittedCents < minSubmittedCents ||
      submittedCents > maxSubmittedCents
    ) {
      return refusedTerms("guarded order has no feasible cent amount");
    }
  }
  const orderUsd = side === "BUY" && buyNotionalMode === "submitted_cents"
    ? submittedBuyOrderUsd(orderPrice, orderShares)
    : round4(orderShares * orderPrice);

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
    targetShares,
    minOrderUsd,
    maxOrderUsd,
    buyNotionalMode,
    absoluteTolerance,
    tickSize,
  } = input;
  const terms = prepareGuardedOrderTerms({
    side,
    leaderPrice,
    targetUsd,
    targetShares,
    minOrderUsd,
    maxOrderUsd,
    buyNotionalMode,
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
