# Independent switch-performance review

**Review date:** 2026-11-14. **Outcome:** the corrected candidate passed the reviewed correctness checks, but the requested near-instant, reliably modal-free branch-switching objective remains unmet. Keep PR #3 in draft for performance acceptance.

This review was performed by a separate AI subagent that did not author the production changes. It began with the adopted specification/ADRs and code diff before the implementation author's performance conclusions were supplied. The reviewer then owned the native desktop exclusively for the observations below. This is independent subagent review, not approval by a separate GitHub user or a human reviewer.

## Reviewed identity

| Item | Identity |
| --- | --- |
| Base commit | `f061347313c031d03b1491a9072717c7ba80b15d` |
| Reviewed candidate commit | `bb208bf6f12fc5d830bbb720b3bd5c9066c2bad3` |
| Final installed Workspaces bundle SHA-256 | `9dee2cbb8b25f768f81d3b94ec1a7c57ddae55267ae29de459ad00a8d94d3400` |
| Pre-correction input-test bundle SHA-256 | `e2f1c9ec72f65500957124e5692bf6cc549d2beb2d71e695abb894c348a5f701` |
| Host | Native Linux Obsidian 1.15.1 |
| Installed Git provider | Obsidian Git 2.43.0 |
| Installed workspace chooser | Quick Switcher++ 6.3.0 |
| Final timing probe SHA-256 | `fb7f9742e038b4926d3d6bc770c1cbd047588cb602a97b97b9021a9c56b52f3b` |

The candidate was copied into the disposable reviewer vault while Workspaces was disabled, then enabled through the native settings UI. Both final native reports independently record the installed product hash above. The benchmark records the reviewed candidate commit and an empty source worktree status. Subsequent evidence-only commits do not change that tested production identity.

## Findings

### Corrected: delayed progress exposed click-based native actions

