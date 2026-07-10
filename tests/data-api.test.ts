import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActivity } from "../src/monitor/data-api.js";
import { getPublicClient } from "../src/sdk/public-client.js";

vi.mock("../src/sdk/public-client.js", () => ({
  getPublicClient: vi.fn(),
}));

const mockGetPublicClient = vi.mocked(getPublicClient);

describe("getActivity", () => {
  beforeEach(() => {
    mockGetPublicClient.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to raw Data API when SDK activity parsing rejects a missing outcomeIndex", async () => {
    mockGetPublicClient.mockResolvedValue({
      listActivity: vi.fn(() => ({
        firstPage: vi
          .fn()
          .mockRejectedValue(new TypeError("Expected activity.outcomeIndex to be present")),
      })),
    } as never);

    const rawActivity = {
      proxyWallet: "0x0000000000000000000000000000000000000001",
      timestamp: Date.now(),
      type: "TRADE",
      size: "12.5",
      usdcSize: "6.25",
      transactionHash: "0xabc",
      price: "0.5",
      asset: "token-without-outcome-index",
      side: "BUY",
      conditionId: "condition-1",
      title: "Test market",
      slug: "test-market",
      eventSlug: "test-event",
      outcome: "Yes",
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn(),
      json: vi.fn().mockResolvedValue([rawActivity]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getActivity("", {
        user: "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4",
        limit: 100,
        offset: 0,
        type: "TRADE",
        sortBy: "TIMESTAMP",
        sortDirection: "DESC",
      })
    ).resolves.toEqual([
      {
        proxyWallet: rawActivity.proxyWallet,
        timestamp: rawActivity.timestamp,
        transactionHash: rawActivity.transactionHash,
        type: "TRADE",
        size: 12.5,
        usdcSize: 6.25,
        price: 0.5,
        asset: rawActivity.asset,
        side: "BUY",
        conditionId: rawActivity.conditionId,
        outcomeIndex: undefined,
        title: rawActivity.title,
        slug: rawActivity.slug,
        eventSlug: rawActivity.eventSlug,
        outcome: rawActivity.outcome,
      },
    ]);
  });
});
