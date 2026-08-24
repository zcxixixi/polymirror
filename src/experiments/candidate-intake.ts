import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  ActivityType,
  type Activity as SdkActivity,
  type Page,
  type PublicClient,
} from "@polymarket/client";
import {
  candidateCohortSchema,
  type CandidateCohortInput,
} from "./candidate-cohort.js";
import { normalizedPayloadJson, payloadSha256 } from "./provenance.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVITY_MARKETS = 500;

export type CandidateActivityRequest = Parameters<PublicClient["listActivity"]>[0];
export type CandidateMarketRequest = Parameters<PublicClient["listMarkets"]>[0];
export type CandidateMarketFetchRequest = Parameters<PublicClient["fetchMarket"]>[0];
export type CandidateClosedPositionRequest = Parameters<PublicClient["listClosedPositions"]>[0];

export interface CandidateActivityMarketRef {
  conditionId: string;
  slug?: string;
}

export const candidateIntakeThresholds = Object.freeze({
  minTrades24h: 20,
  minSellOrRedeem24h: 3,
  minDistinctConditions24h: 5,
  maxMedianTicketUsd: 50,
  maxP90TicketUsd: 500,
  minActivityMarketEndCoveragePct: 100,
  minCopyLeadSeconds: 30,
  minCopyableBuySharePct: 90,
  minProfitabilityPositions: 10,
  minProfitabilityPnlUsd: 0,
  minProfitabilityWinRatePct: 50,
  minProfitabilityProfitFactor: 1.2,
  maxLargestProfitabilityWinSharePct: 50,
  minProfitabilityPnlWithoutLargestWinUsd: 0,
});

export interface CandidateIntakeWindow {
  capturedAt: string;
  sinceMs: number;
  untilMs: number;
}

export interface CandidateIntakeFetcher {
  fetchActivity(address: string, window: CandidateIntakeWindow): Promise<unknown>;
  fetchLeaderboard(address: string, window: CandidateIntakeWindow): Promise<unknown>;
  fetchClosedPositions(address: string, window: CandidateIntakeWindow): Promise<unknown>;
  fetchResolvedMarkets(
    conditionIds: readonly string[],
    window: CandidateIntakeWindow,
    marketRefs?: readonly CandidateActivityMarketRef[]
  ): Promise<unknown>;
}

export interface FilteredCandidateActivityResponse {
  source: "@polymarket/client:listActivity";
  window: { start: number; end: number };
  requests: Array<{
    activityType: ActivityType.TRADE | ActivityType.REDEEM;
    request: CandidateActivityRequest;
    pages: Array<{
      items: SdkActivity[];
      hasMore: boolean;
      nextCursor: Page<SdkActivity[]>["nextCursor"] | null;
      totalCount: number | null;
    }>;
  }>;
  items: SdkActivity[];
}

export interface CandidateActivityClient {
  listActivity(request: CandidateActivityRequest): AsyncIterable<Page<SdkActivity[]>>;
}

export interface CandidateResolvedMarketsClient {
  listMarkets(request: CandidateMarketRequest): AsyncIterable<{
    items: unknown[];
    hasMore: boolean;
    nextCursor?: unknown;
    totalCount?: number;
  }>;
  fetchMarket?(request: CandidateMarketFetchRequest): Promise<unknown>;
}

export interface CandidateClosedPositionsClient {
  listClosedPositions(request: CandidateClosedPositionRequest): AsyncIterable<{
    items: unknown[];
    hasMore: boolean;
    nextCursor?: unknown;
    totalCount?: number;
  }>;
}

export interface FilteredCandidateClosedPositionsResponse {
  source: "@polymarket/client:listClosedPositions";
  request: CandidateClosedPositionRequest;
  pages: Array<{
    items: unknown[];
    hasMore: boolean;
    nextCursor: unknown | null;
    totalCount: number | null;
  }>;
  items: unknown[];
}

export interface FilteredCandidateResolvedMarketsResponse {
  source: "@polymarket/client:listMarkets+fetchMarket";
  requests: Array<{
    request: CandidateMarketRequest;
    pages: Array<{
      items: unknown[];
      hasMore: boolean;
      nextCursor: unknown | null;
      totalCount: number | null;
    }>;
  }>;
  fallbackRequests: Array<{
    conditionId: string;
    request: CandidateMarketFetchRequest;
    item: unknown;
  }>;
  items: unknown[];
}

function mergeCandidateActivityRows(groups: readonly (readonly SdkActivity[])[]): SdkActivity[] {
  const unique = new Map<string, { canonical: string; row: SdkActivity }>();
  for (const row of groups.flat()) {
    const canonical = normalizedPayloadJson(row);
    if (!unique.has(canonical)) unique.set(canonical, { canonical, row });
  }
  return [...unique.values()]
    .sort((a, b) => (
      Number(b.row.timestamp) - Number(a.row.timestamp)
      || String(a.row.type).localeCompare(String(b.row.type))
      || a.canonical.localeCompare(b.canonical)
    ))
    .map(({ row }) => row);
}

