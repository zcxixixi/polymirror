#!/usr/bin/env node
import {
  createPreviewDbDigest,
  formatPreviewDbDigest,
  writePreviewDbDigest,
} from "./sim/preview-db-digest.js";
import { formatSmallLiveGate } from "./sim/small-live-gate.js";

function parseAccounts(value: string | undefined): string[] | undefined {
  const accounts = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return accounts && accounts.length > 0 ? accounts : undefined;
}

const recentWindowMinutes = Number(process.env.REPORT_WINDOW_MINUTES ?? 60);
const staleAfterMinutes = Number(process.env.REPORT_STALE_AFTER_MINUTES ?? 45);

const digest = createPreviewDbDigest({
  dataDir: process.env.REPORT_DATA_DIR ?? "data/accounts",
  accounts: parseAccounts(process.env.REPORT_ACCOUNTS),
  startingCapitalUsd: Number(process.env.REPORT_STARTING_CAPITAL_USD ?? 200),
  recentWindowMs:
    Number.isFinite(recentWindowMinutes) && recentWindowMinutes > 0
      ? recentWindowMinutes * 60_000
      : 60 * 60_000,
  staleAfterMs:
    Number.isFinite(staleAfterMinutes) && staleAfterMinutes > 0
      ? staleAfterMinutes * 60_000
      : 45 * 60_000,
  limit: Number(process.env.REPORT_LIMIT ?? 5),
});

for (const line of formatPreviewDbDigest(digest)) {
  console.log(line);
}
for (const line of formatSmallLiveGate(digest.smallLiveGate)) {
  console.log(line);
}

console.table(
  digest.rows
    .filter((row) => row.exists)
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)
    .slice(0, Number(process.env.REPORT_LIMIT ?? 5))
    .map((row) => ({
      accountId: row.accountId,
      pnl: row.realizedPnlUsd,
      winRate: row.winStats.winRatePct,
      settled: row.winStats.settledCount,
      cash: row.cashUsd,
      openCost: row.openCostUsd,
      recentCopy: row.recent.copyCount,
      recentRedeem: row.recent.redeemCount,
      recentError: row.recent.errorCount,
      stale: row.stale,
    }))
);

const outPath = writePreviewDbDigest(
  digest,
  process.env.REPORT_OUT_DIR ?? "reports/preview-live"
);
console.log(`Report: ${outPath}`);
