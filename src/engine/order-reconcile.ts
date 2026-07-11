import type { LiveOrderIntentRow, StateStore } from "../state/store.js";
import type { ClobExecutor } from "../executor/clob.js";

/** Kept for report compatibility; untracked orders are no longer auto-owned. */
export const RECOVERED_ORDER_LEADER = "_recovered";
const LIVE_ORDER_INTENT_RECOVERY_MS = 2 * 60_000;

function quarantineStaleIntents(
  store: StateStore,
  intents: LiveOrderIntentRow[],
  now: number
): string[] {
  const warnings: string[] = [];
  for (const intent of intents) {
    if (intent.reconciliationOnly) continue;
    if (now - intent.createdAt < LIVE_ORDER_INTENT_RECOVERY_MS) continue;

    const reason =
      "uncertain live order intent quarantined without a persisted CLOB order id";
    store.quarantineLiveOrderIntentAsUncertain(intent, reason);
    warnings.push(
      `quarantined uncertain live order intent ${intent.intentId.slice(0, 12)} for ${intent.leaderId}`
    );
  }
  return warnings;
}

/**
 * Fail closed on restart. An economic match (token/side/price/size/time) is not
 * causal proof that an exchange order belongs to PolyMirror: it may be an old
 * or manual order. Only order ids already persisted in pending_orders are owned.
 */
export async function adoptUntrackedOpenOrders(
  executor: ClobExecutor,
  store: StateStore
): Promise<{ adopted: number; warnings: string[] }> {
  const warnings: string[] = [];
  let open: Awaited<ReturnType<ClobExecutor["listOpenOrders"]>>;
  try {
    open = await executor.listOpenOrders();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    warnings.push(`open order recovery lookup failed (${message}); live intents retained`);
    return { adopted: 0, warnings };
  }

  const pendingIds = new Set(
    store.listPendingOrders({ includeReconciliation: true }).map((row) => row.orderId)
  );
  for (const order of open) {
    if (pendingIds.has(order.orderId)) continue;
    warnings.push(
      `untracked CLOB order ${order.orderId.slice(0, 12)} left unclaimed without a persisted order id link`
    );
  }

  warnings.push(
    ...quarantineStaleIntents(
      store,
      store.listLiveOrderIntents({ includeReconciliation: true }),
      Date.now()
    )
  );
  return { adopted: 0, warnings };
}

/** @deprecated use adoptUntrackedOpenOrders */
export async function warnUntrackedOpenOrders(
  executor: ClobExecutor,
  store: StateStore
): Promise<string[]> {
  const { warnings } = await adoptUntrackedOpenOrders(executor, store);
  return warnings;
}
