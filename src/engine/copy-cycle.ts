import type { RuntimeConfig } from "../config/types.js";
import { pollLeaders } from "../monitor/poll.js";
import type { PollActivityCache } from "../monitor/poll.js";
import { tradeEventKey } from "../monitor/data-api.js";
import type { Activity } from "../monitor/data-api.js";
import { fetchResolvedMarketOutcome } from "../monitor/market-resolve.js";
import { calculateOrderSize } from "../engine/sizing.js";
import {
  prepareExecutableGuardedOrder,
  prepareGuardedOrderTerms,
} from "../engine/execution-price.js";
import { processSettlements } from "../engine/settlement.js";
import { passActivityFilters } from "../engine/filters.js";
import { isAnyTradeKeySeen, isRecentBuyDuplicate } from "../engine/dedup.js";
import { ConflictTracker } from "../engine/conflict.js";
import { aggregateTrades } from "../engine/aggregate.js";
import { RiskGate, assertLiveTradingAllowed } from "../engine/risk.js";
import type { DecisionObservationRef, StateStore, TokenMarketEntry } from "../state/store.js";
import { processPendingOrders } from "../engine/pending-orders.js";
import { adoptUntrackedOpenOrders } from "../engine/order-reconcile.js";
import {
  checkWalletDrifts,
  fetchWalletTokenBalance,
  fetchWalletCollateralUsdc,
  fetchWalletCollateral,
  checkLiveBuyCollateralAndAllowance,
  checkLiveSellTokenAllowance,
  canTradeWithChainFallback,
  proportionalSellable,
} from "../executor/balance.js";
import { ClobExecutor, isDefiniteOrderRejection, type PlaceOrderResult } from "../executor/clob.js";
import {
  formatGeoblockMessage,
  getCachedGeoblockStatus,
} from "../executor/geoblock.js";
import {
  fetchBestExecutablePrice,
  fetchExecutableOrderBookSnapshot,
  quoteExecutableOrderBook,
} from "../executor/orderbook.js";
import { calculateCopySlippageLossPct } from "../sim/copy-slippage.js";
import { logInfo, logError, logPreviewAction } from "../notify/logger.js";
import {
  healthSnapshot,
  syncAggregateHealth,
} from "../notify/health.js";
import { assertDashboardAuthForBind } from "../api/auth.js";
import { syncApiServer, type ApiServerState } from "../api/server.js";
import { AccountManager } from "../accounts/manager.js";
import { LeaderRegistry } from "../leaders/registry.js";
import { emptyLiveProbeFundedReason } from "../live/protected-probe.js";
import { loadTelegramConfig, TelegramNotifier } from "../notify/telegram.js";
import { ensureUndiciGlobalProxy } from "../util/proxy.js";

export interface CopyCycleResult {
  fetched: number;
  copied: number;
  skipped: number;
  pendingFilled: number;
  errors: string[];
  walletDrifts: string[];
  pendingOrders: number;
}

interface QueuedTrade {
  leaderId: string;
  activity: Activity;
  sourceTradeKeys: string[];
  rawObservationRefs?: DecisionObservationRef[];
}

const SETTLEMENT_CHECK_INTERVAL_MS = 60_000;
const settlementChecks = new Map<string, number>();
const settlementStoreIds = new WeakMap<StateStore, number>();
let nextSettlementStoreId = 1;

function settlementStoreId(store: StateStore): number {
  let id = settlementStoreIds.get(store);
  if (id === undefined) {
    id = nextSettlementStoreId++;
    settlementStoreIds.set(store, id);
  }
  return id;
}

function tokenMarketFromActivity(activity: Activity): TokenMarketEntry | undefined {
  if (!activity.asset || !activity.conditionId) return undefined;
  return {
    tokenId: activity.asset,
    conditionId: activity.conditionId,
    title: activity.title,
    slug: activity.slug ?? activity.eventSlug,
    outcome: activity.outcome,
  };
}

function skip(
  store: StateStore,
  leaderId: string,
  activity: Activity,
  reason: string,
  preview: boolean,
  execution?: {
    leaderPrice: number;
    executablePrice: number | null;
    slippagePct: number | null;
    orderPrice?: number;
    orderShares?: number;
    decisionTerms?: Record<string, unknown>;
  }
): void {
  store.audit({
    leaderId,
    action: "SKIP",
    tokenId: activity.asset,
    side: activity.side,
    size: execution?.orderShares ?? activity.size,
    price: execution?.orderPrice ?? activity.price,
    leaderPrice: execution?.leaderPrice,
    executablePrice: execution?.executablePrice,
    slippagePct: execution?.slippagePct,
    reason,
    preview,
    exactTerms: execution?.decisionTerms,
  });
}