export async function fetchFilteredCandidateActivity(
  client: CandidateActivityClient,
  address: string,
  window: CandidateIntakeWindow
): Promise<FilteredCandidateActivityResponse> {
  const requestBase = {
    user: address,
    pageSize: 500,
    start: Math.floor(window.sinceMs / 1000),
    end: Math.ceil(window.untilMs / 1000),
    sortBy: "TIMESTAMP" as const,
    sortDirection: "DESC" as const,
  };
  const requests: FilteredCandidateActivityResponse["requests"] = [];
  const groups: SdkActivity[][] = [];
  for (const activityType of [ActivityType.TRADE, ActivityType.REDEEM] as const) {
    const fetchSlice = async (start: number, end: number): Promise<void> => {
      const request: CandidateActivityRequest = {
        ...requestBase,
        start,
        end,
        type: [activityType],
      };
      const pages: FilteredCandidateActivityResponse["requests"][number]["pages"] = [];
      try {
        for await (const page of client.listActivity(request)) {
          pages.push({
            items: page.items,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor ?? null,
            totalCount: page.totalCount ?? null,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const midpoint = Math.floor((start + end) / 2);
        if (
          /max historical activity offset of 3000 exceeded/i.test(message)
          && midpoint >= start
          && midpoint < end
        ) {
          await fetchSlice(start, midpoint);
          await fetchSlice(midpoint + 1, end);
          return;
        }
        throw error;
      }
      requests.push({ activityType, request, pages });
      groups.push(pages.flatMap((page) => page.items));
    };
    await fetchSlice(requestBase.start, requestBase.end);
  }
  return {
    source: "@polymarket/client:listActivity",
    window: {
      start: requestBase.start,
      end: requestBase.end,
    },
    requests,
    items: mergeCandidateActivityRows(groups),
  };
}

export async function fetchCandidateResolvedMarkets(
  client: CandidateResolvedMarketsClient,
  conditionIds: readonly string[],
  marketRefs: readonly CandidateActivityMarketRef[] = []
): Promise<FilteredCandidateResolvedMarketsResponse> {
  const requests: FilteredCandidateResolvedMarketsResponse["requests"] = [];
  const fallbackRequests: FilteredCandidateResolvedMarketsResponse["fallbackRequests"] = [];
  const items: unknown[] = [];
  for (let index = 0; index < conditionIds.length; index += 50) {
    const request: CandidateMarketRequest = {
      conditionIds: [...conditionIds.slice(index, index + 50)],
      pageSize: 100,
    };
    const pages: FilteredCandidateResolvedMarketsResponse["requests"][number]["pages"] = [];
    for await (const page of client.listMarkets(request)) {
      pages.push({
        items: page.items,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
        totalCount: page.totalCount ?? null,
      });
      items.push(...page.items);
    }
    requests.push({ request, pages });
  }
  const returnedConditionIds = new Set(items.flatMap((item) => {
    const row = object(item);
    const conditionId = nonemptyText(row?.conditionId ?? row?.condition_id);
    return conditionId ? [conditionId.toLowerCase()] : [];
  }));
  const refByCondition = new Map(
    marketRefs.map((ref) => [ref.conditionId.toLowerCase(), ref])
  );
  if (client.fetchMarket) {
    for (const conditionId of conditionIds) {
      const normalizedConditionId = conditionId.toLowerCase();
      if (returnedConditionIds.has(normalizedConditionId)) continue;
      const ref = refByCondition.get(normalizedConditionId);
      if (!ref?.slug) continue;
      const request: CandidateMarketFetchRequest = { slug: ref.slug };
      const item = await client.fetchMarket(request);
      const row = object(item);
      const returnedConditionId = nonemptyText(row?.conditionId ?? row?.condition_id);
      if (returnedConditionId?.toLowerCase() !== normalizedConditionId) {
        throw new Error(`market fallback condition mismatch for ${conditionId}`);
      }
      items.push(item);
      returnedConditionIds.add(normalizedConditionId);
      fallbackRequests.push({ conditionId, request, item });
    }
  }
  return {
    source: "@polymarket/client:listMarkets+fetchMarket",
    requests,
    fallbackRequests,
    items,
  };
}

export async function fetchCandidateClosedPositions(
  client: CandidateClosedPositionsClient,
  address: string
): Promise<FilteredCandidateClosedPositionsResponse> {
  const request: CandidateClosedPositionRequest = {
    user: address,
    pageSize: 50,
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  };
  const pages: FilteredCandidateClosedPositionsResponse["pages"] = [];
  const items: unknown[] = [];
  for await (const page of client.listClosedPositions(request)) {
    pages.push({
      items: page.items,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
      totalCount: page.totalCount ?? null,
    });
    items.push(...page.items);
  }
  if (pages.length === 0 || pages.at(-1)?.hasMore === true) {
    throw new Error("closed positions pagination did not terminate");
  }
  return {
    source: "@polymarket/client:listClosedPositions",
    request,
    pages,
    items,
  };
}

export interface CandidateIntakeMetrics {
  trades24h: number;
  sellOrRedeem24h: number;
  distinctConditions24h: number;
  medianTicketUsd: number | null;
  p90TicketUsd: number | null;
  buyTrades24h: number;
  activityMarketEndCoveragePct: number | null;
  copyableBuyTrades24h: number;
  copyableBuySharePct: number | null;
  medianBuyLeadSeconds: number | null;
  p10BuyLeadSeconds: number | null;
  closedPositions: number;
  closedRealizedPnlUsd: number;
  closedTotalBoughtUsd: number;
  closedWins: number;
  closedLosses: number;
  closedWinRatePct: number | null;
  closedProfitFactor: number | null;
  closedProfitFactorInfinite: boolean;
  largestClosedWinUsd: number;
  largestClosedWinSharePct: number | null;
  closedPnlWithoutLargestWinUsd: number;
  profitabilityPositions: number;
  profitabilityPnlUsd: number;
  profitabilityWins: number;
  profitabilityLosses: number;
  profitabilityWinRatePct: number | null;
  profitabilityProfitFactor: number | null;
  profitabilityProfitFactorInfinite: boolean;
  largestProfitabilityWinUsd: number;
  largestProfitabilityWinSharePct: number | null;
  profitabilityPnlWithoutLargestWinUsd: number;
  derivedResolvedPositions: number;
  unreconciledResolvedPositions: number;
}

export interface CandidateIntakeGates {
  apiNoErrors: boolean;
  trades24h: boolean;
  sellOrRedeem24h: boolean;
  distinctConditions24h: boolean;
  medianTicketUsd: boolean;
  p90TicketUsd: boolean;
  activityMarketEndCoverage: boolean;
  copyableBuyShare: boolean;
  profitabilitySample: boolean;
  profitabilityPnl: boolean;
  profitabilityWinRate: boolean;
  profitabilityProfitFactor: boolean;
  profitabilityWinnerConcentration: boolean;
  profitabilityPnlWithoutLargestWin: boolean;
  profitabilityReconciled: boolean;
}

export interface CandidateIntakeEvidence {
  schemaVersion: 5;
  capturedAt: string;
  window: { since: string; until: string };
  candidate: { id: string; address: string; username?: string };
  thresholds: typeof candidateIntakeThresholds;
  rawResponses: {
    activity: unknown | null;
    leaderboard: unknown | null;
    closedPositions: unknown | null;
    resolvedMarkets: unknown | null;
  };
  apiErrors: string[];
  metrics: CandidateIntakeMetrics;
  gates: CandidateIntakeGates;
  failedGates: Array<keyof CandidateIntakeGates>;
  approved: boolean;
}

export interface CandidateIntakeArtifact {
  candidateId: string;
  address: string;
  fileName: string;
  evidence: CandidateIntakeEvidence;
  canonicalJson: string;
  sha256: string;
}

export interface CandidateIntakeManifest {
  schemaVersion: 1;
  capturedAt: string;
  seedCohortId: string;
  seedCanonicalSha256: string;
  approvedCohortCanonicalSha256: string;
  artifacts: Array<{
    candidateId: string;
    address: string;
    fileName: string;
    sha256: string;
    approved: boolean;
  }>;
}

export interface CandidateIntakeRefreshResult {
  approvedCohort: CandidateCohortInput;
  artifacts: CandidateIntakeArtifact[];
  manifest: CandidateIntakeManifest;
}

interface NormalizedActivity {
  type: string;
  side?: "BUY" | "SELL";
  timestampMs: number;
  conditionId?: string;
  ticketUsd?: number;
  tokenId?: string;
  shares?: number;
  slug?: string;
}

interface NormalizedClosedPosition {
  realizedPnlUsd: number;
  totalBoughtUsd: number;
  conditionId?: string;
  tokenId?: string;
}

interface NormalizedResolvedMarket {
  conditionId: string;
  closed: boolean;
  winnerTokenId?: string;
  endDateMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function extractItems(response: unknown, label: string): unknown[] {
  if (Array.isArray(response)) {
    const looksLikePages = response.length > 0
      && response.every((page) => Array.isArray(object(page)?.items));
    if (looksLikePages) {
      return response.flatMap((page) => object(page)!.items as unknown[]);
    }
    return response;
  }
  const record = object(response);
  if (!record) throw new Error(`${label} response was not an object or array`);
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.pages)) {
    return record.pages.flatMap((page, index) => {
      const items = object(page)?.items;
      if (!Array.isArray(items)) {
        throw new Error(`${label} response page ${index} did not contain items`);
      }
      return items;
    });
  }
  throw new Error(`${label} response did not contain items`);
}

function assertClosedPositionsPaginationComplete(response: unknown): void {
  const record = object(response);
  if (!record) return;
  const directHasMore = record.hasMore;
  if (directHasMore === true) {
    throw new Error("closed positions response was truncated");
  }
  const page = object(record.page);
  if (page?.hasMore === true) {
    throw new Error("closed positions response page was truncated");
  }
  if (Array.isArray(record.pages)) {
    const last = object(record.pages.at(-1));
    if (!last || last.hasMore === true) {
      throw new Error("closed positions response pagination was incomplete");
    }
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function nonemptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  const timestamp = finiteNumber(value);
  if (timestamp === undefined || timestamp <= 0) return undefined;
  return timestamp > 1e12 ? timestamp : timestamp * 1000;
}

function normalizeDateTime(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeActivityRow(value: unknown, index: number): NormalizedActivity {
  const row = object(value);
  if (!row) throw new Error(`activity row ${index} was not an object`);
  const type = nonemptyText(row.type)?.toUpperCase();
  const timestampMs = normalizeTimestamp(row.timestamp);
  if (!type) throw new Error(`activity row ${index} had no type`);
  if (timestampMs === undefined) throw new Error(`activity row ${index} had no timestamp`);

  const normalized: NormalizedActivity = {
    type,
    timestampMs,
    conditionId: nonemptyText(row.conditionId ?? row.condition_id),
    slug: nonemptyText(row.slug ?? row.marketSlug ?? row.market_slug ?? row.eventSlug),
  };
  if (type !== "TRADE") return normalized;

  const side = nonemptyText(row.side)?.toUpperCase();
  if (side !== "BUY" && side !== "SELL") {
    throw new Error(`activity TRADE row ${index} had no valid side`);
  }
  normalized.side = side;
  const explicitTicket = finiteNumber(row.usdcSize ?? row.usdc_size ?? row.amount ?? row.cash);
  const size = finiteNumber(row.size ?? row.shares);
  const price = finiteNumber(row.price);
  const ticketUsd = explicitTicket ?? (
    size !== undefined && price !== undefined ? size * price : undefined
  );
  if (ticketUsd === undefined || ticketUsd <= 0) {
    throw new Error(`activity TRADE row ${index} had no positive ticket notional`);
  }
  normalized.ticketUsd = ticketUsd;
  normalized.tokenId = nonemptyText(row.tokenId ?? row.token_id ?? row.asset);
  if (size !== undefined && size > 0) normalized.shares = size;
  return normalized;
}

function normalizeClosedPositionRow(
  value: unknown,
  index: number
): NormalizedClosedPosition {
  const row = object(value);
  if (!row) throw new Error(`closed position row ${index} was not an object`);
  const realizedPnlUsd = finiteNumber(row.realizedPnl ?? row.realized_pnl);
  const totalBoughtUsd = finiteNumber(row.totalBought ?? row.total_bought);
  if (realizedPnlUsd === undefined) {
    throw new Error(`closed position row ${index} had no realized PnL`);
  }
  if (totalBoughtUsd === undefined || totalBoughtUsd < 0) {
    throw new Error(`closed position row ${index} had no valid total bought`);
  }
  return {
    realizedPnlUsd,
    totalBoughtUsd,
    conditionId: nonemptyText(row.conditionId ?? row.condition_id),
    tokenId: nonemptyText(row.tokenId ?? row.token_id ?? row.asset),
  };
}

function normalizeResolvedMarketRow(
  value: unknown,
  index: number
): NormalizedResolvedMarket {
  const row = object(value);
  if (!row) throw new Error(`resolved market row ${index} was not an object`);
  const conditionId = nonemptyText(row.conditionId ?? row.condition_id);
  if (!conditionId) throw new Error(`resolved market row ${index} had no condition id`);
  const state = object(row.state);
  const endDateMs = normalizeDateTime(
    state?.endDate ?? state?.end_date ?? row.endDate ?? row.end_date
  );
  const resolution = object(row.resolution);
  const status = nonemptyText(
    resolution?.umaResolutionStatus ?? resolution?.uma_resolution_status
  )?.toLowerCase();
  const closed = state?.closed === true || status === "resolved" || status === "settled";
  if (!closed) {
    return {
      conditionId,
      closed: false,
      ...(endDateMs !== undefined ? { endDateMs } : {}),
    };
  }

  const outcomes = object(row.outcomes);
  if (!outcomes) {
    return {
      conditionId,
      closed: true,
      ...(endDateMs !== undefined ? { endDateMs } : {}),
    };
  }
  const priced = Object.values(outcomes)
    .map((value) => object(value))
    .filter((outcome): outcome is Record<string, unknown> => Boolean(outcome))
    .map((outcome) => ({
      tokenId: nonemptyText(outcome.tokenId ?? outcome.token_id),
      price: finiteNumber(outcome.price),
    }))
    .filter((outcome): outcome is { tokenId: string; price: number } =>
      Boolean(outcome.tokenId) && outcome.price !== undefined
    );
  if (priced.length === 0) {
    return {
      conditionId,
      closed: true,
      ...(endDateMs !== undefined ? { endDateMs } : {}),
    };
  }
  const maxPrice = Math.max(...priced.map((outcome) => outcome.price));
  const winners = priced.filter((outcome) => outcome.price === maxPrice && maxPrice > 0);
  return winners.length === 1
    ? {
        conditionId,
        closed: true,
        winnerTokenId: winners[0]!.tokenId,
        ...(endDateMs !== undefined ? { endDateMs } : {}),
      }
    : {
        conditionId,
        closed: true,
        ...(endDateMs !== undefined ? { endDateMs } : {}),
      };
}

function assertResponseAddresses(
  items: readonly unknown[],
  expectedAddress: string,
  label: string
): void {
  for (const [index, item] of items.entries()) {
    const row = object(item);
    if (!row) continue;
    const responseAddress = nonemptyText(
      row.wallet ?? row.proxyWallet ?? row.proxy_wallet
    );
    if (responseAddress && responseAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(`${label} response address mismatch at row ${index}`);
    }
  }
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index]!;
}

interface ProfitStats {
  pnlUsd: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  profitFactor: number | null;
  profitFactorInfinite: boolean;
  largestWinUsd: number;
  largestWinSharePct: number | null;
  pnlWithoutLargestWinUsd: number;
}

function profitStats(pnls: readonly number[]): ProfitStats {
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  const grossWinUsd = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLossUsd = -losses.reduce((sum, pnl) => sum + pnl, 0);
  const pnlUsd = pnls.reduce((sum, pnl) => sum + pnl, 0);
  const largestWinUsd = wins.length > 0 ? Math.max(...wins) : 0;
  return {
    pnlUsd,
    wins: wins.length,
    losses: losses.length,
    winRatePct: wins.length + losses.length > 0
      ? wins.length / (wins.length + losses.length) * 100
      : null,
    profitFactor: grossLossUsd > 0 ? grossWinUsd / grossLossUsd : null,
    profitFactorInfinite: grossWinUsd > 0 && grossLossUsd === 0,
    largestWinUsd,
    largestWinSharePct: grossWinUsd > 0 ? largestWinUsd / grossWinUsd * 100 : null,
    pnlWithoutLargestWinUsd: pnlUsd - largestWinUsd,
  };
}

function positionKey(conditionId: string, tokenId: string): string {
  return `${conditionId.toLowerCase()}|${tokenId}`;
}

function reconcileProfitability(
  rows: readonly NormalizedActivity[],
  closedPositions: readonly NormalizedClosedPosition[],
  resolvedMarkets: readonly NormalizedResolvedMarket[]
): { pnls: number[]; derived: number; unreconciled: number } {
  const pnls = closedPositions.map((position) => position.realizedPnlUsd);
  const coveredConditions = new Set(
    closedPositions
      .filter((position) => position.conditionId && !position.tokenId)
      .map((position) => position.conditionId!.toLowerCase())
  );
  const coveredPositions = new Set(
    closedPositions
      .filter((position) => position.conditionId && position.tokenId)
      .map((position) => positionKey(position.conditionId!, position.tokenId!))
  );
  const rowsByCondition = new Map<string, NormalizedActivity[]>();
  for (const row of rows) {
    if (row.type !== "TRADE" || !row.conditionId) continue;
    const key = row.conditionId.toLowerCase();
    const grouped = rowsByCondition.get(key) ?? [];
    grouped.push(row);
    rowsByCondition.set(key, grouped);
  }

  let derived = 0;
  let unreconciled = 0;
  for (const market of resolvedMarkets) {
    if (!market.closed) continue;
    const conditionKey = market.conditionId.toLowerCase();
    if (coveredConditions.has(conditionKey)) continue;
    const conditionRows = rowsByCondition.get(conditionKey) ?? [];
    const missingTokenRows = conditionRows.filter((row) => !row.tokenId);
    if (missingTokenRows.length > 0) unreconciled++;
    const rowsByToken = new Map<string, NormalizedActivity[]>();
    for (const row of conditionRows) {
      if (!row.tokenId) continue;
      const grouped = rowsByToken.get(row.tokenId) ?? [];
      grouped.push(row);
      rowsByToken.set(row.tokenId, grouped);
    }
    for (const [tokenId, tokenRows] of rowsByToken) {
      if (coveredPositions.has(positionKey(market.conditionId, tokenId))) continue;
      if (
        !market.winnerTokenId
        || tokenRows.some((row) => row.side !== "BUY")
        || tokenRows.some((row) => row.ticketUsd === undefined || row.shares === undefined)
      ) {
        unreconciled++;
        continue;
      }
      const cost = tokenRows.reduce((sum, row) => sum + row.ticketUsd!, 0);
      const payout = tokenId === market.winnerTokenId
        ? tokenRows.reduce((sum, row) => sum + row.shares!, 0)
        : 0;
      if (cost <= 0) {
        unreconciled++;
        continue;
      }
      pnls.push(payout - cost);
      derived++;
    }
  }
  return { pnls, derived, unreconciled };
}

function calculateMetrics(
  rows: readonly NormalizedActivity[],
  closedPositions: readonly NormalizedClosedPosition[],
  resolvedMarkets: readonly NormalizedResolvedMarket[],
  window: CandidateIntakeWindow
): CandidateIntakeMetrics {
  const recent = rows.filter(
    (row) => row.timestampMs >= window.sinceMs && row.timestampMs <= window.untilMs
  );
  const trades = recent.filter((row) => row.type === "TRADE");
  const buys = trades.filter((row) => row.side === "BUY");
  const tickets = trades.map((row) => row.ticketUsd!).sort((a, b) => a - b);
  const marketByCondition = new Map(
    resolvedMarkets.map((market) => [market.conditionId.toLowerCase(), market])
  );
  const tradesWithMarketEnd = trades.filter((row) =>
    row.conditionId !== undefined
    && marketByCondition.get(row.conditionId.toLowerCase())?.endDateMs !== undefined
  );
  const buyLeadSeconds = buys.flatMap((row) => {
    const endDateMs = row.conditionId
      ? marketByCondition.get(row.conditionId.toLowerCase())?.endDateMs
      : undefined;
    return endDateMs === undefined ? [] : [(endDateMs - row.timestampMs) / 1000];
  }).sort((a, b) => a - b);
  const copyableBuyTrades24h = buyLeadSeconds.filter(
    (seconds) => seconds >= candidateIntakeThresholds.minCopyLeadSeconds
  ).length;
  const closed = profitStats(closedPositions.map((row) => row.realizedPnlUsd));
  const reconciliation = reconcileProfitability(recent, closedPositions, resolvedMarkets);
  const profitability = profitStats(reconciliation.pnls);
  return {
    trades24h: trades.length,
    sellOrRedeem24h: recent.filter(
      (row) => row.type === "REDEEM" || (row.type === "TRADE" && row.side === "SELL")
    ).length,
    distinctConditions24h: new Set(
      recent
        .filter((row) => row.type === "TRADE" || row.type === "REDEEM")
        .map((row) => row.conditionId)
        .filter((value): value is string => Boolean(value))
    ).size,
    medianTicketUsd: median(tickets),
    p90TicketUsd: nearestRank(tickets, 0.9),
    buyTrades24h: buys.length,
    activityMarketEndCoveragePct: trades.length > 0
      ? tradesWithMarketEnd.length / trades.length * 100
      : null,
    copyableBuyTrades24h,
    copyableBuySharePct: buys.length > 0
      ? copyableBuyTrades24h / buys.length * 100
      : null,
    medianBuyLeadSeconds: median(buyLeadSeconds),
    p10BuyLeadSeconds: nearestRank(buyLeadSeconds, 0.1),
    closedPositions: closedPositions.length,
    closedRealizedPnlUsd: closed.pnlUsd,
    closedTotalBoughtUsd: closedPositions.reduce(
      (sum, row) => sum + row.totalBoughtUsd,
      0
    ),
    closedWins: closed.wins,
    closedLosses: closed.losses,
    closedWinRatePct: closed.winRatePct,
    closedProfitFactor: closed.profitFactor,
    closedProfitFactorInfinite: closed.profitFactorInfinite,
    largestClosedWinUsd: closed.largestWinUsd,
    largestClosedWinSharePct: closed.largestWinSharePct,
    closedPnlWithoutLargestWinUsd: closed.pnlWithoutLargestWinUsd,
    profitabilityPositions: reconciliation.pnls.length,
    profitabilityPnlUsd: profitability.pnlUsd,
    profitabilityWins: profitability.wins,
    profitabilityLosses: profitability.losses,
    profitabilityWinRatePct: profitability.winRatePct,
    profitabilityProfitFactor: profitability.profitFactor,
    profitabilityProfitFactorInfinite: profitability.profitFactorInfinite,
    largestProfitabilityWinUsd: profitability.largestWinUsd,
    largestProfitabilityWinSharePct: profitability.largestWinSharePct,
    profitabilityPnlWithoutLargestWinUsd: profitability.pnlWithoutLargestWinUsd,
    derivedResolvedPositions: reconciliation.derived,
    unreconciledResolvedPositions: reconciliation.unreconciled,
  };
}

function evaluateGates(
  metrics: CandidateIntakeMetrics,
  apiErrors: readonly string[]
): CandidateIntakeGates {
  return {
    apiNoErrors: apiErrors.length === 0,
    trades24h: metrics.trades24h >= candidateIntakeThresholds.minTrades24h,
    sellOrRedeem24h:
      metrics.sellOrRedeem24h >= candidateIntakeThresholds.minSellOrRedeem24h,
    distinctConditions24h:
      metrics.distinctConditions24h >= candidateIntakeThresholds.minDistinctConditions24h,
    medianTicketUsd: metrics.medianTicketUsd !== null
      && metrics.medianTicketUsd <= candidateIntakeThresholds.maxMedianTicketUsd,
    p90TicketUsd: metrics.p90TicketUsd !== null
      && metrics.p90TicketUsd <= candidateIntakeThresholds.maxP90TicketUsd,
    activityMarketEndCoverage: metrics.activityMarketEndCoveragePct !== null
      && metrics.activityMarketEndCoveragePct
        >= candidateIntakeThresholds.minActivityMarketEndCoveragePct,
    copyableBuyShare: metrics.copyableBuySharePct !== null
      && metrics.copyableBuySharePct
        >= candidateIntakeThresholds.minCopyableBuySharePct,
    profitabilitySample:
      metrics.profitabilityPositions
        >= candidateIntakeThresholds.minProfitabilityPositions,
    profitabilityPnl:
      metrics.profitabilityPnlUsd > candidateIntakeThresholds.minProfitabilityPnlUsd,
    profitabilityWinRate: metrics.profitabilityWinRatePct !== null
      && metrics.profitabilityWinRatePct
        >= candidateIntakeThresholds.minProfitabilityWinRatePct,
    profitabilityProfitFactor: metrics.profitabilityProfitFactorInfinite
      || (metrics.profitabilityProfitFactor !== null
        && metrics.profitabilityProfitFactor
          >= candidateIntakeThresholds.minProfitabilityProfitFactor),
    profitabilityWinnerConcentration: metrics.largestProfitabilityWinSharePct !== null
      && metrics.largestProfitabilityWinSharePct
        <= candidateIntakeThresholds.maxLargestProfitabilityWinSharePct,
    profitabilityPnlWithoutLargestWin:
      metrics.profitabilityPnlWithoutLargestWinUsd
        > candidateIntakeThresholds.minProfitabilityPnlWithoutLargestWinUsd,
    profitabilityReconciled: metrics.unreconciledResolvedPositions === 0,
  };
}

async function evaluateCandidate(
  candidate: CandidateCohortInput["candidates"][number],
  fetcher: CandidateIntakeFetcher,
  window: CandidateIntakeWindow
): Promise<CandidateIntakeArtifact> {
  if (!candidate.address) {
    throw new Error(`Candidate ${candidate.id} requires an exact address for fresh intake`);
  }
  const [activityResult, leaderboardResult, closedPositionsResult] =
    await Promise.allSettled([
    fetcher.fetchActivity(candidate.address, window),
    fetcher.fetchLeaderboard(candidate.address, window),
    fetcher.fetchClosedPositions(candidate.address, window),
  ]);
  const rawActivity = activityResult.status === "fulfilled" ? activityResult.value : null;
  const rawLeaderboard = leaderboardResult.status === "fulfilled" ? leaderboardResult.value : null;
  const rawClosedPositions = closedPositionsResult.status === "fulfilled"
    ? closedPositionsResult.value
    : null;
  const apiErrors: string[] = [];
  let normalizedRows: NormalizedActivity[] = [];
  let normalizedClosedPositions: NormalizedClosedPosition[] = [];
  let rawResolvedMarkets: unknown | null = null;
  let normalizedResolvedMarkets: NormalizedResolvedMarket[] = [];

  if (activityResult.status === "rejected") {
    apiErrors.push(`activity: ${errorMessage(activityResult.reason)}`);
  } else {
    try {
      const items = extractItems(activityResult.value, "activity");
      assertResponseAddresses(items, candidate.address, "activity");
      normalizedRows = items.map(normalizeActivityRow);
    } catch (error) {
      apiErrors.push(`activity: ${errorMessage(error)}`);
    }
  }
  if (leaderboardResult.status === "rejected") {
    apiErrors.push(`leaderboard: ${errorMessage(leaderboardResult.reason)}`);
  } else {
    try {
      const items = extractItems(leaderboardResult.value, "leaderboard");
      assertResponseAddresses(items, candidate.address, "leaderboard");
    } catch (error) {
      apiErrors.push(`leaderboard: ${errorMessage(error)}`);
    }
  }

  if (closedPositionsResult.status === "rejected") {
    apiErrors.push(`closed positions: ${errorMessage(closedPositionsResult.reason)}`);
  } else {
    try {
      assertClosedPositionsPaginationComplete(closedPositionsResult.value);
      const items = extractItems(closedPositionsResult.value, "closed positions");
      assertResponseAddresses(items, candidate.address, "closed positions");
      normalizedClosedPositions = items.map(normalizeClosedPositionRow);
    } catch (error) {
      apiErrors.push(`closed positions: ${errorMessage(error)}`);
    }
  }

  const recentTradeRows = normalizedRows.filter((row) =>
    row.type === "TRADE"
    && row.timestampMs >= window.sinceMs
    && row.timestampMs <= window.untilMs
    && Boolean(row.conditionId)
  );
  const marketRefByCondition = new Map<string, CandidateActivityMarketRef>();
  for (const row of recentTradeRows) {
    const conditionId = row.conditionId!;
    const key = conditionId.toLowerCase();
    const existing = marketRefByCondition.get(key);
    if (existing?.slug && row.slug && existing.slug !== row.slug) {
      apiErrors.push(`activity markets: conflicting slugs for condition ${conditionId}`);
      continue;
    }
    marketRefByCondition.set(key, {
      conditionId,
      ...(existing?.slug || row.slug ? { slug: existing?.slug ?? row.slug } : {}),
    });
  }
  const activityMarketRefs = [...marketRefByCondition.values()];
  const resolutionConditionIds = activityMarketRefs.map((ref) => ref.conditionId);
  try {
    if (resolutionConditionIds.length > MAX_ACTIVITY_MARKETS) {
      throw new Error(
        `activity condition count ${resolutionConditionIds.length} exceeds ${MAX_ACTIVITY_MARKETS}`
      );
    }
    rawResolvedMarkets = await fetcher.fetchResolvedMarkets(
      resolutionConditionIds,
      window,
      activityMarketRefs
    );
    const items = extractItems(rawResolvedMarkets, "resolved markets");
    normalizedResolvedMarkets = items.map(normalizeResolvedMarketRow);
    const requested = new Set(resolutionConditionIds.map((id) => id.toLowerCase()));
    const unexpected = normalizedResolvedMarkets.find(
      (market) => !requested.has(market.conditionId.toLowerCase())
    );
    if (unexpected) {
      throw new Error(`resolved markets response contained unrequested condition ${unexpected.conditionId}`);
    }
    const returned = new Set<string>();
    const duplicate = normalizedResolvedMarkets.find((market) => {
      const conditionId = market.conditionId.toLowerCase();
      if (returned.has(conditionId)) return true;
      returned.add(conditionId);
      return false;
    });
    if (duplicate) {
      throw new Error(`resolved markets response duplicated condition ${duplicate.conditionId}`);
    }
  } catch (error) {
    apiErrors.push(`resolved markets: ${errorMessage(error)}`);
    normalizedResolvedMarkets = [];
  }

  const metrics = calculateMetrics(
    normalizedRows,
    normalizedClosedPositions,
    normalizedResolvedMarkets,
    window
  );
  const gates = evaluateGates(metrics, apiErrors);
  const failedGates = (Object.entries(gates) as Array<[keyof CandidateIntakeGates, boolean]>)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const evidence: CandidateIntakeEvidence = {
    schemaVersion: 5,
    capturedAt: window.capturedAt,
    window: {
      since: new Date(window.sinceMs).toISOString(),
      until: new Date(window.untilMs).toISOString(),
    },
    candidate: {
      id: candidate.id,
      address: candidate.address,
      ...(candidate.username ? { username: candidate.username } : {}),
    },
    thresholds: candidateIntakeThresholds,
    rawResponses: {
      activity: rawActivity,
      leaderboard: rawLeaderboard,
      closedPositions: rawClosedPositions,
      resolvedMarkets: rawResolvedMarkets,
    },
    apiErrors,
    metrics,
    gates,
    failedGates,
    approved: failedGates.length === 0,
  };
  const canonicalJson = normalizedPayloadJson(evidence);
  return {
    candidateId: candidate.id,
    address: candidate.address,
    fileName: `${candidate.id}-${candidate.address.toLowerCase()}.json`,
    evidence,
    canonicalJson,
    sha256: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}

export async function refreshCandidateIntake(
  seedInput: unknown,
  fetcher: CandidateIntakeFetcher,
  options: { capturedAt?: string } = {}
): Promise<CandidateIntakeRefreshResult> {
  const seed = candidateCohortSchema.parse(seedInput);
  if (seed.candidates.some(
    (candidate) => candidate.freshIntakePassed || candidate.freshIntakeEvidenceSha256
  )) {
    throw new Error("Fresh Candidate intake requires a watchlist-only seed");
  }
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const untilMs = Date.parse(capturedAt);
  if (!Number.isFinite(untilMs)) throw new Error("capturedAt must be a valid ISO timestamp");
  const window: CandidateIntakeWindow = {
    capturedAt: new Date(untilMs).toISOString(),
    sinceMs: untilMs - DAY_MS,
    untilMs,
  };

  const artifacts: CandidateIntakeArtifact[] = [];
  for (const candidate of seed.candidates) {
    artifacts.push(await evaluateCandidate(candidate, fetcher, window));
  }
  const artifactByCandidate = new Map(
    artifacts.map((artifact) => [artifact.candidateId, artifact])
  );
  const approvedCohort = candidateCohortSchema.parse({
    ...seed,
    candidates: seed.candidates.map((candidate) => {
      const artifact = artifactByCandidate.get(candidate.id)!;
      const { freshIntakeEvidenceSha256: _oldEvidence, ...base } = candidate;
      return artifact.evidence.approved
        ? {
            ...base,
            freshIntakePassed: true,
            freshIntakeEvidenceSha256: artifact.sha256,
          }
        : { ...base, freshIntakePassed: false };
    }),
  });
  const manifest: CandidateIntakeManifest = {
    schemaVersion: 1,
    capturedAt: window.capturedAt,
    seedCohortId: seed.cohortId,
    seedCanonicalSha256: payloadSha256(seed),
    approvedCohortCanonicalSha256: payloadSha256(approvedCohort),
    artifacts: artifacts.map((artifact) => ({
      candidateId: artifact.candidateId,
      address: artifact.address,
      fileName: artifact.fileName,
      sha256: artifact.sha256,
      approved: artifact.evidence.approved,
    })),
  };
  return { approvedCohort, artifacts, manifest };
}

export interface PersistCandidateIntakeOptions {
  seedPath: string;
  outputPath: string;
  archiveDir: string;
}

export function persistCandidateIntakeRefresh(
  result: CandidateIntakeRefreshResult,
  options: PersistCandidateIntakeOptions
): void {
  const seedPath = resolve(options.seedPath);
  const outputPath = resolve(options.outputPath);
  const archiveDir = resolve(options.archiveDir);
  if (seedPath === outputPath) throw new Error("Approved cohort must not overwrite the seed");
  if (outputPath.startsWith(`${archiveDir}${sep}`)) {
    throw new Error("Approved cohort output must be outside the evidence directory");
  }
  if (existsSync(outputPath)) throw new Error(`Approved cohort already exists: ${outputPath}`);
  if (existsSync(archiveDir)) throw new Error(`Evidence path already exists: ${archiveDir}`);

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(archiveDir), { recursive: true });
  const nonce = `${process.pid}-${randomUUID()}`;
  const stagingDir = `${archiveDir}.tmp-${nonce}`;
  const stagingOutput = `${outputPath}.tmp-${nonce}`;
  let archivePublished = false;
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
    for (const artifact of result.artifacts) {
      writeFileSync(resolve(stagingDir, artifact.fileName), artifact.canonicalJson, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    writeFileSync(
      resolve(stagingDir, "manifest.json"),
      normalizedPayloadJson(result.manifest),
      { encoding: "utf8", mode: 0o600 }
    );
    writeFileSync(stagingOutput, `${JSON.stringify(result.approvedCohort, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(stagingDir, archiveDir);
    archivePublished = true;
    linkSync(stagingOutput, outputPath);
    unlinkSync(stagingOutput);
  } catch (error) {
    if (!archivePublished && existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    if (existsSync(stagingOutput)) rmSync(stagingOutput, { force: true });
    throw error;
  }
}
