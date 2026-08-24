import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAppVersion } from "../version.js";
import { updateStatePath, updatesDir } from "./paths.js";

export type UpdateJobPhase =
  | "queued"
  | "downloading"
  | "backing_up"
  | "extracting"
  | "installing"
  | "building"
  | "restarting"
  | "succeeded"
  | "failed"
  | "rolling_back";

export interface UpdateJobState {
  id: string;
  action: "apply" | "rollback";
  phase: UpdateJobPhase;
  targetVersion: string;
  fromVersion: string;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  logTail: string[];
}

export interface RollbackBundle {
  /** Version restored by rollback (the pre-update install). */
  version: string;
  /** Version that was applied when this backup was taken. */
  replacedBy: string;
  bundlePath: string;
  createdAt: number;
}

export interface UpdatePersistedState {
  job: UpdateJobState | null;
  rollback: RollbackBundle | null;
  lastSuccess: {
    action: "apply" | "rollback";
    version: string;
    at: number;
  } | null;
}

export interface UpdateJobView {
  id: string;
  action: "apply" | "rollback";
  phase: UpdateJobPhase;
  targetVersion: string;
  fromVersion: string;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  logTail: string[];
  active: boolean;
}

const ACTIVE_PHASES = new Set<UpdateJobPhase>([
  "queued",
  "downloading",
  "backing_up",
  "extracting",
  "installing",
  "building",
  "restarting",
  "rolling_back",
]);

function emptyState(): UpdatePersistedState {
  return { job: null, rollback: null, lastSuccess: null };
}

export function ensureUpdatesDir(): void {
  mkdirSync(updatesDir(), { recursive: true });
}

export function loadUpdateState(): UpdatePersistedState {
  const path = updateStatePath();
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as UpdatePersistedState;
    return {
      job: raw.job ?? null,
      rollback: raw.rollback ?? null,
      lastSuccess: raw.lastSuccess ?? null,
    };
  } catch {
    return emptyState();
  }
}

export function saveUpdateState(state: UpdatePersistedState): void {
  ensureUpdatesDir();
  writeFileSync(updateStatePath(), JSON.stringify(state, null, 2), "utf8");
}

export function isJobActive(job: UpdateJobState | null | undefined): boolean {
  return !!job && ACTIVE_PHASES.has(job.phase);
}

export function getUpdateJobView(state?: UpdatePersistedState): UpdateJobView | null {
  const s = state ?? loadUpdateState();
  if (!s.job) return null;
  return {
    ...s.job,
    active: isJobActive(s.job),
  };
}

export function appendJobLog(job: UpdateJobState, line: string): void {
  const entry = `[${new Date().toISOString()}] ${line}`;
  job.logTail = [...job.logTail.slice(-40), entry];
  job.updatedAt = Date.now();
}

export function patchJob(
  mutator: (job: UpdateJobState, state: UpdatePersistedState) => void
): UpdatePersistedState {
  const state = loadUpdateState();
  if (!state.job) throw new Error("No active update job");
  mutator(state.job, state);
  state.job.updatedAt = Date.now();
  saveUpdateState(state);
  return state;
}

/** After process restart, mark apply/rollback as succeeded when versions match. */
export function reconcileJobAfterRestart(): void {
  const state = loadUpdateState();
  const job = state.job;
  if (!job) return;
  if (job.phase !== "restarting") return;

  const current = getAppVersion();
  if (normalizeLoose(current) === normalizeLoose(job.targetVersion)) {
    job.phase = "succeeded";
    job.error = null;
    job.updatedAt = Date.now();
    appendJobLog(job, `Restart complete — running ${current}`);
    state.lastSuccess = {
      action: job.action,
      version: current,
      at: Date.now(),
    };
    saveUpdateState(state);
    return;
  }

  job.phase = "failed";
  job.error = `Restart finished but version is ${current}, expected ${job.targetVersion}`;
  job.updatedAt = Date.now();
  appendJobLog(job, job.error);
  saveUpdateState(state);
}

function normalizeLoose(v: string): string {
  return v.trim().replace(/^v/i, "");
}

/** Test helper. */
export function resetUpdateStateForTests(): void {
  saveUpdateState(emptyState());
}
