import type { LiveOrderIntentRow, StateStore } from "../state/store.js";
import type { ClobExecutor } from "../executor/clob.js";
import type { CompletedOrderFill } from "../executor/trading-backend.js";
import { logInfo } from "../notify/logger.js";
import { calculateCopySlippageLossPct } from "../sim/copy-slippage.js";

/** Leader id for orders recovered from CLOB without local metadata. */
export const RECOVERED_ORDER_LEADER = "_recovered";
const INTENT_PRICE_TOLERANCE = 0.01;
const INTENT_SIZE_TOLERANCE = 0.05;
const LIVE_ORDER_INTENT_RECOVERY_MS = 2 * 60_000;
const COMPLETED_FILL_CLOCK_SKEW_MS = 5_000;
const COMPLETED_FILL_PRICE_EPSILON = 1e-8;

type OpenOrder = Awaited<ReturnType<ClobExecutor["listOpenOrders"]>>[number];

function findMatchingIntent(
  order: OpenOrder,
  intents: LiveOrderIntentRow[],
  claimedIntentIds: Set<string>
): LiveOrderIntentRow | undefined {
  const side = order.side === "SELL" ? "SELL" : "BUY";
  const matches = intents.filter((intent) => {
    if (claimedIntentIds.has(intent.intentId)) return false;
    if (intent.tokenId !== order.tokenId) return false;
    if (intent.side !== side) return false;
    if (Math.abs(intent.price - order.price) > INTENT_PRICE_TOLERANCE) return false;
    if (Math.abs(intent.size - order.size) > INTENT_SIZE_TOLERANCE) return false;
    return true;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function completedFillFeeUsd(fill: CompletedOrderFill): number {
  let feeUsd: number;
  if (fill.cashDeltaUsd !== undefined && Number.isFinite(fill.cashDeltaUsd)) {
    feeUsd = fill.side === "BUY"
      ? Math.max(0, -fill.cashDeltaUsd - fill.usd)
      : Math.max(0, fill.usd - fill.cashDeltaUsd);
  } else {
    feeUsd = fill.feeUsd ?? 0;
  }
  return Math.round(feeUsd * 100_000_000) / 100_000_000;
}

function matchesCompletedFill(
  intent: LiveOrderIntentRow,
  fill: CompletedOrderFill
): boolean {
  const feeUsd = completedFillFeeUsd(fill);
  if (intent.tokenId !== fill.tokenId || intent.side !== fill.side) return false;
  if (
    !Number.isFinite(fill.averagePrice) ||
    fill.averagePrice <= 0 ||
    !Number.isFinite(fill.shares) ||
    fill.shares <= 0 ||
    !Number.isFinite(fill.usd) ||
    fill.usd <= 0 ||
    !Number.isFinite(feeUsd) ||
    feeUsd < 0 ||
    !Number.isFinite(fill.matchedAt)
  ) {
    return false;
  }
  if (fill.matchedAt < intent.createdAt - COMPLETED_FILL_CLOCK_SKEW_MS) return false;
  if (fill.matchedAt > intent.reconciliationUntil) return false;
  const shareTolerance = Math.max(INTENT_SIZE_TOLERANCE, intent.size * 0.05);
  if (fill.shares > intent.size + shareTolerance) return false;

  if (intent.side === "BUY") {
    if (fill.averagePrice > intent.price + COMPLETED_FILL_PRICE_EPSILON) return false;
    const expectedUsd = roundUsd(intent.price * intent.size);
    return fill.usd + feeUsd <= expectedUsd + 0.01;
  }

  if (fill.averagePrice < intent.price - COMPLETED_FILL_PRICE_EPSILON) return false;
  return true;
}

function quarantineStaleIntents(
  store: StateStore,
  intents: LiveOrderIntentRow[],
  retainedIntentIds: Set<string>,
  now: number
): string[] {
  const warnings: string[] = [];
  for (const intent of intents) {
    if (retainedIntentIds.has(intent.intentId)) continue;
    if (now - intent.createdAt < LIVE_ORDER_INTENT_RECOVERY_MS) continue;

    if (intent.reconciliationOnly) continue;
    const reason =
      "uncertain live order intent quarantined without matching open order or completed fill";
    store.quarantineLiveOrderIntentAsUncertain(intent, reason);
    warnings.push(
      `quarantined uncertain live order intent ${intent.intentId.slice(0, 12)} for ${intent.leaderId}`
    );
  }
  return warnings;
}

/** Adopt open CLOB orders missing from pending_orders (e.g. crash after submit). */
export async function adoptUntrackedOpenOrders(
  executor: ClobExecutor,
  store: StateStore
): Promise<{ adopted: number; warnings: string[] }> {
  const warnings: string[] = [];
  let open: OpenOrder[];
  try {
    open = await executor.listOpenOrders();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    warnings.push(`open order recovery lookup failed (${message}); live intents retained`);
    return { adopted: 0, warnings };
  }
  const pendingIds = new Set(
    store.listPendingOrders({ includeReconciliation: true }).map((r) => r.orderId)
  );
  const intents = store.listLiveOrderIntents({ includeReconciliation: true });
  const now = Date.now();
  const recoveryIntents = intents.filter((intent) => now <= intent.reconciliationUntil);
  const claimedIntentIds = new Set<string>();
  const reservedOrderIds = new Set<string>([
    ...pendingIds,
    ...open.map((order) => order.orderId),
  ]);
  let adopted = 0;

  for (const order of open) {
    if (pendingIds.has(order.orderId)) continue;

    const side = order.side === "SELL" ? "SELL" : "BUY";
    let filledShares = 0;
    const statusResult = await executor.getOrderStatus(order.orderId, order.tokenId);
    if (statusResult.kind === "ok") {
      filledShares = Math.min(statusResult.status.sizeMatched, order.size);
    } else if (statusResult.kind === "transient") {
      warnings.push(
        `orphan ${order.orderId.slice(0, 12)}: status check failed (${statusResult.message})`
      );
    }

    const intent = findMatchingIntent(order, recoveryIntents, claimedIntentIds);
    if (intent) {
      const pendingRemaining = Math.max(
        0,
        Math.round((order.size - Math.min(filledShares, order.size)) * 100) / 100
      );
      const filledUsd = statusResult.kind === "ok" && statusResult.status.filledUsd !== undefined
        ? statusResult.status.filledUsd
        : roundUsd(filledShares * intent.price);
      const actualPrice = filledShares > 0 ? filledUsd / filledShares : intent.price;
      const feeUsd = statusResult.kind === "ok" ? statusResult.status.feeUsd ?? 0 : 0;
      store.recordLiveOrderAccepted({
        tradeKeys: intent.tradeKeys,
        leaderId: intent.leaderId,
        tokenId: order.tokenId,
        side,
        price: actualPrice,
        leaderPrice: intent.leaderPrice ?? undefined,
        executablePrice: filledShares > 0 ? actualPrice : intent.executablePrice,
        slippagePct: intent.leaderPrice !== null && filledShares > 0
          ? calculateCopySlippageLossPct(side, intent.leaderPrice, actualPrice)
          : intent.slippagePct,
        orderSize: order.size,
        filledShares,
        filledUsd,
        feeUsd,
        auditReason: `${intent.reasoning}; recovered after restart`,
        orderId: order.orderId,
        pendingRemaining,
        trackPendingGtc: true,
        market: intent.market,
        intentId: intent.intentId,
      });
      claimedIntentIds.add(intent.intentId);
      adopted++;
      logInfo("Adopted untracked CLOB order from live intent", {
        orderId: order.orderId.slice(0, 12),
        token: order.tokenId.slice(0, 12),
        side,
        size: order.size,
        filledShares,
      });
      continue;
    }

    store.upsertPendingOrder({
      orderId: order.orderId,
      leaderId: RECOVERED_ORDER_LEADER,
      tokenId: order.tokenId,
      side,
      price: order.price,
      size: order.size,
      filledShares,
      filledUsd: statusResult.kind === "ok" && statusResult.status.filledUsd !== undefined
        ? statusResult.status.filledUsd
        : filledShares * order.price,
      feeUsd: statusResult.kind === "ok" ? statusResult.status.feeUsd ?? 0 : 0,
      tradeKey: `recovered-${order.orderId}`,
      reasoning: "auto-recovered orphan CLOB order",
    });
    adopted++;
    logInfo("Adopted untracked open CLOB order", {
      orderId: order.orderId.slice(0, 12),
      token: order.tokenId.slice(0, 12),
      side,
      size: order.size,
      filledShares,
    });
  }

  const unmatchedIntents = recoveryIntents.filter(
    (intent) => !claimedIntentIds.has(intent.intentId)
  );
  if (unmatchedIntents.length === 0) {
    warnings.push(...quarantineStaleIntents(store, intents, claimedIntentIds, now));
    return { adopted, warnings };
  }

  const earliestIntentAt = Math.min(...unmatchedIntents.map((intent) => intent.createdAt));
  const fillLookup = await executor.listRecentCompletedFills(
    Math.max(0, earliestIntentAt - COMPLETED_FILL_CLOCK_SKEW_MS)
  );
  if (fillLookup.kind === "transient") {
    warnings.push(
      `completed fill recovery lookup failed (${fillLookup.message}); live intents retained`
    );
    return { adopted, warnings };
  }

  const availableFills = fillLookup.fills.filter(
    (fill) => !reservedOrderIds.has(fill.orderId)
  );
  const candidatesByIntent = new Map<string, CompletedOrderFill[]>();
  const matchingIntentCountByOrder = new Map<string, number>();
  for (const intent of unmatchedIntents) {
    const candidates = availableFills.filter((fill) => matchesCompletedFill(intent, fill));
    candidatesByIntent.set(intent.intentId, candidates);
    for (const fill of candidates) {
      matchingIntentCountByOrder.set(
        fill.orderId,
        (matchingIntentCountByOrder.get(fill.orderId) ?? 0) + 1
      );
    }
  }

  const ambiguousIntentIds = new Set<string>();
  for (const intent of unmatchedIntents) {
    const candidates = candidatesByIntent.get(intent.intentId) ?? [];
    const fill = candidates[0];
    const isUnique =
      candidates.length === 1 &&
      fill !== undefined &&
      matchingIntentCountByOrder.get(fill.orderId) === 1;
    if (!isUnique) {
      if (candidates.length > 0) {
        ambiguousIntentIds.add(intent.intentId);
        warnings.push(
          `ambiguous completed fill recovery for live order intent ${intent.intentId.slice(0, 12)}`
        );
      }
      continue;
    }

    store.recordLiveOrderAccepted({
      tradeKeys: intent.tradeKeys,
      leaderId: intent.leaderId,
      tokenId: fill.tokenId,
      side: fill.side,
      price: fill.averagePrice,
      leaderPrice: intent.leaderPrice ?? undefined,
      executablePrice: fill.averagePrice,
      slippagePct: intent.leaderPrice === null
        ? intent.slippagePct
        : calculateCopySlippageLossPct(fill.side, intent.leaderPrice, fill.averagePrice),
      orderSize: fill.shares,
      filledShares: fill.shares,
      filledUsd: fill.usd,
      feeUsd: completedFillFeeUsd(fill),
      auditReason: `${intent.reasoning}; recovered completed immediate fill after restart`,
      orderId: fill.orderId,
      pendingRemaining: 0,
      trackPendingGtc: false,
      market: intent.market,
      intentId: intent.intentId,
    });
    claimedIntentIds.add(intent.intentId);
    reservedOrderIds.add(fill.orderId);
    adopted++;
    logInfo("Recovered completed immediate CLOB fill from live intent", {
      orderId: fill.orderId.slice(0, 12),
      token: fill.tokenId.slice(0, 12),
      side: fill.side,
      shares: fill.shares,
      usd: fill.usd,
    });
  }

  const retainedIntentIds = new Set([
    ...claimedIntentIds,
    ...ambiguousIntentIds,
  ]);
  warnings.push(...quarantineStaleIntents(store, intents, retainedIntentIds, Date.now()));
  return { adopted, warnings };
}

/** @deprecated use adoptUntrackedOpenOrders */
export async function warnUntrackedOpenOrders(
  executor: ClobExecutor,
  store: StateStore
): Promise<string[]> {
  const { adopted, warnings } = await adoptUntrackedOpenOrders(executor, store);
  if (adopted > 0) {
    warnings.unshift(`adopted ${adopted} orphan CLOB order(s) into pending_orders`);
  }
  return warnings;
}
