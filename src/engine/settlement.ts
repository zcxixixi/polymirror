import type { GlobalConfig, WalletConfig } from "../config/types.js";
import type { LeaderRegistry } from "../leaders/registry.js";
import {
  getActivity,
  redeemEventKey,
  type Activity,
} from "../monitor/data-api.js";
import type { StateStore } from "../state/store.js";
import {
  listRedeemablePositions,
  redeemConditionOnChain,
  type RedeemablePositionRow,
} from "../executor/redeem.js";
import { fetchJsonWithRetry } from "../util/fetch.js";
import { logInfo } from "../notify/logger.js";

const GAMMA_MARKETS = "https://gamma-api.polymarket.com/markets";
const SETTLEMENT_CACHE_TTL_MS = 60_000;

export interface SettlementOptions {
  dataApiUrl?: string;
  wallet?: WalletConfig;
}

export interface SettlementResult {
  leaderRedeems: number;
  autoSettled: number;
  onChainRedeems: number;
  errors: string[];
}

interface TokenSettlement {
  settled: boolean;
  payoutPerShare: number;
  conditionId?: string;
}

const settlementCache = new Map<string, { at: number; value: TokenSettlement | null }>();
const redeemedConditionsThisCycle = new Map<string, boolean>();

function activityMs(a: Activity): number {
  return a.timestamp > 1e12 ? a.timestamp : a.timestamp * 1000;
}

function shouldRedeemOnChain(
  preview: boolean,
  global: GlobalConfig,
  wallet?: WalletConfig
): wallet is WalletConfig {
  return !preview && global.execution.autoRedeemOnChain && wallet !== undefined;
}

async function fetchTokenSettlement(
  tokenId: string,
  retries: number
): Promise<TokenSettlement | null> {
  const hit = settlementCache.get(tokenId);
  const now = Date.now();
  if (hit && now - hit.at < SETTLEMENT_CACHE_TTL_MS) return hit.value;

  try {
    const url = `${GAMMA_MARKETS}?clob_token_ids=${encodeURIComponent(tokenId)}`;
    const rows = await fetchJsonWithRetry<unknown[]>(url, {}, retries);
    if (!Array.isArray(rows) || rows.length === 0) {
      settlementCache.set(tokenId, { at: now, value: null });
      return null;
    }

    const market = rows[0] as Record<string, unknown>;
    const conditionIdRaw = market.conditionId ?? market.condition_id;
    const conditionId =
      conditionIdRaw != null && String(conditionIdRaw) !== ""
        ? String(conditionIdRaw)
        : undefined;

    if (market.closed !== true) {
      const value = { settled: false, payoutPerShare: 0, conditionId };
      settlementCache.set(tokenId, { at: now, value });
      return value;
    }

    const tokens = market.tokens;
    if (!Array.isArray(tokens)) {
      settlementCache.set(tokenId, { at: now, value: null });
      return null;
    }

    let payoutPerShare = 0;
    for (const t of tokens) {
      if (!t || typeof t !== "object") continue;
      const row = t as Record<string, unknown>;
      const id =
        row.token_id != null
          ? String(row.token_id)
          : row.tokenId != null
            ? String(row.tokenId)
            : "";
      if (id !== tokenId) continue;
      payoutPerShare = row.winner === true ? 1 : 0;
      break;
    }

    const value = { settled: true, payoutPerShare, conditionId };
    settlementCache.set(tokenId, { at: now, value });
    return value;
  } catch {
    settlementCache.set(tokenId, { at: now, value: null });
    return null;
  }
}

