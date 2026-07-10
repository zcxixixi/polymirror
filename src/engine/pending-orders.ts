import type { RuntimeConfig } from "../config/types.js";
import type { PendingOrderRow, StateStore } from "../state/store.js";
import type { RiskGate } from "../engine/risk.js";
import { ClobExecutor } from "../executor/clob.js";
import { logInfo, logError } from "../notify/logger.js";
import type { TelegramNotifier } from "../notify/telegram.js";
import { calculateCopySlippageLossPct } from "../sim/copy-slippage.js";

export function isPreviewOrderId(orderId: string): boolean {
  return orderId.startsWith("preview-");
}

export interface PendingOrderResult {
  resolved: number;
  filled: number;
  errors: string[];
  cancelledStale: number;
}

export interface PendingOrderDeps {
  createExecutor: (config: RuntimeConfig) => ClobExecutor;
}

const defaultDeps: PendingOrderDeps = {
  createExecutor: (config) => new ClobExecutor(config.wallet, config.app.global),
};

function roundFillAmount(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

interface RowProcessResult {
  resolved: number;
  filled: number;
  cancelledStale: number;
  errors: string[];
}

function buildFillPayload(
  row: PendingOrderRow,
  delta: number,
  deltaUsd: number,
  deltaFeeUsd: number,
  preview: boolean
): {
  leaderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  delta: number;
  price: number;
  feeUsd?: number;
  leaderPrice?: number;
  executablePrice?: number | null;
  slippagePct?: number | null;
  auditReason: string;
  preview: boolean;
} | undefined {
  if (delta <= 0) return undefined;
  const price = deltaUsd > 0 ? deltaUsd / delta : row.price;
  const leaderPrice = row.leaderPrice ?? undefined;
  return {
    leaderId: row.leaderId,
    tokenId: row.tokenId,
    side: row.side,
    delta,
    price,
    feeUsd: deltaFeeUsd,
    leaderPrice,
    executablePrice: price,
    slippagePct: leaderPrice === undefined
      ? row.slippagePct
      : calculateCopySlippageLossPct(row.side, leaderPrice, price),
    auditReason: `${row.reasoning}; pending fill`,
    preview,
  };
}

async function processPendingOrderRow(
  row: PendingOrderRow,
  opts: {
    executor: ClobExecutor;
    store: StateStore;
    preview: boolean;
    isStale: boolean;
    telegram?: TelegramNotifier;
  }
): Promise<RowProcessResult> {
  const { executor, store, preview, isStale, telegram } = opts;
  const empty: RowProcessResult = { resolved: 0, filled: 0, cancelledStale: 0, errors: [] };

  try {
    const statusResult = await executor.getOrderStatus(row.orderId, row.tokenId);
    if (statusResult.kind === "transient") {
      return {
        ...empty,
        errors: [
          `pending ${row.orderId.slice(0, 12)}: status check failed (${statusResult.message})`,
        ],
      };
    }
    if (statusResult.kind === "not_found") {
      return {
        ...empty,
        errors: [
          `pending ${row.orderId.slice(0, 12)}: confirmation unavailable after order left open book`,
        ],
      };
    }

    const status = statusResult.status;
    const matched = Math.min(status.sizeMatched, row.size);
    const delta = roundFillAmount(matched - row.filledShares);
    const reportedFilledUsd = status.filledUsd;
    const matchedFilledUsd = reportedFilledUsd !== undefined && reportedFilledUsd > 0
      ? reportedFilledUsd * (matched / status.sizeMatched)
      : matched * row.price;
    if (
      delta > 0 &&
      (
        reportedFilledUsd === undefined ||
        !Number.isFinite(reportedFilledUsd) ||
        matchedFilledUsd <= row.filledUsd + 1e-8
      )
    ) {
      return {
        ...empty,
        errors: [
          `pending ${row.orderId.slice(0, 12)}: cumulative fill evidence lagged matched shares`,
        ],
      };
    }
    const deltaUsd = Math.max(0, matchedFilledUsd - row.filledUsd);
    const reportedFeeUsd = status.feeUsd;
    const matchedFeeUsd = reportedFeeUsd !== undefined && reportedFeeUsd >= 0 && status.sizeMatched > 0
      ? reportedFeeUsd * (matched / status.sizeMatched)
      : row.feeUsd;
    const deltaFeeUsd = Math.max(0, matchedFeeUsd - row.feeUsd);
    const fill = buildFillPayload(row, delta, deltaUsd, deltaFeeUsd, preview);
    const terminal =
      status.terminal ||
      (status.status === "CONFIRMED_CLOSED" && matched >= row.size - 1e-8);
    const filled = fill ? 1 : 0;

    if (terminal) {
      const confirmedComplete = matched >= row.size - 1e-8;
      store.commitPendingOrderProgress({
        orderId: row.orderId,
        matchedFilledShares: matched,
        matchedFilledUsd,
        matchedFeeUsd,
        fill,
        remove: confirmedComplete,
        reconciliationOnly: !confirmedComplete,
      });
      if (fill) {
        logInfo("Pending order fill applied", {
          orderId: row.orderId.slice(0, 12),
          leader: row.leaderId,
          delta: fill.delta,
          status: status.status,
        });
        telegram?.copy(
          `[LIVE] pending fill ${row.leaderId} ${row.side} ${fill.delta} @ ${row.price}`
        );
      }
      return { resolved: 1, filled, cancelledStale: 0, errors: [] };
    }

    if (isStale) {
      const cancel = await executor.cancelOrder(row.orderId);
      if (cancel.ok) {
        logInfo("Cancelled stale pending order", {
          orderId: row.orderId.slice(0, 12),
          leader: row.leaderId,
          status: status.status,
        });
        store.commitPendingOrderProgress({
          orderId: row.orderId,
          matchedFilledShares: matched,
          matchedFilledUsd,
          matchedFeeUsd,
          fill,
          remove: false,
          reconciliationOnly: true,
          staleSkipAudit: {
            leaderId: row.leaderId,
            tokenId: row.tokenId,
            side: row.side,
            size: row.size - matched,
            price: row.price,
            preview,
          },
        });
        if (fill) {
          logInfo("Pending order fill applied", {
            orderId: row.orderId.slice(0, 12),
            leader: row.leaderId,
            delta: fill.delta,
            status: status.status,
          });
          telegram?.copy(
            `[LIVE] pending fill ${row.leaderId} ${row.side} ${fill.delta} @ ${row.price}`
          );
        }
        return { resolved: 1, filled, cancelledStale: 1, errors: [] };
      }

      store.commitPendingOrderProgress({
        orderId: row.orderId,
        matchedFilledShares: matched,
        matchedFilledUsd,
        matchedFeeUsd,
        fill,
        remove: false,
      });
      if (fill) {
        logInfo("Pending order fill applied", {
          orderId: row.orderId.slice(0, 12),
          leader: row.leaderId,
          delta: fill.delta,
          status: status.status,
        });
        telegram?.copy(
          `[LIVE] pending fill ${row.leaderId} ${row.side} ${fill.delta} @ ${row.price}`
        );
      }
      return {
        resolved: 0,
        filled,
        cancelledStale: 0,
        errors: [
          `pending ${row.orderId.slice(0, 12)}: stale cancel failed (${cancel.error ?? "unknown"})`,
        ],
      };
    }

    store.commitPendingOrderProgress({
      orderId: row.orderId,
      matchedFilledShares: matched,
      matchedFilledUsd,
      matchedFeeUsd,
      fill,
      remove: false,
    });
    if (fill) {
      logInfo("Pending order fill applied", {
        orderId: row.orderId.slice(0, 12),
        leader: row.leaderId,
        delta: fill.delta,
        status: status.status,
      });
      telegram?.copy(
        `[LIVE] pending fill ${row.leaderId} ${row.side} ${fill.delta} @ ${row.price}`
      );
    }
    return { resolved: 0, filled, cancelledStale: 0, errors: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError("Pending order processing failed", {
      orderId: row.orderId.slice(0, 12),
      error: msg,
    });
    return {
      ...empty,
      errors: [`pending ${row.orderId.slice(0, 12)}: ${msg}`],
    };
  }
}

export async function processPendingOrders(
  config: RuntimeConfig,
  store: StateStore,
  risk: RiskGate,
  telegram?: TelegramNotifier,
  deps: PendingOrderDeps = defaultDeps
): Promise<PendingOrderResult> {
  const maxAgeMs = config.app.global.execution.pendingOrderMaxAgeHours * 3600 * 1000;
  const now = Date.now();
  const pending = store
    .listPendingOrders({ includeReconciliation: true })
    .filter((r) => !isPreviewOrderId(r.orderId));
  if (pending.length === 0) {
    return { resolved: 0, filled: 0, errors: [], cancelledStale: 0 };
  }

  if (config.app.global.previewMode) {
    return {
      resolved: 0,
      filled: 0,
      errors: [`${pending.length} live pending order(s) skipped in preview mode`],
      cancelledStale: 0,
    };
  }

  const executor = deps.createExecutor(config);
  const preview = config.app.global.previewMode;
  let resolved = 0;
  let filled = 0;
  let cancelledStale = 0;
  const errors: string[] = [];

  for (const row of pending) {
    const isStale = now - row.createdAt > maxAgeMs;
    const result = await processPendingOrderRow(row, {
      executor,
      store,
      preview,
      isStale,
      telegram,
    });
    resolved += result.resolved;
    filled += result.filled;
    cancelledStale += result.cancelledStale;
    errors.push(...result.errors);
  }

  return { resolved, filled, errors, cancelledStale };
}
