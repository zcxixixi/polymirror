import { OrderType, OrderSide } from "@polymarket/client";
import { fetchMarketInfo } from "@polymarket/client/actions";
import { getPublicClient } from "../sdk/public-client.js";

export interface OrderBookMeta {
  tickSize: string;
  negRisk: boolean;
  feeRate: number;
  feeExponent: number;
}

export interface ExecutableOrderBookQuote {
  bestPrice: number | null;
  averagePrice: number | null;
  availableShares: number;
  availableUsd: number;
  filledShares: number;
  fullyFillable: boolean;
  minOrderShares: number;
  meetsMinOrderSize: boolean;
}

export interface OrderBookLevelLike {
  price: string | number;
  size: string | number;
}

export interface ExecutableOrderBookSnapshot {
  levels: OrderBookLevelLike[];
  tickSize: number;
  minOrderShares: number;
  feeRate: number;
  feeExponent: number;
}

export async function fetchOrderBookMeta(
  _clobUrl: string,
  _chainId: number,
  tokenId: string
): Promise<OrderBookMeta | null> {
  void _clobUrl;
  void _chainId;
  try {
    const client = await getPublicClient();
    const book = await client.fetchOrderBook({ tokenId });
    const market = await fetchMarketInfo(client, { conditionId: book.market });
    return {
      tickSize: String(book.tickSize),
      negRisk: book.negRisk,
      feeRate: market.feeInfo.rate,
      feeExponent: market.feeInfo.exponent,
    };
  } catch {
    return null;
  }
}

function tickDecimalPlaces(tickSize: number): number {
  if (tickSize >= 0.1) return 1;
  if (tickSize >= 0.01) return 2;
  if (tickSize >= 0.001) return 3;
  return 4;
}

export function roundToTick(value: number, tickSize: number): number {
  if (tickSize <= 0) return value;
  const decimals = tickDecimalPlaces(tickSize);
  const maxPrice = parseFloat((1 - tickSize).toFixed(decimals));
  const ticks = Math.round(value / tickSize);
  const rounded = ticks * tickSize;
  const clamped = Math.max(tickSize, Math.min(maxPrice, rounded));
  return parseFloat(clamped.toFixed(decimals));
}

/** CLOB-safe price string (avoids float artifacts like 0.12300000000000001). */
export function formatPriceForTick(value: number, tickSize: number | string): string {
  const tick = typeof tickSize === "string" ? parseFloat(tickSize) : tickSize;
  if (!Number.isFinite(tick) || tick <= 0) return String(value);
  return roundToTick(value, tick).toFixed(tickDecimalPlaces(tick));
}

export function toOrderType(type: "GTC" | "FAK" | "FOK"): OrderType {
  if (type === "FAK") return OrderType.FAK;
  if (type === "FOK") return OrderType.FOK;
  return OrderType.GTC;
}

export function toSide(side: "BUY" | "SELL"): OrderSide {
  return side === "BUY" ? OrderSide.BUY : OrderSide.SELL;
}

export function toTickSizeArg(tick: string): string {
  const v = tick.trim();
  if (["0.1", "0.01", "0.001", "0.0001"].includes(v)) return v;
  return "0.01";
}

export async function fetchBestExecutablePrice(
  _clobUrl: string,
  _chainId: number,
  tokenId: string,
  side: "BUY" | "SELL"
): Promise<number | null> {
  void _clobUrl;
  void _chainId;
  try {
    const client = await getPublicClient();
    const book = await client.fetchOrderBook({ tokenId });
    if (side === "BUY") {
      const asks = book.asks.map((a) => parseFloat(String(a.price))).filter((p) => p > 0);
      return asks.length ? Math.min(...asks) : null;
    }
    const bids = book.bids.map((b) => parseFloat(String(b.price))).filter((p) => p > 0);
    return bids.length ? Math.max(...bids) : null;
  } catch {
    return null;
  }
}

