import type { Activity as SdkActivity, ClobTradeActivity } from "@polymarket/bindings/data";
import { ActivityType as SdkActivityType } from "@polymarket/bindings/data";
import { getPublicClient } from "../sdk/public-client.js";
import { fetchJsonWithRetry } from "../util/fetch.js";

export type ActivityType =
  | "TRADE"
  | "SPLIT"
  | "MERGE"
  | "REDEEM"
  | "REWARD"
  | "CONVERSION"
  | "MAKER_REBATE";

export interface Activity {
  proxyWallet?: string;
  timestamp: number;
  conditionId?: string;
  type: ActivityType;
  size?: number;
  usdcSize?: number;
  transactionHash?: string;
  price?: number;
  asset?: string;
  side?: "BUY" | "SELL";
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
}

export interface GetActivityParams {
  user: string;
  limit?: number;
  offset?: number;
  type?: ActivityType;
  sortBy?: "TIMESTAMP" | "TOKENS" | "CASH";
  sortDirection?: "ASC" | "DESC";
}

const DEFAULT_DATA_API_BASE = "https://data-api.polymarket.com";

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length ? s : undefined;
}

function side(v: unknown): "BUY" | "SELL" | undefined {
  return v === "BUY" || v === "SELL" ? v : undefined;
}

function optionalNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function mapSdkActivity(raw: SdkActivity): Activity {
  const generic = raw as Record<string, unknown>;
  const base: Activity = {
    proxyWallet: "wallet" in raw ? String(raw.wallet ?? "") : undefined,
    timestamp: Number(raw.timestamp ?? 0),
    transactionHash: raw.transactionHash ? String(raw.transactionHash) : undefined,
    type: String(raw.type) as ActivityType,
  };

  if (raw.type !== SdkActivityType.TRADE) {
    if (String(raw.type) === "REDEEM") {
      const redeem = raw as SdkActivity & {
        tokenId?: string;
        shares?: unknown;
        amount?: unknown;
        conditionId?: string;
      };
      const asset = redeem.tokenId ? String(redeem.tokenId) : undefined;
      if (!asset) return base;
      const size = num(redeem.shares);
      const usdcSize = num(redeem.amount);
      return {
        ...base,
        type: "REDEEM",
        asset,
        size,
        usdcSize: usdcSize > 0 ? usdcSize : size,
        conditionId: redeem.conditionId ? String(redeem.conditionId) : undefined,
      };
    }
    return {
      ...base,
      conditionId: text(generic.conditionId),
      usdcSize: num(generic.amount ?? generic.usdcSize),
      title: text(generic.title),
      slug: text(generic.slug),
      eventSlug: text(generic.eventSlug),
    };
  }

  const trade = raw as ClobTradeActivity;
  return {
    ...base,
    type: "TRADE",
    size: num(trade.shares),
    usdcSize: num(trade.amount),
    price: num(trade.price),
    asset: trade.tokenId ? String(trade.tokenId) : undefined,
    side: trade.side as "BUY" | "SELL",
    conditionId: trade.conditionId ? String(trade.conditionId) : undefined,
    outcomeIndex: trade.outcomeIndex ?? undefined,
    title: trade.title ?? undefined,
    slug: trade.slug ?? undefined,
    eventSlug: trade.eventSlug ?? undefined,
    outcome: trade.outcome ?? undefined,
  };
}

function mapRawActivity(raw: Record<string, unknown>): Activity {
  const base: Activity = {
    proxyWallet: text(raw.proxyWallet) ?? text(raw.wallet),
    timestamp: num(raw.timestamp),
    transactionHash: text(raw.transactionHash),
    type: String(raw.type) as ActivityType,
  };

  if (base.type !== "TRADE") {
    if (base.type === "REDEEM") {
      const asset = text(raw.asset) ?? text(raw.tokenId);
      if (!asset) return base;
      const size = num(raw.size ?? raw.shares);
      const usdcSize = num(raw.usdcSize ?? raw.amount ?? raw.size ?? raw.shares);
      return {
        ...base,
        asset,
        size,
        usdcSize: usdcSize > 0 ? usdcSize : size,
        conditionId: text(raw.conditionId),
        title: text(raw.title),
        slug: text(raw.slug),
        eventSlug: text(raw.eventSlug),
      };
    }
    return {
      ...base,
      conditionId: text(raw.conditionId),
      usdcSize: num(raw.usdcSize ?? raw.amount ?? raw.size),
      title: text(raw.title),
      slug: text(raw.slug),
      eventSlug: text(raw.eventSlug),
    };
  }

  return {
    ...base,
    size: num(raw.size ?? raw.shares),
    usdcSize: num(raw.usdcSize ?? raw.amount ?? raw.size),
    price: num(raw.price),
    asset: text(raw.asset) ?? text(raw.tokenId),
    side: side(raw.side),
    conditionId: text(raw.conditionId),
    outcomeIndex: optionalNum(raw.outcomeIndex),
    title: text(raw.title),
    slug: text(raw.slug),
    eventSlug: text(raw.eventSlug),
    outcome: text(raw.outcome),
  };
}

