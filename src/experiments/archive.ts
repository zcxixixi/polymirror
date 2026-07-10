import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { captureStoredEvidenceBaseline, type ReplayEvidenceSummary } from "./replay-verify.js";

export interface ArchiveFile { path: string; sha256: string; bytes: number }
export interface ExperimentArchiveManifest {
  formatVersion: 1; experimentId: string; sealedAt: number; sourceName: string;
  files: ArchiveFile[]; replayBaseline: ReplayEvidenceSummary;
}
export interface ArchiveResult extends ExperimentArchiveManifest { manifestPath: string; snapshotPath: string }

function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function assertNewDirectory(path: string): void {
  if (existsSync(path)) throw new Error(`Archive destination already exists: ${path}`);
  const parent = realpathSync(dirname(resolve(path)));
  if (lstatSync(parent).isSymbolicLink()) throw new Error("Archive destination parent cannot be a symlink");
}
function safeArtifact(manifestPath: string, artifact: string): string {
  if (isAbsolute(artifact) || artifact.split(/[\\/]/).includes("..")) throw new Error("Unsafe artifact path in archive manifest");
  const root = realpathSync(dirname(resolve(manifestPath)));
  const candidate = resolve(root, artifact);
  if (relative(root, candidate).startsWith("..")) throw new Error("Unsafe artifact path in archive manifest");
  if (lstatSync(candidate).isSymbolicLink()) throw new Error("Archive artifacts cannot be symlinks");
  return candidate;
}

export async function archiveExperimentEvidence(options: { dbPath: string; experimentId: string; archiveDir: string; sealedAt?: number }): Promise<ArchiveResult> {
  const source = realpathSync(options.dbPath);
  assertNewDirectory(options.archiveDir);
  if (resolve(options.archiveDir) === source) throw new Error("Archive destination must differ from source database");
  let sealedAt = options.sealedAt ?? Date.now();
  const sourceDb = new Database(source);
  try {
    sourceDb.pragma("busy_timeout = 5000");
    sourceDb.transaction(() => {
      const row = sourceDb.prepare("SELECT sealed_at AS sealedAt FROM experiments WHERE experiment_id=?").get(options.experimentId) as { sealedAt: number | null } | undefined;
      if (!row) throw new Error(`Experiment not found: ${options.experimentId}`);
      if (row.sealedAt !== null) sealedAt = row.sealedAt;
      else sourceDb.prepare(`UPDATE experiments SET sealed_at=?, ended_at=COALESCE(ended_at, ?), state='ENDED' WHERE experiment_id=? AND sealed_at IS NULL`).run(sealedAt, sealedAt, options.experimentId);
    })();
    mkdirSync(options.archiveDir, { recursive: false });
    const snapshotPath = join(options.archiveDir, "evidence.sqlite");
    await sourceDb.backup(snapshotPath);
    const replayBaseline = captureStoredEvidenceBaseline(snapshotPath, options.experimentId);
    const file = { path: "evidence.sqlite", sha256: sha256(snapshotPath), bytes: statSync(snapshotPath).size };
    const manifest: ExperimentArchiveManifest = { formatVersion: 1, experimentId: options.experimentId, sealedAt, sourceName: basename(source), files: [file], replayBaseline };
    const manifestPath = join(options.archiveDir, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const verified = verifyExperimentArchive(manifestPath);
    if (!verified.valid) throw new Error(`Created archive failed verification: ${verified.errors.join(", ")}`);
    sourceDb.prepare(`INSERT OR IGNORE INTO experiment_archives
      (experiment_id, snapshot_sha256, manifest_sha256, archived_at) VALUES (?, ?, ?, ?)`)
      .run(options.experimentId, file.sha256, sha256(manifestPath), Date.now());
    return { ...manifest, manifestPath, snapshotPath };
  } finally { sourceDb.close(); }
}

export function verifyExperimentArchive(manifestPath: string): { valid: boolean; errors: string[] } {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExperimentArchiveManifest;
  const errors: string[] = [];
  if (manifest.formatVersion !== 1 || manifest.files.length !== 1) errors.push("unsupported archive manifest");
  for (const file of manifest.files) {
    try {
      const path = safeArtifact(manifestPath, file.path);
      if (statSync(path).size !== file.bytes) errors.push(`${file.path}: size mismatch`);
      if (sha256(path) !== file.sha256) errors.push(`${file.path}: checksum mismatch`);
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return { valid: errors.length === 0, errors };
}

export function restoreExperimentArchive(manifestPath: string, destinationPath: string): { valid: boolean; errors: string[] } {
  const verified = verifyExperimentArchive(manifestPath);
  if (!verified.valid) throw new Error(`Archive verification failed: ${verified.errors.join(", ")}`);
  if (existsSync(destinationPath)) throw new Error("Restore destination must not already exist");
  mkdirSync(dirname(resolve(destinationPath)), { recursive: true });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExperimentArchiveManifest;
  const source = safeArtifact(manifestPath, manifest.files[0]!.path);
  copyFileSync(source, destinationPath, 0);
  const errors = sha256(destinationPath) === manifest.files[0]!.sha256 ? [] : ["restored artifact checksum mismatch"];
  return { valid: errors.length === 0, errors };
}
