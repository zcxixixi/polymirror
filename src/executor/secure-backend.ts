import { OrderSide, OrderType as SdkOrderType } from "@polymarket/client";
import type { WalletConfig } from "../config/types.js";
import type { OrderStatusResult } from "./clob.js";
import { formatPriceForTick } from "./orderbook.js";
import { getSecureClient } from "./secure-client.js";
import type {
  OpenOrderRow,
  RecentFillMatch,
  SubmitOrderRequest,
  SubmitOrderResponse,
  TradingBackend,
} from "./trading-backend.js";
import type { TradeSide } from "../config/types.js";

function isTerminalStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes("cancel") || s.includes("reject") || s.includes("expired");
}

/**
 * `GET /data/order/{id}` returns a `null` body once an order is no longer open
 * (fully matched, cancelled, or expired), which the SDK's zod parser rejects with
 * "expected object, received null". A plain 404 means the same thing. Either way the
 * order has left the open-orders book and must be reconciled from trades rather than
 * retried as a transient failure.
 */
function isOrderNoLongerOpen(msg: string): boolean {
  return /404|not found/i.test(msg) || /expected object, received null/i.test(msg);
}

function mapAcceptedResponse(resp: {
  ok: true;
  orderId: string;
  status: string;
  makingAmount: string;
  takingAmount: string;
}): SubmitOrderResponse {
  return {
    raw: resp,
    orderId: resp.orderId,
    makingAmount: resp.makingAmount,
    takingAmount: resp.takingAmount,
    status: resp.status,
  };
}

export class SecureTradingBackend implements TradingBackend {
  readonly kind = "secure" as const;

  constructor(private readonly wallet: WalletConfig) {}

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResponse> {
    const client = await getSecureClient(this.wallet);
    const side = req.side === "BUY" ? OrderSide.BUY : OrderSide.SELL;
    const price = formatPriceForTick(req.price, req.tickSize);
    const builderCode = this.wallet.builderCode as `0x${string}`;

    if (req.orderType === "GTC") {
      const resp = await client.placeLimitOrder({
        tokenId: req.tokenId,
        price,
        size: req.size,
        side,
        builderCode,
      });
      if (!resp.ok) return { raw: resp, error: resp.message };
      return mapAcceptedResponse(resp);
    }

    const sdkOrderType = req.orderType === "FOK" ? SdkOrderType.FOK : SdkOrderType.FAK;
    if (req.side === "BUY") {
      const resp = await client.placeMarketOrder({
        tokenId: req.tokenId,
        side: OrderSide.BUY,
        amount: Math.round(parseFloat(price) * req.size * 100) / 100,
        maxPrice: price,
        orderType: sdkOrderType,
        builderCode,
      });
      if (!resp.ok) return { raw: resp, error: resp.message };
      return mapAcceptedResponse(resp);
    }

    const resp = await client.placeMarketOrder({
      tokenId: req.tokenId,
      side: OrderSide.SELL,
      shares: req.size,
      minPrice: price,
      orderType: sdkOrderType,
      builderCode,
    });
    if (!resp.ok) return { raw: resp, error: resp.message };
    return mapAcceptedResponse(resp);
  }

  async getOrderStatus(orderId: string, tokenId?: string): Promise<OrderStatusResult> {
    const client = await getSecureClient(this.wallet);
    try {
      const order = await client.fetchOrder({ orderId });
      const sizeMatched = parseFloat(String(order.sizeMatched ?? "0"));
      const originalSize = parseFloat(String(order.originalSize ?? "0"));
      const status = String(order.status ?? "unknown");
      const terminal =
        isTerminalStatus(status) || (originalSize > 0 && sizeMatched >= originalSize * 0.99);
      return { kind: "ok", status: { sizeMatched, originalSize, status, terminal } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!isOrderNoLongerOpen(msg)) return { kind: "transient", message: msg };

      // Order has left the open-orders book: reconcile the matched size from trades so
      // a filled order resolves the pending row (and avoids on-chain position drift)
      // instead of being dropped as not_found.
      if (tokenId) {
        try {
          const sizeMatched = await this.sumMatchedSharesFromTrades(orderId, tokenId);
          if (sizeMatched > 0) {
            return {
              kind: "ok",
              status: { sizeMatched, originalSize: 0, status: "closed", terminal: true },
            };
          }
          // Order left the book but trades are not indexed yet — do not drop pending.
          return {
            kind: "transient",
            message: "order closed but trades not yet indexed",
          };
        } catch (tradeErr) {
          const tradeMsg = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
          return { kind: "transient", message: tradeMsg };
        }
      }
      return { kind: "not_found" };
    }
  }

