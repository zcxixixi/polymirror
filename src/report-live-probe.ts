#!/usr/bin/env node
import "dotenv/config";
import { join } from "node:path";
import { loadMultiAccountConfig } from "./config/load.js";
import {
  createLiveProbeSnapshot,
  writeLiveProbeJsonl,
} from "./live/probe.js";
import {
  assessLiveProbeSubmitGuard,
  buildLiveProbeOrderRequest,
  parseLiveProbeSubmitEnv,
  serializeLiveProbeOrderResult,
  type LiveProbeSubmitAttempt,
} from "./live/probe-submit.js";
import type { Activity } from "./monitor/data-api.js";

type FetchWalletCollateral = typeof import("./executor/balance.js")["fetchWalletCollateral"];
type WalletCollateral = Awaited<ReturnType<FetchWalletCollateral>>;

const accountId = process.env.LIVE_PROBE_ACCOUNT_ID ?? "live_probe_empty";
const outDir = process.env.LIVE_PROBE_OUT_DIR ?? "reports/live-probe";
const outFile =
  process.env.LIVE_PROBE_OUT_FILE ??
  join(outDir, `live-probe-${new Date().toISOString().slice(0, 10)}.jsonl`);
const geoblockTimeoutMs = parseTimeoutMs("LIVE_PROBE_GEOBLOCK_TIMEOUT_MS", 15_000);
const pollTimeoutMs = parseTimeoutMs("LIVE_PROBE_POLL_TIMEOUT_MS", 45_000);
const collateralTimeoutMs = parseTimeoutMs("LIVE_PROBE_COLLATERAL_TIMEOUT_MS", 30_000);
const importTimeoutMs = parseTimeoutMs("LIVE_PROBE_IMPORT_TIMEOUT_MS", 10_000);
const submitTimeoutMs = parseTimeoutMs("LIVE_PROBE_SUBMIT_TIMEOUT_MS", 30_000);
const submitOptions = parseLiveProbeSubmitEnv();

let forceExitAfterWrite = false;

function parseTimeoutMs(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function logProbe(stage: string, detail: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ at: new Date().toISOString(), stage, ...detail }));
}

