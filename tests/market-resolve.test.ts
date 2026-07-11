import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketSchema } from "@polymarket/bindings/gamma";
import { fetchResolvedMarketOutcome } from "../src/monitor/market-resolve.js";
import { getPublicClient } from "../src/sdk/public-client.js";
import { gammaMarketResponseFixture } from "./fixtures/gamma-market-response.js";

vi.mock("../src/sdk/public-client.js", () => ({
  getPublicClient: vi.fn(),
}));

const mockGetPublicClient = vi.mocked(getPublicClient);

function mockMarket(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      closed: false,
      endDate: new Date(Date.now() - 60_000).toISOString(),
    },
    resolution: {
      umaResolutionStatus: null,
    },
    outcomes: {
      yes: { tokenId: "yes-token", price: "0.995" },
      no: { tokenId: "no-token", price: "0.005" },
    },
    ...overrides,
  };
}

function decodeGammaMarket(overrides: Record<string, unknown> = {}) {
  return MarketSchema.parse({
    ...gammaMarketResponseFixture,
    ...overrides,
  });
}

describe("official Gamma market decoder compatibility", () => {
  it.each([0.1, 0.01, 0.005, 0.0025, 0.001, 0.0001])(
    "accepts supported minimum tick size %s",
    (minimumTickSize) => {
      const market = decodeGammaMarket({ orderPriceMinTickSize: minimumTickSize });
      expect(market.trading.minimumTickSize).toBe(minimumTickSize);
    }
  );

  it("rejects an unsupported minimum tick size", () => {
    expect(() => decodeGammaMarket({ orderPriceMinTickSize: 0.003 })).toThrow();
  });

  it("feeds a decoded resolved market into settlement without network or orders", async () => {
    const decoded = decodeGammaMarket({ orderPriceMinTickSize: 0.0025 });
    mockGetPublicClient.mockResolvedValue({
      fetchMarket: vi.fn().mockResolvedValue(decoded),
    } as never);

    await expect(fetchResolvedMarketOutcome(decoded.slug)).resolves.toEqual({
      closed: true,
      winnerTokenIds: ["123"],
    });
  });

  it("keeps a decoded unresolved market open without network or orders", async () => {
    const decoded = decodeGammaMarket({
      orderPriceMinTickSize: 0.005,
      closed: false,
      umaResolutionStatus: undefined,
      outcomePrices: '["0.995","0.005"]',
    });
    mockGetPublicClient.mockResolvedValue({
      fetchMarket: vi.fn().mockResolvedValue(decoded),
    } as never);

    await expect(fetchResolvedMarketOutcome(decoded.slug)).resolves.toEqual({
      closed: false,
      winnerTokenIds: [],
    });
  });
});

describe("fetchResolvedMarketOutcome", () => {
  beforeEach(() => {
    mockGetPublicClient.mockReset();
  });

  it("does not close an ended market only because one side is priced near one", async () => {
    mockGetPublicClient.mockResolvedValue({
      fetchMarket: vi.fn().mockResolvedValue(mockMarket()),
    } as never);

    await expect(fetchResolvedMarketOutcome("ended-market")).resolves.toEqual({
      closed: false,
      winnerTokenIds: [],
    });
  });

  it("settles an officially resolved market using the highest priced outcome", async () => {
    mockGetPublicClient.mockResolvedValue({
      fetchMarket: vi.fn().mockResolvedValue(
        mockMarket({
          state: {
            closed: true,
            endDate: new Date(Date.now() - 60_000).toISOString(),
          },
          resolution: {
            umaResolutionStatus: "resolved",
          },
          outcomes: {
            yes: { tokenId: "yes-token", price: "0.98" },
            no: { tokenId: "no-token", price: "0.02" },
          },
        })
      ),
    } as never);

    await expect(fetchResolvedMarketOutcome("resolved-market")).resolves.toEqual({
      closed: true,
      winnerTokenIds: ["yes-token"],
    });
  });

  it("does not close a future market only because one side is expensive", async () => {
    mockGetPublicClient.mockResolvedValue({
      fetchMarket: vi.fn().mockResolvedValue(
        mockMarket({
          state: {
            closed: false,
            endDate: new Date(Date.now() + 60_000).toISOString(),
          },
        })
      ),
    } as never);

    await expect(fetchResolvedMarketOutcome("future-market")).resolves.toEqual({
      closed: false,
      winnerTokenIds: [],
    });
  });

  it("does not treat current official closed state as historical closure before endDate", async () => {
    const endDate = new Date("2026-07-06T10:00:00.000Z").toISOString();
    mockGetPublicClient.mockResolvedValue({
      fetchMarket: vi.fn().mockResolvedValue(
        mockMarket({
          state: {
            closed: true,
            endDate,
          },
          resolution: {
            umaResolutionStatus: "resolved",
          },
        })
      ),
    } as never);

    await expect(
      fetchResolvedMarketOutcome("historical-market", new Date("2026-07-06T09:00:00.000Z").getTime())
    ).resolves.toEqual({
      closed: false,
      winnerTokenIds: [],
    });
  });

  it("does not close unresolved markets without a priced winner", async () => {
    mockGetPublicClient.mockResolvedValue({
      fetchMarket: vi.fn().mockResolvedValue(
        mockMarket({
          outcomes: {
            yes: { tokenId: "yes-token", price: "0.55" },
            no: { tokenId: "no-token", price: "0.45" },
          },
        })
      ),
    } as never);

    await expect(fetchResolvedMarketOutcome("unresolved-market")).resolves.toEqual({
      closed: false,
      winnerTokenIds: [],
    });
  });
});
