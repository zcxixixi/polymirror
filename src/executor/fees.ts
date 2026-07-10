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
