import type { RuntimeConfig } from "../config/types.js";
import { StateStore } from "../state/store.js";
import { RiskGate } from "../engine/risk.js";
import { processPendingOrders, isPreviewOrderId } from "../engine/pending-orders.js";
import { resolveAccountDbPath } from "../state/db-path.js";
import { ClobExecutor } from "../executor/clob.js";
import { logInfo, logError } from "../notify/logger.js";

export function countLivePendingOrders(store: StateStore): number {
  return store.listPendingOrders().filter((r) => !isPreviewOrderId(r.orderId)).length;
}

export type PendingCancelResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Cancel one live pending order after reconciling partial fills (pre + post cancel).
 * Shared by mode flush, unfollow, and manual cancel so local books stay accurate.
 */
export async function cancelPendingOrderWithFillReconcile(
  config: RuntimeConfig,
  store: StateStore,
  orderId: string,
  options?: { reasonTag?: string }
): Promise<PendingCancelResult> {
  const row = store.listPendingOrders().find((r) => r.orderId === orderId);
  if (!row) {
    return { ok: false, error: "Pending order not found" };
  }
  if (isPreviewOrderId(orderId)) {
    store.removePendingOrder(orderId);
    return { ok: true };
  }
  if (config.app.global.previewMode) {
    return { ok: false, error: "Cannot cancel CLOB orders while in Preview mode" };
  }

  const tag = options?.reasonTag ?? "cancel";
  const executor = new ClobExecutor(config.wallet, config.app.global);
  const side = row.side === "SELL" ? ("SELL" as const) : ("BUY" as const);

  try {
    const statusResult = await executor.getOrderStatus(row.orderId, row.tokenId);
    if (statusResult.kind === "ok") {
      const matched = Math.min(statusResult.status.sizeMatched, row.size);
      const delta = Math.round((matched - row.filledShares) * 100) / 100;
      if (delta > 0.001) {
        store.commitPendingOrderProgress({
          orderId: row.orderId,
          matchedFilledShares: matched,
          fill: {
            leaderId: row.leaderId,
            tokenId: row.tokenId,
            side,
            delta,
            price: row.price,
            auditReason: `${row.reasoning}; ${tag} pre-cancel fill`,
            preview: false,
          },
          remove: false,
        });
      }
    }

    const cancel = await executor.cancelOrder(row.orderId);
    if (!cancel.ok) {
      return { ok: false, error: cancel.error ?? "cancel rejected" };
    }

    const refreshed = store.listPendingOrders().find((r) => r.orderId === row.orderId);
    const baselineFilled = refreshed?.filledShares ?? row.filledShares;
    let matched = baselineFilled;
    const after = await executor.getOrderStatus(row.orderId, row.tokenId);
    if (after.kind === "ok") {
      matched = Math.min(after.status.sizeMatched, row.size);
    }
    const delta = Math.round((matched - baselineFilled) * 100) / 100;
    store.commitPendingOrderProgress({
      orderId: row.orderId,
      matchedFilledShares: matched,
      fill:
        delta > 0.001
          ? {
              leaderId: row.leaderId,
              tokenId: row.tokenId,
              side,
              delta,
              price: row.price,
              auditReason: `${row.reasoning}; ${tag} post-cancel fill`,
              preview: false,
            }
          : undefined,
      remove: true,
      staleSkipAudit: {
        leaderId: row.leaderId,
        tokenId: row.tokenId,
        side,
        size: Math.max(0, row.size - matched),
        price: row.price,
        preview: false,
      },
    });
    logInfo("Cancelled pending order with fill reconcile", {
      orderId: row.orderId.slice(0, 12),
      leader: row.leaderId,
      tag,
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * Reconcile then force-cancel remaining live CLOB pending orders before leaving Live.
 * Callers should refuse the mode switch when `remaining > 0`.
 */
export async function flushLivePendingBeforePreview(
  config: RuntimeConfig,
  store: StateStore
): Promise<{ resolved: number; remaining: number; errors: string[] }> {
  if (config.app.global.previewMode) {
    return { resolved: 0, remaining: 0, errors: [] };
  }

  const before = countLivePendingOrders(store);
  if (before === 0) {
    return { resolved: 0, remaining: 0, errors: [] };
  }

  logInfo("Flushing live pending orders before preview/stop", { count: before });
  const risk = new RiskGate(config.app.global, store);
  const result = await processPendingOrders(config, store, risk);
  const errors = [...result.errors];
  let resolved = result.resolved;

  const stillOpen = store.listPendingOrders().filter((r) => !isPreviewOrderId(r.orderId));
  for (const row of stillOpen) {
    const cancel = await cancelPendingOrderWithFillReconcile(config, store, row.orderId, {
      reasonTag: "flush",
    });
    if (!cancel.ok) {
      errors.push(`cancel ${row.orderId.slice(0, 12)}: ${cancel.error}`);
      continue;
    }
    resolved++;
  }

  const remaining = countLivePendingOrders(store);

  if (remaining > 0) {
    logError("Live pending orders remain after flush", {
      remaining,
      errors: errors.slice(0, 3),
    });
  }

  return { resolved, remaining, errors };
}

export interface PreviewToLiveMigration {
  seenImported: number;
  positionsImported: number;
  livePath: string;
}

/**
 * Merge Preview dedup + engine positions into Live DB on Preview→Live switch.
 * Positions are tracking metadata only; chain wallet is authoritative for SELL.
 */
export function migratePreviewToLiveDb(
  accountId: string,
  previewStore: StateStore
): PreviewToLiveMigration {
  const livePath = resolveAccountDbPath(accountId, false);
  const liveStore = new StateStore(livePath);
  try {
    const seenImported = liveStore.importSeenTradesFrom(previewStore);
    const positionsImported = liveStore.importPositionsFrom(previewStore);
    if (seenImported > 0 || positionsImported > 0) {
      logInfo("Migrated preview state to live DB", {
        accountId,
        seenImported,
        positionsImported,
        livePath,
      });
    }
    return { seenImported, positionsImported, livePath };
  } finally {
    liveStore.close();
  }
}

/** @deprecated use migratePreviewToLiveDb */
export function migrateSeenTradesToLiveDb(accountId: string, previewStore: StateStore): number {
  return migratePreviewToLiveDb(accountId, previewStore).seenImported;
}
