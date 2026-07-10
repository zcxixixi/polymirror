export interface LiveBuyCollateralCheck {
  allow: boolean;
  cashUsd: number | null;
  reason?: string;
}

/** Pre-flight CLOB USDC before a live BUY (notional = price x shares). */
export function checkLiveBuyCollateral(
  cashUsd: number | null,
  requiredUsd: number,
  minOrderUsd: number
): LiveBuyCollateralCheck {
  if (cashUsd === null) {
    return { allow: false, cashUsd: null, reason: "USDC balance unavailable (CLOB)" };
  }
  if (cashUsd < minOrderUsd) {
    return {
      allow: false,
      cashUsd,
      reason: `USDC cash $${cashUsd.toFixed(2)} below min order $${minOrderUsd.toFixed(2)}`,
    };
  }
  if (cashUsd + 0.01 < requiredUsd) {
    return {
      allow: false,
      cashUsd,
      reason: `USDC cash $${cashUsd.toFixed(2)} < need $${requiredUsd.toFixed(2)}`,
    };
  }
  return { allow: true, cashUsd };
}

/** Pre-flight CLOB USDC balance + exchange allowance before a live BUY. */
export function checkLiveBuyCollateralAndAllowance(
  balanceUsd: number | null,
  allowanceUsd: number | null,
  requiredUsd: number,
  minOrderUsd: number
): LiveBuyCollateralCheck {
  const base = checkLiveBuyCollateral(balanceUsd, requiredUsd, minOrderUsd);
  if (!base.allow) return base;

  if (allowanceUsd === null) {
    return { allow: false, cashUsd: balanceUsd, reason: "CLOB allowance unavailable" };
  }
  if (allowanceUsd + 0.01 < requiredUsd) {
    return {
      allow: false,
      cashUsd: balanceUsd,
      reason: `CLOB allowance $${allowanceUsd.toFixed(2)} < need $${requiredUsd.toFixed(2)} — approve on polymarket.com`,
    };
  }
  return base;
}
