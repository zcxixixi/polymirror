import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderSide, OrderType as SdkOrderType } from "@polymarket/client";
import type { WalletConfig } from "../src/config/types.js";
import { SecureTradingBackend } from "../src/executor/secure-backend.js";
import { getSecureClient } from "../src/executor/secure-client.js";

vi.mock("../src/executor/secure-client.js", () => ({
  getSecureClient: vi.fn(),
}));

const { mockFetchOrderBookMeta } = vi.hoisted(() => ({
  mockFetchOrderBookMeta: vi.fn(),
}));
vi.mock("../src/executor/orderbook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/executor/orderbook.js")>()),
  fetchOrderBookMeta: mockFetchOrderBookMeta,
}));

const wallet = { proxyAddress: `0x${"2".repeat(40)}` } as WalletConfig;
const mockGetSecureClient = vi.mocked(getSecureClient);
const placeMarketOrder = vi.fn();
const listAccountTrades = vi.fn();
const fetchOrder = vi.fn();

describe("SecureTradingBackend", () => {
  beforeEach(() => {
    placeMarketOrder.mockReset();
    placeMarketOrder.mockResolvedValue({
      ok: true,
      orderId: "order-1",
      status: "matched",
      makingAmount: "5.3",
      takingAmount: "10",
    });
    listAccountTrades.mockReset();
    fetchOrder.mockReset();
    mockGetSecureClient.mockReset();
    mockFetchOrderBookMeta.mockReset();
    mockFetchOrderBookMeta.mockResolvedValue({
      tickSize: "0.01",
      negRisk: false,
      feeRate: 0.25,
      feeExponent: 2,
    });
    mockGetSecureClient.mockResolvedValue({
      placeMarketOrder,
      listAccountTrades,
      fetchOrder,
    } as never);
  });

  it.each([
    ["FOK", SdkOrderType.FOK],
    ["FAK", SdkOrderType.FAK],
  ] as const)(
    "caps a BUY %s market order at the checked all-in amount",
    async (orderType, sdkOrderType) => {
      await new SecureTradingBackend(wallet).submitOrder({
        tokenId: "token-1",
        side: "BUY",
        price: 0.53,
        size: 10,
        orderType,
        tickSize: "0.01",
        negRisk: false,
      });

      expect(placeMarketOrder).toHaveBeenCalledWith({
        tokenId: "token-1",
        side: OrderSide.BUY,
        amount: 5.3,
        maxSpend: 5.3,
        maxPrice: "0.53",
        orderType: sdkOrderType,
      });
    }
  );

  it("forwards an explicitly prepared BUY amount and all-in cap to the official SDK", async () => {
    await new SecureTradingBackend(wallet).submitOrder({
      tokenId: "token-1",
      side: "BUY",
      price: 0.15,
      size: 4.9334,
      buyAmountUsd: 2,
      buyMaxSpendUsd: 2,
      orderType: "FOK",
      tickSize: "0.01",
      negRisk: false,
    });

    expect(placeMarketOrder).toHaveBeenCalledWith({
      tokenId: "token-1",
      side: OrderSide.BUY,
      amount: 2,
      maxSpend: 2,
      maxPrice: "0.15",
      orderType: SdkOrderType.FOK,
    });
  });

  it("groups only confirmed taker fills by order id", async () => {
    const since = Date.parse("2026-07-10T00:00:00.000Z");
    const trade = (overrides: Record<string, unknown>) => ({
      tokenId: "token-1",
      side: "BUY",
      price: "0.50",
      size: "4",
      feeRateBps: "100",
      status: "CONFIRMED",
      takerOrderId: "order-1",
      traderSide: "TAKER",
      matchedAt: "2026-07-10T00:00:01.000Z",
      makerOrders: [],
      ...overrides,
    });
    listAccountTrades.mockReturnValue(
      (async function* () {
        yield {
          items: [
            trade({}),
            trade({
              price: "0.60",
              size: "6",
              matchedAt: "2026-07-10T00:00:02.000Z",
            }),
            trade({ status: "MATCHED", takerOrderId: "matched-order" }),
            trade({ status: "MINED", takerOrderId: "mined-order" }),
            trade({ status: "RETRYING", takerOrderId: "retrying-order" }),
            trade({ status: "FAILED", takerOrderId: "failed-order" }),
            trade({ traderSide: "MAKER", takerOrderId: "maker-order" }),
            trade({
              takerOrderId: "old-order",
              matchedAt: "2026-07-09T23:59:59.000Z",
            }),
          ],
        };
      })()
    );

    const fills = await new SecureTradingBackend(wallet).listRecentCompletedFills(since);

    expect(listAccountTrades).toHaveBeenCalledWith({ after: String(since / 1000) });
    expect(fills).toEqual([
      {
        orderId: "order-1",
        tokenId: "token-1",
        side: "BUY",
        averagePrice: 0.56,
        shares: 10,
        usd: 5.6,
        feeUsd: 0.1489,
        cashDeltaUsd: -5.7489,
        matchedAt: Date.parse("2026-07-10T00:00:02.000Z"),
      },
    ]);
  });

  it("uses market fee rate and exponent at actual execution prices", async () => {
    const since = Date.parse("2026-07-10T00:00:00.000Z");
    listAccountTrades.mockReturnValue((async function* () {
      yield { items: [{
        tokenId: "token-1",
        side: "SELL",
        price: "0.40",
        size: "10",
        feeRateBps: "9999",
        status: "CONFIRMED",
        takerOrderId: "order-fee",
        traderSide: "TAKER",
        matchedAt: "2026-07-10T00:00:01.000Z",
        makerOrders: [],
      }] };
    })());

    const fills = await new SecureTradingBackend(wallet).listRecentCompletedFills(since);

    expect(fills[0]).toMatchObject({
      usd: 4,
      feeUsd: 0.144,
      cashDeltaUsd: 3.856,
    });
  });

  it("recovers confirmed maker fills by maker order id", async () => {
    const since = Date.parse("2026-07-10T00:00:00.000Z");
    listAccountTrades.mockReturnValue(
      (async function* () {
        yield {
          items: [
            {
              tokenId: "taker-token",
              side: "SELL",
              price: "0.55",
              size: "3.5",
              feeRateBps: "100",
              status: "CONFIRMED",
              takerOrderId: "taker-order",
              traderSide: "MAKER",
              matchedAt: "2026-07-10T00:00:01.000Z",
              makerOrders: [
                {
                  orderId: "maker-order",
                  tokenId: "maker-token",
                  side: "BUY",
                  price: "0.45",
                  matchedAmount: "3.5",
                  feeRateBps: null,
                  makerAddress: wallet.proxyAddress,
                },
                {
                  orderId: "other-maker-order",
                  tokenId: "maker-token",
                  side: "BUY",
                  price: "0.45",
                  matchedAmount: "1",
                  feeRateBps: "50",
                  makerAddress: `0x${"3".repeat(40)}`,
                },
              ],
            },
          ],
        };
      })()
    );

    const fills = await new SecureTradingBackend(wallet).listRecentCompletedFills(since);

    expect(fills).toEqual([
      {
        orderId: "maker-order",
        tokenId: "maker-token",
        side: "BUY",
        averagePrice: 0.45,
        shares: 3.5,
        usd: 1.575,
        feeUsd: 0,
        cashDeltaUsd: -1.575,
        matchedAt: Date.parse("2026-07-10T00:00:01.000Z"),
      },
    ]);
  });

  it("never charges platform fees to maker BUY fills", async () => {
    fetchOrder.mockResolvedValue({
      sizeMatched: "3.5",
      originalSize: "10",
      status: "LIVE",
    });
    listAccountTrades.mockReturnValue(
      (async function* () {
        yield {
          items: [
            {
              status: "CONFIRMED",
              traderSide: "MAKER",
              matchedAt: "2026-07-10T00:00:01.000Z",
              makerOrders: [
                {
                  orderId: "maker-order",
                  tokenId: "maker-token",
                  side: "BUY",
                  price: "0.45",
                  matchedAmount: "3.5",
                  feeRateBps: null,
                  makerAddress: wallet.proxyAddress,
                },
              ],
            },
          ],
        };
      })()
    );

    const result = await new SecureTradingBackend(wallet).getOrderStatus(
      "maker-order",
      "maker-token"
    );

    expect(result).toEqual({
      kind: "ok",
      status: {
        sizeMatched: 3.5,
        originalSize: 10,
        status: "LIVE",
        terminal: false,
        filledUsd: 1.575,
        averagePrice: 0.45,
        feeUsd: 0,
      },
    });
  });

  it("recovers maker SELL fills without reducing proceeds by a platform fee", async () => {
    const since = Date.parse("2026-07-10T00:00:00.000Z");
    listAccountTrades.mockReturnValue(
      (async function* () {
        yield {
          items: [{
            status: "CONFIRMED",
            traderSide: "MAKER",
            matchedAt: "2026-07-10T00:00:01.000Z",
            makerOrders: [{
              orderId: "maker-sell",
              tokenId: "maker-token",
              side: "SELL",
              price: "0.45",
              matchedAmount: "3.5",
              feeRateBps: "9999",
              makerAddress: wallet.proxyAddress,
            }],
          }],
        };
      })()
    );

    const fills = await new SecureTradingBackend(wallet).listRecentCompletedFills(since);

    expect(fills).toEqual([expect.objectContaining({
      orderId: "maker-sell",
      side: "SELL",
      usd: 1.575,
      feeUsd: 0,
      cashDeltaUsd: 1.575,
    })]);
  });

  it("returns trade-weighted fill details for an open partially filled order", async () => {
    fetchOrder.mockResolvedValue({
      sizeMatched: "10",
      originalSize: "20",
      status: "LIVE",
    });
    listAccountTrades.mockReturnValue(
      (async function* () {
        yield {
          items: [
            {
              tokenId: "token-1",
              side: "BUY",
              price: "0.40",
              size: "4",
              status: "CONFIRMED",
              takerOrderId: "order-1",
              traderSide: "TAKER",
              matchedAt: "2026-07-10T00:00:01.000Z",
              makerOrders: [],
            },
            {
              tokenId: "token-1",
              side: "BUY",
              price: "0.60",
              size: "6",
              status: "CONFIRMED",
              takerOrderId: "order-1",
              traderSide: "TAKER",
              matchedAt: "2026-07-10T00:00:02.000Z",
              makerOrders: [],
            },
          ],
        };
      })()
    );

    const result = await new SecureTradingBackend(wallet).getOrderStatus("order-1", "token-1");

    expect(result).toEqual({
      kind: "ok",
      status: {
        sizeMatched: 10,
        originalSize: 20,
        status: "LIVE",
        terminal: false,
        filledUsd: 5.2,
        averagePrice: 0.52,
        feeUsd: 0.144,
      },
    });
  });

  it("exposes only confirmed shares and does not complete a 99 percent match", async () => {
    fetchOrder.mockResolvedValue({
      sizeMatched: "99",
      originalSize: "100",
      status: "MATCHED",
    });
    listAccountTrades.mockReturnValue(
      (async function* () {
        yield {
          items: [
            {
              tokenId: "token-1",
              side: "BUY",
              price: "0.40",
              size: "4",
              feeRateBps: "100",
              status: "CONFIRMED",
              takerOrderId: "order-1",
              traderSide: "TAKER",
              matchedAt: "2026-07-10T00:00:01.000Z",
              makerOrders: [],
            },
            {
              tokenId: "token-1",
              side: "BUY",
              price: "0.60",
              size: "95",
              feeRateBps: "100",
              status: "MINED",
              takerOrderId: "order-1",
              traderSide: "TAKER",
              matchedAt: "2026-07-10T00:00:02.000Z",
              makerOrders: [],
            },
          ],
        };
      })()
    );

    const result = await new SecureTradingBackend(wallet).getOrderStatus("order-1", "token-1");

    expect(result).toEqual({
      kind: "ok",
      status: {
        sizeMatched: 4,
        originalSize: 100,
        status: "MATCHED",
        terminal: false,
        filledUsd: 1.6,
        averagePrice: 0.4,
        feeUsd: 0.0576,
      },
    });
  });

  it("keeps a closed order nonterminal while its final confirmed size is unknown", async () => {
    fetchOrder.mockRejectedValue(new Error("404 not found"));
    listAccountTrades.mockReturnValue(
      (async function* () {
        yield {
          items: [
            {
              tokenId: "token-1",
              side: "BUY",
              price: "0.5",
              size: "4",
              feeRateBps: "0",
              status: "CONFIRMED",
              takerOrderId: "order-closed",
              traderSide: "TAKER",
              matchedAt: "2026-07-10T00:00:01.000Z",
              makerOrders: [],
            },
          ],
        };
      })()
    );

    const result = await new SecureTradingBackend(wallet).getOrderStatus(
      "order-closed",
      "token-1"
    );

    expect(result).toEqual({
      kind: "ok",
      status: {
        sizeMatched: 4,
        originalSize: 0,
        status: "CONFIRMED_CLOSED",
        terminal: false,
        filledUsd: 2,
        averagePrice: 0.5,
        feeUsd: 0.0625,
      },
    });
  });
});