async function withTimeout<T>(
  stage: string,
  timeoutMs: number,
  task: Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      forceExitAfterWrite = true;
      reject(new Error(`${stage} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

logProbe("config:start");
const multi = loadMultiAccountConfig(process.env.CONFIG_PATH ?? "config.yaml");
const account = multi.accounts.find((item) => item.id === accountId);
if (!account) throw new Error(`Live probe account not found: ${accountId}`);
logProbe("config:done", { accountId, previewMode: account.config.app.global.previewMode });

let candidateCount = 0;
let candidateError: string | undefined;
let submitCandidate:
  | {
      leaderId: string;
      activity: Activity;
      order: ReturnType<typeof buildLiveProbeOrderRequest> extends infer R
        ? R extends { allow: true; order: infer O }
          ? O
          : never
        : never;
      reasoning: string;
    }
  | undefined;
let collateralError: string | undefined;
let geoblock: Awaited<ReturnType<typeof import("./executor/geoblock.js")["fetchGeoblockStatus"]>> | null = null;
try {
  logProbe("geoblock:import:start", { timeoutMs: importTimeoutMs });
  const geoblockModule = await withTimeout(
    "geoblock import",
    importTimeoutMs,
    import("./executor/geoblock.js")
  );
  logProbe("geoblock:start", { timeoutMs: geoblockTimeoutMs });
  geoblock = await withTimeout(
    "geoblock",
    geoblockTimeoutMs,
    geoblockModule.fetchGeoblockStatus()
  );
} catch (e) {
  logProbe("geoblock:error", { error: errMessage(e) });
  geoblock = null;
}
logProbe("geoblock:done", { blocked: geoblock?.blocked ?? null, ip: geoblock?.ip ?? null });

try {
  logProbe("poll:import:start", { timeoutMs: importTimeoutMs });
  const [registryModule, pollModule] = await withTimeout(
    "poll import",
    importTimeoutMs,
    Promise.all([import("./leaders/registry.js"), import("./monitor/poll.js")])
  );
  logProbe("poll:start", { timeoutMs: pollTimeoutMs });
  const registry = new registryModule.LeaderRegistry(account.config.app.leaders);
  const polls = await withTimeout(
    "poll leaders",
    pollTimeoutMs,
    pollModule.pollLeaders(registry, account.config.app.global)
  );
  candidateCount = polls.reduce((sum, poll) => sum + poll.candidates.length, 0);
  for (const poll of polls) {
    const leader = registry.getById(poll.leaderId);
    if (!leader) continue;
    for (const activity of poll.candidates) {
      const built = buildLiveProbeOrderRequest({
        leader,
        global: account.config.app.global,
        activity,
        maxNotionalUsd: submitOptions.maxNotionalUsd,
      });
      if (built.allow) {
        submitCandidate = {
          leaderId: poll.leaderId,
          activity,
          order: built.order,
          reasoning: built.reasoning,
        };
        break;
      }
    }
    if (submitCandidate) break;
  }
  const errors = polls.map((poll) => poll.error).filter((err): err is string => Boolean(err));
  candidateError = errors.length > 0 ? errors.slice(0, 3).join("; ") : undefined;
  logProbe("poll:done", {
    candidateCount,
    submitCandidate: submitCandidate?.activity.asset?.slice(0, 12) ?? null,
    pollErrors: errors.length,
  });
} catch (e) {
  candidateError = errMessage(e);
  logProbe("poll:error", { error: candidateError });
}

const shouldFetchCollateral =
  account.config.app.global.previewMode === false &&
  geoblock?.blocked !== true &&
  candidateCount > 0;
let collateral: WalletCollateral | null = null;
if (shouldFetchCollateral) {
  try {
    logProbe("collateral:import:start", { timeoutMs: importTimeoutMs });
    const balanceModule = await withTimeout(
      "collateral import",
      importTimeoutMs,
      import("./executor/balance.js")
    );
    logProbe("collateral:start", { timeoutMs: collateralTimeoutMs });
    collateral = await withTimeout(
      "collateral",
      collateralTimeoutMs,
      balanceModule.fetchWalletCollateral(account.config.wallet)
    );
    logProbe("collateral:done", { source: collateral.source, cashUsd: collateral.cashUsd });
  } catch (e) {
    collateralError = errMessage(e);
    logProbe("collateral:error", { error: collateralError });
  }
} else {
  logProbe("collateral:skip", {
    previewMode: account.config.app.global.previewMode,
    geoblocked: geoblock?.blocked ?? null,
    candidateCount,
  });
}

const snapshot = createLiveProbeSnapshot({
  account,
  geoblock,
  candidateCount,
  candidateError,
  collateral,
  collateralError,
});

if (submitOptions.enabled) {
  const guard = assessLiveProbeSubmitGuard({
    account,
    snapshot,
    collateral,
    options: submitOptions,
  });
  let attempt: LiveProbeSubmitAttempt = {
    enabled: true,
    allowed: guard.allow,
    submitted: false,
    reason: guard.reason,
  };

  if (guard.allow && !submitCandidate) {
    attempt = {
      enabled: true,
      allowed: false,
      submitted: false,
      reason: "no eligible BUY candidate for submit probe",
    };
  } else if (guard.allow && submitCandidate) {
    try {
      logProbe("submit:import:start", { timeoutMs: importTimeoutMs });
      const clobModule = await withTimeout(
        "submit import",
        importTimeoutMs,
        import("./executor/clob.js")
      );
      const executor = new clobModule.ClobExecutor(
        account.config.wallet,
        account.config.app.global
      );
      logProbe("submit:start", {
        timeoutMs: submitTimeoutMs,
        leaderId: submitCandidate.leaderId,
        token: submitCandidate.order.tokenId.slice(0, 12),
        notionalUsd: submitCandidate.order.notionalUsd,
        reasoning: submitCandidate.reasoning,
      });
      const result = await withTimeout(
        "submit order",
        submitTimeoutMs,
        executor.placeLimitOrder(submitCandidate.order)
      );
      if (result.orderId && result.pendingRemaining > 0) {
        try {
          const cancel = await executor.cancelOrder(result.orderId);
          result.orderStatus = `${result.orderStatus ?? "submitted"}; cancel=${cancel.ok ? "ok" : cancel.error ?? "failed"}`;
        } catch (e) {
          const msg = errMessage(e);
          result.orderStatus = `${result.orderStatus ?? "submitted"}; cancel failed: ${msg}`;
        }
      }
      attempt = {
        enabled: true,
        allowed: true,
        submitted: true,
        reason: guard.reason,
        request: {
          leaderId: submitCandidate.leaderId,
          tokenId: submitCandidate.order.tokenId,
          side: submitCandidate.order.side,
          price: submitCandidate.order.price,
          size: submitCandidate.order.size,
          notionalUsd: submitCandidate.order.notionalUsd,
        },
        result: serializeLiveProbeOrderResult(result),
      };
      logProbe("submit:done", {
        orderId: result.orderId ?? null,
        error: result.error ?? null,
        status: result.orderStatus ?? null,
      });
    } catch (e) {
      attempt = {
        enabled: true,
        allowed: true,
        submitted: false,
        reason: errMessage(e),
      };
      logProbe("submit:error", { error: attempt.reason });
    }
  }
  snapshot.orderAttempt = attempt;
}

writeLiveProbeJsonl(outFile, snapshot);
console.log(JSON.stringify({ outFile, ...snapshot }, null, 2));
if (forceExitAfterWrite) {
  setTimeout(() => process.exit(0), 10);
}
