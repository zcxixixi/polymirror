import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fetchWithTimeout } from "../util/fetch.js";
import {
  enterMaintenance,
  exitMaintenance,
  waitForCycleIdle,
} from "../engine/cycle-lock.js";
import {
  getAppVersion,
  getProjectRoot,
  isNewerVersion,
  normalizeVersionLabel,
  resetAppVersionCache,
} from "../version.js";
import { fetchReleaseByVersion, githubHeaders } from "./check.js";
import {
  appendJobLog,
  ensureUpdatesDir,
  isJobActive,
  loadUpdateState,
  patchJob,
  saveUpdateState,
  type UpdateJobState,
  type UpdatePersistedState,
} from "./apply-state.js";
import {
  PRESERVE_NAMES,
  updateDownloadsDir,
  updateRollbackDir,
  updateStagingDir,
  isRunningInDocker,
  selfUpdateEnabled,
} from "./paths.js";
import { tryAcquireUpdateJobLock, releaseUpdateJobLock } from "./job-lock.js";
import { scheduleProcessRestart } from "./restart.js";
import { logInfo, logError } from "../notify/logger.js";

const CONFIRM_APPLY_PREFIX = "UPDATE_TO_";
const CONFIRM_ROLLBACK_PREFIX = "ROLLBACK_TO_";

export type LiveGuard = () => boolean;

export function applyConfirmPhrase(version: string): string {
  return `${CONFIRM_APPLY_PREFIX}${normalizeVersionLabel(version)}`;
}

export function rollbackConfirmPhrase(version: string): string {
  return `${CONFIRM_ROLLBACK_PREFIX}${normalizeVersionLabel(version)}`;
}

function assertSelfUpdateAllowed(anyLive: boolean): void {
  if (!selfUpdateEnabled()) {
    throw new Error("Self-update disabled. Set POLYMIRROR_SELF_UPDATE=true to opt in.");
  }
  if (isRunningInDocker()) {
    throw new Error("Self-update is not supported inside Docker.");
  }
  if (anyLive) {
    throw new Error("Refuse to update while any account is in Live mode — switch to Preview first.");
  }
}

