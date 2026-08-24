import { beforeEach, describe, expect, it, vi } from "vitest";
import { TradeSchema } from "@polymarket/bindings/data";
import type { GlobalTakerTradeRow } from "../src/api/discover-global-taker-trades.js";

const sdk = vi.hoisted(() => ({
  listTrades: vi.fn(),
}));

vi.mock("../src/sdk/public-client.js", () => ({
  getPublicClient: vi.fn(async () => ({
    listTrades: sdk.listTrades,
  })),
}));

import {
  discoverGlobalTakerTradeWallets,
  type GlobalTakerTradeDiscoveryOptions,
} from "../src/api/discover-global-taker-trades.js";

interface MockPage {
  items: GlobalTakerTradeRow[];
  hasMore: boolean;
  nextCursor?: string;
  totalCount?: number;
}

interface MockPaginator {
  firstPage(): Promise<MockPage>;
  from(cursor?: unknown): MockPaginator;
  [Symbol.asyncIterator](): AsyncIterator<MockPage>;
}

const BASE_OPTIONS: GlobalTakerTradeDiscoveryOptions = {
  startUtc: "2026-07-15T00:00:00Z",
  endUtc: "2026-07-15T01:00:00Z",
  pageSize: 2,
  maxPages: 3,
  maxTrades: 6,
};
const WINDOW_START_SECONDS = 1_784_073_600;
const WINDOW_END_SECONDS = 1_784_077_200;
const WINDOW_START_MS = WINDOW_START_SECONDS * 1_000;
const WINDOW_END_MS = WINDOW_END_SECONDS * 1_000;

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

