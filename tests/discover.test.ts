import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  listTraderLeaderboard: vi.fn(),
}));

vi.mock("../src/sdk/public-client.js", () => ({
  getPublicClient: vi.fn(async () => ({
    listTraderLeaderboard: sdk.listTraderLeaderboard,
  })),
}));

import { fetchDiscoverLeaderboard } from "../src/api/discover.js";

function row(index: number) {
  return {
    wallet: `0x${index.toString(16).padStart(40, "0")}`,
    rank: String(index),
    userName: `trader-${index}`,
    pnl: String(index * 10),
    vol: String(index * 100),
  };
}

describe("fetchDiscoverLeaderboard", () => {
  beforeEach(() => {
    sdk.listTraderLeaderboard.mockReset();
  });

  it("uses the SDK paginator to return the requested offset window", async () => {
    sdk.listTraderLeaderboard.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { items: [row(1), row(2)], hasMore: true, nextCursor: "page-2" };
        yield { items: [row(3), row(4)], hasMore: false };
      },
    });

    const result = await fetchDiscoverLeaderboard({
      category: "OVERALL",
      timePeriod: "ALL",
      orderBy: "VOL",
      limit: 2,
      offset: 2,
    });

    expect(result.cached).toBe(false);
    expect(result.traders.map((trader) => trader.userName)).toEqual([
      "trader-3",
      "trader-4",
    ]);
    expect(sdk.listTraderLeaderboard).toHaveBeenCalledWith({
      category: "OVERALL",
      timePeriod: "ALL",
      orderBy: "VOL",
      pageSize: 2,
    });
  });
});
