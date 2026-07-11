import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { CopyPriceMode } from "../config/types.js";
import {
  canonicalDecisionConfigJson,
  configSha256,
  newExperimentId,
  type ExperimentManifestInput,
  type ExperimentManifestRow,
  type ExperimentStateSnapshot,
} from "../experiments/manifest.js";
import {
  normalizedPayloadJson,
  payloadSha256,
  type DecisionAction,
  type DecisionRow,
  type DecisionReasonCode,
  type RawEventRow,
  type RawEventObservationRow,
} from "../experiments/provenance.js";

const DEFAULT_DB = "data/polymirror.db";
export const FILL_RECONCILIATION_WINDOW_MS = 24 * 60 * 60_000;
export const STATE_SCHEMA_VERSION = 10;

export type AuditAction = "DETECT" | "SKIP" | "COPY" | "ERROR" | "REDEEM";
export interface DecisionObservationRef { rawEventId: string; observationId: number }

export type RawEventOccurrenceStatus = "NEW" | "RESUMABLE" | "DECIDED";

export interface RawEventOccurrenceResult {
  status: RawEventOccurrenceStatus;
  rawEvent: RawEventRow;
  observationRef: Readonly<DecisionObservationRef>;
  terminalDecisionId: string | null;
}

export interface PollHourlyStatsRow {
  experimentId: string;
  accountId: string;
  hourStart: number;
  pollCount: number;
  fetchedOccurrences: number;
  uniqueObservations: number;
  resumedObservations: number;
  duplicateSuppressed: number;
  pollErrors: number;
  copied: number;
  skipped: number;
  firstPollAt: number;
  lastPollAt: number;
}

export interface RecordPollHourlyStatsInput {
  experimentId?: string;
  accountId?: string;
  observedAt?: number;
  fetchedOccurrences: number;
  uniqueObservations: number;
  resumedObservations: number;
  duplicateSuppressed: number;
  pollErrors: number;
  copied?: number;
  skipped?: number;
}

export interface SettlementFailureRow {
  experimentId: string;
  accountId: string;
  leaderId: string;
  conditionId: string;
  slug: string | null;
  errorCode: string;
  errorMessage: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  resolvedAt: number | null;
}

export interface RecordSettlementFailureInput {
  experimentId?: string;
  accountId?: string;
  leaderId: string;
  conditionId: string;
  slug?: string;
  errorCode: string;
  errorMessage: string;
  observedAt?: number;
}

export interface ResolveSettlementFailureInput {
  experimentId?: string;
  accountId?: string;
  leaderId: string;
  conditionId: string;
  resolvedAt?: number;
}

export type ExperimentCopyState = "ACTIVE" | "SETTLE_ONLY" | "QUARANTINED";

export interface ExperimentControlRow {
  experimentId: string;
  state: ExperimentCopyState;
  reasonCode: string | null;
  details: Record<string, unknown>;
  triggeredAt: number | null;
  healthySince: number | null;
  reviewedAt: number | null;
}

export interface ExperimentControlAuditRow {
  auditId: number;
  experimentId: string;
  fromState: ExperimentCopyState;
  toState: ExperimentCopyState;
  reasonCode: string;
  details: Record<string, unknown>;
  occurredAt: number;
  reviewedAt: number | null;
}

export interface SetExperimentControlInput {
  experimentId?: string;
  state: Exclude<ExperimentCopyState, "ACTIVE">;
  reasonCode: string;
  details?: Record<string, unknown>;
  triggeredAt?: number;
}

export interface MarkExperimentDataHealthyInput {
  experimentId?: string;
  healthyAt?: number;
}

export interface MarkExperimentDataUnhealthyInput {
  experimentId?: string;
  observedAt?: number;
}

export interface ReactivateQuarantinedExperimentInput {
  experimentId?: string;
  reviewedAt: number;
  details?: Record<string, unknown>;
}

export interface EquitySnapshotRow {
  experimentId: string;
  accountId: string;
  hourStart: number;
  cashUsd: number;
  liquidationValueUsd: number;
  equityUsd: number;
  openCostUsd: number;
  quoteCoverage: number;
  drawdownPct: number;
  peakEquityUsd: number;
  missingTokenCount: number;
  observedAt: number;
}

export interface RecordEquitySnapshotInput {
  experimentId?: string;
  accountId?: string;
  observedAt?: number;
  cashUsd: number;
  liquidationValueUsd: number;
  equityUsd: number;
  openCostUsd: number;
  quoteCoverage: number;
  drawdownPct: number;
  peakEquityUsd: number;
  missingTokenCount: number;
}

export interface PendingOrderRow {
  orderId: string;
  leaderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  filledShares: number;
  filledUsd: number;
  feeUsd: number;
  leaderPrice: number | null;
  executablePrice: number | null;
  slippagePct: number | null;
  tradeKey: string;
  reasoning: string;
  createdAt: number;
  updatedAt: number;
  reconciliationOnly: boolean;
  reconciliationStartedAt: number | null;
  decisionTerms: Record<string, unknown>;
}

export interface LiveOrderIntentRow {
  intentId: string;
  leaderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  leaderPrice: number | null;
  executablePrice: number | null;
  slippagePct: number | null;
  size: number;
  tradeKeys: string[];
  reasoning: string;
  market?: TokenMarketEntry;
  createdAt: number;
  updatedAt: number;
  reconciliationOnly: boolean;
  reconciliationUntil: number;
  decisionTerms: Record<string, unknown>;
}

export interface AuditLogRow {
  id: number;
  ts: number;
  leaderId: string | null;
  action: AuditAction;
  tokenId: string | null;
  side: string | null;
  size: number | null;
  price: number | null;
  leaderPrice: number | null;
  executablePrice: number | null;
  slippagePct: number | null;
  feeUsd: number;
  reason: string | null;
  preview: boolean;
  decisionId: string | null;
}

export interface PositionRow {
  leaderId: string;
  tokenId: string;
  shares: number;
  avgEntryPrice: number;
}

export interface PositionWithMarketRow extends PositionRow {
  conditionId: string;
  title: string | null;
  slug: string | null;
  outcome: string | null;
}

export interface OpenConditionRow {
  leaderId: string;
  conditionId: string;
  title: string | null;
  slug: string | null;
  positionCount: number;
  costUsd: number;
}

export interface TokenMarketEntry {
  tokenId: string;
  conditionId: string;
  title?: string;
  slug?: string;
  outcome?: string;
}

export interface SettleConditionEntry {
  leaderId: string;
  conditionId: string;
  winnerTokenIds: string[];
  sourceKeys?: string[];
  cashInitialUsd?: number;
  title?: string;
  slug?: string;
  preview: boolean;
}

export interface SettleConditionResult {
  closedPositions: number;
  payoutUsd: number;
  costUsd: number;
  realizedPnl: number;
}

export interface RecordRedeemSettlementEntry {
  tradeKey: string;
  leaderId: string;
  tokenId: string;
  payoutUsd: number;
  preview: boolean;
  cashInitialUsd?: number;
  auditReason?: string;
  exactTerms?: Record<string, unknown>;
}

export interface CopyFillResult {
  appliedShares: number;
  realizedPnl: number;
}

export interface DailyStatsRow {
  date: string;
  volumeUsd: number;
  realizedPnl: number;
  copyCount: number;
  killSwitch: number;
}

export interface LeaderDailyStatsRow {
  leaderId: string;
  volumeUsd: number;
}

export interface EnsureCopyPriceModeResult {
  mode: CopyPriceMode;
  status: "bound" | "matched" | "mismatch";
}

export interface CopyPriceModeCompatibilityResult {
  mode: CopyPriceMode;
  status: "unbound" | "matched" | "mismatch";
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function requiredAggregateKey(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

const DATA_HEALTHY_WINDOW_MS = 60 * 60_000;

function assertFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

type DecisionSlotPhase = "DETECT" | "PROGRESS" | "TERMINAL";

function decisionSlotPhase(
  action: DecisionAction,
  exactTerms: Record<string, unknown>
): DecisionSlotPhase {
  if (action === "DETECT") return "DETECT";
  if (action === "COPY" || action === "SELL") {
    const pendingRemaining = exactTerms.pendingRemaining;
    if (typeof pendingRemaining === "number" && Number.isFinite(pendingRemaining)) {
      return pendingRemaining > 1e-9 ? "PROGRESS" : "TERMINAL";
    }
    const requestedShares = exactTerms.requestedShares;
    const filledShares = exactTerms.filledShares;
    if (typeof requestedShares === "number" && Number.isFinite(requestedShares)
      && typeof filledShares === "number" && Number.isFinite(filledShares)
      && filledShares + 1e-9 < requestedShares) {
      return "PROGRESS";
    }
  }
  return "TERMINAL";
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundCashUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundAccounting(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function uniqueTradeKeys(keys: string[]): string[] {
  return [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
}

function makeLiveOrderIntentId(leaderId: string, tradeKeys: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ leaderId, tradeKeys: uniqueTradeKeys(tradeKeys) }))
    .digest("hex")
    .slice(0, 32);
}

function appliedFillUsd(
  side: "BUY" | "SELL",
  requestedShares: number,
  reportedUsd: number,
  appliedShares: number,
  price: number
): number {
  if (side === "BUY") return reportedUsd;
  if (appliedShares <= 0) return 0;
  if (requestedShares > 0 && Number.isFinite(reportedUsd)) {
    return reportedUsd * (appliedShares / requestedShares);
  }
  return appliedShares * price;
}

function appliedFeeUsd(
  side: "BUY" | "SELL",
  requestedShares: number,
  reportedFeeUsd: number,
  appliedShares: number
): number {
  if (side === "BUY") return reportedFeeUsd;
  if (appliedShares <= 0 || reportedFeeUsd <= 0) return 0;
  return requestedShares > 0 ? reportedFeeUsd * (appliedShares / requestedShares) : 0;
}

function feeAdjustedPrice(
  side: "BUY" | "SELL",
  shares: number,
  notionalUsd: number,
  feeUsd: number,
  fallback: number
): number {
  if (shares <= 0 || notionalUsd <= 0) return fallback;
  const cashUsd = side === "BUY" ? notionalUsd + feeUsd : Math.max(0, notionalUsd - feeUsd);
  return cashUsd / shares;
}

export function stableSkipReasonCode(reason: string | undefined): DecisionReasonCode {
  const value = reason?.toLowerCase() ?? "";
  if (value === "already seen") return "already_seen";
  if (value.includes("unsupported") || value.includes("incomplete")) return "unsupported_or_incomplete_activity";
  if (value.includes("below") && value.includes("size")) return "below_minimum_activity_size";
  if (value.includes("stale")) return "stale_activity";
  if (value.includes("no local")) return "no_local_position";
  if (value.includes("on-chain redeem failed")) return "onchain_redeem_failed";
  if (value.includes("missing") && value.includes("token")) return "missing_redeem_token";
  if (value.includes("price")) return "price_filter";
  if (value.includes("cash")) return "cash_limit";
  if (value.includes("position")) return "position_limit";
  return "policy_skip";
}

function parseMarketJson(value: string | null): TokenMarketEntry | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<TokenMarketEntry>;
    if (!parsed.tokenId || !parsed.conditionId) return undefined;
    return {
      tokenId: parsed.tokenId,
      conditionId: parsed.conditionId,
      title: parsed.title,
      slug: parsed.slug,
      outcome: parsed.outcome,
    };
  } catch {
    return undefined;
  }
}

