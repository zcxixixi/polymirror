function roundFee(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export function calculateFeeFromBps(notionalUsd: number, feeRateBps: number): number {
  if (notionalUsd <= 0 || feeRateBps <= 0) return 0;
  return roundFee(notionalUsd * feeRateBps / 10_000);
}

export function calculatePlatformFeeUsd(
  shares: number,
  price: number,
  feeRate: number,
  feeExponent: number
): number {
  if (shares <= 0 || price <= 0 || price >= 1 || feeRate <= 0) return 0;
  const exponent = Number.isFinite(feeExponent) && feeExponent >= 0 ? feeExponent : 0;
  return roundFee(shares * feeRate * (price * (1 - price)) ** exponent);
}

const SDK_SHARE_DECIMALS_BY_TICK = new Map<number, number>([
  [0.1, 3],
  [0.01, 4],
  [0.005, 5],
  [0.0025, 6],
  [0.001, 5],
  [0.0001, 6],
]);

function decimalPlaces(value: number): number {
  if (Number.isInteger(value)) return 0;
  const [mantissa = "", exponent] = value.toString().toLowerCase().split("e");
  const [, fractionalPart = ""] = mantissa.split(".");
  if (exponent === undefined) return fractionalPart.length;
  return Math.max(0, fractionalPart.length - Number.parseInt(exponent, 10));
}

function roundDown(value: number, decimals: number): number {
  if (decimalPlaces(value) <= decimals) return value;
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

function roundUp(value: number, decimals: number): number {
  if (decimalPlaces(value) <= decimals) return value;
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}

/**
 * Mirrors the pinned official SDK's protected BUY preparation:
 * `adjustBuyAmountForFees()` followed by `computeMarketOrderAmounts()`.
 * The SDK helpers are internal (absent from the package exports and public d.ts),
 * so this contract mirrors @polymarket/client@0.1.0-beta.14 source-map sources:
 * actions/orders/market.ts, actions/orders/math.ts, and actions/orders/context.ts.
 */
export function prepareSdkMarketBuyWithinMaxSpend(input: {
  requestedAmountUsd: number;
  maxSpendUsd: number;
  price: number;
  tickSize: number;
  platformFeeRate: number;
  platformFeeExponent: number;
}): {
  makerAmountUsd: number;
  requestedShares: number;
  feeUsd: number;
  allInSpendUsd: number;
} {
  const {
    requestedAmountUsd,
    maxSpendUsd,
    price,
    tickSize,
    platformFeeRate,
    platformFeeExponent,
  } = input;
  if (
    !Number.isFinite(requestedAmountUsd) || requestedAmountUsd <= 0 ||
    !Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0 ||
    !Number.isFinite(price) || price <= 0 || price >= 1 ||
    !Number.isFinite(platformFeeRate) || platformFeeRate < 0 ||
    !Number.isFinite(platformFeeExponent) || platformFeeExponent < 0
  ) {
    throw new Error("invalid SDK market BUY parameters");
  }
  const shareDecimals = SDK_SHARE_DECIMALS_BY_TICK.get(tickSize);
  if (shareDecimals === undefined) {
    throw new Error(`unsupported tick size for SDK market BUY: ${tickSize}`);
  }

  const effectiveFeePerShare = platformFeeRate
    * (price * (1 - price)) ** platformFeeExponent;
  const requestedFee = (requestedAmountUsd / price) * effectiveFeePerShare;
  const requestedAllIn = requestedAmountUsd + requestedFee;
  const feeAdjustedAmount = maxSpendUsd <= requestedAllIn
    ? maxSpendUsd / (1 + effectiveFeePerShare / price)
    : requestedAmountUsd;
  const makerAmountUsd = roundDown(feeAdjustedAmount, 2);
  if (makerAmountUsd <= 0) {
    throw new Error("SDK market BUY maker amount rounds to zero");
  }
  let requestedShares = makerAmountUsd / price;
  if (decimalPlaces(requestedShares) > shareDecimals) {
    requestedShares = roundUp(requestedShares, shareDecimals + 4);
    if (decimalPlaces(requestedShares) > shareDecimals) {
      requestedShares = roundUp(requestedShares, shareDecimals);
    }
  }
  const feeUsd = calculatePlatformFeeUsd(
    requestedShares,
    price,
    platformFeeRate,
    platformFeeExponent
  );
  const allInSpendUsd = roundFee(makerAmountUsd + feeUsd);
  if (allInSpendUsd > maxSpendUsd + 1e-8) {
    throw new Error("SDK market BUY exceeds max spend after rounding");
  }
  return { makerAmountUsd, requestedShares, feeUsd, allInSpendUsd };
}
