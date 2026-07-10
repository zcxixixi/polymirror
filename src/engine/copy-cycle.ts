import type { RuntimeConfig } from "../config/types.js";
import { pollLeaders } from "../monitor/poll.js";
import type { PollActivityCache } from "../monitor/poll.js";
import { tradeEventKey } from "../monitor/data-api.js";
import type { Activity } from "../monitor/data-api.js";
import { fetchResolvedMarketOutcome } from "../monitor/market-resolve.js";
import { calculateOrderSize } from "../engine/sizing.js";
import { processSettlements } from "../engine/settlement.js";
import { passActivityFilters } from "../engine/filters.js";
import { isAnyTradeKeySeen, isRecentBuyDuplicate } from "../engine/dedup.js";
import { ConflictTracker } from "../engine/conflict.js";
import { aggregateTrades } from "../engine/aggregate.js";
import { RiskGate, assertLiveTradingAllowed } from "../engine/risk.js";
import type { StateStore, TokenMarketEntry } from "../state/store.js";
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
import { fetchBestExecutablePrice } from "../executor/orderbook.js";
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
  preview: boolean
): void {
  store.audit({
    leaderId,
    action: "SKIP",
    tokenId: activity.asset,
    side: activity.side,
    size: activity.size,
    price: activity.price,
    reason,
    preview,
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
    try {
      resolved = await fetchResolvedMarketOutcome(condition.slug);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${condition.leaderId}: auto settle failed — ${msg}`);
      store.audit({
        leaderId: condition.leaderId,
        action: "ERROR",
        tokenId: condition.conditionId,
        side: "REDEEM",
        reason: msg,
        preview: true,
      });
      continue;
    }

    if (!resolved?.closed || resolved.winnerTokenIds.length === 0) continue;

    const result = store.settleCondition({
      leaderId: condition.leaderId,
      conditionId: condition.conditionId,
      winnerTokenIds: resolved.winnerTokenIds,
      sourceKeys: [
        `auto-settle:${condition.leaderId}:${condition.conditionId}:${resolved.winnerTokenIds.join(",")}`,
      ],
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
  }

  return { settled, errors };
}

export async function runCopyCycle(
  config: RuntimeConfig,
  store: StateStore,
  telegram?: TelegramNotifier,
  options: { pollActivityCache?: PollActivityCache } = {}
): Promise<CopyCycleResult> {
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

  for (const result of pollResults) {
    if (result.error) {
      errors.push(`${result.leaderId}: poll failed — ${result.error}`);
    }
    fetched += result.fetched;
    for (const activity of result.candidates) {
      rawQueue.push({
        leaderId: result.leaderId,
        activity,
        sourceTradeKeys: [tradeEventKey(activity)],
      });
    }
  }

  const aggregated = aggregateTrades(
    rawQueue,
    config.app.global.tradeAggregationWindowMs
  );
  const queue: QueuedTrade[] = aggregated.map((a) => ({
    leaderId: a.leaderId,
    activity: a.activity,
    sourceTradeKeys: a.sourceTradeKeys,
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

  for (const { leaderId, activity, sourceTradeKeys } of queue) {
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

    if (!activity.asset || !activity.side) continue;

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

    if (activity.side === "BUY") {
      const spendCheck = risk.canSpendUsd(
        leaderId,
        sizing.finalUsd,
        leader.limits?.maxDailyVolumeUsd
      );
      if (!spendCheck.allow) {
        skipped++;
        skip(store, leaderId, activity, spendCheck.reason ?? "volume cap", preview);
        continue;
      }

      const cashCheck = risk.canSpendPreviewCash(sizing.finalUsd);
      if (!cashCheck.allow) {
        skipped++;
        skip(store, leaderId, activity, cashCheck.reason ?? "preview cash", preview);
        continue;
      }

      const tokenCap = risk.canAddTokenExposure(
        activity.asset,
        sizing.finalUsd,
        leaderPrice
      );
      if (!tokenCap.allow) {
        skipped++;
        skip(store, leaderId, activity, tokenCap.reason ?? "token exposure cap", preview);
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
          skip(store, leaderId, activity, fundedProbeReason, preview);
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
            preview
          );
          continue;
        }
        const buyBalanceUsd = chainFallback ? chain : tradeable;
        const buyAllowanceUsd = chainFallback ? chain : liveCollateral.clobAllowanceUsd;
        const collateral = checkLiveBuyCollateralAndAllowance(
          buyBalanceUsd,
          buyAllowanceUsd,
          sizing.finalUsd,
          config.app.global.risk.minOrderUsd
        );
        if (!collateral.allow) {
          skipped++;
          skip(store, leaderId, activity, collateral.reason ?? "insufficient USDC", preview);
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
      if (held < sizing.finalShares) {
        const reason = `SELL held=${held} need=${sizing.finalShares}`;
        store.markSeenMany(sourceTradeKeys, leaderId);
        skipped++;
        skip(store, leaderId, activity, reason, preview);
        continue;
      }

      if (!preview) {
        const sellAllowance = await checkLiveSellTokenAllowance(
          config.wallet,
          activity.asset,
          sizing.finalShares
        );
        if (!sellAllowance.allow) {
          skipped++;
          skip(store, leaderId, activity, sellAllowance.reason ?? "token allowance", preview);
          continue;
        }
      }
    }

    let observedExecutablePrice: number | null = null;
    let observedSlippagePct: number | null = null;
    if (preview) {
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
    } else if (config.app.global.risk.slippageTolerance > 0) {
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
      price: leaderPrice,
      size: sizing.finalShares,
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
        price: leaderPrice,
        orderSize: sizing.finalShares,
        auditReason: sizing.reasoning,
        market,
      });
    }

    let orderResult: PlaceOrderResult;
    orderResult = await executor.placeLimitOrder(orderReq);

    if (orderResult.error) {
      const partialFillError = orderResult.error;
      const recovered = await executor.recoverOrderAfterFailure(orderReq);
      if (recovered) {
        orderResult = recovered;
      } else if (
        !preview &&
        orderResult.filledShares > 0 &&
        orderResult.pendingRemaining <= 0
      ) {
        store.audit({
          leaderId,
          action: "ERROR",
          tokenId: activity.asset,
          side: activity.side,
          size: orderResult.filledShares,
          price: orderResult.executionPrice ?? leaderPrice,
          reason: `${partialFillError}; filled portion will be recorded`,
          preview,
        });
        orderResult = {
          ...orderResult,
          error: undefined,
          orderStatus: `${orderResult.orderStatus ?? "partial fill"}; ${partialFillError}`,
        };
      } else {
        errors.push(`${leaderId}: ${orderResult.error}`);
        store.audit({
          leaderId,
          action: "ERROR",
          tokenId: activity.asset,
          side: activity.side,
          size: sizing.finalShares,
          price: activity.price,
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
    }

    if (!orderResult.orderId && !orderResult.preview) {
      const needsOrderId =
        orderResult.pendingRemaining > 0 || orderResult.filledShares <= 0;
      if (needsOrderId) {
        const recovered = await executor.recoverOrderAfterFailure(orderReq);
        if (recovered?.orderId) {
          orderResult = recovered;
        }
      }
    }

    const executionPrice = orderResult.executionPrice ?? leaderPrice;

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
          preview
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
        executablePrice: observedExecutablePrice,
        slippagePct: observedSlippagePct,
        filledUsd: orderResult.filledUsd,
        auditReason: sizing.reasoning,
        preview: true,
        cashInitialUsd: config.app.global.risk.startingCapitalUsd,
        market,
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
          size: sizing.finalShares,
          price: activity.price,
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
        orderSize: sizing.finalShares,
        filledShares: orderResult.filledShares,
        filledUsd: orderResult.filledUsd,
        auditReason: sizing.reasoning,
        orderId: orderResult.orderId,
        pendingRemaining: orderResult.pendingRemaining,
        trackPendingGtc: config.app.global.execution.orderType === "GTC",
        market,
        intentId: liveOrderIntentId,
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
          preview
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
