import {
  generatePreviewAccountsReport,
  parsePreviewReportAccounts,
  type GeneratePreviewAccountsReportOptions,
  type PreviewAccountsReportResult,
} from "./preview-report-runner.js";

export type PreviewReportGenerator =
  () => PreviewAccountsReportResult | Promise<PreviewAccountsReportResult>;

export interface PreviewReportCollectorOptions {
  intervalMs: number;
  maxRuns?: number;
  runImmediately?: boolean;
  runTimeoutMs?: number;
  reportOptions?: GeneratePreviewAccountsReportOptions;
  generate?: PreviewReportGenerator;
  onResult?: (result: PreviewAccountsReportResult, run: number) => void;
  onError?: (error: Error, run: number) => void;
  stopSignal?: AbortSignal;
}

export interface PreviewReportCollectorSummary {
  startedAt: string;
  stoppedAt: string;
  runs: number;
  errors: number;
  stoppedBy: "maxRuns" | "aborted";
  lastOutPath?: string;
  lastSummaryPath?: string;
  lastError?: string;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export function parsePreviewReportCollectorEnv(
  env: NodeJS.ProcessEnv = process.env
): PreviewReportCollectorOptions {
  const intervalMinutes = positiveNumber(env.REPORT_COLLECT_INTERVAL_MINUTES) ?? 15;
  const recentWindowMinutes = positiveNumber(env.REPORT_WINDOW_MINUTES);
  return {
    intervalMs: Math.max(1, Math.round(intervalMinutes * 60_000)),
    maxRuns: positiveInt(env.REPORT_COLLECT_RUNS),
    runImmediately: boolFromEnv(env.REPORT_COLLECT_RUN_IMMEDIATELY, true),
    runTimeoutMs: positiveInt(env.REPORT_COLLECT_RUN_TIMEOUT_MS) ?? 180_000,
    reportOptions: {
      dataDir: env.REPORT_DATA_DIR ?? "data/accounts",
      outDir: env.REPORT_OUT_DIR ?? "reports/preview-live",
      accounts: parsePreviewReportAccounts(env.REPORT_ACCOUNTS),
      startingCapitalUsd: positiveNumber(env.REPORT_STARTING_CAPITAL_USD) ?? 200,
      limit: positiveInt(env.REPORT_LIMIT) ?? 8,
      recentWindowMs: recentWindowMinutes
        ? recentWindowMinutes * 60_000
        : undefined,
    },
  };
}

async function generateWithTimeout(
  generate: PreviewReportGenerator,
  timeoutMs: number | undefined
): Promise<PreviewAccountsReportResult> {
  if (!timeoutMs) return await generate();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(generate),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`preview report run timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runPreviewReportCollector(
  options: PreviewReportCollectorOptions
): Promise<PreviewReportCollectorSummary> {
  const startedAt = new Date().toISOString();
  const maxRuns = options.maxRuns;
  const runImmediately = options.runImmediately !== false;
  const generate =
    options.generate ??
    (() => generatePreviewAccountsReport(options.reportOptions ?? {}));
  let runs = 0;
  let errors = 0;
  let lastOutPath: string | undefined;
  let lastSummaryPath: string | undefined;
  let lastError: string | undefined;

  while (!options.stopSignal?.aborted) {
    if (!runImmediately || runs > 0) {
      await delay(options.intervalMs, options.stopSignal);
      if (options.stopSignal?.aborted) break;
    }

    try {
      const result = await generateWithTimeout(generate, options.runTimeoutMs);
      runs += 1;
      lastOutPath = result.outPath;
      lastSummaryPath = result.summaryPath;
      options.onResult?.(result, runs);
    } catch (e) {
      runs += 1;
      errors += 1;
      const err = e instanceof Error ? e : new Error(String(e));
      lastError = err.message;
      options.onError?.(err, runs);
    }

    if (maxRuns !== undefined && runs >= maxRuns) {
      return {
        startedAt,
        stoppedAt: new Date().toISOString(),
        runs,
        errors,
        stoppedBy: "maxRuns",
        ...(lastOutPath ? { lastOutPath } : {}),
        ...(lastSummaryPath ? { lastSummaryPath } : {}),
        ...(lastError ? { lastError } : {}),
      };
    }
  }

  return {
    startedAt,
    stoppedAt: new Date().toISOString(),
    runs,
    errors,
    stoppedBy: "aborted",
    ...(lastOutPath ? { lastOutPath } : {}),
    ...(lastSummaryPath ? { lastSummaryPath } : {}),
    ...(lastError ? { lastError } : {}),
  };
}
