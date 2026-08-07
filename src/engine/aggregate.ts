import type { Activity } from "../monitor/data-api.js";
import { tradeEventKey } from "../monitor/data-api.js";

export interface AggregatedTrade {
  leaderId: string;
  activity: Activity;
  sourceCount: number;
  /** All tradeEventKeys merged into this bucket (for dedup on live). */
  sourceTradeKeys: string[];
}

function activityTs(a: Activity): number {
  return a.timestamp > 1e12 ? a.timestamp : a.timestamp * 1000;
}

function bucketKey(leaderId: string, activity: Activity): string {
  return `${leaderId}:${activity.asset}:${activity.side}`;
}

/**
 * Merge same leader/token/side trades within a time window (newest anchor).
 * windowMs <= 0 disables aggregation.
 */
export function aggregateTrades(
  items: { leaderId: string; activity: Activity }[],
  windowMs: number
): AggregatedTrade[] {
  if (windowMs <= 0 || items.length === 0) {
    return items.map((i) => ({
      leaderId: i.leaderId,
      activity: i.activity,
      sourceCount: 1,
      sourceTradeKeys: [tradeEventKey(i.activity)],
    }));
  }

  const sorted = [...items].sort((a, b) => activityTs(b.activity) - activityTs(a.activity));
  const buckets = new Map<string, AggregatedTrade>();

  for (const item of sorted) {
    mergeIntoBuckets(buckets, item, windowMs);
  }

  return [...buckets.values()].sort((a, b) => activityTs(b.activity) - activityTs(a.activity));
}

/**
 * Per-leader aggregation window (e.g. fast bot leader uses longer merge window).
 * resolveWindow(leaderId) returns ms; falls back to defaultWindowMs when undefined.
 */
export function aggregateTradesPerLeader(
  items: { leaderId: string; activity: Activity }[],
  defaultWindowMs: number,
  resolveWindow: (leaderId: string) => number | undefined
): AggregatedTrade[] {
  if (items.length === 0) return [];

  const byLeader = new Map<string, { leaderId: string; activity: Activity }[]>();
  for (const item of items) {
    const list = byLeader.get(item.leaderId) ?? [];
    list.push(item);
    byLeader.set(item.leaderId, list);
  }

  const out: AggregatedTrade[] = [];
  for (const [leaderId, leaderItems] of byLeader) {
    const windowMs = resolveWindow(leaderId) ?? defaultWindowMs;
    out.push(...aggregateTrades(leaderItems, windowMs));
  }
  return out.sort((a, b) => activityTs(b.activity) - activityTs(a.activity));
}

function mergeIntoBuckets(
  buckets: Map<string, AggregatedTrade>,
  item: { leaderId: string; activity: Activity },
  windowMs: number
): void {
  const { leaderId, activity } = item;
  if (!activity.asset || !activity.side) {
    return;
  }

  const key = bucketKey(leaderId, activity);
  const existing = buckets.get(key);
  const ts = activityTs(activity);

  if (!existing) {
    buckets.set(key, {
      leaderId,
      activity: { ...activity },
      sourceCount: 1,
      sourceTradeKeys: [tradeEventKey(activity)],
    });
    return;
  }

  const anchorTs = activityTs(existing.activity);
  if (Math.abs(anchorTs - ts) > windowMs) {
    buckets.set(`${key}:${ts}`, {
      leaderId,
      activity: { ...activity },
      sourceCount: 1,
      sourceTradeKeys: [tradeEventKey(activity)],
    });
    return;
  }

  const prevSize = existing.activity.size ?? 0;
  const addSize = activity.size ?? 0;
  const prevPrice = existing.activity.price ?? 0;
  const addPrice = activity.price ?? 0;
  const totalSize = prevSize + addSize;
  const vwap =
    totalSize > 0 ? (prevSize * prevPrice + addSize * addPrice) / totalSize : prevPrice;

  existing.activity.size = Math.round(totalSize * 100) / 100;
  existing.activity.price = Math.round(vwap * 10000) / 10000;
  existing.sourceCount += 1;
  existing.sourceTradeKeys.push(tradeEventKey(activity));
}
