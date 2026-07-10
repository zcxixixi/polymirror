import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchResolvedMarketOutcome } from "../src/monitor/market-resolve.js";
import { getPublicClient } from "../src/sdk/public-client.js";

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
