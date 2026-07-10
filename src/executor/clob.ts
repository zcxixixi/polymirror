import type { WalletConfig, GlobalConfig } from "../config/types.js";
import type { TradeSide } from "../config/types.js";
import {
  fetchOrderBookMeta,
  roundToTick,
  toOrderType,
} from "./orderbook.js";
import {
  createTradingBackend,
  type CompletedOrderFill,
  type TradingBackend,
} from "./trading-backend.js";
import { logError, logInfo } from "../notify/logger.js";
import { OrderType } from "@polymarket/client";
import { calculatePlatformFeeUsd } from "./fees.js";

export interface PlaceOrderRequest {
  tokenId: string;
  side: TradeSide;
  price: number;
  size: number;
  expectedTickSize?: number;
  feeRate?: number;
  feeExponent?: number;
}

export interface PlaceOrderResult {
  orderId?: string;
  preview: boolean;
  error?: string;
  /** Price used for execution/accounting after CLOB tick rounding. */
  executionPrice?: number;
  filledShares: number;
  filledUsd: number;
  feeUsd?: number;
  orderStatus?: string;
  /** Shares still resting on CLOB (GTC only). */
  pendingRemaining: number;
}

export interface OrderStatusSnapshot {
  sizeMatched: number;
  originalSize: number;
  status: string;
  terminal: boolean;
  filledUsd?: number;
  averagePrice?: number;
  feeUsd?: number;
}

export type OrderStatusResult =
  | { kind: "ok"; status: OrderStatusSnapshot }
  | { kind: "not_found" }
  | { kind: "transient"; message: string };

export type CompletedFillLookupResult =
  | { kind: "ok"; fills: CompletedOrderFill[] }
  | { kind: "transient"; message: string };

