import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fetchAccounts, getActiveAccountId, type AuditRow } from "../api/client";
import { FilterBar } from "../components/ui/FilterBar";
import { PageHeader } from "../components/ui/PageHeader";
import { DataCard } from "../components/ui/DataCard";
import { useAuditStream } from "../hooks/useAuditStream";
import { useT } from "../i18n/I18nProvider";
import { actionBadgeClass, SideBadge } from "../utils/auditDisplay";

const ACTIONS = ["", "DETECT", "COPY", "SKIP", "ERROR", "REDEEM"] as const;
const SIDES = ["", "BUY", "SELL", "REDEEM"] as const;

function fmtUsd(n: number) {
  const sign = n >= 0 ? "" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtLast(ts: number | null | undefined) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function ActivityPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [leaderId, setLeaderId] = useState("");
  const [action, setAction] = useState("");
  const [side, setSide] = useState("");
  const [liveRows, setLiveRows] = useState<AuditRow[]>([]);
  const [flashIds, setFlashIds] = useState<Set<number>>(() => new Set());

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: fetchAccounts,
    refetchInterval: 15000,
  });

  const leaders = useQuery({
    queryKey: ["leaders"],
    queryFn: () => apiFetch<{ leaders: { id: string }[] }>("/api/leaders"),
  });

  const audit = useQuery({
    queryKey: ["audit", leaderId, action],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "200" });
      if (leaderId) params.set("leaderId", leaderId);
      if (action) params.set("action", action);
      return apiFetch<{ items: AuditRow[]; total: number }>(`/api/audit?${params}`);
    },
    refetchInterval: 15000,
  });

  useEffect(() => {
    setLiveRows([]);
  }, [leaderId, action, side]);

  const onAudit = useCallback(
    (row: AuditRow) => {
      if (leaderId && row.leaderId !== leaderId) return;
      if (action && row.action !== action) return;
      if (side && row.side !== side) return;

      setLiveRows((prev) => {
        if (prev.some((r) => r.id === row.id)) return prev;
        return [row, ...prev].slice(0, 100);
      });

      setFlashIds((prev) => new Set(prev).add(row.id));
      setTimeout(() => {
        setFlashIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
      }, 2200);

      void queryClient.invalidateQueries({ queryKey: ["audit", leaderId, action] });
      void queryClient.invalidateQueries({ queryKey: ["audit-recent"] });
      void queryClient.invalidateQueries({ queryKey: ["stats-hourly"] });
    },
    [leaderId, action, side, queryClient]
  );

  const { connected } = useAuditStream({ onAudit });

  const rows = useMemo(() => {
    const map = new Map<number, AuditRow>();
    for (const r of liveRows) map.set(r.id, r);
    for (const r of audit.data?.items ?? []) map.set(r.id, r);
    return [...map.values()]
      .filter((r) => !side || r.side === side)
      .sort((a, b) => b.id - a.id)
      .slice(0, 100);
  }, [liveRows, audit.data?.items, side]);

  const activeAccountId = getActiveAccountId() ?? accounts.data?.defaultAccountId;
  const activeAccount = accounts.data?.accounts.find((a) => a.id === activeAccountId);
  const copyRows = rows.filter((r) => r.action === "COPY");
  const skipRows = rows.filter((r) => r.action === "SKIP");
  const errorRows = rows.filter((r) => r.action === "ERROR");
  const redeemRows = rows.filter((r) => r.side === "REDEEM" || r.action === "REDEEM");
  const detectRows = rows.filter((r) => r.action === "DETECT");

  return (
    <>
      <PageHeader
        title={t("activity.title")}
        subtitle={t("activity.subtitle")}
        badges={
          connected ? (
            <span className="badge badge-live">
              <span className="status-dot status-dot-live" style={{ marginRight: "0.35rem" }} />
              {t("badge.realtime")}
            </span>
          ) : (
            <span className="badge badge-preview">{t("badge.connecting")}</span>
          )
        }
        meta={
          audit.isFetching ? (
            <span className="muted">{t("common.sync")}</span>
          ) : (
            <span className="muted">
              {t("common.records", { count: side ? rows.length : audit.data?.total ?? rows.length })}
            </span>
          )
        }
      />

      {activeAccount && (!activeAccount.enabled || !activeAccount.lastPollAt) && (
        <div className="alert alert-warn">
          {activeAccount.enabled
            ? "当前账号还没有轮询记录，活动流可能只有旧数据。"
            : "当前账号已停用，活动流显示的是历史审计记录，不代表现在还在跟单。"}
        </div>
      )}

      {activeAccount && (
        <section className="page-section activity-summary">
          <div className="cards cards-compact">
            <DataCard
              label="账号 PnL"
              value={fmtUsd(activeAccount.todayRealizedPnl ?? 0)}
              variant={(activeAccount.todayRealizedPnl ?? 0) >= 0 ? "positive" : "negative"}
              hint={<span className="muted">今日已实现 / 已结算口径</span>}
            />
            <DataCard
              label="最近轮询"
              value={fmtLast(activeAccount.lastPollAt)}
              variant={activeAccount.lastPollAt ? "accent" : "default"}
              hint={<span className="muted">{activeAccount.enabled ? "启用中" : "已停用"}</span>}
            />
            <DataCard
              label="活动拆分"
              value={`COPY ${copyRows.length}`}
              hint={<span className="muted">DETECT {detectRows.length} · SKIP {skipRows.length}</span>}
            />
            <DataCard
              label="赎回 / 错误"
              value={`${redeemRows.length} / ${errorRows.length}`}
              variant={errorRows.length ? "negative" : "default"}
              hint={<span className="muted">REDEEM 是结算检测，不是买入下单</span>}
            />
          </div>
        </section>
      )}

      <FilterBar meta={<span className="muted">{t("common.filter")}</span>}>
        <select value={leaderId} onChange={(e) => setLeaderId(e.target.value)} aria-label={t("table.leader")}>
          <option value="">{t("activity.allLeaders")}</option>
          {(leaders.data?.leaders ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.id}
            </option>
          ))}
        </select>
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label={t("table.action")}>
          {ACTIONS.map((a) => (
            <option key={a || "all"} value={a}>
              {a || t("activity.allActions")}
            </option>
          ))}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value)} aria-label={t("table.side")}>
          {SIDES.map((s) => (
            <option key={s || "all"} value={s}>
              {s || "全部方向"}
            </option>
          ))}
        </select>
      </FilterBar>

      <div className="panel panel-wide">
        <table>
          <thead>
            <tr>
              <th>{t("table.time")}</th>
              <th>{t("table.leader")}</th>
              <th>{t("table.action")}</th>
              <th>{t("table.side")}</th>
              <th>{t("table.token")}</th>
              <th>{t("table.size")}</th>
              <th>{t("table.price")}</th>
              <th>{t("table.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={flashIds.has(row.id) ? "row-flash" : undefined}>
                <td className="mono">{new Date(row.ts).toLocaleString()}</td>
                <td>{row.leaderId ?? t("common.none")}</td>
                <td>
                  <span className={actionBadgeClass(row.action)}>{row.action}</span>
                </td>
                <td>
                  <SideBadge side={row.side} />
                </td>
                <td className="mono">{row.tokenId?.slice(0, 10) ?? t("common.none")}</td>
                <td className="mono">{row.size ?? t("common.none")}</td>
                <td className="mono">{row.price ?? t("common.none")}</td>
                <td className="table-cell-detail" title={row.reason ?? undefined}>
                  {row.reason ?? t("common.none")}
                  {row.preview && <span className="badge badge-preview badge-xs">P</span>}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={8} className="table-empty">
                  <span className="muted">{t("activity.noMatch")}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
