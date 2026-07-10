const TOKEN_KEY = "polymirror_dashboard_token";
const ACCOUNT_KEY = "polymirror_active_account";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function getActiveAccountId(): string | null {
  return sessionStorage.getItem(ACCOUNT_KEY);
}

export function setActiveAccountId(id: string): void {
  sessionStorage.setItem(ACCOUNT_KEY, id);
}

/** Prefix API path with active account scope. Discover/auth stay global. */
export function accountApi(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (
    normalized.startsWith("/api/discover") ||
    normalized.startsWith("/api/auth") ||
    normalized === "/api/accounts" ||
    normalized === "/api/quality" ||
    normalized.startsWith("/api/leaders/validate") ||
    normalized === "/api/config/reload" ||
    normalized === "/api/settings/proxy/test" ||
    normalized === "/api/settings/telegram"
  ) {
    return normalized;
  }
  const accountId = getActiveAccountId();
  if (!accountId) return normalized;
  if (normalized.startsWith("/api/accounts/")) return normalized;
  const suffix = normalized.replace(/^\/api/, "") || "";
  return `/api/accounts/${encodeURIComponent(accountId)}${suffix}`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = accountApi(path);
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const text = await res.text();
    if (text) {
      try {
        const err = JSON.parse(text) as {
          error?: string;
          details?: { message: string }[];
        };
        const detail = err.details?.map((d) => d.message).join("; ");
        throw new Error(detail || err.error || `HTTP ${res.status}`);
      } catch (e) {
        if (e instanceof Error && e.message !== text) throw e;
      }
    }
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface AccountSummary {
  id: string;
  label: string;
  enabled: boolean;
  walletAddress: string;
  walletEnv: string | null;
  previewMode: boolean;
  dbPath: string;
  killSwitchActive: boolean;
  enabledLeaders: string[];
  lastPollAt: number | null;
  lastPoll: {
    fetched: number;
    copied: number;
    skipped: number;
    pendingFilled: number;
    errors: string[];
  } | null;
  todayVolumeUsd: number;
  todayCopyCount: number;
  todayRealizedPnl?: number;
  initialCapitalUsd?: number;
  cashUsd?: number | null;
  openCostUsd?: number;
  openPositions?: number;
  pendingOrders: number;
}

export interface AccountsResponse {
  accounts: AccountSummary[];
  defaultAccountId: string;
}

export interface CopyQualityIssue {
  code:
    | "healthy"
    | "no_data"
    | "not_buying"
    | "not_selling"
    | "parameter_filtered"
    | "cash_occupied"
    | "risk_limited"
    | "market_unsettled"
    | "strategy_losing"
    | "safety_blocker";
  severity: "ok" | "info" | "warning" | "danger";
  label: string;
  detail: string;
}

export interface CopyQualitySummary {
  detected: { buy: number; sell: number; redeem: number; totalTrades: number };
  copied: { buy: number; sell: number; totalTrades: number };
  deduped?: { buy: number; sell: number; totalTrades: number };
  effectiveDetected?: { buy: number; sell: number; totalTrades: number };
  coverage: { buyPct: number; sellPct: number; tradePct: number };
  effectiveCoverage?: { buyPct: number; sellPct: number; tradePct: number };
  skips: {
    parameterFiltered: number;
    cashBlocked: number;
    exposureBlocked: number;
    sellWithoutLocal: number;
    noLocalRedeem: number;
    unresolvedRedeem: number;
    alreadySeen: number;
  };
  copyGap?: {
    buy: {
      detected: number;
      deduped: number;
      effectiveDetected: number;
      copied: number;
      skipped: {
        parameterFiltered: number;
        cashBlocked: number;
        exposureBlocked: number;
        sellWithoutLocal: number;
        other: number;
        total: number;
      };
      unclassified: number;
      copyPct: number;
      explainedPct: number;
      topUnclassified?: {
        tokenId: string;
        detected: number;
        deduped: number;
        copied: number;
        skipped: number;
        unclassified: number;
        lastSkipReason: string | null;
      }[];
    };
    sell: {
      detected: number;
      deduped: number;
      effectiveDetected: number;
      copied: number;
      skipped: {
        parameterFiltered: number;
        cashBlocked: number;
        exposureBlocked: number;
        sellWithoutLocal: number;
        other: number;
        total: number;
      };
      unclassified: number;
      copyPct: number;
      explainedPct: number;
      topUnclassified?: {
        tokenId: string;
        detected: number;
        deduped: number;
        copied: number;
        skipped: number;
        unclassified: number;
        lastSkipReason: string | null;
      }[];
    };
  };
  redeem: { count: number; payoutUsd: number; pnlUsd: number };
  open: { costUsd: number; positions: number; cashUsd: number; exposurePct: number };
  primaryIssue: CopyQualityIssue;
  notes: string[];
  marketPnl: {
    conditionId: string | null;
    title: string | null;
    slug: string | null;
    redeemCount: number;
    payoutUsd: number;
    pnlUsd: number;
  }[];
}

export type ProfitDependencyIssue =
  | "diversified"
  | "concentrated"
  | "no_profit"
  | "insufficient_data";

export interface PerformanceSummary {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  totalPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  winRatePct: number;
  profitFactor: number | null;
  payoffRatio: number | null;
  sharpeRatio: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  largestWinUsd: number;
  largestLossUsd: number;
  largestWinContributionPct: number;
  top3WinContributionPct: number;
  dependencyIssue: ProfitDependencyIssue;
  equityStabilityPct: number;
  recent: {
    sinceMs: number | null;
    tradeCount: number;
    pnlUsd: number;
    winRatePct: number;
    profitFactor: number | null;
  };
}

export type ProfitabilityGateGrade =
  | "live_candidate"
  | "candidate"
  | "watch"
  | "reject";

export interface ProfitabilityGateAssessment {
  grade: ProfitabilityGateGrade;
  passed: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
  sample: {
    settledTrades: number;
    copyTrades: number;
    recentSettledTrades: number;
  };
  metrics: {
    realizedPnlUsd: number;
    sharpeRatio: number | null;
    profitFactor: number | null;
    winRatePct: number;
    payoffRatio: number | null;
    maxDrawdownPct: number;
    dependencyIssue: ProfitDependencyIssue | string;
    equityStabilityPct: number;
    recentPnlUsd: number;
    recentProfitFactor: number | null;
  };
}

export interface GoalMarketSummary {
  marketCount: number;
  pnlUsd: number;
  winRatePct: number;
  profitFactor: number | null;
  grossProfitUsd: number;
  grossLossUsd: number;
  slippageSampleCount: number;
  slippageCoveragePct: number;
  slippageLossPct: number | null;
}

export interface GoalWindowSummary {
  sinceMs: number;
  marketCount: number;
  pnlUsd: number;
  winRatePct: number;
  profitFactor: number | null;
  grossProfitUsd: number;
  grossLossUsd: number;
}

export interface StabilityGoalMetrics {
  observationDays: number;
  activeTradingDays: number;
  firstCopyAtMs: number | null;
  lastCopyAtMs: number | null;
  settledMarketCount: number;
  copyPnlUsd: number;
  grossCopyVolumeUsd: number;
  pnlVolumePct: number;
  overall: GoalMarketSummary;
  recent20: GoalMarketSummary;
  slippage: {
    observationStartedAtMs: number | null;
    observationDays: number;
    copyCount: number;
    sampleCount: number;
    totalNotionalUsd: number;
    sampledNotionalUsd: number;
    coveragePct: number;
    lossPct: number | null;
  };
  windows: {
    h24: GoalWindowSummary;
    d7: GoalWindowSummary;
    d14: GoalWindowSummary;
  };
}

export interface StabilityGoalAssessment {
  passed: boolean;
  status: "qualified" | "collecting" | "not_qualified";
  failedChecks: string[];
  blockers: string[];
  warnings: string[];
  checks: Array<{
    key: string;
    label: string;
    passed: boolean;
    actual: number | null;
    target: number;
    comparator: ">=" | "<=" | ">" | "=";
  }>;
}

export interface QualityAccountReport {
  accountId: string;
  label?: string;
  enabled: boolean;
  previewMode: boolean;
  exists: boolean;
  enabledLeaderCount?: number;
  enabledLeaderIds?: string[];
  copyingActive?: boolean;
  cashUsd?: number;
  openCostUsd?: number;
  openPositions?: number;
  realizedPnlUsd?: number;
  copyCount?: number;
  redeemCount?: number;
  skipCount?: number;
  errorCount?: number;
  cashReplayDeltaUsd?: number;
  capitalDeltaUsd?: number;
  pendingOrderCount?: number;
  liveOrderIntentCount?: number;
  copyQuality?: CopyQualitySummary;
  performance?: PerformanceSummary;
  goalMetrics?: StabilityGoalMetrics;
  stabilityGoal?: StabilityGoalAssessment;
  profitabilityGate?: ProfitabilityGateAssessment;
  error?: string;
}

export interface QualityResponse {
  generatedAt: string;
  windowMinutes: number;
  reports: QualityAccountReport[];
  summary: {
    totalAccounts: number;
    enabledAccounts: number;
    activeCopyAccounts?: number;
    settleOnlyAccounts?: number;
    issueCounts: Record<string, number>;
    gateCounts?: Record<string, number>;
    copyGap?: {
      accountsWithUnclassified: number;
      unclassifiedBuy: number;
      unclassifiedSell: number;
      unclassifiedTotal: number;
    };
    activeIssueCounts?: Record<string, number>;
    activeGateCounts?: Record<string, number>;
    activeStabilityGoalCounts?: Record<string, number>;
    stabilityGoal?: {
      requiredQualifiedStrategies: number;
      qualifiedStrategies: number;
      independentQualifiedStrategies: number;
      strategyRequirementPassed: boolean;
    };
    activeCopyGap?: {
      accountsWithUnclassified: number;
      unclassifiedBuy: number;
      unclassifiedSell: number;
      unclassifiedTotal: number;
    };
    freshActiveCopyGap?: {
      windowMinutes: number;
      copyGap: {
        accountsWithUnclassified: number;
        unclassifiedBuy: number;
        unclassifiedSell: number;
        unclassifiedTotal: number;
      };
    };
  };
}

export interface StatusResponse {
  version: string;
  accountId: string;
  accountLabel: string;
  status: string;
  uptimeSec: number;
  previewMode: boolean;
  copyTradingEnabled: boolean;
  killSwitchActive: boolean;
  lastPollAt: number | null;
  lastPoll: {
    fetched: number;
    copied: number;
    skipped: number;
    pendingFilled: number;
    errors: string[];
  } | null;
  enabledLeaders: string[];
  lastError: string | null;
  pendingOrders: number;
  walletDrifts: string[];
  dbPath: string;
  accounts?: AccountSummary[];
}

export interface DailyStatsResponse {
  accountId: string;
  today: {
    date: string;
    volumeUsd: number;
    realizedPnl: number;
    copyCount: number;
    killSwitch: number;
  };
  leaders: { leaderId: string; volumeUsd: number }[];
}

export interface LeaderRow {
  id: string;
  address?: string;
  username?: string;
  enabled: boolean;
  weight: number;
  strategy: { type: string; copySize: number };
  limits?: { maxOrderUsd?: number; maxPositionUsd?: number; maxDailyVolumeUsd?: number };
  filters?: { minPrice?: number; maxPrice?: number; sides?: string[] };
  todayVolumeUsd: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  leaderId: string | null;
  action: string;
  tokenId: string | null;
  side: string | null;
  size: number | null;
  price: number | null;
  reason: string | null;
  preview: boolean;
}

export interface PositionRow {
  leaderId: string;
  tokenId: string;
  shares: number;
  avgEntryPrice: number;
}

export interface PendingOrderRow {
  orderId: string;
  leaderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  filledShares: number;
  tradeKey: string;
  reasoning: string;
  createdAt: number;
  updatedAt: number;
}

export async function fetchAccounts(): Promise<AccountsResponse> {
  return apiFetch<AccountsResponse>("/api/accounts");
}
