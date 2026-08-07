import { Link } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, type StatusResponse, type UpdateCheckResponse } from "../api/client";
import { useT } from "../i18n/I18nProvider";
import { ModeSwitchButton } from "./ModeSwitchButton";
import { UpdateApplyModal } from "./UpdateApplyModal";

const DISMISS_KEY_PREFIX = "polymirror_dismiss_update:";
const UPDATE_POLL_MS = 15 * 60 * 1000;

function fmtUptime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(`${DISMISS_KEY_PREFIX}${version}`) === "1";
  } catch {
    return false;
  }
}

function dismissVersion(version: string): void {
  try {
    localStorage.setItem(`${DISMISS_KEY_PREFIX}${version}`, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

export function GlobalStatusBar() {
  const t = useT();
  const [dismissedLatest, setDismissedLatest] = useState<string | null>(null);
  const [modal, setModal] = useState<"apply" | "rollback" | null>(null);

  const { data: s, isError } = useQuery({
    queryKey: ["status"],
    queryFn: () => apiFetch<StatusResponse>("/api/status"),
    refetchInterval: 5000,
  });

  const { data: update } = useQuery({
    queryKey: ["update-check"],
    queryFn: () => apiFetch<UpdateCheckResponse>("/api/update"),
    refetchInterval: (q) => {
      const job = q.state.data?.selfUpdate?.job;
      if (job?.active || job?.phase === "restarting") return 2000;
      return UPDATE_POLL_MS;
    },
    staleTime: 5_000,
    retry: 1,
  });

  const latest = update?.latestVersion ?? null;
  const job = update?.selfUpdate?.job ?? null;
  const jobActive = !!job && (job.active || job.phase === "restarting");
  const showUpdate =
    !!update?.enabled &&
    !!update.updateAvailable &&
    !!latest &&
    dismissedLatest !== latest &&
    !isDismissed(latest);

  const showRollback =
    !!update?.selfUpdate?.canRollback && !!update.selfUpdate.rollbackVersion && !showUpdate;

  const hasDrift = (s?.walletDrifts?.length ?? 0) > 0;
  const showBar =
    isError ||
    s?.killSwitchActive ||
    s?.lastError ||
    hasDrift ||
    (s && !s.previewMode) ||
    showUpdate ||
    showRollback ||
    jobActive ||
    job?.phase === "failed" ||
    job?.phase === "succeeded";

  if (!showBar && !s) return null;

  if (isError) {
    return (
      <div className="status-bar status-bar-error" role="alert">
        <span className="status-bar-icon">⚠</span>
        <span>{t("statusBar.engineDown")}</span>
      </div>
    );
  }

  if (!s && !showUpdate && !jobActive && !showRollback) return null;

  const items: { key: string; node: ReactNode; tone?: string }[] = [];

  if (jobActive && job) {
    items.push({
      key: "update-job",
      tone: "update",
      node: (
        <>
          <span className="status-dot status-dot-update" aria-hidden />
          {t("statusBar.updateProgress", {
            phase: job.phase,
            version: job.targetVersion,
          })}
        </>
      ),
    });
  } else if (job?.phase === "failed") {
    items.push({
      key: "update-fail",
      tone: "danger",
      node: <>{t("statusBar.updateFailed", { error: job.error || "unknown" })}</>,
    });
  } else if (job?.phase === "succeeded") {
    items.push({
      key: "update-ok",
      tone: "live",
      node: <>{t("statusBar.updateSucceeded", { version: job.targetVersion })}</>,
    });
  }

  if (showUpdate && latest && !jobActive) {
    const canApply = !!update?.selfUpdate?.canApply;
    items.push({
      key: "update",
      tone: "update",
      node: (
        <>
          <span className="status-dot status-dot-update" aria-hidden />
          {t("statusBar.updateAvailable", {
            current: update!.currentVersion,
            latest,
          })}
          {update?.releaseUrl ? (
            <a
              className="status-bar-link"
              href={update.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("statusBar.viewRelease")}
            </a>
          ) : null}
          {update?.selfUpdate ? (
            <button
              type="button"
              className="status-bar-link"
              onClick={() => setModal("apply")}
              title={update.selfUpdate.blockReason ?? undefined}
            >
              {canApply ? t("statusBar.installUpdate") : t("statusBar.installUpdateBlocked")}
            </button>
          ) : null}
          {update?.selfUpdate?.canRollback ? (
            <button type="button" className="status-bar-link" onClick={() => setModal("rollback")}>
              {t("statusBar.rollback")}
            </button>
          ) : null}
          <button
            type="button"
            className="status-bar-link"
            onClick={() => {
              dismissVersion(latest);
              setDismissedLatest(latest);
            }}
          >
            {t("statusBar.dismissUpdate")}
          </button>
        </>
      ),
    });
  } else if (showRollback && !jobActive) {
    items.push({
      key: "rollback",
      tone: "warn",
      node: (
        <>
          {t("statusBar.rollbackAvailable", {
            version: update!.selfUpdate!.rollbackVersion!,
          })}
          <button type="button" className="status-bar-link" onClick={() => setModal("rollback")}>
            {t("statusBar.rollback")}
          </button>
        </>
      ),
    });
  }

  if (s?.killSwitchActive) {
    items.push({
      key: "kill",
      tone: "danger",
      node: (
        <>
          <span className="status-dot status-dot-kill" aria-hidden />
          {t("statusBar.killActive")}
          <Link to="/risk" className="status-bar-link">
            {t("statusBar.goRisk")}
          </Link>
        </>
      ),
    });
  }

  if (s?.lastError) {
    items.push({
      key: "err",
      tone: "danger",
      node: <>{t("statusBar.lastError", { error: s.lastError })}</>,
    });
  }

  if (hasDrift && s) {
    items.push({
      key: "drift",
      tone: "warn",
      node: (
        <>
          {t("statusBar.drift", { count: s.walletDrifts.length })}
          <Link to="/positions" className="status-bar-link">
            {t("statusBar.viewPositions")}
          </Link>
        </>
      ),
    });
  }

  if (s && !s.previewMode) {
    items.push({
      key: "live",
      tone: "live",
      node: (
        <>
          <span className="status-dot status-dot-live" aria-hidden />
          {t("statusBar.liveMode")}
          <ModeSwitchButton previewMode={false} target="preview" variant="link" />
        </>
      ),
    });
  }

  if (items.length === 0) return null;

  const tone = items.some((i) => i.tone === "danger")
    ? "error"
    : items.some((i) => i.tone === "warn")
      ? "warn"
      : items.some((i) => i.tone === "live")
        ? "live"
        : items.some((i) => i.tone === "update")
          ? "update"
          : "info";

  const modeLabel = s
    ? s.previewMode
      ? t("badge.previewShort")
      : t("badge.liveShort")
    : null;

  return (
    <>
      <div className={`status-bar status-bar-${tone}`} role="status">
        <div className="status-bar-items">
          {items.map((item) => (
            <span
              key={item.key}
              className={`status-bar-item${item.tone ? ` status-bar-item-${item.tone}` : ""}`}
            >
              {item.node}
            </span>
          ))}
        </div>
        {s && modeLabel ? (
          <span className="status-bar-meta muted">
            {t("statusBar.uptime", { mode: modeLabel, time: fmtUptime(s.uptimeSec) })}
          </span>
        ) : null}
      </div>
      {update && modal ? (
        <UpdateApplyModal
          open
          mode={modal}
          update={update}
          onClose={() => setModal(null)}
        />
      ) : null}
    </>
  );
}
