#!/usr/bin/env python3
"""Markdown tables from bench/results/*.csv, for the paper, README and test report.

Usage: python3 bench/tables.py <name>   (sizes | wire | ttu | cpu | upload | readme | first)
"""
import csv
import sys
from pathlib import Path

RES = Path(__file__).resolve().parent / "results"
PROFILES = ["wifi", "4g", "3g", "edge", "lossy"]
LABEL = {"wifi": "Wi-Fi", "4g": "4G", "3g": "3G", "edge": "EDGE (2G)", "lossy": "3G + 3% loss"}
COUNTS = [10, 50, 150, 300]


def summary():
    rows = list(csv.DictReader(open(RES / "sim-summary.csv")))
    return {(r["profile"], r["kind"], int(r["vehicles"]), r["format"]): r for r in rows}


def f0(x):
    return f"{float(x):,.0f}"


def change(a, b):
    a, b = float(a), float(b)
    return f"{(b - a) / a * 100:+.0f}%"


def sizes():
    out = ["| vehicles | JSON | JSON gzip | JSON 5-dp gzip | MsgPack gzip | CBOR gzip | Protobuf gzip | Protobuf tuned | **this format** | JSON gzip ÷ this |",
           "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in csv.DictReader(open(RES / "sizes.csv")):
        out.append(f"| {r['vehicles']} | {f0(r['json_raw'])} | {f0(r['json_gzip'])} | {f0(r['json_rounded_gzip'])} | {f0(r['msgpack_gzip'])} | {f0(r['cbor_gzip'])} | {f0(r['protobuf_naive_gzip'])} | {f0(r['protobuf_tuned'])} | **{f0(r['binary_sent'])}** | {float(r['ratio_json_gzip_over_binary']):.1f}× |")
    return "\n".join(out) + "\n\n*Table 1. Bytes for one routine refresh (synthetic Gaza fleet; gzip level 6).*"


def wire():
    S = summary()
    out = ["| vehicles | JSON body | JSON on wire | binary body | binary on wire | wire change |", "|---:|---:|---:|---:|---:|---:|"]
    for n in COUNTS:
        j, b = S[("wifi", "refresh", n, "json")], S[("wifi", "refresh", n, "bin")]
        out.append(f"| {n} | {f0(j['body_bytes_median'])} | {f0(j['wire_bytes_median'])} | {f0(b['body_bytes_median'])} | {f0(b['wire_bytes_median'])} | {change(j['wire_bytes_median'], b['wire_bytes_median'])} |")
    return "\n".join(out) + "\n\n*Table 2. Median bytes per routine refresh. Wire = request + response, HTTP headers included (≈360–390 B request, ≈220–250 B response headers).*"


def ttu():
    S = summary()
    out = ["| profile | vehicles | JSON median | JSON p90 | binary median | binary p90 | median change |", "|---|---:|---:|---:|---:|---:|---:|"]
    for p in PROFILES:
        for n in COUNTS:
            j, b = S[(p, "refresh", n, "json")], S[(p, "refresh", n, "bin")]
            out.append(f"| {LABEL[p]} | {n} | {f0(j['ttu_median_ms'])} | {f0(j['ttu_p90_ms'])} | {f0(b['ttu_median_ms'])} | {f0(b['ttu_p90_ms'])} | {change(j['ttu_median_ms'], b['ttu_median_ms'])} |")
    return "\n".join(out) + "\n\n*Table 3. Time to update the map (ms), 40 refreshes per cell.*"


def cpu():
    rows = [r for r in csv.DictReader(open(RES / "sim-raw.csv")) if r["kind"] == "refresh"]
    import statistics

    def med(n, fmt, key):
        xs = [float(r[key]) for r in rows if int(r["vehicles"]) == n and r["format"] == fmt and r[key] != ""]
        return statistics.median(xs)

    out = ["| vehicles | JSON parse | binary decode + records | JSON main-thread task | binary main-thread task |", "|---:|---:|---:|---:|---:|"]
    for n in COUNTS:
        out.append(f"| {n} | {med(n, 'json', 'decode_ms'):.2f} | {med(n, 'bin', 'decode_ms'):.2f} | {med(n, 'json', 'task_ms'):.1f} | {med(n, 'bin', 'task_ms'):.1f} |")
    return "\n".join(out) + "\n\n*Table 4. CPU per refresh (ms, medians over all profiles, 4× CPU throttle; browser timer resolution 0.1 ms).*"


def upload():
    S = summary()
    out = ["| profile | JSON exchange (B) | binary exchange (B) | JSON median / p90 (ms) | binary median / p90 (ms) |", "|---|---:|---:|---:|---:|"]
    for p in PROFILES:
        j, b = S[(p, "upload", 0, "json")], S[(p, "upload", 0, "bin")]
        out.append(f"| {LABEL[p]} | {f0(j['wire_bytes_median'])} | {f0(b['wire_bytes_median'])} | {f0(j['ttu_median_ms'])} / {f0(j['ttu_p90_ms'])} | {f0(b['ttu_median_ms'])} / {f0(b['ttu_p90_ms'])} |")
    return "\n".join(out) + "\n\n*Table 5. One upload exchange (request + response, headers included) and its round-trip time.*"


def first():
    S = summary()
    out = ["| profile | vehicles | JSON first sync (B / ms) | binary first sync (B / ms) |", "|---|---:|---:|---:|"]
    for p in PROFILES:
        for n in COUNTS:
            j, b = S[(p, "first", n, "json")], S[(p, "first", n, "bin")]
            out.append(f"| {LABEL[p]} | {n} | {f0(j['wire_bytes_median'])} / {f0(j['ttu_median_ms'])} | {f0(b['wire_bytes_median'])} / {f0(b['ttu_median_ms'])} |")
    return "\n".join(out)


def readme():
    S = summary()
    out = ["| profile | 50 vehicles: JSON → binary (median ms) | 300 vehicles: JSON → binary (median ms) | p90 at 300 | bytes per refresh at 300 (wire) |", "|---|---:|---:|---:|---:|"]
    for p in PROFILES:
        j50, b50 = S[(p, "refresh", 50, "json")], S[(p, "refresh", 50, "bin")]
        j3, b3 = S[(p, "refresh", 300, "json")], S[(p, "refresh", 300, "bin")]
        out.append(f"| {LABEL[p]} | {f0(j50['ttu_median_ms'])} → {f0(b50['ttu_median_ms'])} | {f0(j3['ttu_median_ms'])} → **{f0(b3['ttu_median_ms'])}** | {f0(j3['ttu_p90_ms'])} → {f0(b3['ttu_p90_ms'])} | {f0(j3['wire_bytes_median'])} → {f0(b3['wire_bytes_median'])} |")
    return "\n".join(out)


print(globals()[sys.argv[1]]())
