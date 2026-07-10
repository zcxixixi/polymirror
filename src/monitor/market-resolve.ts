import { getPublicClient } from "../sdk/public-client.js";

export interface ResolvedMarketOutcome {
  closed: boolean;
  winnerTokenIds: string[];
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function timeMs(v: unknown): number | null {
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof v === "string" || typeof v === "number") {
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function highestPricedWinnerTokenIds(
  outcomes: Array<{ tokenId?: unknown; price?: unknown }>
): string[] {
  const priced = outcomes
    .map((o) => ({
      tokenId: o.tokenId ? String(o.tokenId) : "",
      price: num(o.price),
    }))
    .filter((o) => o.tokenId && Number.isFinite(o.price));

  if (priced.length === 0) return [];
  const maxPrice = Math.max(...priced.map((o) => o.price));
  if (maxPrice <= 0) return [];

  const winners = priced.filter((o) => o.price === maxPrice);
  return winners.length === 1 ? [winners[0]!.tokenId] : [];
}

export async function fetchResolvedMarketOutcome(
  slug?: string,
  nowMs = Date.now()
): Promise<ResolvedMarketOutcome | null> {
  if (!slug) return null;

  const client = await getPublicClient();
  const market = await client.fetchMarket({ slug });
  const status = String(market.resolution.umaResolutionStatus ?? "").toLowerCase();
  const officiallyClosedNow =
    Boolean(market.state.closed) || status === "resolved" || status === "settled";
  const outcomes = [market.outcomes.yes, market.outcomes.no];
  const endMs = timeMs(market.state.endDate);
  const officiallyClosed =
    officiallyClosedNow && (endMs === null || endMs <= nowMs);
  const winnerTokenIds = officiallyClosed ? highestPricedWinnerTokenIds(outcomes) : [];

  return { closed: officiallyClosed, winnerTokenIds };
}