function assertStillPreview(isAnyLive?: LiveGuard): void {
  if (isAnyLive?.()) {
    throw new Error(
      "Update aborted: an account entered Live mode during the job — switch back to Preview and retry."
    );
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onLine?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handle = (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) onLine?.(trimmed.slice(0, 300));
      }
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.on("error", (e) => reject(new Error(`${command} failed to start: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function downloadTarball(
  url: string,
  destFile: string,
  onLog: (s: string) => void
): Promise<void> {
  mkdirSync(join(destFile, ".."), { recursive: true });
  onLog(`Downloading release archive`);
  const res = await fetchWithTimeout(url, {
    headers: githubHeaders("application/octet-stream"),
    timeoutMs: 120_000,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Download failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(destFile));
  onLog(`Saved ${basename(destFile)} (${statSync(destFile).size} bytes)`);
}

async function extractTarballAsync(
  archive: string,
  destDir: string,
  onLog: (s: string) => void
): Promise<string> {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  onLog("Extracting release archive");
  await runCommand("tar", ["-xzf", archive, "-C", destDir], getProjectRoot());
  return findExtractedRoot(destDir);
}

function findExtractedRoot(destDir: string): string {
  const entries = readdirSync(destDir).filter((n) => !n.startsWith("."));
  if (entries.length === 1) {
    const only = join(destDir, entries[0]!);
    if (statSync(only).isDirectory()) return only;
  }
  if (existsSync(join(destDir, "package.json"))) return destDir;
  throw new Error("Could not locate extracted release root (package.json missing)");
}

async function createCodeBackupAsync(
  fromVersion: string,
  onLog: (s: string) => void
): Promise<string> {
  const dir = updateRollbackDir();
  mkdirSync(dir, { recursive: true });
  const bundlePath = join(dir, `backup-${fromVersion}-${Date.now()}.tar.gz`);
  onLog(`Creating rollback bundle → ${basename(bundlePath)}`);
  const root = getProjectRoot();
  await runCommand(
    "tar",
    [
      "-czf",
      bundlePath,
      "--exclude=./node_modules",
      "--exclude=./dashboard/node_modules",
      "--exclude=./data",
      "--exclude=./.git",
      "--exclude=./.env",
      "--exclude=./config.yaml",
      "--exclude=./config.yaml.bak",
      "--exclude=./config.local.yaml",
      "-C",
      root,
      ".",
    ],
    root,
    onLog
  );
  return bundlePath;
}

function copyReleaseTree(srcRoot: string, onLog: (s: string) => void): void {
  const destRoot = getProjectRoot();
  onLog("Copying release files into install root");
  for (const name of readdirSync(srcRoot)) {
    if (PRESERVE_NAMES.has(name)) continue;
    const from = join(srcRoot, name);
    const to = join(destRoot, name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
}

async function restoreBundleAsync(bundlePath: string, onLog: (s: string) => void): Promise<void> {
  if (!existsSync(bundlePath)) {
    throw new Error(`Rollback bundle missing: ${bundlePath}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "polymirror-rollback-"));
  try {
    onLog("Extracting rollback bundle");
    await runCommand("tar", ["-xzf", bundlePath, "-C", tmp], getProjectRoot());
    copyReleaseTree(tmp, onLog);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Install root + dashboard deps (dashboard has its own lockfile), then build. */
export async function npmInstallAndBuild(onLog: (s: string) => void): Promise<void> {
  const root = getProjectRoot();
  const hasLock = existsSync(join(root, "package-lock.json"));
  onLog(hasLock ? "Running npm ci (root)" : "Running npm install (root)");
  await runCommand("npm", hasLock ? ["ci"] : ["install"], root, onLog);

  const dashRoot = join(root, "dashboard");
  if (existsSync(join(dashRoot, "package.json"))) {
    const dashLock = existsSync(join(dashRoot, "package-lock.json"));
    onLog(dashLock ? "Running npm ci (dashboard)" : "Running npm install (dashboard)");
    await runCommand("npm", dashLock ? ["ci"] : ["install"], dashRoot, onLog);
  }

  onLog("Building daemon + dashboard");
  await runCommand("npm", ["run", "build"], root, onLog);
}

function newJob(
  action: "apply" | "rollback",
  targetVersion: string,
  fromVersion: string
): UpdateJobState {
  const now = Date.now();
  return {
    id: `${action}-${now}`,
    action,
    phase: "queued",
    targetVersion: normalizeVersionLabel(targetVersion),
    fromVersion: normalizeVersionLabel(fromVersion),
    error: null,
    startedAt: now,
    updatedAt: now,
    logTail: [],
  };
}

function logToJob(line: string): void {
  try {
    patchJob((job) => appendJobLog(job, line));
  } catch {
    /* ignore */
  }
}

function setPhase(phase: UpdateJobState["phase"]): void {
  patchJob((job) => {
    job.phase = phase;
    appendJobLog(job, `phase → ${phase}`);
  });
}

function persistRollback(
  fromVersion: string,
  replacedBy: string,
  bundlePath: string
): void {
  const state = loadUpdateState();
  state.rollback = {
    version: fromVersion,
    replacedBy,
    bundlePath,
    createdAt: Date.now(),
  };
  saveUpdateState(state);
}

async function autoRestoreAfterFailure(
  bundlePath: string | null,
  treeMutated: boolean
): Promise<string | null> {
  if (!treeMutated || !bundlePath) return null;
  try {
    logToJob("Auto-restoring code from backup after failure…");
    await restoreBundleAsync(bundlePath, logToJob);
    resetAppVersionCache();
    try {
      await npmInstallAndBuild(logToJob);
      logToJob("Auto-restore completed (source + rebuild)");
      return "restored";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logToJob(`Auto-restore wrote source back but rebuild failed: ${msg}`);
      return "source_only";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logToJob(`Auto-restore FAILED: ${msg}`);
    return "failed";
  }
}

function finishJobFailed(msg: string, restoreNote: string | null): void {
  try {
    patchJob((job) => {
      job.phase = "failed";
      job.error = restoreNote ? `${msg} [${restoreNote}]` : msg;
      appendJobLog(job, `FAILED: ${job.error}`);
    });
  } catch {
    /* no job */
  }
}

async function beginMaintenanceWindow(onLog: (s: string) => void): Promise<void> {
  onLog("Entering maintenance — pausing copy poll cycles");
  enterMaintenance();
  try {
    await waitForCycleIdle();
  } catch (e) {
    exitMaintenance();
    throw e;
  }
  onLog("Copy cycles idle — safe to mutate install tree");
}

function endMaintenanceWindow(keepHeld: boolean): void {
  if (keepHeld) {
    // Process will exit / operator must restart; keep polls blocked.
    return;
  }
  exitMaintenance();
}

async function runApplyJob(targetVersion: string, isAnyLive?: LiveGuard): Promise<void> {
  const root = getProjectRoot();
  ensureUpdatesDir();
  let bundlePath: string | null = null;
  let treeMutated = false;
  let maintenanceEntered = false;

  try {
    await beginMaintenanceWindow(logToJob);
    maintenanceEntered = true;
    assertStillPreview(isAnyLive);

    setPhase("downloading");
    const release = await fetchReleaseByVersion(targetVersion);
    if (normalizeVersionLabel(release.latestVersion) !== normalizeVersionLabel(targetVersion)) {
      throw new Error(
        `Requested ${targetVersion} but GitHub Release resolved to ${release.latestVersion}`
      );
    }
    assertStillPreview(isAnyLive);

    const tarball = join(updateDownloadsDir(), `v${release.latestVersion}.tar.gz`);
    await downloadTarball(release.tarballUrl, tarball, logToJob);

    setPhase("backing_up");
    const fromVersion = getAppVersion();
    bundlePath = await createCodeBackupAsync(fromVersion, logToJob);
    // Persist rollback before mutating so UI can recover even if build fails.
    persistRollback(fromVersion, release.latestVersion, bundlePath);

    assertStillPreview(isAnyLive);
    setPhase("extracting");
    const extracted = await extractTarballAsync(tarball, updateStagingDir(), logToJob);
    if (!existsSync(join(extracted, "package.json"))) {
      throw new Error("Release package.json missing");
    }

    assertStillPreview(isAnyLive);
    copyReleaseTree(extracted, logToJob);
    treeMutated = true;
    resetAppVersionCache();

    setPhase("installing");
    assertStillPreview(isAnyLive);
    setPhase("building");
    await npmInstallAndBuild(logToJob);
    assertStillPreview(isAnyLive);

    const state = loadUpdateState();
    if (state.job) {
      state.job.phase = "restarting";
      appendJobLog(state.job, "Build complete — restarting process");
    }
    saveUpdateState(state);

    logInfo("Self-update ready to restart", {
      from: fromVersion,
      to: release.latestVersion,
      root,
    });

    const mode = scheduleProcessRestart();
    if (mode === "none") {
      patchJob((job) => {
        job.phase = "succeeded";
        appendJobLog(
          job,
          "Files updated; POLYMIRROR_UPDATE_RESTART=none — restart the process manually (poll stays paused until then)"
        );
      });
      // Keep maintenance held so we do not poll with a half-swapped native tree.
      endMaintenanceWindow(true);
      releaseUpdateJobLock();
      return;
    }

    // Restart scheduled — keep maintenance + lock until process exits.
    endMaintenanceWindow(true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError("Self-update failed", { error: msg });
    const restore = await autoRestoreAfterFailure(bundlePath, treeMutated);
    const restoreNote =
      restore === "restored"
        ? "auto-restored from backup"
        : restore === "source_only"
          ? "source restored; rebuild incomplete — restart recommended"
          : restore === "failed"
            ? "auto-restore failed — manual recovery may be required"
            : null;
    finishJobFailed(msg, restoreNote);
    if (maintenanceEntered) endMaintenanceWindow(false);
    releaseUpdateJobLock();
  }
}

async function runRollbackJob(targetVersion: string, isAnyLive?: LiveGuard): Promise<void> {
  let treeMutated = false;
  let maintenanceEntered = false;
  let bundlePath: string | null = null;

  try {
    await beginMaintenanceWindow(logToJob);
    maintenanceEntered = true;
    assertStillPreview(isAnyLive);

    const state = loadUpdateState();
    const bundle = state.rollback;
    if (!bundle) throw new Error("No rollback bundle available");
    if (normalizeVersionLabel(bundle.version) !== normalizeVersionLabel(targetVersion)) {
      throw new Error(
        `Rollback target mismatch: bundle is ${bundle.version}, requested ${targetVersion}`
      );
    }
    bundlePath = bundle.bundlePath;

    setPhase("rolling_back");
    assertStillPreview(isAnyLive);
    await restoreBundleAsync(bundle.bundlePath, logToJob);
    treeMutated = true;
    resetAppVersionCache();

    setPhase("building");
    assertStillPreview(isAnyLive);
    await npmInstallAndBuild(logToJob);

    const next = loadUpdateState();
    next.rollback = null;
    if (next.job) {
      next.job.phase = "restarting";
      appendJobLog(next.job, "Rollback build complete — restarting process");
    }
    saveUpdateState(next);

    const mode = scheduleProcessRestart();
    if (mode === "none") {
      patchJob((job) => {
        job.phase = "succeeded";
        appendJobLog(
          job,
          "Rollback files applied; POLYMIRROR_UPDATE_RESTART=none — restart manually (poll stays paused)"
        );
      });
      endMaintenanceWindow(true);
      releaseUpdateJobLock();
      return;
    }
    endMaintenanceWindow(true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError("Rollback failed", { error: msg });
    // If we mutated mid-rollback, try to re-apply the same bundle again.
    if (treeMutated && bundlePath) {
      await autoRestoreAfterFailure(bundlePath, true);
    }
    finishJobFailed(msg, treeMutated ? "attempted re-apply of rollback bundle" : null);
    if (maintenanceEntered) endMaintenanceWindow(false);
    releaseUpdateJobLock();
  }
}

export function startApplyUpdate(opts: {
  version: string;
  confirm: string;
  anyLive: boolean;
  isAnyLive?: LiveGuard;
}): { status: number; body: unknown } {
  try {
    assertSelfUpdateAllowed(opts.anyLive);
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
  }

  const target = normalizeVersionLabel(opts.version);
  const expected = applyConfirmPhrase(target);
  if (opts.confirm.trim() !== expected) {
    return {
      status: 400,
      body: {
        error: `Confirmation mismatch. Type exactly: ${expected}`,
        confirmPhrase: expected,
      },
    };
  }

  const state = loadUpdateState();
  if (isJobActive(state.job)) {
    return { status: 409, body: { error: "An update job is already running", job: state.job } };
  }

  if (!tryAcquireUpdateJobLock()) {
    return { status: 409, body: { error: "An update job lock is already held" } };
  }

  const current = getAppVersion();
  if (!isNewerVersion(target, current)) {
    releaseUpdateJobLock();
    return {
      status: 400,
      body: { error: `Target ${target} is not newer than current ${current}` },
    };
  }

  const job = newJob("apply", target, current);
  appendJobLog(job, `Queued apply ${current} → ${target}`);
  const next: UpdatePersistedState = { ...state, job };
  saveUpdateState(next);

  void runApplyJob(target, opts.isAnyLive);

  return {
    status: 202,
    body: {
      ok: true,
      message: "Update started. Copy polling is paused until restart.",
      job: { ...job, active: true },
      confirmPhrase: expected,
    },
  };
}

export function startRollback(opts: {
  confirm: string;
  anyLive: boolean;
  isAnyLive?: LiveGuard;
}): { status: number; body: unknown } {
  try {
    assertSelfUpdateAllowed(opts.anyLive);
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
  }

  const state = loadUpdateState();
  if (!state.rollback) {
    return { status: 400, body: { error: "No rollback bundle available" } };
  }
  if (isJobActive(state.job)) {
    return { status: 409, body: { error: "An update job is already running", job: state.job } };
  }

  if (!tryAcquireUpdateJobLock()) {
    return { status: 409, body: { error: "An update job lock is already held" } };
  }

  const target = state.rollback.version;
  const expected = rollbackConfirmPhrase(target);
  if (opts.confirm.trim() !== expected) {
    releaseUpdateJobLock();
    return {
      status: 400,
      body: {
        error: `Confirmation mismatch. Type exactly: ${expected}`,
        confirmPhrase: expected,
      },
    };
  }

  const job = newJob("rollback", target, getAppVersion());
  appendJobLog(job, `Queued rollback → ${target}`);
  saveUpdateState({ ...state, job });

  void runRollbackJob(target, opts.isAnyLive);

  return {
    status: 202,
    body: {
      ok: true,
      message: "Rollback started. Copy polling is paused until restart.",
      job: { ...job, active: true },
      confirmPhrase: expected,
    },
  };
}