function hasTable(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function hasRows(db: Database.Database, table: string, where = ""): boolean {
  return hasTable(db, table) && db.prepare(`SELECT 1 FROM ${table}${where} LIMIT 1`).get() !== undefined;
}

function legacyCopyPriceModeState(db: Database.Database): boolean {
  return (
    hasRows(db, "positions") ||
    hasRows(db, "seen_trades") ||
    hasRows(db, "cash_ledger") ||
    hasRows(
      db,
      "daily_stats",
      " WHERE volume_usd <> 0 OR realized_pnl <> 0 OR copy_count <> 0 OR kill_switch <> 0"
    ) ||
    hasRows(db, "leader_daily_stats", " WHERE volume_usd <> 0") ||
    hasRows(db, "buy_dedup") ||
    hasRows(db, "pending_orders") ||
    hasRows(db, "live_order_intents") ||
    hasRows(db, "audit_log", " WHERE action IN ('COPY', 'REDEEM')")
  );
}

function copyPriceModeCompatibility(
  db: Database.Database,
  requested: CopyPriceMode
): CopyPriceModeCompatibilityResult {
  const existing = hasTable(db, "runtime_metadata")
    ? (db
        .prepare("SELECT value FROM runtime_metadata WHERE key = 'copy_price_mode'")
        .get() as { value: CopyPriceMode } | undefined)
    : undefined;
  if (existing) {
    return {
      mode: existing.value,
      status: existing.value === requested ? "matched" : "mismatch",
    };
  }

  if (legacyCopyPriceModeState(db)) {
    return {
      mode: "leader_limit",
      status: requested === "leader_limit" ? "matched" : "mismatch",
    };
  }

  return { mode: requested, status: "unbound" };
}

export class StateStore {
  private db: Database.Database;
  private decisionRawEventIds: string[] = [];
  private latestObservationIdByRawEventId = new Map<string, number>();
  private decisionObservationRefs: DecisionObservationRef[] = [];

  constructor(path = DEFAULT_DB) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_trades (
        key TEXT PRIMARY KEY,
        leader_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS positions (
        leader_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        shares REAL NOT NULL DEFAULT 0,
        avg_entry_price REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (leader_id, token_id)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        leader_id TEXT,
        action TEXT NOT NULL,
        token_id TEXT,
        side TEXT,
        size REAL,
        price REAL,
        leader_price REAL,
        executable_price REAL,
        slippage_pct REAL,
        fee_usd REAL NOT NULL DEFAULT 0,
        reason TEXT,
        preview INTEGER NOT NULL DEFAULT 1
        ,experiment_id TEXT
        ,decision_id TEXT REFERENCES decisions(decision_id)
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action_reason ON audit_log(action, reason);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action_id ON audit_log(action, id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_ts_action ON audit_log(ts, action);
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        volume_usd REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,
        copy_count INTEGER NOT NULL DEFAULT 0,
        kill_switch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS leader_daily_stats (
        date TEXT NOT NULL,
        leader_id TEXT NOT NULL,
        volume_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (date, leader_id)
      );
      CREATE TABLE IF NOT EXISTS buy_dedup (
        leader_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_buy_dedup ON buy_dedup(leader_id, token_id, created_at);
      CREATE TABLE IF NOT EXISTS pending_orders (
        order_id TEXT PRIMARY KEY,
        leader_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        filled_shares REAL NOT NULL DEFAULT 0,
        filled_usd REAL NOT NULL DEFAULT 0,
        fee_usd REAL NOT NULL DEFAULT 0,
        leader_price REAL,
        executable_price REAL,
        slippage_pct REAL,
        trade_key TEXT NOT NULL,
        reasoning TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reconciliation_only INTEGER NOT NULL DEFAULT 0,
        reconciliation_started_at INTEGER,
        observation_refs_json TEXT NOT NULL DEFAULT '[]',
        decision_terms_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_pending_orders_leader ON pending_orders(leader_id);
      CREATE TABLE IF NOT EXISTS live_order_intents (
        intent_id TEXT PRIMARY KEY,
        leader_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        leader_price REAL,
        executable_price REAL,
        slippage_pct REAL,
        size REAL NOT NULL,
        trade_keys TEXT NOT NULL,
        reasoning TEXT NOT NULL DEFAULT '',
        market_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reconciliation_only INTEGER NOT NULL DEFAULT 0,
        reconciliation_until INTEGER NOT NULL,
        observation_refs_json TEXT NOT NULL DEFAULT '[]',
        decision_terms_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_live_order_intents_created ON live_order_intents(created_at);
      CREATE TABLE IF NOT EXISTS cash_ledger (
        scope TEXT PRIMARY KEY,
        cash_usd REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS token_markets (
        token_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        title TEXT,
        slug TEXT,
        outcome TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_token_markets_condition ON token_markets(condition_id);
      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiments (
        experiment_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        candidate_addresses_json TEXT NOT NULL,
        canonical_config_json TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        git_sha TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        lockfile_hash TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        sealed_at INTEGER,
        trust_class TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ACTIVE',
        previous_experiment_id TEXT
        ,start_state_json TEXT NOT NULL DEFAULT '{"cashUsd":0,"positions":[],"realizedPnlUsd":0}'
        ,end_state_json TEXT
        ,archive_status TEXT NOT NULL DEFAULT 'NONE'
        ,archive_error TEXT
      );
      CREATE TRIGGER IF NOT EXISTS experiments_no_delete
        BEFORE DELETE ON experiments BEGIN SELECT RAISE(ABORT, 'experiments are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS experiments_immutable_core
        BEFORE UPDATE ON experiments
        WHEN NEW.experiment_id <> OLD.experiment_id
          OR NEW.account_id <> OLD.account_id
          OR NEW.candidate_addresses_json <> OLD.candidate_addresses_json
          OR NEW.canonical_config_json <> OLD.canonical_config_json
          OR NEW.config_hash <> OLD.config_hash
          OR NEW.git_sha <> OLD.git_sha
          OR NEW.image_digest <> OLD.image_digest
          OR NEW.lockfile_hash <> OLD.lockfile_hash
          OR NEW.schema_version <> OLD.schema_version
          OR NEW.started_at <> OLD.started_at
          OR NEW.trust_class <> OLD.trust_class
          OR NEW.start_state_json <> OLD.start_state_json
        BEGIN SELECT RAISE(ABORT, 'experiment manifest is immutable'); END;
      CREATE TABLE IF NOT EXISTS experiment_controls (
        experiment_id TEXT PRIMARY KEY REFERENCES experiments(experiment_id),
        copy_state TEXT NOT NULL CHECK(copy_state IN ('ACTIVE', 'SETTLE_ONLY', 'QUARANTINED')),
        reason_code TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        triggered_at INTEGER NOT NULL,
        healthy_since INTEGER,
        reviewed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS experiment_control_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        occurred_at INTEGER NOT NULL,
        reviewed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_experiment_control_audit_experiment
        ON experiment_control_audit(experiment_id, audit_id);
      CREATE TABLE IF NOT EXISTS raw_events (
        raw_event_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        source_id TEXT,
        payload_hash TEXT NOT NULL,
        normalized_payload_json TEXT NOT NULL,
        source_timestamp INTEGER NOT NULL,
        observed_timestamp INTEGER NOT NULL,
        UNIQUE(experiment_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_raw_events_experiment ON raw_events(experiment_id, observed_timestamp);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_payload_fallback
        ON raw_events(experiment_id, payload_hash) WHERE source_id IS NULL;
      CREATE TRIGGER IF NOT EXISTS raw_events_no_update
        BEFORE UPDATE ON raw_events BEGIN SELECT RAISE(ABORT, 'raw events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS raw_events_no_delete
        BEFORE DELETE ON raw_events BEGIN SELECT RAISE(ABORT, 'raw events are append-only'); END;
      CREATE TABLE IF NOT EXISTS raw_event_observations (
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_key TEXT,
        raw_event_id TEXT NOT NULL REFERENCES raw_events(raw_event_id),
        payload_hash TEXT NOT NULL,
        normalized_payload_json TEXT NOT NULL,
        source_timestamp INTEGER NOT NULL,
        observed_timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_raw_event_observations_event
        ON raw_event_observations(raw_event_id, observation_id);
      CREATE TRIGGER IF NOT EXISTS raw_event_observations_no_update
        BEFORE UPDATE ON raw_event_observations BEGIN SELECT RAISE(ABORT, 'raw observations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS raw_event_observations_no_delete
        BEFORE DELETE ON raw_event_observations BEGIN SELECT RAISE(ABORT, 'raw observations are append-only'); END;
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        raw_event_id TEXT NOT NULL REFERENCES raw_events(raw_event_id),
        action TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        exact_terms_json TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        decision_order INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_raw_event ON decisions(raw_event_id, decided_at);
      CREATE TABLE IF NOT EXISTS observation_decision_slots (
        observation_id INTEGER NOT NULL REFERENCES raw_event_observations(observation_id),
        decision_phase TEXT NOT NULL CHECK(decision_phase IN ('DETECT', 'TERMINAL')),
        decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (observation_id, decision_phase),
        UNIQUE (observation_id, decision_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observation_decision_slots_decision
        ON observation_decision_slots(decision_id);
      CREATE TABLE IF NOT EXISTS poll_hourly_stats (
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        account_id TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        poll_count INTEGER NOT NULL DEFAULT 0,
        fetched_occurrences INTEGER NOT NULL DEFAULT 0,
        unique_observations INTEGER NOT NULL DEFAULT 0,
        resumed_observations INTEGER NOT NULL DEFAULT 0,
        duplicate_suppressed INTEGER NOT NULL DEFAULT 0,
        poll_errors INTEGER NOT NULL DEFAULT 0,
        copied INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        first_poll_at INTEGER NOT NULL,
        last_poll_at INTEGER NOT NULL,
        PRIMARY KEY (experiment_id, account_id, hour_start)
      );
      CREATE TABLE IF NOT EXISTS settlement_failures (
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        account_id TEXT NOT NULL,
        leader_id TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        slug TEXT,
        error_code TEXT NOT NULL,
        error_message TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 1,
        resolved_at INTEGER,
        PRIMARY KEY (experiment_id, account_id, leader_id, condition_id, error_code)
      );
      CREATE INDEX IF NOT EXISTS idx_settlement_failures_active
        ON settlement_failures(experiment_id, resolved_at, last_seen_at);
      CREATE TABLE IF NOT EXISTS equity_snapshots (
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        account_id TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        cash_usd REAL NOT NULL,
        liquidation_value_usd REAL NOT NULL,
        equity_usd REAL NOT NULL,
        open_cost_usd REAL NOT NULL,
        quote_coverage REAL NOT NULL,
        drawdown_pct REAL NOT NULL,
        peak_equity_usd REAL NOT NULL,
        missing_token_count INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY (experiment_id, account_id, hour_start)
      );
      CREATE TABLE IF NOT EXISTS experiment_archives (
        experiment_id TEXT PRIMARY KEY REFERENCES experiments(experiment_id),
        snapshot_sha256 TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        archive_path TEXT,
        verified_at INTEGER,
        verification_status TEXT NOT NULL DEFAULT 'PENDING_VERIFY'
      );
      CREATE TABLE IF NOT EXISTS experiment_archive_attempts (
        attempt_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        snapshot_sha256 TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        archive_path TEXT NOT NULL,
        verified_at INTEGER,
        verification_status TEXT NOT NULL DEFAULT 'PENDING_VERIFY',
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_experiment_archive_attempts_experiment
        ON experiment_archive_attempts(experiment_id, archived_at);
      CREATE TRIGGER IF NOT EXISTS experiment_archive_attempts_no_update
        BEFORE UPDATE ON experiment_archive_attempts
        WHEN NOT (OLD.verification_status='PENDING_VERIFY' AND NEW.verification_status IN ('VERIFIED','FAILED')
          AND NEW.attempt_id=OLD.attempt_id AND NEW.experiment_id=OLD.experiment_id
          AND NEW.snapshot_sha256=OLD.snapshot_sha256 AND NEW.manifest_sha256=OLD.manifest_sha256
          AND NEW.archived_at=OLD.archived_at AND NEW.archive_path=OLD.archive_path)
        BEGIN SELECT RAISE(ABORT, 'experiment archive attempts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS experiment_archive_attempts_no_delete
        BEFORE DELETE ON experiment_archive_attempts
        BEGIN SELECT RAISE(ABORT, 'experiment archive attempts are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS experiment_archives_no_update
        BEFORE UPDATE ON experiment_archives
        WHEN NOT (OLD.verification_status='PENDING_VERIFY' AND NEW.verification_status IN ('VERIFIED','FAILED')
          AND NEW.experiment_id=OLD.experiment_id AND NEW.snapshot_sha256=OLD.snapshot_sha256
          AND NEW.manifest_sha256=OLD.manifest_sha256 AND NEW.archive_path=OLD.archive_path)
        BEGIN SELECT RAISE(ABORT, 'experiment archive records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS experiment_archives_no_delete
        BEFORE DELETE ON experiment_archives BEGIN SELECT RAISE(ABORT, 'experiment archive records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS decisions_no_update
        BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS decisions_no_delete
        BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS experiments_sealed_no_update
        BEFORE UPDATE ON experiments WHEN OLD.sealed_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'sealed experiment is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS raw_events_sealed_no_insert
        BEFORE INSERT ON raw_events WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING' FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS decisions_sealed_no_insert
        BEFORE INSERT ON decisions WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING' FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_archive_guard
        BEFORE INSERT ON audit_log WHEN NEW.experiment_id IS NOT NULL AND
          (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING' FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS positions_archive_guard_insert BEFORE INSERT ON positions
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS positions_archive_guard_update BEFORE UPDATE ON positions
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS cash_archive_guard_insert BEFORE INSERT ON cash_ledger
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS cash_archive_guard_update BEFORE UPDATE ON cash_ledger
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS stats_archive_guard_insert BEFORE INSERT ON daily_stats
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS stats_archive_guard_update BEFORE UPDATE ON daily_stats
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS seen_archive_guard_insert BEFORE INSERT ON seen_trades
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS dedup_archive_guard_insert BEFORE INSERT ON buy_dedup
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS markets_archive_guard_insert BEFORE INSERT ON token_markets
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS markets_archive_guard_update BEFORE UPDATE ON token_markets
        WHEN EXISTS(SELECT 1 FROM experiments WHERE state='ACTIVE' AND archive_status='PREPARING')
        BEGIN SELECT RAISE(ABORT, 'experiment archive is finalizing'); END;
      CREATE TRIGGER IF NOT EXISTS raw_event_observations_sealed_no_insert
        BEFORE INSERT ON raw_event_observations
        WHEN (SELECT e.sealed_at FROM raw_events r JOIN experiments e ON e.experiment_id=r.experiment_id WHERE r.raw_event_id=NEW.raw_event_id) IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'sealed experiment evidence is immutable'); END;
    `);
    this.db.transaction(() => {
      this.migrate();
      this.db.exec(`
        DROP TRIGGER IF EXISTS experiments_immutable_core;
        CREATE TRIGGER experiments_immutable_core BEFORE UPDATE ON experiments
        WHEN NEW.experiment_id <> OLD.experiment_id OR NEW.account_id <> OLD.account_id
          OR NEW.candidate_addresses_json <> OLD.candidate_addresses_json
          OR NEW.canonical_config_json <> OLD.canonical_config_json OR NEW.config_hash <> OLD.config_hash
          OR NEW.git_sha <> OLD.git_sha OR NEW.image_digest <> OLD.image_digest
          OR NEW.lockfile_hash <> OLD.lockfile_hash OR NEW.schema_version <> OLD.schema_version
          OR NEW.started_at <> OLD.started_at OR NEW.trust_class <> OLD.trust_class
          OR NEW.start_state_json <> OLD.start_state_json
          OR NEW.previous_experiment_id IS NOT OLD.previous_experiment_id
        BEGIN SELECT RAISE(ABORT, 'experiment manifest is immutable'); END;
        DROP TRIGGER IF EXISTS raw_events_sealed_no_insert;
        CREATE TRIGGER raw_events_sealed_no_insert BEFORE INSERT ON raw_events
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING' FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment evidence is immutable'); END;
        DROP TRIGGER IF EXISTS decisions_sealed_no_insert;
        CREATE TRIGGER decisions_sealed_no_insert BEFORE INSERT ON decisions
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING' FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment evidence is immutable'); END;
        DROP TRIGGER IF EXISTS raw_event_observations_sealed_no_insert;
        CREATE TRIGGER raw_event_observations_sealed_no_insert BEFORE INSERT ON raw_event_observations
        WHEN (SELECT e.sealed_at IS NOT NULL OR e.archive_status='PREPARING' FROM raw_events r
          JOIN experiments e ON e.experiment_id=r.experiment_id WHERE r.raw_event_id=NEW.raw_event_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment evidence is immutable'); END;
        DROP TRIGGER IF EXISTS experiment_archives_no_update;
        CREATE TRIGGER experiment_archives_no_update BEFORE UPDATE ON experiment_archives
        WHEN NOT (OLD.verification_status='PENDING_VERIFY' AND NEW.verification_status IN ('VERIFIED','FAILED')
          AND NEW.experiment_id=OLD.experiment_id AND NEW.snapshot_sha256=OLD.snapshot_sha256
          AND NEW.manifest_sha256=OLD.manifest_sha256 AND NEW.archive_path=OLD.archive_path)
        BEGIN SELECT RAISE(ABORT, 'experiment archive records are immutable'); END;
        DROP TRIGGER IF EXISTS experiment_archives_no_delete;
        CREATE TRIGGER experiment_archives_no_delete BEFORE DELETE ON experiment_archives
        BEGIN SELECT RAISE(ABORT, 'experiment archive records are append-only'); END;
        DROP TRIGGER IF EXISTS experiment_archive_attempts_no_update;
        CREATE TRIGGER experiment_archive_attempts_no_update BEFORE UPDATE ON experiment_archive_attempts
        WHEN NOT (OLD.verification_status='PENDING_VERIFY' AND NEW.verification_status IN ('VERIFIED','FAILED')
          AND NEW.attempt_id=OLD.attempt_id AND NEW.experiment_id=OLD.experiment_id
          AND NEW.snapshot_sha256=OLD.snapshot_sha256 AND NEW.manifest_sha256=OLD.manifest_sha256
          AND NEW.archived_at=OLD.archived_at AND NEW.archive_path=OLD.archive_path)
        BEGIN SELECT RAISE(ABORT, 'experiment archive attempts are immutable'); END;
        DROP TRIGGER IF EXISTS experiment_archive_attempts_no_delete;
        CREATE TRIGGER experiment_archive_attempts_no_delete BEFORE DELETE ON experiment_archive_attempts
        BEGIN SELECT RAISE(ABORT, 'experiment archive attempts are append-only'); END;
        DROP INDEX IF EXISTS idx_experiments_active_account;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_active_account
          ON experiments(account_id) WHERE state = 'ACTIVE' AND ended_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_event_observations_identity
          ON raw_event_observations(observation_key) WHERE observation_key IS NOT NULL;
        DROP TRIGGER IF EXISTS decision_observation_links_no_update;
        CREATE TRIGGER decision_observation_links_no_update BEFORE UPDATE ON decision_observation_links
        BEGIN SELECT RAISE(ABORT, 'decision observation links are immutable'); END;
        DROP TRIGGER IF EXISTS decision_observation_links_no_delete;
        CREATE TRIGGER decision_observation_links_no_delete BEFORE DELETE ON decision_observation_links
        BEGIN SELECT RAISE(ABORT, 'decision observation links are append-only'); END;
        DROP TRIGGER IF EXISTS decision_observation_links_sealed_no_insert;
        CREATE TRIGGER decision_observation_links_sealed_no_insert BEFORE INSERT ON decision_observation_links
        WHEN (SELECT e.sealed_at IS NOT NULL OR e.archive_status='PREPARING'
          FROM raw_event_observations o JOIN raw_events r ON r.raw_event_id=o.raw_event_id
          JOIN experiments e ON e.experiment_id=r.experiment_id WHERE o.observation_id=NEW.observation_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment evidence is immutable'); END;
        DROP TRIGGER IF EXISTS observation_decision_slots_no_update;
        CREATE TRIGGER observation_decision_slots_no_update BEFORE UPDATE ON observation_decision_slots
        BEGIN SELECT RAISE(ABORT, 'observation decision slots are immutable'); END;
        DROP TRIGGER IF EXISTS observation_decision_slots_no_delete;
        CREATE TRIGGER observation_decision_slots_no_delete BEFORE DELETE ON observation_decision_slots
        BEGIN SELECT RAISE(ABORT, 'observation decision slots are append-only'); END;
        DROP TRIGGER IF EXISTS observation_decision_slots_sealed_no_insert;
        CREATE TRIGGER observation_decision_slots_sealed_no_insert BEFORE INSERT ON observation_decision_slots
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment evidence is immutable'); END;
        DROP TRIGGER IF EXISTS experiment_controls_transition_guard;
        CREATE TRIGGER experiment_controls_transition_guard BEFORE UPDATE OF copy_state ON experiment_controls
        WHEN OLD.copy_state <> NEW.copy_state
          AND NOT (OLD.copy_state='ACTIVE' AND NEW.copy_state IN ('SETTLE_ONLY','QUARANTINED'))
          AND NOT (OLD.copy_state='QUARANTINED' AND NEW.copy_state='ACTIVE'
            AND substr(OLD.reason_code, 1, 5)='DATA_'
            AND OLD.healthy_since IS NOT NULL AND NEW.reviewed_at IS NOT NULL
            AND NEW.reviewed_at - OLD.healthy_since >= ${DATA_HEALTHY_WINDOW_MS})
        BEGIN SELECT RAISE(ABORT, 'sticky experiment control transition rejected'); END;
        DROP TRIGGER IF EXISTS experiment_controls_sealed_no_insert;
        CREATE TRIGGER experiment_controls_sealed_no_insert BEFORE INSERT ON experiment_controls
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment controls are immutable'); END;
        DROP TRIGGER IF EXISTS experiment_controls_sealed_no_update;
        CREATE TRIGGER experiment_controls_sealed_no_update BEFORE UPDATE ON experiment_controls
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment controls are immutable'); END;
        DROP TRIGGER IF EXISTS experiment_controls_no_delete;
        CREATE TRIGGER experiment_controls_no_delete BEFORE DELETE ON experiment_controls
        BEGIN SELECT RAISE(ABORT, 'experiment controls are persistent'); END;
        DROP TRIGGER IF EXISTS experiment_control_audit_sealed_no_insert;
        CREATE TRIGGER experiment_control_audit_sealed_no_insert BEFORE INSERT ON experiment_control_audit
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment controls are immutable'); END;
        DROP TRIGGER IF EXISTS experiment_control_audit_no_update;
        CREATE TRIGGER experiment_control_audit_no_update BEFORE UPDATE ON experiment_control_audit
        BEGIN SELECT RAISE(ABORT, 'experiment control audit is immutable'); END;
        DROP TRIGGER IF EXISTS experiment_control_audit_no_delete;
        CREATE TRIGGER experiment_control_audit_no_delete BEFORE DELETE ON experiment_control_audit
        BEGIN SELECT RAISE(ABORT, 'experiment control audit is append-only'); END;
        DROP TRIGGER IF EXISTS poll_hourly_stats_sealed_no_insert;
        CREATE TRIGGER poll_hourly_stats_sealed_no_insert BEFORE INSERT ON poll_hourly_stats
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment aggregates are immutable'); END;
        DROP TRIGGER IF EXISTS poll_hourly_stats_sealed_no_update;
        CREATE TRIGGER poll_hourly_stats_sealed_no_update BEFORE UPDATE ON poll_hourly_stats
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment aggregates are immutable'); END;
        DROP TRIGGER IF EXISTS poll_hourly_stats_no_delete;
        CREATE TRIGGER poll_hourly_stats_no_delete BEFORE DELETE ON poll_hourly_stats
        BEGIN SELECT RAISE(ABORT, 'poll aggregates are persistent'); END;
        DROP TRIGGER IF EXISTS settlement_failures_sealed_no_insert;
        CREATE TRIGGER settlement_failures_sealed_no_insert BEFORE INSERT ON settlement_failures
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment aggregates are immutable'); END;
        DROP TRIGGER IF EXISTS settlement_failures_sealed_no_update;
        CREATE TRIGGER settlement_failures_sealed_no_update BEFORE UPDATE ON settlement_failures
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment aggregates are immutable'); END;
        DROP TRIGGER IF EXISTS settlement_failures_no_delete;
        CREATE TRIGGER settlement_failures_no_delete BEFORE DELETE ON settlement_failures
        BEGIN SELECT RAISE(ABORT, 'settlement failure aggregates are persistent'); END;
        DROP TRIGGER IF EXISTS equity_snapshots_sealed_no_insert;
        CREATE TRIGGER equity_snapshots_sealed_no_insert BEFORE INSERT ON equity_snapshots
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment snapshots are immutable'); END;
        DROP TRIGGER IF EXISTS equity_snapshots_sealed_no_update;
        CREATE TRIGGER equity_snapshots_sealed_no_update BEFORE UPDATE ON equity_snapshots
        WHEN (SELECT sealed_at IS NOT NULL OR archive_status='PREPARING'
          FROM experiments WHERE experiment_id=NEW.experiment_id)
        BEGIN SELECT RAISE(ABORT, 'sealed experiment snapshots are immutable'); END;
        DROP TRIGGER IF EXISTS equity_snapshots_no_delete;
        CREATE TRIGGER equity_snapshots_no_delete BEFORE DELETE ON equity_snapshots
        BEGIN SELECT RAISE(ABORT, 'equity snapshots are persistent'); END;
      `);
      this.db.prepare(
        `INSERT INTO schema_metadata (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(String(STATE_SCHEMA_VERSION));
    })();
    this.reconcileOrphanPreparedExperiments();
  }

  private reconcileOrphanPreparedExperiments(now = Date.now()): void {
    this.db.prepare(`UPDATE experiment_archive_attempts
      SET verification_status='FAILED', error='interrupted archive preparation'
      WHERE verification_status='PENDING_VERIFY'
        AND experiment_id IN (SELECT experiment_id FROM experiments WHERE archive_status='PREPARING' AND sealed_at IS NULL)`)
      .run();
    this.db.prepare(`UPDATE experiments SET archive_status='FAILED',
      archive_error='interrupted archive preparation',
      end_state_json=CASE WHEN state='ACTIVE' THEN NULL ELSE end_state_json END
      WHERE archive_status='PREPARING' AND sealed_at IS NULL`).run();
    const rows = this.db.prepare(
      "SELECT experiment_id AS experimentId, previous_experiment_id AS previousExperimentId FROM experiments WHERE state = 'PREPARED'"
    ).all() as { experimentId: string; previousExperimentId: string | null }[];
    for (const row of rows) {
      if (row.previousExperimentId) {
        this.abortPreparedExperiments([row.experimentId], now);
      } else {
        this.db.prepare("UPDATE experiments SET state = 'ABORTED', ended_at = ? WHERE experiment_id = ? AND state = 'PREPARED'")
          .run(now, row.experimentId);
      }
    }
  }

  startOrResumeExperiment(input: ExperimentManifestInput, now = Date.now()): ExperimentManifestRow {
    const hash = configSha256(input.config);
    const preparing = this.db.inTransaction;
    return this.db.transaction(() => {
      const active = this.getActiveExperiment(input.accountId);
      const candidates = [...input.candidateAddresses].sort();
      const sameDecisionIdentity = active?.configHash === hash
        && active.canonicalConfigJson === canonicalDecisionConfigJson(input.config)
        && JSON.stringify(active.candidateAddresses) === JSON.stringify(candidates)
        && active.schemaVersion === STATE_SCHEMA_VERSION
        && active.trustClass === input.trustClass;
      const sameIdentity = sameDecisionIdentity
        && active.gitSha === input.gitSha
        && active.imageDigest === input.imageDigest
        && active.lockfileHash === input.lockfileHash;
      if (sameIdentity) {
        this.consumePendingLegacyKillSwitch(active!);
        return this.getExperiment(active!.experimentId)!;
      }
      const buildOnlyRotation = Boolean(active && sameDecisionIdentity);
      const inheritedControl = buildOnlyRotation
        ? this.readExperimentControl(active!.experimentId)
        : undefined;
      if (active) {
        const pending = this.db.prepare("SELECT COUNT(*) AS count FROM pending_orders").get() as { count: number };
        if (pending.count > 0) {
          throw new Error(`experiment rotation blocked by ${pending.count} unresolved pending order(s)`);
        }
        const intents = this.db.prepare("SELECT COUNT(*) AS count FROM live_order_intents").get() as { count: number };
        if (intents.count > 0) {
          throw new Error(`experiment rotation blocked by ${intents.count} unresolved live order intent(s)`);
        }
      }
      const newStartState = this.captureExperimentState(
        input.config.app.global.risk.startingCapitalUsd
      );
      if (active && !preparing) {
        const previousConfig = JSON.parse(active.canonicalConfigJson) as {
          app?: { global?: { risk?: { startingCapitalUsd?: number } } };
        };
        const previousInitial = previousConfig.app?.global?.risk?.startingCapitalUsd;
        if (typeof previousInitial !== "number" || !Number.isFinite(previousInitial)) {
          throw new Error("active experiment has invalid starting capital");
        }
        const oldEndState = this.captureExperimentState(previousInitial);
        this.db.prepare(
          "UPDATE experiments SET state = 'ENDED', ended_at = ?, end_state_json = ? WHERE experiment_id = ?"
        ).run(now, normalizedPayloadJson(oldEndState), active.experimentId);
      }
      const experimentId = newExperimentId(input.accountId, hash);
      this.db.prepare(
        `INSERT INTO experiments
         (experiment_id, account_id, candidate_addresses_json, canonical_config_json,
          config_hash, git_sha, image_digest, lockfile_hash, schema_version,
          started_at, trust_class, state, previous_experiment_id, start_state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        experimentId,
        input.accountId,
        JSON.stringify(candidates),
        canonicalDecisionConfigJson(input.config),
        hash,
        input.gitSha,
        input.imageDigest,
        input.lockfileHash,
        STATE_SCHEMA_VERSION,
        now,
        input.trustClass,
        preparing ? "PREPARED" : "ACTIVE",
        active?.experimentId ?? null,
        normalizedPayloadJson(newStartState)
      );
      if (buildOnlyRotation) {
        this.inheritBuildOnlyRuntimeSafetyState({
          previousExperimentId: active!.experimentId,
          nextExperimentId: experimentId,
          previousControl: inheritedControl,
          occurredAt: now,
        });
      }
      const experiment = this.getExperiment(experimentId)!;
      if (experiment.state === "ACTIVE") this.consumePendingLegacyKillSwitch(experiment);
      return this.getExperiment(experimentId)!;
    })();
  }

  private inheritBuildOnlyRuntimeSafetyState(input: {
    previousExperimentId: string;
    nextExperimentId: string;
    previousControl?: ExperimentControlRow;
    occurredAt: number;
  }): void {
    const control = input.previousControl;
    if (control && control.state !== "ACTIVE") {
      if (!control.reasonCode || control.triggeredAt === null) {
        throw new Error("non-active experiment control is incomplete");
      }
      const inherited = this.db.prepare(
        `INSERT INTO experiment_controls
         (experiment_id, copy_state, reason_code, details_json, triggered_at,
          healthy_since, reviewed_at)
         SELECT ?, copy_state, reason_code, details_json, triggered_at, NULL, NULL
         FROM experiment_controls
         WHERE experiment_id = ? AND copy_state <> 'ACTIVE'`
      ).run(
        input.nextExperimentId,
        input.previousExperimentId
      );
      if (inherited.changes !== 1) {
        throw new Error("failed to inherit non-active experiment control");
      }
      this.insertExperimentControlAudit({
        experimentId: input.nextExperimentId,
        fromState: control.state,
        toState: control.state,
        reasonCode: control.reasonCode,
        details: {
          event: "BUILD_PROVENANCE_CONTROL_INHERITED",
          fromExperimentId: input.previousExperimentId,
        },
        occurredAt: input.occurredAt,
        reviewedAt: null,
      });
    }
    this.db.prepare(
      `INSERT INTO settlement_failures
       (experiment_id, account_id, leader_id, condition_id, slug, error_code,
        error_message, first_seen_at, last_seen_at, failure_count, resolved_at)
       SELECT ?, account_id, leader_id, condition_id, slug, error_code,
              error_message, first_seen_at, last_seen_at, failure_count, NULL
       FROM settlement_failures
       WHERE experiment_id = ? AND resolved_at IS NULL`
    ).run(input.nextExperimentId, input.previousExperimentId);
  }

  getExperiment(experimentId: string): ExperimentManifestRow | undefined {
    const row = this.db.prepare(
      `SELECT experiment_id AS experimentId, account_id AS accountId,
              candidate_addresses_json AS candidateAddressesJson,
              canonical_config_json AS canonicalConfigJson, config_hash AS configHash,
              git_sha AS gitSha, image_digest AS imageDigest, lockfile_hash AS lockfileHash,
              schema_version AS schemaVersion, started_at AS startedAt, ended_at AS endedAt,
              sealed_at AS sealedAt, trust_class AS trustClass
              , state, previous_experiment_id AS previousExperimentId
              , start_state_json AS startStateJson, end_state_json AS endStateJson,
              archive_status AS archiveStatus, archive_error AS archiveError
       FROM experiments WHERE experiment_id = ?`
    ).get(experimentId) as (Omit<ExperimentManifestRow, "candidateAddresses" | "startState" | "endState"> & { candidateAddressesJson: string; startStateJson: string; endStateJson: string | null }) | undefined;
    if (!row) return undefined;
    const { candidateAddressesJson, startStateJson, endStateJson, ...rest } = row;
    return { ...rest, candidateAddresses: JSON.parse(candidateAddressesJson) as string[],
      startState: JSON.parse(startStateJson) as ExperimentStateSnapshot,
      endState: endStateJson ? JSON.parse(endStateJson) as ExperimentStateSnapshot : null };
  }

  getActiveExperiment(accountId?: string): ExperimentManifestRow | undefined {
    const row = this.db.prepare(
      `SELECT experiment_id AS experimentId FROM experiments
       WHERE state = 'ACTIVE' AND ended_at IS NULL AND (? IS NULL OR account_id = ?) ORDER BY started_at DESC LIMIT 1`
    ).get(accountId ?? null, accountId ?? null) as { experimentId: string } | undefined;
    return row ? this.getExperiment(row.experimentId) : undefined;
  }

  captureExperimentState(initialCashUsd: number): ExperimentStateSnapshot {
    const cash = this.db.prepare("SELECT cash_usd AS cashUsd FROM cash_ledger WHERE scope='preview'").get() as { cashUsd: number } | undefined;
    const positions = this.db.prepare(`SELECT leader_id AS leaderId, token_id AS tokenId, shares,
      avg_entry_price AS avgEntryPrice FROM positions WHERE ABS(shares)>1e-12 ORDER BY leader_id, token_id`).all() as ExperimentStateSnapshot["positions"];
    const pnl = this.db.prepare("SELECT COALESCE(SUM(realized_pnl), 0) AS realizedPnlUsd FROM daily_stats").get() as { realizedPnlUsd: number };
    return { cashUsd: cash?.cashUsd ?? initialCashUsd, positions, realizedPnlUsd: pnl.realizedPnlUsd };
  }

  listExperiments(): ExperimentManifestRow[] {
    const ids = this.db.prepare(
      "SELECT experiment_id AS experimentId FROM experiments ORDER BY started_at, experiment_id"
    ).all() as { experimentId: string }[];
    return ids.map((row) => this.getExperiment(row.experimentId)!);
  }

  finalizePreparedExperiments(experimentIds: string[], now = Date.now()): void {
    if (experimentIds.length === 0) return;
    this.db.transaction(() => {
      for (const experimentId of experimentIds) {
        const row = this.db.prepare(
          `SELECT experiment_id AS experimentId, previous_experiment_id AS previousExperimentId
           FROM experiments WHERE experiment_id = ? AND state = 'PREPARED'`
        ).get(experimentId) as { experimentId: string; previousExperimentId: string | null } | undefined;
        if (!row) continue;
        if (row.previousExperimentId) {
          const previous = this.db.prepare(
            "SELECT canonical_config_json AS configJson FROM experiments WHERE experiment_id = ?"
          ).get(row.previousExperimentId) as { configJson: string } | undefined;
          const previousConfig = JSON.parse(previous?.configJson ?? "null") as {
            app?: { global?: { risk?: { startingCapitalUsd?: number } } };
          } | null;
          const previousInitial = previousConfig?.app?.global?.risk?.startingCapitalUsd;
          if (typeof previousInitial !== "number" || !Number.isFinite(previousInitial)) {
            throw new Error("previous experiment has invalid starting capital");
          }
          const oldEndState = this.captureExperimentState(previousInitial);
          this.db.prepare(
            `UPDATE experiments SET state = 'ENDED', ended_at = ?, end_state_json = ?
             WHERE experiment_id = ? AND state = 'ACTIVE'`
          ).run(now, normalizedPayloadJson(oldEndState), row.previousExperimentId);
        }
        this.db.prepare("UPDATE experiments SET state = 'ACTIVE' WHERE experiment_id = ? AND state = 'PREPARED'")
          .run(row.experimentId);
        const activated = this.getExperiment(row.experimentId);
        if (activated) this.consumePendingLegacyKillSwitch(activated);
      }
    })();
  }

  abortPreparedExperiments(experimentIds: string[], now = Date.now()): void {
    if (experimentIds.length === 0) return;
    this.db.transaction(() => {
      for (const experimentId of experimentIds) {
        const row = this.db.prepare(
          `SELECT experiment_id AS experimentId, previous_experiment_id AS previousExperimentId
           FROM experiments WHERE experiment_id = ? AND state IN ('PREPARED', 'ACTIVE') AND previous_experiment_id IS NOT NULL`
        ).get(experimentId) as { experimentId: string; previousExperimentId: string } | undefined;
        if (!row) continue;
        this.db.prepare("UPDATE experiments SET state = 'ABORTED', ended_at = ? WHERE experiment_id = ?")
          .run(now, row.experimentId);
        this.db.prepare(
          "UPDATE experiments SET state = 'ACTIVE', ended_at = NULL, end_state_json = NULL WHERE experiment_id = ?"
        )
          .run(row.previousExperimentId);
      }
    })();
  }

  recordRawEvent(input: {
    sourceId?: string;
    payload: unknown;
    sourceTimestamp: number;
    observedTimestamp?: number;
    experimentId?: string;
  }): RawEventRow {
    return this.recordRawEventOccurrence(input).rawEvent;
  }

  recordRawEventOccurrence(input: {
    sourceId?: string;
    payload: unknown;
    sourceTimestamp: number;
    observedTimestamp?: number;
    experimentId?: string;
  }): RawEventOccurrenceResult {
    return this.db.transaction((): RawEventOccurrenceResult => {
      const experiment = input.experimentId
        ? this.getExperiment(input.experimentId)
        : this.getActiveExperiment();
      if (!experiment) throw new Error("Cannot record raw event without an active experiment");
      const payloadHash = payloadSha256(input.payload);
      const payloadJson = normalizedPayloadJson(input.payload);
      const sourceId = input.sourceId?.trim() || null;
      const identity = sourceId ? `source:${sourceId}` : `payload:${payloadHash}`;
      const rawEventId = createHash("sha256")
        .update(`${experiment.experimentId}\n${identity}`)
        .digest("hex");
      const observedTimestamp = input.observedTimestamp ?? Date.now();
      this.db.prepare(
        `INSERT OR IGNORE INTO raw_events
         (raw_event_id, experiment_id, source_id, payload_hash, normalized_payload_json,
          source_timestamp, observed_timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rawEventId,
        experiment.experimentId,
        sourceId,
        payloadHash,
        payloadJson,
        input.sourceTimestamp,
        observedTimestamp
      );
      const row = sourceId
        ? this.db.prepare("SELECT raw_event_id AS rawEventId FROM raw_events WHERE experiment_id = ? AND source_id = ?")
            .get(experiment.experimentId, sourceId) as { rawEventId: string }
        : this.db.prepare("SELECT raw_event_id AS rawEventId FROM raw_events WHERE experiment_id = ? AND payload_hash = ?")
            .get(experiment.experimentId, payloadHash) as { rawEventId: string };
      const observationKey = createHash("sha256")
        .update([row.rawEventId, payloadHash, input.sourceTimestamp].join("\n"))
        .digest("hex");
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO raw_event_observations
         (observation_key, raw_event_id, payload_hash, normalized_payload_json, source_timestamp, observed_timestamp)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM raw_event_observations
           WHERE raw_event_id = ? AND payload_hash = ? AND source_timestamp = ?
         )`
      ).run(
        observationKey,
        row.rawEventId,
        payloadHash,
        payloadJson,
        input.sourceTimestamp,
        observedTimestamp,
        row.rawEventId,
        payloadHash,
        input.sourceTimestamp
      );
      const observation = this.db.prepare(
        `SELECT observation_id AS observationId FROM raw_event_observations
         WHERE raw_event_id = ? AND payload_hash = ? AND source_timestamp = ?
         ORDER BY observation_id LIMIT 1`
      ).get(row.rawEventId, payloadHash, input.sourceTimestamp) as { observationId: number } | undefined;
      if (!observation) throw new Error(`Raw observation persistence failed: ${row.rawEventId}`);
      this.latestObservationIdByRawEventId.set(row.rawEventId, observation.observationId);
      const observationRef = Object.freeze({
        rawEventId: row.rawEventId,
        observationId: observation.observationId,
      });
      const terminal = this.db.prepare(
        `SELECT decision_id AS decisionId FROM observation_decision_slots
         WHERE observation_id = ? AND decision_phase = 'TERMINAL'`
      ).get(observation.observationId) as { decisionId: string } | undefined;
      return {
        status: inserted.changes > 0 ? "NEW" : terminal ? "DECIDED" : "RESUMABLE",
        rawEvent: this.getRawEvent(row.rawEventId)!,
        observationRef,
        terminalDecisionId: terminal?.decisionId ?? null,
      };
    })();
  }

  private getRawEvent(rawEventId: string): RawEventRow | undefined {
    const row = this.db.prepare(
      `SELECT raw_event_id AS rawEventId, experiment_id AS experimentId, source_id AS sourceId,
              payload_hash AS payloadHash, normalized_payload_json AS payloadJson,
              source_timestamp AS sourceTimestamp, observed_timestamp AS observedTimestamp
       FROM raw_events WHERE raw_event_id = ?`
    ).get(rawEventId) as (Omit<RawEventRow, "payload"> & { payloadJson: string }) | undefined;
    if (!row) return undefined;
    const { payloadJson, ...rest } = row;
    return { ...rest, payload: JSON.parse(payloadJson) };
  }

  listRawEvents(): RawEventRow[] {
    const ids = this.db.prepare(
      "SELECT raw_event_id AS rawEventId FROM raw_events ORDER BY observed_timestamp, raw_event_id"
    ).all() as { rawEventId: string }[];
    return ids.map((row) => this.getRawEvent(row.rawEventId)!);
  }

  listRawEventObservations(rawEventId: string): RawEventObservationRow[] {
    const rows = this.db.prepare(
      `SELECT observation_id AS observationId, observation_key AS observationKey,
              raw_event_id AS rawEventId,
              payload_hash AS payloadHash, normalized_payload_json AS payloadJson,
              source_timestamp AS sourceTimestamp, observed_timestamp AS observedTimestamp
       FROM raw_event_observations WHERE raw_event_id = ? ORDER BY observation_id`
    ).all(rawEventId) as Array<Omit<RawEventObservationRow, "payload"> & { payloadJson: string }>;
    return rows.map(({ payloadJson, ...row }) => ({
      ...row,
      payload: JSON.parse(payloadJson),
    }));
  }

  recordDecision(input: {
    rawEventId: string;
    action: DecisionAction;
    reasonCode: DecisionReasonCode;
    exactTerms: Record<string, unknown>;
    decidedAt?: number;
    observationRefs?: DecisionObservationRef[];
  }): DecisionRow {
    const raw = this.getRawEvent(input.rawEventId);
    if (!raw) throw new Error(`Raw event not found: ${input.rawEventId}`);
    const contextRefs = input.observationRefs
      ?? this.decisionObservationRefs.filter((ref) => ref.rawEventId === raw.rawEventId);
    const fallbackObservationId = this.latestObservationIdByRawEventId.get(raw.rawEventId)
      ?? (this.db.prepare(
        "SELECT observation_id AS observationId FROM raw_event_observations WHERE raw_event_id = ? ORDER BY observation_id DESC LIMIT 1"
      ).get(raw.rawEventId) as { observationId: number } | undefined)?.observationId;
    const observationRefs = contextRefs.length > 0
      ? contextRefs
      : fallbackObservationId === undefined ? [] : [fallbackObservationId];
    const normalizedRefs = observationRefs.map((ref) => typeof ref === "number"
      ? { rawEventId: raw.rawEventId, observationId: ref }
      : ref);
    if (normalizedRefs.length === 0) throw new Error(`Cannot record decision without raw observation context: ${raw.rawEventId}`);
    const owner = this.db.prepare(`SELECT r.experiment_id AS experimentId
      FROM raw_event_observations o JOIN raw_events r ON r.raw_event_id=o.raw_event_id
      WHERE o.observation_id=? AND o.raw_event_id=?`);
    for (const ref of normalizedRefs) {
      const row = owner.get(ref.observationId, ref.rawEventId) as { experimentId: string } | undefined;
      if (row?.experimentId !== raw.experimentId) throw new Error("Decision observation context crosses experiments");
    }
    return this.db.transaction(() => {
      const exactTermsJson = normalizedPayloadJson(input.exactTerms);
      const decidedAt = input.decidedAt ?? Date.now();
      const decisionOrder = (this.db.prepare("SELECT COALESCE(MAX(decision_order), 0) + 1 AS next FROM decisions WHERE experiment_id=?").get(raw.experimentId) as { next: number }).next;
      const observationContext = [...normalizedRefs]
        .sort((a, b) => a.observationId - b.observationId || a.rawEventId.localeCompare(b.rawEventId))
        .map((ref) => `${ref.rawEventId}:${ref.observationId}`)
        .join("\n");
      const decisionId = createHash("sha256")
        .update([raw.experimentId, observationContext, input.action, input.reasonCode, exactTermsJson].join("\n"))
        .digest("hex");
      const decisionPhase = decisionSlotPhase(input.action, input.exactTerms);
      this.db.prepare(
        `INSERT OR IGNORE INTO decisions
         (decision_id, experiment_id, raw_event_id, action, reason_code, exact_terms_json, decided_at, decision_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        decisionId,
        raw.experimentId,
        raw.rawEventId,
        input.action,
        input.reasonCode,
        exactTermsJson,
        decidedAt,
        decisionOrder
      );
      const nextLinkOrder = this.db.prepare(
        "SELECT COALESCE(MAX(link_order), 0) + 1 AS next FROM decision_observation_links WHERE experiment_id=?"
      );
      const insertLink = this.db.prepare(
        `INSERT OR IGNORE INTO decision_observation_links
         (experiment_id, observation_id, decision_id, link_order, linked_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      const readSlot = this.db.prepare(
        `SELECT decision_id AS decisionId FROM observation_decision_slots
         WHERE observation_id = ? AND decision_phase = ?`
      );
      const insertSlot = this.db.prepare(
        `INSERT INTO observation_decision_slots
         (observation_id, decision_phase, decision_id, experiment_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const { observationId } of normalizedRefs) {
        if (decisionPhase !== "PROGRESS") {
          const slot = readSlot.get(observationId, decisionPhase) as { decisionId: string } | undefined;
          if (slot && slot.decisionId !== decisionId) {
            throw new Error(
              `${decisionPhase === "DETECT" ? "DETECT" : "terminal"} decision already exists for observation ${observationId}`
            );
          }
          if (!slot) {
            insertSlot.run(
              observationId,
              decisionPhase,
              decisionId,
              raw.experimentId,
              decidedAt
            );
          }
        }
        const linkOrder = (nextLinkOrder.get(raw.experimentId) as { next: number }).next;
        insertLink.run(raw.experimentId, observationId, decisionId, linkOrder, decidedAt);
      }
      return this.getDecision(decisionId)!;
    })();
  }

  private getDecision(decisionId: string): DecisionRow | undefined {
    const row = this.db.prepare(
      `SELECT decision_id AS decisionId, experiment_id AS experimentId,
              raw_event_id AS rawEventId, action, reason_code AS reasonCode,
              exact_terms_json AS exactTermsJson, decided_at AS decidedAt
       FROM decisions WHERE decision_id = ?`
    ).get(decisionId) as (Omit<DecisionRow, "exactTerms" | "action"> & { action: DecisionAction; exactTermsJson: string }) | undefined;
    if (!row) return undefined;
    const { exactTermsJson, ...rest } = row;
    return { ...rest, exactTerms: JSON.parse(exactTermsJson) as Record<string, unknown> };
  }

  listDecisions(): DecisionRow[] {
    const ids = this.db.prepare(
      "SELECT decision_id AS decisionId FROM decisions ORDER BY decision_order, decided_at, decision_id"
    ).all() as { decisionId: string }[];
    return ids.map((row) => this.getDecision(row.decisionId)!);
  }

  getExperimentControl(experimentId?: string): ExperimentControlRow | null {
    const experiment = experimentId
      ? this.getExperiment(experimentId)
      : this.getActiveExperiment();
    if (!experiment) return null;
    return this.readExperimentControl(experiment.experimentId) ?? {
      experimentId: experiment.experimentId,
      state: "ACTIVE",
      reasonCode: null,
      details: {},
      triggeredAt: null,
      healthySince: null,
      reviewedAt: null,
    };
  }

  setExperimentControl(input: SetExperimentControlInput): ExperimentControlRow {
    return this.db.transaction(() => {
      if (input.state !== "SETTLE_ONLY" && input.state !== "QUARANTINED") {
        throw new Error("setExperimentControl only permits ACTIVE to non-active transitions");
      }
      const triggeredAt = input.triggeredAt ?? Date.now();
      assertNonNegativeInteger("triggeredAt", triggeredAt);
      const reasonCode = requiredAggregateKey("reasonCode", input.reasonCode);
      const experiment = this.aggregateExperiment(input.experimentId);
      const current = this.getExperimentControl(experiment.experimentId)!;
      if (current.state !== "ACTIVE") {
        if (current.state === input.state && current.reasonCode === reasonCode) return current;
        throw new Error("Experiment control transition requires ACTIVE to non-active");
      }
      const details = input.details ?? {};
      const detailsJson = normalizedPayloadJson(details);
      if (this.readExperimentControl(experiment.experimentId)) {
        this.db.prepare(
          `UPDATE experiment_controls SET copy_state = ?, reason_code = ?, details_json = ?,
             triggered_at = ?, healthy_since = NULL, reviewed_at = NULL
           WHERE experiment_id = ?`
        ).run(input.state, reasonCode, detailsJson, triggeredAt, experiment.experimentId);
      } else {
        this.db.prepare(
          `INSERT INTO experiment_controls
           (experiment_id, copy_state, reason_code, details_json, triggered_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(experiment.experimentId, input.state, reasonCode, detailsJson, triggeredAt);
      }
      this.insertExperimentControlAudit({
        experimentId: experiment.experimentId,
        fromState: "ACTIVE",
        toState: input.state,
        reasonCode,
        details,
        occurredAt: triggeredAt,
        reviewedAt: null,
      });
      return this.readExperimentControl(experiment.experimentId)!;
    })();
  }

  markExperimentDataHealthy(
    input: MarkExperimentDataHealthyInput = {}
  ): ExperimentControlRow {
    const healthyAt = input.healthyAt ?? Date.now();
    assertNonNegativeInteger("healthyAt", healthyAt);
    const experiment = this.aggregateExperiment(input.experimentId);
    const control = this.readExperimentControl(experiment.experimentId);
    if (control?.state !== "QUARANTINED") {
      throw new Error("Data health can only be marked for a QUARANTINED experiment");
    }
    if (!control.reasonCode?.startsWith("DATA_")) {
      throw new Error("Only DATA_* quarantines can enter a healthy review window");
    }
    this.db.prepare(
      `UPDATE experiment_controls
       SET healthy_since = COALESCE(healthy_since, ?), reviewed_at = NULL
       WHERE experiment_id = ?`
    ).run(healthyAt, experiment.experimentId);
    return this.readExperimentControl(experiment.experimentId)!;
  }

  markExperimentDataUnhealthy(
    input: MarkExperimentDataUnhealthyInput = {}
  ): ExperimentControlRow {
    return this.db.transaction(() => {
      const observedAt = input.observedAt ?? Date.now();
      assertNonNegativeInteger("observedAt", observedAt);
      const experiment = this.aggregateExperiment(input.experimentId);
      const control = this.readExperimentControl(experiment.experimentId);
      if (control?.state !== "QUARANTINED") {
        throw new Error("Data health can only be reset for a QUARANTINED experiment");
      }
      if (!control.reasonCode?.startsWith("DATA_")) {
        throw new Error("Only DATA_* quarantines can reset the healthy review window");
      }
      if (control.healthySince === null && control.reviewedAt === null) return control;
      this.db.prepare(
        `UPDATE experiment_controls SET healthy_since = NULL, reviewed_at = NULL
         WHERE experiment_id = ?`
      ).run(experiment.experimentId);
      this.insertExperimentControlAudit({
        experimentId: experiment.experimentId,
        fromState: "QUARANTINED",
        toState: "QUARANTINED",
        reasonCode: control.reasonCode,
        details: { event: "DATA_UNHEALTHY", observedAt },
        occurredAt: observedAt,
        reviewedAt: null,
      });
      return this.readExperimentControl(experiment.experimentId)!;
    })();
  }

  reactivateQuarantinedExperiment(
    input: ReactivateQuarantinedExperimentInput
  ): ExperimentControlRow {
    return this.db.transaction(() => {
      assertNonNegativeInteger("reviewedAt", input.reviewedAt);
      const experiment = this.aggregateExperiment(input.experimentId);
      const control = this.readExperimentControl(experiment.experimentId);
      if (control?.state !== "QUARANTINED") {
        throw new Error("Only a QUARANTINED experiment can be reactivated");
      }
      if (!control.reasonCode?.startsWith("DATA_")) {
        throw new Error("Only DATA_* quarantines can be reactivated");
      }
      if (control.healthySince === null
        || input.reviewedAt - control.healthySince < DATA_HEALTHY_WINDOW_MS) {
        throw new Error("DATA quarantine requires 60 continuous healthy minutes before review");
      }
      const details = { ...control.details, ...(input.details ?? {}) };
      this.db.prepare(
        `UPDATE experiment_controls SET copy_state = 'ACTIVE', details_json = ?, reviewed_at = ?
         WHERE experiment_id = ?`
      ).run(normalizedPayloadJson(details), input.reviewedAt, experiment.experimentId);
      this.insertExperimentControlAudit({
        experimentId: experiment.experimentId,
        fromState: "QUARANTINED",
        toState: "ACTIVE",
        reasonCode: control.reasonCode,
        details: input.details ?? {},
        occurredAt: input.reviewedAt,
        reviewedAt: input.reviewedAt,
      });
      return this.readExperimentControl(experiment.experimentId)!;
    })();
  }

  listExperimentControlAudit(experimentId?: string): ExperimentControlAuditRow[] {
    const resolvedExperimentId = experimentId ?? this.getActiveExperiment()?.experimentId;
    if (!resolvedExperimentId) return [];
    const rows = this.db.prepare(
      `SELECT audit_id AS auditId, experiment_id AS experimentId,
              from_state AS fromState, to_state AS toState, reason_code AS reasonCode,
              details_json AS detailsJson, occurred_at AS occurredAt,
              reviewed_at AS reviewedAt
       FROM experiment_control_audit WHERE experiment_id = ? ORDER BY audit_id`
    ).all(resolvedExperimentId) as Array<Omit<ExperimentControlAuditRow, "details"> & {
      detailsJson: string;
    }>;
    return rows.map(({ detailsJson, ...row }) => ({
      ...row,
      details: JSON.parse(detailsJson) as Record<string, unknown>,
    }));
  }

  private readExperimentControl(experimentId: string): ExperimentControlRow | undefined {
    const row = this.db.prepare(
      `SELECT experiment_id AS experimentId, copy_state AS state,
              reason_code AS reasonCode, details_json AS detailsJson,
              triggered_at AS triggeredAt, healthy_since AS healthySince,
              reviewed_at AS reviewedAt
       FROM experiment_controls WHERE experiment_id = ?`
    ).get(experimentId) as (Omit<ExperimentControlRow, "details"> & {
      detailsJson: string;
    }) | undefined;
    if (!row) return undefined;
    const { detailsJson, ...rest } = row;
    return { ...rest, details: JSON.parse(detailsJson) as Record<string, unknown> };
  }

  private insertExperimentControlAudit(input: Omit<ExperimentControlAuditRow, "auditId">): void {
    this.db.prepare(
      `INSERT INTO experiment_control_audit
       (experiment_id, from_state, to_state, reason_code, details_json,
        occurred_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.experimentId,
      input.fromState,
      input.toState,
      input.reasonCode,
      normalizedPayloadJson(input.details),
      input.occurredAt,
      input.reviewedAt
    );
  }

  private latestLegacyKillSwitch(): { date: string; triggeredAt: number } | null {
    const row = this.db.prepare(
      "SELECT date FROM daily_stats WHERE kill_switch = 1 ORDER BY date DESC LIMIT 1"
    ).get() as { date: string } | undefined;
    if (!row) return null;
    const parsed = Date.parse(`${row.date}T00:00:00.000Z`);
    return { date: row.date, triggeredAt: Number.isFinite(parsed) ? parsed : Date.now() };
  }

  private persistLegacyKillSwitchControl(
    experimentId: string,
    legacyKill: { date: string; triggeredAt: number }
  ): void {
    if (this.readExperimentControl(experimentId)) return;
    const details = { migratedFrom: "daily_stats", legacyDate: legacyKill.date };
    this.db.prepare(
      `INSERT INTO experiment_controls
       (experiment_id, copy_state, reason_code, details_json, triggered_at)
       VALUES (?, 'SETTLE_ONLY', 'LEGACY_KILL_SWITCH', ?, ?)`
    ).run(experimentId, normalizedPayloadJson(details), legacyKill.triggeredAt);
    this.insertExperimentControlAudit({
      experimentId,
      fromState: "ACTIVE",
      toState: "SETTLE_ONLY",
      reasonCode: "LEGACY_KILL_SWITCH",
      details,
      occurredAt: legacyKill.triggeredAt,
      reviewedAt: null,
    });
  }

  private consumePendingLegacyKillSwitch(experiment: ExperimentManifestRow): void {
    if (experiment.previousExperimentId !== null) return;
    const pending = this.db.prepare(
      "SELECT 1 FROM runtime_metadata WHERE key = 'legacy_kill_switch_backfill_pending' AND value = '1'"
    ).get();
    if (!pending) return;
    const legacyKill = this.latestLegacyKillSwitch();
    if (legacyKill) this.persistLegacyKillSwitchControl(experiment.experimentId, legacyKill);
    this.db.prepare(
      "DELETE FROM runtime_metadata WHERE key = 'legacy_kill_switch_backfill_pending'"
    ).run();
  }

  private aggregateExperiment(
    experimentId?: string,
    accountId?: string
  ): ExperimentManifestRow {
    const experiment = experimentId
      ? this.getExperiment(experimentId)
      : this.getActiveExperiment(accountId);
    if (!experiment) throw new Error("Cannot record aggregate without an active experiment");
    if (accountId && accountId !== experiment.accountId) {
      throw new Error("Aggregate account does not own the experiment");
    }
    if (experiment.state !== "ACTIVE" && experiment.state !== "PREPARED") {
      throw new Error("Cannot update aggregates for an inactive experiment");
    }
    return experiment;
  }

  recordPollHourlyStats(input: RecordPollHourlyStatsInput): PollHourlyStatsRow {
    const observedAt = input.observedAt ?? Date.now();
    assertNonNegativeInteger("observedAt", observedAt);
    const counters = {
      fetchedOccurrences: input.fetchedOccurrences,
      uniqueObservations: input.uniqueObservations,
      resumedObservations: input.resumedObservations,
      duplicateSuppressed: input.duplicateSuppressed,
      pollErrors: input.pollErrors,
      copied: input.copied ?? 0,
      skipped: input.skipped ?? 0,
    };
    for (const [name, value] of Object.entries(counters)) {
      assertNonNegativeInteger(name, value);
    }
    const experiment = this.aggregateExperiment(input.experimentId, input.accountId);
    const hourStart = Math.floor(observedAt / 3_600_000) * 3_600_000;
    this.db.prepare(
      `INSERT INTO poll_hourly_stats
       (experiment_id, account_id, hour_start, poll_count, fetched_occurrences,
        unique_observations, resumed_observations, duplicate_suppressed, poll_errors,
        copied, skipped, first_poll_at, last_poll_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(experiment_id, account_id, hour_start) DO UPDATE SET
         poll_count = poll_count + 1,
         fetched_occurrences = fetched_occurrences + excluded.fetched_occurrences,
         unique_observations = unique_observations + excluded.unique_observations,
         resumed_observations = resumed_observations + excluded.resumed_observations,
         duplicate_suppressed = duplicate_suppressed + excluded.duplicate_suppressed,
         poll_errors = poll_errors + excluded.poll_errors,
         copied = copied + excluded.copied,
         skipped = skipped + excluded.skipped,
         first_poll_at = MIN(first_poll_at, excluded.first_poll_at),
         last_poll_at = MAX(last_poll_at, excluded.last_poll_at)`
    ).run(
      experiment.experimentId,
      experiment.accountId,
      hourStart,
      counters.fetchedOccurrences,
      counters.uniqueObservations,
      counters.resumedObservations,
      counters.duplicateSuppressed,
      counters.pollErrors,
      counters.copied,
      counters.skipped,
      observedAt,
      observedAt
    );
    return this.listPollHourlyStats(experiment.experimentId)
      .find((row) => row.hourStart === hourStart)!;
  }

  listPollHourlyStats(experimentId?: string): PollHourlyStatsRow[] {
    const resolvedExperimentId = experimentId ?? this.getActiveExperiment()?.experimentId;
    if (!resolvedExperimentId) return [];
    return this.db.prepare(
      `SELECT experiment_id AS experimentId, account_id AS accountId,
              hour_start AS hourStart, poll_count AS pollCount,
              fetched_occurrences AS fetchedOccurrences,
              unique_observations AS uniqueObservations,
              resumed_observations AS resumedObservations,
              duplicate_suppressed AS duplicateSuppressed,
              poll_errors AS pollErrors, copied, skipped,
              first_poll_at AS firstPollAt, last_poll_at AS lastPollAt
       FROM poll_hourly_stats WHERE experiment_id = ?
       ORDER BY hour_start`
    ).all(resolvedExperimentId) as PollHourlyStatsRow[];
  }

  recordEquitySnapshot(input: RecordEquitySnapshotInput): EquitySnapshotRow {
    const observedAt = input.observedAt ?? Date.now();
    assertNonNegativeInteger("observedAt", observedAt);
    for (const [name, value] of Object.entries({
      cashUsd: input.cashUsd,
      liquidationValueUsd: input.liquidationValueUsd,
      equityUsd: input.equityUsd,
      openCostUsd: input.openCostUsd,
      quoteCoverage: input.quoteCoverage,
      drawdownPct: input.drawdownPct,
      peakEquityUsd: input.peakEquityUsd,
    })) {
      assertFiniteNumber(name, value);
    }
    if (input.quoteCoverage < 0 || input.quoteCoverage > 1) {
      throw new Error("quoteCoverage must be between 0 and 1");
    }
    if (input.drawdownPct < 0 || input.drawdownPct > 100) {
      throw new Error("drawdownPct must be between 0 and 100");
    }
    assertNonNegativeInteger("missingTokenCount", input.missingTokenCount);
    const experiment = this.aggregateExperiment(input.experimentId, input.accountId);
    const hourStart = Math.floor(observedAt / 3_600_000) * 3_600_000;
    this.db.prepare(
      `INSERT INTO equity_snapshots
       (experiment_id, account_id, hour_start, cash_usd, liquidation_value_usd,
        equity_usd, open_cost_usd, quote_coverage, drawdown_pct, peak_equity_usd,
        missing_token_count, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(experiment_id, account_id, hour_start) DO UPDATE SET
         cash_usd = CASE WHEN excluded.observed_at >= equity_snapshots.observed_at
           THEN excluded.cash_usd ELSE equity_snapshots.cash_usd END,
         liquidation_value_usd = CASE WHEN excluded.observed_at >= equity_snapshots.observed_at
           THEN excluded.liquidation_value_usd ELSE equity_snapshots.liquidation_value_usd END,
         equity_usd = CASE WHEN excluded.observed_at >= equity_snapshots.observed_at
           THEN excluded.equity_usd ELSE equity_snapshots.equity_usd END,
         open_cost_usd = CASE WHEN excluded.observed_at >= equity_snapshots.observed_at
           THEN excluded.open_cost_usd ELSE equity_snapshots.open_cost_usd END,
         quote_coverage = CASE WHEN excluded.observed_at >= equity_snapshots.observed_at
           THEN excluded.quote_coverage ELSE equity_snapshots.quote_coverage END,
         drawdown_pct = CASE WHEN excluded.observed_at >= equity_snapshots.observed_at
           THEN excluded.drawdown_pct ELSE equity_snapshots.drawdown_pct END,
         peak_equity_usd = CASE WHEN excluded.observed_at >= equity_snapshots.observed_at
           THEN excluded.peak_equity_usd ELSE equity_snapshots.peak_equity_usd END,
         missing_token_count = CASE WHEN excluded.observed_at >= equity_snapshots.observed_at
           THEN excluded.missing_token_count ELSE equity_snapshots.missing_token_count END,
         observed_at = MAX(equity_snapshots.observed_at, excluded.observed_at)`
    ).run(
      experiment.experimentId,
      experiment.accountId,
      hourStart,
      input.cashUsd,
      input.liquidationValueUsd,
      input.equityUsd,
      input.openCostUsd,
      input.quoteCoverage,
      input.drawdownPct,
      input.peakEquityUsd,
      input.missingTokenCount,
      observedAt
    );
    return this.listEquitySnapshots(experiment.experimentId)
      .find((row) => row.hourStart === hourStart)!;
  }

  listEquitySnapshots(experimentId?: string): EquitySnapshotRow[] {
    const resolvedExperimentId = experimentId ?? this.getActiveExperiment()?.experimentId;
    if (!resolvedExperimentId) return [];
    return this.db.prepare(
      `SELECT experiment_id AS experimentId, account_id AS accountId,
              hour_start AS hourStart, cash_usd AS cashUsd,
              liquidation_value_usd AS liquidationValueUsd, equity_usd AS equityUsd,
              open_cost_usd AS openCostUsd, quote_coverage AS quoteCoverage,
              drawdown_pct AS drawdownPct, peak_equity_usd AS peakEquityUsd,
              missing_token_count AS missingTokenCount, observed_at AS observedAt
       FROM equity_snapshots WHERE experiment_id = ? ORDER BY hour_start`
    ).all(resolvedExperimentId) as EquitySnapshotRow[];
  }

  getLatestEquitySnapshot(experimentId?: string): EquitySnapshotRow | null {
    return this.listEquitySnapshots(experimentId).at(-1) ?? null;
  }

  getCodeLineagePeakEquity(experimentId?: string): number | null {
    let experiment = experimentId
      ? this.getExperiment(experimentId)
      : this.getActiveExperiment();
    const visited = new Set<string>();
    let peak: number | null = null;
    while (experiment && !visited.has(experiment.experimentId)) {
      visited.add(experiment.experimentId);
      const row = this.db.prepare(
        `SELECT MAX(peak_equity_usd) AS peakEquityUsd
         FROM equity_snapshots WHERE experiment_id = ?`
      ).get(experiment.experimentId) as { peakEquityUsd: number | null };
      if (row.peakEquityUsd !== null) {
        peak = peak === null ? row.peakEquityUsd : Math.max(peak, row.peakEquityUsd);
      }
      if (!experiment.previousExperimentId) return peak;
      const previous = this.getExperiment(experiment.previousExperimentId);
      if (!previous || !this.isBuildOnlyExperimentTransition(previous, experiment)) {
        return peak;
      }
      experiment = previous;
    }
    return peak;
  }

  private isBuildOnlyExperimentTransition(
    previous: ExperimentManifestRow,
    next: ExperimentManifestRow
  ): boolean {
    return next.previousExperimentId === previous.experimentId
      && next.accountId === previous.accountId
      && next.configHash === previous.configHash
      && next.canonicalConfigJson === previous.canonicalConfigJson
      && JSON.stringify(next.candidateAddresses) === JSON.stringify(previous.candidateAddresses)
      && next.schemaVersion === previous.schemaVersion
      && next.trustClass === previous.trustClass
      && (
        next.gitSha !== previous.gitSha
        || next.imageDigest !== previous.imageDigest
        || next.lockfileHash !== previous.lockfileHash
      );
  }

  recordSettlementFailure(input: RecordSettlementFailureInput): SettlementFailureRow {
    return this.db.transaction(() => {
      const observedAt = input.observedAt ?? Date.now();
      assertNonNegativeInteger("observedAt", observedAt);
      const leaderId = requiredAggregateKey("leaderId", input.leaderId);
      const conditionId = requiredAggregateKey("conditionId", input.conditionId);
      const errorCode = requiredAggregateKey("errorCode", input.errorCode);
      const experiment = this.aggregateExperiment(input.experimentId, input.accountId);
      const existing = this.readSettlementFailure(
        experiment.experimentId,
        experiment.accountId,
        leaderId,
        conditionId,
        errorCode
      );
      if (existing?.resolvedAt !== null && existing?.resolvedAt !== undefined
        && observedAt <= existing.resolvedAt) {
        return existing;
      }
      this.db.prepare(
        `INSERT INTO settlement_failures
         (experiment_id, account_id, leader_id, condition_id, slug, error_code,
          error_message, first_seen_at, last_seen_at, failure_count, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
         ON CONFLICT(experiment_id, account_id, leader_id, condition_id, error_code)
         DO UPDATE SET
           slug = COALESCE(excluded.slug, settlement_failures.slug),
           error_message = excluded.error_message,
           first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
           last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
           failure_count = failure_count + 1,
           resolved_at = NULL`
      ).run(
        experiment.experimentId,
        experiment.accountId,
        leaderId,
        conditionId,
        input.slug?.trim() || null,
        errorCode,
        input.errorMessage,
        observedAt,
        observedAt
      );
      const control = this.readExperimentControl(experiment.experimentId);
      if (control?.state === "QUARANTINED"
        && control.reasonCode?.startsWith("DATA_")
        && control.healthySince !== null) {
        this.markExperimentDataUnhealthy({
          experimentId: experiment.experimentId,
          observedAt,
        });
      }
      return this.readSettlementFailure(
        experiment.experimentId,
        experiment.accountId,
        leaderId,
        conditionId,
        errorCode
      )!;
    })();
  }

  resolveSettlementFailure(input: ResolveSettlementFailureInput): number {
    const resolvedAt = input.resolvedAt ?? Date.now();
    assertNonNegativeInteger("resolvedAt", resolvedAt);
    const leaderId = requiredAggregateKey("leaderId", input.leaderId);
    const conditionId = requiredAggregateKey("conditionId", input.conditionId);
    const experiment = this.aggregateExperiment(input.experimentId, input.accountId);
    const latest = this.db.prepare(
      `SELECT MAX(last_seen_at) AS lastSeenAt FROM settlement_failures
       WHERE experiment_id = ? AND account_id = ? AND leader_id = ? AND condition_id = ?
         AND resolved_at IS NULL`
    ).get(
      experiment.experimentId,
      experiment.accountId,
      leaderId,
      conditionId
    ) as { lastSeenAt: number | null };
    if (latest.lastSeenAt === null) return 0;
    if (resolvedAt < latest.lastSeenAt) {
      throw new Error("Settlement resolution predates the latest failure");
    }
    return this.db.prepare(
      `UPDATE settlement_failures SET resolved_at = ?
       WHERE experiment_id = ? AND account_id = ? AND leader_id = ? AND condition_id = ?
         AND resolved_at IS NULL`
    ).run(
      resolvedAt,
      experiment.experimentId,
      experiment.accountId,
      leaderId,
      conditionId
    ).changes;
  }

  listSettlementFailures(experimentId?: string): SettlementFailureRow[] {
    const resolvedExperimentId = experimentId ?? this.getActiveExperiment()?.experimentId;
    if (!resolvedExperimentId) return [];
    return this.db.prepare(
      `SELECT experiment_id AS experimentId, account_id AS accountId,
              leader_id AS leaderId, condition_id AS conditionId, slug,
              error_code AS errorCode, error_message AS errorMessage,
              first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
              failure_count AS count, resolved_at AS resolvedAt
       FROM settlement_failures WHERE experiment_id = ?
       ORDER BY first_seen_at, leader_id, condition_id, error_code`
    ).all(resolvedExperimentId) as SettlementFailureRow[];
  }

  listActiveSettlementFailures(experimentId?: string): SettlementFailureRow[] {
    return this.listSettlementFailures(experimentId)
      .filter((failure) => failure.resolvedAt === null);
  }

  private readSettlementFailure(
    experimentId: string,
    accountId: string,
    leaderId: string,
    conditionId: string,
    errorCode: string
  ): SettlementFailureRow | undefined {
    return this.db.prepare(
      `SELECT experiment_id AS experimentId, account_id AS accountId,
              leader_id AS leaderId, condition_id AS conditionId, slug,
              error_code AS errorCode, error_message AS errorMessage,
              first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
              failure_count AS count, resolved_at AS resolvedAt
       FROM settlement_failures
       WHERE experiment_id = ? AND account_id = ? AND leader_id = ?
         AND condition_id = ? AND error_code = ?`
    ).get(experimentId, accountId, leaderId, conditionId, errorCode) as
      SettlementFailureRow | undefined;
  }

  setDecisionRawEventIds(rawEventIds: string[]): void {
    this.decisionRawEventIds = [...new Set(rawEventIds)];
    this.decisionObservationRefs = [];
    this.decisionObservationRefs = this.observationRefsForRawEventIds(this.decisionRawEventIds);
  }

  private observationRefsForRawEventIds(rawEventIds: string[]): DecisionObservationRef[] {
    const latest = this.db.prepare(
      "SELECT observation_id AS observationId FROM raw_event_observations WHERE raw_event_id=? ORDER BY observation_id DESC LIMIT 1"
    );
    return [...new Set(rawEventIds)].flatMap((rawEventId) => {
      const context = this.decisionObservationRefs.filter((ref) => ref.rawEventId === rawEventId);
      if (context.length > 0) return context;
      const observationId = this.latestObservationIdByRawEventId.get(rawEventId)
        ?? (latest.get(rawEventId) as { observationId: number } | undefined)?.observationId;
      return observationId === undefined ? [] : [{ rawEventId, observationId }];
    });
  }

  private observationRefsForSourceKeys(sourceKeys: string[]): DecisionObservationRef[] {
    return this.observationRefsForRawEventIds(this.rawEventIdsForSourceKeys(sourceKeys));
  }

  private parseObservationRefs(value: string | null | undefined): DecisionObservationRef[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((ref) => {
        const row = ref as Partial<DecisionObservationRef>;
        return typeof row.rawEventId === "string" && Number.isInteger(row.observationId) && row.observationId! > 0
          ? [{ rawEventId: row.rawEventId, observationId: row.observationId! }]
          : [];
      });
    } catch { return []; }
  }

  private parseDecisionTerms(value: string | null | undefined): Record<string, unknown> {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch { return {}; }
  }

  setDecisionObservationRefs(refs: DecisionObservationRef[]): void {
    const owner = this.db.prepare(
      "SELECT 1 FROM raw_event_observations WHERE observation_id=? AND raw_event_id=?"
    );
    const identities = new Set<string>();
    for (const ref of refs) {
      const identity = `${ref.rawEventId}\n${ref.observationId}`;
      if (identities.has(identity) || !owner.get(ref.observationId, ref.rawEventId)) {
        throw new Error("Invalid persisted decision observation context");
      }
      identities.add(identity);
    }
    this.decisionRawEventIds = [...new Set(refs.map((ref) => ref.rawEventId))];
    this.decisionObservationRefs = [...refs];
  }

  latestObservationRef(rawEventId: string): DecisionObservationRef {
    const observationId = this.latestObservationIdByRawEventId.get(rawEventId)
      ?? (this.db.prepare(
        "SELECT observation_id AS observationId FROM raw_event_observations WHERE raw_event_id=? ORDER BY observation_id DESC LIMIT 1"
      ).get(rawEventId) as { observationId: number } | undefined)?.observationId;
    if (observationId === undefined) throw new Error(`Raw observation not found: ${rawEventId}`);
    return { rawEventId, observationId };
  }

  private rawEventIdsForSourceKeys(sourceKeys: string[]): string[] {
    if (sourceKeys.length === 0) return [];
    const stmt = this.db.prepare(
      "SELECT raw_event_id AS rawEventId FROM raw_events WHERE source_id = ? ORDER BY observed_timestamp DESC LIMIT 1"
    );
    return uniqueTradeKeys(sourceKeys).flatMap((key) => {
      const row = stmt.get(key) as { rawEventId: string } | undefined;
      return row ? [row.rawEventId] : [];
    });
  }

  private migrate(): void {
    const storedSchemaVersion = Number((this.db.prepare(
      "SELECT value FROM schema_metadata WHERE key = 'schema_version'"
    ).get() as { value: string } | undefined)?.value ?? 0);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_observation_links (
        link_id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
        observation_id INTEGER NOT NULL REFERENCES raw_event_observations(observation_id),
        decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
        link_order INTEGER NOT NULL,
        linked_at INTEGER NOT NULL,
        UNIQUE(observation_id, decision_id),
        UNIQUE(experiment_id, link_order)
      );
      CREATE INDEX IF NOT EXISTS idx_decision_observation_links_observation
        ON decision_observation_links(observation_id, link_order);
      CREATE INDEX IF NOT EXISTS idx_decision_observation_links_decision
        ON decision_observation_links(decision_id);
    `);
    const experimentCols = this.db.prepare("PRAGMA table_info(experiments)").all() as { name: string }[];
    if (!experimentCols.some((column) => column.name === "state")) {
      this.db.exec("ALTER TABLE experiments ADD COLUMN state TEXT NOT NULL DEFAULT 'ACTIVE'");
    }
    if (!experimentCols.some((column) => column.name === "previous_experiment_id")) {
      this.db.exec("ALTER TABLE experiments ADD COLUMN previous_experiment_id TEXT");
    }
    if (!experimentCols.some((column) => column.name === "start_state_json")) this.db.exec(`ALTER TABLE experiments ADD COLUMN start_state_json TEXT NOT NULL DEFAULT '{"cashUsd":0,"positions":[],"realizedPnlUsd":0}'`);
    if (!experimentCols.some((column) => column.name === "end_state_json")) this.db.exec("ALTER TABLE experiments ADD COLUMN end_state_json TEXT");
    if (!experimentCols.some((column) => column.name === "archive_status")) this.db.exec("ALTER TABLE experiments ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'NONE'");
    if (!experimentCols.some((column) => column.name === "archive_error")) this.db.exec("ALTER TABLE experiments ADD COLUMN archive_error TEXT");
    const legacyKill = this.latestLegacyKillSwitch();
    if (legacyKill) {
      const legacyKilledExperiments = this.db.prepare(
        `SELECT e.experiment_id AS experimentId
         FROM experiments e
         LEFT JOIN experiment_controls c ON c.experiment_id=e.experiment_id
         WHERE e.state='ACTIVE' AND e.ended_at IS NULL AND e.sealed_at IS NULL
           AND e.archive_status <> 'PREPARING'
           AND e.schema_version < ? AND c.experiment_id IS NULL`
      ).all(STATE_SCHEMA_VERSION) as { experimentId: string }[];
      for (const row of legacyKilledExperiments) {
        this.persistLegacyKillSwitchControl(row.experimentId, legacyKill);
      }
      const experimentCount = (this.db.prepare(
        "SELECT COUNT(*) AS count FROM experiments"
      ).get() as { count: number }).count;
      if (experimentCount === 0 && storedSchemaVersion < STATE_SCHEMA_VERSION) {
        this.db.prepare(
          `INSERT INTO runtime_metadata (key, value)
           VALUES ('legacy_kill_switch_backfill_pending', '1')
           ON CONFLICT(key) DO UPDATE SET value = '1'`
        ).run();
      }
    }
    const auditExperimentCols = this.db.prepare("PRAGMA table_info(audit_log)").all() as { name: string }[];
    if (!auditExperimentCols.some((column) => column.name === "experiment_id")) this.db.exec("ALTER TABLE audit_log ADD COLUMN experiment_id TEXT");
    if (!auditExperimentCols.some((column) => column.name === "decision_id")) {
      this.db.exec("ALTER TABLE audit_log ADD COLUMN decision_id TEXT REFERENCES decisions(decision_id)");
    }
    const archiveCols = this.db.prepare("PRAGMA table_info(experiment_archives)").all() as { name: string }[];
    if (!archiveCols.some((column) => column.name === "archive_path")) this.db.exec("ALTER TABLE experiment_archives ADD COLUMN archive_path TEXT");
    if (!archiveCols.some((column) => column.name === "verified_at")) this.db.exec("ALTER TABLE experiment_archives ADD COLUMN verified_at INTEGER");
    if (!archiveCols.some((column) => column.name === "verification_status")) this.db.exec("ALTER TABLE experiment_archives ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'PENDING_VERIFY'");
    // Schema v9 keeps every publication as an append-only attempt while the
    // one-row experiment_archives table remains the verified trust anchor.
    this.db.exec(`
      INSERT OR IGNORE INTO experiment_archive_attempts
        (attempt_id, experiment_id, snapshot_sha256, manifest_sha256, archived_at,
         archive_path, verified_at, verification_status, error)
      SELECT 'legacy:' || experiment_id || ':' || archived_at,
             experiment_id, snapshot_sha256, manifest_sha256, archived_at,
             COALESCE(archive_path, ''), verified_at, verification_status, NULL
      FROM experiment_archives;
      DROP TRIGGER IF EXISTS experiment_archives_no_delete;
      DELETE FROM experiment_archives WHERE verification_status <> 'VERIFIED';
    `);
    const decisionCols = this.db.prepare("PRAGMA table_info(decisions)").all() as { name: string }[];
    if (!decisionCols.some((column) => column.name === "decision_order")) {
      this.db.exec("ALTER TABLE decisions ADD COLUMN decision_order INTEGER");
      this.db.exec("UPDATE decisions SET decision_order=rowid WHERE decision_order IS NULL");
    }
    const legacyDecisionLinks = this.db.prepare(
      `SELECT l.observation_id AS observationId, d.action,
              d.exact_terms_json AS exactTermsJson, d.decision_id AS decisionId,
              d.experiment_id AS experimentId, l.linked_at AS linkedAt
       FROM decision_observation_links l
       JOIN decisions d ON d.decision_id=l.decision_id
       ORDER BY l.link_order, l.link_id`
    ).all() as Array<{
      observationId: number;
      action: DecisionAction;
      exactTermsJson: string;
      decisionId: string;
      experimentId: string;
      linkedAt: number;
    }>;
    const insertLegacySlot = this.db.prepare(
      `INSERT OR IGNORE INTO observation_decision_slots
       (observation_id, decision_phase, decision_id, experiment_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const hasLegacySlot = this.db.prepare(
      `SELECT 1 FROM observation_decision_slots
       WHERE observation_id = ? AND decision_phase = ?`
    );
    for (const row of legacyDecisionLinks) {
      let exactTerms: Record<string, unknown> = {};
      try {
        exactTerms = JSON.parse(row.exactTermsJson) as Record<string, unknown>;
      } catch {
        // Invalid legacy terms fail closed as a terminal decision slot.
      }
      const phase = decisionSlotPhase(row.action, exactTerms);
      if (phase === "PROGRESS") continue;
      if (hasLegacySlot.get(row.observationId, phase)) continue;
      insertLegacySlot.run(
        row.observationId,
        phase,
        row.decisionId,
        row.experimentId,
        row.linkedAt
      );
    }
    const observationCols = this.db.prepare("PRAGMA table_info(raw_event_observations)").all() as { name: string }[];
    if (!observationCols.some((column) => column.name === "observation_key")) {
      this.db.exec("ALTER TABLE raw_event_observations ADD COLUMN observation_key TEXT");
    }
    // Historical duplicate observations are immutable evidence. recordRawEvent's
    // logical NOT EXISTS guard prevents new duplicates without rewriting or
    // deleting legacy rows during schema migration.
    const cols = this.db.prepare("PRAGMA table_info(positions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "avg_entry_price")) {
      this.db.exec("ALTER TABLE positions ADD COLUMN avg_entry_price REAL NOT NULL DEFAULT 0");
    }
    const dailyCols = this.db.prepare("PRAGMA table_info(daily_stats)").all() as { name: string }[];
    if (!dailyCols.some((c) => c.name === "realized_pnl")) {
      this.db.exec("ALTER TABLE daily_stats ADD COLUMN realized_pnl REAL NOT NULL DEFAULT 0");
    }
    const auditCols = this.db.prepare("PRAGMA table_info(audit_log)").all() as { name: string }[];
    if (!auditCols.some((c) => c.name === "leader_price")) {
      this.db.exec("ALTER TABLE audit_log ADD COLUMN leader_price REAL");
    }
    if (!auditCols.some((c) => c.name === "executable_price")) {
      this.db.exec("ALTER TABLE audit_log ADD COLUMN executable_price REAL");
    }
    if (!auditCols.some((c) => c.name === "slippage_pct")) {
      this.db.exec("ALTER TABLE audit_log ADD COLUMN slippage_pct REAL");
    }
    if (!auditCols.some((c) => c.name === "fee_usd")) {
      this.db.exec("ALTER TABLE audit_log ADD COLUMN fee_usd REAL NOT NULL DEFAULT 0");
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_decision
      ON audit_log(decision_id) WHERE decision_id IS NOT NULL`);
    const intentCols = this.db.prepare("PRAGMA table_info(live_order_intents)").all() as { name: string }[];
    if (!intentCols.some((c) => c.name === "leader_price")) {
      this.db.exec("ALTER TABLE live_order_intents ADD COLUMN leader_price REAL");
    }
    if (!intentCols.some((c) => c.name === "executable_price")) {
      this.db.exec("ALTER TABLE live_order_intents ADD COLUMN executable_price REAL");
    }
    if (!intentCols.some((c) => c.name === "slippage_pct")) {
      this.db.exec("ALTER TABLE live_order_intents ADD COLUMN slippage_pct REAL");
    }
    if (!intentCols.some((c) => c.name === "reconciliation_only")) {
      this.db.exec("ALTER TABLE live_order_intents ADD COLUMN reconciliation_only INTEGER NOT NULL DEFAULT 0");
    }
    if (!intentCols.some((c) => c.name === "reconciliation_until")) {
      this.db.exec("ALTER TABLE live_order_intents ADD COLUMN reconciliation_until INTEGER NOT NULL DEFAULT 0");
      this.db.exec(
        `UPDATE live_order_intents
         SET reconciliation_until = created_at + ${FILL_RECONCILIATION_WINDOW_MS}
         WHERE reconciliation_until = 0`
      );
    }
    if (!intentCols.some((c) => c.name === "observation_refs_json")) {
      this.db.exec("ALTER TABLE live_order_intents ADD COLUMN observation_refs_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!intentCols.some((c) => c.name === "decision_terms_json")) {
      this.db.exec("ALTER TABLE live_order_intents ADD COLUMN decision_terms_json TEXT NOT NULL DEFAULT '{}'");
    }
    const pendingCols = this.db.prepare("PRAGMA table_info(pending_orders)").all() as { name: string }[];
    if (!pendingCols.some((c) => c.name === "filled_usd")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN filled_usd REAL NOT NULL DEFAULT 0");
      this.db.exec("UPDATE pending_orders SET filled_usd = filled_shares * price");
    }
    if (!pendingCols.some((c) => c.name === "fee_usd")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN fee_usd REAL NOT NULL DEFAULT 0");
    }
    if (!pendingCols.some((c) => c.name === "leader_price")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN leader_price REAL");
    }
    if (!pendingCols.some((c) => c.name === "executable_price")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN executable_price REAL");
    }
    if (!pendingCols.some((c) => c.name === "slippage_pct")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN slippage_pct REAL");
    }
    if (!pendingCols.some((c) => c.name === "reconciliation_only")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN reconciliation_only INTEGER NOT NULL DEFAULT 0");
    }
    if (!pendingCols.some((c) => c.name === "reconciliation_started_at")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN reconciliation_started_at INTEGER");
    }
    if (!pendingCols.some((c) => c.name === "observation_refs_json")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN observation_refs_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!pendingCols.some((c) => c.name === "decision_terms_json")) {
      this.db.exec("ALTER TABLE pending_orders ADD COLUMN decision_terms_json TEXT NOT NULL DEFAULT '{}'");
    }
    this.db.exec(
      `UPDATE pending_orders
       SET reconciliation_started_at = COALESCE(updated_at, created_at)
       WHERE reconciliation_only = 1 AND reconciliation_started_at IS NULL`
    );
  }

  getCopyPriceModeCompatibility(requested: CopyPriceMode): CopyPriceModeCompatibilityResult {
    return copyPriceModeCompatibility(this.db, requested);
  }

  hasLegacyEvidence(): boolean {
    return legacyCopyPriceModeState(this.db);
  }

  beginExperimentBatch(): void {
    this.db.exec("BEGIN IMMEDIATE");
  }

  commitExperimentBatch(): void {
    this.db.exec("COMMIT");
  }

  rollbackExperimentBatch(): void {
    if (this.db.inTransaction) this.db.exec("ROLLBACK");
  }

  static getCopyPriceModeCompatibilityForPath(
    path: string,
    requested: CopyPriceMode
  ): CopyPriceModeCompatibilityResult {
    if (!path || !existsSync(path)) return { mode: requested, status: "unbound" };
    const db = new Database(path, { readonly: true });
    try {
      return copyPriceModeCompatibility(db, requested);
    } finally {
      db.close();
    }
  }

  ensureCopyPriceMode(requested: CopyPriceMode): EnsureCopyPriceModeResult {
    return this.db.transaction((): EnsureCopyPriceModeResult => {
      const compatibility = this.getCopyPriceModeCompatibility(requested);
      const mode = compatibility.mode;
      if (compatibility.status === "unbound") {
        this.db
          .prepare("INSERT INTO runtime_metadata (key, value) VALUES ('copy_price_mode', ?)")
          .run(mode);
        return { mode, status: "bound" };
      }

      if (!hasTable(this.db, "runtime_metadata") || !this.db
        .prepare("SELECT 1 FROM runtime_metadata WHERE key = 'copy_price_mode'")
        .get()) {
        this.db
          .prepare("INSERT INTO runtime_metadata (key, value) VALUES ('copy_price_mode', ?)")
          .run(mode);
      }

      return { mode, status: compatibility.status };
    })();
  }

  hasSeen(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen_trades WHERE key = ?").get(key) !== undefined;
  }

  markSeen(key: string, leaderId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO seen_trades (key, leader_id, created_at) VALUES (?, ?, ?)")
      .run(key, leaderId, Date.now());
  }

  markSeenMany(keys: string[], leaderId: string): void {
    if (keys.length === 0) return;
    const unique = [...new Set(keys)];
    this.db.transaction(() => {
      for (const key of unique) {
        this.markSeen(key, leaderId);
      }
    })();
  }

  listSeenTrades(): { key: string; leaderId: string; createdAt: number }[] {
    return this.db
      .prepare(
        `SELECT key, leader_id AS leaderId, created_at AS createdAt FROM seen_trades ORDER BY created_at ASC`
      )
      .all() as { key: string; leaderId: string; createdAt: number }[];
  }

  /** Merge dedup keys from another store (e.g. preview → live on mode switch). */
  importSeenTradesFrom(source: StateStore): number {
    const rows = source.listSeenTrades();
    if (rows.length === 0) return 0;

    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO seen_trades (key, leader_id, created_at) VALUES (?, ?, ?)"
    );
    let imported = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const result = stmt.run(row.key, row.leaderId, row.createdAt);
        if (result.changes > 0) imported++;
      }
    })();
    return imported;
  }

  /**
   * Copy Preview engine positions into Live DB when empty for that leader+token.
   * Tracking only — on-chain wallet remains authoritative for SELL sizing.
   */
  importPositionsFrom(source: StateStore): number {
    const rows = source.listPositions();
    if (rows.length === 0) return 0;

    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO positions (leader_id, token_id, shares, avg_entry_price)
       VALUES (?, ?, ?, ?)`
    );
    let imported = 0;
    this.db.transaction(() => {
      for (const p of rows) {
        if (p.shares <= 0) continue;
        const result = stmt.run(p.leaderId, p.tokenId, p.shares, p.avgEntryPrice);
        if (result.changes > 0) imported++;
      }
    })();
    return imported;
  }

  getPosition(leaderId: string, tokenId: string): number {
    const row = this.db
      .prepare("SELECT shares FROM positions WHERE leader_id = ? AND token_id = ?")
      .get(leaderId, tokenId) as { shares: number } | undefined;
    return row?.shares ?? 0;
  }

  getCashBalance(initialUsd: number): number {
    const scope = "preview";
    const row = this.db
      .prepare("SELECT cash_usd FROM cash_ledger WHERE scope = ?")
      .get(scope) as { cash_usd: number } | undefined;
    if (row) return row.cash_usd;

    const initialCash = roundCashUsd(initialUsd);
    this.db
      .prepare("INSERT INTO cash_ledger (scope, cash_usd, updated_at) VALUES (?, ?, ?)")
      .run(scope, initialCash, Date.now());
    return initialCash;
  }

  readCashBalance(initialUsd: number): number {
    const row = this.db
      .prepare("SELECT cash_usd FROM cash_ledger WHERE scope = ?")
      .get("preview") as { cash_usd: number } | undefined;
    return row?.cash_usd ?? roundCashUsd(initialUsd);
  }

  getOpenPositionSummary(): { openPositions: number; openCostUsd: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS openPositions,
                COALESCE(SUM(shares * avg_entry_price), 0) AS openCostUsd
         FROM positions
         WHERE shares > 0`
      )
      .get() as { openPositions: number; openCostUsd: number };
    return {
      openPositions: row.openPositions,
      openCostUsd: roundUsd(row.openCostUsd),
    };
  }

  adjustCash(deltaUsd: number, initialUsd: number): number {
    const current = this.getCashBalance(initialUsd);
    const next = roundCashUsd(current + deltaUsd);
    this.db
      .prepare("UPDATE cash_ledger SET cash_usd = ?, updated_at = ? WHERE scope = ?")
      .run(next, Date.now(), "preview");
    return next;
  }

  /** Cost basis (USD) of a leader's position: shares × average entry price. */
  getPositionCostUsd(leaderId: string, tokenId: string): number {
    const row = this.db
      .prepare(
        "SELECT shares, avg_entry_price FROM positions WHERE leader_id = ? AND token_id = ?"
      )
      .get(leaderId, tokenId) as { shares: number; avg_entry_price: number } | undefined;
    if (!row) return 0;
    return row.shares * row.avg_entry_price;
  }

  adjustPosition(leaderId: string, tokenId: string, deltaShares: number): void {
    const current = this.getPosition(leaderId, tokenId);
    const next = Math.max(0, roundAccounting(current + deltaShares));
    this.db
      .prepare(
        `INSERT INTO positions (leader_id, token_id, shares, avg_entry_price) VALUES (?, ?, ?, 0)
         ON CONFLICT(leader_id, token_id) DO UPDATE SET shares = excluded.shares`
      )
      .run(leaderId, tokenId, next);
  }

  /** Update position after a copy; SELL may apply fewer shares than requested. */
  applyCopyFill(
    leaderId: string,
    tokenId: string,
    side: "BUY" | "SELL",
    shares: number,
    price: number
  ): CopyFillResult {
    const row = this.db
      .prepare("SELECT shares, avg_entry_price FROM positions WHERE leader_id = ? AND token_id = ?")
      .get(leaderId, tokenId) as { shares: number; avg_entry_price: number } | undefined;
    const current = row?.shares ?? 0;
    const avg = row?.avg_entry_price ?? 0;

    if (side === "BUY") {
      const nextShares = roundAccounting(current + shares);
      const nextAvg =
        nextShares > 0 ? (current * avg + shares * price) / nextShares : price;
      this.db
        .prepare(
          `INSERT INTO positions (leader_id, token_id, shares, avg_entry_price) VALUES (?, ?, ?, ?)
           ON CONFLICT(leader_id, token_id) DO UPDATE SET
             shares = excluded.shares,
             avg_entry_price = excluded.avg_entry_price`
        )
        .run(leaderId, tokenId, nextShares, nextAvg);
      return { appliedShares: shares, realizedPnl: 0 };
    }

    const sold = Math.min(current, shares);
    const pnl = roundAccounting((price - avg) * sold);
    const nextShares = Math.max(0, roundAccounting(current - sold));
    this.db
      .prepare(
        `INSERT INTO positions (leader_id, token_id, shares, avg_entry_price) VALUES (?, ?, ?, ?)
         ON CONFLICT(leader_id, token_id) DO UPDATE SET
           shares = excluded.shares,
           avg_entry_price = CASE WHEN excluded.shares = 0 THEN 0 ELSE avg_entry_price END`
      )
      .run(leaderId, tokenId, nextShares, nextShares > 0 ? avg : 0);
    if (pnl !== 0) this.addRealizedPnl(pnl);
    return { appliedShares: sold, realizedPnl: pnl };
  }

  countOpenMarkets(): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT token_id) AS c FROM positions WHERE shares > 0")
      .get() as { c: number };
    return row.c;
  }

  hasOpenPosition(tokenId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM positions WHERE token_id = ? AND shares > 0 LIMIT 1")
      .get(tokenId);
    return row !== undefined;
  }

  /** Sum shares held for a token across all leaders (single wallet). */
  getTotalTokenShares(tokenId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(shares), 0) AS total FROM positions WHERE token_id = ?")
      .get(tokenId) as { total: number };
    return row.total;
  }

  listOpenTokenIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT token_id FROM positions WHERE shares > 0")
      .all() as { token_id: string }[];
    return rows.map((r) => r.token_id);
  }

  upsertTokenMarket(entry: TokenMarketEntry): void {
    if (!entry.tokenId || !entry.conditionId) return;
    this.db
      .prepare(
        `INSERT INTO token_markets (token_id, condition_id, title, slug, outcome)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           condition_id = excluded.condition_id,
           title = COALESCE(excluded.title, token_markets.title),
           slug = COALESCE(excluded.slug, token_markets.slug),
           outcome = COALESCE(excluded.outcome, token_markets.outcome)`
      )
      .run(
        entry.tokenId,
        entry.conditionId,
        entry.title ?? null,
        entry.slug ?? null,
        entry.outcome ?? null
      );
  }

  listPositionsByCondition(leaderId: string, conditionId: string): PositionWithMarketRow[] {
    return this.db
      .prepare(
        `SELECT p.leader_id AS leaderId, p.token_id AS tokenId, p.shares,
                p.avg_entry_price AS avgEntryPrice, m.condition_id AS conditionId,
                m.title, m.slug, m.outcome
         FROM positions p
         JOIN token_markets m ON m.token_id = p.token_id
         WHERE p.leader_id = ? AND m.condition_id = ? AND p.shares > 0
         ORDER BY p.token_id`
      )
      .all(leaderId, conditionId) as PositionWithMarketRow[];
  }

  listOpenConditions(): OpenConditionRow[] {
    return this.db
      .prepare(
        `SELECT p.leader_id AS leaderId, m.condition_id AS conditionId,
                MAX(m.title) AS title, MAX(m.slug) AS slug,
                COUNT(*) AS positionCount,
                COALESCE(SUM(p.shares * p.avg_entry_price), 0) AS costUsd
         FROM positions p
         JOIN token_markets m ON m.token_id = p.token_id
         WHERE p.shares > 0
         GROUP BY p.leader_id, m.condition_id
         ORDER BY p.leader_id, m.condition_id`
      )
      .all() as OpenConditionRow[];
  }

  settleCondition(entry: SettleConditionEntry): SettleConditionResult {
    const winners = new Set(entry.winnerTokenIds);
    return this.db.transaction(() => {
      for (const key of [...new Set(entry.sourceKeys ?? [])]) {
        this.markSeen(key, entry.leaderId);
      }

      const positions = this.listPositionsByCondition(entry.leaderId, entry.conditionId);
      const closedPositions = positions.length;
      const costUsd = roundUsd(
        positions.reduce((sum, p) => sum + p.shares * p.avgEntryPrice, 0)
      );
      const payoutUsd = roundUsd(
        positions.reduce((sum, p) => sum + (winners.has(p.tokenId) ? p.shares : 0), 0)
      );
      const realizedPnl = roundUsd(payoutUsd - costUsd);

      for (const pos of positions) {
        this.db
          .prepare(
            `UPDATE positions
             SET shares = 0, avg_entry_price = 0
             WHERE leader_id = ? AND token_id = ?`
          )
          .run(entry.leaderId, pos.tokenId);
      }

      if (realizedPnl !== 0) this.addRealizedPnl(realizedPnl);
      if (entry.cashInitialUsd !== undefined && payoutUsd !== 0) {
        this.adjustCash(payoutUsd, entry.cashInitialUsd);
      }

      if (closedPositions > 0) {
        this.audit({
          leaderId: entry.leaderId,
          action: "REDEEM",
          tokenId: entry.conditionId,
          side: "REDEEM",
          size: payoutUsd,
          price: closedPositions,
          reason: `settled ${closedPositions} position(s); pnl $${realizedPnl.toFixed(2)}`,
          preview: entry.preview,
          exactTerms: {
            settlementSource: "condition_resolution",
            sourceIds: entry.sourceKeys ?? [],
            winnerTokenIds: [...winners].sort(),
            costBasisUsd: costUsd,
            grossPayoutUsd: payoutUsd,
            realizedPnlUsd: realizedPnl,
            conditionId: entry.conditionId,
          },
        });
      }

      return { closedPositions, payoutUsd, costUsd, realizedPnl };
    })();
  }

  recordRedeemSettlement(entry: RecordRedeemSettlementEntry): boolean {
    return this.db.transaction(() => {
      if (this.hasSeen(entry.tradeKey)) return false;

      const row = this.db
        .prepare(
          `SELECT shares, avg_entry_price AS avgEntryPrice
           FROM positions
           WHERE leader_id = ? AND token_id = ? AND shares > 0`
        )
        .get(entry.leaderId, entry.tokenId) as
        | { shares: number; avgEntryPrice: number }
        | undefined;

      if (!row || row.shares <= 0) {
        this.markSeen(entry.tradeKey, entry.leaderId);
        return false;
      }

      this.markSeen(entry.tradeKey, entry.leaderId);
      const payoutUsd = roundUsd(entry.payoutUsd);
      const costUsd = roundUsd(row.shares * row.avgEntryPrice);
      const realizedPnl = roundUsd(payoutUsd - costUsd);

      this.db
        .prepare(
          `UPDATE positions
           SET shares = 0, avg_entry_price = 0
           WHERE leader_id = ? AND token_id = ?`
        )
        .run(entry.leaderId, entry.tokenId);

      if (realizedPnl !== 0) this.addRealizedPnl(realizedPnl);
      if (entry.preview && entry.cashInitialUsd !== undefined && payoutUsd !== 0) {
        this.adjustCash(payoutUsd, entry.cashInitialUsd);
      }

      this.audit({
        leaderId: entry.leaderId,
        action: "REDEEM",
        tokenId: entry.tokenId,
        side: "REDEEM",
        size: payoutUsd,
        price: row.shares,
        reason:
          entry.auditReason ??
          `settled ${row.shares} shares; pnl $${realizedPnl.toFixed(2)}`,
        preview: entry.preview,
        exactTerms: {
          settlementSource: "leader_redeem",
          sourceId: entry.tradeKey,
          costBasisUsd: costUsd,
          grossPayoutUsd: payoutUsd,
          realizedPnlUsd: realizedPnl,
          ...entry.exactTerms,
        },
      });
      return true;
    })();
  }

  recordTokenSettlement(
    tokenId: string,
    payoutPerShare: number,
    preview: boolean,
    cashInitialUsd?: number,
    settlementTerms?: Record<string, unknown>
  ): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT leader_id AS leaderId, shares, avg_entry_price AS avgEntryPrice
           FROM positions
           WHERE token_id = ? AND shares > 0
           ORDER BY leader_id`
        )
        .all(tokenId) as { leaderId: string; shares: number; avgEntryPrice: number }[];

      if (rows.length === 0) return 0;
      const settlements = rows.map((row) => {
        const payoutUsd = roundUsd(row.shares * payoutPerShare);
        const costUsd = roundUsd(row.shares * row.avgEntryPrice);
        const realizedPnl = roundUsd(payoutUsd - costUsd);
        return {
          leaderId: row.leaderId,
          tokenId,
          shares: row.shares,
          payoutPerShare,
          costBasisUsd: costUsd,
          grossPayoutUsd: payoutUsd,
          realizedPnlUsd: realizedPnl,
        };
      });
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE positions
             SET shares = 0, avg_entry_price = 0
             WHERE leader_id = ? AND token_id = ?`
          )
          .run(row.leaderId, tokenId);
      }
      const totalShares = Math.round(
        settlements.reduce((sum, row) => sum + row.shares, 0) * 100_000_000
      ) / 100_000_000;
      const costBasisUsd = roundUsd(settlements.reduce((sum, row) => sum + row.costBasisUsd, 0));
      const grossPayoutUsd = roundUsd(settlements.reduce((sum, row) => sum + row.grossPayoutUsd, 0));
      const realizedPnlUsd = roundUsd(settlements.reduce((sum, row) => sum + row.realizedPnlUsd, 0));
      if (realizedPnlUsd !== 0) this.addRealizedPnl(realizedPnlUsd);
      if (preview && cashInitialUsd !== undefined && grossPayoutUsd !== 0) {
        this.adjustCash(grossPayoutUsd, cashInitialUsd);
      }
      const single = settlements.length === 1 ? settlements[0]! : null;
      this.audit({
        leaderId: single?.leaderId,
        action: "REDEEM",
        tokenId,
        side: "REDEEM",
        size: grossPayoutUsd,
        price: totalShares,
        reason: single
          ? `token settlement payout ${payoutPerShare}; pnl $${realizedPnlUsd.toFixed(2)}`
          : `token settlement payout ${payoutPerShare}; ${settlements.length} positions; pnl $${realizedPnlUsd.toFixed(2)}`,
        preview,
        exactTerms: {
          settlementSource: "token_settlement",
          payoutPerShare,
          winnerTokenIds: payoutPerShare > 0 ? [tokenId] : [],
          costBasisUsd,
          grossPayoutUsd,
          realizedPnlUsd,
          settlements,
          ...settlementTerms,
        },
      });
      return rows.length;
    })();
  }

  upsertPendingOrder(entry: {
    orderId: string;
    leaderId: string;
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    filledShares: number;
    filledUsd?: number;
    feeUsd?: number;
    leaderPrice?: number;
    executablePrice?: number | null;
    slippagePct?: number | null;
    tradeKey: string;
    reasoning: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pending_orders
         (order_id, leader_id, token_id, side, price, size, filled_shares, filled_usd, fee_usd,
          leader_price, executable_price, slippage_pct, trade_key, reasoning, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           filled_shares = excluded.filled_shares,
           filled_usd = excluded.filled_usd,
           fee_usd = excluded.fee_usd,
           leader_price = COALESCE(excluded.leader_price, pending_orders.leader_price),
           executable_price = COALESCE(excluded.executable_price, pending_orders.executable_price),
           slippage_pct = COALESCE(excluded.slippage_pct, pending_orders.slippage_pct),
           updated_at = excluded.updated_at`
      )
      .run(
        entry.orderId,
        entry.leaderId,
        entry.tokenId,
        entry.side,
        entry.price,
        entry.size,
        entry.filledShares,
        entry.filledUsd ?? entry.filledShares * entry.price,
        entry.feeUsd ?? 0,
        entry.leaderPrice ?? null,
        entry.executablePrice ?? null,
        entry.slippagePct ?? null,
        entry.tradeKey,
        entry.reasoning,
        now,
        now
      );
  }

  listPendingOrders(options?: { includeReconciliation?: boolean }): PendingOrderRow[] {
    const rows = this.db
      .prepare(
        `SELECT order_id AS orderId, leader_id AS leaderId, token_id AS tokenId, side,
                price, size, filled_shares AS filledShares, filled_usd AS filledUsd,
                fee_usd AS feeUsd,
                leader_price AS leaderPrice, executable_price AS executablePrice,
                slippage_pct AS slippagePct, trade_key AS tradeKey,
                reasoning, created_at AS createdAt, updated_at AS updatedAt,
                reconciliation_only AS reconciliationOnly,
                reconciliation_started_at AS reconciliationStartedAt,
                decision_terms_json AS decisionTermsJson
         FROM pending_orders
         WHERE reconciliation_only = 0 OR ? = 1
         ORDER BY created_at ASC`
      )
      .all(options?.includeReconciliation ? 1 : 0) as Array<Omit<PendingOrderRow, "decisionTerms"> & {
        decisionTermsJson: string;
      }>;
    return rows.map(({ decisionTermsJson, ...row }) => ({
      ...row,
      side: row.side as "BUY" | "SELL",
      reconciliationOnly: Boolean(row.reconciliationOnly),
      decisionTerms: this.parseDecisionTerms(decisionTermsJson),
    }));
  }

  countPendingOrders(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM pending_orders WHERE reconciliation_only = 0").get() as { c: number };
    return row.c;
  }

  countReconcilingOrders(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM pending_orders WHERE reconciliation_only = 1")
      .get() as { c: number };
    return row.c;
  }

  updatePendingOrderFilled(orderId: string, filledShares: number): void {
    this.db
      .prepare(
        "UPDATE pending_orders SET filled_shares = ?, updated_at = ? WHERE order_id = ?"
      )
      .run(filledShares, Date.now(), orderId);
  }

  removePendingOrder(orderId: string): void {
    this.db.prepare("DELETE FROM pending_orders WHERE order_id = ?").run(orderId);
  }

  retirePendingReconciliation(row: PendingOrderRow, reason: string): void {
    this.db.transaction(() => {
      this.audit({
        leaderId: row.leaderId,
        action: "ERROR",
        tokenId: row.tokenId,
        side: row.side,
        size: Math.max(0, row.size - row.filledShares),
        price: row.price,
        leaderPrice: row.leaderPrice ?? undefined,
        executablePrice: row.executablePrice,
        slippagePct: row.slippagePct,
        reason,
        preview: false,
      });
      this.removePendingOrder(row.orderId);
    })();
  }

  removeStalePendingOrders(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db
      .prepare("DELETE FROM pending_orders WHERE created_at < ? AND reconciliation_only = 0")
      .run(cutoff);
    return result.changes;
  }

  recordLiveOrderIntent(entry: {
    tradeKeys: string[];
    leaderId: string;
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    leaderPrice?: number;
    executablePrice?: number | null;
    slippagePct?: number | null;
    orderSize: number;
    auditReason: string;
    market?: TokenMarketEntry;
    decisionTerms?: Record<string, unknown>;
  }): string {
    const tradeKeys = uniqueTradeKeys(entry.tradeKeys);
    if (tradeKeys.length === 0) throw new Error("live order intent requires trade keys");
    const intentId = makeLiveOrderIntentId(entry.leaderId, tradeKeys);
    const now = Date.now();
    const observationRefsJson = JSON.stringify(this.observationRefsForRawEventIds(this.decisionRawEventIds));
    this.db
      .prepare(
        `INSERT INTO live_order_intents
         (intent_id, leader_id, token_id, side, price, leader_price, executable_price,
          slippage_pct, size, trade_keys, reasoning, market_json, created_at, updated_at,
          reconciliation_until, observation_refs_json, decision_terms_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(intent_id) DO UPDATE SET
           token_id = excluded.token_id,
           side = excluded.side,
           price = excluded.price,
           leader_price = excluded.leader_price,
           executable_price = excluded.executable_price,
           slippage_pct = excluded.slippage_pct,
           size = excluded.size,
           trade_keys = excluded.trade_keys,
           reasoning = excluded.reasoning,
           market_json = excluded.market_json,
           observation_refs_json = excluded.observation_refs_json,
           decision_terms_json = excluded.decision_terms_json,
           reconciliation_until = excluded.reconciliation_until,
           updated_at = excluded.updated_at`
      )
      .run(
        intentId,
        entry.leaderId,
        entry.tokenId,
        entry.side,
        entry.price,
        entry.leaderPrice ?? null,
        entry.executablePrice ?? null,
        entry.slippagePct ?? null,
        entry.orderSize,
        JSON.stringify(tradeKeys),
        entry.auditReason,
        entry.market ? JSON.stringify(entry.market) : null,
        now,
        now,
        now + FILL_RECONCILIATION_WINDOW_MS,
        observationRefsJson,
        normalizedPayloadJson(entry.decisionTerms ?? {})
      );
    return intentId;
  }

  listLiveOrderIntents(options?: { includeReconciliation?: boolean }): LiveOrderIntentRow[] {
    const rows = this.db
      .prepare(
        `SELECT intent_id AS intentId, leader_id AS leaderId, token_id AS tokenId,
                side, price, leader_price AS leaderPrice, executable_price AS executablePrice,
                slippage_pct AS slippagePct, size, trade_keys AS tradeKeys, reasoning, market_json AS marketJson,
                created_at AS createdAt, updated_at AS updatedAt,
                reconciliation_only AS reconciliationOnly,
                reconciliation_until AS reconciliationUntil,
                decision_terms_json AS decisionTermsJson
         FROM live_order_intents
         WHERE reconciliation_only = 0 OR ? = 1
         ORDER BY created_at ASC`
      )
      .all(options?.includeReconciliation ? 1 : 0) as Array<
      Omit<LiveOrderIntentRow, "tradeKeys" | "market" | "side" | "decisionTerms"> & {
        side: string;
        tradeKeys: string;
        marketJson: string | null;
        decisionTermsJson: string;
      }
    >;
    return rows.map((r) => {
      let tradeKeys: string[] = [];
      try {
        const parsed = JSON.parse(r.tradeKeys) as unknown;
        if (Array.isArray(parsed)) tradeKeys = uniqueTradeKeys(parsed.map(String));
      } catch {
        tradeKeys = [];
      }
      return {
        intentId: r.intentId,
        leaderId: r.leaderId,
        tokenId: r.tokenId,
        side: r.side === "SELL" ? "SELL" : "BUY",
        price: r.price,
        leaderPrice: r.leaderPrice,
        executablePrice: r.executablePrice,
        slippagePct: r.slippagePct,
        size: r.size,
        tradeKeys,
        reasoning: r.reasoning,
        market: parseMarketJson(r.marketJson),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        reconciliationOnly: Boolean(r.reconciliationOnly),
        reconciliationUntil: r.reconciliationUntil,
        decisionTerms: this.parseDecisionTerms(r.decisionTermsJson),
      };
    });
  }

  hasLiveOrderIntentForAnyKey(keys: string[]): boolean {
    const wanted = new Set(uniqueTradeKeys(keys));
    if (wanted.size === 0) return false;
    return this.listLiveOrderIntents().some((intent) =>
      intent.tradeKeys.some((key) => wanted.has(key))
    );
  }

  countQuarantinedLiveOrderIntents(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM live_order_intents WHERE reconciliation_only = 1")
      .get() as { c: number };
    return row.c;
  }

  deleteLiveOrderIntent(intentId: string): void {
    this.db.prepare("DELETE FROM live_order_intents WHERE intent_id = ?").run(intentId);
  }

  quarantineLiveOrderIntentAsUncertain(intent: LiveOrderIntentRow, reason: string): void {
    this.db.transaction(() => {
      for (const key of intent.tradeKeys) {
        this.markSeen(key, intent.leaderId);
      }
      this.audit({
        leaderId: intent.leaderId,
        action: "ERROR",
        tokenId: intent.tokenId,
        side: intent.side,
        size: intent.size,
        price: intent.price,
        leaderPrice: intent.leaderPrice ?? undefined,
        executablePrice: intent.executablePrice,
        slippagePct: intent.slippagePct,
        reason,
        preview: false,
      });
      this.db
        .prepare("UPDATE live_order_intents SET reconciliation_only = 1, updated_at = ? WHERE intent_id = ?")
        .run(Date.now(), intent.intentId);
    })();
  }

  /** Apply a pending-order partial fill atomically (position, volume, audit). */
  recordPendingFill(entry: {
    leaderId: string;
    tokenId: string;
    side: "BUY" | "SELL";
    delta: number;
    price: number;
    auditReason: string;
    preview: boolean;
  }): void {
    this.commitPendingOrderProgress({
      orderId: "",
      matchedFilledShares: -1,
      fill: entry,
      remove: false,
      skipPendingRowUpdate: true,
    });
  }

  /**
   * Atomically apply pending fill (optional), update filled_shares or remove the row.
   * Prevents double-counting when fill and row state were previously separate writes.
   */
  commitPendingOrderProgress(entry: {
    orderId: string;
    matchedFilledShares: number;
    matchedFilledUsd?: number;
    matchedFeeUsd?: number;
    fill?: {
      leaderId: string;
      tokenId: string;
      side: "BUY" | "SELL";
      delta: number;
      price: number;
      feeUsd?: number;
      leaderPrice?: number;
      executablePrice?: number | null;
      slippagePct?: number | null;
      auditReason: string;
      preview: boolean;
      cashInitialUsd?: number;
      market?: TokenMarketEntry;
    };
    remove: boolean;
    reconciliationOnly?: boolean;
    reconciliationStartedAt?: number;
    skipPendingRowUpdate?: boolean;
    staleSkipAudit?: {
      leaderId: string;
      tokenId: string;
      side: "BUY" | "SELL";
      size: number;
      price: number;
      preview: boolean;
    };
  }): void {
    const {
      orderId,
      matchedFilledShares,
      matchedFilledUsd,
      matchedFeeUsd,
      fill,
      remove,
      reconciliationOnly,
      reconciliationStartedAt,
      skipPendingRowUpdate,
      staleSkipAudit,
    } = entry;

    const previousDecisionRawEventIds = this.decisionRawEventIds;
    const previousDecisionObservationRefs = [...this.decisionObservationRefs];
    const pendingLineage = orderId
      ? this.db.prepare(
        `SELECT trade_key AS tradeKey, price, size, leader_price AS leaderPrice,
                  executable_price AS executablePrice, slippage_pct AS slippagePct,
                  observation_refs_json AS observationRefsJson,
                  decision_terms_json AS decisionTermsJson
           FROM pending_orders WHERE order_id = ?`
        ).get(orderId) as {
          tradeKey: string;
          price: number;
          size: number;
          leaderPrice: number | null;
          executablePrice: number | null;
          slippagePct: number | null;
          observationRefsJson: string;
          decisionTermsJson: string;
        } | undefined
      : undefined;
    if (this.decisionRawEventIds.length === 0 && orderId) {
      if (pendingLineage) {
        const refs = this.parseObservationRefs(pendingLineage.observationRefsJson);
        this.setDecisionObservationRefs(refs.length > 0
          ? refs
          : this.observationRefsForSourceKeys([pendingLineage.tradeKey]));
      }
    }
    const apply = this.db.transaction(() => {
      if (fill && fill.delta > 0) {
        const reportedUsd = fill.delta * fill.price;
        const feeUsd = fill.feeUsd ?? 0;
        const accountingPrice = feeAdjustedPrice(
          fill.side,
          fill.delta,
          reportedUsd,
          feeUsd,
          fill.price
        );
        if (fill.market) this.upsertTokenMarket(fill.market);
        const applied = this.applyCopyFill(
          fill.leaderId,
          fill.tokenId,
          fill.side,
          fill.delta,
          accountingPrice
        );
        const appliedShares =
          fill.side === "SELL" ? applied.appliedShares : fill.delta;
        const usd = appliedFillUsd(
          fill.side,
          fill.delta,
          reportedUsd,
          appliedShares,
          fill.price
        );
        const appliedFee = appliedFeeUsd(
          fill.side,
          fill.delta,
          feeUsd,
          appliedShares
        );
        const cashUsd = fill.side === "BUY" ? usd + appliedFee : usd - appliedFee;
        if (fill.side === "BUY") this.recordBuy(fill.leaderId, fill.tokenId);
        this.addDailyVolume(fill.side === "BUY" ? usd : 0);
        if (fill.side === "BUY") this.addLeaderDailyVolume(fill.leaderId, usd);
        if (fill.preview && fill.cashInitialUsd !== undefined) {
          this.adjustCash(fill.side === "BUY" ? -cashUsd : cashUsd, fill.cashInitialUsd);
        }
        this.audit({
          leaderId: fill.leaderId,
          action: "COPY",
          tokenId: fill.tokenId,
          side: fill.side,
          size: appliedShares,
          price: fill.price,
          leaderPrice: fill.leaderPrice,
          executablePrice: fill.executablePrice,
          slippagePct: fill.slippagePct,
          feeUsd: appliedFee,
          reason: fill.auditReason,
          preview: fill.preview,
          exactTerms: pendingLineage
            ? {
                orderId,
                orderType: "GTC",
                requestedPrice: pendingLineage.price,
                requestedShares: pendingLineage.size,
                ...this.parseDecisionTerms(pendingLineage.decisionTermsJson),
                filledShares: matchedFilledShares,
                filledUsd: matchedFilledUsd ?? fill.delta * fill.price,
                matchedFeeUsd: matchedFeeUsd ?? fill.feeUsd ?? 0,
                leaderPrice: fill.leaderPrice ?? pendingLineage.leaderPrice,
                executablePrice: fill.executablePrice !== undefined
                  ? fill.executablePrice
                  : pendingLineage.executablePrice,
                slippagePct: fill.slippagePct !== undefined
                  ? fill.slippagePct
                  : pendingLineage.slippagePct,
                reconciliationOnly: reconciliationOnly ?? false,
              }
            : undefined,
        });
      }

      if (staleSkipAudit) {
        this.audit({
          leaderId: staleSkipAudit.leaderId,
          action: "SKIP",
          tokenId: staleSkipAudit.tokenId,
          side: staleSkipAudit.side,
          size: staleSkipAudit.size,
          price: staleSkipAudit.price,
          reason: "stale GTC cancelled on CLOB",
          preview: staleSkipAudit.preview,
        });
      }

      if (skipPendingRowUpdate) return;

      if (remove) {
        this.db.prepare("DELETE FROM pending_orders WHERE order_id = ?").run(orderId);
      } else {
        this.db
          .prepare(
            `UPDATE pending_orders
             SET filled_shares = ?, filled_usd = COALESCE(?, filled_usd),
                 fee_usd = COALESCE(?, fee_usd),
                 reconciliation_only = COALESCE(?, reconciliation_only),
                 reconciliation_started_at = COALESCE(?, reconciliation_started_at), updated_at = ?
             WHERE order_id = ?`
          )
          .run(
            matchedFilledShares,
            matchedFilledUsd ?? null,
            matchedFeeUsd ?? null,
            reconciliationOnly === undefined ? null : reconciliationOnly ? 1 : 0,
            reconciliationStartedAt ?? null,
            Date.now(),
            orderId
          );
      }
    });
    try {
      apply();
    } finally {
      this.decisionRawEventIds = previousDecisionRawEventIds;
      this.decisionObservationRefs = previousDecisionObservationRefs;
    }
  }

  /** Record a successful copy trade atomically (dedup, position, volume, audit). */
  recordCopySuccess(entry: {
    tradeKey?: string;
    tradeKeys?: string[];
    leaderId: string;
    tokenId: string;
    side: "BUY" | "SELL";
    filledShares: number;
    price: number;
    leaderPrice?: number;
    executablePrice?: number | null;
    slippagePct?: number | null;
    filledUsd: number;
    feeUsd?: number;
    auditReason: string;
    preview: boolean;
    cashInitialUsd?: number;
    market?: TokenMarketEntry;
    decisionTerms?: Record<string, unknown>;
  }): void {
    const {
      tradeKey,
      tradeKeys,
      leaderId,
      tokenId,
      side,
      filledShares,
      price,
      leaderPrice,
      executablePrice,
      slippagePct,
      filledUsd,
      feeUsd = 0,
      auditReason,
      preview,
      cashInitialUsd,
      market,
      decisionTerms,
    } = entry;
    const keys = tradeKeys ?? (tradeKey ? [tradeKey] : []);
    const previousDecisionRawEventIds = this.decisionRawEventIds;
    const previousDecisionObservationRefs = [...this.decisionObservationRefs];
    if (this.decisionRawEventIds.length === 0) {
      this.setDecisionObservationRefs(this.observationRefsForSourceKeys(keys));
    }
    const apply = this.db.transaction(() => {
      for (const key of keys) {
        this.markSeen(key, leaderId);
      }
      if (market) this.upsertTokenMarket(market);
      const accountingPrice = feeAdjustedPrice(side, filledShares, filledUsd, feeUsd, price);
      const applied = this.applyCopyFill(leaderId, tokenId, side, filledShares, accountingPrice);
      const appliedShares = side === "SELL" ? applied.appliedShares : filledShares;
      const appliedUsd = appliedFillUsd(
        side,
        filledShares,
        filledUsd,
        appliedShares,
        price
      );
      const appliedFee = appliedFeeUsd(side, filledShares, feeUsd, appliedShares);
      const cashUsd = side === "BUY" ? appliedUsd + appliedFee : appliedUsd - appliedFee;
      if (side === "BUY") this.recordBuy(leaderId, tokenId);
      this.addDailyVolume(side === "BUY" ? appliedUsd : 0);
      if (side === "BUY") this.addLeaderDailyVolume(leaderId, appliedUsd);
      if (preview && cashInitialUsd !== undefined) {
        this.adjustCash(side === "BUY" ? -cashUsd : cashUsd, cashInitialUsd);
      }
      this.audit({
        leaderId,
        action: "COPY",
        tokenId,
        side,
        size: appliedShares,
        price,
        leaderPrice,
        executablePrice,
        slippagePct,
        feeUsd: appliedFee,
        reason: auditReason,
        preview,
        exactTerms: decisionTerms ?? {
          requestedPrice: price,
          requestedShares: filledShares,
          filledShares,
          appliedShares,
          filledUsd,
          feeUsd,
          recovery: true,
        },
      });
    });
    try {
      apply();
    } finally {
      this.decisionRawEventIds = previousDecisionRawEventIds;
      this.decisionObservationRefs = previousDecisionObservationRefs;
    }
  }

  /**
   * Live: atomically mark trade keys seen, optional GTC pending row, and any immediate fill.
   * Prevents crash between CLOB accept and dedup/pending persistence.
   */
  recordLiveOrderAccepted(entry: {
    tradeKeys: string[];
    leaderId: string;
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    leaderPrice?: number;
    executablePrice?: number | null;
    slippagePct?: number | null;
    orderSize: number;
    filledShares: number;
    filledUsd: number;
    feeUsd?: number;
    auditReason: string;
    orderId?: string;
    pendingRemaining: number;
    trackPendingGtc: boolean;
    market?: TokenMarketEntry;
    intentId?: string;
    decisionTerms?: Record<string, unknown>;
  }): void {
    const {
      tradeKeys,
      leaderId,
      tokenId,
      side,
      price,
      leaderPrice,
      executablePrice,
      slippagePct,
      orderSize,
      filledShares,
      filledUsd,
      feeUsd = 0,
      auditReason,
      orderId,
      pendingRemaining,
      trackPendingGtc,
      market,
      intentId,
      decisionTerms,
    } = entry;
    const primaryKey = tradeKeys[0] ?? "";
    const now = Date.now();
    const previousDecisionRawEventIds = this.decisionRawEventIds;
    const previousDecisionObservationRefs = [...this.decisionObservationRefs];
    if (this.decisionRawEventIds.length === 0) {
      const persisted = intentId
        ? this.db.prepare("SELECT observation_refs_json AS refs FROM live_order_intents WHERE intent_id=?")
            .get(intentId) as { refs: string } | undefined
        : undefined;
      const refs = this.parseObservationRefs(persisted?.refs);
      this.setDecisionObservationRefs(refs.length > 0 ? refs : this.observationRefsForSourceKeys(tradeKeys));
    }
    const observationRefsJson = JSON.stringify(this.observationRefsForRawEventIds(this.decisionRawEventIds));
    const persistedDecisionTerms = decisionTerms ?? {
      orderType: trackPendingGtc ? "GTC" : "IMMEDIATE",
      requestedPrice: price,
      requestedShares: orderSize,
    };
    const persistedRequestedPrice = typeof persistedDecisionTerms.requestedPrice === "number" &&
      Number.isFinite(persistedDecisionTerms.requestedPrice)
      ? persistedDecisionTerms.requestedPrice
      : price;
    const persistedRequestedShares = typeof persistedDecisionTerms.requestedShares === "number" &&
      Number.isFinite(persistedDecisionTerms.requestedShares)
      ? persistedDecisionTerms.requestedShares
      : orderSize;

    const apply = this.db.transaction(() => {
      for (const key of [...new Set(tradeKeys)]) {
        this.markSeen(key, leaderId);
      }
      if (market) this.upsertTokenMarket(market);

      if (
        trackPendingGtc &&
        orderId &&
        pendingRemaining > 0.001 &&
        primaryKey
      ) {
        this.db
          .prepare(
            `INSERT INTO pending_orders
             (order_id, leader_id, token_id, side, price, size, filled_shares, filled_usd, fee_usd,
              leader_price, executable_price, slippage_pct, trade_key, reasoning, created_at, updated_at,
              observation_refs_json, decision_terms_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(order_id) DO UPDATE SET
               filled_shares = excluded.filled_shares,
               filled_usd = excluded.filled_usd,
               fee_usd = excluded.fee_usd,
               leader_price = excluded.leader_price,
               executable_price = excluded.executable_price,
               slippage_pct = excluded.slippage_pct,
               observation_refs_json = excluded.observation_refs_json,
               decision_terms_json = excluded.decision_terms_json,
               updated_at = excluded.updated_at`
          )
          .run(
            orderId,
            leaderId,
            tokenId,
            side,
            persistedRequestedPrice,
            persistedRequestedShares,
            filledShares,
            filledUsd,
            feeUsd,
            leaderPrice ?? null,
            executablePrice ?? null,
            slippagePct ?? null,
            primaryKey,
            auditReason,
            now,
            now,
            observationRefsJson,
            normalizedPayloadJson(persistedDecisionTerms)
          );
      }

      if (filledShares > 0) {
        const accountingPrice = feeAdjustedPrice(side, filledShares, filledUsd, feeUsd, price);
        const applied = this.applyCopyFill(leaderId, tokenId, side, filledShares, accountingPrice);
        const appliedShares = side === "SELL" ? applied.appliedShares : filledShares;
        const appliedUsd = appliedFillUsd(
          side,
          filledShares,
          filledUsd,
          appliedShares,
          price
        );
        const appliedFee = appliedFeeUsd(side, filledShares, feeUsd, appliedShares);
        if (side === "BUY") this.recordBuy(leaderId, tokenId);
        this.addDailyVolume(side === "BUY" ? appliedUsd : 0);
        if (side === "BUY") this.addLeaderDailyVolume(leaderId, appliedUsd);
        this.audit({
          leaderId,
          action: "COPY",
          tokenId,
          side,
          size: appliedShares,
          price,
          leaderPrice,
          executablePrice,
          slippagePct,
          feeUsd: appliedFee,
          reason: auditReason,
          preview: false,
          exactTerms: {
            ...persistedDecisionTerms,
            orderId: orderId ?? null,
            filledShares,
            appliedShares,
            filledUsd,
            feeUsd,
            pendingRemaining,
          },
        });
      }

      if (intentId) {
        this.db.prepare("DELETE FROM live_order_intents WHERE intent_id = ?").run(intentId);
      }
    });
    try {
      apply();
    } finally {
      this.decisionRawEventIds = previousDecisionRawEventIds;
      this.decisionObservationRefs = previousDecisionObservationRefs;
    }
  }

  /** Set pending order timestamps (for tests / recovery). */
  setPendingOrderTimestamps(orderId: string, createdAt: number, updatedAt?: number): void {
    this.db
      .prepare("UPDATE pending_orders SET created_at = ?, updated_at = ? WHERE order_id = ?")
      .run(createdAt, updatedAt ?? createdAt, orderId);
  }

  /** Set live order intent timestamps (for tests / recovery). */
  setLiveOrderIntentTimestamps(intentId: string, createdAt: number, updatedAt?: number): void {
    this.db
      .prepare(
        "UPDATE live_order_intents SET created_at = ?, updated_at = ?, reconciliation_until = ? WHERE intent_id = ?"
      )
      .run(createdAt, updatedAt ?? createdAt, createdAt + FILL_RECONCILIATION_WINDOW_MS, intentId);
  }

  audit(entry: {
    leaderId?: string;
    action: AuditAction;
    tokenId?: string;
    side?: string;
    size?: number;
    price?: number;
    leaderPrice?: number;
    executablePrice?: number | null;
    slippagePct?: number | null;
    feeUsd?: number;
    reason?: string;
    preview: boolean;
    exactTerms?: Record<string, unknown>;
    reasonCode?: DecisionReasonCode;
  }): void {
    this.db.transaction(() => {
      const ts = Date.now();
      const experimentId = this.getActiveExperiment()?.experimentId ?? null;
      const decisionAction: DecisionAction | null = entry.action === "ERROR"
        ? null
        : entry.action === "COPY" && entry.side === "SELL"
          ? "SELL"
          : entry.action;
      let decisionId: string | null = null;
      if (decisionAction) {
        const reasonCode = entry.reasonCode ?? (decisionAction === "DETECT"
          ? "detected"
          : decisionAction === "COPY"
            ? "copy_executed"
            : decisionAction === "SELL"
              ? "sell_executed"
              : decisionAction === "REDEEM"
                ? "redeem_settled"
                : stableSkipReasonCode(entry.reason));
        const exactTerms: Record<string, unknown> = {
          leaderId: entry.leaderId ?? null,
          tokenId: entry.tokenId ?? null,
          side: entry.side ?? null,
          size: entry.size ?? null,
          price: entry.price ?? null,
          leaderPrice: entry.leaderPrice ?? null,
          executablePrice: entry.executablePrice ?? null,
          slippagePct: entry.slippagePct ?? null,
          feeUsd: entry.feeUsd ?? 0,
          reason: entry.reason ?? null,
          preview: entry.preview,
          ...entry.exactTerms,
        };
        const observationRefs = this.observationRefsForRawEventIds(this.decisionRawEventIds);
        if (this.decisionRawEventIds.length > 0 && observationRefs.length === 0) {
          throw new Error("Cannot persist decision without raw observation evidence");
        }
        const primary = observationRefs[0];
        if (primary) {
          decisionId = this.recordDecision({
            rawEventId: primary.rawEventId,
            action: decisionAction,
            reasonCode,
            exactTerms,
            observationRefs,
            decidedAt: ts,
          }).decisionId;
        }
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO audit_log
           (ts, leader_id, action, token_id, side, size, price, leader_price,
            executable_price, slippage_pct, fee_usd, reason, preview, experiment_id, decision_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ts,
          entry.leaderId ?? null,
          entry.action,
          entry.tokenId ?? null,
          entry.side ?? null,
          entry.size ?? null,
          entry.price ?? null,
          entry.leaderPrice ?? null,
          entry.executablePrice ?? null,
          entry.slippagePct ?? null,
          entry.feeUsd ?? 0,
          entry.reason ?? null,
          entry.preview ? 1 : 0,
          experimentId,
          decisionId
        );
    })();
  }

  getDailyVolumeUsd(): number {
    const row = this.db
      .prepare("SELECT volume_usd FROM daily_stats WHERE date = ?")
      .get(todayKey()) as { volume_usd: number } | undefined;
    return row?.volume_usd ?? 0;
  }

  addDailyVolume(usd: number): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, volume_usd, copy_count) VALUES (?, ?, 1)
         ON CONFLICT(date) DO UPDATE SET
           volume_usd = volume_usd + excluded.volume_usd,
           copy_count = copy_count + 1`
      )
      .run(todayKey(), usd);
  }

  getLeaderDailyVolumeUsd(leaderId: string): number {
    const row = this.db
      .prepare("SELECT volume_usd FROM leader_daily_stats WHERE date = ? AND leader_id = ?")
      .get(todayKey(), leaderId) as { volume_usd: number } | undefined;
    return row?.volume_usd ?? 0;
  }

  addLeaderDailyVolume(leaderId: string, usd: number): void {
    this.db
      .prepare(
        `INSERT INTO leader_daily_stats (date, leader_id, volume_usd) VALUES (?, ?, ?)
         ON CONFLICT(date, leader_id) DO UPDATE SET volume_usd = volume_usd + excluded.volume_usd`
      )
      .run(todayKey(), leaderId, usd);
  }

  getDailyRealizedPnl(): number {
    const row = this.db
      .prepare("SELECT realized_pnl FROM daily_stats WHERE date = ?")
      .get(todayKey()) as { realized_pnl: number } | undefined;
    return row?.realized_pnl ?? 0;
  }

  getTotalRealizedPnl(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(realized_pnl), 0) AS realizedPnl FROM daily_stats"
    ).get() as { realizedPnl: number };
    return row.realizedPnl;
  }

  addRealizedPnl(delta: number): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, realized_pnl) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET realized_pnl = realized_pnl + excluded.realized_pnl`
      )
      .run(todayKey(), delta);
  }

  triggerKillSwitch(reasonCode = "DAILY_LOSS_CAP"): void {
    const normalizedReason = requiredAggregateKey("reasonCode", reasonCode);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO daily_stats (date, kill_switch) VALUES (?, 1)
           ON CONFLICT(date) DO UPDATE SET kill_switch = 1`
        )
        .run(todayKey());
      const experiment = this.getActiveExperiment();
      if (!experiment) {
        this.db.prepare(
          `INSERT INTO runtime_metadata (key, value)
           VALUES ('legacy_kill_switch_backfill_pending', '1')
           ON CONFLICT(key) DO UPDATE SET value = '1'`
        ).run();
        return;
      }
      const control = this.getExperimentControl(experiment.experimentId)!;
      if (control.state === "ACTIVE") {
        this.setExperimentControl({
          experimentId: experiment.experimentId,
          state: "SETTLE_ONLY",
          reasonCode: normalizedReason,
          details: { source: "kill_switch" },
        });
      }
    })();
  }

  resetKillSwitch(): void {
    const experiment = this.getActiveExperiment();
    if (experiment) {
      const control = this.getExperimentControl(experiment.experimentId)!;
      if (control.state !== "ACTIVE") {
        throw new Error("Sticky experiment control cannot reset; start a new experiment or use reviewed DATA recovery");
      }
    }
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, kill_switch) VALUES (?, 0)
         ON CONFLICT(date) DO UPDATE SET kill_switch = 0`
      )
      .run(todayKey());
  }

  isKillSwitchActive(): boolean {
    const experiment = this.getActiveExperiment();
    if (experiment) {
      return this.getExperimentControl(experiment.experimentId)!.state !== "ACTIVE";
    }
    const row = this.db
      .prepare("SELECT kill_switch FROM daily_stats WHERE date = ?")
      .get(todayKey()) as { kill_switch: number } | undefined;
    return (row?.kill_switch ?? 0) === 1;
  }

  hasRecentBuy(leaderId: string, tokenId: string, windowMs: number): boolean {
    const since = Date.now() - windowMs;
    const row = this.db
      .prepare(
        `SELECT 1 FROM buy_dedup WHERE leader_id = ? AND token_id = ? AND created_at > ? LIMIT 1`
      )
      .get(leaderId, tokenId, since);
    return row !== undefined;
  }

  recordBuy(leaderId: string, tokenId: string): void {
    this.db
      .prepare("INSERT INTO buy_dedup (leader_id, token_id, created_at) VALUES (?, ?, ?)")
      .run(leaderId, tokenId, Date.now());
    this.db.prepare("DELETE FROM buy_dedup WHERE created_at < ?").run(Date.now() - 86400000);
  }

  listAuditLog(options: {
    limit?: number;
    offset?: number;
    leaderId?: string;
    action?: AuditAction;
  } = {}): { items: AuditLogRow[]; total: number } {
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.leaderId) {
      conditions.push("leader_id = ?");
      params.push(options.leaderId);
    }
    if (options.action) {
      conditions.push("action = ?");
      params.push(options.action);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_log ${where}`)
      .get(...params) as { c: number };

    const items = this.db
      .prepare(
        `SELECT id, ts, leader_id AS leaderId, action, token_id AS tokenId, side,
                size, price, leader_price AS leaderPrice,
                executable_price AS executablePrice, slippage_pct AS slippagePct,
                fee_usd AS feeUsd,
                reason, preview, decision_id AS decisionId
         FROM audit_log ${where}
         ORDER BY ts DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as AuditLogRow[];

    return {
      items: items.map((r) => ({ ...r, preview: Boolean(r.preview) })),
      total: totalRow.c,
    };
  }

  listAuditAfterId(afterId: number, limit = 100): AuditLogRow[] {
    const items = this.db
      .prepare(
        `SELECT id, ts, leader_id AS leaderId, action, token_id AS tokenId, side,
                size, price, leader_price AS leaderPrice,
                executable_price AS executablePrice, slippage_pct AS slippagePct,
                fee_usd AS feeUsd,
                reason, preview, decision_id AS decisionId
         FROM audit_log
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(afterId, limit) as AuditLogRow[];

    return items.map((r) => ({ ...r, preview: Boolean(r.preview) }));
  }

  getMaxAuditId(): number {
    const row = this.db.prepare("SELECT MAX(id) AS maxId FROM audit_log").get() as {
      maxId: number | null;
    };
    return row.maxId ?? 0;
  }

  getHourlyAuditStats(hours: number): {
    bucketMs: number;
    copyCount: number;
    skipCount: number;
    errorCount: number;
  }[] {
    const clampedHours = Math.min(48, Math.max(1, hours));
    const since = Date.now() - clampedHours * 3600_000;
    const hourMs = 3600_000;

    const rows = this.db
      .prepare(
        `SELECT
           CAST(ts / ? AS INTEGER) * ? AS bucketMs,
           SUM(CASE WHEN action = 'COPY' THEN 1 ELSE 0 END) AS copyCount,
           SUM(CASE WHEN action = 'SKIP' THEN 1 ELSE 0 END) AS skipCount,
           SUM(CASE WHEN action = 'ERROR' THEN 1 ELSE 0 END) AS errorCount
         FROM audit_log
         WHERE ts >= ?
         GROUP BY bucketMs
         ORDER BY bucketMs ASC`
      )
      .all(hourMs, hourMs, since) as {
      bucketMs: number;
      copyCount: number;
      skipCount: number;
      errorCount: number;
    }[];

    const byBucket = new Map(rows.map((r) => [r.bucketMs, r]));
    const startBucket = Math.floor(since / hourMs) * hourMs;
    const endBucket = Math.floor(Date.now() / hourMs) * hourMs;
    const buckets: {
      bucketMs: number;
      copyCount: number;
      skipCount: number;
      errorCount: number;
    }[] = [];

    for (let t = startBucket; t <= endBucket; t += hourMs) {
      const row = byBucket.get(t);
      buckets.push({
        bucketMs: t,
        copyCount: row?.copyCount ?? 0,
        skipCount: row?.skipCount ?? 0,
        errorCount: row?.errorCount ?? 0,
      });
    }

    return buckets;
  }

  listPositions(): PositionRow[] {
    return this.db
      .prepare(
        `SELECT leader_id AS leaderId, token_id AS tokenId, shares, avg_entry_price AS avgEntryPrice
         FROM positions WHERE shares > 0
         ORDER BY leader_id, token_id`
      )
      .all() as PositionRow[];
  }

  getTodayStats(): DailyStatsRow | null {
    const row = this.db
      .prepare(
        `SELECT date, volume_usd AS volumeUsd, realized_pnl AS realizedPnl,
                copy_count AS copyCount, kill_switch AS killSwitch
         FROM daily_stats WHERE date = ?`
      )
      .get(todayKey()) as DailyStatsRow | undefined;
    return row ?? null;
  }

  listLeaderTodayStats(): LeaderDailyStatsRow[] {
    return this.db
      .prepare(
        `SELECT leader_id AS leaderId, volume_usd AS volumeUsd
         FROM leader_daily_stats WHERE date = ?`
      )
      .all(todayKey()) as LeaderDailyStatsRow[];
  }

  close(): void {
    this.db.close();
  }
}
