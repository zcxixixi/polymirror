import type { GlobalConfig, LeaderConfig } from "../config/types.js";
import { isRecentBuyDuplicate } from "../engine/dedup.js";
import { passActivityFilters } from "../engine/filters.js";
import { RiskGate } from "../engine/risk.js";
import { calculateOrderSize } from "../engine/sizing.js";
import type { Activity } from "../monitor/data-api.js";
import { tradeEventKey } from "../monitor/data-api.js";
import type { ResolvedMarketOutcome } from "../monitor/market-resolve.js";
import type { StateStore, TokenMarketEntry } from "../state/store.js";

export interface PreviewReplayResult {
  copyTrades: number;
  detectedBuyTrades: number;
  detectedSellTrades: number;
  copiedBuyTrades: number;
  copiedSellTrades: number;
  buyCoveragePct: number;
  sellCoveragePct: number;
  tradeCoveragePct: number;
  settlements: number;
  skipped: number;
  cashUsd: number;
  minCashUsd: number;
  openCostUsd: number;
  peakOpenCostUsd: number;
  peakMarketCostUsd: number;
  realizedPnlUsd: number;
  cashStarvedSkips: number;
  positionCapSkips: number;
  maxOpenMarketSkips: number;
  unmatchedRedeemSkips: number;
  skipReasons: Record<string, number>;
}

export type ReplayResolveMarket = (
  slug: string,
  atMs: number
) => Promise<ResolvedMarketOutcome | null>;

export interface PreviewReplayOptions {
  store: StateStore;
  leader: LeaderConfig;
  global: GlobalConfig;
  activities: Activity[];
  resolveMarket: ReplayResolveMarket;
}

function activityMs(activity: Activity): number {
  return activity.timestamp > 1e12 ? activity.timestamp : activity.timestamp * 1000;
}

function marketFromActivity(activity: Activity): TokenMarketEntry | undefined {
  if (!activity.asset || !activity.conditionId) return undefined;
  return {
    tokenId: activity.asset,
    conditionId: activity.conditionId,
    title: activity.title,
    slug: activity.slug ?? activity.eventSlug,
    outcome: activity.outcome,
  };
}

