#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


STATUS_COLORS = {
    "LiveReady": "#2ca25f",
    "CandidateBlocked": "#4c78a8",
    "Watch": "#f2b447",
    "Reject": "#d95f5f",
}


def short_name(name: str) -> str:
    return (
        name.replace("ceshi_", "")
        .replace("_b55fa129", "")
        .replace("fixed", "fix")
        .replace("pct", "p")
        .replace("cap", "c")
        .replace("tight", "tight")
        .replace("age72", "a72")
        .replace("fresh30s", "f30s")
    )


def status_for(rank: dict) -> str:
    if rank["liveReady"]:
        return "LiveReady"
    if rank["grade"] == "reject":
        return "Reject"
    if rank["grade"] == "watch":
        return "Watch"
    return "CandidateBlocked"


def build_rows(data: dict) -> pd.DataFrame:
    reports = {row["accountId"]: row for row in data["reports"]}
    rows = []
    for rank in data["rankings"]:
        report = reports[rank["accountId"]]
        blockers = "; ".join(rank.get("liveBlockers", []))
        reasons = "; ".join(rank.get("reasons", []))
        window = report.get("recentWindow") or {}
        rows.append(
            {
                "account": rank["accountId"],
                "label": short_name(rank["accountId"]),
                "status": status_for(rank),
                "grade": rank["grade"],
                "liveReady": bool(rank["liveReady"]),
                "pnl": float(report["realizedPnlUsd"]),
                "cash": float(report["cashUsd"]),
                "openCost": float(report["openCostUsd"]),
                "copies": int(report["copyCount"]),
                "redeems": int(report["redeemCount"]),
                "errors": int(report["errorCount"]),
                "cashSkips": int(window.get("cashStarvedSkipCount", 0)),
                "capSkips": int(window.get("positionCapSkipCount", 0)),
                "blockers": blockers,
                "reasons": reasons,
                "cashWarn": "cash-starved" in reasons,
                "capRisk": "position-cap" in blockers or "position-cap" in reasons,
                "errorRisk": "errors present" in blockers,
                "killRisk": "kill switch active" in blockers,
                "acctRisk": "accounting diagnostics not clean" in blockers,
                "exposureRisk": "high open cost" in blockers,
                "profitGate": "live profit gate not met" in blockers,
                "settlementGate": "settled redeem count below live gate" in blockers,
            }
        )
    return pd.DataFrame(rows)


def plot_report(df: pd.DataFrame, data: dict, out_png: Path) -> None:
    ordered = df.sort_values("pnl", ascending=True).reset_index(drop=True)
    matrix_cols = [
        ("liveReady", "Ready"),
        ("cashWarn", "Cash\nwarn"),
        ("capRisk", "Cap"),
        ("errorRisk", "Err"),
        ("killRisk", "Kill"),
        ("acctRisk", "Acct"),
        ("exposureRisk", "Exposure"),
        ("profitGate", "Profit"),
        ("settlementGate", "Settle"),
    ]
    matrix = ordered[[col for col, _ in matrix_cols]].astype(int)

    fig = plt.figure(figsize=(15, 9), dpi=160)
    gs = fig.add_gridspec(
        3,
        2,
        width_ratios=[1.35, 1],
        height_ratios=[0.18, 1, 0.58],
        hspace=0.28,
        wspace=0.2,
    )

    ax_title = fig.add_subplot(gs[0, :])
    ax_title.axis("off")
    generated = data.get("generatedAt", "")
    live_ready = df[df["liveReady"]]
    cash_warn_count = int(df["cashWarn"].sum())
    hard_blocked = int((~df["liveReady"]).sum())
    ax_title.text(
        0,
        0.7,
        "PolyMirror Preview Strategy Risk Snapshot",
        fontsize=20,
        fontweight="bold",
        color="#17212b",
        transform=ax_title.transAxes,
    )
    ax_title.text(
        0,
        0.2,
        f"Source: latest real preview report | generated {generated} | "
        f"LiveReady {len(live_ready)}/{len(df)} | Cash warnings {cash_warn_count} | Blocked {hard_blocked}",
        fontsize=10.5,
        color="#56616f",
        transform=ax_title.transAxes,
    )

    ax_bar = fig.add_subplot(gs[1, 0])
    colors = [STATUS_COLORS[s] for s in ordered["status"]]
    ax_bar.barh(ordered["label"], ordered["pnl"], color=colors)
    ax_bar.axvline(0, color="#38424f", linewidth=0.8)
    ax_bar.set_title("Realized PnL by strategy (settled only)", loc="left", fontweight="bold")
    ax_bar.set_xlabel("USDC")
    ax_bar.grid(axis="x", alpha=0.18)
    ax_bar.spines[["top", "right", "left"]].set_visible(False)
    ax_bar.tick_params(axis="y", labelsize=8)
    for y, pnl in enumerate(ordered["pnl"]):
        ax_bar.text(
            pnl + (8 if pnl >= 0 else -8),
            y,
            f"{pnl:.0f}",
            va="center",
            ha="left" if pnl >= 0 else "right",
            fontsize=8,
            color="#27313d",
        )

    ax_matrix = fig.add_subplot(gs[1, 1])
    ax_matrix.imshow(matrix.values, aspect="auto", cmap="RdYlGn_r", vmin=0, vmax=1)
    ax_matrix.set_title("Risk flags", loc="left", fontweight="bold")
    ax_matrix.set_yticks(range(len(ordered)))
    ax_matrix.set_yticklabels(ordered["label"], fontsize=8)
    ax_matrix.set_xticks(range(len(matrix_cols)))
    ax_matrix.set_xticklabels([label for _, label in matrix_cols], fontsize=8)
    ax_matrix.tick_params(axis="x", top=True, bottom=False, labeltop=True, labelbottom=False)
    for y in range(matrix.shape[0]):
        for x in range(matrix.shape[1]):
            value = matrix.iat[y, x]
            if value:
                ax_matrix.text(x, y, "!", ha="center", va="center", fontsize=8, fontweight="bold")
    ax_matrix.spines[:].set_visible(False)

    ax_scatter = fig.add_subplot(gs[2, 0])
    marker_sizes = 35 + ordered["cashSkips"].clip(upper=5000) / 55
    ax_scatter.scatter(
        ordered["openCost"],
        ordered["pnl"],
        s=marker_sizes,
        c=[STATUS_COLORS[s] for s in ordered["status"]],
        alpha=0.78,
        edgecolor="#ffffff",
        linewidth=0.7,
    )
    for _, row in ordered.nlargest(5, "pnl").iterrows():
        ax_scatter.text(row["openCost"], row["pnl"], row["label"], fontsize=7, ha="left", va="bottom")
    ax_scatter.axvline(180, color="#d95f5f", linestyle="--", linewidth=1, alpha=0.65)
    ax_scatter.set_title("PnL vs current open cost (bubble = cash warnings)", loc="left", fontweight="bold")
    ax_scatter.set_xlabel("Open cost USDC")
    ax_scatter.set_ylabel("Realized PnL USDC")
    ax_scatter.grid(alpha=0.18)
    ax_scatter.spines[["top", "right"]].set_visible(False)

    ax_notes = fig.add_subplot(gs[2, 1])
    ax_notes.axis("off")
    top = df.sort_values("pnl", ascending=False).iloc[0]
    ready_names = ", ".join(live_ready["label"].tolist()) or "none"
    notes = [
        ("Green", "eligible"),
        ("Blue", "blocked by non-cash risk"),
        ("Orange", "watch"),
        ("Red", "hard blocker"),
    ]
    ax_notes.text(0, 0.95, "Reading guide", fontweight="bold", fontsize=12, transform=ax_notes.transAxes)
    y = 0.82
    for label, desc in notes:
        ax_notes.scatter(
            [0.02],
            [y + 0.02],
            s=90,
            color=STATUS_COLORS[
                "LiveReady"
                if label == "Green"
                else "CandidateBlocked"
                if label == "Blue"
                else "Watch"
                if label == "Orange"
                else "Reject"
            ],
            transform=ax_notes.transAxes,
            clip_on=False,
        )
        ax_notes.text(0.07, y, f"{label}: {desc}", fontsize=9, transform=ax_notes.transAxes)
        y -= 0.12
    ax_notes.text(
        0,
        0.08,
        f"Top PnL: {short_name(top['account'])} +{top['pnl']:.2f}U\n"
        f"LiveReady: {ready_names}\n"
        "Cash shortage is now a warning, not a hard blocker.",
        fontsize=8.5,
        color="#27313d",
        linespacing=1.35,
        transform=ax_notes.transAxes,
    )

    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, facecolor="#ffffff")
    plt.close(fig)


