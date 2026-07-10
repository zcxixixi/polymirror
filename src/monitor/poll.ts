import type { GlobalConfig } from "../config/types.js";
import type { Activity } from "../monitor/data-api.js";
import { getActivity } from "../monitor/data-api.js";
import type { LeaderRegistry } from "../leaders/registry.js";

export interface PollResult {
  leaderId: string;
  fetched: number;
  candidates: Activity[];
  error?: string;
}

export type PollActivityCache = Map<string, Promise<Activity[]>>;

function activityMs(a: Activity): number {
  return a.timestamp > 1e12 ? a.timestamp : a.timestamp * 1000;
}

function activityCacheKey(user: string, global: GlobalConfig): string {
  return [
    user.toLowerCase(),
    global.copyTradesOnly ? "trades-redeems" : "all",
    global.activityLimit,
    global.execution.networkRetryLimit,
  ].join(":");
}

async function fetchLeaderActivities(
  user: string,
  global: GlobalConfig
): Promise<Activity[]> {
  const common = {
    user,
    limit: global.activityLimit,
    offset: 0,
    sortBy: "TIMESTAMP" as const,
    sortDirection: "DESC" as const,
  };

  if (!global.copyTradesOnly) {
    return getActivity("", common, global.execution.networkRetryLimit);
  }

  const [trades, redeems] = await Promise.all([
    getActivity("", { ...common, type: "TRADE" }, global.execution.networkRetryLimit),
    getActivity("", { ...common, type: "REDEEM" }, global.execution.networkRetryLimit),
  ]);
  return [...trades, ...redeems].sort((a, b) => activityMs(b) - activityMs(a));
}

export async function pollLeaders(
  registry: LeaderRegistry,
  global: GlobalConfig,
  activityCache: PollActivityCache = new Map()
): Promise<PollResult[]> {
  const leaders = registry.enabled();

  const settled = await Promise.allSettled(
    leaders.map(async (leader) => {
      const key = activityCacheKey(leader.address!, global);
      let activityPromise = activityCache.get(key);
      if (!activityPromise) {
        activityPromise = fetchLeaderActivities(leader.address!, global);
        activityCache.set(key, activityPromise);
      }
      const activities = await activityPromise;

      const maxAgeMs = global.maxTradeAgeHours * 3600 * 1000;
      const now = Date.now();
      const candidates = activities.filter((a) => {
        const ts = activityMs(a);
        if (now - ts > maxAgeMs) return false;
        if (a.type === "REDEEM") return Boolean(a.conditionId);
        if (a.type !== "TRADE" || !a.asset || !a.side) return false;
        return (a.size ?? 0) >= 0.01;
      });

      return {
        leaderId: leader.id,
        fetched: activities.length,
        candidates,
      };
    })
  );

  return settled.map((result, i) => {
    const leaderId = leaders[i]!.id;
    if (result.status === "fulfilled") return result.value;
    const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { leaderId, fetched: 0, candidates: [], error: msg };
  });
}