async function settleResolvedPreviewPositions(
  config: RuntimeConfig,
  store: StateStore
): Promise<{ settled: number; errors: string[] }> {
  if (!config.app.global.previewMode) return { settled: 0, errors: [] };

  const errors: string[] = [];
  let settled = 0;
  const now = Date.now();

  for (const condition of store.listOpenConditions()) {
    if (!condition.slug) continue;

    const checkKey = `${settlementStoreId(store)}:${condition.leaderId}:${condition.conditionId}`;
    const lastChecked = settlementChecks.get(checkKey) ?? 0;
    if (now - lastChecked < SETTLEMENT_CHECK_INTERVAL_MS) continue;
    settlementChecks.set(checkKey, now);

    let resolved: Awaited<ReturnType<typeof fetchResolvedMarketOutcome>> | null = null;
    let resolutionError: string | null = null;
    try {
      resolved = await fetchResolvedMarketOutcome(condition.slug);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      resolutionError = msg;
      errors.push(`${condition.leaderId}: auto settle failed — ${msg}`);
      resolved = null;
    }

    const sourceKey = `auto-settle-observation:${condition.leaderId}:${condition.conditionId}`;
    const raw = store.getActiveExperiment()
      ? store.recordRawEvent({
          sourceId: sourceKey,
          payload: {
            type: "AUTO_SETTLEMENT",
            leaderId: condition.leaderId,
            conditionId: condition.conditionId,
            slug: condition.slug,
            resolution: resolved,
            resolutionError,
          },
          sourceTimestamp: now,
          observedTimestamp: Date.now(),
        })
      : undefined;
    store.setDecisionRawEventIds(raw ? [raw.rawEventId] : []);
    store.audit({
      leaderId: condition.leaderId,
      action: "DETECT",
      tokenId: condition.conditionId,
      side: "REDEEM",
      reason: "auto settlement detected",
      preview: true,
    });
    if (!resolved) {
      store.audit({ leaderId: condition.leaderId, action: "SKIP", tokenId: condition.conditionId, side: "REDEEM", reason: "settlement evidence unavailable", reasonCode: "settlement_evidence_unavailable", preview: true });
      store.setDecisionRawEventIds([]);
      continue;
    }
    if (!resolved.closed) {
      store.audit({ leaderId: condition.leaderId, action: "SKIP", tokenId: condition.conditionId, side: "REDEEM", reason: "market unresolved", reasonCode: "market_unresolved", preview: true });
      store.setDecisionRawEventIds([]);
      continue;
    }
    if (resolved.winnerTokenIds.length === 0) {
      store.audit({ leaderId: condition.leaderId, action: "SKIP", tokenId: condition.conditionId, side: "REDEEM", reason: "winner set unavailable", reasonCode: "winner_set_unavailable", preview: true });
      store.setDecisionRawEventIds([]);
      continue;
    }

    const result = store.settleCondition({
      leaderId: condition.leaderId,
      conditionId: condition.conditionId,
      winnerTokenIds: resolved.winnerTokenIds,
      sourceKeys: [sourceKey],
      cashInitialUsd: config.app.global.risk.startingCapitalUsd,
      title: condition.title ?? undefined,
      slug: condition.slug,
      preview: true,
    });

    if (result.closedPositions > 0) {
      settled++;
      settlementChecks.delete(checkKey);
      logInfo("Preview auto-settled resolved market", {
        leader: condition.leaderId,
        condition: condition.conditionId.slice(0, 12),
        positions: result.closedPositions,
        payout: result.payoutUsd,
        pnl: result.realizedPnl,
      });
    }
    store.setDecisionRawEventIds([]);
  }

  return { settled, errors };
}