async function pollLeaderRedeemCandidates(
  registry: LeaderRegistry,
  global: GlobalConfig,
  dataApiUrl?: string
): Promise<{ leaderId: string; activity: Activity }[]> {
  const leaders = registry.enabled();
  const maxAgeMs = global.maxTradeAgeHours * 3600 * 1000;
  const now = Date.now();
  const candidates: { leaderId: string; activity: Activity }[] = [];

  const settled = await Promise.allSettled(
    leaders.map(async (leader) => {
      const activities = await getActivity(
        dataApiUrl ?? "",
        {
          user: leader.address!,
          limit: global.activityLimit,
          offset: 0,
          type: "REDEEM",
          sortBy: "TIMESTAMP",
          sortDirection: "DESC",
        },
        global.execution.networkRetryLimit
      );

      for (const activity of activities) {
        if (activity.type !== "REDEEM" || !activity.asset) continue;
        if (now - activityMs(activity) > maxAgeMs) continue;
        if ((activity.size ?? 0) < 0.01) continue;
        candidates.push({ leaderId: leader.id, activity });
      }
    })
  );

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    if (result.status === "rejected") {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logInfo("Leader REDEEM poll failed", {
        leaderId: leaders[i]!.id,
        error: msg,
      });
    }
  }

  return candidates;
}

function payoutFromLeaderRedeem(activity: Activity, ourShares: number): number {
  const leaderShares = activity.size ?? 0;
  const leaderUsdc = activity.usdcSize ?? 0;
  if (ourShares <= 0 || leaderShares <= 0) return 0;
  return Math.round((ourShares * leaderUsdc / leaderShares) * 100) / 100;
}

async function redeemConditionOnce(
  wallet: WalletConfig,
  conditionId: string,
  errors: string[]
): Promise<boolean> {
  const cached = redeemedConditionsThisCycle.get(conditionId);
  if (cached !== undefined) return cached;

  const result = await redeemConditionOnChain(wallet, conditionId);
  const ok = result.ok || result.benignFailure === true;
  redeemedConditionsThisCycle.set(conditionId, ok);
  if (!ok) errors.push(`redeem ${conditionId.slice(0, 12)}: ${result.error ?? "failed"}`);
  return ok;
}

async function conditionIdForToken(
  tokenId: string,
  activityConditionId: string | undefined,
  retries: number
): Promise<string | undefined> {
  if (activityConditionId) return activityConditionId;
  return (await fetchTokenSettlement(tokenId, retries))?.conditionId;
}

async function ensureLiveRedeem(
  liveRedeem: boolean,
  wallet: WalletConfig | undefined,
  tokenId: string,
  conditionId: string | undefined,
  errors: string[]
): Promise<boolean> {
  if (!liveRedeem) return true;
  if (!wallet) return false;

  const resolved =
    conditionId ??
    (await conditionIdForToken(tokenId, undefined, 1));
  if (!resolved) {
    logInfo("Live settlement skipped - missing conditionId", {
      tokenId: tokenId.slice(0, 12),
    });
    return false;
  }

  return redeemConditionOnce(wallet, resolved, errors);
}

function settleTrackedTokenPayouts(
  store: StateStore,
  tokenPayouts: Map<string, number>,
  preview: boolean,
  cashInitialUsd: number
): number {
  let settled = 0;
  for (const [tokenId, payoutPerShare] of tokenPayouts) {
    if (store.getTotalTokenShares(tokenId) <= 0.001) continue;
    settled += store.recordTokenSettlement(
      tokenId,
      payoutPerShare,
      preview,
      preview ? cashInitialUsd : undefined
    );
  }
  return settled;
}

