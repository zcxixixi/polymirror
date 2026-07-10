import type { GlobalConfig } from "../config/types.js";
import type { Activity } from "../monitor/data-api.js";
import { getActivity } from "../monitor/data-api.js";
import type { LeaderRegistry } from "../leaders/registry.js";

export interface PollResult {
  leaderId: string;
  fetched: number;
  candidates: Activity[];
  observations?: PollObservation[];
  error?: string;
}

export type PollRejectionReasonCode =
  | "stale_activity"
  | "missing_redeem_condition"
  | "unsupported_activity_type"
  | "missing_trade_asset"
  | "missing_trade_side"
  | "below_minimum_activity_size";

export interface PollObservation {
  activity: Activity;
  candidate: boolean;
  rejectionReasonCode?: PollRejectionReasonCode;
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
      const observations = activities.map((a): PollObservation => {
        const ts = activityMs(a);
        if (now - ts > maxAgeMs) return { activity: a, candidate: false, rejectionReasonCode: "stale_activity" };
        if (a.type === "REDEEM") return a.conditionId
          ? { activity: a, candidate: true }
          : { activity: a, candidate: false, rejectionReasonCode: "missing_redeem_condition" };
        if (a.type !== "TRADE") return { activity: a, candidate: false, rejectionReasonCode: "unsupported_activity_type" };
        if (!a.asset) return { activity: a, candidate: false, rejectionReasonCode: "missing_trade_asset" };
        if (!a.side) return { activity: a, candidate: false, rejectionReasonCode: "missing_trade_side" };
        if ((a.size ?? 0) < 0.01) return { activity: a, candidate: false, rejectionReasonCode: "below_minimum_activity_size" };
        return { activity: a, candidate: true };
      });
      const candidates = observations.filter((row) => row.candidate).map((row) => row.activity);

      return {
        leaderId: leader.id,
        fetched: activities.length,
        candidates,
        observations,
      };
    })
  );

  return settled.map((result, i) => {
    const leaderId = leaders[i]!.id;
    if (result.status === "fulfilled") return result.value;
    const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { leaderId, fetched: 0, candidates: [], observations: [], error: msg };
  });
}
