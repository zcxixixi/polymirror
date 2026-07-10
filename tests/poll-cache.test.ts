import { describe, expect, it, vi, beforeEach } from "vitest";
import { LeaderRegistry } from "../src/leaders/registry.js";
import { pollLeaders } from "../src/monitor/poll.js";
import { getActivity, type Activity } from "../src/monitor/data-api.js";
import { previewRuntimeConfig, testLeader } from "./helpers/fixtures.js";

vi.mock("../src/monitor/data-api.js", () => ({
  getActivity: vi.fn(),
}));

const mockGetActivity = vi.mocked(getActivity);

beforeEach(() => {
  mockGetActivity.mockReset();
});

describe("pollLeaders activity cache", () => {
  it("shares Data API fetches for the same leader address across poll calls", async () => {
    const trade: Activity = {
      type: "TRADE",
      timestamp: Date.now(),
      transactionHash: "0xcachetrade",
      asset: "token-cache",
      side: "BUY",
      size: 10,
      price: 0.5,
    };
    mockGetActivity.mockImplementation(async (_base, params) =>
      params.type === "TRADE" ? [trade] : []
    );

    const global = previewRuntimeConfig().app.global;
    const address = "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4";
    const sharedCache = new Map<string, Promise<Activity[]>>();
    const firstRegistry = new LeaderRegistry([
      testLeader({ id: "variant-a", address }),
    ]);
    const secondRegistry = new LeaderRegistry([
      testLeader({ id: "variant-b", address }),
    ]);

    const first = await (pollLeaders as any)(firstRegistry, global, sharedCache);
    const second = await (pollLeaders as any)(secondRegistry, global, sharedCache);

    expect(mockGetActivity).toHaveBeenCalledTimes(2);
    expect(first[0]).toMatchObject({ leaderId: "variant-a", fetched: 1 });
    expect(second[0]).toMatchObject({ leaderId: "variant-b", fetched: 1 });
  });
});
