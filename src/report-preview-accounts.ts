#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  formatPreviewAccountDetails,
  formatPreviewEvolutionPlan,
  formatPreviewAccountRanking,
  formatPreviewReportScope,
  formatPreviewSummaryDigest,
  formatStrategyRiskAssessment,
  generatePreviewAccountsReport,
  parsePreviewReportAccounts,
} from "./sim/preview-report-runner.js";
import {
  accountMergedGlobal,
  normalizeConfigDocument,
} from "./config/document.js";

const recentWindowMinutes = Number(process.env.REPORT_WINDOW_MINUTES ?? 60);
const accounts = parsePreviewReportAccounts(process.env.REPORT_ACCOUNTS);
const fallbackStartingCapitalUsd = Number(process.env.REPORT_STARTING_CAPITAL_USD ?? 200);

function loadConfigReportContext():
  | {
      startingCapitalByAccount?: Map<string, number>;
      currentActiveAccounts?: string[];
    }
  | undefined {
  if (process.env.REPORT_USE_CONFIG_CAPITALS === "0") return undefined;
  try {
    const configPath = process.env.CONFIG_PATH ?? "config.yaml";
    const normalized = normalizeConfigDocument(parseYaml(readFileSync(configPath, "utf8")));
    return {
      startingCapitalByAccount: new Map(
        normalized.accounts.map((account) => [
          account.id,
          accountMergedGlobal(normalized, account).risk.starting_capital_usd,
        ])
      ),
      currentActiveAccounts: normalized.accounts
        .filter((account) => account.enabled !== false)
        .map((account) => account.id),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`Warning: config report context unavailable: ${msg}`);
    return undefined;
  }
}

const configContext = loadConfigReportContext();
const result = generatePreviewAccountsReport({
  dataDir: process.env.REPORT_DATA_DIR ?? "data/accounts",
  outDir: process.env.REPORT_OUT_DIR ?? "reports/preview-live",
  accounts,
  currentActiveAccounts: configContext?.currentActiveAccounts,
  startingCapitalUsd: fallbackStartingCapitalUsd,
  startingCapitalByAccount: configContext?.startingCapitalByAccount,
  limit: Number(process.env.REPORT_LIMIT ?? 8),
  recentWindowMs:
    Number.isFinite(recentWindowMinutes) && recentWindowMinutes > 0
      ? recentWindowMinutes * 60_000
      : undefined,
});

if (process.env.REPORT_JSON_STDOUT === "1") {
  console.log(JSON.stringify(result));
} else {
  console.log(formatPreviewReportScope(result.metadata));
  if (result.active) console.log("\nAll historical pool:");
  for (const line of formatPreviewSummaryDigest(result.summary)) {
    console.log(line);
  }

  if (result.active) {
    console.log("\nActive pool:");
    for (const line of formatPreviewSummaryDigest(result.active.summary)) {
      console.log(line);
    }
    console.table(result.active.rows);
  } else {
    console.table(result.rows);
  }

  const primary = result.active ?? result;

  console.log("\nRanking:");
  for (const ranking of primary.rankings) {
    console.log(formatPreviewAccountRanking(ranking));
  }

  console.log("\nStrategy risk / compounding capital:");
  for (const assessment of primary.strategyRisks.slice(0, Number(process.env.REPORT_LIMIT ?? 8))) {
    console.log(formatStrategyRiskAssessment(assessment));
  }

  console.log("\nEvolution:");
  for (const line of formatPreviewEvolutionPlan(primary.evolution)) {
    console.log(line);
  }

  const details =
    result.active && process.env.REPORT_INCLUDE_HISTORICAL_DETAILS !== "1"
      ? result.active.reports
      : result.reports;
  for (const report of details) {
    console.log(formatPreviewAccountDetails(report).join("\n"));
  }

  console.log(`\nReport: ${result.outPath}`);
}
