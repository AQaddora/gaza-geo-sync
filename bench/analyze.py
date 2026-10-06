#!/usr/bin/env python3
"""Summarise bench/results/*.csv and draw the figures (paper/figures and docs/images).

Usage: python3 bench/analyze.py   (needs matplotlib)
All data is SYNTHETIC (bench/synthetic.ts); see docs/TEST-REPORT.md.
"""
import csv
import statistics
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.ticker  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "bench" / "results"
FIG = ROOT / "paper" / "figures"
IMG = ROOT / "docs" / "images"
FIG.mkdir(parents=True, exist_ok=True)

PROFILES = ["wifi", "4g", "3g", "edge", "lossy"]
PROFILE_LABEL = {"wifi": "Wi-Fi", "4g": "4G", "3g": "3G", "edge": "EDGE (2G)", "lossy": "3G + 3% loss"}
COUNTS = [10, 50, 150, 300]
BIN = "#2a78d6"  # this format (categorical slot 1)
JSON = "#eb6834"  # gzip'd JSON (slot 2)
AQUA = "#1baf7a"
YELLOW = "#eda100"
INK = "#0b0b0b"
INK2 = "#52514e"
GRID = "#e4e3df"
SURFACE = "#fcfcfb"

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 10,
    "axes.edgecolor": GRID,
    "axes.labelcolor": INK2,
    "axes.titlecolor": INK,
    "axes.titlesize": 11,
    "axes.titleweight": "bold",
    "xtick.color": INK2,
    "ytick.color": INK2,
    "axes.grid": True,
    "axes.grid.axis": "y",
    "grid.color": GRID,
    "grid.linewidth": 0.8,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "figure.facecolor": SURFACE,
    "axes.facecolor": SURFACE,
    "savefig.facecolor": SURFACE,
    "legend.frameon": False,
})


def pct(xs, p):
    s = sorted(xs)
    if not s:
        return float("nan")
    k = (len(s) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def save(fig, name, also_docs=False):
    for ax in fig.axes:
        ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:,.0f}" if v >= 10 or v == 0 else f"{v:g}"))
    fig.tight_layout()
    fig.savefig(FIG / name, dpi=160)
    if also_docs:
        fig.savefig(IMG / name, dpi=160)
    plt.close(fig)


def bar_pair(ax, xs, a, b, a_err=None, b_err=None, labels=("gzip'd JSON", "this format"), colors=(JSON, BIN)):
    w = 0.38
    pos = list(range(len(xs)))
    ax.bar([p - w / 2 - 0.01 for p in pos], a, w, color=colors[0], label=labels[0], yerr=a_err, error_kw={"ecolor": INK2, "elinewidth": 1, "capsize": 2})
    ax.bar([p + w / 2 + 0.01 for p in pos], b, w, color=colors[1], label=labels[1], yerr=b_err, error_kw={"ecolor": INK2, "elinewidth": 1, "capsize": 2})
    ax.set_xticks(pos, xs)


# ---------- 1. Payload sizes (bench/sizes.ts) ----------
sizes = list(csv.DictReader(open(RES / "sizes.csv")))
fig, ax = plt.subplots(figsize=(7.2, 3.8))
sel = [r for r in sizes if int(r["vehicles"]) in (10, 50, 150, 300)]
xs = [r["vehicles"] for r in sel]
series = [("JSON, gzip", "json_gzip", JSON), ("MessagePack, gzip", "msgpack_gzip", AQUA), ("Protobuf, gzip", "protobuf_naive_gzip", YELLOW), ("this format", "binary_sent", BIN)]
w = 0.2
for i, (label, key, color) in enumerate(series):
    vals = [int(r[key]) for r in sel]
    bars = ax.bar([p + (i - 1.5) * (w + 0.01) for p in range(len(sel))], vals, w, color=color, label=label)
    if key in ("json_gzip", "binary_sent"):
        for b, v in zip(bars, vals):
            ax.annotate(f"{v:,}", (b.get_x() + b.get_width() / 2, v), ha="center", va="bottom", fontsize=7.5, color=INK2, xytext=(0, 2), textcoords="offset points")
ax.set_xticks(range(len(sel)), [f"{x} vehicles" for x in xs])
ax.set_ylabel("bytes per map refresh")
ax.set_title("One routine map refresh (synthetic Gaza fleet, client knows the index)")
ax.set_ylim(0, max(int(r["json_gzip"]) for r in sel) * 1.22)
ax.legend(ncol=4, loc="upper left", fontsize=8.5)
save(fig, "size-comparison.png", also_docs=True)

