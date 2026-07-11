import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  configurePreviewReportDatabase,
  readStabilityGoalEvidence,
} from "../src/sim/preview-report.js";
import { buildPreviewCopyQuality } from "../src/sim/preview-quality.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("preview report bounded reads", () => {
  it("uses SQLite read-only reporting pragmas with a bounded memory cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-report-performance-"));
    dirs.push(dir);
    const db = new Database(join(dir, "preview.db"));
    try {
      db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY)");
      configurePreviewReportDatabase(db);

      expect(db.pragma("query_only", { simple: true })).toBe(1);
      expect(db.pragma("temp_store", { simple: true })).toBe(1);
      expect(db.pragma("cache_size", { simple: true })).toBe(-65_536);
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5_000);
      expect(() => db.exec("INSERT INTO sample DEFAULT VALUES")).toThrow();
    } finally {
      db.close();
    }
  });

  it("reads exact stability path and error evidence in one compact aggregate", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          action TEXT NOT NULL,
          token_id TEXT,
          side TEXT,
          size REAL,
          reason TEXT
        );
        INSERT INTO audit_log (ts, action, token_id, side, size, reason) VALUES
          (1000, 'DETECT', 'buy-copied', 'BUY', 1, NULL),
          (1001, 'COPY', 'buy-copied', 'BUY', 1, NULL),
          (1002, 'DETECT', 'sell-deduped', 'SELL', 1, NULL),
          (1003, 'SKIP', 'sell-deduped', 'SELL', 1, 'already seen'),
          (1004, 'DETECT', 'sell-copied', 'SELL', 1, NULL),
          (1005, 'COPY', 'sell-copied', 'SELL', 1, NULL),
          (1006, 'DETECT', 'sell-gap', 'SELL', 1, NULL),
          (1007, 'REDEEM', 'condition', 'REDEEM', 1, NULL),
          (2000, 'ERROR', 'condition', 'REDEEM', 0, 'upstream timeout');
      `);

      const evidence = readStabilityGoalEvidence(db, 0, 1500);
      const quality = buildPreviewCopyQuality({
        db,
        hasAuditLog: true,
        hasTokenMarkets: false,
        cashUsd: 200,
        openCostUsd: 0,
        openPositions: 0,
        realizedPnlUsd: 0,
        errorCount: 0,
        killSwitch: false,
        pendingOrderCount: 0,
        liveOrderIntentCount: 0,
        cashReplayDeltaUsd: 0,
        capitalDeltaUsd: 0,
        missingMarketMetadataCount: 0,
        sinceMs: 0,
      });

      expect(evidence).toEqual({
        recentErrorCount: 1,
        copyPath: {
          copiedBuy: 1,
          copiedSell: 1,
          redeemCount: 1,
          unclassifiedGap: 1,
        },
      });
      expect(evidence.copyPath).toEqual({
        copiedBuy: quality.copied.buy,
        copiedSell: quality.copied.sell,
        redeemCount: quality.redeem.count,
        unclassifiedGap:
          quality.copyGap.buy.unclassified + quality.copyGap.sell.unclassified,
      });
    } finally {
      db.close();
    }
  });
});
