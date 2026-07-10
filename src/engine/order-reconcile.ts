import type { LiveOrderIntentRow, StateStore } from "../state/store.js";
import type { ClobExecutor } from "../executor/clob.js";
import { logInfo } from "../notify/logger.js";

/** Leader id for orders recovered from CLOB without local metadata. */
export const RECOVERED_ORDER_LEADER = "_recovered";
const INTENT_PRICE_TOLERANCE = 0.01;
const INTENT_SIZE_TOLERANCE = 0.05;
const LIVE_ORDER_INTENT_RECOVERY_MS = 2 * 60_000;

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

function expireStaleIntents(
  store: StateStore,
  intents: LiveOrderIntentRow[],
  claimedIntentIds: Set<string>,
  now: number
): string[] {
  const warnings: string[] = [];
  for (const intent of intents) {
    if (claimedIntentIds.has(intent.intentId)) continue;
    if (now - intent.createdAt < LIVE_ORDER_INTENT_RECOVERY_MS) continue;

    const reason = "uncertain live order intent expired without matching open CLOB order";
    store.expireLiveOrderIntentAsUncertain(intent, reason);
    warnings.push(
      `expired uncertain live order intent ${intent.intentId.slice(0, 12)} for ${intent.leaderId}`
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
  const open = await executor.listOpenOrders();
  const pendingIds = new Set(store.listPendingOrders().map((r) => r.orderId));
  const intents = store.listLiveOrderIntents();
  const claimedIntentIds = new Set<string>();
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

    const intent = findMatchingIntent(order, intents, claimedIntentIds);
    if (intent) {
      const pendingRemaining = Math.max(
        0,
        Math.round((order.size - Math.min(filledShares, order.size)) * 100) / 100
      );
      store.recordLiveOrderAccepted({
        tradeKeys: intent.tradeKeys,
        leaderId: intent.leaderId,
        tokenId: order.tokenId,
        side,
        price: intent.price,
        orderSize: order.size,
        filledShares,
        filledUsd: roundUsd(filledShares * intent.price),
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

  warnings.push(...expireStaleIntents(store, intents, claimedIntentIds, Date.now()));
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
