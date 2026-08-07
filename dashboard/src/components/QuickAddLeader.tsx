import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost, validateLeader } from "../api/leaders";
import { useToast } from "./ui/Toast";
import { translateApiMessage } from "../i18n/apiMessages";
import { useT } from "../i18n/I18nProvider";
import { parseFollowTarget, suggestLeaderId } from "../utils/leaderId";

export function QuickAddLeader() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [raw, setRaw] = useState("");
  const [leaderId, setLeaderId] = useState("");
  const [copySize, setCopySize] = useState("5");
  const [maxOrderUsd, setMaxOrderUsd] = useState("20");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = useMemo(() => parseFollowTarget(raw), [raw]);

  function onTargetChange(value: string) {
    setRaw(value);
    setError(null);
    setStatus(null);
    const parsed = parseFollowTarget(value);
    if (!parsed) return;
    if (parsed.mode === "address") {
      setLeaderId((prev) =>
        !prev || prev.startsWith("trader_") ? suggestLeaderId(undefined, parsed.address) : prev
      );
    } else {
      setLeaderId((prev) =>
        !prev || prev.startsWith("trader_") ? suggestLeaderId(parsed.username, "") : prev
      );
    }
  }

  async function onValidate() {
    setError(null);
    setStatus(null);
    if (!target) {
      setError(t("leaders.quickInvalid"));
      return;
    }
    try {
      const r = await validateLeader({
        id: leaderId,
        mode: target.mode,
        address: target.mode === "address" ? target.address : "",
        username: target.mode === "username" ? target.username : "",
        enabled: true,
        weight: 1,
        strategyType: "PERCENTAGE",
        copySize: 5,
        maxOrderUsd: "20",
        maxPositionUsd: "",
        maxDailyVolumeUsd: "",
        minPrice: "",
        maxPrice: "",
        sideBuy: true,
        sideSell: true,
      });
      if (r.valid) {
        if (r.resolvedAddress && target.mode === "username") {
          setLeaderId((prev) =>
            !prev || prev.startsWith("trader_")
              ? suggestLeaderId(target.username, r.resolvedAddress!)
              : prev
          );
        }
        const addr = r.resolvedAddress ? ` → ${r.resolvedAddress.slice(0, 10)}…` : "";
        setStatus(`✓ ${t("leaders.validateOk")} ${r.trades}${addr}`);
      } else {
        setStatus(r.error ?? t("leaders.validateFail"));
      }
    } catch (e) {
      setError(
        translateApiMessage(t, e instanceof Error ? e.message : String(e))
      );
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error(t("leaders.quickInvalid"));
      const id = leaderId.trim();
      if (!id) throw new Error(t("leaders.quickIdRequired"));
      const ratio = parseFloat(copySize);
      const cap = parseFloat(maxOrderUsd);
      if (!(ratio > 0)) throw new Error(t("leaders.ratioRequired"));
      if (!(cap > 0)) throw new Error(t("leaders.capRequired"));
      return apiPost("/api/leaders", {
        id,
        mode: target.mode,
        ...(target.mode === "address"
          ? { address: target.address }
          : { username: target.username }),
        enabled: true,
        weight: 1,
        strategy: { type: "PERCENTAGE", copySize: ratio },
        limits: { maxOrderUsd: cap },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["leaders"] });
      void queryClient.invalidateQueries({ queryKey: ["discover"] });
      toast(t("leaders.quickAdded", { id: leaderId.trim() }), "success");
      setRaw("");
      setLeaderId("");
      setStatus(null);
      setError(null);
    },
    onError: (e: Error) => {
      const msg = translateApiMessage(t, e.message);
      setError(msg);
      toast(msg, "error");
    },
  });

  return (
    <div className="panel quick-add-leader" id="quick-add-leader">
      <div className="quick-add-header">
        <h2 className="section-title">{t("leaders.quickTitle")}</h2>
        <p className="muted">{t("leaders.quickSubtitle")}</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {status && <p className="validate-msg">{status}</p>}

      <div className="form-row">
        <label className="form-label" style={{ gridColumn: "1 / -1" }}>
          {t("leaders.quickTarget")}
          <input
            type="text"
            className="mono"
            value={raw}
            onChange={(e) => onTargetChange(e.target.value)}
            placeholder={t("leaders.quickPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="form-label">
          {t("leaders.leaderIdLabel")}
          <input
            type="text"
            value={leaderId}
            onChange={(e) => setLeaderId(e.target.value)}
            placeholder="whale_a"
            pattern="[a-zA-Z0-9_-]+"
          />
        </label>
        <label className="form-label">
          {t("leaders.ratioLabel")}
          <input
            type="number"
            min="0.1"
            step="0.5"
            value={copySize}
            onChange={(e) => setCopySize(e.target.value)}
          />
        </label>
        <label className="form-label">
          {t("leaders.capLabel")}
          <input
            type="number"
            min="1"
            step="1"
            value={maxOrderUsd}
            onChange={(e) => setMaxOrderUsd(e.target.value)}
          />
        </label>
      </div>

      <div className="form-actions">
        <button type="button" disabled={save.isPending || !target} onClick={() => save.mutate()}>
          {save.isPending ? t("common.processing") : t("leaders.quickFollow")}
        </button>
        <button type="button" className="secondary" disabled={!target} onClick={onValidate}>
          {t("leaders.validateBtn")}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!target || target.mode !== "address"}
          onClick={() => {
            if (target?.mode === "address") {
              navigate(`/discover/trader/${encodeURIComponent(target.address)}`);
            }
          }}
        >
          {t("leaders.quickInspect")}
        </button>
        <button type="button" className="secondary" onClick={() => navigate("/leaders/new")}>
          {t("leaders.quickAdvanced")}
        </button>
      </div>
    </div>
  );
}
