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
export const STATE_SCHEMA_VERSION = 3;

export type AuditAction = "DETECT" | "SKIP" | "COPY" | "ERROR" | "REDEEM";

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

function stableSkipReasonCode(reason: string | undefined): DecisionReasonCode {
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
        reconciliation_started_at INTEGER
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
        reconciliation_until INTEGER NOT NULL
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
        BEGIN SELECT RAISE(ABORT, 'experiment manifest is immutable'); END;
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
        decided_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_raw_event ON decisions(raw_event_id, decided_at);
      CREATE TRIGGER IF NOT EXISTS decisions_no_update
        BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS decisions_no_delete
        BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
    `);
    this.db.transaction(() => {
      this.migrate();
      this.db.exec(`
        DROP INDEX IF EXISTS idx_experiments_active_account;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_active_account
          ON experiments(account_id) WHERE state = 'ACTIVE' AND ended_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_event_observations_identity
          ON raw_event_observations(observation_key) WHERE observation_key IS NOT NULL;
      `);
      this.db.prepare(
        `INSERT INTO schema_metadata (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(String(STATE_SCHEMA_VERSION));
    })();
    this.reconcileOrphanPreparedExperiments();
  }

  private reconcileOrphanPreparedExperiments(now = Date.now()): void {
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
      const sameIdentity = active?.configHash === hash
        && JSON.stringify(active.candidateAddresses) === JSON.stringify(candidates)
        && active.gitSha === input.gitSha
        && active.imageDigest === input.imageDigest
        && active.lockfileHash === input.lockfileHash
        && active.schemaVersion === STATE_SCHEMA_VERSION
        && active.trustClass === input.trustClass;
      if (sameIdentity) return active!;
      if (active && !preparing) {
        this.db.prepare("UPDATE experiments SET ended_at = ? WHERE experiment_id = ?")
          .run(now, active.experimentId);
        this.db.prepare("UPDATE experiments SET state = 'ENDED' WHERE experiment_id = ?")
          .run(active.experimentId);
      }
      const experimentId = newExperimentId(input.accountId, hash);
      this.db.prepare(
        `INSERT INTO experiments
         (experiment_id, account_id, candidate_addresses_json, canonical_config_json,
          config_hash, git_sha, image_digest, lockfile_hash, schema_version,
          started_at, trust_class, state, previous_experiment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        active?.experimentId ?? null
      );
      return this.getExperiment(experimentId)!;
    })();
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
       FROM experiments WHERE experiment_id = ?`
    ).get(experimentId) as (Omit<ExperimentManifestRow, "candidateAddresses"> & { candidateAddressesJson: string }) | undefined;
    if (!row) return undefined;
    const { candidateAddressesJson, ...rest } = row;
    return { ...rest, candidateAddresses: JSON.parse(candidateAddressesJson) as string[] };
  }

  getActiveExperiment(accountId?: string): ExperimentManifestRow | undefined {
    const row = this.db.prepare(
      `SELECT experiment_id AS experimentId FROM experiments
       WHERE state = 'ACTIVE' AND ended_at IS NULL AND (? IS NULL OR account_id = ?) ORDER BY started_at DESC LIMIT 1`
    ).get(accountId ?? null, accountId ?? null) as { experimentId: string } | undefined;
    return row ? this.getExperiment(row.experimentId) : undefined;
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
          "SELECT experiment_id AS experimentId, previous_experiment_id AS previousExperimentId FROM experiments WHERE experiment_id = ? AND state = 'PREPARED'"
        ).get(experimentId) as { experimentId: string; previousExperimentId: string | null } | undefined;
        if (!row) continue;
        if (row.previousExperimentId) {
          this.db.prepare("UPDATE experiments SET state = 'ENDED', ended_at = ? WHERE experiment_id = ? AND state = 'ACTIVE'")
            .run(now, row.previousExperimentId);
        }
        this.db.prepare("UPDATE experiments SET state = 'ACTIVE' WHERE experiment_id = ? AND state = 'PREPARED'")
          .run(row.experimentId);
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
        this.db.prepare("UPDATE experiments SET state = 'ACTIVE', ended_at = NULL WHERE experiment_id = ?")
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
    return this.db.transaction(() => {
    const experiment = input.experimentId
      ? this.getExperiment(input.experimentId)
      : this.getActiveExperiment();
    if (!experiment) throw new Error("Cannot record raw event without an active experiment");
    const payloadHash = payloadSha256(input.payload);
    const sourceId = input.sourceId?.trim() || null;
    const identity = sourceId ? `source:${sourceId}` : `payload:${payloadHash}`;
    const rawEventId = createHash("sha256")
      .update(`${experiment.experimentId}\n${identity}`)
      .digest("hex");
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
      normalizedPayloadJson(input.payload),
      input.sourceTimestamp,
      input.observedTimestamp ?? Date.now()
    );
    const row = sourceId
      ? this.db.prepare("SELECT raw_event_id AS rawEventId FROM raw_events WHERE experiment_id = ? AND source_id = ?")
          .get(experiment.experimentId, sourceId) as { rawEventId: string }
      : this.db.prepare("SELECT raw_event_id AS rawEventId FROM raw_events WHERE experiment_id = ? AND payload_hash = ?")
          .get(experiment.experimentId, payloadHash) as { rawEventId: string };
    const observedTimestamp = input.observedTimestamp ?? Date.now();
    const observationKey = createHash("sha256")
      .update([row.rawEventId, payloadHash, input.sourceTimestamp, observedTimestamp].join("\n"))
      .digest("hex");
    this.db.prepare(
      `INSERT OR IGNORE INTO raw_event_observations
       (observation_key, raw_event_id, payload_hash, normalized_payload_json, source_timestamp, observed_timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      observationKey,
      row.rawEventId,
      payloadHash,
      normalizedPayloadJson(input.payload),
      input.sourceTimestamp,
      observedTimestamp
    );
    return this.getRawEvent(row.rawEventId)!;
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
  }): DecisionRow {
    const raw = this.getRawEvent(input.rawEventId);
    if (!raw) throw new Error(`Raw event not found: ${input.rawEventId}`);
    const exactTermsJson = normalizedPayloadJson(input.exactTerms);
    const decisionId = createHash("sha256")
      .update([raw.experimentId, raw.rawEventId, input.action, input.reasonCode, exactTermsJson].join("\n"))
      .digest("hex");
    this.db.prepare(
      `INSERT OR IGNORE INTO decisions
       (decision_id, experiment_id, raw_event_id, action, reason_code, exact_terms_json, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      decisionId,
      raw.experimentId,
      raw.rawEventId,
      input.action,
      input.reasonCode,
      exactTermsJson,
      input.decidedAt ?? Date.now()
    );
    return this.getDecision(decisionId)!;
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
      "SELECT decision_id AS decisionId FROM decisions ORDER BY decided_at, decision_id"
    ).all() as { decisionId: string }[];
    return ids.map((row) => this.getDecision(row.decisionId)!);
  }

  setDecisionRawEventIds(rawEventIds: string[]): void {
    this.decisionRawEventIds = [...new Set(rawEventIds)];
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
    const experimentCols = this.db.prepare("PRAGMA table_info(experiments)").all() as { name: string }[];
    if (!experimentCols.some((column) => column.name === "state")) {
      this.db.exec("ALTER TABLE experiments ADD COLUMN state TEXT NOT NULL DEFAULT 'ACTIVE'");
    }
    if (!experimentCols.some((column) => column.name === "previous_experiment_id")) {
      this.db.exec("ALTER TABLE experiments ADD COLUMN previous_experiment_id TEXT");
    }
    const observationCols = this.db.prepare("PRAGMA table_info(raw_event_observations)").all() as { name: string }[];
    if (!observationCols.some((column) => column.name === "observation_key")) {
      this.db.exec("ALTER TABLE raw_event_observations ADD COLUMN observation_key TEXT");
    }
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

      let settled = 0;
      for (const row of rows) {
        const payoutUsd = roundUsd(row.shares * payoutPerShare);
        const costUsd = roundUsd(row.shares * row.avgEntryPrice);
        const realizedPnl = roundUsd(payoutUsd - costUsd);

        this.db
          .prepare(
            `UPDATE positions
             SET shares = 0, avg_entry_price = 0
             WHERE leader_id = ? AND token_id = ?`
          )
          .run(row.leaderId, tokenId);

        if (realizedPnl !== 0) this.addRealizedPnl(realizedPnl);
        if (preview && cashInitialUsd !== undefined && payoutUsd !== 0) {
          this.adjustCash(payoutUsd, cashInitialUsd);
        }

        this.audit({
          leaderId: row.leaderId,
          action: "REDEEM",
          tokenId,
          side: "REDEEM",
          size: payoutUsd,
          price: row.shares,
          reason: `token settlement payout ${payoutPerShare}; pnl $${realizedPnl.toFixed(2)}`,
          preview,
          exactTerms: {
            settlementSource: "token_settlement",
            payoutPerShare,
            winnerTokenIds: payoutPerShare > 0 ? [tokenId] : [],
            costBasisUsd: costUsd,
            grossPayoutUsd: payoutUsd,
            realizedPnlUsd: realizedPnl,
            ...settlementTerms,
          },
        });
        settled++;
      }

      return settled;
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
                reconciliation_started_at AS reconciliationStartedAt
         FROM pending_orders
         WHERE reconciliation_only = 0 OR ? = 1
         ORDER BY created_at ASC`
      )
      .all(options?.includeReconciliation ? 1 : 0) as PendingOrderRow[];
    return rows.map((r) => ({
      ...r,
      side: r.side as "BUY" | "SELL",
      reconciliationOnly: Boolean(r.reconciliationOnly),
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
  }): string {
    const tradeKeys = uniqueTradeKeys(entry.tradeKeys);
    if (tradeKeys.length === 0) throw new Error("live order intent requires trade keys");
    const intentId = makeLiveOrderIntentId(entry.leaderId, tradeKeys);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO live_order_intents
         (intent_id, leader_id, token_id, side, price, leader_price, executable_price,
          slippage_pct, size, trade_keys, reasoning, market_json, created_at, updated_at,
          reconciliation_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now + FILL_RECONCILIATION_WINDOW_MS
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
                reconciliation_until AS reconciliationUntil
         FROM live_order_intents
         WHERE reconciliation_only = 0 OR ? = 1
         ORDER BY created_at ASC`
      )
      .all(options?.includeReconciliation ? 1 : 0) as Array<
      Omit<LiveOrderIntentRow, "tradeKeys" | "market" | "side"> & {
        side: string;
        tradeKeys: string;
        marketJson: string | null;
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
    const pendingLineage = orderId
      ? this.db.prepare(
          `SELECT trade_key AS tradeKey, price, size, leader_price AS leaderPrice,
                  executable_price AS executablePrice, slippage_pct AS slippagePct
           FROM pending_orders WHERE order_id = ?`
        ).get(orderId) as {
          tradeKey: string;
          price: number;
          size: number;
          leaderPrice: number | null;
          executablePrice: number | null;
          slippagePct: number | null;
        } | undefined
      : undefined;
    if (this.decisionRawEventIds.length === 0 && orderId) {
      if (pendingLineage) {
        this.decisionRawEventIds = this.rawEventIdsForSourceKeys([pendingLineage.tradeKey]);
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
                filledShares: matchedFilledShares,
                filledUsd: matchedFilledUsd ?? fill.delta * fill.price,
                matchedFeeUsd: matchedFeeUsd ?? fill.feeUsd ?? 0,
                leaderPrice: pendingLineage.leaderPrice,
                executablePrice: pendingLineage.executablePrice,
                slippagePct: pendingLineage.slippagePct,
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
    if (this.decisionRawEventIds.length === 0) {
      this.decisionRawEventIds = this.rawEventIdsForSourceKeys(keys);
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

    this.db.transaction(() => {
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
              leader_price, executable_price, slippage_pct, trade_key, reasoning, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(order_id) DO UPDATE SET
               filled_shares = excluded.filled_shares,
               filled_usd = excluded.filled_usd,
               fee_usd = excluded.fee_usd,
               leader_price = excluded.leader_price,
               executable_price = excluded.executable_price,
               slippage_pct = excluded.slippage_pct,
               updated_at = excluded.updated_at`
          )
          .run(
            orderId,
            leaderId,
            tokenId,
            side,
            price,
            orderSize,
            filledShares,
            filledUsd,
            feeUsd,
            leaderPrice ?? null,
            executablePrice ?? null,
            slippagePct ?? null,
            primaryKey,
            auditReason,
            now,
            now
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
          exactTerms: decisionTerms ?? {
            orderId: orderId ?? null,
            orderType: trackPendingGtc ? "GTC" : "IMMEDIATE",
            requestedPrice: price,
            requestedShares: orderSize,
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
    })();
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
    this.db
      .prepare(
        `INSERT INTO audit_log
         (ts, leader_id, action, token_id, side, size, price, leader_price,
          executable_price, slippage_pct, fee_usd, reason, preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
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
        entry.preview ? 1 : 0
      );
    const decisionAction: DecisionAction | null = entry.action === "ERROR"
      ? null
      : entry.action === "COPY" && entry.side === "SELL"
        ? "SELL"
        : entry.action;
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
      for (const rawEventId of this.decisionRawEventIds) {
        this.recordDecision({ rawEventId, action: decisionAction, reasonCode, exactTerms });
      }
    }
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

  addRealizedPnl(delta: number): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, realized_pnl) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET realized_pnl = realized_pnl + excluded.realized_pnl`
      )
      .run(todayKey(), delta);
  }

  triggerKillSwitch(): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, kill_switch) VALUES (?, 1)
         ON CONFLICT(date) DO UPDATE SET kill_switch = 1`
      )
      .run(todayKey());
  }

  resetKillSwitch(): void {
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, kill_switch) VALUES (?, 0)
         ON CONFLICT(date) DO UPDATE SET kill_switch = 0`
      )
      .run(todayKey());
  }

  isKillSwitchActive(): boolean {
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
                reason, preview
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
                reason, preview
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
