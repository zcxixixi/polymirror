import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { auditPreviewSettlements } from "../src/sim/settlement-audit.js";
import { StateStore } from "../src/state/store.js";

let dir: string;
let dbPath: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-settlement-audit-"));
  dbPath = join(dir, "preview.db");
  store = new StateStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function buy(tokenId: string, conditionId: string | null, slug: string | null) {
  store.recordCopySuccess({
    tradeKey: `buy-${tokenId}`,
    leaderId: "leader-a",
    tokenId,
    side: "BUY",
    filledShares: 10,
    price: 0.5,
    filledUsd: 5,
    auditReason: "Fixed $5.00",
    preview: true,
    cashInitialUsd: 100,
    market:
      conditionId && slug
        ? {
            tokenId,
            conditionId,
            slug,
            title: `Title ${slug}`,
            outcome: "Yes",
          }
        : undefined,
  });
}

describe("auditPreviewSettlements", () => {
  it("classifies open preview conditions by settlement readiness", async () => {
    buy("ready-token", "condition-ready", "ready-slug");
    buy("pending-token", "condition-pending", "pending-slug");
    buy("error-token", "condition-error", "error-slug");
    buy("missing-market-token", null, null);

    const resolveMarket = vi.fn(async (slug: string) => {
      if (slug === "ready-slug") return { closed: true, winnerTokenIds: ["ready-token"] };
      if (slug === "pending-slug") return { closed: false, winnerTokenIds: [] };
      throw new Error("resolver down");
    });

    const report = await auditPreviewSettlements({
      accountId: "acct-a",
      dbPath,
      resolveMarket,
    });

    expect(report.exists).toBe(true);
    expect(report.openConditionCount).toBe(4);
    expect(report.readyToSettleCount).toBe(1);
    expect(report.pendingCount).toBe(1);
    expect(report.missingMetadataCount).toBe(1);
    expect(report.resolverErrorCount).toBe(1);
    expect(report.conditions.map((c) => c.status)).toEqual([
      "ready_to_settle",
      "pending",
      "resolver_error",
      "missing_metadata",
    ]);
    expect(resolveMarket).toHaveBeenCalledTimes(3);
  });

  it("marks resolver calls as errors when they time out", async () => {
    buy("slow-token", "condition-slow", "slow-slug");

    const report = await auditPreviewSettlements({
      accountId: "acct-a",
      dbPath,
      resolveMarket: () => new Promise(() => undefined),
      resolveTimeoutMs: 5,
    });

    expect(report.resolverErrorCount).toBe(1);
    expect(report.conditions[0]?.status).toBe("resolver_error");
    expect(report.conditions[0]?.reason).toContain("timed out");
  });

  it("checks open markets concurrently", async () => {
    buy("first-token", "condition-first", "first-slug");
    buy("second-token", "condition-second", "second-slug");

    const resolvers = new Map<string, (value: { closed: boolean; winnerTokenIds: string[] }) => void>();
    const resolveMarket = vi.fn(
      (slug: string) =>
        new Promise<{ closed: boolean; winnerTokenIds: string[] }>((resolve) => {
          resolvers.set(slug, resolve);
        })
    );

    const auditPromise = auditPreviewSettlements({
      accountId: "acct-a",
      dbPath,
      resolveMarket,
      resolveTimeoutMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveMarket).toHaveBeenCalledTimes(2);
    resolvers.get("first-slug")?.({ closed: false, winnerTokenIds: [] });
    resolvers.get("second-slug")?.({ closed: false, winnerTokenIds: [] });

    const report = await auditPromise;
    expect(report.pendingCount).toBe(2);
  });

  it("classifies legacy positions without token market metadata instead of throwing", async () => {
    store.close();
    rmSync(dbPath, { force: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE positions (
          leader_id TEXT NOT NULL,
          token_id TEXT NOT NULL,
          shares REAL NOT NULL DEFAULT 0,
          avg_entry_price REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (leader_id, token_id)
        );
        INSERT INTO positions VALUES ('leader-a', 'legacy-token', 10, 0.5);
      `);
    } finally {
      db.close();
    }

    const report = await auditPreviewSettlements({
      accountId: "legacy",
      dbPath,
      resolveMarket: vi.fn(),
    });

    expect(report.exists).toBe(true);
    expect(report.openConditionCount).toBe(1);
    expect(report.missingMetadataCount).toBe(1);
    expect(report.conditions[0]).toMatchObject({
      tokenIds: ["legacy-token"],
      status: "missing_metadata",
      costUsd: 5,
    });
  });
});
