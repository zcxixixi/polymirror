import type { OrderType, TradeSide, WalletConfig } from "../config/types.js";
import type { OrderStatusResult } from "./clob.js";
import { SecureTradingBackend } from "./secure-backend.js";

export interface SubmitOrderRequest {
  tokenId: string;
  side: TradeSide;
  price: number;
  size: number;
  orderType: OrderType;
  tickSize: string;
  negRisk: boolean;
}

export interface SubmitOrderResponse {
  raw: unknown;
  orderId?: string;
  error?: string;
  takingAmount?: string;
  makingAmount?: string;
  status?: string;
}

export interface OpenOrderRow {
  orderId: string;
  tokenId: string;
  side: string;
  price: number;
  size: number;
}

/** Recent account trade used to recover after an ambiguous submit. */
export interface RecentFillMatch {
  orderId?: string;
  filledShares: number;
  filledUsd: number;
  price: number;
  status: string;
}

export interface TradingBackend {
  readonly kind: WalletConfig["tradingBackend"];
  submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResponse>;
  getOrderStatus(orderId: string, tokenId?: string): Promise<OrderStatusResult>;
  cancelOrder(orderId: string): Promise<{ ok: boolean; error?: string }>;
  listOpenOrders(filter?: { tokenId?: string }): Promise<OpenOrderRow[]>;
  /**
   * Look for a recent account trade matching side/size/price (post-submit recovery).
   * Used when the order left the open book before we observed an order id.
   */
  findRecentMatchingFill?(req: {
    tokenId: string;
    side: TradeSide;
    size: number;
    price: number;
    priceTol: number;
    maxAgeMs: number;
  }): Promise<RecentFillMatch | null>;
}

export function createTradingBackend(wallet: WalletConfig): TradingBackend {
  void wallet;
  return new SecureTradingBackend(wallet);
}
