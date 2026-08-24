import type { PublicClient } from "@polymarket/client";
import { getPublicClient } from "../sdk/public-client.js";

type ListTradesPaginator = ReturnType<PublicClient["listTrades"]>;
type ListTradesPage = Awaited<ReturnType<ListTradesPaginator["firstPage"]>>;

/** SDK-normalized Data API trade. `wallet` is the source `proxyWallet`. */
export type GlobalTakerTradeRow = ListTradesPage["items"][number];

export const globalTakerTradeDiscoveryLimits = Object.freeze({
  maxPageSize: 500,
  maxPages: 20,
  // The official Data API rejects historical offsets above 3000. Keep each
  // independently complete query at or below that upstream ceiling.
  maxTrades: 3_000,
  maxMarketConditionsPerQuery: 10,
});

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_TRADES = 1_000;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CONDITION_ID_RE = /^0x[a-fA-F0-9]{64}$/;
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/;

export type GlobalTakerTradeDiscoveryErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_PAGE"
  | "PAGE_LIMIT_EXCEEDED"
  | "TRADE_LIMIT_EXCEEDED";

export class GlobalTakerTradeDiscoveryError extends Error {
  constructor(
    public readonly code: GlobalTakerTradeDiscoveryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "GlobalTakerTradeDiscoveryError";
  }
}

export interface GlobalTakerTradeDiscoveryOptions {
  /** UTC lower bound, aligned to a whole second. */
  startUtc: string;
  /** UTC upper bound, aligned to a whole second. */
  endUtc: string;
  /** SDK page size. Hard-capped by `globalTakerTradeDiscoveryLimits`. */
  pageSize?: number;
  /** Maximum complete pages. Discovery fails instead of returning a partial sample. */
  maxPages?: number;
  /** Maximum complete trade rows. Discovery fails instead of truncating. */
  maxTrades?: number;
  /**
   * Fixed, disjoint market-condition partition for this query. High-volume
   * discovery must invoke separately frozen partitions and retain each
   * complete artifact; an unfiltered query must never be treated as complete
   * after an upstream offset-cap failure.
   */
  marketConditionIds?: readonly string[];
  /** Known proxy-wallet addresses to exclude. Invalid entries fail closed. */
  excludeAddresses?: readonly string[];
}

export interface GlobalTakerTradeCandidate {
  address: string;
  tradeCount: number;
  buyTradeCount: number;
  sellTradeCount: number;
  distinctConditionCount: number;
  firstTradeTimestampMs: number | null;
  lastTradeTimestampMs: number | null;
  sourcePageNumbers: number[];
}

export interface GlobalTakerTradeRawPage {
  pageNumber: number;
  cursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
  items: GlobalTakerTradeRow[];
}

export interface GlobalTakerTradeDiscoveryArtifact {
  schemaVersion: 1;
  source: "polymarket-data-api-global-taker-trades";
  samplingParameters: {
    startUtc: string;
    endUtc: string;
    startEpochSeconds: number;
    endEpochSeconds: number;
    takerOnly: true;
    pageSize: number;
    maxPages: number;
    maxTrades: number;
    marketConditionIds: string[];
    excludeAddresses: string[];
    sort: "trade_count_desc_address_asc";
  };
  rawPages: GlobalTakerTradeRawPage[];
  samplingSummary: {
    pagesFetched: number;
    rowsFetched: number;
    invalidWalletRows: number;
    excludedWalletRows: number;
    acceptedTradeRows: number;
    uniqueCandidates: number;
  };
  candidates: GlobalTakerTradeCandidate[];
}

interface CandidateAccumulator {
  address: string;
  tradeCount: number;
  buyTradeCount: number;
  sellTradeCount: number;
  conditions: Set<string>;
  firstTradeTimestampMs: number | null;
  lastTradeTimestampMs: number | null;
  sourcePageNumbers: Set<number>;
}

function fail(
  code: GlobalTakerTradeDiscoveryErrorCode,
  message: string
): never {
  throw new GlobalTakerTradeDiscoveryError(code, message);
}