# ---------- 2. Browser simulation ----------
raw_path = RES / "sim-raw.csv"
summary_rows = []
if raw_path.exists():
    raw = list(csv.DictReader(open(raw_path)))
    cell = defaultdict(list)
    for r in raw:
        cell[(r["profile"], r["kind"], int(r["vehicles"]), r["format"])].append(r)

    def col(rows, key):
        return [float(r[key]) for r in rows if r[key] not in ("", None)]

    for (profile, kind, n, fmt), rows in sorted(cell.items()):
        ttu = col(rows, "ttu_ms")
        wire = [float(r["req_bytes"]) + float(r["res_bytes"]) for r in rows if r["req_bytes"] and r["res_bytes"]]
        summary_rows.append({
            "profile": profile, "kind": kind, "vehicles": n, "format": fmt, "runs": len(rows),
            "ttu_median_ms": round(statistics.median(ttu), 1) if ttu else "",
            "ttu_p90_ms": round(pct(ttu, 0.9), 1) if ttu else "",
            "decode_median_ms": round(statistics.median(col(rows, "decode_ms")), 2) if col(rows, "decode_ms") else "",
            "task_median_ms": round(statistics.median(col(rows, "task_ms")), 2) if col(rows, "task_ms") else "",
            "task_p90_ms": round(pct(col(rows, "task_ms"), 0.9), 2) if col(rows, "task_ms") else "",
            "req_bytes_median": round(statistics.median(col(rows, "req_bytes"))) if col(rows, "req_bytes") else "",
            "res_bytes_median": round(statistics.median(col(rows, "res_bytes"))) if col(rows, "res_bytes") else "",
            "body_bytes_median": round(statistics.median(col(rows, "body_bytes"))) if col(rows, "body_bytes") else "",
            "wire_bytes_median": round(statistics.median(wire)) if wire else "",
        })
    keys = list(summary_rows[0].keys())
    with open(RES / "sim-summary.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=keys)
        wr.writeheader()
        wr.writerows(summary_rows)

    S = {(r["profile"], r["kind"], r["vehicles"], r["format"]): r for r in summary_rows}

    # Fig: wire bytes per refresh (Wi-Fi run; bytes do not depend on the profile)
    fig, ax = plt.subplots(figsize=(6.4, 3.4))
    a = [S[("wifi", "refresh", n, "json")]["wire_bytes_median"] for n in COUNTS]
    b = [S[("wifi", "refresh", n, "bin")]["wire_bytes_median"] for n in COUNTS]
    bar_pair(ax, [f"{n} vehicles" for n in COUNTS], a, b)
    for i, (x, y) in enumerate(zip(a, b)):
        ax.annotate(f"{x:,}", (i - 0.2, x), ha="center", va="bottom", fontsize=8, color=INK2, xytext=(0, 2), textcoords="offset points")
        ax.annotate(f"{y:,}", (i + 0.2, y), ha="center", va="bottom", fontsize=8, color=INK2, xytext=(0, 2), textcoords="offset points")
    ax.set_ylim(0, max(a) * 1.2)
    ax.set_ylabel("bytes on the wire per refresh\n(HTTP headers + body, both ways)")
    ax.set_title("Bytes per map refresh, measured at the socket")
    ax.legend(loc="upper left")
    save(fig, "fig-wire-bytes.png", also_docs=True)

    # Fig: time to update, small multiples per vehicle count, median bars + p90 whiskers
    fig, axes = plt.subplots(1, 4, figsize=(11, 3.6), sharey=False)
    for ax, n in zip(axes, COUNTS):
        med_a = [S[(p, "refresh", n, "json")]["ttu_median_ms"] for p in PROFILES]
        med_b = [S[(p, "refresh", n, "bin")]["ttu_median_ms"] for p in PROFILES]
        p90_a = [S[(p, "refresh", n, "json")]["ttu_p90_ms"] for p in PROFILES]
        p90_b = [S[(p, "refresh", n, "bin")]["ttu_p90_ms"] for p in PROFILES]
        bar_pair(ax, ["Wi-Fi", "4G", "3G", "EDGE", "3G+\nloss"], med_a, med_b,
                 [[0] * 5, [max(0, x - m) for x, m in zip(p90_a, med_a)]], [[0] * 5, [max(0, x - m) for x, m in zip(p90_b, med_b)]])
        ax.set_title(f"{n} vehicles")
        ax.tick_params(axis="x", labelsize=7.5)
    axes[0].set_ylabel("ms from request to map updated\n(median, whisker = p90)")
    axes[0].legend(loc="upper left", fontsize=8)
    fig.suptitle("Time to update the map, by network profile (headless Chromium, 4× CPU throttle)", fontsize=11, fontweight="bold", color=INK)
    save(fig, "fig-time-to-update.png", also_docs=True)

    # Fig: CPU (battery proxy): main-thread task time per refresh, median over all profiles
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.4))
    allp = lambda n, fmt, key: statistics.median(col([r for r in raw if r["kind"] == "refresh" and int(r["vehicles"]) == n and r["format"] == fmt], key))
    bar_pair(axes[0], [str(n) for n in COUNTS], [allp(n, "json", "decode_ms") for n in COUNTS], [allp(n, "bin", "decode_ms") for n in COUNTS])
    axes[0].set_title("Parse / decode only")
    axes[0].set_xlabel("vehicles")
    axes[0].set_ylabel("ms (median, 4× throttled CPU)")
    bar_pair(axes[1], [str(n) for n in COUNTS], [allp(n, "json", "task_ms") for n in COUNTS], [allp(n, "bin", "task_ms") for n in COUNTS])
    axes[1].set_title("All main-thread work per refresh")
    axes[1].set_xlabel("vehicles")
    axes[1].legend(loc="upper left", fontsize=8)
    fig.suptitle("CPU per refresh (battery proxy)", fontsize=11, fontweight="bold", color=INK)
    save(fig, "fig-cpu.png", also_docs=True)

    # Fig: uploads — requests/min (synthetic trace) × measured wire bytes per request
    up = list(csv.DictReader(open(RES / "uploads.csv")))
    before, after = up[0], up[1]
    wire_json = S[("wifi", "upload", 0, "json")]["wire_bytes_median"]
    wire_bin = S[("wifi", "upload", 0, "bin")]["wire_bytes_median"]
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.4))
    ax = axes[0]
    labels = ["moving", "parked"]
    bar_pair(ax, labels, [float(before["requests_per_min_moving"]), float(before["requests_per_min_parked"])],
             [float(after["requests_per_min_moving"]), float(after["requests_per_min_parked"])], labels=("every 15 s", "+ standing-still throttle"), colors=("#8a8984", AQUA))
    ax.set_ylim(0, 5.2)
    ax.set_ylabel("requests per minute")
    ax.set_title("Driver uploads (synthetic 2 h trace)")
    ax.legend(loc="upper center", ncol=2, fontsize=8)
    ax = axes[1]
    combos = [("JSON,\nevery 15 s", wire_json * float(before["requests_per_min_parked"]), JSON),
              ("binary,\nevery 15 s", wire_bin * float(before["requests_per_min_parked"]), BIN),
              ("binary +\nthrottle", wire_bin * float(after["requests_per_min_parked"]), BIN)]
    bars = ax.bar([c[0] for c in combos], [c[1] for c in combos], 0.55, color=[c[2] for c in combos])
    for bb, c in zip(bars, combos):
        ax.annotate(f"{c[1]:,.0f} B", (bb.get_x() + bb.get_width() / 2, c[1]), ha="center", va="bottom", fontsize=8, color=INK2, xytext=(0, 2), textcoords="offset points")
    ax.set_ylim(0, combos[0][1] * 1.15)
    ax.set_ylabel("bytes per minute on the wire")
    ax.set_title("Parked driver: headers dominate")
    save(fig, "fig-uploads.png", also_docs=True)

    # Console table for the report
    print("profile,n,json_ttu_med,json_ttu_p90,bin_ttu_med,bin_ttu_p90,json_wire,bin_wire,json_task,bin_task")
    for p in PROFILES:
        for n in COUNTS:
            j, b = S[(p, "refresh", n, "json")], S[(p, "refresh", n, "bin")]
            print(f"{p},{n},{j['ttu_median_ms']},{j['ttu_p90_ms']},{b['ttu_median_ms']},{b['ttu_p90_ms']},{j['wire_bytes_median']},{b['wire_bytes_median']},{j['task_median_ms']},{b['task_median_ms']}")
    for p in PROFILES:
        j, b = S[(p, "upload", 0, "json")], S[(p, "upload", 0, "bin")]
        print(f"upload,{p},{j['ttu_median_ms']},{j['ttu_p90_ms']},{b['ttu_median_ms']},{b['ttu_p90_ms']},{j['wire_bytes_median']},{b['wire_bytes_median']}")
    for p in PROFILES:
        for n in COUNTS:
            j, b = S[(p, "first", n, "json")], S[(p, "first", n, "bin")]
            print(f"first,{p},{n},{j['ttu_median_ms']},{b['ttu_median_ms']},{j['wire_bytes_median']},{b['wire_bytes_median']}")
else:
    print("no bench/results/sim-raw.csv yet: run bench/sim/run-all.sh first")
