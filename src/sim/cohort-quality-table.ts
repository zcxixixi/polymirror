import type { PreviewAccountReport } from "./preview-report.js";

export type CohortOperatorRole =
  | "settle-only"
  | "qualified"
  | "watch"
  | "collecting";

type Lookup<T> = ReadonlyMap<string, T> | Readonly<Record<string, T>>;
type EvidenceCount = number | readonly unknown[];

export interface CohortQualityTableOptions {
  labels?: Lookup<string>;
  controlStates?: Lookup<string>;
  walletDrifts?: Lookup<EvidenceCount>;
  settlementFailures?: Lookup<EvidenceCount>;
}

export interface CohortQualityRow {
  accountId: string;
  account: string;
  role: CohortOperatorRole;
  cumulative: string;
  cashOpenCost: string;
  quality: string;
  performance: string;
  recent24h: string;
}

function lookup<T>(source: Lookup<T> | undefined, key: string): T | undefined {
  if (!source) return undefined;
  if (typeof (source as ReadonlyMap<string, T>).get === "function") {
    return (source as ReadonlyMap<string, T>).get(key);
  }
  return (source as Readonly<Record<string, T>>)[key];
}

function fixed(value: number, decimals = 2): string {
  return (Number.isFinite(value) ? value : 0).toFixed(decimals);
}

function signed(value: number): string {
  const normalized = Number.isFinite(value) ? value : 0;
  return `${normalized >= 0 ? "+" : ""}${fixed(normalized)}`;
}

function evidenceCount(value: EvidenceCount | undefined): string {
  if (value === undefined) return "未提供";
  if (typeof value !== "number") return String(value.length);
  return String(Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
}

function effectiveControlState(
  report: PreviewAccountReport,
  options: CohortQualityTableOptions
): string {
  if (report.killSwitch) return "SETTLE_ONLY";
  return (lookup(options.controlStates, report.accountId) ?? "ACTIVE").trim().toUpperCase();
}

function roleFor(
  report: PreviewAccountReport,
  controlState: string
): CohortOperatorRole {
  if (controlState !== "ACTIVE" || report.killSwitch) return "settle-only";
  if (report.stabilityGoal?.passed === true) return "qualified";
  if (report.redeemCount >= 10) return "watch";
  return "collecting";
}

function formatPerformance(report: PreviewAccountReport): string {
  const performance = report.performance;
  if (!performance || performance.tradeCount < 2) {
    return (
      "Sharpe=样本不足 / PF=样本不足 / 胜率=样本不足 / " +
      "Payoff=样本不足 / 回撤=样本不足 / 稳定度=样本不足"
    );
  }

  const sharpe = performance.sharpeRatio === null
    ? "样本不足"
    : fixed(performance.sharpeRatio);
  const profitFactor = performance.profitFactor === null
    ? performance.grossProfitUsd > 0 && performance.grossLossUsd === 0
      ? "∞"
      : "样本不足"
    : fixed(performance.profitFactor);
  const payoff = performance.payoffRatio === null
    ? "样本不足"
    : fixed(performance.payoffRatio);

  return (
    `Sharpe=${sharpe} / PF=${profitFactor} / 胜率=${fixed(performance.winRatePct)}% / ` +
    `Payoff=${payoff} / 回撤=${fixed(performance.maxDrawdownPct)}% / ` +
    `稳定度=${fixed(performance.equityStabilityPct)}%`
  );
}

function formatRecent24h(report: PreviewAccountReport): string {
  const recentWindow = report.recentWindow;
  const recentPerformance = report.performance?.recent;
  if (!recentWindow || !recentPerformance || recentPerformance.sinceMs === null) {
    return "样本不足";
  }
  const trades = recentWindow.copyCount + recentWindow.redeemCount;
  return `${trades} / ${signed(recentPerformance.pnlUsd)}U`;
}

export function createCohortQualityRows(
  reports: readonly PreviewAccountReport[],
  options: CohortQualityTableOptions = {}
): CohortQualityRow[] {
  return [...reports]
    .sort((a, b) => a.accountId.localeCompare(b.accountId))
    .map((report) => {
      const controlState = effectiveControlState(report, options);
      const label = lookup(options.labels, report.accountId)?.trim() || report.accountId;
      const walletDrift = evidenceCount(lookup(options.walletDrifts, report.accountId));
      const settlement = evidenceCount(
        lookup(options.settlementFailures, report.accountId)
      );
      return {
        accountId: report.accountId,
        account: label,
        role: roleFor(report, controlState),
        cumulative:
          `${signed(report.realizedPnlUsd)}U / ${report.copyCount} / ${report.redeemCount}`,
        cashOpenCost: `${fixed(report.cashUsd)}U / ${fixed(report.openCostUsd)}U`,
        quality:
          `state=${controlState}; pending=${report.pendingOrderCount}; ` +
          `intents=${report.liveOrderIntentCount}; walletDrift=${walletDrift}; ` +
          `settlement=${settlement}; accountingDelta=` +
          `${signed(report.cashReplayDeltaUsd)}/${signed(report.capitalDeltaUsd)}U`,
        performance: formatPerformance(report),
        recent24h: formatRecent24h(report),
      };
    });
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function formatCohortQualityMarkdown(
  rows: readonly CohortQualityRow[]
): string {
  const lines = [
    "| 账户 | 角色 | 累计PnL/COPY/REDEEM | Cash/OpenCost | 质量 | 绩效 | 近24h交易/PnL |",
    "|---|---|---:|---:|---|---|---:|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownCell(row.account)} | ${row.role} | ${row.cumulative} | ` +
      `${row.cashOpenCost} | ${escapeMarkdownCell(row.quality)} | ` +
      `${escapeMarkdownCell(row.performance)} | ${row.recent24h} |`
    );
  }
  return `${lines.join("\n")}\n`;
}