function parseUtcSecond(label: string, value: unknown): {
  iso: string;
  epochSeconds: number;
} {
  if (typeof value !== "string" || !UTC_SECOND_RE.test(value)) {
    fail("INVALID_OPTIONS", `${label} must be a whole-second UTC timestamp ending in Z`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) {
    fail("INVALID_OPTIONS", `${label} is not a valid whole-second UTC timestamp`);
  }
  const iso = new Date(milliseconds).toISOString();
  const normalizedInput = value.endsWith(".000Z")
    ? value
    : `${value.slice(0, -1)}.000Z`;
  if (normalizedInput !== iso) {
    fail("INVALID_OPTIONS", `${label} is not a canonical UTC timestamp`);
  }
  return { iso, epochSeconds: milliseconds / 1_000 };
}

function positiveInteger(
  label: string,
  value: unknown,
  fallback: number,
  maximum: number
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || (resolved as number) <= 0 || (resolved as number) > maximum) {
    fail("INVALID_OPTIONS", `${label} must be an integer between 1 and ${maximum}`);
  }
  return resolved as number;
}

function normalizeExcludedAddresses(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("INVALID_OPTIONS", "excludeAddresses must be an array");
  }
  const addresses = new Set<string>();
  for (const address of value) {
    if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
      fail("INVALID_OPTIONS", `excludeAddresses contains an invalid proxy wallet: ${String(address)}`);
    }
    addresses.add(address.toLowerCase());
  }
  return [...addresses].sort(compareStrings);
}

function normalizeMarketConditionIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    fail("INVALID_OPTIONS", "marketConditionIds must be a non-empty array when supplied");
  }
  const conditions = new Set<string>();
  for (const conditionId of value) {
    if (typeof conditionId !== "string" || !CONDITION_ID_RE.test(conditionId)) {
      fail(
        "INVALID_OPTIONS",
        `marketConditionIds contains an invalid condition id: ${String(conditionId)}`
      );
    }
    conditions.add(conditionId.toLowerCase());
  }
  if (conditions.size > globalTakerTradeDiscoveryLimits.maxMarketConditionsPerQuery) {
    fail(
      "INVALID_OPTIONS",
      `marketConditionIds may contain at most ${globalTakerTradeDiscoveryLimits.maxMarketConditionsPerQuery} unique conditions`
    );
  }
  return [...conditions].sort(compareStrings);
}

function normalizeTradeWallet(value: unknown): string | null {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return null;
  return value.toLowerCase();
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function validatePage(
  page: unknown,
  pageNumber: number,
  pageSize: number
): asserts page is ListTradesPage {
  if (!page || typeof page !== "object") {
    fail("INVALID_PAGE", `trade page ${pageNumber} was not an object`);
  }
  const candidate = page as Partial<ListTradesPage>;
  if (!Array.isArray(candidate.items)) {
    fail("INVALID_PAGE", `trade page ${pageNumber} items were not an array`);
  }
  if (candidate.items.length > pageSize) {
    fail(
      "INVALID_PAGE",
      `trade page ${pageNumber} returned ${candidate.items.length} rows, above pageSize ${pageSize}`
    );
  }
  if (typeof candidate.hasMore !== "boolean") {
    fail("INVALID_PAGE", `trade page ${pageNumber} had no boolean hasMore`);
  }
  if (candidate.hasMore && candidate.items.length === 0) {
    fail("INVALID_PAGE", `trade page ${pageNumber} was empty while hasMore=true`);
  }
  if (
    candidate.hasMore
    && (typeof candidate.nextCursor !== "string" || candidate.nextCursor.trim().length === 0)
  ) {
    fail("INVALID_PAGE", `trade page ${pageNumber} had hasMore=true without a next cursor`);
  }
  if (!candidate.hasMore && candidate.nextCursor !== undefined) {
    fail("INVALID_PAGE", `trade page ${pageNumber} had a next cursor while hasMore=false`);
  }
  if (
    candidate.totalCount !== undefined
    && (!Number.isInteger(candidate.totalCount) || candidate.totalCount < 0)
  ) {
    fail("INVALID_PAGE", `trade page ${pageNumber} had an invalid totalCount`);
  }
}

function normalizeTradeTimestampMs(
  value: unknown,
  startTimestampMs: number,
  endTimestampMs: number,
  pageNumber: number,
  rowNumber: number
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(
      "INVALID_PAGE",
      `trade page ${pageNumber} row ${rowNumber} had an invalid timestamp`
    );
  }
  // Data API timestamps are Unix seconds; tolerate already-normalized SDK rows.
  // This mirrors the normalization rule used by the rest of the project.
  const timestampMs = value > 1e12 ? value : value * 1_000;
  if (!Number.isSafeInteger(timestampMs)) {
    fail(
      "INVALID_PAGE",
      `trade page ${pageNumber} row ${rowNumber} timestamp was not safely representable in milliseconds`
    );
  }
  if (timestampMs < startTimestampMs || timestampMs > endTimestampMs) {
    fail(
      "INVALID_PAGE",
      `trade page ${pageNumber} row ${rowNumber} timestamp was outside the fixed UTC window`
    );
  }
  return timestampMs;
}

