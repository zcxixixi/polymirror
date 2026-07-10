import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import {
  fetchResolvedMarketOutcome,
  type ResolvedMarketOutcome,
} from "../monitor/market-resolve.js";

export type SettlementAuditStatus =
  | "ready_to_settle"
  | "pending"
  | "missing_metadata"
  | "resolver_error";

export interface PreviewSettlementCondition {
  leaderId: string;
  conditionId: string | null;
  slug: string | null;
  title: string | null;
  positions: number;
  costUsd: number;
  tokenIds: string[];
  status: SettlementAuditStatus;
  winnerTokenIds: string[];
  reason: string | null;
}

export interface PreviewSettlementAuditReport {
  accountId: string;
  dbPath: string;
  exists: boolean;
  checkedAt: string;
  openConditionCount: number;
  readyToSettleCount: number;
  pendingCount: number;
  missingMetadataCount: number;
  resolverErrorCount: number;
  conditions: PreviewSettlementCondition[];
}

export interface AuditPreviewSettlementsOptions {
  accountId: string;
  dbPath: string;
  resolveMarket?: (slug: string) => Promise<ResolvedMarketOutcome | null>;
  resolveTimeoutMs?: number;
}

interface OpenConditionRow {
  leaderId: string;
  conditionId: string | null;
  slug: string | null;
  title: string | null;
  positions: number;
  costUsd: number;
  tokenIds: string | null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function emptyReport(options: AuditPreviewSettlementsOptions): PreviewSettlementAuditReport {
  return {
    accountId: options.accountId,
    dbPath: options.dbPath,
    exists: false,
    checkedAt: new Date().toISOString(),
    openConditionCount: 0,
    readyToSettleCount: 0,
    pendingCount: 0,
    missingMetadataCount: 0,
    resolverErrorCount: 0,
    conditions: [],
  };
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

function sortStatus(status: SettlementAuditStatus): number {
  switch (status) {
    case "ready_to_settle":
      return 0;
    case "pending":
      return 1;
    case "resolver_error":
      return 2;
    case "missing_metadata":
      return 3;
  }
}

async function resolveMarketWithTimeout(
  resolveMarket: (slug: string) => Promise<ResolvedMarketOutcome | null>,
  slug: string,
  timeoutMs: number
): Promise<ResolvedMarketOutcome | null> {
  if (timeoutMs <= 0) return resolveMarket(slug);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveMarket(slug),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`resolver timed out after ${timeoutMs}ms for ${slug}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function auditPreviewSettlements(
  options: AuditPreviewSettlementsOptions
): Promise<PreviewSettlementAuditReport> {
  if (!existsSync(options.dbPath)) return emptyReport(options);

  const resolveMarket = options.resolveMarket ?? fetchResolvedMarketOutcome;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? 10_000;
  const db = new Database(options.dbPath, { readonly: true });
  try {
    const hasTokenMarkets = tableExists(db, "token_markets");
    const rows = db
      .prepare(
        hasTokenMarkets
          ? `SELECT p.leader_id AS leaderId,
                    m.condition_id AS conditionId,
                    m.slug AS slug,
                    MAX(m.title) AS title,
                    COUNT(*) AS positions,
                    COALESCE(SUM(p.shares * p.avg_entry_price), 0) AS costUsd,
                    GROUP_CONCAT(p.token_id, ',') AS tokenIds
             FROM positions p
             LEFT JOIN token_markets m ON m.token_id = p.token_id
             WHERE p.shares > 0
             GROUP BY p.leader_id, COALESCE(m.condition_id, p.token_id), m.slug
             ORDER BY costUsd DESC`
          : `SELECT p.leader_id AS leaderId,
                    NULL AS conditionId,
                    NULL AS slug,
                    NULL AS title,
                    COUNT(*) AS positions,
                    COALESCE(SUM(p.shares * p.avg_entry_price), 0) AS costUsd,
                    GROUP_CONCAT(p.token_id, ',') AS tokenIds
             FROM positions p
             WHERE p.shares > 0
             GROUP BY p.leader_id, p.token_id
             ORDER BY costUsd DESC`
      )
      .all() as OpenConditionRow[];

    const classifyRow = async (row: OpenConditionRow): Promise<PreviewSettlementCondition> => {
      const tokenIds = row.tokenIds ? row.tokenIds.split(",").filter(Boolean) : [];
      const base = {
        leaderId: row.leaderId,
        conditionId: row.conditionId,
        slug: row.slug,
        title: row.title,
        positions: row.positions,
        costUsd: round4(row.costUsd),
        tokenIds,
      };

      if (!row.conditionId || !row.slug) {
        return {
          ...base,
          status: "missing_metadata",
          winnerTokenIds: [],
          reason: "open position missing conditionId or slug",
        };
      }

      try {
        const resolved = await resolveMarketWithTimeout(resolveMarket, row.slug, resolveTimeoutMs);
        if (resolved?.closed && resolved.winnerTokenIds.length > 0) {
          return {
            ...base,
            status: "ready_to_settle",
            winnerTokenIds: resolved.winnerTokenIds,
            reason: null,
          };
        }
        return {
          ...base,
          status: "pending",
          winnerTokenIds: resolved?.winnerTokenIds ?? [],
          reason: resolved?.closed ? "closed without priced winner" : "market not resolved",
        };
      } catch (e) {
        return {
          ...base,
          status: "resolver_error",
          winnerTokenIds: [],
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    };

    const conditions = await Promise.all(rows.map(classifyRow));

    conditions.sort((a, b) => {
      const statusDiff = sortStatus(a.status) - sortStatus(b.status);
      if (statusDiff !== 0) return statusDiff;
      return b.costUsd - a.costUsd || String(a.slug ?? "").localeCompare(String(b.slug ?? ""));
    });

    return {
      accountId: options.accountId,
      dbPath: options.dbPath,
      exists: true,
      checkedAt: new Date().toISOString(),
      openConditionCount: conditions.length,
      readyToSettleCount: conditions.filter((c) => c.status === "ready_to_settle").length,
      pendingCount: conditions.filter((c) => c.status === "pending").length,
      missingMetadataCount: conditions.filter((c) => c.status === "missing_metadata").length,
      resolverErrorCount: conditions.filter((c) => c.status === "resolver_error").length,
      conditions,
    };
  } finally {
    db.close();
  }
}
