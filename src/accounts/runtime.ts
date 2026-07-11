import type { CopyCycleResult } from "../engine/copy-cycle.js";
import type { RuntimeConfig } from "../config/types.js";
import type { StateStore } from "../state/store.js";
import type { ExperimentCopyState } from "../state/store.js";
import {
  recordRollingByteRate,
  type RollingByteSample,
} from "../engine/capacity-guard.js";

export interface AccountHealthSlice {
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
  dbSizeSampleAt?: number | null;
  dbSizeSamples?: RollingByteSample[];
}

export function newAccountHealth(config: RuntimeConfig): AccountHealthSlice {
  return {
    previewMode: config.app.global.previewMode,
    lastPollAt: null,
    lastPollResult: null,
    killSwitchActive: false,
    enabledLeaders: config.app.leaders.filter((l) => l.enabled).map((l) => l.id),
    lastError: null,
    pendingOrders: 0,
    walletDrifts: [],
    experimentState: "ACTIVE",
    experimentReason: null,
    settlementFailures: 0,
    closedMarketOpenPositions: 0,
    liquidationEquityUsd: null,
    liquidationDrawdownPct: null,
    quoteCoveragePct: null,
    dbSizeBytes: 0,
    dbGrowthBytesPerHour: null,
    dbSizeSampleAt: null,
    dbSizeSamples: [],
  };
}

export interface AccountRuntime {
  id: string;
  label: string;
  enabled: boolean;
  walletEnv: string;
  config: RuntimeConfig;
  store: StateStore;
  dbPath: string;
  health: AccountHealthSlice;
}

export function sampleAccountDbFootprint(
  health: AccountHealthSlice,
  dbSizeBytes: number,
  sampledAt = Date.now()
): void {
  const dbSizeSamples = health.dbSizeSamples ?? [];
  health.dbSizeBytes = dbSizeBytes;
  health.dbGrowthBytesPerHour = recordRollingByteRate(
    dbSizeSamples,
    { bytes: dbSizeBytes, sampledAt },
    "increase"
  );
  health.dbSizeSampleAt = sampledAt;
  health.dbSizeSamples = dbSizeSamples;
}

export function updateAccountHealthAfterPoll(
  health: AccountHealthSlice,
  result: CopyCycleResult,
  killSwitchActive: boolean,
  pendingOrders: number,
  walletDrifts: string[],
  diagnostics?: {
    experimentState: ExperimentCopyState;
    experimentReason: string | null;
    settlementFailures: number;
    closedMarketOpenPositions: number;
    liquidationEquityUsd: number | null;
    liquidationDrawdownPct: number | null;
    quoteCoveragePct: number | null;
    dbSizeBytes: number;
    sampledAt?: number;
  }
): void {
  const resolvedDiagnostics = diagnostics ?? {
    experimentState: health.experimentState ?? "ACTIVE",
    experimentReason: health.experimentReason ?? null,
    settlementFailures: health.settlementFailures ?? 0,
    closedMarketOpenPositions: health.closedMarketOpenPositions ?? 0,
    liquidationEquityUsd: health.liquidationEquityUsd ?? null,
    liquidationDrawdownPct: health.liquidationDrawdownPct ?? null,
    quoteCoveragePct: health.quoteCoveragePct ?? null,
    dbSizeBytes: health.dbSizeBytes ?? 0,
  };
  const sampledAt = resolvedDiagnostics.sampledAt ?? Date.now();
  health.lastPollAt = Date.now();
  health.lastPollResult = result;
  health.killSwitchActive = killSwitchActive;
  health.pendingOrders = pendingOrders;
  health.walletDrifts = walletDrifts;
  health.lastError = result.errors[0] ?? null;
  health.experimentState = resolvedDiagnostics.experimentState;
  health.experimentReason = resolvedDiagnostics.experimentReason;
  health.settlementFailures = resolvedDiagnostics.settlementFailures;
  health.closedMarketOpenPositions = resolvedDiagnostics.closedMarketOpenPositions;
  health.liquidationEquityUsd = resolvedDiagnostics.liquidationEquityUsd;
  health.liquidationDrawdownPct = resolvedDiagnostics.liquidationDrawdownPct;
  health.quoteCoveragePct = resolvedDiagnostics.quoteCoveragePct;
  sampleAccountDbFootprint(health, resolvedDiagnostics.dbSizeBytes, sampledAt);
}
