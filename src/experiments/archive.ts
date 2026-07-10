import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { captureStoredEvidenceBaseline, type ReplayEvidenceSummary } from "./replay-verify.js";

export interface ArchiveFile { path: string; sha256: string; bytes: number }
export interface ExperimentArchiveManifest {
  formatVersion: 2;
  experimentId: string;
  sealedAt: number;
  sourceName: string;
  files: ArchiveFile[];
  replayBaseline: ReplayEvidenceSummary;
}
export interface ArchiveResult extends ExperimentArchiveManifest { manifestPath: string; snapshotPath: string }
export interface ArchiveVerificationOptions { sourceDbPath: string }

function sha256Bytes(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function sha256(path: string): string { return sha256Bytes(readFileSync(path)); }

function assertNoSymlinkComponents(path: string, allowMissingTail: boolean): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (allowMissingTail) return;
      throw new Error(`Path component does not exist: ${current}`);
    }
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink path component is not allowed: ${current}`);
  }
}

function safeExistingFile(path: string): string {
  assertNoSymlinkComponents(path, false);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error(`Expected regular file: ${path}`);
  return canonical;
}

function safeArtifact(manifestPath: string, artifact: string): string {
  if (isAbsolute(artifact) || artifact.split(/[\\/]/).includes("..")) throw new Error("Unsafe artifact path in archive manifest");
  const root = realpathSync(dirname(safeExistingFile(manifestPath)));
  const candidate = resolve(root, artifact);
  if (relative(root, candidate).startsWith("..")) throw new Error("Unsafe artifact path in archive manifest");
  return safeExistingFile(candidate);
}

function parseManifest(manifestPath: string): ExperimentArchiveManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(safeExistingFile(manifestPath), "utf8")); }
  catch (error) { throw new Error(`Malformed archive manifest: ${error instanceof Error ? error.message : String(error)}`); }
  const value = parsed as Partial<ExperimentArchiveManifest>;
  if (value.formatVersion !== 2 || typeof value.experimentId !== "string" || !Array.isArray(value.files) || value.files.length !== 1) {
    throw new Error("Malformed archive manifest: unsupported or incomplete fields");
  }
  return value as ExperimentArchiveManifest;
}

function atomicPublishJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

function storedState(db: Database.Database, experimentId: string): { configJson: string; sealedAt: number | null; archiveStatus: string } {
  const row = db.prepare(`SELECT canonical_config_json AS configJson, sealed_at AS sealedAt,
    archive_status AS archiveStatus FROM experiments WHERE experiment_id=?`).get(experimentId) as
    { configJson: string; sealedAt: number | null; archiveStatus: string } | undefined;
  if (!row) throw new Error(`Experiment not found: ${experimentId}`);
  return row;
}

export async function archiveExperimentEvidence(options: {
  dbPath: string; experimentId: string; archiveDir: string; sealedAt?: number;
}): Promise<ArchiveResult> {
  const source = safeExistingFile(options.dbPath);
  assertNoSymlinkComponents(options.archiveDir, true);
  if (existsSync(options.archiveDir)) throw new Error(`Archive destination already exists: ${options.archiveDir}`);
  mkdirSync(options.archiveDir, { recursive: false, mode: 0o700 });
  const archiveDir = realpathSync(options.archiveDir);
  const sealedAt = options.sealedAt ?? Date.now();
  const sourceDb = new Database(source);
  let sourceSealed = false;
  try {
    sourceDb.pragma("busy_timeout = 5000");
    sourceDb.transaction(() => {
      const row = storedState(sourceDb, options.experimentId);
      if (row.sealedAt !== null || row.archiveStatus === "SEALED") throw new Error("Experiment is already sealed");
      const config = JSON.parse(row.configJson) as { app?: { global?: { risk?: { startingCapitalUsd?: number } } } };
      const initial = config.app?.global?.risk?.startingCapitalUsd;
      if (typeof initial !== "number" || !Number.isFinite(initial)) throw new Error("Experiment config has invalid starting capital");
      const cash = sourceDb.prepare("SELECT cash_usd AS cashUsd FROM cash_ledger WHERE scope='preview'").get() as { cashUsd: number } | undefined;
      const positions = sourceDb.prepare(`SELECT leader_id AS leaderId, token_id AS tokenId, shares,
        avg_entry_price AS avgEntryPrice FROM positions WHERE ABS(shares)>1e-12 ORDER BY leader_id, token_id`).all();
      const pnl = sourceDb.prepare("SELECT COALESCE(SUM(realized_pnl),0) AS realizedPnlUsd FROM daily_stats").get() as { realizedPnlUsd: number };
      const endState = { cashUsd: cash?.cashUsd ?? initial, positions, realizedPnlUsd: pnl.realizedPnlUsd };
      sourceDb.prepare(`UPDATE experiments SET archive_status='PREPARING', archive_error=NULL,
        end_state_json=? WHERE experiment_id=? AND sealed_at IS NULL`).run(JSON.stringify(endState), options.experimentId);
    })();

    const snapshotPath = join(archiveDir, "evidence.sqlite");
    await sourceDb.backup(snapshotPath);
    const snapshotDb = new Database(snapshotPath);
    try {
      snapshotDb.prepare(`UPDATE experiments SET sealed_at=?, ended_at=COALESCE(ended_at, ?),
        state='ENDED', archive_status='SEALED' WHERE experiment_id=? AND archive_status='PREPARING'`)
        .run(sealedAt, sealedAt, options.experimentId);
    } finally { snapshotDb.close(); }

    const replayBaseline = captureStoredEvidenceBaseline(snapshotPath, options.experimentId);
    const file = { path: "evidence.sqlite", sha256: sha256(snapshotPath), bytes: statSync(snapshotPath).size };
    const manifest: ExperimentArchiveManifest = {
      formatVersion: 2, experimentId: options.experimentId, sealedAt,
      sourceName: basename(source), files: [file], replayBaseline,
    };
    const manifestPath = join(archiveDir, "manifest.json");
    atomicPublishJson(manifestPath, manifest);
    const manifestHash = sha256(manifestPath);
    const canonicalManifest = realpathSync(manifestPath);

    sourceDb.transaction(() => {
      const row = storedState(sourceDb, options.experimentId);
      if (row.archiveStatus !== "PREPARING" || row.sealedAt !== null) throw new Error("Archive preparation lost ownership");
      sourceDb.prepare(`UPDATE experiments SET sealed_at=?, ended_at=COALESCE(ended_at, ?),
        state='ENDED', archive_status='SEALED', archive_error=NULL WHERE experiment_id=?`)
        .run(sealedAt, sealedAt, options.experimentId);
      sourceDb.prepare(`INSERT INTO experiment_archives
        (experiment_id, snapshot_sha256, manifest_sha256, archived_at, archive_path, verified_at, verification_status)
        VALUES (?, ?, ?, ?, ?, ?, 'VERIFIED')`)
        .run(options.experimentId, file.sha256, manifestHash, sealedAt, canonicalManifest, Date.now());
    })();
    sourceSealed = true;
    const verified = verifyExperimentArchive(manifestPath, { sourceDbPath: source });
    if (!verified.valid) throw new Error(`Created archive failed anchored verification: ${verified.errors.join(", ")}`);
    return { ...manifest, manifestPath: canonicalManifest, snapshotPath: realpathSync(snapshotPath) };
  } catch (error) {
    if (!sourceSealed) {
      try {
        sourceDb.prepare(`UPDATE experiments SET archive_status='FAILED', archive_error=?,
          end_state_json=NULL WHERE experiment_id=? AND sealed_at IS NULL`)
          .run(error instanceof Error ? error.message : String(error), options.experimentId);
      } catch { /* original error remains authoritative */ }
    }
    throw error;
  } finally { sourceDb.close(); }
}

export function verifyExperimentArchive(manifestPath: string, options: ArchiveVerificationOptions): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  try {
    const canonicalManifest = safeExistingFile(manifestPath);
    const source = safeExistingFile(options.sourceDbPath);
    const manifest = parseManifest(canonicalManifest);
    const artifact = safeArtifact(canonicalManifest, manifest.files[0]!.path);
    const file = manifest.files[0]!;
    if (statSync(artifact).size !== file.bytes) errors.push(`${file.path}: size mismatch`);
    if (sha256(artifact) !== file.sha256) errors.push(`${file.path}: checksum mismatch`);
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      const anchor = db.prepare(`SELECT snapshot_sha256 AS snapshotSha256, manifest_sha256 AS manifestSha256,
        archive_path AS archivePath, verification_status AS verificationStatus, verified_at AS verifiedAt,
        e.sealed_at AS sourceSealedAt, e.archive_status AS sourceArchiveStatus
        FROM experiment_archives a JOIN experiments e ON e.experiment_id=a.experiment_id
        WHERE a.experiment_id=?`).get(manifest.experimentId) as
        { snapshotSha256: string; manifestSha256: string; archivePath: string | null; verificationStatus: string;
          verifiedAt: number | null; sourceSealedAt: number | null; sourceArchiveStatus: string } | undefined;
      if (!anchor || anchor.verificationStatus !== "VERIFIED" || anchor.verifiedAt === null) errors.push("missing verified source archive anchor");
      else {
        if (anchor.sourceArchiveStatus !== "SEALED" || anchor.sourceSealedAt !== manifest.sealedAt) errors.push("source experiment is not sealed at the anchored timestamp");
        if (anchor.archivePath !== canonicalManifest) errors.push("archive canonical path does not match source anchor");
        if (anchor.snapshotSha256 !== file.sha256) errors.push("snapshot checksum does not match source anchor");
        if (anchor.manifestSha256 !== sha256(canonicalManifest)) errors.push("manifest checksum does not match source anchor");
      }
    } finally { db.close(); }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: errors.length === 0, errors };
}

export function restoreExperimentArchive(manifestPath: string, destinationPath: string, options?: ArchiveVerificationOptions): { valid: boolean; errors: string[] } {
  if (!options) throw new Error("Restore requires a source database trust anchor");
  const verified = verifyExperimentArchive(manifestPath, options);
  if (!verified.valid) throw new Error(`Archive verification failed: ${verified.errors.join(", ")}`);
  assertNoSymlinkComponents(destinationPath, true);
  if (existsSync(destinationPath)) throw new Error("Restore destination must not already exist");
  mkdirSync(dirname(resolve(destinationPath)), { recursive: true });
  const manifest = parseManifest(manifestPath);
  const source = safeArtifact(manifestPath, manifest.files[0]!.path);
  copyFileSync(source, destinationPath, 0);
  const errors = sha256(destinationPath) === manifest.files[0]!.sha256 ? [] : ["restored artifact checksum mismatch"];
  return { valid: errors.length === 0, errors };
}
