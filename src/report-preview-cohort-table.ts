#!/usr/bin/env node
import Database from "better-sqlite3";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  accountMergedGlobal,
  normalizeConfigDocument,
  type NormalizedConfigDocument,
} from "./config/document.js";
import {
  createCohortQualityRows,
  formatCohortQualityMarkdown,
  type CohortQualityTableOptions,
} from "./sim/cohort-quality-table.js";
import { resolveCohortTableAccounts } from "./sim/cohort-table-accounts.js";
import { readPreviewAccountReport } from "./sim/preview-report.js";

const RECENT_WINDOW_MS = 24 * 60 * 60_000;

function loadConfig(path: string): NormalizedConfigDocument | undefined {
  try {
    return normalizeConfigDocument(parseYaml(readFileSync(path, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: cohort table config context unavailable: ${message}`);
    return undefined;
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

function readOperationalEvidence(dbPath: string): {
  controlState?: string;
  settlementFailures?: number;
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let controlState: string | undefined;
    if (tableExists(db, "experiments")) {
      const hasControls = tableExists(db, "experiment_controls");
      const hasState = columnExists(db, "experiments", "state");
      const hasEndedAt = columnExists(db, "experiments", "ended_at");
      const activeWhere = [
        hasState ? "e.state = 'ACTIVE'" : undefined,
        hasEndedAt ? "e.ended_at IS NULL" : undefined,
      ].filter(Boolean).join(" AND ") || "1 = 1";
      const row = db
        .prepare(
          hasControls
            ? `SELECT COALESCE(c.copy_state, 'ACTIVE') AS controlState
               FROM experiments e
               LEFT JOIN experiment_controls c ON c.experiment_id = e.experiment_id
               WHERE ${activeWhere}
               ORDER BY e.started_at DESC LIMIT 1`
            : `SELECT 'ACTIVE' AS controlState
               FROM experiments e
               WHERE ${activeWhere}
               ORDER BY e.started_at DESC LIMIT 1`
        )
        .get() as { controlState: string } | undefined;
      controlState = row?.controlState;
    }

    let settlementFailures: number | undefined;
    if (tableExists(db, "settlement_failures")) {
      settlementFailures = (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM settlement_failures WHERE resolved_at IS NULL"
          )
          .get() as { count: number }
      ).count;
    }
    return { controlState, settlementFailures };
  } finally {
    db.close();
  }
}

const dataDir = process.env.REPORT_DATA_DIR ?? "data/accounts";
const outDir = process.env.REPORT_OUT_DIR ?? "reports/preview-live";
const config = loadConfig(process.env.CONFIG_PATH ?? "config.yaml");
const fallbackCapital = Number(process.env.REPORT_STARTING_CAPITAL_USD ?? 200);
const accountIds = resolveCohortTableAccounts(dataDir, process.env.REPORT_ACCOUNTS);
const labels: Record<string, string> = {};
const controlStates: Record<string, string> = {};
const settlementFailures: Record<string, number> = {};

const configAccountById = new Map(config?.accounts.map((account) => [account.id, account]));
const reports = accountIds.map((accountId) => {
  const dbPath = join(dataDir, accountId, "preview.db");
  const configAccount = configAccountById.get(accountId);
  const mergedGlobal = config && configAccount
    ? accountMergedGlobal(config, configAccount)
    : undefined;
  if (configAccount?.label.trim()) labels[accountId] = configAccount.label.trim();

  const evidence = readOperationalEvidence(dbPath);
  controlStates[accountId] = configAccount?.enabled === false
    ? "SETTLE_ONLY"
    : evidence.controlState ?? "ACTIVE";
  if (evidence.settlementFailures !== undefined) {
    settlementFailures[accountId] = evidence.settlementFailures;
  }

  return readPreviewAccountReport({
    accountId,
    dbPath,
    copyPriceMode: mergedGlobal?.copy_price_mode ?? "leader_limit",
    startingCapitalUsd: mergedGlobal?.risk.starting_capital_usd ?? fallbackCapital,
    recentWindowMs: RECENT_WINDOW_MS,
    limit: Number(process.env.REPORT_LIMIT ?? 8),
  });
});

const options: CohortQualityTableOptions = {
  labels,
  controlStates,
  settlementFailures,
};
const rows = createCohortQualityRows(reports, options);
const markdown = formatCohortQualityMarkdown(rows);
const generatedAt = new Date();
const timestamp = generatedAt.toISOString().replace(/[:.]/g, "-");
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, `preview-cohort-table-${timestamp}.json`);
const markdownPath = join(outDir, `preview-cohort-table-${timestamp}.md`);
writeFileSync(
  jsonPath,
  `${JSON.stringify({
    generatedAt: generatedAt.toISOString(),
    recentWindowMs: RECENT_WINDOW_MS,
    rows,
  }, null, 2)}\n`,
  "utf8"
);
writeFileSync(markdownPath, markdown, "utf8");

console.log(markdown);
console.log(`JSON: ${jsonPath}`);
console.log(`Markdown: ${markdownPath}`);
