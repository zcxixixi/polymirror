import Database from "better-sqlite3";

export interface CohortOperationalEvidence {
  controlState?: string;
  settlementFailures?: number;
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

export function readCohortOperationalEvidence(
  dbPath: string
): CohortOperationalEvidence {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  try {
    db.exec("BEGIN");
    let activeExperimentId: string | undefined;
    let controlState: string | undefined;
    const hasExperiments = tableExists(db, "experiments");
    if (hasExperiments) {
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
            ? `SELECT e.experiment_id AS experimentId,
                      COALESCE(c.copy_state, 'ACTIVE') AS controlState
               FROM experiments e
               LEFT JOIN experiment_controls c ON c.experiment_id = e.experiment_id
               WHERE ${activeWhere}
               ORDER BY e.started_at DESC LIMIT 1`
            : `SELECT e.experiment_id AS experimentId, 'ACTIVE' AS controlState
               FROM experiments e
               WHERE ${activeWhere}
               ORDER BY e.started_at DESC LIMIT 1`
        )
        .get() as { experimentId: string; controlState: string } | undefined;
      activeExperimentId = row?.experimentId;
      controlState = row?.controlState;
    }

    let settlementFailures: number | undefined;
    if (tableExists(db, "settlement_failures")) {
      settlementFailures = activeExperimentId
        ? (db.prepare(
            `SELECT COUNT(*) AS count FROM settlement_failures
             WHERE experiment_id = ? AND resolved_at IS NULL`
          ).get(activeExperimentId) as { count: number }).count
        : hasExperiments
          ? 0
          : (db.prepare(
              "SELECT COUNT(*) AS count FROM settlement_failures WHERE resolved_at IS NULL"
            ).get() as { count: number }).count;
    }
    const evidence = { controlState, settlementFailures };
    db.exec("COMMIT");
    return evidence;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