export async function runCopyCycle(
  config: RuntimeConfig,
  store: StateStore,
  telegram?: TelegramNotifier,
  options: { pollActivityCache?: PollActivityCache } = {}
): Promise<CopyCycleResult> {
  store.setDecisionRawEventIds([]);
  const registry = new LeaderRegistry(config.app.leaders);
  const executor = new ClobExecutor(config.wallet, config.app.global);
  const risk = new RiskGate(config.app.global, store);
  const conflict = new ConflictTracker();
  const leaderMap = new Map(registry.enabled().map((l) => [l.id, l]));
  const errors: string[] = [];
  let fetched = 0;
  let copied = 0;
  let skipped = 0;
  let pendingFilled = 0;
  const requestedCopyPriceMode = config.app.global.copyPriceMode ?? "leader_limit";
  const copyPriceModeBinding = store.ensureCopyPriceMode(requestedCopyPriceMode);
  const copyPriceModeMismatch = copyPriceModeBinding.status === "mismatch"
    ? `copy price mode mismatch: database=${copyPriceModeBinding.mode} config=${requestedCopyPriceMode}`
    : null;

  const pendingResult = await processPendingOrders(config, store, risk, telegram);
  pendingFilled += pendingResult.filled;
  errors.push(...pendingResult.errors);

  if (config.app.global.previewMode) {
    const settlementResult = await settleResolvedPreviewPositions(config, store);
    copied += settlementResult.settled;
    errors.push(...settlementResult.errors);
  } else {
    const settlementResult = await processSettlements(
      registry,
      config.app.global,
      store,
      false,
      {
        wallet: config.wallet,
        dataApiUrl: config.wallet.dataApiUrl,
      }
    );
    copied += settlementResult.leaderRedeems + settlementResult.autoSettled;
    errors.push(...settlementResult.errors);
  }

  if (copyPriceModeMismatch) {
    errors.unshift(copyPriceModeMismatch);
    return {
      fetched: 0,
      copied,
      skipped: 0,
      pendingFilled,
      errors,
      walletDrifts: [],
      pendingOrders: store.countPendingOrders(),
    };
  }

  const gate = risk.canTrade();
  if (!gate.allow) {
    logInfo("Copy cycle blocked", { reason: gate.reason });
    if (gate.reason?.includes("daily loss cap") && telegram) {
      telegram.killSwitch(gate.reason);
    }
    return {
      fetched: 0,
      copied: 0,
      skipped: 0,
      pendingFilled,
      errors: gate.reason ? [gate.reason, ...errors] : errors,
      walletDrifts: [],
      pendingOrders: store.countPendingOrders(),
    };
  }

  if (!config.app.global.previewMode) {
    const orphanResult = await adoptUntrackedOpenOrders(executor, store);
    if (orphanResult.adopted > 0) {
      logInfo("Recovered orphan CLOB orders", { adopted: orphanResult.adopted });
    }
    errors.push(...orphanResult.warnings);
  }

  const preview = config.app.global.previewMode;
  let liveCollateral: Awaited<ReturnType<typeof fetchWalletCollateral>> | undefined;
  let walletDrifts: string[] = [];
  if (!preview && config.app.global.risk.syncWalletBalance) {
    const drifts = await checkWalletDrifts(
      config.wallet,
      store.listOpenTokenIds(),
      (tokenId) => store.getTotalTokenShares(tokenId)
    );
    walletDrifts = drifts.map(
      (d) => `${d.tokenId.slice(0, 12)}: wallet=${d.walletShares} tracked=${d.trackedShares}`
    );
    if (drifts.length > 0) {
      logInfo("Wallet vs tracked position drift", { drifts: walletDrifts });
    }
  }

  const pendingOrders = store.countPendingOrders();

  const pollResults = await pollLeaders(
    registry,
    config.app.global,
    options.pollActivityCache
  );
  const rawQueue: QueuedTrade[] = [];
  const observationRefByLineageKey = new Map<string, DecisionObservationRef>();

  for (const result of pollResults) {
    if (result.error) {
      errors.push(`${result.leaderId}: poll failed — ${result.error}`);
    }
    fetched += result.fetched;
    const observations = result.observations
      ?? result.candidates.map((activity) => ({ activity, candidate: true as const }));
    for (const observation of observations) {
      const activity = observation.activity;
      const sourceKey = tradeEventKey(activity);
      const rawEvent = store.getActiveExperiment()
        ? store.recordRawEvent({
            sourceId: sourceKey,
            payload: {
              ...activity,
              leaderId: result.leaderId,
              candidate: observation.candidate,
              rejectionReasonCode: "rejectionReasonCode" in observation
                ? observation.rejectionReasonCode ?? null
                : null,
            },
            sourceTimestamp: activity.timestamp,
            observedTimestamp: Date.now(),
          })
        : undefined;
      const rawObservationRef = rawEvent ? store.latestObservationRef(rawEvent.rawEventId) : undefined;
      const lineageKey = rawObservationRef
        ? `${rawObservationRef.rawEventId}:${rawObservationRef.observationId}`
        : undefined;
      if (lineageKey && rawObservationRef) observationRefByLineageKey.set(lineageKey, rawObservationRef);
      if (!observation.candidate) {
        store.setDecisionObservationRefs(rawObservationRef ? [rawObservationRef] : []);
        store.audit({
          leaderId: result.leaderId,
          action: "DETECT",
          tokenId: activity.asset ?? activity.conditionId,
          side: activity.side ?? activity.type,
          size: activity.size,
          price: activity.price,
          reason: "raw activity detected",
          preview,
        });
        store.audit({
          leaderId: result.leaderId,
          action: "SKIP",
          tokenId: activity.asset ?? activity.conditionId,
          side: activity.side ?? activity.type,
          size: activity.size,
          price: activity.price,
          reason: observation.rejectionReasonCode ?? "poll rejected activity",
          reasonCode: observation.rejectionReasonCode ?? "poll_rejected_activity",
          preview,
        });
        store.setDecisionRawEventIds([]);
        skipped++;
        continue;
      }
      rawQueue.push({
        leaderId: result.leaderId,
        activity,
        sourceTradeKeys: [sourceKey],
        rawObservationRefs: rawObservationRef ? [rawObservationRef] : [],
      });
    }
  }

  const aggregated = aggregateTrades(
    rawQueue.map((item) => ({
      leaderId: item.leaderId,
      activity: item.activity,
      sourceLineageKeys: item.rawObservationRefs?.map((ref) => `${ref.rawEventId}:${ref.observationId}`),
    })),
    config.app.global.tradeAggregationWindowMs
  );
  const queue: QueuedTrade[] = aggregated.map((a) => ({
    leaderId: a.leaderId,
    activity: a.activity,
    sourceTradeKeys: a.sourceTradeKeys,
    rawObservationRefs: (a.sourceLineageKeys ?? [])
      .map((key) => observationRefByLineageKey.get(key))
      .filter((ref): ref is DecisionObservationRef => Boolean(ref)),
  }));

  const buyWindow = config.app.global.buyDedupWindowMs;

  let geoblockMsg: string | undefined;
  if (!preview) {
    const geo = await getCachedGeoblockStatus();
    if (geo?.blocked) {
      geoblockMsg = formatGeoblockMessage(geo);
      logError("Live copy blocked by CLOB geoblock", {
        ip: geo.ip,
        country: geo.country,
        region: geo.region,
      });
      errors.push(geoblockMsg);
    }
  }

  for (const { leaderId, activity, sourceTradeKeys, rawObservationRefs } of queue) {
    store.setDecisionObservationRefs(rawObservationRefs ?? []);
    const leader = registry.getById(leaderId);
    if (!leader || !leader.enabled) continue;

    if (activity.type === "REDEEM") {
      const conditionId = activity.conditionId;
      store.audit({
        leaderId,
        action: "DETECT",
        tokenId: conditionId,
        side: "REDEEM",
        size: activity.usdcSize,
        reason: activity.title,
        preview,
      });

      if (isAnyTradeKeySeen(store, sourceTradeKeys)) {
        skipped++;
        store.audit({
          leaderId,
          action: "SKIP",
          tokenId: conditionId,
          side: "REDEEM",
          size: activity.usdcSize,
          reason: "already seen",
          preview,
        });
        continue;
      }

      if (!preview) {
        skipped++;
        store.audit({
          leaderId,
          action: "SKIP",
          tokenId: conditionId,
          side: "REDEEM",
          reason: "REDEEM handled by settlement engine",
          preview,
        });
        continue;
      }

      if (!conditionId) {
        store.markSeenMany(sourceTradeKeys, leaderId);
        skipped++;
        store.audit({
          leaderId,
          action: "SKIP",
          side: "REDEEM",
          reason: "REDEEM missing conditionId",
          preview,
        });
        continue;
      }

      const positions = store.listPositionsByCondition(leaderId, conditionId);
      if (positions.length === 0) {
        store.markSeenMany(sourceTradeKeys, leaderId);
        skipped++;
        store.audit({
          leaderId,
          action: "SKIP",
          tokenId: conditionId,
          side: "REDEEM",
          reason: "no local preview position for condition",
          preview,
        });
        continue;
      }

      const slug = activity.slug ?? activity.eventSlug ?? positions.find((p) => p.slug)?.slug ?? undefined;
      if (!slug) {
        store.markSeenMany(sourceTradeKeys, leaderId);
        skipped++;
        store.audit({
          leaderId,
          action: "SKIP",
          tokenId: conditionId,
          side: "REDEEM",
          reason: "REDEEM missing market slug",
          preview,
        });
        continue;
      }

      let resolved: Awaited<ReturnType<typeof fetchResolvedMarketOutcome>> | null = null;
      try {
        resolved = await fetchResolvedMarketOutcome(slug);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${leaderId}: redeem resolve failed — ${msg}`);
        store.audit({
          leaderId,
          action: "ERROR",
          tokenId: conditionId,
          side: "REDEEM",
          reason: msg,
          preview,
        });
        continue;
      }

      if (!resolved?.closed || resolved.winnerTokenIds.length === 0) {
        skipped++;
        store.audit({
          leaderId,
          action: "SKIP",
          tokenId: conditionId,
          side: "REDEEM",
          reason: "market unresolved",
          preview,
        });
        continue;
      }

      const settled = store.settleCondition({
        leaderId,
        conditionId,
        winnerTokenIds: resolved.winnerTokenIds,
        sourceKeys: sourceTradeKeys,
        cashInitialUsd: config.app.global.risk.startingCapitalUsd,
        title: activity.title,
        slug,
        preview,
      });

      if (settled.closedPositions > 0) {
        copied++;
        logInfo("Preview REDEEM settled", {
          leader: leaderId,
          condition: conditionId.slice(0, 12),
          payout: settled.payoutUsd,
          pnl: settled.realizedPnl,
        });
      } else {
        skipped++;
      }
      continue;
    }

    if (!activity.asset || !activity.side) {
      skipped++;
      store.audit({
        leaderId,
        action: "DETECT",
        tokenId: activity.asset,
        side: activity.side,
        size: activity.size,
        price: activity.price,
        preview,
      });
      skip(store, leaderId, activity, "unsupported or incomplete activity", preview);
      continue;
    }

    if (geoblockMsg) {
      skipped++;
      skip(store, leaderId, activity, geoblockMsg, preview);
      continue;
    }

    store.audit({
      leaderId,
      action: "DETECT",
      tokenId: activity.asset,
      side: activity.side,
      size: activity.size,
      price: activity.price,
      preview,
    });

    const filter = passActivityFilters(leader, activity);
    if (!filter.pass) {
      skipped++;
      skip(store, leaderId, activity, filter.reason ?? "filter", preview);
      continue;
    }

    if (isAnyTradeKeySeen(store, sourceTradeKeys)) {
      skipped++;
      skip(store, leaderId, activity, "already seen", preview);
      continue;
    }

    if (!preview && store.hasLiveOrderIntentForAnyKey(sourceTradeKeys)) {
      skipped++;
      skip(store, leaderId, activity, "live order intent pending recovery", preview);
      continue;
    }

    if (isRecentBuyDuplicate(store, leaderId, activity, buyWindow)) {
      skipped++;
      skip(store, leaderId, activity, "recent buy dedup", preview);
      continue;
    }

    const conflictDecision = conflict.check(
      config.app.global.conflict,
      leaderMap,
      leaderId,
      activity
    );
    if (!conflictDecision.allow) {
      skipped++;
      skip(store, leaderId, activity, conflictDecision.reason ?? "conflict", preview);
      continue;
    }

    const sizing = calculateOrderSize(leader, config.app.global, activity, store);
    if (sizing.belowMinimum) {
      store.markSeenMany(sourceTradeKeys, leaderId);
      skipped++;
      skip(store, leaderId, activity, sizing.reasoning, preview);
      continue;
    }

    const openCheck = risk.canOpenNewMarket(activity.asset, activity.side);
    if (!openCheck.allow) {
      skipped++;
      skip(store, leaderId, activity, openCheck.reason ?? "max markets", preview);
      continue;
    }

    const leaderPrice = activity.price ?? 0;
    const guardedExecution = config.app.global.copyPriceMode === "executable_guarded";
    let observedExecutablePrice: number | null = null;
    let observedSlippagePct: number | null = null;
    let orderPrice = leaderPrice;
    let orderShares = sizing.finalShares;
    let orderUsd = sizing.finalUsd;
    let guardedTickSize: number | undefined;
    let guardedFeeRate = 0;
    let guardedFeeExponent = 0;
    let guardedQuoteEvidence: Record<string, unknown> | null = null;
    let executionAudit:
      | {
          leaderPrice: number;
          executablePrice: number | null;
          slippagePct: number | null;
          orderPrice: number;
          orderShares: number;
          decisionTerms?: Record<string, unknown>;
        }
      | undefined;

    if (guardedExecution) {
      let snapshot = null;
      try {
        snapshot = await fetchExecutableOrderBookSnapshot(
          config.wallet.clobUrl,
          config.wallet.chainId,
          activity.asset,
          activity.side
        );
      } catch {
        snapshot = null;
      }
      const terms = prepareGuardedOrderTerms({
        side: activity.side,
        leaderPrice,
        targetUsd: sizing.finalUsd,
        targetShares: sizing.finalShares,
        minOrderUsd: config.app.global.risk.minOrderUsd,
        absoluteTolerance: config.app.global.risk.slippageTolerance,
        tickSize: snapshot?.tickSize,
      });
      if (!terms.allow || terms.orderPrice === null) {
        skipped++;
        skip(store, leaderId, activity, terms.reason ?? "invalid guarded order", preview);
        continue;
      }
      const quote = snapshot
        ? quoteExecutableOrderBook(
          snapshot.levels,
          activity.side,
          terms.orderShares,
          terms.orderPrice,
          snapshot.minOrderShares,
          activity.side === "BUY"
            ? Math.round(terms.orderUsd * 100) / 100
            : undefined
        )
        : null;
      guardedQuoteEvidence = snapshot ? {
        levels: snapshot.levels,
        tickSize: snapshot.tickSize,
        minOrderShares: snapshot.minOrderShares,
        feeRate: snapshot.feeRate,
        feeExponent: snapshot.feeExponent,
      } : null;
      const guardedDecisionTerms = {
        requestedPrice: terms.orderPrice,
        requestedShares: terms.orderShares,
        quoteBestPrice: quote?.averagePrice ?? quote?.bestPrice ?? null,
        guardedTickSize: snapshot?.tickSize ?? null,
        guardedFeeRate: snapshot?.feeRate ?? 0,
        guardedFeeExponent: snapshot?.feeExponent ?? 0,
        quoteEvidence: guardedQuoteEvidence,
      };
      observedExecutablePrice = quote?.fullyFillable
        ? quote.averagePrice
        : (quote?.bestPrice ?? null);
      const guarded = prepareExecutableGuardedOrder({
        side: activity.side,
        leaderPrice,
        executablePrice: observedExecutablePrice,
        targetUsd: sizing.finalUsd,
        targetShares: sizing.finalShares,
        minOrderUsd: config.app.global.risk.minOrderUsd,
        absoluteTolerance: config.app.global.risk.slippageTolerance,
        tickSize: snapshot?.tickSize,
      });
      observedSlippagePct = guarded.slippagePct;
      if (!guarded.allow || guarded.orderPrice === null) {
        skipped++;
        skip(
          store,
          leaderId,
          activity,
          guarded.reason ?? "guarded execution rejected",
          preview,
          {
            leaderPrice,
            executablePrice: observedExecutablePrice,
            slippagePct: observedSlippagePct,
            orderPrice: terms.orderPrice,
            orderShares: terms.orderShares,
            decisionTerms: guardedDecisionTerms,
          }
        );
        continue;
      }
      if (!quote?.fullyFillable) {
        const reason = activity.side === "BUY"
          ? `executable depth $${Number((quote?.availableUsd ?? 0).toFixed(4))} < $${Number((Math.round(terms.orderUsd * 100) / 100).toFixed(2))}`
          : `executable depth ${Number((quote?.availableShares ?? 0).toFixed(4))} < ${terms.orderShares} shares`;
        skipped++;
        skip(
          store,
          leaderId,
          activity,
          reason,
          preview,
          {
            leaderPrice,
            executablePrice: observedExecutablePrice,
            slippagePct: observedSlippagePct,
            orderPrice: terms.orderPrice,
            orderShares: terms.orderShares,
            decisionTerms: guardedDecisionTerms,
          }
        );
        continue;
      }
      if (!quote.meetsMinOrderSize) {
        const minOrderShares = Number(quote.minOrderShares.toFixed(4));
        skipped++;
        skip(
          store,
          leaderId,
          activity,
          `market min order ${minOrderShares} > ${Number(quote.filledShares.toFixed(4))} shares`,
          preview,
          {
            leaderPrice,
            executablePrice: observedExecutablePrice,
            slippagePct: observedSlippagePct,
            orderPrice: terms.orderPrice,
            orderShares: terms.orderShares,
            decisionTerms: guardedDecisionTerms,
          }
        );
        continue;
      }
      orderPrice = guarded.orderPrice;
      orderShares = guarded.orderShares;
      orderUsd = guarded.orderUsd;
      guardedTickSize = snapshot?.tickSize;
      guardedFeeRate = snapshot?.feeRate ?? 0;
      guardedFeeExponent = snapshot?.feeExponent ?? 0;
      executionAudit = {
        leaderPrice,
        executablePrice: observedExecutablePrice,
        slippagePct: observedSlippagePct,
        orderPrice,
        orderShares,
        decisionTerms: guardedDecisionTerms,
      };
      const maxOrderUsd = Math.min(
        config.app.global.risk.maxOrderUsd,
        leader.limits?.maxOrderUsd ?? Infinity
      );
      if (orderUsd > maxOrderUsd + 1e-9) {
        skipped++;
        skip(
          store,
          leaderId,
          activity,
          `guarded max order $${orderUsd.toFixed(4)} > $${maxOrderUsd}`,
          preview,
          executionAudit
        );
        continue;
      }
      if (activity.side === "BUY" && leader.limits?.maxPositionUsd !== undefined) {
        const basis = config.app.global.risk.positionCapBasis ?? "market";
        const heldUsd = basis === "cost"
          ? store.getPositionCostUsd(leaderId, activity.asset)
          : store.getPosition(leaderId, activity.asset) * orderPrice;
        const projectedUsd = heldUsd + orderUsd;
        if (projectedUsd > leader.limits.maxPositionUsd + 1e-9) {
          skipped++;
          skip(
            store,
            leaderId,
            activity,
            `guarded position cap $${projectedUsd.toFixed(2)} > $${leader.limits.maxPositionUsd}`,
            preview,
            executionAudit
          );
          continue;
        }
      }
    }

    if (activity.side === "BUY") {
      const spendCheck = risk.canSpendUsd(
        leaderId,
        orderUsd,
        leader.limits?.maxDailyVolumeUsd
      );
      if (!spendCheck.allow) {
        skipped++;
        skip(store, leaderId, activity, spendCheck.reason ?? "volume cap", preview, executionAudit);
        continue;
      }

      const cashCheck = risk.canSpendPreviewCash(orderUsd);
      if (!cashCheck.allow) {
        skipped++;
        skip(store, leaderId, activity, cashCheck.reason ?? "preview cash", preview, executionAudit);
        continue;
      }

      const tokenCap = risk.canAddTokenExposure(
        activity.asset,
        orderUsd,
        orderPrice
      );
      if (!tokenCap.allow) {
        skipped++;
        skip(store, leaderId, activity, tokenCap.reason ?? "token exposure cap", preview, executionAudit);
        continue;
      }

      if (!preview) {
        if (!liveCollateral) {
          liveCollateral = await fetchWalletCollateral(config.wallet);
        }
        const fundedProbeReason = emptyLiveProbeFundedReason(
          config.wallet.proxyAddress,
          liveCollateral
        );
        if (fundedProbeReason) {
          skipped++;
          skip(store, leaderId, activity, fundedProbeReason, preview, executionAudit);
          continue;
        }
        const tradeable = liveCollateral.clobUsd ?? 0;
        const chain = liveCollateral.chainUsd ?? 0;
        const chainFallback = canTradeWithChainFallback(liveCollateral);
        if (tradeable <= 0 && chain > 0 && !chainFallback) {
          skipped++;
          skip(
            store,
            leaderId,
            activity,
            `CLOB $0 but chain pUSD $${chain.toFixed(2)} — approve pUSD on polymarket.com (trade once)`,
            preview,
            executionAudit
          );
          continue;
        }
        const buyBalanceUsd = chainFallback ? chain : tradeable;
        const buyAllowanceUsd = chainFallback ? chain : liveCollateral.clobAllowanceUsd;
        const collateral = checkLiveBuyCollateralAndAllowance(
          buyBalanceUsd,
          buyAllowanceUsd,
          orderUsd,
          config.app.global.risk.minOrderUsd
        );
        if (!collateral.allow) {
          skipped++;
          skip(
            store,
            leaderId,
            activity,
            collateral.reason ?? "insufficient USDC",
            preview,
            executionAudit
          );
          continue;
        }
      }
    }

    if (activity.side === "SELL") {
      let held = store.getPosition(leaderId, activity.asset);
      if (!preview && config.app.global.risk.syncWalletBalance) {
        const walletShares = await fetchWalletTokenBalance(config.wallet, activity.asset);
        if (walletShares !== null) {
          const totalTracked = store.getTotalTokenShares(activity.asset);
          held = proportionalSellable(held, walletShares, totalTracked);
        }
      }
      if (held < orderShares) {
        const reason = `SELL held=${held} need=${orderShares}`;
        store.markSeenMany(sourceTradeKeys, leaderId);
        skipped++;
        skip(store, leaderId, activity, reason, preview, executionAudit);
        continue;
      }

      if (!preview) {
        const sellAllowance = await checkLiveSellTokenAllowance(
          config.wallet,
          activity.asset,
          orderShares
        );
        if (!sellAllowance.allow) {
          skipped++;
          skip(
            store,
            leaderId,
            activity,
            sellAllowance.reason ?? "token allowance",
            preview,
            executionAudit
          );
          continue;
        }
      }
    }

    if (!guardedExecution && preview) {
      try {
        observedExecutablePrice = await fetchBestExecutablePrice(
          config.wallet.clobUrl,
          config.wallet.chainId,
          activity.asset,
          activity.side
        );
      } catch {
        observedExecutablePrice = null;
      }
      observedSlippagePct = calculateCopySlippageLossPct(
        activity.side,
        leaderPrice,
        observedExecutablePrice
      );
    } else if (!guardedExecution && config.app.global.risk.slippageTolerance > 0) {
      const ref = await fetchBestExecutablePrice(
        config.wallet.clobUrl,
        config.wallet.chainId,
        activity.asset,
        activity.side
      );
      if (ref === null) {
        skipped++;
        skip(store, leaderId, activity, "slippage reference price unavailable", preview);
        continue;
      }
      const slip = risk.checkSlippage(leaderPrice, ref);
      if (!slip.allow) {
        skipped++;
        skip(store, leaderId, activity, slip.reason ?? "slippage", preview);
        continue;
      }
    }

    const orderReq = {
      tokenId: activity.asset,
      side: activity.side,
      price: orderPrice,
      size: orderShares,
      expectedTickSize: guardedTickSize,
      feeRate: guardedExecution ? guardedFeeRate : undefined,
      feeExponent: guardedExecution ? guardedFeeExponent : undefined,
    };

    const tradeKeys = sourceTradeKeys;
    const market = tokenMarketFromActivity(activity);
    let liveOrderIntentId: string | undefined;
    if (!preview) {
      liveOrderIntentId = store.recordLiveOrderIntent({
        tradeKeys,
        leaderId,
        tokenId: activity.asset,
        side: activity.side,
        price: orderPrice,
        leaderPrice: executionAudit?.leaderPrice,
        executablePrice: executionAudit?.executablePrice,
        slippagePct: executionAudit?.slippagePct,
        orderSize: orderShares,
        auditReason: sizing.reasoning,
        market,
        decisionTerms: {
          orderType: config.app.global.execution.orderType,
          requestedPrice: orderPrice,
          requestedShares: orderShares,
          quoteBestPrice: observedExecutablePrice,
          guardedTickSize: guardedTickSize ?? null,
          guardedFeeRate,
          guardedFeeExponent,
          quoteEvidence: guardedQuoteEvidence,
        },
      });
    }

    let orderResult: PlaceOrderResult;
    orderResult = await executor.placeLimitOrder(orderReq);

    if (orderResult.error) {
      if (!preview && orderResult.orderId && liveOrderIntentId) {
        store.recordLiveOrderAccepted({
          tradeKeys,
          leaderId,
          tokenId: activity.asset,
          side: activity.side,
          price: orderResult.executionPrice ?? orderPrice,
          leaderPrice: executionAudit?.leaderPrice,
          executablePrice: executionAudit?.executablePrice,
          slippagePct: executionAudit?.slippagePct,
          orderSize: orderShares,
          filledShares: 0,
          filledUsd: 0,
          feeUsd: 0,
          auditReason: `${sizing.reasoning}; awaiting confirmed fill evidence`,
          orderId: orderResult.orderId,
          pendingRemaining: orderShares,
          trackPendingGtc: true,
          market,
          intentId: liveOrderIntentId,
          decisionTerms: {
            orderType: config.app.global.execution.orderType,
            requestedPrice: orderPrice,
            requestedShares: orderShares,
            orderId: orderResult.orderId,
            orderStatus: orderResult.orderStatus ?? null,
            awaitingConfirmedFill: true,
            quoteBestPrice: observedExecutablePrice,
            guardedTickSize: guardedTickSize ?? null,
            guardedFeeRate,
            guardedFeeExponent,
            quoteEvidence: guardedQuoteEvidence,
          },
        });
        healthSnapshot.pendingOrders = store.countPendingOrders();
      }
      errors.push(`${leaderId}: ${orderResult.error}`);
      store.audit({
        leaderId,
        action: "ERROR",
        tokenId: activity.asset,
        side: activity.side,
        size: orderShares,
        price: orderPrice,
        leaderPrice: executionAudit?.leaderPrice,
        executablePrice: executionAudit?.executablePrice,
        slippagePct: executionAudit?.slippagePct,
        reason: orderResult.error,
        preview,
      });
      if (isDefiniteOrderRejection(orderResult.error)) {
        store.markSeenMany(tradeKeys, leaderId);
        if (liveOrderIntentId) store.deleteLiveOrderIntent(liveOrderIntentId);
      }
      telegram?.error(`${leaderId} ${activity.side} ${orderResult.error}`);
      continue;
    }

    const executionPrice = orderResult.executionPrice ?? orderPrice;
    const filledExecutionAudit = guardedExecution && executionAudit && orderResult.filledShares > 0
      ? {
          ...executionAudit,
          executablePrice: executionPrice,
          slippagePct: calculateCopySlippageLossPct(
            activity.side,
            leaderPrice,
            executionPrice
          ),
        }
      : executionAudit;

    if (preview) {
      if (orderResult.filledShares <= 0) {
        store.markSeenMany(tradeKeys, leaderId);
        skipped++;
        skip(
          store,
          leaderId,
          activity,
          orderResult.pendingRemaining > 0
            ? `GTC pending (${orderResult.orderStatus ?? "resting"})`
            : (orderResult.orderStatus ?? "order submitted — no fill"),
          preview,
          executionAudit
        );
        continue;
      }

      store.recordCopySuccess({
        tradeKeys,
        leaderId,
        tokenId: activity.asset,
        side: activity.side,
        filledShares: orderResult.filledShares,
        price: executionPrice,
        leaderPrice,
        executablePrice: filledExecutionAudit?.executablePrice ?? observedExecutablePrice,
        slippagePct: filledExecutionAudit?.slippagePct ?? observedSlippagePct,
        filledUsd: orderResult.filledUsd,
        feeUsd: orderResult.feeUsd,
        auditReason: sizing.reasoning,
        preview: true,
        cashInitialUsd: config.app.global.risk.startingCapitalUsd,
        market,
        decisionTerms: {
          orderType: config.app.global.execution.orderType,
          requestedPrice: orderPrice,
          requestedShares: orderShares,
          filledShares: orderResult.filledShares,
          filledUsd: orderResult.filledUsd,
          orderId: orderResult.orderId ?? null,
          orderStatus: orderResult.orderStatus ?? null,
          pendingRemaining: orderResult.pendingRemaining,
          quoteBestPrice: observedExecutablePrice,
          guardedTickSize: guardedTickSize ?? null,
          guardedFeeRate,
          guardedFeeExponent,
          quoteEvidence: guardedQuoteEvidence,
        },
      });
    } else {
      if (
        !orderResult.orderId &&
        (orderResult.pendingRemaining > 0 || orderResult.filledShares <= 0)
      ) {
        const msg =
          orderResult.pendingRemaining > 0
            ? `GTC pending without order id (remaining ${orderResult.pendingRemaining})`
            : "order submitted without order id";
        errors.push(`${leaderId}: ${msg}`);
        store.audit({
          leaderId,
          action: "ERROR",
          tokenId: activity.asset,
          side: activity.side,
          size: orderShares,
          price: orderPrice,
          leaderPrice: executionAudit?.leaderPrice,
          executablePrice: executionAudit?.executablePrice,
          slippagePct: executionAudit?.slippagePct,
          reason: msg,
          preview,
        });
        continue;
      }

      store.recordLiveOrderAccepted({
        tradeKeys,
        leaderId,
        tokenId: activity.asset,
        side: activity.side,
        price: executionPrice,
        leaderPrice: filledExecutionAudit?.leaderPrice,
        executablePrice: filledExecutionAudit?.executablePrice,
        slippagePct: filledExecutionAudit?.slippagePct,
        orderSize: orderShares,
        filledShares: orderResult.filledShares,
        filledUsd: orderResult.filledUsd,
        feeUsd: orderResult.feeUsd,
        auditReason: sizing.reasoning,
        orderId: orderResult.orderId,
        pendingRemaining: orderResult.pendingRemaining,
        trackPendingGtc: config.app.global.execution.orderType === "GTC",
        market,
        intentId: liveOrderIntentId,
        decisionTerms: {
          orderType: config.app.global.execution.orderType,
          requestedPrice: orderPrice,
          requestedShares: orderShares,
          filledShares: orderResult.filledShares,
          filledUsd: orderResult.filledUsd,
          orderId: orderResult.orderId ?? null,
          orderStatus: orderResult.orderStatus ?? null,
          pendingRemaining: orderResult.pendingRemaining,
          quoteBestPrice: observedExecutablePrice,
          guardedTickSize: guardedTickSize ?? null,
          guardedFeeRate,
          guardedFeeExponent,
          quoteEvidence: guardedQuoteEvidence,
        },
      });
      healthSnapshot.pendingOrders = store.countPendingOrders();

      if (orderResult.filledShares <= 0) {
        skipped++;
        skip(
          store,
          leaderId,
          activity,
          orderResult.pendingRemaining > 0
            ? `GTC pending (${orderResult.orderStatus ?? "resting"})`
            : (orderResult.orderStatus ?? "order submitted — no fill"),
          preview,
          executionAudit
        );
        continue;
      }
    }

    const details = {
      leader: leaderId,
      side: activity.side,
      size: orderResult.filledShares,
      price: executionPrice,
      token: activity.asset.slice(0, 12),
      reasoning: sizing.reasoning,
      preview,
      orderId: orderResult.orderId,
      orderStatus: orderResult.orderStatus,
    };

    if (preview) {
      logPreviewAction(details);
    } else {
      logInfo("Copied trade", details);
    }

    const tag = preview ? "[PREVIEW]" : "[LIVE]";
    telegram?.copy(
      `${tag} ${leaderId} ${activity.side} ${orderResult.filledShares} @ ${executionPrice} ($${orderResult.filledUsd.toFixed(2)})`
    );
    copied++;
  }
  store.setDecisionRawEventIds([]);

  healthSnapshot.pendingOrders = store.countPendingOrders();
  return { fetched, copied, skipped, pendingFilled, errors, walletDrifts, pendingOrders };
}

export async function startBot(configPath = "config.yaml"): Promise<void> {
  const manager = await AccountManager.create(configPath);
  const accounts = manager.enabled();

  for (const account of accounts) {
    assertLiveTradingAllowed(account.config.app.global.previewMode);
  }

  await ensureUndiciGlobalProxy();

  const liveAccount = accounts.find((a) => !a.config.app.global.previewMode);
  if (liveAccount) {
    const { fetchGeoblockStatus, formatGeoblockMessage } = await import("../executor/geoblock.js");
    const geo = await fetchGeoblockStatus();
    if (geo?.blocked) {
      logError("Polymarket geoblock detected at startup", {
        ip: geo.ip,
        country: geo.country,
        region: geo.region,
      });
      logInfo(formatGeoblockMessage(geo));
    } else if (geo) {
      logInfo("Polymarket geoblock check passed", {
        ip: geo.ip,
        country: geo.country,
        region: geo.region,
      });
    }
  }

  for (const account of accounts) {
    if (!account.config.app.global.previewMode) {
      const { ensureTradingReady } = await import("../executor/secure-client.js");
      await ensureTradingReady(account.config.wallet);
    }
  }

  syncAggregateHealth(manager.list());
  healthSnapshot.startedAt = Date.now();

  const firstAccount = manager.list()[0];
  const tgEnv = loadTelegramConfig();
  const telegram = new TelegramNotifier({
    botToken: tgEnv.botToken,
    chatId: tgEnv.chatId,
    onCopy: firstAccount?.config.app.global.notify.telegramOnCopy && tgEnv.onCopy,
    onError: firstAccount?.config.app.global.notify.telegramOnError && tgEnv.onError,
    onKillSwitch:
      firstAccount?.config.app.global.notify.telegramOnKillSwitch && tgEnv.onKillSwitch,
  });

  logInfo("PolyMirror starting", {
    accounts: manager.list().map((a) => ({
      id: a.id,
      enabled: a.enabled,
      preview: a.config.app.global.previewMode,
      tradingBackend: a.config.wallet.tradingBackend,
      dbPath: a.dbPath,
      leaders: a.config.app.leaders
        .filter((l) => l.enabled)
        .map((l) => ({ id: l.id, address: l.address?.slice(0, 10) })),
    })),
    pollMs: manager.pollIntervalMs,
    healthPort: manager.healthPort,
  });

  assertDashboardAuthForBind();

  const apiCtx = {
    manager,
    configPath: manager.configPath,
    configFileKey: manager.configFileKey,
    reloadConfig: () => manager.reloadConfig(),
  };
  const apiState: ApiServerState = { server: null, port: 0 };
  syncApiServer(apiState, manager.healthPort, apiCtx);

  let cycleRunning = false;
  let pollIntervalMs = manager.pollIntervalMs;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const schedulePoll = (ms: number) => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, ms);
  };

  const tick = async () => {
    const nextMs = manager.pollIntervalMs;
    if (nextMs !== pollIntervalMs) {
      pollIntervalMs = nextMs;
      schedulePoll(pollIntervalMs);
      logInfo("Poll interval updated", { pollMs: pollIntervalMs });
    }

    syncApiServer(apiState, manager.healthPort, apiCtx);

    if (cycleRunning) {
      logInfo("Skipping poll tick — previous cycle still running");
      return;
    }
    cycleRunning = true;
    try {
      const pollActivityCache: PollActivityCache = new Map();
      for (const account of manager.enabled()) {
        const tag = `[${account.id}]`;
        try {
          const result = await runCopyCycle(account.config, account.store, telegram, {
            pollActivityCache,
          });
          manager.updateHealthAfterPoll(account.id, result, result.walletDrifts);
          if (result.fetched > 0 || result.copied > 0 || result.errors.length > 0) {
            logInfo(`${tag} Poll complete`, result);
          }
          if (result.errors.length > 0) {
            result.errors.slice(0, 5).forEach((e) => logError(`${tag} ${e}`));
          }
          if (account.store.isKillSwitchActive()) {
            telegram.killSwitch(`${tag} active — no new copies until tomorrow UTC`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logError(`${tag} Poll failed`, { error: msg });
          account.health.lastError = msg;
          telegram.error(`${tag} Poll failed: ${msg}`);
        }
      }
      syncAggregateHealth(manager.list());
    } finally {
      cycleRunning = false;
    }
  };

  const shutdown = (signal: string) => {
    logInfo("Shutting down", { signal });
    if (pollTimer) clearInterval(pollTimer);
    if (apiState.server) {
      apiState.server.close();
      apiState.server = null;
    }
    manager.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await tick();
  schedulePoll(pollIntervalMs);
}
