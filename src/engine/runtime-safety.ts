import type { RuntimeConfig } from "../config/types.js";
import type {
  EquitySnapshotRow,
  ExperimentControlRow,
  StateStore,
} from "../state/store.js";
import {
  assessLiquidationEquity,
  type LiquidationEquityAssessment,
} from "./liquidation-equity.js";

const EQUITY_REFRESH_MS = 60_000;
const MAX_LIQUIDATION_DRAWDOWN_PCT = 10;

export interface RuntimeSafetyResult {
  control: ExperimentControlRow | null;
  equity: LiquidationEquityAssessment | null;
  capitalDeltaUsd: number;
  activeSettlementFailures: number;
  staleExchangeState: number;
  dataIssues: string[];
}

function round8(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function snapshotAssessment(snapshot: EquitySnapshotRow): LiquidationEquityAssessment {
  return {
    cashUsd: snapshot.cashUsd,
    liquidationValueUsd: snapshot.liquidationValueUsd,
    equityUsd: snapshot.equityUsd,
    openCostUsd: snapshot.openCostUsd,
    quoteCoverage: snapshot.quoteCoverage,
    missingTokenIds: [],
    drawdownPct: snapshot.drawdownPct,
    peakEquityUsd: snapshot.peakEquityUsd,
  };
}

function staleExchangeStateCount(
  config: RuntimeConfig,
  store: StateStore,
  nowMs: number
): number {
  const cutoff = nowMs - config.app.global.pollIntervalMs * 2;
  const pending = store.listPendingOrders().filter((row) => row.updatedAt <= cutoff).length;
  const intents = store.listLiveOrderIntents().filter((row) => row.updatedAt <= cutoff).length;
  return pending + intents;
}

function stopForDataIssue(
  store: StateStore,
  control: ExperimentControlRow,
  reasonCode: string,
  details: Record<string, unknown>,
  nowMs: number
): ExperimentControlRow {
  if (control.state === "ACTIVE") {
    return store.setExperimentControl({
      experimentId: control.experimentId,
      state: "QUARANTINED",
      reasonCode,
      details,
      triggeredAt: nowMs,
    });
  }
  if (
    control.state === "QUARANTINED"
    && control.reasonCode?.startsWith("DATA_")
    && control.reasonCode !== "DATA_CAPACITY_LOW"
  ) {
    return store.markExperimentDataUnhealthy({
      experimentId: control.experimentId,
      observedAt: nowMs,
    });
  }
  return control;
}

export async function evaluateRuntimeSafety(
  config: RuntimeConfig,
  store: StateStore,
  options: { nowMs?: number; forceEquityRefresh?: boolean } = {}
): Promise<RuntimeSafetyResult> {
  const nowMs = options.nowMs ?? Date.now();
  const experiment = store.getActiveExperiment();
  if (!experiment) {
    return {
      control: null,
      equity: null,
      capitalDeltaUsd: 0,
      activeSettlementFailures: 0,
      staleExchangeState: 0,
      dataIssues: [],
    };
  }

  const initial = config.app.global.risk.startingCapitalUsd;
  const cashUsd = store.readCashBalance(initial);
  const openCostUsd = store.getOpenPositionSummary().openCostUsd;
  const realizedPnlUsd = store.getTotalRealizedPnl();
  const capitalDeltaUsd = round8(cashUsd + openCostUsd - initial - realizedPnlUsd);
  const failures = store.listActiveSettlementFailures(experiment.experimentId);
  const maxFailureCount = failures.reduce((max, failure) => Math.max(max, failure.count), 0);
  const staleExchangeState = staleExchangeStateCount(config, store, nowMs);
  const dataIssues: string[] = [];
  if (Math.abs(capitalDeltaUsd) > 0.01) dataIssues.push("ledger_drift");
  if (failures.length > 0) dataIssues.push("settlement_failure");
  if (staleExchangeState > 0) dataIssues.push("stale_exchange_state");

  let control = store.getExperimentControl(experiment.experimentId)!;
  if (Math.abs(capitalDeltaUsd) > 0.01) {
    control = stopForDataIssue(
      store,
      control,
      "DATA_LEDGER_DRIFT",
      { capitalDeltaUsd },
      nowMs
    );
  } else if (maxFailureCount >= 3) {
    control = stopForDataIssue(
      store,
      control,
      "DATA_SETTLEMENT_FAILURE",
      { activeFailures: failures.length, maxFailureCount },
      nowMs
    );
  } else if (staleExchangeState > 0) {
    control = stopForDataIssue(
      store,
      control,
      "DATA_PENDING_STALE",
      { staleExchangeState },
      nowMs
    );
  }

  const latest = store.getLatestEquitySnapshot(experiment.experimentId);
  const refreshEquity = config.app.global.previewMode && (
    options.forceEquityRefresh
    || !latest
    || nowMs - latest.observedAt >= EQUITY_REFRESH_MS
  );
  let equity = latest ? snapshotAssessment(latest) : null;
  if (refreshEquity) {
    equity = await assessLiquidationEquity(
      config,
      store,
      latest?.peakEquityUsd
    );
    store.recordEquitySnapshot({
      experimentId: experiment.experimentId,
      accountId: experiment.accountId,
      observedAt: nowMs,
      cashUsd: equity.cashUsd,
      liquidationValueUsd: equity.liquidationValueUsd,
      equityUsd: equity.equityUsd,
      openCostUsd: equity.openCostUsd,
      quoteCoverage: equity.quoteCoverage,
      drawdownPct: equity.drawdownPct,
      peakEquityUsd: equity.peakEquityUsd,
      missingTokenCount: equity.missingTokenIds.length,
    });
  }

  if (equity && equity.quoteCoverage < 1) dataIssues.push("liquidation_quote_gap");
  if (
    equity
    && equity.drawdownPct >= MAX_LIQUIDATION_DRAWDOWN_PCT
    && control.state === "ACTIVE"
  ) {
    control = store.setExperimentControl({
      experimentId: experiment.experimentId,
      state: "SETTLE_ONLY",
      reasonCode: "RISK_MAX_LIQUIDATION_DRAWDOWN",
      details: {
        drawdownPct: equity.drawdownPct,
        equityUsd: equity.equityUsd,
        quoteCoverage: equity.quoteCoverage,
      },
      triggeredAt: nowMs,
    });
  }

  const dataHealthy = dataIssues.length === 0;
  if (
    control.state === "QUARANTINED"
    && control.reasonCode?.startsWith("DATA_")
    && control.reasonCode !== "DATA_CAPACITY_LOW"
  ) {
    control = dataHealthy
      ? (control.healthySince === null
          ? store.markExperimentDataHealthy({
              experimentId: experiment.experimentId,
              healthyAt: nowMs,
            })
          : control)
      : store.markExperimentDataUnhealthy({
          experimentId: experiment.experimentId,
          observedAt: nowMs,
        });
  }

  return {
    control,
    equity,
    capitalDeltaUsd,
    activeSettlementFailures: failures.length,
    staleExchangeState,
    dataIssues,
  };
}
