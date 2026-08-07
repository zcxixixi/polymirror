/**
 * Serializes poll cycles vs control-plane reloads so SQLite is never closed
 * under an active copy cycle. Reload/control-plane work is single-flight.
 */
let cycleHeld = false;
let reloadWaiters = 0;
/** Chains control-plane sections so only one runs at a time. */
let reloadTail: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Begin a poll cycle. Returns false if a cycle or reload is already in progress. */
export function tryBeginCycle(): boolean {
  if (cycleHeld || reloadWaiters > 0) return false;
  cycleHeld = true;
  return true;
}

export function endCycle(): void {
  cycleHeld = false;
}

/**
 * Wait for any in-flight cycle and prior control-plane work, then run `fn`
 * while blocking new cycles. Concurrent callers are serialized (single-flight).
 */
export async function withReloadLock<T>(fn: () => Promise<T>): Promise<T> {
  reloadWaiters++;
  const run = reloadTail.then(async () => {
    while (cycleHeld) {
      await sleep(50);
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
  reloadTail = Promise.resolve();
}