function countSkip(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function skip(
  store: StateStore,
  leaderId: string,
  activity: Activity,
  reason: string,
  skipReasons: Record<string, number>
): void {
  countSkip(skipReasons, reason);
  store.audit({
    leaderId,
    action: "SKIP",
    tokenId: activity.asset ?? activity.conditionId,
    side: activity.side ?? activity.type,
    size: activity.size,
    price: activity.price,
    reason,
    preview: true,
  });
}

async function settleOpenConditions(
  store: StateStore,
  leader: LeaderConfig,
  global: GlobalConfig,
  resolveMarket: ReplayResolveMarket,
  atMs: number
): Promise<number> {
  let settlements = 0;
  for (const condition of store.listOpenConditions()) {
    if (condition.leaderId !== leader.id || !condition.slug) continue;
    const resolved = await resolveMarket(condition.slug, atMs);
    if (!resolved?.closed || resolved.winnerTokenIds.length === 0) continue;

    const result = store.settleCondition({
      leaderId: leader.id,
      conditionId: condition.conditionId,
      winnerTokenIds: resolved.winnerTokenIds,
      sourceKeys: [
        `replay-auto-settle:${leader.id}:${condition.conditionId}:${resolved.winnerTokenIds.join(",")}`,
      ],
      cashInitialUsd: global.risk.startingCapitalUsd,
      title: condition.title ?? undefined,
      slug: condition.slug,
      preview: true,
    });
    if (result.closedPositions > 0) settlements++;
  }
  return settlements;
}

async function processRedeem(
  store: StateStore,
  leader: LeaderConfig,
  global: GlobalConfig,
  activity: Activity,
  resolveMarket: ReplayResolveMarket,
  atMs: number,
  skipReasons: Record<string, number>
): Promise<number> {
  const key = tradeEventKey(activity);
  if (store.hasSeen(key)) {
    countSkip(skipReasons, "already seen");
    store.audit({
      leaderId: leader.id,
      action: "SKIP",
      tokenId: activity.conditionId,
      side: "REDEEM",
      size: activity.usdcSize,
      reason: "already seen",
      preview: true,
    });
    return 0;
  }
  if (!activity.conditionId) {
    store.markSeen(key, leader.id);
    skip(store, leader.id, activity, "REDEEM missing conditionId", skipReasons);
    return 0;
  }
  const positions = store.listPositionsByCondition(leader.id, activity.conditionId);
  if (positions.length === 0) {
    store.markSeen(key, leader.id);
    skip(store, leader.id, activity, "no local preview position for condition", skipReasons);
    return 0;
  }
  const slug = activity.slug ?? activity.eventSlug ?? positions.find((p) => p.slug)?.slug;
  if (!slug) {
    store.markSeen(key, leader.id);
    skip(store, leader.id, activity, "REDEEM missing market slug", skipReasons);
    return 0;
  }
  const resolved = await resolveMarket(slug, atMs);
  if (!resolved?.closed || resolved.winnerTokenIds.length === 0) {
    skip(store, leader.id, activity, "market unresolved", skipReasons);
    return 0;
  }
  const result = store.settleCondition({
    leaderId: leader.id,
    conditionId: activity.conditionId,
    winnerTokenIds: resolved.winnerTokenIds,
    sourceKeys: [key],
    cashInitialUsd: global.risk.startingCapitalUsd,
    title: activity.title,
    slug,
    preview: true,
  });
  return result.closedPositions > 0 ? 1 : 0;
}

function openCostUsd(store: StateStore): number {
  return store
    .listPositions()
    .reduce((sum, p) => sum + p.shares * p.avgEntryPrice, 0);
}

function peakConditionOrTokenCostUsd(store: StateStore): number {
  const openConditions = store.listOpenConditions();
  if (openConditions.length > 0) {
    return Math.max(...openConditions.map((c) => c.costUsd));
  }
  const positions = store.listPositions();
  if (positions.length === 0) return 0;
  return Math.max(...positions.map((p) => p.shares * p.avgEntryPrice));
}

function skipCountMatching(
  skipReasons: Record<string, number>,
  matches: (reason: string) => boolean
): number {
  return Object.entries(skipReasons).reduce(
    (sum, [reason, count]) => sum + (matches(reason) ? count : 0),
    0
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function coveragePct(copied: number, detected: number): number {
  if (detected <= 0) return 0;
  return round2((copied / detected) * 100);
}

export async function replayPreviewActivities(
  options: PreviewReplayOptions
): Promise<PreviewReplayResult> {
  const { store, leader, global, activities, resolveMarket } = options;
  const risk = new RiskGate(global, store);
  const skipReasons: Record<string, number> = {};
  let copyTrades = 0;
  let detectedBuyTrades = 0;
  let detectedSellTrades = 0;
  let copiedBuyTrades = 0;
  let copiedSellTrades = 0;
  let settlements = 0;
  let skipped = 0;
  let minCashUsd = store.getCashBalance(global.risk.startingCapitalUsd);
  let peakOpenCostUsd = openCostUsd(store);
  let peakMarketCostUsd = peakConditionOrTokenCostUsd(store);

  const captureRiskSnapshot = () => {
    minCashUsd = Math.min(minCashUsd, store.getCashBalance(global.risk.startingCapitalUsd));
    peakOpenCostUsd = Math.max(peakOpenCostUsd, openCostUsd(store));
    peakMarketCostUsd = Math.max(peakMarketCostUsd, peakConditionOrTokenCostUsd(store));
  };

  const sorted = [...activities].sort((a, b) => activityMs(a) - activityMs(b));
  for (const activity of sorted) {
    const atMs = activityMs(activity);
    settlements += await settleOpenConditions(store, leader, global, resolveMarket, atMs);
    captureRiskSnapshot();

    if (activity.type === "REDEEM") {
      const before = settlements;
      settlements += await processRedeem(
        store,
        leader,
        global,
        activity,
        resolveMarket,
        atMs,
        skipReasons
      );
      if (settlements === before) skipped++;
      captureRiskSnapshot();
      continue;
    }

    if (activity.type !== "TRADE" || !activity.asset || !activity.side) continue;

    if (activity.side === "BUY") detectedBuyTrades++;
    if (activity.side === "SELL") detectedSellTrades++;

    store.audit({
      leaderId: leader.id,
      action: "DETECT",
      tokenId: activity.asset,
      side: activity.side,
      size: activity.size,
      price: activity.price,
      preview: true,
    });

    const filter = passActivityFilters(leader, activity);
    if (!filter.pass) {
      skipped++;
      skip(store, leader.id, activity, filter.reason ?? "filter", skipReasons);
      continue;
    }

    const key = tradeEventKey(activity);
    if (store.hasSeen(key)) {
      skipped++;
      skip(store, leader.id, activity, "already seen", skipReasons);
      continue;
    }

    if (isRecentBuyDuplicate(store, leader.id, activity, global.buyDedupWindowMs)) {
      skipped++;
      skip(store, leader.id, activity, "recent buy dedup", skipReasons);
      continue;
    }

    const sizing = calculateOrderSize(leader, global, activity, store);
    if (sizing.belowMinimum) {
      store.markSeen(key, leader.id);
      skipped++;
      skip(store, leader.id, activity, sizing.reasoning, skipReasons);
      continue;
    }

    const openCheck = risk.canOpenNewMarket(activity.asset, activity.side);
    if (!openCheck.allow) {
      skipped++;
      skip(store, leader.id, activity, openCheck.reason ?? "max markets", skipReasons);
      continue;
    }

    if (activity.side === "BUY") {
      const spendCheck = risk.canSpendUsd(
        leader.id,
        sizing.finalUsd,
        leader.limits?.maxDailyVolumeUsd
      );
      if (!spendCheck.allow) {
        skipped++;
        skip(store, leader.id, activity, spendCheck.reason ?? "volume cap", skipReasons);
        continue;
      }
      const cashCheck = risk.canSpendPreviewCash(sizing.finalUsd);
      if (!cashCheck.allow) {
        skipped++;
        skip(store, leader.id, activity, cashCheck.reason ?? "preview cash", skipReasons);
        continue;
      }
      const tokenCap = risk.canAddTokenExposure(
        activity.asset,
        sizing.finalUsd,
        activity.price ?? 0
      );
      if (!tokenCap.allow) {
        skipped++;
        skip(store, leader.id, activity, tokenCap.reason ?? "token exposure cap", skipReasons);
        continue;
      }
    } else {
      const held = store.getPosition(leader.id, activity.asset);
      if (held < sizing.finalShares) {
        const reason = `SELL held=${held} need=${sizing.finalShares}`;
        store.markSeen(key, leader.id);
        skipped++;
        skip(store, leader.id, activity, reason, skipReasons);
        continue;
      }
    }

    store.recordCopySuccess({
      tradeKeys: [key],
      leaderId: leader.id,
      tokenId: activity.asset,
      side: activity.side,
      filledShares: sizing.finalShares,
      price: activity.price ?? 0,
      filledUsd: sizing.finalUsd,
      auditReason: sizing.reasoning,
      preview: true,
      cashInitialUsd: global.risk.startingCapitalUsd,
      market: marketFromActivity(activity),
    });
    copyTrades++;
    if (activity.side === "BUY") copiedBuyTrades++;
    if (activity.side === "SELL") copiedSellTrades++;
    captureRiskSnapshot();
  }

  const finalAt = sorted.length ? activityMs(sorted[sorted.length - 1]!) : Date.now();
  settlements += await settleOpenConditions(store, leader, global, resolveMarket, finalAt);
  captureRiskSnapshot();

  return {
    copyTrades,
    detectedBuyTrades,
    detectedSellTrades,
    copiedBuyTrades,
    copiedSellTrades,
    buyCoveragePct: coveragePct(copiedBuyTrades, detectedBuyTrades),
    sellCoveragePct: coveragePct(copiedSellTrades, detectedSellTrades),
    tradeCoveragePct: coveragePct(
      copiedBuyTrades + copiedSellTrades,
      detectedBuyTrades + detectedSellTrades
    ),
    settlements,
    skipped,
    cashUsd: store.getCashBalance(global.risk.startingCapitalUsd),
    minCashUsd,
    openCostUsd: openCostUsd(store),
    peakOpenCostUsd,
    peakMarketCostUsd,
    realizedPnlUsd: store.getDailyRealizedPnl(),
    cashStarvedSkips: skipCountMatching(skipReasons, (reason) =>
      reason.startsWith("preview cash ")
    ),
    positionCapSkips: skipCountMatching(
      skipReasons,
      (reason) =>
        reason.includes("max position") ||
        reason.includes("position cap") ||
        reason.includes("token exposure")
    ),
    maxOpenMarketSkips: skipCountMatching(skipReasons, (reason) =>
      reason.startsWith("max open markets")
    ),
    unmatchedRedeemSkips: skipCountMatching(
      skipReasons,
      (reason) => reason === "no local preview position for condition"
    ),
    skipReasons,
  };
}
