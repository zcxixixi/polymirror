import Database from "better-sqlite3";
import { existsSync } from "node:fs";

export interface ReconcilePreviewCashOptions {
  dbPath: string;
  startingCapitalUsd?: number;
  dryRun?: boolean;
}

export interface ReconcilePreviewCashResult {
  exists: boolean;
  auditRows: number;
  oldCashUsd: number;
  replayedCashUsd: number;
  deltaUsd: number;
  applied: boolean;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundCashUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

export function replayPreviewCashFromAudit(
  db: Database.Database,
  startingCapitalUsd: number
): { cashUsd: number; auditRows: number } {
  if (!tableExists(db, "audit_log")) {
    return { cashUsd: roundCashUsd(startingCapitalUsd), auditRows: 0 };
  }

  const rows = db
    .prepare(
      `SELECT action, side, size, price
       FROM audit_log
       WHERE action IN ('COPY', 'REDEEM')
       ORDER BY id ASC`
    )
    .all() as Array<{
    action: string;
    side: string | null;
    size: number | null;
    price: number | null;
  }>;

  let cash = startingCapitalUsd;
  for (const row of rows) {
    if (row.action === "COPY") {
      const usd = (row.size ?? 0) * (row.price ?? 0);
      if (row.side === "BUY") cash = roundCashUsd(cash - usd);
      if (row.side === "SELL") cash = roundCashUsd(cash + usd);
    } else if (row.action === "REDEEM") {
      cash = roundCashUsd(cash + (row.size ?? 0));
    }
  }

  return { cashUsd: cash, auditRows: rows.length };
}

export function reconcilePreviewCash(
  options: ReconcilePreviewCashOptions
): ReconcilePreviewCashResult {
  const startingCapitalUsd = options.startingCapitalUsd ?? 200;
  if (!existsSync(options.dbPath)) {
    return {
      exists: false,
      auditRows: 0,
      oldCashUsd: roundCashUsd(startingCapitalUsd),
      replayedCashUsd: roundCashUsd(startingCapitalUsd),
      deltaUsd: 0,
      applied: false,
    };
  }

  const db = new Database(options.dbPath);
  try {
    const replay = replayPreviewCashFromAudit(db, startingCapitalUsd);
    const oldRow = tableExists(db, "cash_ledger")
      ? (db
          .prepare("SELECT cash_usd AS cashUsd FROM cash_ledger WHERE scope = 'preview'")
          .get() as { cashUsd: number } | undefined)
      : undefined;
    const oldCashUsd = roundCashUsd(oldRow?.cashUsd ?? startingCapitalUsd);
    const replayedCashUsd = roundCashUsd(replay.cashUsd);
    const deltaUsd = round4(oldCashUsd - replayedCashUsd);
    const applied = !options.dryRun && Math.abs(deltaUsd) > 0.0001;

    if (applied) {
      db.prepare(
        `INSERT INTO cash_ledger (scope, cash_usd, updated_at)
         VALUES ('preview', ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           cash_usd = excluded.cash_usd,
           updated_at = excluded.updated_at`
      ).run(replayedCashUsd, Date.now());
    }

    return {
      exists: true,
      auditRows: replay.auditRows,
      oldCashUsd,
      replayedCashUsd,
      deltaUsd,
      applied,
    };
  } finally {
    db.close();
  }
}