/** Parse CLOB POST /order body (V1 orderID or V2 order_id; empty string = missing). */
export function extractOrderIdFromPostResponse(resp: unknown): string | undefined {
  if (!resp || typeof resp !== "object") return undefined;
  const r = resp as Record<string, unknown>;
  for (const key of ["orderID", "order_id", "orderId", "id"]) {
    const v = r[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

export function extractPostOrderError(resp: unknown): string | undefined {
  if (!resp || typeof resp !== "object") return undefined;
  const r = resp as Record<string, unknown>;
  if (r.ok === false && typeof r.message === "string" && r.message.trim()) {
    return r.message.trim();
  }
  const msg = String(r.errorMsg ?? r.error ?? "").trim();
  if (msg) return msg;
  if (r.success === false) return "Order rejected by CLOB";
  return undefined;
}

/** Parse CLOB cancel/delete response (client default throwOnError is false). */
export function parseCancelResponse(raw: unknown): { ok: boolean; error?: string } {
  if (!raw || typeof raw !== "object") return { ok: true };
  const r = raw as Record<string, unknown>;
  const msg = String(r.errorMsg ?? r.error ?? "").trim();
  if (msg) return { ok: false, error: msg };
  if (r.success === false) return { ok: false, error: "Cancel rejected by CLOB" };
  if (r.canceled === false) return { ok: false, error: "Order was not canceled" };
  return { ok: true };
}

export class ClobExecutor {
  private readonly backend: TradingBackend;

  constructor(
    private readonly wallet: WalletConfig,
    private readonly global: GlobalConfig
  ) {
    this.backend = createTradingBackend(wallet);
  }

  async placeLimitOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const notional = req.price * req.size;

    if (this.global.previewMode) {
      const feeUsd = calculatePlatformFeeUsd(
        req.size,
        req.price,
        req.feeRate ?? 0,
        req.feeExponent ?? 0
      );
      return {
        preview: true,
        orderId: `preview-${req.tokenId.slice(0, 8)}-${Date.now()}`,
        executionPrice: req.price,
        filledShares: req.size,
        filledUsd: notional,
        feeUsd,
        orderStatus: "PREVIEW",
        pendingRemaining: 0,
      };
    }

    const meta = await fetchOrderBookMeta(
      this.wallet.clobUrl,
      this.wallet.chainId,
      req.tokenId
    );
    if (!meta) {
      return {
        preview: false,
        error: `Order book unavailable for ${req.tokenId.slice(0, 12)}`,
        filledShares: 0,
        filledUsd: 0,
        pendingRemaining: 0,
      };
    }

    const tick = parseFloat(meta.tickSize);
    if (
      req.expectedTickSize !== undefined &&
      Math.abs(tick - req.expectedTickSize) > 1e-9
    ) {
      return {
        preview: false,
        executionPrice: req.price,
        error: `guarded order tick changed ${req.expectedTickSize} -> ${tick}`,
        filledShares: 0,
        filledUsd: 0,
        pendingRemaining: 0,
      };
    }
    const price = roundToTick(req.price, tick);
    if (req.expectedTickSize !== undefined && Math.abs(price - req.price) > 1e-9) {
      return {
        preview: false,
        executionPrice: req.price,
        error: `guarded order price ${req.price} is not aligned to tick ${tick}`,
        filledShares: 0,
        filledUsd: 0,
        pendingRemaining: 0,
      };
    }
    const orderType = toOrderType(this.global.execution.orderType);
    const retries = this.global.execution.retryLimit;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const submitted = await this.backend.submitOrder({
          tokenId: req.tokenId,
          side: req.side,
          price,
          size: req.size,
          orderType: this.global.execution.orderType,
          tickSize: meta.tickSize,
          negRisk: meta.negRisk,
        });

        const postError = submitted.error ?? extractPostOrderError(submitted.raw);
        if (postError) {
          return {
            preview: false,
            executionPrice: price,
            error: postError,
            filledShares: 0,
            filledUsd: 0,
            pendingRemaining: 0,
          };
        }

        const immediate = {
          takingAmount: submitted.takingAmount,
          makingAmount: submitted.makingAmount,
          status: submitted.status,
        };
        let orderId = submitted.orderId ?? extractOrderIdFromPostResponse(submitted.raw);

        if (!orderId) {
          const recovered = await this.findMatchingOpenOrder(req, price);
          if (recovered) return recovered;

          const responseFill = parseImmediateFill(immediate, req.side, price);

          logError("Order response missing order id", {
            token: req.tokenId.slice(0, 12),
            status: immediate.status,
            response: JSON.stringify(submitted.raw).slice(0, 400),
          });
          return {
            preview: false,
            executionPrice: price,
            error: responseFill.shares > 0
              ? "Matched response awaiting confirmation but no order ID returned"
              : "Order accepted but no order ID returned",
            filledShares: 0,
            filledUsd: 0,
            orderStatus: immediate.status,
            pendingRemaining: 0,
          };
        }

        const fill = await this.resolveFill(
          orderId,
          req,
          price,
          orderType,
          immediate
        );

        const immediateOrder = orderType === OrderType.FAK || orderType === OrderType.FOK;
        if (immediateOrder && fill.shares <= 0 && !isTerminalStatus(fill.status)) {
          return {
            preview: false,
            orderId,
            executionPrice: price,
            error: "Order accepted; fill confirmation pending",
            filledShares: 0,
            filledUsd: 0,
            orderStatus: fill.status,
            pendingRemaining: 0,
          };
        }

        const averagePrice = averageFillPrice(fill.shares, fill.usd, price);
        const feeUsd = fill.feeUsd ?? calculatePlatformFeeUsd(
          fill.shares,
          averagePrice,
          meta.feeRate,
          meta.feeExponent
        );

        return {
          preview: false,
          orderId,
          executionPrice: averagePrice,
          filledShares: fill.shares,
          filledUsd: fill.usd,
          feeUsd,
          orderStatus: fill.status,
          pendingRemaining: fill.remaining,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < retries) {
          const recovered = await this.findMatchingOpenOrder(req, price);
          if (recovered) return recovered;
          logError("Order submit failed with uncertain outcome", {
            token: req.tokenId.slice(0, 12),
            error: msg,
          });
          return {
            preview: false,
            executionPrice: price,
            error: "submit failed with uncertain outcome - will not retry",
            orderStatus: msg,
            filledShares: 0,
            filledUsd: 0,
            pendingRemaining: 0,
          };
        }
        logError("Order failed", { token: req.tokenId.slice(0, 12), error: msg });
        return {
          preview: false,
          executionPrice: price,
          error: msg,
          filledShares: 0,
          filledUsd: 0,
          pendingRemaining: 0,
        };
      }
    }

    return {
      preview: false,
      error: "Order failed after retries",
      filledShares: 0,
      filledUsd: 0,
      pendingRemaining: 0,
    };
  }

  async getOrderStatus(orderId: string, tokenId?: string): Promise<OrderStatusResult> {
    return this.backend.getOrderStatus(orderId, tokenId);
  }

  async cancelOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.global.previewMode) {
      return { ok: true };
    }
    try {
      const parsed = await this.backend.cancelOrder(orderId);
      if (!parsed.ok) {
        logError("Cancel order rejected", {
          orderId: orderId.slice(0, 12),
          error: parsed.error,
        });
      }
      return parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("Cancel order failed", { orderId: orderId.slice(0, 12), error: msg });
      return { ok: false, error: msg };
    }
  }

  /** After a failed submit, look for a matching resting order on CLOB (timeout / lost response). */
  async recoverOrderAfterFailure(
    req: PlaceOrderRequest,
    expectedPrice?: number
  ): Promise<PlaceOrderResult | null> {
    return this.findMatchingOpenOrder(req, expectedPrice);
  }

  /** List all open orders on CLOB (live only). */
  async listOpenOrders(): Promise<
    Array<{ orderId: string; tokenId: string; side: string; price: number; size: number }>
  > {
    if (this.global.previewMode) return [];
    try {
      return await this.backend.listOpenOrders();
    } catch (e) {
      logError("List open orders failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  async listRecentCompletedFills(sinceMs: number): Promise<CompletedFillLookupResult> {
    if (this.global.previewMode) return { kind: "ok", fills: [] };
    try {
      return {
        kind: "ok",
        fills: await this.backend.listRecentCompletedFills(sinceMs),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError("List recent completed fills failed", { error: message });
      return { kind: "transient", message };
    }
  }

  private async findMatchingOpenOrder(
    req: PlaceOrderRequest,
    expectedPrice?: number
  ): Promise<PlaceOrderResult | null> {
    try {
      let matchPrice = expectedPrice;
      let priceTol = 0.0001;
      if (matchPrice === undefined) {
        const meta = await fetchOrderBookMeta(
          this.wallet.clobUrl,
          this.wallet.chainId,
          req.tokenId
        );
        if (meta) {
          const tick = parseFloat(meta.tickSize);
          matchPrice = roundToTick(req.price, tick);
          priceTol = Math.max(tick / 2, 0.0001);
        } else {
          matchPrice = req.price;
        }
      }

      const open = await this.backend.listOpenOrders({ tokenId: req.tokenId });
      if (open.length === 0) return null;

      const side = req.side;
      for (const row of open) {
        const { orderId, side: orderSide, price, size: originalSize } = row;
        if (!orderId) continue;
        if (orderSide !== side) continue;
        if (Math.abs(price - matchPrice) > priceTol) continue;
        if (originalSize <= 0) continue;
        if (Math.abs(originalSize - req.size) > 0.05) continue;

        const statusResult = await this.getOrderStatus(orderId, req.tokenId);
        if (statusResult.kind !== "ok") continue;

        const { sizeMatched, status } = statusResult.status;
        const filledShares = Math.min(sizeMatched, req.size);
        const reportedUsd = statusResult.status.filledUsd;
        const filledUsd = reportedUsd !== undefined && reportedUsd > 0 && sizeMatched > 0
          ? reportedUsd * (filledShares / sizeMatched)
          : filledShares * matchPrice;
        const remaining = Math.max(
          0,
          roundFillAmount(req.size - filledShares)
        );
        logInfo("Recovered open order after submit failure", {
          orderId: orderId.slice(0, 12),
          token: req.tokenId.slice(0, 12),
          status,
        });
        return {
          preview: false,
          orderId,
          executionPrice: averageFillPrice(filledShares, filledUsd, matchPrice),
          filledShares,
          filledUsd: Math.round(filledUsd * 100_000_000) / 100_000_000,
          feeUsd: statusResult.status.feeUsd,
          orderStatus: `${status} (recovered)`,
          pendingRemaining: remaining,
        };
      }
    } catch (e) {
      logError("Open order recovery failed", {
        token: req.tokenId.slice(0, 12),
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return null;
  }

  private async resolveFill(
    orderId: string,
    req: PlaceOrderRequest,
    price: number,
    orderType: OrderType,
    immediate: { takingAmount?: string; makingAmount?: string; status?: string }
  ): Promise<{ shares: number; usd: number; feeUsd?: number; status: string; remaining: number }> {
    if (orderType === OrderType.FAK || orderType === OrderType.FOK) {
      const polled = await this.pollOrderFill(
        orderId,
        req.size,
        price,
        3000,
        req.tokenId,
        true
      );
      if (polled.shares > 0) return { ...polled, remaining: 0 };

      return {
        shares: 0,
        usd: 0,
        status: immediate.status ?? "market order unfilled",
        remaining: 0,
      };
    }

    return this.pollOrderFill(
      orderId,
      req.size,
      price,
      this.global.execution.gtcFillTimeoutMs,
      req.tokenId
    );
  }

  private async pollOrderFill(
    orderId: string,
    requestedShares: number,
    price: number,
    timeoutMs: number,
    tokenId?: string,
    allowOverfill = false
  ): Promise<{ shares: number; usd: number; feeUsd?: number; status: string; remaining: number }> {
    if (timeoutMs <= 0) {
      return {
        shares: 0,
        usd: 0,
        status: "GTC submitted (fill polling disabled)",
        remaining: requestedShares,
      };
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const statusResult = await this.getOrderStatus(orderId, tokenId);
        if (statusResult.kind !== "ok") {
          await sleep(500);
          continue;
        }
        const { sizeMatched: matched, originalSize: original, status } = statusResult.status;

        if (matched > 0) {
          const shares = allowOverfill ? matched : Math.min(matched, requestedShares);
          const actualUsd = statusResult.status.filledUsd;
          const usd = actualUsd !== undefined && actualUsd > 0
            ? actualUsd * (shares / matched)
            : shares * price;
          const remaining = Math.max(0, roundFillAmount(requestedShares - shares));
          return {
            shares: roundFillAmount(shares),
            usd: roundFillAmount(usd),
            feeUsd: statusResult.status.feeUsd === undefined
              ? undefined
              : statusResult.status.feeUsd * (shares / matched),
            status: matched >= original * 0.99 ? status : `${status} (partial)`,
            remaining,
          };
        }

        if (isTerminalStatus(status)) {
          return { shares: 0, usd: 0, status, remaining: 0 };
        }
      } catch (e) {
        logError("Fill poll failed", {
          orderId: orderId.slice(0, 12),
          error: e instanceof Error ? e.message : String(e),
        });
      }

      await sleep(500);
    }

    try {
      const statusResult = await this.getOrderStatus(orderId, tokenId);
      if (statusResult.kind === "ok" && statusResult.status.sizeMatched > 0) {
        const shares = allowOverfill
          ? statusResult.status.sizeMatched
          : Math.min(statusResult.status.sizeMatched, requestedShares);
        const actualUsd = statusResult.status.filledUsd;
        const usd = actualUsd !== undefined && actualUsd > 0
          ? actualUsd * (shares / statusResult.status.sizeMatched)
          : shares * price;
        logInfo("GTC partial fill after timeout", {
          orderId: orderId.slice(0, 12),
          matched: shares,
        });
        return {
          shares: roundFillAmount(shares),
          usd: roundFillAmount(usd),
          feeUsd: statusResult.status.feeUsd === undefined
            ? undefined
            : statusResult.status.feeUsd * (shares / statusResult.status.sizeMatched),
          status: `${statusResult.status.status} (partial, timeout)`,
          remaining: Math.max(0, roundFillAmount(requestedShares - shares)),
        };
      }
    } catch {
      // ignore final poll failure
    }

    return {
      shares: 0,
      usd: 0,
      status: "GTC timeout — no fill",
      remaining: requestedShares,
    };
  }
}

function averageFillPrice(shares: number, usd: number, fallback: number): number {
  if (shares <= 0 || usd <= 0) return fallback;
  return roundFillAmount(usd / shares);
}

function roundFillAmount(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function parseImmediateFill(
  resp: { takingAmount?: string; makingAmount?: string; status?: string },
  side: TradeSide,
  price: number
): { shares: number; usd: number; status: string } {
  const taking = parseFloat(resp.takingAmount ?? "0");
  const making = parseFloat(resp.makingAmount ?? "0");
  const status = resp.status ?? "matched";

  if (side === "BUY" && taking > 0) {
    return {
      shares: roundFillAmount(taking),
      usd: roundFillAmount(making > 0 ? making : taking * price),
      status,
    };
  }
  if (side === "SELL" && making > 0) {
    return {
      shares: roundFillAmount(making),
      usd: roundFillAmount(taking > 0 ? taking : making * price),
      status,
    };
  }

  return { shares: 0, usd: 0, status };
}

function isTerminalStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes("cancel") || s.includes("reject") || s.includes("expired");
}

/** Errors that will not succeed on retry — safe to mark trade as seen. */
export function isDefiniteOrderRejection(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("balance") ||
    lower.includes("allowance") ||
    lower.includes("insufficient") ||
    lower.includes("invalid") ||
    lower.includes("reject") ||
    lower.includes("minimum") ||
    lower.includes("not enough") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("restricted in your region") ||
    lower.includes("geoblock") ||
    lower.includes("order signer address has to be the address of the api key")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
