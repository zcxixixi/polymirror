import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, switchLiveMode, switchPreviewMode } from "../api/settings";
import { ConfirmModal } from "./ui/ConfirmModal";
import { useToast } from "./ui/Toast";
import { translateApiMessage } from "../i18n/apiMessages";
import { useT } from "../i18n/I18nProvider";

interface ModeSwitchButtonProps {
  previewMode: boolean;
  /** Default: offer the opposite of current mode */
  target?: "live" | "preview";
  /** page header button vs status-bar text link */
  variant?: "button" | "link";
  compact?: boolean;
}

export function ModeSwitchButton({
  previewMode,
  target,
  variant = "button",
  compact,
}: ModeSwitchButtonProps) {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const switchTo = target ?? (previewMode ? "live" : "preview");
  const alreadyThere = switchTo === "live" ? !previewMode : previewMode;

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    enabled: switchTo === "live" && !alreadyThere,
    staleTime: 30_000,
  });

  const canSwitchLive =
    !!settings.data &&
    (settings.data.env.liveConfirmSet || !settings.data.env.requireLiveConfirm);
  const liveBlocked =
    switchTo === "live" && settings.isSuccess && !canSwitchLive;
  const settingsUnavailable =
    switchTo === "live" && (settings.isError || settings.isFetching || settings.isLoading);

  const toPreview = useMutation({
    mutationFn: switchPreviewMode,
    onSuccess: (r) => {
      toast(translateApiMessage(t, r.message), "success");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["risk"] });
    },
    onError: (e: Error) => toast(translateApiMessage(t, e.message), "error"),
  });

  const toLive = useMutation({
    mutationFn: switchLiveMode,
    onSuccess: (r) => {
      toast(translateApiMessage(t, r.message), "success");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["risk"] });
    },
    onError: (e: Error) => {
      const msg = translateApiMessage(t, e.message);
      toast(t("settings.liveSwitchFailed", { message: msg }), "error");
    },
  });

  if (alreadyThere) return null;

  const pending = switchTo === "live" ? toLive.isPending : toPreview.isPending;
  // Soft-block liveBlocked so click can toast; hard-disable only while loading/pending.
  const hardDisabled =
    pending || (switchTo === "live" && (settings.isLoading || settings.isFetching));

  const label = switchTo === "live" ? t("settings.toLive") : t("settings.toPreview");

  const buttonClass =
    variant === "link"
      ? "status-bar-link"
      : compact
        ? "secondary btn-sm"
        : "secondary";

  function onClick() {
    if (switchTo === "live") {
      if (settings.isError) {
        toast(translateApiMessage(t, (settings.error as Error).message), "error");
        return;
      }
      if (liveBlocked) {
        toast(t("settings.liveBlocked"), "error");
        return;
      }
      if (settingsUnavailable) return;
    }
    setConfirmOpen(true);
  }

  return (
    <>
      <button
        type="button"
        className={buttonClass}
        disabled={hardDisabled}
        style={liveBlocked ? { opacity: 0.65 } : undefined}
        title={liveBlocked ? t("settings.liveBlocked") : undefined}
        onClick={onClick}
      >
        {label}
      </button>
      <ConfirmModal
        open={confirmOpen}
        title={
          switchTo === "live" ? t("settings.confirmLiveTitle") : t("settings.confirmPreviewTitle")
        }
        variant="danger"
        confirmLabel={
          switchTo === "live" ? t("settings.confirmLiveBtn") : t("settings.confirmPreviewBtn")
        }
        loading={pending}
        description={
          switchTo === "live" ? (
            <>
              <p style={{ margin: "0 0 0.75rem" }}>{t("settings.confirmLiveP1")}</p>
              <ul style={{ margin: 0, paddingLeft: "1.25rem", color: "var(--text-secondary)" }}>
                <li>{t("settings.confirmLiveLi1")}</li>
                <li>{t("settings.confirmLiveLi2")}</li>
                <li>{t("settings.confirmLiveLi3")}</li>
              </ul>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 0.75rem" }}>{t("settings.confirmPreviewP1")}</p>
              <ul style={{ margin: 0, paddingLeft: "1.25rem", color: "var(--text-secondary)" }}>
                <li>{t("settings.confirmPreviewLi1")}</li>
                <li>{t("settings.confirmPreviewLi2")}</li>
              </ul>
            </>
          )
        }
        onConfirm={() => {
          const m = switchTo === "live" ? toLive : toPreview;
          m.mutate(undefined, { onSettled: () => setConfirmOpen(false) });
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
