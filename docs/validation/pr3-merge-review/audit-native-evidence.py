#!/usr/bin/env python3
"""Recompute the merge review's observations from attached raw JSON; no app writes."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics

HERE = Path(__file__).resolve().parent
LATENCY = HERE.parent / "switch-latency"
PRODUCT = "9dee2cbb8b25f768f81d3b94ec1a7c57ddae55267ae29de459ad00a8d94d3400"


def read(path):
    compressed = path.read_bytes()
    raw = gzip.decompress(compressed) if path.suffix == ".gz" else compressed
    return json.loads(raw), {
        "fileSHA256": hashlib.sha256(compressed).hexdigest(),
        "uncompressedSHA256": hashlib.sha256(raw).hexdigest(),
    }


def file_leaves(layout):
    result = []

    def walk(node, region):
        if isinstance(node, list):
            for child in node:
                walk(child, region)
        elif isinstance(node, dict):
            state = node.get("state", {})
            inner = state.get("state", {}) if isinstance(state, dict) else {}
            if node.get("type") == "leaf" and isinstance(inner, dict) and "file" in inner:
                result.append((region, inner["file"], state.get("type"),
                               bool(node.get("pinned") or state.get("pinned"))))
            else:
                for child in node.values():
                    walk(child, region)

    for region in ("main", "left", "right", "floating"):
        walk(layout.get(region), region)
    return result


def verify_snapshot(snapshot):
    branch = snapshot["branch"]
    assert branch in ("alpha", "beta") and snapshot["journal"] is None
    leaves = file_leaves(snapshot["layout"])
    markdown = [(region, path, pin) for region, path, kind, pin in leaves if kind == "markdown"]
    expected = [("main", f"{branch}-exclusive.md", True), ("main", "shared.md", False),
                ("left", f"sidebar-{branch}.md", True), ("right", f"sidebar-{branch}.md", True)]
    assert sorted(markdown) == sorted(expected), (branch, markdown)
    # Native read-only following panes may also reference the current main note.
    allowed = {f"{branch}-exclusive.md", f"sidebar-{branch}.md", "shared.md"}
    assert all(path in allowed for _, path, _, _ in leaves), leaves
    for workspace, saved in snapshot.get("savedPins", {}).items():
        saved_branch = {"runtime-alpha": "alpha", "runtime-beta": "beta"}[workspace]
        expected_pins = [("main", f"{saved_branch}-exclusive.md"),
                         ("left", f"sidebar-{saved_branch}.md"),
                         ("right", f"sidebar-{saved_branch}.md")]
        assert sorted((leaf["region"], leaf["path"]) for leaf in saved if leaf["pinned"]) == sorted(expected_pins)


def snapshots(value):
    found = []
    if isinstance(value, dict):
        if {"branch", "activeId", "journal", "layout", "views"} <= value.keys():
            verify_snapshot(value)
            found.append(value)
        for child in value.values():
            found.extend(snapshots(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(snapshots(child))
    return found


def stats(samples):
    values = sorted(s["controllerCompleteMs"] - s["selectionMs"] for s in samples)
    for sample in samples:
        measured = sample["controllerCompleteMs"] - sample["selectionMs"]
        assert abs(measured - sample["timingsMs"]["selectionToControllerComplete"]) < 1e-9
    return {"n": len(values), "medianMs": statistics.median(values),
            "p95Ms": values[math.ceil(len(values) * .95) - 1],
            "minimumMs": min(values), "maximumMs": max(values),
            "progressOpened": sum(s["transitionModalOpened"] for s in samples),
            "progressAtFrameOpportunity": sum(s["transitionModalAtFrameOpportunity"] for s in samples)}


result = {"reviewedCommit": "27c7a8d56fa708036248ffcc63120b243703fff4", "historical": {}}
manifest = json.loads((LATENCY / "reports.json").read_text())
for entry in manifest:
    _, hashes = read(LATENCY / entry["file"])
    assert hashes["uncompressedSHA256"] == entry["uncompressedSHA256"], entry["file"]
prior = json.loads((LATENCY / "independent-review/summary.json").read_text())
for name, expected in prior["evidence"].items():
    assert hashlib.sha256((LATENCY / "independent-review" / name).read_bytes()).hexdigest() == expected
result["allHistoricalManifestHashesVerified"] = True
result["historicalInputGuard"] = {}
for name, cancelled, leaf_delta in (("input-before.json", False, 1), ("input-after.json", True, 0)):
    report, hashes = read(LATENCY / "independent-review" / name)
    click = next(event for event in report["events"] if event["type"] == "click")
    assert click["trusted"] and click["defaultPrevented"] is cancelled
    assert not click["progressModalPresent"] and click["atMs"] < 500
    assert len(report["after"]) - len(report["before"]) == leaf_delta
    if cancelled:
        assert report["productBundleSHA256"] == PRODUCT and report["newNativeLeafIds"] == []
    result["historicalInputGuard"][name] = {**hashes, "trustedClickCancelled": cancelled,
                                          "beforeLeaves": len(report["before"]),
                                          "afterLeaves": len(report["after"]),
                                          "productBundleSHA256": report["productBundleSHA256"]}

for name in ("baseline-matched.json.gz", "optimized-matched.json.gz", "independent-review/benchmark-final.json.gz"):
    report, hashes = read(LATENCY / name)
    assert report["status"] == "passed" and report["finalGitStatus"] == ""
    assert not report.get("error") and not report.get("cleanupError")
    assert len(report["samples"]) == 42 and all(s["status"] == "passed" for s in report["samples"])
    for sample in report["samples"]:
        assert sample["documentVisibility"] == "visible" and not sample["nativeSettingsPresent"]
        assert sample["verification"]["branch"] == sample["expectedBranch"]
        assert sample["verification"]["activeId"] == sample["toId"]
        verify_snapshot(sample["verification"])
    result["historical"][name] = {
        **hashes, "runId": report["runId"], "totalCorrectnessSamples": len(report["samples"]),
        "productBundleSHA256": report["environment"]["plugins"]["obsidian-workspaces"]["bundleSHA256"],
        "groups": {scenario: stats([s for s in report["samples"] if s["scenario"] == scenario and s["temperature"] == "measured"])
                   for scenario in ("branch", "same-branch", "unbound")},
    }

fresh, hashes = read(HERE / "quick-switcher-fresh.json.gz")
assert fresh["status"] == "passed" and fresh["finalGitStatus"] == ""
assert not fresh.get("error") and not fresh.get("cleanupError")
assert len(fresh["checks"]) == 10 and all(c["status"] == "passed" for c in fresh["checks"])
assert fresh["checks"][0]["details"]["bundleSHA256"]["obsidian-workspaces"] == PRODUCT
observed = snapshots(fresh)
dirty = next(c for c in fresh["checks"] if c["name"].startswith("dirty native editor"))["details"]
assert dirty["actual"]["activeId"] == "runtime-alpha" and dirty["actual"]["branch"] == "alpha"
calls = dirty["choice"]["controllerCalls"]
assert len(calls) == 1 and calls[0]["status"] == "rejected"
assert "tracked and untracked changes" in calls[0]["error"]["message"]
assert fresh["final"]["activeId"] == "runtime-alpha" and fresh["final"]["branch"] == "alpha"
result["freshNative"] = {**hashes, "runId": fresh["runId"], "startedAt": fresh["startedAt"],
                        "finishedAt": fresh["finishedAt"], "checksPassed": 10,
                        "snapshotsWithCorrectPinsAndNoStaleSourceFileLeaves": len(observed),
                        "bundleSHA256": PRODUCT, "dirtyCheckoutRejected": True,
                        "finalBranch": "alpha", "finalActiveId": "runtime-alpha",
                        "finalJournal": None, "finalGitStatus": ""}
for branch in ("beta", "alpha"):
    physical, hashes = read(HERE / f"physical-{branch}.json")
    assert physical["branch"] == branch and physical["gitStatus"] == ""
    assert physical["bundleSHA256"] == PRODUCT
    verify_snapshot({"branch": branch, "journal": None, "layout": physical["nativeLayout"]})
    result[f"physical-{branch}"] = {**hashes, "recordedAt": physical["recordedAt"],
                                    "branch": branch, "gitStatus": "", "pinsVerified": True}
print(json.dumps(result, indent=2))
