import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveExperimentEvidence,
  restoreExperimentArchive,
  verifyExperimentArchive,
} from "../src/experiments/archive.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "pm-archive-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function buildArchive(name: string, reason: string) {
  const dbPath = join(dir, `${name}.db`);
  const store = new StateStore(dbPath);
  const config = previewRuntimeConfig();
  const experiment = store.startOrResumeExperiment({
    accountId: name,
    candidateAddresses: [],
    config,
    gitSha: "git-a",
    imageDigest: "image-a",
    lockfileHash: "lock-a",
    trustClass: "candidate",
  }, 100);
  store.audit({ action: "SKIP", reason, preview: true });
  store.close();
  return archiveExperimentEvidence({
    dbPath,
    experimentId: experiment.experimentId,
    archiveDir: join(dir, `${name}-archive`),
    sealedAt: 200,
  });
}

describe("experiment evidence archive", () => {
  it("changes checksum with the source snapshot and verifies restored artifacts", async () => {
    const first = await buildArchive("first", "snapshot one");
    const second = await buildArchive("second", "snapshot two");
    expect(first.files[0]?.sha256).not.toBe(second.files[0]?.sha256);
    expect(verifyExperimentArchive(first.manifestPath, { sourceDbPath: join(dir, "first.db") }).valid).toBe(true);

    const restored = join(dir, "restored.db");
    const result = restoreExperimentArchive(first.manifestPath, restored, { sourceDbPath: join(dir, "first.db") });
    expect(result.valid).toBe(true);
    expect(readFileSync(restored)).toEqual(readFileSync(first.snapshotPath));
    const db = new Database(restored, { readonly: true });
    expect((db.prepare("SELECT sealed_at AS sealedAt FROM experiments").get() as { sealedAt: number }).sealedAt).toBe(200);
    db.close();
    const source = new Database(join(dir, "first.db"), { readonly: true });
    expect((source.prepare("SELECT COUNT(*) AS count FROM experiment_archives").get() as { count: number }).count).toBe(1);
    source.close();
  });

  it("rejects a rewritten snapshot and self-consistent rewritten manifest without the source anchor", async () => {
    const archived = await buildArchive("anchored", "original");
    const manifest = JSON.parse(readFileSync(archived.manifestPath, "utf8"));
    const db = new Database(archived.snapshotPath); db.prepare("UPDATE audit_log SET reason='attacker'").run(); db.close();
    const { createHash } = await import("node:crypto");
    manifest.files[0].sha256 = createHash("sha256").update(readFileSync(archived.snapshotPath)).digest("hex");
    const { writeFileSync } = await import("node:fs"); writeFileSync(archived.manifestPath, JSON.stringify(manifest));
    expect(verifyExperimentArchive(archived.manifestPath, { sourceDbPath: join(dir, "anchored.db") }).valid).toBe(false);
  });

  it("rejects a manual anchor when the source experiment is not sealed", async () => {
    const archived = await buildArchive("manual-anchor", "original");
    const source = new Database(join(dir, "manual-anchor.db"));
    source.exec("DROP TRIGGER experiments_sealed_no_update");
    source.prepare("UPDATE experiments SET sealed_at=NULL, archive_status='NONE', state='ACTIVE', ended_at=NULL").run();
    source.close();
    expect(verifyExperimentArchive(archived.manifestPath, { sourceDbPath: join(dir, "manual-anchor.db") }).valid).toBe(false);
  });

  it("rejects an archive reached through a nested symlink component", async () => {
    const archived = await buildArchive("nested", "original");
    const alias = join(dir, "archive-alias"); symlinkSync(join(dir, "nested-archive"), alias, "dir");
    const result = verifyExperimentArchive(join(alias, "manifest.json"), { sourceDbPath: join(dir, "nested.db") });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/symlink/i);
  });

  it("recovers a failed preparation without sealing or blocking later evidence", async () => {
    const dbPath = join(dir, "recover.db"); const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const experiment = store.startOrResumeExperiment({ accountId: "recover", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" }); store.close();
    const backup = vi.spyOn(Database.prototype, "backup").mockRejectedValueOnce(new Error("disk I/O failure"));
    await expect(archiveExperimentEvidence({ dbPath, experimentId: experiment.experimentId, archiveDir: join(dir, "failed") })).rejects.toThrow(/disk I\/O/);
    backup.mockRestore();
    const reopened = new StateStore(dbPath);
    expect(reopened.getExperiment(experiment.experimentId)).toMatchObject({ sealedAt: null, archiveStatus: "FAILED" });
    expect(() => reopened.recordRawEvent({ sourceId: "after-failure", payload: {}, sourceTimestamp: 2 })).not.toThrow();
    reopened.close();
  });

  it("makes sealing append-only and refuses unsafe restore paths", async () => {
    const archived = await buildArchive("sealed", "immutable");
    const db = new Database(join(dir, "sealed.db"));
    expect(() => db.prepare("UPDATE experiments SET sealed_at = NULL").run()).toThrow(/sealed/i);
    expect(() => db.prepare(`INSERT INTO decisions
      (decision_id, experiment_id, raw_event_id, action, reason_code, exact_terms_json, decided_at)
      VALUES ('x', (SELECT experiment_id FROM experiments), 'missing', 'SKIP', 'policy_skip', '{}', 1)`).run()).toThrow();
    db.close();
    expect(() => restoreExperimentArchive(archived.manifestPath, archived.snapshotPath, { sourceDbPath: join(dir, "sealed.db") })).toThrow(/destination/i);
  });

  it("refuses to archive decisions whose stored raw observation evidence is incomplete", async () => {
    const dbPath = join(dir, "incomplete.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    const experiment = store.startOrResumeExperiment({ accountId: "incomplete", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "event", payload: { side: "BUY" }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "SKIP", reasonCode: "policy_skip", exactTerms: {}, decidedAt: 2 });
    store.close();
    const db = new Database(dbPath);
    db.exec("DROP TRIGGER raw_event_observations_no_delete; DELETE FROM raw_event_observations");
    db.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: experiment.experimentId, archiveDir: join(dir, "incomplete-archive") }))
      .rejects.toThrow(/raw observation/i);
  });
});
