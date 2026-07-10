import Database from "better-sqlite3";
import { existsSync } from "node:fs";

export interface PrunePreviewAuditLogOptions {
  dbPath: string;
  keepRecentMs: number;
  nowMs?: number;
  dryRun?: boolean;
  vacuum?: boolean;
}

export interface PrunePreviewAuditLogResult {
  dbPath: string;
  exists: boolean;
  cutoffMs: number;
  matchedRows: number;
  deletedRows: number;
  dryRun: boolean;
  vacuumed: boolean;
}

export function prunePreviewAuditLog(
  options: PrunePreviewAuditLogOptions
): PrunePreviewAuditLogResult {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.keepRecentMs;
  const dryRun = options.dryRun ?? true;

  if (!existsSync(options.dbPath)) {
    return {
      dbPath: options.dbPath,
      exists: false,
      cutoffMs,
      matchedRows: 0,
      deletedRows: 0,
      dryRun,
      vacuumed: false,
    };
  }

  const db = new Database(options.dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const hasExperiments = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='experiments'").get();
    if (hasExperiments) {
      const unsealed = db.prepare("SELECT COUNT(*) AS count FROM experiments WHERE sealed_at IS NULL").get() as { count: number };
      if (unsealed.count > 0) throw new Error(`Refusing to prune: ${unsealed.count} unsealed experiment evidence set(s)`);
      const experimentCount = (db.prepare("SELECT COUNT(*) AS count FROM experiments").get() as { count: number }).count;
      const hasArchives = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='experiment_archives'").get();
      if (experimentCount > 0 && !hasArchives) throw new Error("Refusing to prune: sealed evidence has no verified archive record");
      if (experimentCount > 0) {
        const missingArchive = db.prepare(`SELECT COUNT(*) AS count FROM experiments e
          LEFT JOIN experiment_archives a ON a.experiment_id=e.experiment_id
          WHERE a.experiment_id IS NULL`).get() as { count: number };
        if (missingArchive.count > 0) throw new Error(`Refusing to prune: ${missingArchive.count} experiment(s) have no verified archive record`);
      }
    }
    const params = [cutoffMs, "DETECT", "SKIP"] as const;
    const matched = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE ts < ? AND action IN (?, ?)`
      )
      .get(...params) as { count: number };

    if (dryRun || matched.count === 0) {
      return {
        dbPath: options.dbPath,
        exists: true,
        cutoffMs,
        matchedRows: matched.count,
        deletedRows: 0,
        dryRun,
        vacuumed: false,
      };
    }

    const deleted = db
      .prepare(
        `DELETE FROM audit_log
         WHERE ts < ? AND action IN (?, ?)`
      )
      .run(...params);
    const vacuumed = Boolean(options.vacuum && deleted.changes > 0);
    if (vacuumed) {
      db.exec("VACUUM");
    }

    return {
      dbPath: options.dbPath,
      exists: true,
      cutoffMs,
      matchedRows: matched.count,
      deletedRows: deleted.changes,
      dryRun,
      vacuumed,
    };
  } finally {
    db.close();
  }
}
