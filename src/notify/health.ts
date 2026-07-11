import type { CopyCycleResult } from "../engine/copy-cycle.js";
import type { CapacityReason, CapacityStatus } from "../engine/capacity-guard.js";
import type { ExperimentCopyState } from "../state/store.js";

export interface HealthSnapshot {
  startedAt: number;
  previewMode: boolean;
  lastPollAt: number | null;
  lastPollResult: CopyCycleResult | null;
  killSwitchActive: boolean;
  enabledLeaders: string[];
  lastError: string | null;
  pendingOrders: number;
  walletDrifts: string[];
  settlementFailures: number;
  closedMarketOpenPositions: number;
  dbSizeBytes: number;
  dbGrowthBytesPerHour: number;
  filesystemAvailableBytes: number | null;
  filesystemDeclineBytesPerHour: number | null;
  capacityProjectedDays: number | null;
  capacityStatus: CapacityStatus | null;
  capacityReasons: CapacityReason[];
  enabledAccountCount: number;
  polledAccountCount: number;
  experiments: Array<{
    accountId: string;
    state: ExperimentCopyState;
    reason: string | null;
    killSwitchActive: boolean;
    liquidationEquityUsd: number | null;
    liquidationDrawdownPct: number | null;
    quoteCoveragePct: number | null;
  }>;
}

/** Process-level health summary (aggregated across accounts). */
export const healthSnapshot: HealthSnapshot = {
  startedAt: Date.now(),
  previewMode: true,
  lastPollAt: null,
  lastPollResult: null,
  killSwitchActive: false,
  enabledLeaders: [],
  lastError: null,
  pendingOrders: 0,
  walletDrifts: [],
  settlementFailures: 0,
  closedMarketOpenPositions: 0,
  dbSizeBytes: 0,
  dbGrowthBytesPerHour: 0,
  filesystemAvailableBytes: null,
  filesystemDeclineBytesPerHour: null,
  capacityProjectedDays: null,
  capacityStatus: null,
  capacityReasons: [],
  enabledAccountCount: 0,
  polledAccountCount: 0,
  experiments: [],
};

export function syncAggregateHealth(
  accounts: {
    id?: string;
    enabled?: boolean;
    health: {
      previewMode: boolean;
      lastPollAt: number | null;
      lastPollResult: CopyCycleResult | null;
      killSwitchActive: boolean;
      enabledLeaders: string[];
      lastError: string | null;
      pendingOrders: number;
      walletDrifts: string[];
      experimentState?: ExperimentCopyState;
      experimentReason?: string | null;
      settlementFailures?: number;
      closedMarketOpenPositions?: number;
      liquidationEquityUsd?: number | null;
      liquidationDrawdownPct?: number | null;
      quoteCoveragePct?: number | null;
      dbSizeBytes?: number;
      dbGrowthBytesPerHour?: number | null;
    };
  }[]
): void {
  if (accounts.length === 0) return;

  const enabledAccounts = accounts.filter((a) => a.enabled !== false);

  healthSnapshot.enabledAccountCount = enabledAccounts.length;
  healthSnapshot.polledAccountCount = enabledAccounts.filter(
    (account) => account.health.lastPollAt !== null
  ).length;
  healthSnapshot.previewMode = enabledAccounts.every((a) => a.health.previewMode);
  healthSnapshot.killSwitchActive = enabledAccounts.some((a) => a.health.killSwitchActive);
  healthSnapshot.enabledLeaders = enabledAccounts.flatMap((a) => a.health.enabledLeaders);
  healthSnapshot.pendingOrders = enabledAccounts.reduce((s, a) => s + a.health.pendingOrders, 0);
  healthSnapshot.walletDrifts = enabledAccounts.flatMap((a) => a.health.walletDrifts);
  healthSnapshot.settlementFailures = enabledAccounts.reduce(
    (sum, account) => sum + (account.health.settlementFailures ?? 0),
    0
  );
  healthSnapshot.closedMarketOpenPositions = enabledAccounts.reduce(
    (sum, account) => sum + (account.health.closedMarketOpenPositions ?? 0),
    0
  );
  healthSnapshot.dbSizeBytes = enabledAccounts.reduce(
    (sum, account) => sum + (account.health.dbSizeBytes ?? 0),
    0
  );
  healthSnapshot.dbGrowthBytesPerHour = enabledAccounts.reduce(
    (sum, account) => sum + (account.health.dbGrowthBytesPerHour ?? 0),
    0
  );
  healthSnapshot.experiments = enabledAccounts.map((account) => ({
    accountId: account.id ?? "unknown",
    state: account.health.experimentState ?? "ACTIVE",
    reason: account.health.experimentReason ?? null,
    killSwitchActive: account.health.killSwitchActive,
    liquidationEquityUsd: account.health.liquidationEquityUsd ?? null,
    liquidationDrawdownPct: account.health.liquidationDrawdownPct ?? null,
    quoteCoveragePct: account.health.quoteCoveragePct ?? null,
  }));
  healthSnapshot.lastError = enabledAccounts.find(
    (account) => account.health.lastError !== null
  )?.health.lastError ?? null;

  const withPoll = enabledAccounts
    .filter((a) => a.health.lastPollAt)
    .sort((a, b) => (b.health.lastPollAt ?? 0) - (a.health.lastPollAt ?? 0));
  const latest = withPoll[0];
  if (latest) {
    healthSnapshot.lastPollAt = latest.health.lastPollAt;
    healthSnapshot.lastPollResult = latest.health.lastPollResult;
  }
}

const EXPECTED_SETTLE_ONLY_REASON = "MANUAL_LEGACY_COHORT_SETTLE_ONLY";

/** True only for an unexpected sticky stop; planned legacy settlement is healthy operation. */
export function hasAbnormalExperimentControl(snapshot: HealthSnapshot): boolean {
  let expectedKillSeen = false;
  for (const experiment of snapshot.experiments) {
    const expectedSettleOnly = experiment.state === "SETTLE_ONLY"
      && experiment.reason === EXPECTED_SETTLE_ONLY_REASON;
    if (expectedSettleOnly) {
      if (experiment.killSwitchActive) expectedKillSeen = true;
      continue;
    }
    if (experiment.state !== "ACTIVE" || experiment.killSwitchActive === true) return true;
  }

  if (!snapshot.killSwitchActive) return false;
  return !expectedKillSeen;
}

/** @deprecated use AccountManager.updateHealthAfterPoll */
export function updateHealthAfterPoll(
  result: CopyCycleResult,
  killSwitchActive: boolean
): void {
  healthSnapshot.lastPollAt = Date.now();
  healthSnapshot.lastPollResult = result;
  healthSnapshot.killSwitchActive = killSwitchActive;
  healthSnapshot.lastError = result.errors[0] ?? null;
}
