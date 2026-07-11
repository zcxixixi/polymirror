import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parsePreviewReportAccounts } from "./preview-report-runner.js";

function hasPreviewDatabase(dataDir: string, accountId: string): boolean {
  const accountDir = join(dataDir, accountId);
  try {
    return statSync(accountDir).isDirectory() && existsSync(join(accountDir, "preview.db"));
  } catch {
    return false;
  }
}

function discoverCohortTableAccounts(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((accountId) => hasPreviewDatabase(dataDir, accountId))
    .sort();
}

function isSafeAccountId(accountId: string): boolean {
  return accountId !== "."
    && accountId !== ".."
    && !accountId.includes("/")
    && !accountId.includes("\\")
    && !accountId.includes("\0");
}

export function serializeRequiredReportAccounts(
  accountIds: readonly string[],
  expectedCount: number
): string {
  const uniqueAccountIds = [...new Set(accountIds)];
  if (!Number.isSafeInteger(expectedCount)
    || expectedCount <= 0
    || accountIds.length !== expectedCount
    || uniqueAccountIds.length !== expectedCount
    || uniqueAccountIds.some((accountId) => !isSafeAccountId(accountId))) {
    throw new Error(`shadow report selection requires exactly ${expectedCount} unique account ids`);
  }
  return uniqueAccountIds.join(",");
}

export function resolveCohortTableAccounts(
  dataDir: string,
  rawAccounts: string | undefined
): string[] {
  const requested = parsePreviewReportAccounts(rawAccounts);
  if (!requested) return discoverCohortTableAccounts(dataDir);

  const accountIds = [...new Set(requested)];
  for (const accountId of accountIds) {
    if (!isSafeAccountId(accountId)) {
      throw new Error(`invalid requested cohort account id: ${accountId}`);
    }
    if (!hasPreviewDatabase(dataDir, accountId)) {
      throw new Error(`requested cohort account ${accountId} is unavailable`);
    }
  }
  return accountIds;
}