export function quoteExecutableOrderBook(
  levels: readonly OrderBookLevelLike[],
  side: "BUY" | "SELL",
  requiredShares: number,
  limitPrice: number,
  minOrderSharesInput = 0,
  requiredUsdInput?: number
): ExecutableOrderBookQuote {
  const minOrderShares =
    Number.isFinite(minOrderSharesInput) && minOrderSharesInput > 0
      ? minOrderSharesInput
      : 0;
  const normalized = levels
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    }))
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        level.price > 0 &&
        level.price < 1 &&
        Number.isFinite(level.size) &&
        level.size > 0
    )
    .sort((a, b) => side === "BUY" ? a.price - b.price : b.price - a.price);
  const bestPrice = normalized[0]?.price ?? null;
  if (
    bestPrice === null ||
    !Number.isFinite(requiredShares) ||
    requiredShares <= 0 ||
    !Number.isFinite(limitPrice) ||
    limitPrice <= 0 ||
    limitPrice >= 1
  ) {
    return {
      bestPrice,
      averagePrice: null,
      availableShares: 0,
      availableUsd: 0,
      filledShares: 0,
      fullyFillable: false,
      minOrderShares,
      meetsMinOrderSize: false,
    };
  }

  const eligible = normalized.filter((level) =>
    side === "BUY" ? level.price <= limitPrice : level.price >= limitPrice
  );
  const availableShares = eligible.reduce((sum, level) => sum + level.size, 0);
  const availableUsd = eligible.reduce((sum, level) => sum + level.size * level.price, 0);
  const requiredUsd =
    side === "BUY" && Number.isFinite(requiredUsdInput) && (requiredUsdInput ?? 0) > 0
      ? requiredUsdInput!
      : null;
  const fullyFillable = requiredUsd !== null
    ? availableUsd + 1e-9 >= requiredUsd
    : availableShares + 1e-9 >= requiredShares;
  if (!fullyFillable) {
    return {
      bestPrice,
      averagePrice: null,
      availableShares,
      availableUsd,
      filledShares: availableShares,
      fullyFillable: false,
      minOrderShares,
      meetsMinOrderSize: false,
    };
  }

  let remainingShares = requiredShares;
  let remainingUsd = requiredUsd;
  let filledShares = 0;
  let totalUsd = 0;
  for (const level of eligible) {
    const filled = remainingUsd !== null
      ? Math.min(level.size, remainingUsd / level.price)
      : Math.min(remainingShares, level.size);
    totalUsd += filled * level.price;
    filledShares += filled;
    if (remainingUsd !== null) {
      remainingUsd -= filled * level.price;
      if (remainingUsd <= 1e-9) break;
    } else {
      remainingShares -= filled;
      if (remainingShares <= 1e-9) break;
    }
  }

  return {
    bestPrice,
    averagePrice: Math.round((totalUsd / filledShares) * 100_000_000) / 100_000_000,
    availableShares,
    availableUsd,
    filledShares,
    fullyFillable: true,
    minOrderShares,
    meetsMinOrderSize: filledShares + 1e-9 >= minOrderShares,
  };
}

export async function fetchExecutableOrderBookSnapshot(
  _clobUrl: string,
  _chainId: number,
  tokenId: string,
  side: "BUY" | "SELL"
): Promise<ExecutableOrderBookSnapshot | null> {
  void _clobUrl;
  void _chainId;
  try {
    const client = await getPublicClient();
    const book = await client.fetchOrderBook({ tokenId });
    const market = await fetchMarketInfo(client, { conditionId: book.market });
    const tickSize = Number(book.tickSize);
    const minOrderShares = Number(book.minOrderSize);
    if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
    return {
      levels: side === "BUY" ? book.asks : book.bids,
      tickSize,
      minOrderShares:
        Number.isFinite(minOrderShares) && minOrderShares > 0 ? minOrderShares : 0,
      feeRate: market.feeInfo.rate,
      feeExponent: market.feeInfo.exponent,
    };
  } catch {
    return null;
  }
}
