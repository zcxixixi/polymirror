#!/usr/bin/env python3
from __future__ import annotations

import argparse
import glob
import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd


SUCCESS = "#2ca25f"
BLUE = "#4c78a8"
WARN = "#f2b447"
DANGER = "#d95f5f"
INK = "#17212b"
MUTED = "#56616f"


@dataclass
class LiveAttempt:
    generated_at: datetime
    account_id: str
    leader_id: str
    token_id: str
    side: str
    price: float
    size: float
    notional_usd: float
    submitted: bool
    geoblocked: bool
    safe_rejection: bool
    error: str
    filled_usd: float
    pending_remaining: float
    raw: dict[str, Any]


@dataclass
class PreviewCopy:
    account_id: str
    ts: datetime
    leader_id: str
    token_id: str
    side: str
    price: float
    size: float
    notional_usd: float
    reason: str


def parse_time(value: str | int | float) -> datetime:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
    text = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def latest_file(pattern: str) -> Path:
    files = sorted(Path(p) for p in glob.glob(pattern))
    if not files:
        raise FileNotFoundError(f"no files matched {pattern}")
    return files[-1]


def resolve_input_path(root: Path, path: Path) -> Path:
    if path.is_absolute() or path.exists():
        return path
    return root / path


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def normalize_leader_id(value: str) -> str:
    v = (value or "").lower()
    for prefix in ("trader_",):
        if v.startswith(prefix):
            v = v[len(prefix) :]
    for suffix in (
        "_probe",
        "_pct2_tight",
        "_pct5_wide",
        "_fixed1_wide",
        "_pct2",
        "_pct5",
        "_fixed1",
    ):
        v = v.replace(suffix, "")
    return v


def load_live_attempts(paths: list[Path]) -> list[LiveAttempt]:
    attempts: list[LiveAttempt] = []
    for path in paths:
        for row in read_jsonl(path):
            attempt = row.get("orderAttempt") or {}
            request = attempt.get("request") or {}
            if not request:
                continue
            result = attempt.get("result") or {}
            error = str(result.get("error") or attempt.get("reason") or "")
            filled = float(result.get("filledUsd") or 0)
            pending = float(result.get("pendingRemaining") or 0)
            safe = "not enough balance" in error.lower() and filled == 0 and pending == 0
            attempts.append(
                LiveAttempt(
                    generated_at=parse_time(row["generatedAt"]),
                    account_id=str(row.get("accountId") or ""),
                    leader_id=str(request.get("leaderId") or ""),
                    token_id=str(request.get("tokenId") or ""),
                    side=str(request.get("side") or ""),
                    price=float(request.get("price") or 0),
                    size=float(request.get("size") or 0),
                    notional_usd=float(request.get("notionalUsd") or 0),
                    submitted=bool(attempt.get("submitted")),
                    geoblocked=bool((row.get("geoblock") or {}).get("blocked")),
                    safe_rejection=safe,
                    error=error,
                    filled_usd=filled,
                    pending_remaining=pending,
                    raw=row,
                )
            )
    return sorted(attempts, key=lambda x: x.generated_at)


def load_preview_copies(data_dir: Path) -> list[PreviewCopy]:
    copies: list[PreviewCopy] = []
    for db_path in sorted(data_dir.glob("*/preview.db")):
        account_id = db_path.parent.name
        try:
            con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            rows = con.execute(
                """
                SELECT ts, leader_id, token_id, side, size, price, reason
                FROM audit_log
                WHERE action = 'COPY'
                  AND token_id IS NOT NULL
                  AND side IS NOT NULL
                ORDER BY ts ASC
                """
            ).fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            con.close()
        for ts, leader_id, token_id, side, size, price, reason in rows:
            p = float(price or 0)
            s = float(size or 0)
            copies.append(
                PreviewCopy(
                    account_id=account_id,
                    ts=parse_time(ts),
                    leader_id=str(leader_id or ""),
                    token_id=str(token_id or ""),
                    side=str(side or ""),
                    price=p,
                    size=s,
                    notional_usd=p * s,
                    reason=str(reason or ""),
                )
            )
    return copies


