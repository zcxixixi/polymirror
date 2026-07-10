import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderSide, OrderType as SdkOrderType } from "@polymarket/client";
import type { WalletConfig } from "../src/config/types.js";
import { SecureTradingBackend } from "../src/executor/secure-backend.js";
import { getSecureClient } from "../src/executor/secure-client.js";

vi.mock("../src/executor/secure-client.js", () => ({
  getSecureClient: vi.fn(),
}));

const wallet = {} as WalletConfig;
const mockGetSecureClient = vi.mocked(getSecureClient);
const placeMarketOrder = vi.fn();
const listAccountTrades = vi.fn();

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
    mockGetSecureClient.mockReset();
    mockGetSecureClient.mockResolvedValue({ placeMarketOrder, listAccountTrades } as never);
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

  it("groups recent successful taker fills by order id", async () => {
    const since = Date.parse("2026-07-10T00:00:00.000Z");
    const trade = (overrides: Record<string, unknown>) => ({
      tokenId: "token-1",
      side: "BUY",
      price: "0.50",
      size: "4",
      status: "MATCHED",
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
        matchedAt: Date.parse("2026-07-10T00:00:02.000Z"),
      },
    ]);
  });
});
