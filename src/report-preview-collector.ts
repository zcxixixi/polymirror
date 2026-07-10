#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parsePreviewReportCollectorEnv,
  runPreviewReportCollector,
} from "./sim/preview-report-collector.js";
import type {
  GeneratePreviewAccountsReportOptions,
  PreviewAccountsReportResult,
} from "./sim/preview-report-runner.js";

function reportEnv(
  options: GeneratePreviewAccountsReportOptions | undefined
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    REPORT_JSON_STDOUT: "1",
    REPORT_DATA_DIR: options?.dataDir ?? "data/accounts",
    REPORT_OUT_DIR: options?.outDir ?? "reports/preview-live",
    REPORT_ACCOUNTS: options?.accounts?.join(",") ?? "",
    REPORT_STARTING_CAPITAL_USD: String(options?.startingCapitalUsd ?? 200),
    REPORT_LIMIT: String(options?.limit ?? 8),
    REPORT_WINDOW_MINUTES: options?.recentWindowMs
      ? String(options.recentWindowMs / 60_000)
      : "0",
  };
}

function lastJsonLine(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith("{") && line.endsWith("}"));
}

function runOneShotReportCommand(
  options: GeneratePreviewAccountsReportOptions | undefined,
  timeoutMs: number | undefined,
  stopSignal: AbortSignal
): Promise<PreviewAccountsReportResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./report-preview-accounts.js", import.meta.url))], {
      cwd: process.cwd(),
      env: reportEnv(options),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
    };
    const isRunning = () => child.exitCode === null && child.signalCode === null;
    const terminate = () => {
      if (isRunning()) child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        if (isRunning()) child.kill("SIGKILL");
      }, 2_000);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };

    if (timeoutMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
    }

    stopSignal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimers();
      stopSignal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      stopSignal.removeEventListener("abort", onAbort);
      if (timedOut) {
        reject(new Error(`preview report command timed out after ${timeoutMs}ms`));
        return;
      }
      if (aborted) {
        reject(new Error("preview report command aborted"));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `preview report command failed code=${code} signal=${signal ?? "none"} stderr=${stderr.trim()}`
          )
        );
        return;
      }

      const jsonLine = lastJsonLine(stdout);
      if (!jsonLine) {
        reject(new Error("preview report command did not emit JSON result"));
        return;
      }
      try {
        resolve(JSON.parse(jsonLine) as PreviewAccountsReportResult);
      } catch (e) {
        reject(
          new Error(
            `preview report command emitted invalid JSON: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        );
      }
    });
  });
}

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

const options = parsePreviewReportCollectorEnv();
const summary = await runPreviewReportCollector({
  ...options,
  runTimeoutMs: undefined,
  stopSignal: controller.signal,
  generate: () =>
    runOneShotReportCommand(
      options.reportOptions,
      options.runTimeoutMs,
      controller.signal
    ),
  onResult: (result, run) => {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        run,
        outPath: result.outPath,
        summaryPath: result.summaryPath,
        liveReady: result.summary.liveReadyCount,
        accountCount: result.summary.accountCount,
        realizedPnlUsd: result.summary.totals.realizedPnlUsd,
        openCostUsd: result.summary.totals.openCostUsd,
        risks: result.summary.riskCounts,
      })
    );
  },
  onError: (error, run) => {
    console.error(
      JSON.stringify({
        at: new Date().toISOString(),
        run,
        error: error.message,
      })
    );
  },
});

console.log(JSON.stringify({ at: new Date().toISOString(), summary }));
