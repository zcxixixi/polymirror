import { OrderSide, OrderType as SdkOrderType } from "@polymarket/client";
import type { WalletConfig } from "../config/types.js";
import type { OrderStatusResult } from "./clob.js";
import { formatPriceForTick } from "./orderbook.js";
import { getSecureClient } from "./secure-client.js";
import type {
  CompletedOrderFill,
  OpenOrderRow,
  SubmitOrderRequest,
  SubmitOrderResponse,
  TradingBackend,
} from "./trading-backend.js";
import { calculateFeeFromBps } from "./fees.js";

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

function parseMatchedAt(value: string): number {
  const raw = String(value);
  if (/^\d+$/.test(raw)) {
    const epoch = Number(raw);
    return epoch < 1_000_000_000_000 ? epoch * 1000 : epoch;
  }
  return Date.parse(raw);
}

function roundFillValue(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function parseNonNegativeNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

const CONFIRMED_FILL_STATUSES = new Set(["CONFIRMED"]);
const FILL_EPSILON = 1e-8;

interface AggregatedOrderFill {
  shares: number;
  usd: number;
  averagePrice: number;
  feeUsd: number;
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

    if (req.orderType === "GTC") {
      const resp = await client.placeLimitOrder({
        tokenId: req.tokenId,
        price,
        size: req.size,
        side,
      });
      if (!resp.ok) return { raw: resp, error: resp.message };
      return mapAcceptedResponse(resp);
    }

    const sdkOrderType = req.orderType === "FOK" ? SdkOrderType.FOK : SdkOrderType.FAK;
    if (req.side === "BUY") {
      const amount = Math.round(parseFloat(price) * req.size * 100) / 100;
      const resp = await client.placeMarketOrder({
        tokenId: req.tokenId,
        side: OrderSide.BUY,
        amount,
        maxSpend: amount,
        maxPrice: price,
        orderType: sdkOrderType,
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
    });
    if (!resp.ok) return { raw: resp, error: resp.message };
    return mapAcceptedResponse(resp);
  }

  async getOrderStatus(orderId: string, tokenId?: string): Promise<OrderStatusResult> {
    const client = await getSecureClient(this.wallet);
    try {
      const order = await client.fetchOrder({ orderId });
      const reportedSizeMatched = parseFloat(String(order.sizeMatched ?? "0"));
      const originalSize = parseFloat(String(order.originalSize ?? "0"));
      const status = String(order.status ?? "unknown");
      const fill = tokenId && reportedSizeMatched > 0
        ? await this.aggregateOrderFillFromTrades(orderId, tokenId, CONFIRMED_FILL_STATUSES)
        : null;
      const sizeMatched = fill?.shares ?? 0;
      const terminal =
        isTerminalStatus(status) ||
        (originalSize > 0 && sizeMatched >= originalSize - FILL_EPSILON);
      return {
        kind: "ok",
        status: {
          sizeMatched,
          originalSize,
          status,
          terminal,
          ...(fill
            ? { filledUsd: fill.usd, averagePrice: fill.averagePrice, feeUsd: fill.feeUsd }
            : {}),
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!isOrderNoLongerOpen(msg)) return { kind: "transient", message: msg };

      // Order has left the open-orders book: reconcile the matched size from trades so
      // a filled order resolves the pending row (and avoids on-chain position drift)
      // instead of being dropped as not_found.
      if (tokenId) {
        try {
          const fill = await this.aggregateOrderFillFromTrades(
            orderId,
            tokenId,
            CONFIRMED_FILL_STATUSES
          );
          if (fill && fill.shares > 0) {
            return {
              kind: "ok",
              status: {
                sizeMatched: fill.shares,
                originalSize: 0,
                status: "CONFIRMED_CLOSED",
                terminal: false,
                filledUsd: fill.usd,
                averagePrice: fill.averagePrice,
                feeUsd: fill.feeUsd,
              },
            };
          }
        } catch (tradeErr) {
          const tradeMsg = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
          return { kind: "transient", message: tradeMsg };
        }
      }
      return { kind: "not_found" };
    }
  }

  /** Aggregate actual executions for either a taker or maker order id. */
  private async aggregateOrderFillFromTrades(
    orderId: string,
    tokenId: string,
    acceptedStatuses: ReadonlySet<string>
  ): Promise<AggregatedOrderFill | null> {
    const client = await getSecureClient(this.wallet);
    let shares = 0;
    let usd = 0;
    let feeUsd = 0;
    for await (const page of client.listAccountTrades({ tokenId })) {
      for (const trade of page.items) {
        if (!acceptedStatuses.has(String(trade.status ?? "").toUpperCase())) continue;
        if (trade.takerOrderId === orderId) {
          const matchedShares = parseFloat(String(trade.size ?? "0"));
          const price = parseFloat(String(trade.price ?? "0"));
          if (matchedShares > 0 && price > 0) {
            const notional = matchedShares * price;
            shares += matchedShares;
            usd += notional;
            feeUsd += calculateFeeFromBps(
              notional,
              parseFloat(String(trade.feeRateBps ?? "0"))
            );
          }
        }
        for (const maker of trade.makerOrders ?? []) {
          if (maker.orderId === orderId) {
            const matchedShares = parseFloat(String(maker.matchedAmount ?? "0"));
            const price = parseFloat(String(maker.price ?? "0"));
            if (matchedShares > 0 && price > 0) {
              const notional = matchedShares * price;
              shares += matchedShares;
              usd += notional;
              feeUsd += calculateFeeFromBps(
                notional,
                parseFloat(String(maker.feeRateBps ?? "0"))
              );
            }
          }
        }
      }
    }
    if (shares <= 0 || usd <= 0) return null;
    return {
      shares: roundFillValue(shares),
      usd: roundFillValue(usd),
      averagePrice: roundFillValue(usd / shares),
      feeUsd: roundFillValue(feeUsd),
    };
  }

  async listRecentCompletedFills(sinceMs: number): Promise<CompletedOrderFill[]> {
    const client = await getSecureClient(this.wallet);
    const groups = new Map<
      string,
      CompletedOrderFill & { invalid: boolean }
    >();
    const after = String(Math.floor(sinceMs / 1000));
    const ownMakerAddress = this.wallet.proxyAddress?.toLowerCase();

    const addFill = (input: {
      orderId: string;
      tokenId: string;
      sideValue: string;
      price: number;
      shares: number;
      feeRateBps: number;
      matchedAt: number;
    }): void => {
      const side = input.sideValue === "BUY" || input.sideValue === "SELL"
        ? input.sideValue
        : undefined;
      if (
        !input.orderId ||
        !input.tokenId ||
        !side ||
        !Number.isFinite(input.price) ||
        input.price <= 0 ||
        !Number.isFinite(input.shares) ||
        input.shares <= 0 ||
        !Number.isFinite(input.matchedAt) ||
        input.matchedAt < sinceMs
      ) {
        return;
      }

      const usd = input.price * input.shares;
      const feeUsd = calculateFeeFromBps(usd, input.feeRateBps);
      const existing = groups.get(input.orderId);
      if (!existing) {
        groups.set(input.orderId, {
          orderId: input.orderId,
          tokenId: input.tokenId,
          side,
          averagePrice: input.price,
          shares: input.shares,
          usd,
          feeUsd,
          matchedAt: input.matchedAt,
          invalid: false,
        });
        return;
      }
      if (existing.tokenId !== input.tokenId || existing.side !== side) {
        existing.invalid = true;
        return;
      }
      existing.shares += input.shares;
      existing.usd += usd;
      existing.feeUsd = (existing.feeUsd ?? 0) + feeUsd;
      existing.matchedAt = Math.max(existing.matchedAt, input.matchedAt);
    };

    for await (const page of client.listAccountTrades({ after })) {
      for (const trade of page.items) {
        if (String(trade.status ?? "").toUpperCase() !== "CONFIRMED") continue;
        const matchedAt = parseMatchedAt(String(trade.matchedAt ?? ""));
        const traderSide = String(trade.traderSide ?? "").toUpperCase();
        if (traderSide === "TAKER") {
          addFill({
            orderId: String(trade.takerOrderId ?? "").trim(),
            tokenId: String(trade.tokenId ?? "").trim(),
            sideValue: String(trade.side ?? "").toUpperCase(),
            price: parseFloat(String(trade.price ?? "0")),
            shares: parseFloat(String(trade.size ?? "0")),
            feeRateBps: parseNonNegativeNumber(trade.feeRateBps),
            matchedAt,
          });
        }

        if (traderSide === "MAKER") {
          for (const maker of trade.makerOrders ?? []) {
            if (
              ownMakerAddress &&
              String(maker.makerAddress ?? "").toLowerCase() !== ownMakerAddress
            ) {
              continue;
            }
            addFill({
              orderId: String(maker.orderId ?? "").trim(),
              tokenId: String(maker.tokenId ?? "").trim(),
              sideValue: String(maker.side ?? "").toUpperCase(),
              price: parseFloat(String(maker.price ?? "0")),
              shares: parseFloat(String(maker.matchedAmount ?? "0")),
              feeRateBps: parseNonNegativeNumber(maker.feeRateBps),
              matchedAt,
            });
          }
        }
      }
    }

    return [...groups.values()]
      .filter((fill) => !fill.invalid && fill.shares > 0 && fill.usd > 0)
      .map(({ invalid: _invalid, ...fill }) => ({
        ...fill,
        averagePrice: roundFillValue(fill.usd / fill.shares),
        shares: roundFillValue(fill.shares),
        usd: roundFillValue(fill.usd),
        feeUsd: roundFillValue(fill.feeUsd ?? 0),
      }))
      .sort((a, b) => a.matchedAt - b.matchedAt || a.orderId.localeCompare(b.orderId));
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