function toCandidate(accumulator: CandidateAccumulator): GlobalTakerTradeCandidate {
  return {
    address: accumulator.address,
    tradeCount: accumulator.tradeCount,
    buyTradeCount: accumulator.buyTradeCount,
    sellTradeCount: accumulator.sellTradeCount,
    distinctConditionCount: accumulator.conditions.size,
    firstTradeTimestampMs: accumulator.firstTradeTimestampMs,
    lastTradeTimestampMs: accumulator.lastTradeTimestampMs,
    sourcePageNumbers: [...accumulator.sourcePageNumbers].sort((a, b) => a - b),
  };
}

/**
 * Discovers proxy wallets from the official global taker trade tape.
 *
 * This only produces a deterministic candidate artifact. It does not approve,
 * enable, replay, or deploy a wallet; schema-v5 intake remains mandatory.
 */
export async function discoverGlobalTakerTradeWallets(
  options: GlobalTakerTradeDiscoveryOptions
): Promise<GlobalTakerTradeDiscoveryArtifact> {
  if (!options || typeof options !== "object") {
    fail("INVALID_OPTIONS", "global taker trade discovery options are required");
  }
  const start = parseUtcSecond("startUtc", options.startUtc);
  const end = parseUtcSecond("endUtc", options.endUtc);
  if (start.epochSeconds >= end.epochSeconds) {
    fail("INVALID_OPTIONS", "startUtc must be earlier than endUtc");
  }
  const pageSize = positiveInteger(
    "pageSize",
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    globalTakerTradeDiscoveryLimits.maxPageSize
  );
  const maxPages = positiveInteger(
    "maxPages",
    options.maxPages,
    DEFAULT_MAX_PAGES,
    globalTakerTradeDiscoveryLimits.maxPages
  );
  const maxTrades = positiveInteger(
    "maxTrades",
    options.maxTrades,
    DEFAULT_MAX_TRADES,
    globalTakerTradeDiscoveryLimits.maxTrades
  );
  const excludeAddresses = normalizeExcludedAddresses(options.excludeAddresses);
  const marketConditionIds = normalizeMarketConditionIds(options.marketConditionIds);
  const marketConditions = new Set(marketConditionIds);
  const excluded = new Set(excludeAddresses);
  const startTimestampMs = start.epochSeconds * 1_000;
  const endTimestampMs = end.epochSeconds * 1_000;

  const client = await getPublicClient();
  let paginator = client.listTrades({
    pageSize,
    takerOnly: true,
    start: start.epochSeconds,
    end: end.epochSeconds,
    ...(marketConditionIds.length > 0 ? { market: marketConditionIds } : {}),
  });
  let cursor: ListTradesPage["nextCursor"];
  const seenCursors = new Set<string>();
  const rawPages: GlobalTakerTradeRawPage[] = [];
  const candidatesByAddress = new Map<string, CandidateAccumulator>();
  let rowsFetched = 0;
  let invalidWalletRows = 0;
  let excludedWalletRows = 0;
  let acceptedTradeRows = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await paginator.firstPage();
    validatePage(page, pageNumber, pageSize);
    if (page.totalCount !== undefined && page.totalCount > maxTrades) {
      fail(
        "TRADE_LIMIT_EXCEEDED",
        `trade window contains ${page.totalCount} rows, above maxTrades ${maxTrades}`
      );
    }
    if (rowsFetched + page.items.length > maxTrades) {
      fail(
        "TRADE_LIMIT_EXCEEDED",
        `trade rows exceed maxTrades ${maxTrades} on page ${pageNumber}`
      );
    }

    rawPages.push({
      pageNumber,
      cursor: cursor === undefined ? null : String(cursor),
      nextCursor: page.nextCursor === undefined ? null : String(page.nextCursor),
      hasMore: page.hasMore,
      ...(page.totalCount !== undefined ? { totalCount: page.totalCount } : {}),
      items: [...page.items],
    });
    rowsFetched += page.items.length;

    for (const [rowIndex, trade] of page.items.entries()) {
      if (marketConditions.size > 0) {
        const conditionId = typeof trade.conditionId === "string"
          ? trade.conditionId.toLowerCase()
          : null;
        if (conditionId === null || !marketConditions.has(conditionId)) {
          fail(
            "INVALID_PAGE",
            `trade page ${pageNumber} row ${rowIndex + 1} was outside the fixed market partition`
          );
        }
      }
      const timestampMs = normalizeTradeTimestampMs(
        trade.timestamp,
        startTimestampMs,
        endTimestampMs,
        pageNumber,
        rowIndex + 1
      );
      const address = normalizeTradeWallet(trade.wallet);
      if (!address) {
        invalidWalletRows++;
        continue;
      }
      if (excluded.has(address)) {
        excludedWalletRows++;
        continue;
      }
      acceptedTradeRows++;
      let accumulator = candidatesByAddress.get(address);
      if (!accumulator) {
        accumulator = {
          address,
          tradeCount: 0,
          buyTradeCount: 0,
          sellTradeCount: 0,
          conditions: new Set(),
          firstTradeTimestampMs: null,
          lastTradeTimestampMs: null,
          sourcePageNumbers: new Set(),
        };
        candidatesByAddress.set(address, accumulator);
      }
      accumulator.tradeCount++;
      if (trade.side === "BUY") accumulator.buyTradeCount++;
      if (trade.side === "SELL") accumulator.sellTradeCount++;
      if (typeof trade.conditionId === "string" && trade.conditionId.length > 0) {
        accumulator.conditions.add(trade.conditionId.toLowerCase());
      }
      accumulator.firstTradeTimestampMs = accumulator.firstTradeTimestampMs === null
        ? timestampMs
        : Math.min(accumulator.firstTradeTimestampMs, timestampMs);
      accumulator.lastTradeTimestampMs = accumulator.lastTradeTimestampMs === null
        ? timestampMs
        : Math.max(accumulator.lastTradeTimestampMs, timestampMs);
      accumulator.sourcePageNumbers.add(pageNumber);
    }

    if (!page.hasMore) break;
    if (rowsFetched >= maxTrades) {
      fail(
        "TRADE_LIMIT_EXCEEDED",
        `trade window has more rows after reaching maxTrades ${maxTrades}`
      );
    }
    if (pageNumber >= maxPages) {
      fail(
        "PAGE_LIMIT_EXCEEDED",
        `trade window has more pages after reaching maxPages ${maxPages}`
      );
    }
    const nextCursor = String(page.nextCursor);
    if (seenCursors.has(nextCursor)) {
      fail("INVALID_PAGE", `trade pagination cursor repeated on page ${pageNumber}`);
    }
    seenCursors.add(nextCursor);
    cursor = page.nextCursor;
    paginator = paginator.from(page.nextCursor);
  }

  const candidates = [...candidatesByAddress.values()]
    .map(toCandidate)
    .sort((a, b) => b.tradeCount - a.tradeCount || compareStrings(a.address, b.address));

  return {
    schemaVersion: 1,
    source: "polymarket-data-api-global-taker-trades",
    samplingParameters: {
      startUtc: start.iso,
      endUtc: end.iso,
      startEpochSeconds: start.epochSeconds,
      endEpochSeconds: end.epochSeconds,
      takerOnly: true,
      pageSize,
      maxPages,
      maxTrades,
      marketConditionIds,
      excludeAddresses,
      sort: "trade_count_desc_address_asc",
    },
    rawPages,
    samplingSummary: {
      pagesFetched: rawPages.length,
      rowsFetched,
      invalidWalletRows,
      excludedWalletRows,
      acceptedTradeRows,
      uniqueCandidates: candidates.length,
    },
    candidates,
  };
}