The intermediate implementation delayed the visible modal by 500 ms while its document guard only canceled `keydown`, `beforeinput`, `pointerdown`, `drop`, and `paste`. Canceling `pointerdown` does not cancel later click/auxclick/contextmenu activation. Native Obsidian tab and new-tab handlers use `click`, so they could mutate the live layout during the protected interval. The [Pointer Events specification](https://www.w3.org/TR/pointerevents3/) defines this distinction; the issue was also reproduced in the actual application.

The independent [input probe](../../../../tests/obsidian/independent-input-probe.cjs) invokes the actual `controller.host.block()` method. A trusted pointer hover over the native new-tab plus starts the guard; the immediately following trusted desktop click tests the still-visible control. The probe does not replace a native input handler, production method, controller, or Git implementation. This isolates the input guard used by transitions; it does not perform a checkout during the click test.

| Native observation | Before correction | Corrected candidate |
| --- | --- | --- |
| Trusted `pointerdown` | Canceled at 99.014 ms | Canceled at 94.326 ms |
| Trusted `click` | **Not canceled** at 111.002 ms | Canceled at 107.248 ms |
| Native leaf count | **15 → 16**, new native tab | 15 → 15, no new tab |
| Progress modal during events | Absent | Absent |
| Evidence | [input-before.json](input-before.json) | [input-after.json](input-after.json) |

The author corrected the guard to capture `click`, `dblclick`, `auxclick`, and `contextmenu`, made release idempotent, and subscribed to the public `window-open` event to protect new popout documents. The repeated trusted click verifies the main-window regression is fixed. Newly opened popouts are covered by source inspection and the focused host regression test, not by a separate native popout observation in this review.

An initial diagnostic attempt used an observer callback that inadvertently returned `Array.push()` to `iterateAllLeaves`, which short-circuits traversal. It was corrected before the two evidence files above were collected. That initial attempt is excluded from these results.

### Open: the requested performance acceptance is not satisfied

The reviewer ran the complete manual-start timing fixture on the corrected candidate, with Settings closed, the document visible, and heavy implementation-author commands paused. **All 42 native transitions passed correctness verification.** Of those, 32 are the measured samples below; the remainder are the first switch after arming, warmups, and cleanup.

Times are actual Quick Switcher++ selection to settlement of the unchanged `controller.activate` promise, in milliseconds. Medians use the midpoint of the two middle observations; p95 uses nearest rank.

| Scenario | Measured n | Median | p95 | Range | Progress opened | Progress present at a frame opportunity |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Branch change | 20 | 563.472 | 680.750 | 467.668–685.571 | **14/20** | **11/20** |
| Same-branch bound layout | 6 | 233.486 | 575.542 | 184.813–575.542 | 1/6 | 1/6 |
| Unbound layout | 6 | 151.955 | 182.484 | 135.795–182.484 | 0/6 | 0/6 |

Evidence: [complete final timing report](benchmark-final.json.gz), [independently recomputed summary](summary.json).

The observed branch latency and visible progress instances prevent accepting the requested near-instant, reliably modal-free behavior. The delayed modal is functioning as implemented; the unresolved issue is time spent in the actual protected operation. Increasing the visibility delay would not establish the requested latency improvement.

The implementation author's matched reports were also read and their statistics recomputed: the base had median 1426.540 ms / p95 1679.286 ms, while the preceding candidate had 522.178 ms / 735.477 ms and progress in 10/20 branch switches. Those reports support a substantial partial improvement and the same remaining acceptance problem. They are separate runs, and this review does not substitute an earlier faster exploratory run or combine samples from different bundles into a final claim.

### No further blocking correctness defect found in the reviewed diff

Review and targeted execution covered the batched Git reads, exact ref handling, source-tree/index target reconstruction, ignored-path and protected-runtime safeguards, fresh validation after view unload, concurrent unload/hydration draining, event-driven readiness, two-write journal boundary, restart recovery, and presentation-refresh queue lifetime.

The final native runs retained actual branch identity, branch-exclusive main/sidebar pins, current editor contents, source-only file removal, committed active IDs, and a cleared journal. This conclusion is limited to the observed fixture and tests, rather than a general guarantee for other host versions or arbitrary editable plugins.

## Final native safety regression

The reviewer independently armed and ran the existing native Quick Switcher++ regression probe on the exact corrected product bundle. Its verifier and timing boundaries were inspected during code review. All **10 scenario checks passed**, including:

- Actual Quick Switcher++ Enter activation in both branch directions, with branch-exclusive main and both-sidebar pins and the same-path `shared.md` contents checked.
- The actual save-and-switch key handler routing through one `saveAndActivate` operation.
- Workspaces Mode with core Workspaces disabled, and duplicate display names selecting distinct stable IDs.
- A pending native Markdown editor edit blocking checkout before target layout or journal drift; the pending text was flushed and preserved on Alpha.
- A clean roundtrip after the rejected dirty switch.

The fixture ended on actual `alpha`, with `runtime-alpha` active, no recovery journal, and an empty Git porcelain status. The probe restored its fixture-only core catalog changes and removed its temporary duplicate.

Evidence: [native safety and Quick Switcher++ report](quick-switcher-final.json.gz). The dirty rejection is the check named `dirty native editor rejects Q++ checkout without target layout or journal drift`.

These checks invoke the native chooser's registered methods and the installed plugins. They are not all trusted physical key events. The separate input-guard experiment above records trusted native pointer events explicitly.

## Independent automated verification

The reviewer ran the following against the candidate commit after native timing had finished:

```sh
node --import tsx --test \
  tests/integration/git-adapter.test.ts \
  tests/integration/workspace-switch.test.ts \
  tests/unit/controller.test.ts \
  tests/unit/layout-files.test.ts \
  tests/unit/obsidian-layout.test.ts \
  tests/unit/vault-reconcile.test.ts
```

Result: **218 tests passed, 0 failed, 0 skipped**. The integration set uses real Git and includes actual process-exit journal/restart cases; its host stubs do not replace the separate native evidence above. The focused gate is recorded in [focused-tests.txt](focused-tests.txt). The implementation-author full 272-test gate is not counted as an independently rerun full gate here.

## Reproduction

For native latency, use the disposable fixture described in `docs/development.md`, disable the benchmark before rearming, and install the intended product bundle while Workspaces is disabled:

```sh
node scripts/prepare-switch-benchmark.mjs /absolute/disposable/vault \
  --phase independent-final \
  --result /absolute/reports/benchmark-final.json \
  --manual-start
```

Enable the benchmark in the native app, close Settings, then run **Workspaces Switch Latency Benchmark: Run switch benchmark** from the visible command palette. The command runs the actual Quick Switcher++ selection route and records the installed hashes. Leave the app visible and avoid competing test/build work until it finishes.

For the input regression, install `tests/obsidian/independent-input-probe.cjs` as `main.js` in a test-only plugin directory named `workspaces-independent-input-review` in that same disposable vault. Use the following manifest and data:

```json
{
  "id": "workspaces-independent-input-review",
  "name": "Workspaces Independent Input Review",
  "version": "0.1.0",
  "minAppVersion": "1.15.0",
  "description": "Test-only native input regression probe.",
  "author": "Independent reviewer",
  "isDesktopOnly": true
}
```

```json
{
  "vaultPath": "/absolute/disposable/vault",
  "phase": "after-click-fix",
  "resultFile": "/absolute/reports/input-after.json"
}
```

Keep the result outside the vault. Enable the test plugin, run **Arm independent native input guard**, then move the desktop pointer onto the main tab group's plus and click immediately. The hover begins a maximum 450 ms real input guard; native events and the complete before/after leaf inventory are written to the report. On the affected intermediate build the click opens a native empty tab; close that test tab before the next run. On the corrected candidate no tab should open. The probe's source SHA-256 used for both attached observations is recorded in `summary.json`.

## Evidence limits

The native environment is one small local Linux fixture with three saved workspaces and the specified plugin versions. This review does not establish large-vault scaling, other operating systems, mobile, unsupported editable plugin views, or behavior on host versions other than 1.15.1. The first timed switch is cold only relative to probe arming; it is not an OS-cache or process-cold measurement. The next `requestAnimationFrame` timestamp is a rendering opportunity, not proof of scanout. Correctness checks run after the measured completion/frame boundaries without repairing the target.

The final verdict is therefore **correctness checks passed after the input fix; performance acceptance remains open**. The evidence supports keeping the work as a draft partial improvement, not declaring the user's near-instant/no-normal-modal objective complete.
