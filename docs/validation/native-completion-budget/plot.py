#!/usr/bin/env python3
"""Optional report figure: requires matplotlib; no dependency on the product build."""

import gzip
import json
import statistics
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parent
pairs = [
    ("Small S1: baseline then candidate", "small-s1", "baseline", "candidate"),
    ("Small S2: candidate then baseline", "small-s2", "candidate", "baseline"),
    ("Larger S1: baseline then candidate", "scale-s1", "baseline", "candidate"),
]
colors = {"baseline": "#3268a8", "candidate": "#bc5a16"}
plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(2, 3, figsize=(14, 7.6), sharex=True, sharey="row")
for col, (title, suffix, first, second) in enumerate(pairs):
    for role in (first, second):
        report = json.loads(gzip.decompress((root / "reports" / f"final-{suffix}-{role}.json.gz").read_bytes()))
        samples = [s for s in report["samples"] if s["scenario"] == "branch" and s["temperature"] == "measured"]
        assert len(samples) == 100
        elapsed = [s["timingsMs"]["selectionToControllerComplete"] for s in samples]
        rss = [s["memory"]["beforeTiming"]["rss"] / 2**20 for s in samples]
        label = f"{role.capitalize()} ({'first' if role == first else 'second'})"
        axes[0, col].scatter(range(1, 101), elapsed, s=11, color=colors[role], alpha=0.42, linewidths=0)
        axes[0, col].plot([13, 38, 63, 88], [statistics.median(elapsed[i:i + 25]) for i in range(0, 100, 25)],
                          color=colors[role], linewidth=2.3, marker="o", markersize=4, label=label)
        axes[1, col].plot(range(1, 101), rss, color=colors[role], linewidth=1.6)
    axes[0, col].set_title(title, fontsize=11, pad=10)
    axes[0, col].legend(loc="upper left", fontsize=9, frameon=False)
    axes[1, col].set_xlabel("Measured branch switch within each report")
    for row in (0, 1):
        axes[row, col].grid(axis="y", color="#dddddd", linewidth=0.6)
        axes[row, col].set_axisbelow(True)
        axes[row, col].set_xlim(0, 101)
axes[0, 0].set_ylabel("Selection to completion (ms)")
axes[1, 0].set_ylabel("Renderer RSS before timing (MiB)")
axes[0, 0].set_ylim(0, 1200)
axes[1, 0].set_ylim(150, 1200)
fig.suptitle("The later report is slower in each paired renderer session", fontsize=16, y=0.98)
fig.text(0.5, 0.935, "Dots: every measured branch switch. Upper lines: medians of successive blocks of 25.", ha="center", fontsize=10)
fig.text(0.5, 0.025, "Reports share a renderer within each pair; pairs use different processes. Memory correlation does not establish causation.",
         ha="center", fontsize=9, color="#444444")
fig.subplots_adjust(top=0.87, bottom=0.12, left=0.065, right=0.985, hspace=0.18, wspace=0.13)
fig.savefig(root / "session-effects.png", dpi=150, facecolor="white")
plt.close(fig)