  async findRecentMatchingFill(req: {
    tokenId: string;
    side: TradeSide;
    size: number;
    price: number;
    priceTol: number;
    maxAgeMs: number;
  }): Promise<RecentFillMatch | null> {
    const client = await getSecureClient(this.wallet);
    const cutoff = Date.now() - req.maxAgeMs;
    const side = req.side.toUpperCase();
    let best: RecentFillMatch | null = null;
    let bestSizeDelta = Number.POSITIVE_INFINITY;

    for await (const page of client.listAccountTrades({ tokenId: req.tokenId })) {
      for (const trade of page.items) {
        if (String(trade.status ?? "").toUpperCase() === "FAILED") continue;
        const matchedAt = trade.matchedAt ? new Date(trade.matchedAt).getTime() : NaN;
        if (Number.isFinite(matchedAt) && matchedAt < cutoff) continue;
        if (String(trade.side ?? "").toUpperCase() !== side) continue;
        const price = parseFloat(String(trade.price ?? "0"));
        if (Math.abs(price - req.price) > req.priceTol) continue;
        const size = parseFloat(String(trade.size ?? "0"));
        if (size <= 0 || size > req.size + 0.05) continue;
        const sizeDelta = Math.abs(size - req.size);
        if (sizeDelta > bestSizeDelta) continue;
        bestSizeDelta = sizeDelta;
        best = {
          orderId: trade.takerOrderId ? String(trade.takerOrderId) : undefined,
          filledShares: Math.round(size * 100) / 100,
          filledUsd: Math.round(size * price * 100) / 100,
          price,
          status: String(trade.status ?? "matched"),
        };
        if (sizeDelta <= 0.05) return best;
      }
    }
    return best;
  }

  /** Sum shares matched against `orderId` across all account trades for `tokenId`. */
  private async sumMatchedSharesFromTrades(orderId: string, tokenId: string): Promise<number> {
    const client = await getSecureClient(this.wallet);
    let matched = 0;
    for await (const page of client.listAccountTrades({ tokenId })) {
      for (const trade of page.items) {
        if (String(trade.status ?? "").toUpperCase() === "FAILED") continue;
        if (trade.takerOrderId === orderId) {
          matched += parseFloat(String(trade.size ?? "0"));
        }
        for (const maker of trade.makerOrders ?? []) {
          if (maker.orderId === orderId) {
            matched += parseFloat(String(maker.matchedAmount ?? "0"));
          }
        }
      }
    }
    return Math.round(matched * 100) / 100;
  }

  async cancelOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = await getSecureClient(this.wallet);
      const resp = await client.cancelOrder({ orderId });
      if (resp.canceled.includes(orderId)) return { ok: true };
      const err = resp.notCanceled[orderId];
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  async listOpenOrders(filter?: { tokenId?: string }): Promise<OpenOrderRow[]> {
    const client = await getSecureClient(this.wallet);
    const paginator = client.listOpenOrders(
      filter?.tokenId ? { tokenId: filter.tokenId } : {}
    );
    const rows: OpenOrderRow[] = [];
    for await (const page of paginator) {
      for (const o of page.items) {
        const size = parseFloat(String(o.originalSize ?? "0"));
        if (size <= 0) continue;
        rows.push({
          orderId: o.id,
          tokenId: String(o.tokenId),
          side: String(o.side ?? "").toUpperCase(),
          price: parseFloat(String(o.price ?? "0")),
          size,
        });
      }
    }
    return rows;
  }
}
