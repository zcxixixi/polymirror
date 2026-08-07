import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type UpdateCheckResponse } from "../api/client";
import { ConfirmModal } from "./ui/ConfirmModal";
import { useToast } from "./ui/Toast";
import { useT } from "../i18n/I18nProvider";
import { translateApiMessage } from "../i18n/apiMessages";

type Mode = "apply" | "rollback";

interface UpdateApplyModalProps {
  open: boolean;
  mode: Mode;
  update: UpdateCheckResponse;
  onClose: () => void;
}

export function UpdateApplyModal({ open, mode, update, onClose }: UpdateApplyModalProps) {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");

  const self = update.selfUpdate;
  const phrase =
    mode === "apply" ? self?.confirmPhrase ?? "" : self?.rollbackConfirmPhrase ?? "";
  const target =
    mode === "apply" ? update.latestVersion : self?.rollbackVersion ?? null;

  useEffect(() => {
    if (open) setTyped("");
  }, [open, mode, phrase]);

  const apply = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("No target version");
      return apiFetch<{ ok: boolean; message?: string }>("/api/update/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: target, confirm: typed.trim() }),
      });
    },
    onSuccess: (r) => {
      toast(r.message ?? t("statusBar.updateStarted"), "success");
      queryClient.invalidateQueries({ queryKey: ["update-check"] });
      onClose();
    },
    onError: (e: Error) => toast(translateApiMessage(t, e.message), "error"),
  });

  const rollback = useMutation({
    mutationFn: async () =>
      apiFetch<{ ok: boolean; message?: string }>("/api/update/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed.trim() }),
      }),
    onSuccess: (r) => {
      toast(r.message ?? t("statusBar.rollbackStarted"), "success");
      queryClient.invalidateQueries({ queryKey: ["update-check"] });
      onClose();
    },
    onError: (e: Error) => toast(translateApiMessage(t, e.message), "error"),
  });

  const pending = apply.isPending || rollback.isPending;
  const canSubmit = !!phrase && typed.trim() === phrase && !pending;

  if (!open) return null;

  const blocked = mode === "apply" ? !self?.canApply : !self?.canRollback;

  return (
    <ConfirmModal
      open={open}
      title={mode === "apply" ? t("statusBar.applyTitle") : t("statusBar.rollbackTitle")}
      variant="danger"
      confirmLabel={
        mode === "apply" ? t("statusBar.applyConfirmBtn") : t("statusBar.rollbackConfirmBtn")
      }
      loading={pending}
      confirmDisabled={!canSubmit || blocked}
      onCancel={onClose}
      onConfirm={() => {
        if (!canSubmit) return;
        if (mode === "apply") apply.mutate();
        else rollback.mutate();
      }}
      description={
        <>
          {mode === "apply" ? (
            <>
              <p style={{ margin: "0 0 0.75rem" }}>
                {t("statusBar.applyP1", {
                  current: update.currentVersion,
                  latest: target ?? "?",
                })}
              </p>
              <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.25rem", color: "var(--text-secondary)" }}>
                <li>{t("statusBar.applyLi1")}</li>
                <li>{t("statusBar.applyLi2")}</li>
                <li>{t("statusBar.applyLi3")}</li>
              </ul>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 0.75rem" }}>
                {t("statusBar.rollbackP1", {
                  version: target ?? "?",
                })}
              </p>
              <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.25rem", color: "var(--text-secondary)" }}>
                <li>{t("statusBar.rollbackLi1")}</li>
                <li>{t("statusBar.rollbackLi2")}</li>
              </ul>
            </>
          )}

          {self?.blockReason ? (
            <p className="form-error" style={{ margin: "0 0 0.75rem" }}>
              {self.blockReason}
            </p>
          ) : null}

          {blocked && !self?.blockReason ? (
            <p className="form-error" style={{ margin: "0 0 0.75rem" }}>
              {t("statusBar.updateBlocked")}
            </p>
          ) : null}

          <label className="field" style={{ display: "block", marginTop: "0.5rem" }}>
            <span className="muted" style={{ display: "block", marginBottom: "0.35rem" }}>
              {t("statusBar.typeConfirm", { phrase: phrase || "—" })}
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={blocked || pending}
              placeholder={phrase || undefined}
            />
          </label>
        </>
      }
    />
  );
}
