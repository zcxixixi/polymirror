import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { buildActivityUrl, mapRawActivityItem } from "../src/monitor/data-api.js";

describe("mapRawActivityItem", () => {
  it("maps a normal CLOB trade without outcomeIndex", () => {
    const activity = mapRawActivityItem({
      type: "TRADE",
      proxyWallet: "0xabc",
      timestamp: 1_700_000_000,
      transactionHash: "0xtx",
      asset: "1234567890123456789012345678901234567890123456789012345678901234",
      side: "BUY",
      size: 10,
      usdcSize: 5,
      price: 0.5,
      title: "Test market",
    });

    expect(activity).toMatchObject({
      type: "TRADE",
      asset: expect.stringContaining("1234"),
      side: "BUY",
      size: 10,
      price: 0.5,
    });
    expect(activity?.outcomeIndex).toBeUndefined();
  });

  it("skips combo trades (outcomeIndex 999 sentinel)", () => {
    expect(
      mapRawActivityItem({
        type: "TRADE",
        proxyWallet: "0xabc",
        timestamp: 1,
        asset: "combo-position-id",
        side: "BUY",
        size: 1,
        price: 0.5,
        outcomeIndex: 999,
      })
    ).toBeNull();
  });

  it("skips explicit combo trades", () => {
    expect(
      mapRawActivityItem({
        type: "TRADE",
        proxyWallet: "0xabc",
        timestamp: 1,
        isCombo: true,
        asset: "combo-position-id",
        side: "SELL",
        size: 1,
        price: 0.5,
      })
    ).toBeNull();
  });

  it("maps REDEEM activity with asset and usdcSize", () => {
    const activity = mapRawActivityItem({
      type: "REDEEM",
      proxyWallet: "0xabc",
      timestamp: 1_700_000_000,
      transactionHash: "0xredeem",
      asset: "token-redeem",
      size: 12,
      usdcSize: 12,
    });

    expect(activity).toMatchObject({
      type: "REDEEM",
      asset: "token-redeem",
      size: 12,
      usdcSize: 12,
    });
  });
});

describe("buildActivityUrl", () => {
  it("builds data-api activity query", () => {
    const url = buildActivityUrl("https://data-api.polymarket.com", {
      user: "0xc4d5a24a240ec9f52669e3251e0473fd0c5687cf",
      limit: 10,
      type: "TRADE",
      sortBy: "TIMESTAMP",
      sortDirection: "DESC",
    });

    expect(url).toBe(
      "https://data-api.polymarket.com/activity?user=0xc4d5a24a240ec9f52669e3251e0473fd0c5687cf&limit=10&type=TRADE&sortBy=TIMESTAMP&sortDirection=DESC"
    );
  });
});

describe("getActivity cache", () => {
  const mockFirstPage = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    mockFirstPage.mockReset();
    vi.doMock("../src/sdk/public-client.js", () => ({
      getPublicClient: vi.fn(async () => ({
        listActivity: vi.fn(() => ({
          firstPage: mockFirstPage,
        })),
      })),
    }));
  });

  afterEach(async () => {
    vi.doUnmock("../src/sdk/public-client.js");
    vi.resetModules();
  });

  it("returns cached activity within TTL without refetching", async () => {
    const trade = {
      type: "TRADE",
      wallet: "0xabc",
      timestamp: 1_700_000_000,
      transactionHash: "0xtx",
      tokenId: "1234567890123456789012345678901234567890123456789012345678901234",
      side: "BUY",
      shares: "10",
      amount: "5",
      price: "0.5",
    };
    mockFirstPage.mockResolvedValue({ items: [trade] });

    const { getActivity, resetActivityCache } = await import("../src/monitor/data-api.js");
    resetActivityCache();

    const params = {
      user: "0xc4d5a24a240ec9f52669e3251e0473fd0c5687cf",
      limit: 10,
      type: "TRADE" as const,
    };

    const first = await getActivity("", params);
    const second = await getActivity("", params);

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(mockFirstPage).toHaveBeenCalledTimes(1);
  });

  it("falls back to stale cache when fetch fails", async () => {
    const trade = {
      type: "TRADE",
      wallet: "0xabc",
      timestamp: 1_700_000_000,
      transactionHash: "0xtx",
      tokenId: "1234567890123456789012345678901234567890123456789012345678901234",
      side: "BUY",
      shares: "10",
      amount: "5",
      price: "0.5",
    };
    mockFirstPage
      .mockResolvedValueOnce({ items: [trade] })
      .mockRejectedValueOnce(new Error("fetch failed"));

    const { getActivity, resetActivityCache, ACTIVITY_CACHE_TTL_MS } = await import(
      "../src/monitor/data-api.js"
    );
    resetActivityCache();

    const params = {
      user: "0xc4d5a24a240ec9f52669e3251e0473fd0c5687cf",
      limit: 10,
      type: "TRADE" as const,
    };

    const first = await getActivity("", params);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + ACTIVITY_CACHE_TTL_MS + 1);

    const second = await getActivity("", params);

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(mockFirstPage).toHaveBeenCalledTimes(2);

    vi.spyOn(Date, "now").mockRestore();
  });
});

