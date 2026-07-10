import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Activity, ActivityType } from "../src/monitor/data-api.js";
import { fetchResolvedMarketOutcome } from "../src/monitor/market-resolve.js";
import { replayPreviewActivities } from "../src/sim/preview-replay.js";
import { StateStore } from "../src/state/store.js";
import type { GlobalConfig, LeaderConfig } from "../src/config/types.js";
import { ensureUndiciGlobalProxy, resolveProxyConfig, setProxyConfig } from "../src/util/proxy.js";

const DEFAULT_LEADER = "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4";

interface SweepVariant {
  id: string;
  note: string;
  leader: LeaderConfig;
  global: GlobalConfig;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function baseGlobal(overrides: Partial<GlobalConfig["risk"]> = {}): GlobalConfig {
  return {
    previewMode: true,
    pollIntervalMs: 10_000,
    activityLimit: 500,
    copyTradesOnly: true,
    maxTradeAgeHours: 24,
    buyDedupWindowMs: 0,
    tradeAggregationWindowMs: 0,
    healthPort: 0,
    risk: {
      enableCopyTrading: true,
      dailyLossCapPct: 100,
      startingCapitalUsd: 200,
      maxDailyVolumeUsd: 100_000,
      maxOpenMarkets: 200,
      maxOrderUsd: 20,
      minOrderUsd: 1,
      slippageTolerance: 0,
      maxPositionPerTokenUsd: 0,
      syncWalletBalance: false,
      ...overrides,
    },
    execution: {
      orderType: "GTC",
      retryLimit: 3,
      networkRetryLimit: 3,
      gtcFillTimeoutMs: 10_000,
      pendingOrderMaxAgeHours: 48,
    },
    conflict: { mode: "priority_leader", priority: [] },
    notify: {
      telegramOnCopy: false,
      telegramOnError: false,
      telegramOnKillSwitch: false,
    },
    proxy: {
      mode: "none",
      staticUrl: "",
      dynamicUrl: "",
      dynamicRotateSession: false,
    },
  };
}

function leader(strategy: LeaderConfig["strategy"], maxOrderUsd: number, maxPositionUsd?: number): LeaderConfig {
  return {
    id: "sweep_leader",
    address: DEFAULT_LEADER,
    enabled: true,
    weight: 1,
    strategy,
    limits: {
      maxOrderUsd,
      ...(maxPositionUsd !== undefined ? { maxPositionUsd } : {}),
    },
    filters: {
      minPrice: 0.05,
      maxPrice: 0.95,
      sides: ["BUY", "SELL"],
    },
  };
}

function variants(): SweepVariant[] {
  return [
    {
      id: "fixed_1u",
      note: "current stable baseline",
      leader: leader({ type: "FIXED", copySize: 1 }, 1),
      global: baseGlobal({ maxOrderUsd: 1 }),
    },
    {
      id: "fixed_2u",
      note: "slightly larger fixed sizing",
      leader: leader({ type: "FIXED", copySize: 2 }, 2),
      global: baseGlobal({ maxOrderUsd: 2 }),
    },
    {
      id: "fixed_5u",
      note: "aggressive fixed sizing",
      leader: leader({ type: "FIXED", copySize: 5 }, 5),
      global: baseGlobal({ maxOrderUsd: 5 }),
    },
    {
      id: "fixed_1u_token_cap_8u",
      note: "stable fixed sizing with per-token cost cap",
      leader: leader({ type: "FIXED", copySize: 1 }, 1, 8),
      global: baseGlobal({ maxOrderUsd: 1, positionCapBasis: "cost" }),
    },
    {
      id: "fixed_1u_token_cap_6u",
      note: "conservative fixed sizing with tighter per-token cost cap",
      leader: leader({ type: "FIXED", copySize: 1 }, 1, 6),
      global: baseGlobal({ maxOrderUsd: 1, positionCapBasis: "cost" }),
    },
    {
      id: "fixed_1u_token_cap_10u",
      note: "fixed $1 sizing with looser per-token cost cap",
      leader: leader({ type: "FIXED", copySize: 1 }, 1, 10),
      global: baseGlobal({ maxOrderUsd: 1, positionCapBasis: "cost" }),
    },
    {
      id: "fixed_1_5u_token_cap_10u",
      note: "middle fixed sizing between conservative and balanced",
      leader: leader({ type: "FIXED", copySize: 1.5 }, 1.5, 10),
      global: baseGlobal({ maxOrderUsd: 1.5, positionCapBasis: "cost" }),
    },
    {
      id: "fixed_1_5u_token_cap_12u",
      note: "middle fixed sizing with looser per-token cap",
      leader: leader({ type: "FIXED", copySize: 1.5 }, 1.5, 12),
      global: baseGlobal({ maxOrderUsd: 1.5, positionCapBasis: "cost" }),
    },
    {
      id: "fixed_2u_token_cap_12u",
      note: "balanced fixed sizing with per-token cost cap",
      leader: leader({ type: "FIXED", copySize: 2 }, 2, 12),
      global: baseGlobal({ maxOrderUsd: 2, positionCapBasis: "cost" }),
    },
    {
      id: "fixed_2u_token_cap_10u",
      note: "balanced fixed sizing with tighter per-token cap",
      leader: leader({ type: "FIXED", copySize: 2 }, 2, 10),
      global: baseGlobal({ maxOrderUsd: 2, positionCapBasis: "cost" }),
    },
    {
      id: "fixed_2u_token_cap_16u",
      note: "aggressive fixed sizing with wider per-token cap",
      leader: leader({ type: "FIXED", copySize: 2 }, 2, 16),
      global: baseGlobal({ maxOrderUsd: 2, positionCapBasis: "cost" }),
    },
    {
      id: "fixed_2_5u_token_cap_15u",
      note: "more aggressive fixed sizing with capital concentration guard",
      leader: leader({ type: "FIXED", copySize: 2.5 }, 2.5, 15),
      global: baseGlobal({ maxOrderUsd: 2.5, positionCapBasis: "cost" }),
    },
    {
      id: "pct_5_cap_20u",
      note: "percentage sizing that often misses small trades",
      leader: leader({ type: "PERCENTAGE", copySize: 5 }, 20),
      global: baseGlobal({ maxOrderUsd: 20 }),
    },
    {
      id: "pct_10_cap_20u",
      note: "moderate percentage sizing",
      leader: leader({ type: "PERCENTAGE", copySize: 10 }, 20),
      global: baseGlobal({ maxOrderUsd: 20 }),
    },
    {
      id: "pct_25_cap_20u",
      note: "aggressive percentage sizing",
      leader: leader({ type: "PERCENTAGE", copySize: 25 }, 20),
      global: baseGlobal({ maxOrderUsd: 20 }),
    },
    {
      id: "adaptive_10_5_20_cap_20u",
      note: "adaptive percentage dampens large leader trades",
      leader: leader(
        {
          type: "ADAPTIVE",
          copySize: 10,
          adaptiveMinPercent: 5,
          adaptiveMaxPercent: 20,
          adaptiveThresholdUsd: 500,
        },
        20
      ),
      global: baseGlobal({ maxOrderUsd: 20 }),
    },
  ];
}

function activityMs(a: Activity): number {
  return a.timestamp > 1e12 ? a.timestamp : a.timestamp * 1000;
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length ? s : undefined;
}

function mapHttpActivity(raw: Record<string, unknown>): Activity {
  const type = String(raw.type ?? "") as ActivityType;
  const base: Activity = {
    proxyWallet: text(raw.proxyWallet) ?? text(raw.wallet),
    timestamp: num(raw.timestamp),
    transactionHash: text(raw.transactionHash),
    type,
    conditionId: text(raw.conditionId),
    usdcSize: num(raw.usdcSize ?? raw.amount),
    title: text(raw.title),
    slug: text(raw.slug),
    eventSlug: text(raw.eventSlug),
  };

  if (type !== "TRADE") return base;

  return {
    ...base,
    size: num(raw.size ?? raw.shares),
    price: num(raw.price),
    asset: text(raw.asset) ?? text(raw.tokenId),
    side: String(raw.side ?? "") as "BUY" | "SELL",
    outcomeIndex: Number.isFinite(Number(raw.outcomeIndex)) ? Number(raw.outcomeIndex) : undefined,
    outcome: text(raw.outcome),
  };
}

async function fetchActivityHttp(
  address: string,
  type: ActivityType,
  limit: number
): Promise<Activity[]> {
  const params = new URLSearchParams({
    user: address,
    type,
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
    limit: String(limit),
    offset: "0",
  });
  const url = `https://data-api.polymarket.com/activity?${params}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = (await res.json()) as unknown;
      if (!Array.isArray(json)) throw new Error("Data API returned non-array activity payload");
      return json.map((row) => mapHttpActivity(row as Record<string, unknown>));
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchLeaderActivities(address: string, limit: number): Promise<Activity[]> {
  const [trades, redeems] = await Promise.all([
    fetchActivityHttp(address, "TRADE", limit),
    fetchActivityHttp(address, "REDEEM", limit),
  ]);
  return [...trades, ...redeems].sort((a, b) => activityMs(a) - activityMs(b));
}

function topReasons(reasons: Record<string, number>): string[] {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => `${count}x ${reason}`);
}

const address = process.argv[2] ?? process.env.SWEEP_LEADER ?? DEFAULT_LEADER;
const limit = Math.min(500, Math.max(1, numEnv("SWEEP_LIMIT", 500)));
const outDir = process.env.SWEEP_OUT_DIR ?? "reports/preview-sweeps";

const proxy = resolveProxyConfig({ mode: "none" });
setProxyConfig(proxy.config, proxy.source);
await ensureUndiciGlobalProxy();

console.log(`Fetching ${limit} TRADE and ${limit} REDEEM activities for ${address}...`);
const activities = await fetchLeaderActivities(address, limit);
console.log(`Fetched ${activities.length} activities.`);

const resolutionCache = new Map<string, Promise<ReturnType<typeof fetchResolvedMarketOutcome>>>();
const resolveMarket = (slug: string, atMs: number) => {
  const key = `${slug}:${Math.floor(atMs / 60_000)}`;
  let cached = resolutionCache.get(key);
  if (!cached) {
    cached = fetchResolvedMarketOutcome(slug, atMs);
    resolutionCache.set(key, cached);
  }
  return cached;
};

const startedAt = new Date().toISOString();
const results = [];

for (const variant of variants()) {
  const temp = join(tmpdir(), `polymirror-sweep-${variant.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const store = new StateStore(join(temp, "preview.db"));
  try {
    const result = await replayPreviewActivities({
      store,
      leader: { ...variant.leader, address },
      global: variant.global,
      activities,
      resolveMarket,
    });
    results.push({
      id: variant.id,
      note: variant.note,
      copyTrades: result.copyTrades,
      settlements: result.settlements,
      skipped: result.skipped,
      cashUsd: Number(result.cashUsd.toFixed(4)),
      minCashUsd: Number(result.minCashUsd.toFixed(4)),
      openCostUsd: Number(result.openCostUsd.toFixed(4)),
      peakOpenCostUsd: Number(result.peakOpenCostUsd.toFixed(4)),
      peakMarketCostUsd: Number(result.peakMarketCostUsd.toFixed(4)),
      realizedPnlUsd: Number(result.realizedPnlUsd.toFixed(4)),
      capitalUsedPct: Number((((200 - result.cashUsd) / 200) * 100).toFixed(2)),
      peakCapitalUsedPct: Number(((result.peakOpenCostUsd / 200) * 100).toFixed(2)),
      cashStarvedSkips: result.cashStarvedSkips,
      positionCapSkips: result.positionCapSkips,
      maxOpenMarketSkips: result.maxOpenMarketSkips,
      unmatchedRedeemSkips: result.unmatchedRedeemSkips,
      trialScore: Number(
        (
          result.realizedPnlUsd +
          result.copyTrades * 0.02 -
          result.cashStarvedSkips * 0.5 -
          result.positionCapSkips * 0.05 -
          Math.max(0, (result.peakOpenCostUsd / 200) * 100 - 90) * 1.2 -
          Math.max(0, result.peakMarketCostUsd - 40) * 0.15
        ).toFixed(4)
      ),
      skipReasons: result.skipReasons,
      topSkipReasons: topReasons(result.skipReasons),
    });
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

results.sort((a, b) => {
  return b.trialScore - a.trialScore;
});

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `sweep-${startedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ startedAt, address, limit, activities: activities.length, results }, null, 2)
);

console.table(
  results.map((r) => ({
    id: r.id,
    score: r.trialScore,
    copy: r.copyTrades,
    settle: r.settlements,
    skipped: r.skipped,
    cash: r.cashUsd,
    minCash: r.minCashUsd,
    openCost: r.openCostUsd,
    peakOpen: r.peakOpenCostUsd,
    peakMarket: r.peakMarketCostUsd,
    pnl: r.realizedPnlUsd,
    usedPct: r.capitalUsedPct,
    peakUsedPct: r.peakCapitalUsedPct,
    cashSkips: r.cashStarvedSkips,
    capSkips: r.positionCapSkips,
    marketSkips: r.maxOpenMarketSkips,
    unmatchedRedeems: r.unmatchedRedeemSkips,
  }))
);
console.log(`Report: ${outPath}`);
console.log("Top skip reasons by variant:");
for (const r of results) {
  console.log(`- ${r.id}: ${r.topSkipReasons.join(" | ") || "none"}`);
}