function condition(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function trade(
  wallet: unknown,
  overrides: Record<string, unknown> = {}
): GlobalTakerTradeRow {
  return {
    wallet,
    side: "BUY",
    conditionId: "condition-a",
    timestamp: WINDOW_START_SECONDS + 1_800,
    ...overrides,
  } as GlobalTakerTradeRow;
}

function paginated(pages: MockPage[], onFrom?: (cursor: unknown) => void): MockPaginator {
  const at = (index: number): MockPaginator => ({
    async firstPage() {
      const page = pages[index];
      if (!page) throw new Error(`unexpected page ${index + 1}`);
      return page;
    },
    from(cursor) {
      onFrom?.(cursor);
      return at(index + 1);
    },
    async *[Symbol.asyncIterator]() {
      for (let pageIndex = index; pageIndex < pages.length; pageIndex++) {
        yield pages[pageIndex]!;
      }
    },
  });
  return at(0);
}

function usePages(pages: MockPage[]): void {
  sdk.listTrades.mockReturnValue(paginated(pages));
}

describe("discoverGlobalTakerTradeWallets", () => {
  beforeEach(() => {
    sdk.listTrades.mockReset();
  });

  it("confirms the installed official binding converts Data API seconds to milliseconds", () => {
    const parsed = TradeSchema.parse({
      proxyWallet: address(1),
      timestamp: WINDOW_START_SECONDS,
    });

    expect(parsed.timestamp).toBe(WINDOW_START_MS);
  });

  it("uses the official SDK paginator with a fixed UTC taker-only window", async () => {
    usePages([
      {
        items: [trade(address(2)), trade(address(1))],
        hasMore: true,
        nextCursor: "cursor-2",
      },
      {
        items: [trade(address(3))],
        hasMore: false,
      },
    ]);

    const result = await discoverGlobalTakerTradeWallets(BASE_OPTIONS);

    expect(sdk.listTrades).toHaveBeenCalledTimes(1);
    expect(sdk.listTrades).toHaveBeenCalledWith({
      pageSize: 2,
      takerOnly: true,
      start: 1_784_073_600,
      end: 1_784_077_200,
    });
    expect(result.samplingParameters).toMatchObject({
      startUtc: "2026-07-15T00:00:00.000Z",
      endUtc: "2026-07-15T01:00:00.000Z",
      takerOnly: true,
      pageSize: 2,
      maxPages: 3,
      maxTrades: 6,
    });
    expect(result.rawPages).toHaveLength(2);
    expect(result.rawPages[0]).toMatchObject({
      pageNumber: 1,
      cursor: null,
      nextCursor: "cursor-2",
      hasMore: true,
    });
    expect(result.rawPages[1]).toMatchObject({
      pageNumber: 2,
      cursor: "cursor-2",
      nextCursor: null,
      hasMore: false,
    });
    expect(result.samplingSummary).toEqual({
      pagesFetched: 2,
      rowsFetched: 3,
      invalidWalletRows: 0,
      excludedWalletRows: 0,
      acceptedTradeRows: 3,
      uniqueCandidates: 3,
    });
  });

  it("passes a normalized fixed market-condition partition to the official SDK", async () => {
    usePages([{
      items: [trade(address(1), { conditionId: condition(1) })],
      hasMore: false,
    }]);

    const result = await discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      marketConditionIds: [condition(2).toUpperCase().replace("0X", "0x"), condition(1), condition(2)],
    });

    expect(sdk.listTrades).toHaveBeenCalledWith({
      pageSize: 2,
      takerOnly: true,
      start: WINDOW_START_SECONDS,
      end: WINDOW_END_SECONDS,
      market: [condition(1), condition(2)],
    });
    expect(result.samplingParameters.marketConditionIds).toEqual([
      condition(1),
      condition(2),
    ]);
  });

  it("fails closed when a returned trade is outside the fixed market partition", async () => {
    usePages([{
      items: [trade(address(1), { conditionId: condition(2) })],
      hasMore: false,
    }]);

    await expect(discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      marketConditionIds: [condition(1)],
    })).rejects.toMatchObject({ code: "INVALID_PAGE" });
  });

  it("stops locally at 3000 rows before requesting the forbidden offset", async () => {
    const from = vi.fn();
    const pages = Array.from({ length: 6 }, (_, pageIndex) => ({
      items: Array.from({ length: 500 }, () => trade(address(1))),
      hasMore: true,
      nextCursor: `cursor-${pageIndex + 2}`,
    }));
    sdk.listTrades.mockReturnValue(paginated(pages, from));

    await expect(discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      pageSize: 500,
      maxPages: 20,
      maxTrades: 3_000,
    })).rejects.toMatchObject({ code: "TRADE_LIMIT_EXCEEDED" });
    expect(from).toHaveBeenCalledTimes(5);
    expect(from).not.toHaveBeenCalledWith("cursor-7");
  });

  it("aggregates repeated proxy wallets across pages", async () => {
    const wallet = `0x${"a".repeat(40)}`;
    usePages([
      {
        items: [
          trade(wallet.toUpperCase().replace("0X", "0x"), {
            side: "BUY",
            conditionId: "CONDITION-A",
            timestamp: WINDOW_START_MS + 3_000,
          }),
          trade(address(2)),
        ],
        hasMore: true,
        nextCursor: "cursor-2",
      },
      {
        items: [
          trade(wallet, {
            side: "SELL",
            conditionId: "condition-a",
            timestamp: WINDOW_START_SECONDS + 1,
          }),
          trade(wallet, {
            side: "BUY",
            conditionId: "condition-b",
            timestamp: WINDOW_START_MS + 2_000,
          }),
        ],
        hasMore: false,
      },
    ]);

    const result = await discoverGlobalTakerTradeWallets(BASE_OPTIONS);

    expect(result.candidates[0]).toEqual({
      address: wallet,
      tradeCount: 3,
      buyTradeCount: 2,
      sellTradeCount: 1,
      distinctConditionCount: 2,
      firstTradeTimestampMs: WINDOW_START_MS + 1_000,
      lastTradeTimestampMs: WINDOW_START_MS + 3_000,
      sourcePageNumbers: [1, 2],
    });
  });

  it("drops rows whose SDK-normalized proxy wallet is invalid", async () => {
    usePages([{
      items: [
        trade(null),
        trade("0x1234"),
        trade(`0x${"g".repeat(40)}`),
        trade(` ${address(4)}`),
        trade(address(5)),
      ],
      hasMore: false,
    }]);

    const result = await discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      pageSize: 5,
    });

    expect(result.candidates.map((candidate) => candidate.address)).toEqual([address(5)]);
    expect(result.samplingSummary).toMatchObject({
      rowsFetched: 5,
      invalidWalletRows: 4,
      acceptedTradeRows: 1,
    });
  });

  it("normalizes and applies the exclusion address set before aggregation", async () => {
    const excluded = `0x${"b".repeat(40)}`;
    usePages([{
      items: [
        trade(excluded),
        trade(excluded.toUpperCase().replace("0X", "0x")),
        trade(address(2)),
      ],
      hasMore: false,
    }]);

    const result = await discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      pageSize: 3,
      excludeAddresses: [excluded.toUpperCase().replace("0X", "0x"), excluded],
    });

    expect(result.samplingParameters.excludeAddresses).toEqual([excluded]);
    expect(result.candidates.map((candidate) => candidate.address)).toEqual([address(2)]);
    expect(result.samplingSummary.excludedWalletRows).toBe(2);
  });

  it("uses address ascending as a deterministic equal-count tie-break", async () => {
    usePages([{
      items: [trade(address(3)), trade(address(1)), trade(address(2))],
      hasMore: false,
    }]);

    const result = await discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      pageSize: 3,
    });

    expect(result.candidates.map((candidate) => candidate.address)).toEqual([
      address(1),
      address(2),
      address(3),
    ]);
    expect(result.samplingParameters.sort).toBe("trade_count_desc_address_asc");
  });

  it("normalizes Unix seconds and preserves already-normalized milliseconds", async () => {
    const wallet = address(1);
    usePages([{
      items: [
        trade(wallet, { timestamp: WINDOW_START_SECONDS + 10 }),
        trade(wallet, { timestamp: WINDOW_START_MS + 20_000 }),
      ],
      hasMore: false,
    }]);

    const result = await discoverGlobalTakerTradeWallets(BASE_OPTIONS);

    expect(result.candidates[0]).toMatchObject({
      firstTradeTimestampMs: WINDOW_START_MS + 10_000,
      lastTradeTimestampMs: WINDOW_START_MS + 20_000,
    });
  });

  it("accepts timestamps exactly on both fixed-window boundaries", async () => {
    const wallet = address(1);
    usePages([{
      items: [
        trade(wallet, { timestamp: WINDOW_START_SECONDS }),
        trade(wallet, { timestamp: WINDOW_END_MS }),
      ],
      hasMore: false,
    }]);

    const result = await discoverGlobalTakerTradeWallets(BASE_OPTIONS);

    expect(result.candidates[0]).toMatchObject({
      firstTradeTimestampMs: WINDOW_START_MS,
      lastTradeTimestampMs: WINDOW_END_MS,
    });
  });

  it.each([
    {
      name: "one millisecond before the fixed window",
      timestamp: WINDOW_START_MS - 1,
    },
    {
      name: "one second after the fixed window",
      timestamp: WINDOW_END_SECONDS + 1,
    },
    {
      name: "a non-safe integer timestamp",
      timestamp: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      name: "a fractional timestamp",
      timestamp: WINDOW_START_SECONDS + 0.5,
    },
  ])("fails closed for $name", async ({ timestamp }) => {
    usePages([{
      items: [trade(address(1), { timestamp })],
      hasMore: false,
    }]);

    await expect(discoverGlobalTakerTradeWallets(BASE_OPTIONS)).rejects.toMatchObject({
      code: "INVALID_PAGE",
    });
  });

  it.each([
    {
      name: "an oversized SDK page",
      pages: [{ items: [trade(address(1)), trade(address(2))], hasMore: false }],
      options: { ...BASE_OPTIONS, pageSize: 1 },
      code: "INVALID_PAGE",
    },
    {
      name: "hasMore without a cursor",
      pages: [{ items: [trade(address(1))], hasMore: true }],
      options: BASE_OPTIONS,
      code: "INVALID_PAGE",
    },
    {
      name: "hasMore with a blank cursor",
      pages: [{ items: [trade(address(1))], hasMore: true, nextCursor: " " }],
      options: BASE_OPTIONS,
      code: "INVALID_PAGE",
    },
    {
      name: "an empty non-terminal page",
      pages: [{ items: [], hasMore: true, nextCursor: "cursor-2" }],
      options: BASE_OPTIONS,
      code: "INVALID_PAGE",
    },
    {
      name: "a terminal page carrying a cursor",
      pages: [{ items: [trade(address(1))], hasMore: false, nextCursor: "cursor-2" }],
      options: BASE_OPTIONS,
      code: "INVALID_PAGE",
    },
    {
      name: "a repeated pagination cursor",
      pages: [
        { items: [trade(address(1))], hasMore: true, nextCursor: "cursor-2" },
        { items: [trade(address(2))], hasMore: true, nextCursor: "cursor-2" },
      ],
      options: BASE_OPTIONS,
      code: "INVALID_PAGE",
    },
    {
      name: "a page cap that would truncate results",
      pages: [{
        items: [trade(address(1))],
        hasMore: true,
        nextCursor: "cursor-2",
      }],
      options: { ...BASE_OPTIONS, maxPages: 1 },
      code: "PAGE_LIMIT_EXCEEDED",
    },
    {
      name: "a trade cap that would truncate results",
      pages: [{
        items: [trade(address(1))],
        hasMore: true,
        nextCursor: "cursor-2",
      }],
      options: { ...BASE_OPTIONS, maxTrades: 1 },
      code: "TRADE_LIMIT_EXCEEDED",
    },
    {
      name: "a page that crosses the trade cap",
      pages: [{
        items: [trade(address(1)), trade(address(2))],
        hasMore: false,
      }],
      options: { ...BASE_OPTIONS, maxTrades: 1 },
      code: "TRADE_LIMIT_EXCEEDED",
    },
  ])("fails closed for $name", async ({ pages, options, code }) => {
    usePages(pages);

    await expect(discoverGlobalTakerTradeWallets(options)).rejects.toMatchObject({ code });
  });

  it("fails before calling the SDK for non-canonical windows or exclusions", async () => {
    await expect(discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      startUtc: "2026-07-15T00:00:00.001Z",
    })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      excludeAddresses: ["not-an-address"],
    })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      maxTrades: 3_001,
    })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      marketConditionIds: [],
    })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(discoverGlobalTakerTradeWallets({
      ...BASE_OPTIONS,
      marketConditionIds: ["not-a-condition"],
    })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(sdk.listTrades).not.toHaveBeenCalled();
  });
});