async function processOnChainRedeemableScan(
  wallet: WalletConfig,
  store: StateStore,
  preview: boolean,
  cashInitialUsd: number,
  errors: string[]
): Promise<number> {
  const tracked = new Set(store.listOpenTokenIds());
  if (tracked.size === 0) return 0;

  let redeemable: RedeemablePositionRow[] = [];
  try {
    redeemable = await listRedeemablePositions(wallet.proxyAddress);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`redeemable scan: ${msg}`);
    return 0;
  }

  const byCondition = new Map<string, RedeemablePositionRow[]>();
  for (const row of redeemable) {
    if (!tracked.has(row.tokenId)) continue;
    const bucket = byCondition.get(row.conditionId) ?? [];
    bucket.push(row);
    byCondition.set(row.conditionId, bucket);
  }

  let onChainRedeems = 0;
  for (const [conditionId, rows] of byCondition) {
    const ok = await redeemConditionOnce(wallet, conditionId, errors);
    if (!ok) continue;

    onChainRedeems++;
    const tokenPayouts = new Map<string, number>();
    for (const row of rows) tokenPayouts.set(row.tokenId, row.payoutPerShare);

    const settled = settleTrackedTokenPayouts(
      store,
      tokenPayouts,
      preview,
      cashInitialUsd
    );
    if (settled > 0) {
      logInfo("Synced local positions after on-chain redeem", {
        conditionId: conditionId.slice(0, 12),
        leaders: settled,
      });
    }
  }

  return onChainRedeems;
}

export async function processSettlements(
  registry: LeaderRegistry,
  global: GlobalConfig,
  store: StateStore,
  preview: boolean,
  options: SettlementOptions = {}
): Promise<SettlementResult> {
  const errors: string[] = [];
  const cashInitialUsd = global.risk.startingCapitalUsd;
  const liveRedeem = shouldRedeemOnChain(preview, global, options.wallet);
  const liveWallet = liveRedeem ? options.wallet! : undefined;
  let leaderRedeems = 0;
  let autoSettled = 0;
  let onChainRedeems = 0;
  redeemedConditionsThisCycle.clear();

  if (liveWallet) {
    onChainRedeems += await processOnChainRedeemableScan(
      liveWallet,
      store,
      preview,
      cashInitialUsd,
      errors
    );
  }

  const redeemCandidates = await pollLeaderRedeemCandidates(
    registry,
    global,
    options.dataApiUrl
  );
  for (const { leaderId, activity } of redeemCandidates) {
    const tokenId = activity.asset!;
    const key = redeemEventKey(activity);
    if (store.hasSeen(key)) continue;

    const ourShares = store.getPosition(leaderId, tokenId);
    if (ourShares <= 0.001) {
      store.markSeen(key, leaderId);
      continue;
    }

    if (liveRedeem) {
      const chainOk = await ensureLiveRedeem(
        liveRedeem,
        liveWallet,
        tokenId,
        activity.conditionId,
        errors
      );
      if (!chainOk) continue;
      onChainRedeems++;
    }

    const payoutUsd = payoutFromLeaderRedeem(activity, ourShares);
    const ok = store.recordRedeemSettlement({
      tradeKey: key,
      leaderId,
      tokenId,
      payoutUsd,
      preview,
      cashInitialUsd: preview ? cashInitialUsd : undefined,
      auditReason: `leader REDEEM ${ourShares} shares -> $${payoutUsd.toFixed(2)}`,
    });
    if (ok) leaderRedeems++;
  }

  const openTokenIds = [...new Set(store.listOpenTokenIds())];
  for (const tokenId of openTokenIds) {
    const settlement = await fetchTokenSettlement(
      tokenId,
      Math.min(global.execution.networkRetryLimit, 1)
    );
    if (!settlement?.settled) continue;

    if (liveRedeem) {
      const chainOk = await ensureLiveRedeem(
        liveRedeem,
        liveWallet,
        tokenId,
        settlement.conditionId,
        errors
      );
      if (!chainOk) continue;
      onChainRedeems++;
    }

    const settled = store.recordTokenSettlement(
      tokenId,
      settlement.payoutPerShare,
      preview,
      preview ? cashInitialUsd : undefined
    );
    if (settled > 0) {
      autoSettled += settled;
      logInfo("Auto-settled resolved market positions", {
        tokenId: tokenId.slice(0, 12),
        payoutPerShare: settlement.payoutPerShare,
        leaders: settled,
        onChain: liveRedeem,
      });
    }
  }

  return { leaderRedeems, autoSettled, onChainRedeems, errors };
}

export function resetSettlementCache(): void {
  settlementCache.clear();
  redeemedConditionsThisCycle.clear();
}
