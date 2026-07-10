import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveExperimentEvidence,
  restoreExperimentArchive,
  verifyExperimentArchive,
} from "../src/experiments/archive.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pm-archive-")); });
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
    expect(verifyExperimentArchive(first.manifestPath).valid).toBe(true);

    const restored = join(dir, "restored.db");
    const result = restoreExperimentArchive(first.manifestPath, restored);
    expect(result.valid).toBe(true);
    expect(readFileSync(restored)).toEqual(readFileSync(first.snapshotPath));
    const db = new Database(restored, { readonly: true });
    expect((db.prepare("SELECT sealed_at AS sealedAt FROM experiments").get() as { sealedAt: number }).sealedAt).toBe(200);
    db.close();
    const source = new Database(join(dir, "first.db"), { readonly: true });
    expect((source.prepare("SELECT COUNT(*) AS count FROM experiment_archives").get() as { count: number }).count).toBe(1);
    source.close();
  });

  it("makes sealing append-only and refuses unsafe restore paths", async () => {
    const archived = await buildArchive("sealed", "immutable");
    const db = new Database(join(dir, "sealed.db"));
    expect(() => db.prepare("UPDATE experiments SET sealed_at = NULL").run()).toThrow(/sealed/i);
    expect(() => db.prepare(`INSERT INTO decisions
      (decision_id, experiment_id, raw_event_id, action, reason_code, exact_terms_json, decided_at)
      VALUES ('x', (SELECT experiment_id FROM experiments), 'missing', 'SKIP', 'policy_skip', '{}', 1)`).run()).toThrow();
    db.close();
    expect(() => restoreExperimentArchive(archived.manifestPath, archived.snapshotPath)).toThrow(/destination/i);
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