function isSdkActivitySchemaError(e: Error): boolean {
  return /^Expected activity\.[A-Za-z0-9_]+ to be present$/.test(e.message);
}

/** @deprecated base URL ignored — uses @polymarket/client listActivity */
export function buildActivityUrl(base: string, params: GetActivityParams): string {
  void base;
  return `sdk:listActivity?user=${params.user}`;
}

function isRetryableActivityError(e: Error): boolean {
  if (e.name === "TimeoutError") return true;
  return /timed out|fetch failed|transport/i.test(e.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchActivityPage(params: GetActivityParams): Promise<Activity[]> {
  const client = await getPublicClient();
  const pageSize = Math.min(500, params.limit ?? 100);
  const paginator = client.listActivity({
    user: params.user,
    pageSize,
    ...(params.type ? { type: [params.type as SdkActivityType] } : {}),
    ...(params.sortBy ? { sortBy: params.sortBy } : {}),
    ...(params.sortDirection ? { sortDirection: params.sortDirection } : {}),
  });

  const first = await paginator.firstPage();
  let items = first.items.map(mapSdkActivity);

  if (params.offset && params.offset > 0) {
    items = items.slice(params.offset);
  }

  return items;
}

function buildRawActivityUrl(base: string, params: GetActivityParams, pageSize: number): string {
  const url = new URL("/activity", base || DEFAULT_DATA_API_BASE);
  url.searchParams.set("user", params.user);
  url.searchParams.set("limit", String(pageSize + 1));
  url.searchParams.set("offset", String(params.offset ?? 0));
  if (params.type) url.searchParams.set("type", params.type);
  if (params.sortBy) url.searchParams.set("sortBy", params.sortBy);
  if (params.sortDirection) url.searchParams.set("sortDirection", params.sortDirection);
  return url.toString();
}

async function fetchRawActivityPage(
  base: string,
  params: GetActivityParams,
  networkRetryLimit: number
): Promise<Activity[]> {
  const pageSize = Math.min(500, params.limit ?? 100);
  const url = buildRawActivityUrl(base, params, pageSize);
  const rows = await fetchJsonWithRetry<unknown[]>(url, {}, networkRetryLimit);
  if (!Array.isArray(rows)) {
    throw new Error("Data API /activity response was not an array");
  }
  return rows
    .slice(0, pageSize)
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
    .map(mapRawActivity);
}

export async function getActivity(
  base: string,
  params: GetActivityParams,
  networkRetryLimit = 0
): Promise<Activity[]> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= networkRetryLimit; attempt++) {
    try {
      return await fetchActivityPage(params);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (isSdkActivitySchemaError(lastError)) {
        try {
          return await fetchRawActivityPage(base, params, networkRetryLimit);
        } catch (fallbackError) {
          const fallback =
            fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
          throw new Error(
            `Data API SDK parse failed (${lastError.message}); raw fallback failed (${fallback.message})`
          );
        }
      }
      if (attempt < networkRetryLimit && isRetryableActivityError(lastError)) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("getActivity failed");
}

export function tradeEventKey(a: Activity): string {
  if (a.type === "REDEEM") return redeemEventKey(a);
  const tx = a.transactionHash ?? "";
  const ts = a.timestamp ?? 0;
  if (a.type !== "TRADE") {
    const id = a.conditionId ?? a.slug ?? a.eventSlug ?? "";
    if (tx) return `${tx}:${a.type}:${id}`;
    return `:${ts}:${a.type}:${id}`;
  }
  const asset = a.asset ?? "";
  const side = a.side ?? "";
  if (tx) return `${tx}:${asset}:${side}`;
  return `:${ts}:${asset}:${side}`;
}

export function redeemEventKey(a: Activity): string {
  const tx = a.transactionHash ?? "";
  const asset = a.asset ?? "";
  const ts = a.timestamp ?? 0;
  if (tx) return `${tx}:${asset}:REDEEM`;
  return `:${ts}:${asset}:REDEEM`;
}