describe("getPositions / fetchLeaderSharesBeforeSell", () => {
  const mockFetchJson = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockFetchJson.mockReset();
    vi.doMock("../src/util/fetch.js", () => ({
      fetchJsonWithRetry: mockFetchJson,
      fetchWithTimeout: vi.fn(),
      isProxyConfigured: () => false,
      getProxyHint: () => "",
    }));
  });

  afterEach(() => {
    vi.doUnmock("../src/util/fetch.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("maps positions and estimates before = current + sell", async () => {
    mockFetchJson.mockResolvedValue([
      { asset: "token-a", size: 40 },
      { asset: "other", size: 9 },
    ]);

    const {
      getPositions,
      fetchLeaderSharesBeforeSell,
      resetPositionCache,
    } = await import("../src/monitor/data-api.js");
    resetPositionCache();

    const positions = await getPositions(
      "https://data-api.polymarket.com",
      "0xLeaderaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      0,
      { sizeThreshold: 0 }
    );
    expect(positions).toEqual([
      { asset: "token-a", size: 40, conditionId: undefined },
      { asset: "other", size: 9, conditionId: undefined },
    ]);

    const before = await fetchLeaderSharesBeforeSell(
      "https://data-api.polymarket.com",
      "0xLeaderaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "token-a",
      100,
      0
    );
    // current 40 < sell 100 → before = 140
    expect(before).toBe(140);
    // fetchLeaderSharesBeforeSell reuses the TTL cache from getPositions
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it("treats lag (current >= sell) as before = current", async () => {
    mockFetchJson.mockResolvedValue([{ asset: "token-lag", size: 300 }]);

    const { fetchLeaderSharesBeforeSell, resetPositionCache } = await import(
      "../src/monitor/data-api.js"
    );
    resetPositionCache();

    const before = await fetchLeaderSharesBeforeSell(
      "https://data-api.polymarket.com",
      "0xLeaderbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "token-lag",
      100,
      0
    );
    expect(before).toBe(300);
  });

  it("returns null when positions HTTP fails with empty cache", async () => {
    mockFetchJson.mockRejectedValue(new Error("network timeout"));

    const { fetchLeaderSharesBeforeSell, resetPositionCache } = await import(
      "../src/monitor/data-api.js"
    );
    resetPositionCache();

    const before = await fetchLeaderSharesBeforeSell(
      "https://data-api.polymarket.com",
      "0xLeadercccccccccccccccccccccccccccccccc",
      "token-fail",
      50,
      0
    );
    expect(before).toBeNull();
  });

  it("serves stale positions cache after TTL when refetch fails", async () => {
    mockFetchJson
      .mockResolvedValueOnce([{ asset: "token-stale", size: 25 }])
      .mockRejectedValueOnce(new Error("fetch failed"));

    const { getPositions, resetPositionCache, POSITION_CACHE_TTL_MS } = await import(
      "../src/monitor/data-api.js"
    );
    resetPositionCache();

    const user = "0xLeaderdddddddddddddddddddddddddddddddd";
    const first = await getPositions("https://data-api.polymarket.com", user);
    expect(first[0]?.size).toBe(25);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + POSITION_CACHE_TTL_MS + 1);
    const second = await getPositions("https://data-api.polymarket.com", user);
    expect(second).toEqual(first);
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it("full-exit when position disappears (current=0)", async () => {
    mockFetchJson.mockResolvedValue([]);

    const { fetchLeaderSharesBeforeSell, resetPositionCache } = await import(
      "../src/monitor/data-api.js"
    );
    resetPositionCache();

    const before = await fetchLeaderSharesBeforeSell(
      "https://data-api.polymarket.com",
      "0xLeadereeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "token-gone",
      120,
      0
    );
    expect(before).toBe(120);
  });
});
