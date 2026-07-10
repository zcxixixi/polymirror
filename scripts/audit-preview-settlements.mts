import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchResolvedMarketOutcome,
  type ResolvedMarketOutcome,
} from "../src/monitor/market-resolve.js";
import { auditPreviewSettlements } from "../src/sim/settlement-audit.js";
import { ensureUndiciGlobalProxy, resolveProxyConfig, setProxyConfig } from "../src/util/proxy.js";

const defaultAccounts = ["ceshi", "ceshi_fixed1_cap8", "ceshi_fixed2_cap12"];
const dataDir = process.env.REPORT_DATA_DIR ?? "data/accounts";
const outDir = process.env.REPORT_OUT_DIR ?? "reports/preview-live";
const resolveTimeoutMs = Number(process.env.RESOLVE_TIMEOUT_MS ?? 8000);
const accounts = (process.env.REPORT_ACCOUNTS ?? defaultAccounts.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const proxy = resolveProxyConfig({ mode: "none" });
setProxyConfig(proxy.config, proxy.source);
await ensureUndiciGlobalProxy();

const resolveCache = new Map<string, Promise<ResolvedMarketOutcome | null>>();
function resolveMarketCached(slug: string): Promise<ResolvedMarketOutcome | null> {
  let cached = resolveCache.get(slug);
  if (!cached) {
    cached = fetchResolvedMarketOutcome(slug);
    resolveCache.set(slug, cached);
  }
  return cached;
}

const reports = [];
for (const accountId of accounts) {
  reports.push(
    await auditPreviewSettlements({
      accountId,
      dbPath: join(dataDir, accountId, "preview.db"),
      resolveMarket: resolveMarketCached,
      resolveTimeoutMs,
    })
  );
}

console.table(
  reports.map((r) => ({
    account: r.accountId,
    exists: r.exists,
    open: r.openConditionCount,
    ready: r.readyToSettleCount,
    pending: r.pendingCount,
    missing: r.missingMetadataCount,
    resolverErrors: r.resolverErrorCount,
  }))
);

for (const report of reports) {
  console.log(`\n${report.accountId}`);
  const important = report.conditions.filter((c) => c.status !== "pending").slice(0, 12);
  if (important.length === 0) {
    console.log("non-pending: none");
    continue;
  }
  for (const c of important) {
    console.log(
      `${c.status} ${c.costUsd}U ${c.slug ?? c.conditionId ?? "(missing market)"} ${c.reason ?? ""}`
    );
  }
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `settlement-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
console.log(`\nReport: ${outPath}`);
