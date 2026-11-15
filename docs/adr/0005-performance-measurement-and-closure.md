# ADR 0005 — Performance measurement and closure

**Status:** Accepted

**Date:** 2026-11-15

## Context

The performance objective is near-instant workspace and branch activation with no progress modal during normal successful switches. A small Linux fixture, an earlier fast exploratory run, or a delayed indicator cannot establish that behavior on the user's Mac. Completion must include the requested native notes and pins, current file contents, final branch validation, and durable active workspace state.

## Decision

Measure the actual Quick Switcher++ command and selection route in native Obsidian with the installed Obsidian Git plugin. Preserve the production controller's promise and input-release callback. Measure selection through settlement of that original promise, including the provider repository scope. Record input release, the next rendering opportunity, modal openings and the first switch separately. A frame callback is not a physical display measurement.

Capture an immutable synchronous snapshot at controller completion before awaiting a frame, a Git query or an independent verifier. It records native layout, active leaf, every file editor's content and deferred state, input ownership, visible identifiers, active workspace and journal. Independently validate that captured state afterward against the target and disk/Git evidence. Verification must not repair views or grant an incomplete operation additional settling time.

The performance budget for normal measured branch and layout switches is median at most 100 ms, p95 at most 200 ms and p99 at most 300 ms, with zero progress openings. The first switch is reported separately and must finish within the unchanged 500 ms progress threshold without a modal. These are acceptance requirements, not claims about current performance.

Use normal-mode timing for acceptance and separate diagnostic runs for attribution. Diagnostic wrappers, CPU profiling and periodic report writes perturb elapsed time. Never combine nested spans or add component medians to claim an end-to-end total. Preserve all samples, both directions, outliers, raw reports and exact installed artifact hashes.

Keep recording work linear in the number of samples. Append each completed raw sample once to a run-specific journal, write only compact progress during the run, and stream the final report after timing. Do not repeatedly serialize the entire growing report or retain its detailed samples in the renderer. Keep failed attempts and incomplete journals, and require complete recorder evidence for acceptance. Observe process memory outside the measured interval; do not force garbage collection or add artificial settling delays to make a run pass.

The local closure gate requires real Darwin evidence for both the small deterministic fixture and a declared representative generated workload. Each scope uses three independent paired baseline/candidate sessions, with at least 100 alternating branch switches and 20 controls each for same-branch and unbound activation in each report. Record the native app session, host and plugin versions, workload counts, candidate and baseline bundle identities and identical benchmark code. A fresh candidate Quick Switcher++ safety report is also required. Report both individual-session and pooled statistics; a favorable pooled average cannot hide a failing session.

Both roles in a pair share one native session and renderer process. Independent pairs require a new native session and a different renderer process ID; reloading the application page alone may retain the process and its resident memory. Close and relaunch Obsidian when needed. This establishes process independence, not cold operating-system or filesystem caches.

Generated workload parameters scale tracked-file count and branch-change volume without copying personal notes. The local agent must record whether file counts, change volume and open main/sidebar leaf counts cover the user's normal workload. A small-fixture pass is only evidence for that fixture. The runbook and manifest specify how to record the representative scope and its limits.

The gate fails closed for missing evidence, wrong platforms, mismatched artifacts, reused sessions, inadequate samples, diagnostic runs, incorrect completion snapshots, failed safety checks or exceeded budgets. It produces a machine-readable report and a nonzero exit status when blocked. It does not close GitHub issues or grant approval by itself.

Keep the performance issue open until the final report, raw evidence, artifact identities, local workload declaration and independent review are attached and every required gate passes. A partial optimization may be reviewed and merged while the issue remains open. Such a PR must reference the issue without an automatic closing directive.

Retain the safety and recovery contract from ADRs 0003 and 0004. Performance changes cannot remove the post-unload checkout safeguard, carry source editable buffers across checkout, accept stale cached text, defer hidden pinned notes beyond completion or remove either durable state boundary. Provider execution remains through the installed Obsidian Git integration unless a separately validated capability is adopted.

## Consequences

Performance becomes a reproducible acceptance decision tied to a product build and workload. Linux validation supplies useful implementation evidence and regression detection, while the Mac gate establishes the required local result. A failed gate leaves an actionable report instead of an unsupported completion claim.

See the [local Mac runbook](../performance/local-mac-closure.md), [closure manifest](../performance/closure-manifest.example.json) and [closure evaluator](../../scripts/check-switch-performance.mjs).
