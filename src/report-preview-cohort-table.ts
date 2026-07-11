#!/usr/bin/env node
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
import {
  resolveCohortTableAccounts,
  selectExactCohortReports,
} from "./sim/cohort-table-accounts.js";
import { readCohortOperationalEvidence } from "./sim/cohort-operational-evidence.js";
import {
  readPreviewAccountReport,
  type PreviewAccountReport,
} from "./sim/preview-report.js";

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

const dataDir = process.env.REPORT_DATA_DIR ?? "data/accounts";
const outDir = process.env.REPORT_OUT_DIR ?? "reports/preview-live";
const config = loadConfig(process.env.CONFIG_PATH ?? "config.yaml");
const fallbackCapital = Number(process.env.REPORT_STARTING_CAPITAL_USD ?? 200);
const accountIds = resolveCohortTableAccounts(dataDir, process.env.REPORT_ACCOUNTS);
const labels: Record<string, string> = {};
const controlStates: Record<string, string> = {};
const settlementFailures: Record<string, number> = {};

const configAccountById = new Map(config?.accounts.map((account) => [account.id, account]));
for (const accountId of accountIds) {
  const dbPath = join(dataDir, accountId, "preview.db");
  const configAccount = configAccountById.get(accountId);
  if (configAccount?.label.trim()) labels[accountId] = configAccount.label.trim();

  const evidence = readCohortOperationalEvidence(dbPath);
  controlStates[accountId] = configAccount?.enabled === false
    ? "SETTLE_ONLY"
    : evidence.controlState ?? "ACTIVE";
  if (evidence.settlementFailures !== undefined) {
    settlementFailures[accountId] = evidence.settlementFailures;
  }
}

const sourceReportPath = process.env.REPORT_SOURCE_JSON?.trim();
const reports: PreviewAccountReport[] = sourceReportPath
  ? selectExactCohortReports(
      accountIds,
      (JSON.parse(readFileSync(sourceReportPath, "utf8")) as {
        reports?: PreviewAccountReport[];
      }).reports ?? []
    )
  : accountIds.map((accountId) => {
      const dbPath = join(dataDir, accountId, "preview.db");
      const configAccount = configAccountById.get(accountId);
      const mergedGlobal = config && configAccount
        ? accountMergedGlobal(config, configAccount)
        : undefined;
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
