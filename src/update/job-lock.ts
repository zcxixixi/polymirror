import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureUpdatesDir, isJobActive, loadUpdateState } from "./apply-state.js";
import { updatesDir } from "./paths.js";

let held = false;

function lockPath(): string {
  return join(updatesDir(), "job.lock");
}

/** Clear a leftover lock if no active job is recorded (e.g. after crash). */
export function clearStaleUpdateJobLock(): void {
  const path = lockPath();
  if (!existsSync(path)) return;
  const state = loadUpdateState();
  if (isJobActive(state.job)) return;
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
  held = false;
}

/**
 * Exclusive in-process + file lock so concurrent apply/rollback POSTs cannot
 * overlap. Returns false if another job holds the lock.
 */
export function tryAcquireUpdateJobLock(): boolean {
  if (held) return false;
  ensureUpdatesDir();
  clearStaleUpdateJobLock();
  const path = lockPath();
  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
    } finally {
      closeSync(fd);
    }
    held = true;
    return true;
  } catch {
    return false;
  }
}

export function releaseUpdateJobLock(): void {
  if (!held) return;
  held = false;
  try {
    unlinkSync(lockPath());
  } catch {
    /* ignore */
  }
}

/** Test helper. */
export function resetUpdateJobLockForTests(): void {
  held = false;
  try {
    unlinkSync(lockPath());
  } catch {
    /* ignore */
  }
}
