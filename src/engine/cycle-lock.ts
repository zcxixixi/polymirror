/**
 * Serializes poll cycles vs control-plane reloads so SQLite is never closed
 * under an active copy cycle. Reload/control-plane work is single-flight.
 *
 * Maintenance mode (self-update) blocks new poll cycles until the process
 * restarts or {@link exitMaintenance} is called after a failed update restore.
 */
let cycleHeld = false;
let reloadWaiters = 0;
let maintenanceDepth = 0;
/** Chains control-plane sections so only one runs at a time. */
let reloadTail: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Begin a poll cycle. Returns false if a cycle, reload, or maintenance is active. */
export function tryBeginCycle(): boolean {
  if (cycleHeld || reloadWaiters > 0 || maintenanceDepth > 0) return false;
  cycleHeld = true;
  return true;
}

export function endCycle(): void {
  cycleHeld = false;
}

/** Block new poll cycles (self-update / maintenance window). Nested-safe. */
export function enterMaintenance(): void {
  maintenanceDepth++;
}

export function exitMaintenance(): void {
  if (maintenanceDepth > 0) maintenanceDepth--;
}

export function isMaintenanceActive(): boolean {
  return maintenanceDepth > 0;
}

/** Wait until no poll cycle is holding the lock (does not clear maintenance). */
export async function waitForCycleIdle(timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (cycleHeld) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for copy cycle to finish before maintenance");
    }
    await sleep(50);
  }
}

/**
 * Wait for any in-flight cycle and prior control-plane work, then run `fn`
 * while blocking new cycles. Concurrent callers are serialized (single-flight).
 */
export async function withReloadLock<T>(fn: () => Promise<T>): Promise<T> {
  if (maintenanceDepth > 0) {
    throw new Error("Config reload blocked while a self-update maintenance window is active");
  }
  reloadWaiters++;
  const run = reloadTail.then(async () => {
    while (cycleHeld) {
      await sleep(50);
    }
    if (maintenanceDepth > 0) {
      throw new Error("Config reload blocked while a self-update maintenance window is active");
    }
    return fn();
  });
  // Keep the chain alive even if this section rejects.
  reloadTail = run.then(
    () => undefined,
    () => undefined
  );
  try {
    return await run;
  } finally {
    reloadWaiters--;
  }
}

/** Test helper — reset lock state between unit tests. */
export function resetCycleLockForTests(): void {
  cycleHeld = false;
  reloadWaiters = 0;
  maintenanceDepth = 0;
  reloadTail = Promise.resolve();
}
