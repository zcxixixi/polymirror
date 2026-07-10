import type { WalletCollateralSnapshot } from "../executor/balance.js";

export const DEFAULT_EMPTY_LIVE_PROBE_MAX_COLLATERAL_USD = 0.99;

export function emptyLiveProbeAddresses(
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  return new Set(
    (env.POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function emptyLiveProbeMaxCollateralUsd(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.POLYMIRROR_EMPTY_LIVE_PROBE_MAX_COLLATERAL_USD;
  if (!raw) return DEFAULT_EMPTY_LIVE_PROBE_MAX_COLLATERAL_USD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_EMPTY_LIVE_PROBE_MAX_COLLATERAL_USD;
}

export function isEmptyLiveProbeAddress(
  walletAddress: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return emptyLiveProbeAddresses(env).has(walletAddress.toLowerCase());
}

export function walletCollateralUsd(collateral: WalletCollateralSnapshot): number {
  return Math.max(
    collateral.cashUsd ?? 0,
    collateral.clobUsd ?? 0,
    collateral.chainUsd ?? 0
  );
}

export function emptyLiveProbeFundedReason(
  walletAddress: string,
  collateral: WalletCollateralSnapshot,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!isEmptyLiveProbeAddress(walletAddress, env)) return undefined;
  const cashUsd = walletCollateralUsd(collateral);
  const maxUsd = emptyLiveProbeMaxCollateralUsd(env);
  if (cashUsd <= maxUsd) return undefined;
  return `empty live probe has tradeable funds $${cashUsd.toFixed(
    2
  )} > protected max $${maxUsd.toFixed(2)} - refusing live order`;
}
