#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prunePreviewAuditLog } from "./sim/audit-log-prune.js";

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase());
}

function parseAccounts(value: string | undefined, dataDir: string): string[] {
  if (value?.trim()) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((name) => existsSync(join(dataDir, name, "preview.db")))
    .sort();
}

const dataDir = process.env.PRUNE_DATA_DIR ?? "data/accounts";
const keepHours = Number(process.env.PRUNE_KEEP_HOURS ?? 24);
const dryRun = parseBool(process.env.PRUNE_DRY_RUN, true);
const vacuum = parseBool(process.env.PRUNE_VACUUM, false);
const accounts = parseAccounts(process.env.PRUNE_ACCOUNTS, dataDir);

if (!Number.isFinite(keepHours) || keepHours <= 0) {
  throw new Error("PRUNE_KEEP_HOURS must be a positive number");
}

const results = accounts.map((accountId) => {
  const result = prunePreviewAuditLog({
    dbPath: join(dataDir, accountId, "preview.db"),
    keepRecentMs: keepHours * 3600_000,
    dryRun,
    vacuum,
  });
  return {
    account: accountId,
    exists: result.exists,
    matched: result.matchedRows,
    deleted: result.deletedRows,
    vacuumed: result.vacuumed,
    dryRun: result.dryRun,
  };
});

console.table(results);
const matched = results.reduce((sum, row) => sum + row.matched, 0);
const deleted = results.reduce((sum, row) => sum + row.deleted, 0);
console.log(
  `Matched ${matched} old DETECT/SKIP rows; deleted ${deleted}. ` +
    (dryRun
      ? "Set PRUNE_DRY_RUN=false to apply."
      : `Applied.${vacuum ? " Vacuumed changed DBs." : ""}`)
);