def compare_attempts(
    attempts: list[LiveAttempt],
    copies: list[PreviewCopy],
    window_seconds: int,
    price_tolerance: float,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for attempt in attempts:
        live_leader = normalize_leader_id(attempt.leader_id)
        candidates = [
            c
            for c in copies
            if c.token_id == attempt.token_id
            and c.side == attempt.side
            and abs((c.ts - attempt.generated_at).total_seconds()) <= window_seconds
        ]
        leader_candidates = [c for c in candidates if normalize_leader_id(c.leader_id) == live_leader]
        if leader_candidates:
            candidates = leader_candidates
        match = None
        if candidates:
            match = sorted(
                candidates,
                key=lambda c: (
                    abs((c.ts - attempt.generated_at).total_seconds()),
                    abs(c.price - attempt.price),
                    abs(c.notional_usd - attempt.notional_usd),
                ),
            )[0]
        dt_seconds = None
        price_delta = None
        notional_delta = None
        matched = match is not None
        if match:
            dt_seconds = (match.ts - attempt.generated_at).total_seconds()
            price_delta = match.price - attempt.price
            notional_delta = match.notional_usd - attempt.notional_usd
        price_ok = matched and abs(price_delta or 0) <= price_tolerance
        consistent = matched and price_ok
        rows.append(
            {
                "generatedAt": attempt.generated_at.isoformat(),
                "accountId": attempt.account_id,
                "leaderId": attempt.leader_id,
                "tokenId": attempt.token_id,
                "side": attempt.side,
                "livePrice": attempt.price,
                "liveSize": attempt.size,
                "liveNotionalUsd": attempt.notional_usd,
                "submitted": attempt.submitted,
                "geoblocked": attempt.geoblocked,
                "safeRejection": attempt.safe_rejection,
                "error": attempt.error,
                "matched": matched,
                "consistent": consistent,
                "matchAccountId": match.account_id if match else "",
                "matchLeaderId": match.leader_id if match else "",
                "matchAt": match.ts.isoformat() if match else "",
                "dtSeconds": dt_seconds,
                "previewPrice": match.price if match else math.nan,
                "previewNotionalUsd": match.notional_usd if match else math.nan,
                "priceDelta": price_delta,
                "notionalDeltaUsd": notional_delta,
                "previewReason": match.reason if match else "",
            }
        )
    return pd.DataFrame(rows)


def load_preview_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def account_reason(row: pd.Series) -> str:
    if bool(row.get("killSwitch", False)):
        return "触发 kill switch"
    if row["errorCount"] > 0:
        return "有执行错误"
    if row["copyCount"] == 0:
        return "暂无有效跟单"
    if row["cashRatio"] < 0.08 or row["cashStarvedSkipCount"] > 0:
        return "现金跟不上"
    if row["openRatio"] > 0.7:
        return "敞口过高"
    if row["maxOpenMarketSkipCount"] > 0:
        return "开仓数量过多"
    if row["realizedPnlUsd"] > 0:
        return "已结算盈利"
    if row["realizedPnlUsd"] < 0:
        return "已结算亏损"
    return "继续观察"


PLOT_REASON_LABELS = {
    "触发 kill switch": "kill switch",
    "有执行错误": "execution errors",
    "暂无有效跟单": "no valid copies",
    "现金跟不上": "cash constrained",
    "敞口过高": "high exposure",
    "开仓数量过多": "too many markets",
    "已结算盈利": "settled profit",
    "已结算亏损": "settled loss",
    "继续观察": "watch",
}


def build_account_frame(report: dict[str, Any]) -> pd.DataFrame:
    rows = []
    for r in report.get("reports", []):
        initial = float(r.get("cashUsd", 0)) + float(r.get("openCostUsd", 0)) - float(
            r.get("realizedPnlUsd", 0)
        )
        if initial <= 0:
            initial = 1.0
        rows.append(
            {
                "accountId": r.get("accountId", ""),
                "realizedPnlUsd": float(r.get("realizedPnlUsd", 0)),
                "cashUsd": float(r.get("cashUsd", 0)),
                "openCostUsd": float(r.get("openCostUsd", 0)),
                "copyCount": int(r.get("copyCount", 0)),
                "redeemCount": int(r.get("redeemCount", 0)),
                "skipCount": int(r.get("skipCount", 0)),
                "cashStarvedSkipCount": int(r.get("cashStarvedSkipCount", 0)),
                "maxOpenMarketSkipCount": int(r.get("maxOpenMarketSkipCount", 0)),
                "errorCount": int(r.get("errorCount", 0)),
                "killSwitch": bool(r.get("killSwitch", False)),
                "initialUsd": initial,
                "cashRatio": float(r.get("cashUsd", 0)) / initial,
                "openRatio": float(r.get("openCostUsd", 0)) / initial,
                "isExperiment": str(r.get("accountId", "")).startswith("exp_"),
            }
        )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["reason"] = df.apply(account_reason, axis=1)
    return df


def short_account(name: str) -> str:
    return (
        name.replace("acc_", "")
        .replace("exp_", "x_")
        .replace("b55fa129", "b55")
        .replace("d9e0aaca", "d9e")
        .replace("q96s3kwozynxpau", "q96")
        .replace("_200", "")
        .replace("_wide", "")
        .replace("_tight", "")
        .replace("fixed", "fix")
        .replace("pct", "p")
    )


def plot_live_parity(matches: pd.DataFrame, out_png: Path) -> None:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig = plt.figure(figsize=(14, 8), dpi=160)
    gs = fig.add_gridspec(2, 2, height_ratios=[0.55, 1], hspace=0.35, wspace=0.25)

    ax0 = fig.add_subplot(gs[0, 0])
    counts = {
        "live submitted": int(matches["submitted"].sum()) if not matches.empty else 0,
        "safe rejected": int(matches["safeRejection"].sum()) if not matches.empty else 0,
        "preview matched": int(matches["consistent"].sum()) if not matches.empty else 0,
        "geoblocked": int(matches["geoblocked"].sum()) if not matches.empty else 0,
    }
    colors = [BLUE, SUCCESS, SUCCESS, DANGER]
    ax0.barh(list(counts.keys()), list(counts.values()), color=colors)
    ax0.set_title("Live path parity checklist", loc="left", fontweight="bold")
    ax0.set_xlabel("count")
    ax0.spines[["top", "right", "left"]].set_visible(False)
    for y, value in enumerate(counts.values()):
        ax0.text(value + 0.1, y, str(value), va="center", fontsize=10)

    ax1 = fig.add_subplot(gs[0, 1])
    if not matches.empty:
        ratio = [
            matches["submitted"].mean(),
            matches["safeRejection"].mean(),
            matches["consistent"].mean(),
            1 - matches["geoblocked"].mean(),
        ]
    else:
        ratio = [0, 0, 0, 0]
    labels = ["submitted", "safe reject", "preview match", "not geoblocked"]
    ax1.bar(labels, ratio, color=[BLUE, SUCCESS, SUCCESS, SUCCESS])
    ax1.set_ylim(0, 1.05)
    ax1.set_title("Pass rate", loc="left", fontweight="bold")
    ax1.set_ylabel("share")
    ax1.grid(axis="y", alpha=0.18)
    ax1.spines[["top", "right"]].set_visible(False)
    for x, value in enumerate(ratio):
        ax1.text(x, value + 0.03, f"{value:.0%}", ha="center", fontsize=9)

    ax2 = fig.add_subplot(gs[1, 0])
    if not matches.empty and matches["matched"].any():
        matched = matches[matches["matched"]].copy()
        x = pd.to_datetime(matched["generatedAt"])
        y = matched["dtSeconds"].astype(float)
        c = [SUCCESS if ok else WARN for ok in matched["consistent"]]
        ax2.scatter(x, y, s=70, c=c, edgecolor="white", linewidth=0.7)
        ax2.axhline(0, color=INK, linewidth=0.8)
        ax2.set_ylabel("preview time - live time (sec)")
    else:
        ax2.text(0.5, 0.5, "no preview matches", ha="center", va="center", transform=ax2.transAxes)
    ax2.set_title("Matched order timing", loc="left", fontweight="bold")
    ax2.grid(alpha=0.18)
    ax2.spines[["top", "right"]].set_visible(False)

    ax3 = fig.add_subplot(gs[1, 1])
    if not matches.empty and matches["matched"].any():
        matched = matches[matches["matched"]].copy()
        ax3.scatter(
            matched["liveNotionalUsd"],
            matched["previewNotionalUsd"],
            c=[SUCCESS if ok else WARN for ok in matched["consistent"]],
            s=80,
            edgecolor="white",
            linewidth=0.7,
        )
        max_v = max(1.2, float(matched[["liveNotionalUsd", "previewNotionalUsd"]].max().max()) * 1.1)
        ax3.plot([0, max_v], [0, max_v], "--", color=INK, alpha=0.5)
        ax3.set_xlim(0, max_v)
        ax3.set_ylim(0, max_v)
        ax3.set_xlabel("live probe notional USDC")
        ax3.set_ylabel("preview notional USDC")
    else:
        ax3.text(0.5, 0.5, "no notional comparison", ha="center", va="center", transform=ax3.transAxes)
    ax3.set_title("Order size comparison", loc="left", fontweight="bold")
    ax3.grid(alpha=0.18)
    ax3.spines[["top", "right"]].set_visible(False)

    fig.suptitle("PolyMirror live order vs preview order parity", x=0.02, ha="left", fontsize=18, fontweight="bold")
    fig.savefig(out_png, facecolor="white", bbox_inches="tight")
    plt.close(fig)


def plot_strategy_health(accounts: pd.DataFrame, out_png: Path) -> None:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    if accounts.empty:
        return
    df = accounts.copy().sort_values("realizedPnlUsd", ascending=True)
    df["label"] = df["accountId"].map(short_account)
    fig = plt.figure(figsize=(16, 10), dpi=160)
    gs = fig.add_gridspec(2, 2, height_ratios=[1.1, 0.9], hspace=0.28, wspace=0.22)

    ax0 = fig.add_subplot(gs[0, 0])
    colors = [SUCCESS if v > 0 else DANGER if v < 0 else WARN for v in df["realizedPnlUsd"]]
    ax0.barh(df["label"], df["realizedPnlUsd"], color=colors)
    ax0.axvline(0, color=INK, linewidth=0.8)
    ax0.set_title("Settled PnL by account", loc="left", fontweight="bold")
    ax0.set_xlabel("USDC")
    ax0.tick_params(axis="y", labelsize=8)
    ax0.grid(axis="x", alpha=0.16)
    ax0.spines[["top", "right", "left"]].set_visible(False)

    ax1 = fig.add_subplot(gs[0, 1])
    flags = pd.DataFrame(
        {
            "cash low": (accounts["cashRatio"] < 0.08) | (accounts["cashStarvedSkipCount"] > 0),
            "high open": accounts["openRatio"] > 0.7,
            "max markets": accounts["maxOpenMarketSkipCount"] > 0,
            "errors": accounts["errorCount"] > 0,
            "kill": accounts["killSwitch"],
            "no copies": accounts["copyCount"] == 0,
        }
    ).astype(int)
    ordered_flags = flags.loc[df.index]
    ax1.imshow(ordered_flags.values, aspect="auto", cmap="YlOrRd", vmin=0, vmax=1)
    ax1.set_yticks(range(len(df)))
    ax1.set_yticklabels(df["label"], fontsize=8)
    ax1.set_xticks(range(len(ordered_flags.columns)))
    ax1.set_xticklabels(ordered_flags.columns, fontsize=8, rotation=25, ha="right")
    ax1.set_title("Risk reasons", loc="left", fontweight="bold")
    for y in range(ordered_flags.shape[0]):
        for x in range(ordered_flags.shape[1]):
            if ordered_flags.iat[y, x]:
                ax1.text(x, y, "!", ha="center", va="center", fontsize=8, fontweight="bold")
    ax1.spines[:].set_visible(False)

    ax2 = fig.add_subplot(gs[1, 0])
    sizes = 35 + accounts["copyCount"].clip(upper=250) * 1.4
    colors2 = [BLUE if exp else SUCCESS for exp in accounts["isExperiment"]]
    ax2.scatter(accounts["openCostUsd"], accounts["realizedPnlUsd"], s=sizes, c=colors2, alpha=0.75, edgecolor="white")
    for _, row in accounts.nlargest(5, "realizedPnlUsd").iterrows():
        ax2.text(row["openCostUsd"], row["realizedPnlUsd"], short_account(row["accountId"]), fontsize=8)
    ax2.axhline(0, color=INK, linewidth=0.8)
    ax2.set_title("Profit vs exposure", loc="left", fontweight="bold")
    ax2.set_xlabel("open cost USDC")
    ax2.set_ylabel("settled PnL USDC")
    ax2.grid(alpha=0.16)
    ax2.spines[["top", "right"]].set_visible(False)

    ax3 = fig.add_subplot(gs[1, 1])
    reason_counts = accounts["reason"].map(lambda x: PLOT_REASON_LABELS.get(str(x), str(x))).value_counts().sort_values()
    ax3.barh(reason_counts.index, reason_counts.values, color=WARN)
    ax3.set_title("Plain-English reasons", loc="left", fontweight="bold")
    ax3.set_xlabel("accounts")
    ax3.spines[["top", "right", "left"]].set_visible(False)
    for y, value in enumerate(reason_counts.values):
        ax3.text(value + 0.05, y, str(value), va="center", fontsize=9)

    fig.suptitle("PolyMirror strategy health analysis", x=0.02, ha="left", fontsize=18, fontweight="bold")
    fig.savefig(out_png, facecolor="white", bbox_inches="tight")
    plt.close(fig)


def write_report(
    out_md: Path,
    out_json: Path,
    live_png: Path,
    strategy_png: Path,
    matches: pd.DataFrame,
    accounts: pd.DataFrame,
    preview_report: dict[str, Any],
    live_paths: list[Path],
    preview_path: Path,
) -> None:
    summary = preview_report.get("summary", {})
    total_attempts = len(matches)
    submitted = int(matches["submitted"].sum()) if total_attempts else 0
    safe = int(matches["safeRejection"].sum()) if total_attempts else 0
    consistent = int(matches["consistent"].sum()) if total_attempts else 0
    geoblocked = int(matches["geoblocked"].sum()) if total_attempts else 0
    top = accounts.sort_values("realizedPnlUsd", ascending=False).head(6) if not accounts.empty else pd.DataFrame()
    worst = accounts.sort_values("realizedPnlUsd", ascending=True).head(5) if not accounts.empty else pd.DataFrame()

    def account_lines(df: pd.DataFrame) -> list[str]:
        lines = []
        for _, r in df.iterrows():
            lines.append(
                f"- `{r['accountId']}`: PnL `{r['realizedPnlUsd']:.2f}U`, "
                f"现金 `{r['cashUsd']:.2f}U`, 未结算敞口 `{r['openCostUsd']:.2f}U`, "
                f"跟单 `{int(r['copyCount'])}` 次，原因：{r['reason']}"
            )
        return lines or ["- 暂无"]

    if total_attempts:
        parity_sentence = (
            f"实盘探针共 `{total_attempts}` 次订单意图，`{submitted}` 次进入真实 CLOB 下单路径，"
            f"`{safe}` 次被余额不足安全拒绝，`{consistent}` 次能在模拟盘找到同 token/side/时间/价格的对应单。"
        )
    else:
        parity_sentence = "当前快照没有可比较的实盘订单意图。"

    md = [
        "# PolyMirror 实盘探针 vs 模拟盘一致性报告",
        "",
        f"生成时间：`{datetime.now(timezone.utc).isoformat()}`",
        f"实盘日志：`{', '.join(str(p) for p in live_paths)}`",
        f"模拟报告：`{preview_path}`",
        "",
        "## 1. 结论",
        "",
        f"- {parity_sentence}",
        f"- 地区封锁次数：`{geoblocked}`。如果为 0，说明当前出口可访问 Polymarket CLOB。",
        f"- 最新模拟报告账户数：`{summary.get('accountCount', 0)}`；LiveReady：`{summary.get('liveReadyCount', 0)}`；错误：`{(summary.get('riskCounts') or {}).get('errors', 0)}`；账务异常：`{(summary.get('riskCounts') or {}).get('accountingDiagnostics', 0)}`。",
        "- 现在验证到的是“交易意图和下单链路一致”，不是“已经适合真钱实盘”。真钱还需要更多结算样本和 LiveReady 通过。",
        "",
        "## 2. 实盘和模拟盘是否一致",
        "",
        f"![live parity]({live_png.resolve()})",
        "",
        "普通解释：空钱包实盘探针会真的调用 CLOB 下单接口；因为钱包几乎没钱，订单被余额不足拒绝。只要它的 token、方向、价格和模拟盘对应得上，就说明从“读到 leader 交易 -> 算出订单 -> 调用实盘接口”的链路是通的。",
        "",
        "## 3. 策略健康和成败原因",
        "",
        f"![strategy health]({strategy_png.resolve()})",
        "",
        "成功通常来自三个条件：有足够多的有效 COPY、有结算 REDEEM、现金和敞口没有把账户卡死。失败通常不是一个原因，而是现金耗尽、敞口太高、开仓过多或已经结算亏损叠加。",
        "",
        "### 当前表现较好的组",
        "",
        *account_lines(top),
        "",
        "### 当前需要警惕的组",
        "",
        *account_lines(worst),
        "",
        "## 4. 给明天迭代的读法",
        "",
        "- `safe rejected` 高：好事，说明实盘接口被真实触发但没有资金风险。",
        "- `preview matched` 高：好事，说明实盘意图和模拟盘一致。",
        "- `open cost` 太高：说明钱被未结算仓位占住，下一轮跟单能力会下降。",
        "- `cash low / cash-starved`：200U 沙盒跟不全小周期高频盘，不一定是 bug，但会降低复刻率。",
        "- `kill/errors/accounting`：这是硬问题，出现就不能实盘。",
    ]
    out_md.write_text("\n".join(md) + "\n", encoding="utf-8")

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "liveProbeFiles": [str(p) for p in live_paths],
        "previewReport": str(preview_path),
        "summary": {
            "liveAttempts": total_attempts,
            "submitted": submitted,
            "safeRejections": safe,
            "consistentMatches": consistent,
            "geoblocked": geoblocked,
            "matchRate": consistent / total_attempts if total_attempts else None,
            "safeRejectionRate": safe / submitted if submitted else None,
            "previewSummary": summary,
        },
        "matches": matches.to_dict(orient="records"),
        "accounts": accounts.to_dict(orient="records") if not accounts.empty else [],
    }
    out_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare empty-wallet live probe orders with preview COPY records.")
    parser.add_argument("--root", type=Path, default=Path("."), help="Snapshot/root directory containing data and reports.")
    parser.add_argument("--live-probe", type=Path, action="append", help="Live-probe jsonl file. Can be repeated.")
    parser.add_argument("--preview-report", type=Path, help="Preview report JSON. Defaults to latest preview-report-*.json.")
    parser.add_argument("--out-dir", type=Path, default=Path("reports/visual"))
    parser.add_argument("--window-seconds", type=int, default=900)
    parser.add_argument("--price-tolerance", type=float, default=0.05)
    args = parser.parse_args()

    root = args.root
    live_paths = args.live_probe or [latest_file(str(root / "reports/live-probe/live-probe-*.jsonl"))]
    live_paths = [resolve_input_path(root, p) for p in live_paths]
    preview_path = args.preview_report or latest_file(str(root / "reports/preview-live/preview-report-*.json"))
    preview_path = resolve_input_path(root, preview_path)
    out_dir = args.out_dir if args.out_dir.is_absolute() else root / args.out_dir

    attempts = load_live_attempts(live_paths)
    copies = load_preview_copies(root / "data/accounts")
    matches = compare_attempts(attempts, copies, args.window_seconds, args.price_tolerance)
    preview_report = load_preview_report(preview_path)
    accounts = build_account_frame(preview_report)

    out_dir.mkdir(parents=True, exist_ok=True)
    live_png = out_dir / "live-preview-parity.png"
    strategy_png = out_dir / "strategy-health-analysis.png"
    out_md = out_dir / "live-preview-parity-report.md"
    out_json = out_dir / "live-preview-parity-report.json"

    plot_live_parity(matches, live_png)
    plot_strategy_health(accounts, strategy_png)
    write_report(out_md, out_json, live_png, strategy_png, matches, accounts, preview_report, live_paths, preview_path)

    print(out_md)
    print(out_json)
    print(live_png)
    print(strategy_png)


if __name__ == "__main__":
    main()
