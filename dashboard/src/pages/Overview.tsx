import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  apiFetch,
  type AuditRow,
  type DailyStatsResponse,
  type PerformanceSummary,
  type QualityAccountReport,
  type QualityResponse,
  type StatusResponse,
} from "../api/client";
import { DataCard } from "../components/ui/DataCard";
import { PageHeader } from "../components/ui/PageHeader";
import { OverviewHourlyChart } from "../components/OverviewHourlyChart";
import { useT } from "../i18n/I18nProvider";
import { actionBadgeClass, SideBadge } from "../utils/auditDisplay";
import { StopCopyTradingButton } from "../components/StopCopyTradingButton";
import type { AccountSummary } from "../api/client";

function fmtUsd(n: number) {
  const sign = n >= 0 ? "" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtTime(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function fmtUptime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtPct(n: number) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtCoverage(n?: number) {
  return `${(n ?? 0).toFixed(0)}%`;
}

function fmtNumber(n?: number | null, digits = 2) {
  if (n === Number.POSITIVE_INFINITY) return "∞";
  return n == null || Number.isNaN(n) ? "—" : n.toFixed(digits);
}

function dependencyLabel(code?: string) {
  if (code === "diversified") return "分散";
  if (code === "concentrated") return "大单依赖";
  if (code === "no_profit") return "未盈利";
  return "样本小";
}

function meanFinite(values: (number | null | undefined)[]): number | null {
  const valid = values.filter(
    (value): value is number => value != null && Number.isFinite(value)
  );
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function effectiveProfitFactor(p?: PerformanceSummary): number | null {
  if (!p) return null;
  if (p.profitFactor != null) return p.profitFactor;
  if (p.lossCount === 0 && p.grossProfitUsd > 0 && p.tradeCount > 0) {
    return Number.POSITIVE_INFINITY;
  }
  return null;
}

function effectiveCoverage(q?: QualityAccountReport["copyQuality"]) {
  return q?.effectiveCoverage ?? q?.coverage;
}

function buyGapText(q?: QualityAccountReport["copyQuality"]) {
  const gap = q?.copyGap?.buy;
  if (!gap) return null;
  const top = gap.topUnclassified?.[0];
  const tokenHint = top ? ` · token ${top.tokenId.slice(0, 8)} +${top.unclassified}` : "";
  return `解释 ${fmtCoverage(gap.explainedPct)} · 未解释 ${gap.unclassified}${tokenHint}`;
}

function accountPnl(a: AccountSummary) {
  return a.todayRealizedPnl ?? 0;
}

function accountRoi(a: AccountSummary) {
  const base = a.initialCapitalUsd ?? 0;
  return base > 0 ? (accountPnl(a) / base) * 100 : 0;
}

function accountActivityScore(a: AccountSummary) {
  return (a.todayCopyCount ?? 0) + ((a.lastPollAt ?? 0) > 0 ? 1 : 0);
}

function sortAccountsForOps(accounts: AccountSummary[]) {
  return [...accounts].sort((a, b) => {
    const enabledDelta = Number(b.enabled) - Number(a.enabled);
    if (enabledDelta) return enabledDelta;
    const activeDelta = accountActivityScore(b) - accountActivityScore(a);
    if (activeDelta) return activeDelta;
    const pnlDelta = accountPnl(b) - accountPnl(a);
    if (pnlDelta) return pnlDelta;
    return (b.lastPollAt ?? 0) - (a.lastPollAt ?? 0);
  });
}

function issueBadgeClass(severity?: string) {
  if (severity === "danger") return "badge badge-kill";
  if (severity === "warning") return "badge badge-warn";
  if (severity === "ok") return "badge badge-live";
  return "badge badge-muted";
}

function gateLabel(grade?: string) {
  if (grade === "live_candidate") return "实盘候选";
  if (grade === "candidate") return "候选";
  if (grade === "watch") return "观察";
  if (grade === "reject") return "淘汰";
  return "未部署标准";
}

function gateBadgeClass(grade?: string) {
  if (grade === "live_candidate") return "badge badge-live";
  if (grade === "candidate") return "badge badge-preview";
  if (grade === "watch") return "badge badge-warn";
  if (grade === "reject") return "badge badge-kill";
  return "badge badge-muted";
}

function qualityVariant(q?: QualityAccountReport) {
  const gate = q?.profitabilityGate?.grade;
  if (gate === "live_candidate") return "positive";
  if (gate === "reject") return "negative";
  const severity = q?.copyQuality?.primaryIssue.severity;
  if (severity === "danger") return "negative";
  if (severity === "ok") return "positive";
  return "accent";
}

export function OverviewPage() {
  const t = useT();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => apiFetch<StatusResponse>("/api/status"),
    refetchInterval: 5000,
  });

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => apiFetch<DailyStatsResponse>("/api/stats/daily"),
    refetchInterval: 10000,
  });

  const audit = useQuery({
    queryKey: ["audit-recent"],
    queryFn: () => apiFetch<{ items: AuditRow[] }>("/api/audit?limit=15"),
    refetchInterval: 5000,
  });

  const quality = useQuery({
    queryKey: ["quality"],
    queryFn: () => apiFetch<QualityResponse>("/api/quality?windowMinutes=360&limit=8"),
    refetchInterval: 10000,
  });

  const s = status.data;
  const today = stats.data?.today;
  const pnl = today?.realizedPnl ?? 0;
  const accounts = s?.accounts ?? [];
  const qualityReports = quality.data?.reports ?? [];
  const qualityByAccount = new Map(qualityReports.map((r) => [r.accountId, r]));
  const enabledQuality = qualityReports.filter((r) => r.enabled && r.copyQuality);
  const activeQuality = enabledQuality.filter((r) => r.copyingActive !== false);
  const issueCounts = quality.data?.summary.issueCounts ?? {};
  const activeIssueCounts = quality.data?.summary.activeIssueCounts ?? issueCounts;
  const gateCounts = quality.data?.summary.gateCounts ?? {};
  const activeGateCounts = quality.data?.summary.activeGateCounts ?? gateCounts;
  const copyGapSummary = quality.data?.summary.copyGap;
  const activeCopyGapSummary = quality.data?.summary.activeCopyGap ?? copyGapSummary;
  const freshActiveCopyGap = quality.data?.summary.freshActiveCopyGap;
  const auditCopyGapSummary = freshActiveCopyGap?.copyGap ?? activeCopyGapSummary;
  const activeCopyAccounts = quality.data?.summary.activeCopyAccounts ?? enabledQuality.filter((r) => r.copyingActive).length;
  const settleOnlyAccounts = quality.data?.summary.settleOnlyAccounts ?? Math.max(0, enabledQuality.length - activeCopyAccounts);
  const gateAvailable = activeQuality.some((r) => Boolean(r.profitabilityGate));
  const averageTradeCoverage =
    activeQuality.length > 0
      ? activeQuality.reduce(
          (sum, r) => sum + (r.copyQuality?.coverage.tradePct ?? 0),
          0
        ) / activeQuality.length
      : 0;
  const averageEffectiveTradeCoverage =
    activeQuality.length > 0
      ? activeQuality.reduce(
          (sum, r) => sum + (effectiveCoverage(r.copyQuality)?.tradePct ?? 0),
          0
        ) / activeQuality.length
      : 0;
  const averageBuyCoverage =
    activeQuality.length > 0
      ? activeQuality.reduce((sum, r) => sum + (r.copyQuality?.coverage.buyPct ?? 0), 0) /
        activeQuality.length
      : 0;
  const averageEffectiveBuyCoverage =
    activeQuality.length > 0
      ? activeQuality.reduce((sum, r) => sum + (effectiveCoverage(r.copyQuality)?.buyPct ?? 0), 0) /
        activeQuality.length
      : 0;
  const averageSellCoverage =
    activeQuality.length > 0
      ? activeQuality.reduce((sum, r) => sum + (r.copyQuality?.coverage.sellPct ?? 0), 0) /
        activeQuality.length
      : 0;
  const averageEffectiveSellCoverage =
    activeQuality.length > 0
      ? activeQuality.reduce((sum, r) => sum + (effectiveCoverage(r.copyQuality)?.sellPct ?? 0), 0) /
        activeQuality.length
      : 0;
  const performanceReports = activeQuality.filter((r) => r.performance);
  const maturePerformanceReports = performanceReports.filter(
    (r) => (r.performance?.tradeCount ?? 0) >= 30
  );
  const passingPerformanceReports = maturePerformanceReports.filter((r) => {
    const p = r.performance;
    if (!p) return false;
    const profitFactor = effectiveProfitFactor(p) ?? 0;
    return (
      p.totalPnlUsd > 0 &&
      p.winRatePct >= 60 &&
      profitFactor >= 1.5 &&
      p.maxDrawdownPct <= 10 &&
      p.dependencyIssue !== "concentrated"
    );
  });
  const maturePerformances = maturePerformanceReports
    .map((r) => r.performance)
    .filter((p): p is PerformanceSummary => Boolean(p));
  const avgSharpe = meanFinite(maturePerformances.map((p) => p.sharpeRatio));
  const avgProfitFactor = meanFinite(
    maturePerformances.map((p) => p.profitFactor)
  );
  const avgWinRate = meanFinite(maturePerformances.map((p) => p.winRatePct)) ?? 0;
  const avgPayoff = meanFinite(maturePerformances.map((p) => p.payoffRatio));
  const avgEquityStability =
    meanFinite(maturePerformances.map((p) => p.equityStabilityPct)) ?? 0;
  const worstDrawdown =
    maturePerformances.length > 0
      ? Math.max(...maturePerformances.map((p) => p.maxDrawdownPct))
      : 0;
  const rankedAccounts = sortAccountsForOps(accounts);
  const enabledAccounts = accounts.filter((a) => a.enabled);
  const profitableAccounts = enabledAccounts.filter((a) => accountPnl(a) > 0);
  const losingAccounts = enabledAccounts.filter((a) => accountPnl(a) < 0);
  const copyingAccounts = enabledAccounts.filter((a) => (a.todayCopyCount ?? 0) > 0);
  const totalPnl = enabledAccounts.reduce((sum, a) => sum + accountPnl(a), 0);
  const totalOpenCost = enabledAccounts.reduce((sum, a) => sum + (a.openCostUsd ?? 0), 0);
  const totalCash = enabledAccounts.reduce((sum, a) => sum + (a.cashUsd ?? 0), 0);
  const activeAccount = accounts.find((a) => a.id === s?.accountId);

  return (
    <>
      <PageHeader
        title={
          s?.accountLabel
            ? t("overview.titleWithAccount", { account: s.accountLabel })
            : t("overview.title")
        }
        subtitle={t("overview.subtitle")}
        badges={
          s ? (
            <>
              <span className={`badge ${s.previewMode ? "badge-preview" : "badge-live"}`}>
                {s.previewMode ? t("badge.preview") : t("badge.live")}
              </span>
              {s.killSwitchActive && <span className="badge badge-kill">{t("badge.killSwitch")}</span>}
            </>
          ) : undefined
        }
        meta={
          s ? (
            <span className="muted">{t("overview.engineUptime", { time: fmtUptime(s.uptimeSec) })}</span>
          ) : undefined
        }
        actions={
          s ? (
            <StopCopyTradingButton
              previewMode={s.previewMode}
              copyTradingEnabled={s.copyTradingEnabled}
              compact
            />
          ) : undefined
        }
      />

      {status.isError && (
        <div className="alert alert-error">
          {t("common.engineError", { message: (status.error as Error).message })}
        </div>
      )}

      {activeAccount && (!activeAccount.enabled || !activeAccount.lastPollAt) && (
        <div className="alert alert-warn">
          {activeAccount.enabled
            ? "当前选中的账号还没有轮询记录，下面可能主要是历史数据。"
            : "当前选中的账号已停用，下面显示的是历史账本；看实时跟单请切换到启用账号。"}
        </div>
      )}

      {accounts.length > 1 && (
        <section className="page-section">
          <h2 className="section-title">策略池健康</h2>
          <div className="cards cards-compact">
            <DataCard
              label="活跃复制"
              value={`${activeCopyAccounts}/${enabledAccounts.length}`}
              hint={<span className="muted">settle-only {settleOnlyAccounts} · 总账号 {accounts.length}</span>}
            />
            <DataCard
              label="今日盈利"
              value={`${profitableAccounts.length}`}
              variant="positive"
              hint={<span className="muted">亏损 {losingAccounts.length} · 有复制 {copyingAccounts.length}</span>}
            />
            <DataCard
              label="启用池 PnL"
              value={fmtUsd(totalPnl)}
              variant={totalPnl >= 0 ? "positive" : "negative"}
              hint={<span className="muted">已结算/已实现口径</span>}
            />
            <DataCard
              label="现金 / 持仓成本"
              value={`${fmtUsd(totalCash)} / ${fmtUsd(totalOpenCost)}`}
              variant="accent"
              hint={<span className="muted">模拟账本成本口径，不是市值</span>}
            />
          </div>
        </section>
      )}

      {qualityReports.length > 0 && (
        <section className="page-section">
          <h2 className="section-title">盈利标准</h2>
          <div className="cards cards-compact">
            <DataCard
              label="达标账户"
              value={
                gateAvailable
                  ? `${activeGateCounts.live_candidate ?? 0}/${activeQuality.length}`
                  : `${passingPerformanceReports.length}/${maturePerformanceReports.length}`
              }
              variant={
                gateAvailable
                  ? (activeGateCounts.live_candidate ?? 0) > 0
                    ? "positive"
                    : "accent"
                  : passingPerformanceReports.length > 0
                    ? "positive"
                    : "accent"
              }
              hint={
                <span className="muted">
                  {gateAvailable
                    ? `候选 ${activeGateCounts.candidate ?? 0} · 观察 ${activeGateCounts.watch ?? 0} · 淘汰 ${activeGateCounts.reject ?? 0}`
                    : "远端还未部署盈利 gate，先按旧指标估算"}
                </span>
              }
            />
            <DataCard
              label="Sharpe / PF"
              value={`${fmtNumber(avgSharpe)} / ${fmtNumber(avgProfitFactor)}`}
              variant={(avgProfitFactor ?? 0) >= 1.5 ? "positive" : "accent"}
              hint={<span className="muted">风险调整收益 / 总盈亏比</span>}
            />
            <DataCard
              label="胜率 / 盈亏比"
              value={`${fmtCoverage(avgWinRate)} / ${fmtNumber(avgPayoff)}`}
              variant={avgWinRate >= 60 ? "positive" : "accent"}
              hint={<span className="muted">平均胜率 / 平均赚亏比</span>}
            />
            <DataCard
              label="回撤 / 稳定"
              value={`${fmtCoverage(worstDrawdown)} / ${fmtCoverage(avgEquityStability)}`}
              variant={worstDrawdown <= 10 ? "positive" : "negative"}
              hint={<span className="muted">按成熟账户已结算曲线估算</span>}
            />
          </div>

          <h2 className="section-title">为什么没赚钱</h2>
          <div className="cards cards-compact">
            <DataCard
              label="有效复制率"
              value={fmtCoverage(averageEffectiveTradeCoverage)}
              variant={averageEffectiveTradeCoverage >= 40 ? "positive" : "accent"}
              hint={
                <span className="muted">
                  买 {fmtCoverage(averageEffectiveBuyCoverage)} · 卖 {fmtCoverage(averageEffectiveSellCoverage)} · 原始{" "}
                  {fmtCoverage(averageTradeCoverage)}
                </span>
              }
            />
            <DataCard
              label="主要阻塞"
              value={`${(activeIssueCounts.not_buying ?? 0) + (activeIssueCounts.parameter_filtered ?? 0) + (activeIssueCounts.risk_limited ?? 0) + (activeIssueCounts.cash_occupied ?? 0)}`}
              variant="accent"
              hint={<span className="muted">没买到/参数/风控/现金</span>}
            />
            <DataCard
              label="卖出缺口"
              value={`${activeIssueCounts.not_selling ?? 0}`}
              variant={(activeIssueCounts.not_selling ?? 0) > 0 ? "negative" : "positive"}
              hint={<span className="muted">SELL 多但本地没仓</span>}
            />
            <DataCard
              label="审计缺口"
              value={`${auditCopyGapSummary?.unclassifiedTotal ?? 0}`}
              variant={(auditCopyGapSummary?.unclassifiedTotal ?? 0) > 0 ? "negative" : "positive"}
              hint={
                <span className="muted">
                  {freshActiveCopyGap ? `${freshActiveCopyGap.windowMinutes}m · ` : ""}
                  买 {auditCopyGapSummary?.unclassifiedBuy ?? 0} · 卖 {auditCopyGapSummary?.unclassifiedSell ?? 0} · 账户{" "}
                  {auditCopyGapSummary?.accountsWithUnclassified ?? 0}
                </span>
              }
            />
            <DataCard
              label="策略亏损"
              value={`${activeIssueCounts.strategy_losing ?? 0}`}
              variant={(activeIssueCounts.strategy_losing ?? 0) > 0 ? "negative" : "positive"}
              hint={<span className="muted">已结算样本为负</span>}
            />
          </div>
          <div className="quality-strip">
            {enabledQuality.slice(0, 12).map((r) => {
              const q = r.copyQuality;
              return (
                <div key={r.accountId} className="quality-row">
                  <div className="quality-main">
                    <strong>{r.label || r.accountId}</strong>
                    <span className={gateBadgeClass(r.profitabilityGate?.grade)}>
                      {gateLabel(r.profitabilityGate?.grade)}
                    </span>
                    <span className={issueBadgeClass(q?.primaryIssue.severity)}>
                      {q?.primaryIssue.label ?? "无数据"}
                    </span>
                  </div>
                  <div className="quality-metrics muted">
                    COPY {r.copyCount ?? 0} · 有效 {fmtCoverage(effectiveCoverage(q)?.tradePct)} · 原始{" "}
                    {fmtCoverage(q?.coverage.tradePct)} · 买 {fmtCoverage(effectiveCoverage(q)?.buyPct)} · 卖{" "}
                    {fmtCoverage(effectiveCoverage(q)?.sellPct)} · 已结算{" "}
                    {fmtUsd(q?.redeem.pnlUsd ?? 0)}
                    {(q?.skips.alreadySeen ?? 0) > 0 ? ` · 去重 ${q?.skips.alreadySeen}` : ""}
                    {buyGapText(q) ? ` · ${buyGapText(q)}` : ""}
                  </div>
                  {r.performance && (
                    <div className="quality-metrics muted">
                      PF {fmtNumber(effectiveProfitFactor(r.performance))} · 胜率{" "}
                      {fmtCoverage(r.performance.winRatePct)} · Sharpe{" "}
                      {fmtNumber(r.performance.sharpeRatio)} · 回撤{" "}
                      {fmtCoverage(r.performance.maxDrawdownPct)} · 稳定{" "}
                      {fmtCoverage(r.performance.equityStabilityPct)} · 近6h{" "}
                      {r.performance.recent.tradeCount} 笔 / {fmtUsd(r.performance.recent.pnlUsd)} ·{" "}
                      {dependencyLabel(r.performance.dependencyIssue)}
                    </div>
                  )}
                  {r.profitabilityGate && r.profitabilityGate.blockers.length > 0 && (
                    <div className="quality-metrics muted">
                      门槛阻塞：{r.profitabilityGate.blockers.slice(0, 3).join(" · ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {accounts.length > 1 && (
        <section className="page-section">
          <h2 className="section-title">{t("overview.allAccounts")}</h2>
          <div className="account-score-grid">
            {rankedAccounts.map((a) => {
              const accountPnlValue = accountPnl(a);
              const roi = accountRoi(a);
              const stale = a.enabled && !a.lastPollAt;
              const q = qualityByAccount.get(a.id);
              const cq = q?.copyQuality;
              return (
              <DataCard
                key={a.id}
                label={a.label || a.id}
                value={fmtUsd(accountPnlValue)}
                variant={accountPnlValue >= 0 ? qualityVariant(q) : "negative"}
                className={!a.enabled ? "data-card-muted" : ""}
                hint={
                  <>
                    <span className={`badge ${a.previewMode ? "badge-preview" : "badge-live"}`}>
                      {a.previewMode ? t("badge.previewShort") : t("badge.liveShort")}
                    </span>
                    {!a.enabled && <span className="badge badge-muted">停用</span>}
                    {a.enabled && q?.copyingActive === false && <span className="badge badge-muted">settle-only</span>}
                    {stale && <span className="badge badge-warn">未轮询</span>}
                    <span className="muted">
                      ROI {fmtPct(roi)} · COPY {a.todayCopyCount} · 持仓 {a.openPositions ?? 0}
                      {a.killSwitchActive ? ` · ${t("badge.killSwitch")}` : ""}
                    </span>
                    {cq && (
                      <>
                        <span className={gateBadgeClass(q?.profitabilityGate?.grade)}>
                          {gateLabel(q?.profitabilityGate?.grade)}
                        </span>
                        <span className={issueBadgeClass(cq.primaryIssue.severity)}>
                          {cq.primaryIssue.label}
                        </span>
                        <span className="muted">
                          有效 {fmtCoverage(effectiveCoverage(cq)?.tradePct)} · 原始 {fmtCoverage(cq.coverage.tradePct)} · 买{" "}
                          {fmtCoverage(effectiveCoverage(cq)?.buyPct)} · 卖 {fmtCoverage(effectiveCoverage(cq)?.sellPct)}
                          {cq.skips.alreadySeen > 0 ? ` · 去重 ${cq.skips.alreadySeen}` : ""}
                          {buyGapText(cq) ? ` · ${buyGapText(cq)}` : ""}
                        </span>
                      </>
                    )}
                    {q?.performance && (
                      <span className="muted">
                        PF {fmtNumber(effectiveProfitFactor(q.performance))} · 胜率{" "}
                        {fmtCoverage(q.performance.winRatePct)} · 回撤{" "}
                        {fmtCoverage(q.performance.maxDrawdownPct)} · 近6h{" "}
                        {q.performance.recent.tradeCount} 笔 / {fmtUsd(q.performance.recent.pnlUsd)} ·{" "}
                        {dependencyLabel(q.performance.dependencyIssue)}
                      </span>
                    )}
                    {q?.profitabilityGate && q.profitabilityGate.blockers.length > 0 && (
                      <span className="muted">
                        门槛 {q.profitabilityGate.blockers.slice(0, 2).join(" · ")}
                      </span>
                    )}
                    <span className="muted">
                      现金 {fmtUsd(a.cashUsd ?? 0)} · 成本 {fmtUsd(a.openCostUsd ?? 0)}
                    </span>
                  </>
                }
              />
              );
            })}
          </div>
        </section>
      )}

      <section className="page-section">
        <h2 className="section-title">{t("overview.todayPerf")}</h2>
        <div className="cards">
          <DataCard label={t("overview.copyCount")} value={today?.copyCount ?? 0} />
          <DataCard label={t("overview.volume")} value={fmtUsd(today?.volumeUsd ?? 0)} variant="accent" />
          <DataCard
            label={t("overview.realizedPnl")}
            value={fmtUsd(pnl)}
            variant={pnl >= 0 ? "positive" : "negative"}
          />
          <DataCard
            label={t("overview.pendingGtc")}
            value={s?.pendingOrders ?? 0}
            linkTo={(s?.pendingOrders ?? 0) > 0 ? "/orders" : undefined}
            linkLabel={t("common.view")}
          />
          <DataCard
            label={t("overview.enabledLeaders")}
            value={s?.enabledLeaders.length ?? 0}
            linkTo="/leaders"
            linkLabel={t("common.manage")}
          />
          <DataCard label={t("overview.lastPollCopy")} value={s?.lastPoll?.copied ?? 0} />
        </div>
      </section>

      <section className="page-section">
        <OverviewHourlyChart />
      </section>

      <section className="page-section">
        <h2 className="section-title">{t("overview.pollEngine")}</h2>
        <div className="panel panel-inset">
          <div className="engine-stats">
            <div className="engine-stat">
              <span className="engine-stat-label">{t("overview.lastPoll")}</span>
              <span className="engine-stat-value">{fmtTime(s?.lastPollAt ?? null)}</span>
            </div>
            {s?.lastPoll && (
              <>
                <div className="engine-stat">
                  <span className="engine-stat-label">Fetched</span>
                  <span className="engine-stat-value mono">{s.lastPoll.fetched}</span>
                </div>
                <div className="engine-stat">
                  <span className="engine-stat-label">Copied</span>
                  <span className="engine-stat-value mono engine-stat-good">{s.lastPoll.copied}</span>
                </div>
                <div className="engine-stat">
                  <span className="engine-stat-label">Skipped</span>
                  <span className="engine-stat-value mono">{s.lastPoll.skipped}</span>
                </div>
                <div className="engine-stat">
                  <span className="engine-stat-label">Pending Filled</span>
                  <span className="engine-stat-value mono">{s.lastPoll.pendingFilled}</span>
                </div>
                {s.lastPoll.errors.length > 0 && (
                  <div className="engine-stat">
                    <span className="engine-stat-label">Errors</span>
                    <span className="engine-stat-value mono engine-stat-bad">{s.lastPoll.errors.length}</span>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="muted engine-db-path">DB · {s?.dbPath ?? t("common.none")}</div>
        </div>
      </section>

      <section className="page-section">
        <div className="section-header-row">
          <h2 className="section-title">{t("overview.recentActivity")}</h2>
          <Link to="/activity" className="card-link">
            {t("common.viewAll")}
          </Link>
        </div>
        <div className="panel panel-wide">
          <table>
            <thead>
              <tr>
                <th>{t("table.time")}</th>
                <th>{t("table.leader")}</th>
                <th>{t("table.action")}</th>
                <th>{t("table.side")}</th>
                <th>{t("table.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {(audit.data?.items ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="mono">{new Date(row.ts).toLocaleTimeString()}</td>
                  <td>{row.leaderId ?? t("common.none")}</td>
                  <td>
                    <span className={actionBadgeClass(row.action)}>{row.action}</span>
                  </td>
                  <td>
                    <SideBadge side={row.side} />
                  </td>
                  <td className="mono table-cell-detail">
                    {row.action === "COPY" && row.size != null
                      ? `${row.size} @ ${row.price}`
                      : row.reason?.slice(0, 48) ?? t("common.none")}
                    {row.preview && <span className="badge badge-preview badge-xs">P</span>}
                  </td>
                </tr>
              ))}
              {!audit.data?.items.length && (
                <tr>
                  <td colSpan={5} className="table-empty">
                    <span className="muted">{t("overview.noAudit")}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
