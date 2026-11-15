#!/usr/bin/env python3
"""Recompute the documented Linux comparison; this is not the Mac closure gate."""

import collections
import gzip
import hashlib
import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPORTS = [
    ("small", "s1", "baseline", 1),
    ("small", "s1", "candidate", 2),
    ("small", "s2", "candidate", 1),
    ("small", "s2", "baseline", 2),
    ("scale", "s1", "baseline", 1),
    ("scale", "s1", "candidate", 2),
]


def distribution(values):
    values = sorted(value for value in values if isinstance(value, (int, float)) and math.isfinite(value))
    if not values:
        return None
    count = len(values)
    return {
        "n": count,
        "median": round((values[(count - 1) // 2] + values[count // 2]) / 2, 3),
        "p95": round(values[math.ceil(count * 0.95) - 1], 3),
        "p99": round(values[math.ceil(count * 0.99) - 1], 3),
        "min": round(values[0], 3),
        "max": round(values[-1], 3),
    }


def summarize(samples):
    return {
        "selectionToCompleteMs": distribution(sample["timingsMs"]["selectionToControllerComplete"] for sample in samples),
        "selectionToNextFrameMs": distribution(sample["timingsMs"]["selectionToNextFrame"] for sample in samples),
        "selectionToInputReleaseMs": distribution(sample["timingsMs"]["selectionToInputRelease"] for sample in samples),
        "endpointCaptureMs": distribution(sample["timingsMs"]["endpointCapture"] for sample in samples),
        "modalOpenings": sum(bool(sample["transitionModalOpened"]) for sample in samples),
        "endpointPasses": sum(sample.get("endpointValidation", {}).get("status") == "passed" for sample in samples),
        "rawGitCalls": dict(sorted(collections.Counter(sample["rawGitCommandCount"] for sample in samples).items())),
    }


result = {"purpose": "Descriptive Linux evidence only; not local Mac acceptance", "reports": [], "pooled": {}}
pooled = collections.defaultdict(list)
for profile, session, role, order in REPORTS:
    filename = f"final-{profile}-{session}-{role}.json.gz"
    compressed = (ROOT / "reports" / filename).read_bytes()
    raw = gzip.decompress(compressed)
    report = json.loads(raw)
    samples = report["samples"]
    assert report["status"] == "passed" and report["recorder"]["complete"]
    assert all(sample["status"] == "passed" for sample in samples)
    measured = [sample for sample in samples if sample["temperature"] == "measured"]
    branch = [sample for sample in measured if sample["scenario"] == "branch"]
    assert len(branch) == 100
    environment = report["environment"]
    item = {
        "file": filename,
        "profile": profile,
        "session": session,
        "role": role,
        "order": order,
        "rawSHA256": hashlib.sha256(raw).hexdigest(),
        "gzipSHA256": hashlib.sha256(compressed).hexdigest(),
        "productSourceCommit": environment["productSourceCommit"],
        "plugins": environment["plugins"],
        "nativeSession": environment["nativeSession"],
        "samples": len(samples),
        "allSampleModalOpenings": sum(bool(sample["transitionModalOpened"]) for sample in samples),
        "allSampleEndpointPasses": sum(sample.get("endpointValidation", {}).get("status") == "passed" for sample in samples),
        "groups": {},
        "directions": {},
        "firstSwitches": [
            {"scenario": sample["scenario"], "direction": sample["direction"],
             "timingsMs": sample["timingsMs"], "modalOpened": sample["transitionModalOpened"]}
            for sample in samples if sample["temperature"] == "cold"
        ],
        "branchQuartileCompletionMs": [distribution(sample["timingsMs"]["selectionToControllerComplete"] for sample in branch[offset:offset + 25]) for offset in range(0, 100, 25)],
        "branchRssMiB": {
            "first": round(branch[0]["memory"]["beforeTiming"]["rss"] / 2**20, 3),
            "last": round(branch[-1]["memory"]["beforeTiming"]["rss"] / 2**20, 3),
        },
        "recorderCosts": report["recorder"]["costs"],
        "recorderSampleCostsMs": {
            "serialization": distribution(sample["recorderObservation"]["serializationMs"] for sample in samples),
            "append": distribution(sample["recorderObservation"]["appendMs"] for sample in samples),
        },
    }
    for scenario in ("branch", "same-branch", "unbound"):
        group = [sample for sample in measured if sample["scenario"] == scenario]
        item["groups"][scenario] = summarize(group)
        pooled[(profile, role, scenario)].extend(group)
    for direction in ("alpha->beta", "beta->alpha"):
        item["directions"][direction] = summarize([sample for sample in branch if sample["direction"] == direction])
    result["reports"].append(item)

for (profile, role, scenario), samples in pooled.items():
    result["pooled"][f"{profile}/{role}/{scenario}"] = summarize(samples)
print(json.dumps(result, indent=2))