def write_markdown(df: pd.DataFrame, data: dict, out_png: Path, out_md: Path) -> None:
    ready = df[df["liveReady"]].sort_values("pnl", ascending=False)
    top = df.sort_values("pnl", ascending=False).head(5)
    hard = df[df["status"] == "Reject"].sort_values("pnl", ascending=False)
    image_path = out_png.resolve()

    def bullet_rows(frame: pd.DataFrame) -> list[str]:
        lines = []
        for _, row in frame.iterrows():
            lines.append(
                f"- `{row['account']}`: PnL `{row['pnl']:.2f}U`, "
                f"cash `{row['cash']:.2f}U`, open cost `{row['openCost']:.2f}U`, "
                f"status `{row['status']}`"
            )
        return lines

    md = [
        "# PolyMirror Preview Risk Snapshot",
        "",
        f"Data source: `reports/visual/latest-preview-report.json`",
        f"Generated at: `{data.get('generatedAt', '')}`",
        "",
        f"![Preview risk snapshot]({image_path})",
        "",
        "## Key Takeaways",
        "",
        f"- LiveReady strategies: `{len(ready)}` / `{len(df)}`.",
        f"- Cash-starved strategies are now warnings: `{int(df['cashWarn'].sum())}` strategies.",
        f"- Hard rejected strategies: `{len(hard)}` strategies.",
        "- PnL is realized/settled only. Open cost is exposure/cost, not marked-to-market value.",
        "",
        "## LiveReady Now",
        "",
        *(bullet_rows(ready) or ["- none"]),
        "",
        "## Highest Realized PnL",
        "",
        *bullet_rows(top),
        "",
        "## Hard Risk To Watch",
        "",
        *(bullet_rows(hard) or ["- none"]),
        "",
        "## Interpretation",
        "",
        "Cash shortage means the 200U sandbox could not follow every trade. It is not a bug by itself, but it means replication is incomplete.",
        "The remaining hard blockers are more serious: kill switch, errors, accounting mismatch, high exposure, and position-cap pressure.",
    ]
    out_md.write_text("\n".join(md) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args()

    data = json.loads(args.input.read_text(encoding="utf-8"))
    df = build_rows(data)
    out_png = args.out_dir / "preview-risk-snapshot.png"
    out_md = args.out_dir / "preview-risk-snapshot.md"
    plot_report(df, data, out_png)
    write_markdown(df, data, out_png, out_md)
    print(out_png)
    print(out_md)


if __name__ == "__main__":
    main()
