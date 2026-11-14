# Native switch latency validation

Native Linux evidence captured on **2026-11-14**. The [independent review of the final build](independent-review/README.md) measured **563.472 ms median / 680.750 ms p95**, with progress opening in **14/20 measured branch switches**. Its 42 native transitions and 10 separate Quick Switcher++ safety scenarios passed. **The near-instant and reliably modal-free objectives are not met; this is a partial performance improvement, not completion of those objectives.**

The implementation-author matched normal runs reduced branch-switch median latency from **1426.540 ms to 522.178 ms**, with candidate p95 **735.477 ms** and progress in **10/20 measured branch switches**. Both matched runs passed 42/42 post-transition correctness checks and restored clean Alpha. See the [matched baseline](baseline-matched.json.gz) and [candidate](optimized-matched.json.gz). That performance checkpoint preceded the input-guard correction; the independent review records the exact corrected bundle and separate results.

The matched and exploratory measurements below were collected by implementation authors using an independent state/content verifier. The [separate subagent review](independent-review/README.md) independently inspected the changes, reproduced and retested the delayed-modal input bug with trusted native clicks, and ran the final native and focused automated gates. Complete samples, directions, spans, environment versions, and installed bundle hashes are retained in the compressed reports. [reports.json](reports.json) records author archive identities and original JSON hashes; the review has its own [evidence summary](independent-review/summary.json).

The [Git process census](git-process-census.md) accounts for every observed process in the final diagnostic samples, distinguishes recorded arguments from source-supported inference, and identifies the remaining opportunities to combine work without reusing stale state.

A [fresh blind merge review](../pr3-merge-review/README.md) independently reran the complete repository gate, installed the matching build in Linux Obsidian, repeated the native safety scenarios, and completed a physical command-palette roundtrip. It found no material correctness blocker for merging this partial improvement. The performance measurements and unmet objective above remain unchanged.

## Environment and measurement

- Obsidian **1.15.1**, Linux x64; Electron **43.8.9**, embedded Node **24.22.1**.
- Installed Obsidian Git **2.43.0** and Quick Switcher++ **6.3.0**.
- Disposable `reviewer-vault`, existing `alpha`/`beta` branches, no remotes, clean `alpha` start, `runtime-alpha` active, no recovery journal. Control state is outside the vault.
- Branch-exclusive main/sidebar notes and branch-dependent contents at `shared.md`; pinned main and sidebar editors are verified after every sample.

The [native benchmark](../../../tests/obsidian/switch-benchmark.cjs) invokes the actual registered Quick Switcher++ Workspaces command and chooser Enter path. Its primary clock runs from chooser selection to settlement of the original controller promise. Command/chooser latency and the next animation-frame callback are recorded separately. A frame callback indicates a rendering opportunity, not physical display scanout.

Normal runs contain a first switch, three branch warmups, **20 measured alternating branch switches**, and **six measured same-branch and six measured unbound layout switches**, with their own warmups and cleanup. Reports retain 42 verified transitions. The first switch is probe-cold, not process/OS-cache cold; existing starting editors are hydrated before timing, without a setup activation. No human decision time is simulated.

After timing, the [shared native verifier](../../../tests/obsidian/quick-switcher-probe.cjs) checks actual Git branch, journal/active identity, disk bytes, the Vault index, active note, every matching Markdown editor's hydration/content, main/sidebar pins, and status. Current text is verified through the loaded Markdown buffers; this verifier does not independently call `vault.cachedRead()`. Native backlinks, outgoing links, and outline may follow a file without exposing text-editor contents; raw layouts retain those views for review. The verifier checks required pin presence rather than an independent complete-layout equality comparison. Verification never repairs target views. Later probe revisions additionally assert the independent Git branch label; installed probe hashes identify these revisions.

Median is the midpoint of the two middle observations for even sample counts; p95 uses nearest rank. Full direction-specific statistics and individual values remain in each report.

## Exploratory runs

These seven earlier runs are retained as exploration history; use the matched comparison below for the principal result. Times are **selection to controller completion**, in milliseconds. Progress counts refer to transition-progress modals among the 20 measured branch switches, not the chooser itself. All normal runs passed 42/42 transitions; each deep run passed 4/4.

| Report | Product SHA-256 prefix | Condition | Measured branch median | p95 | Progress modals |
| --- | --- | --- | ---: | ---: | ---: |
| [Baseline](baseline.json.gz) | `62a226c4` | Settings open | 1283.308 | 1440.156 | 20/20 |
| [First optimization](optimized-first.json.gz) | `8c8a1cb1` | Settings open | 609.565 | 734.734 | 20/20 |
| [Two durable commits](optimized-journal.json.gz) | `a4eb2b62` | Settings open | 605.864 | 700.886 | 19/20 |
| [Journal-build deep trace](optimized-deep-native.json.gz) | `a4eb2b62` | Settings closed; diagnostic | — | — | — |
| [Batched reads and native reconciliation](optimized-native-reconcile.json.gz) | `4fc6dbf9` | Settings closed | 341.024 | 412.922 | 0/20 |
| [Candidate deep trace](candidate-deep.json.gz) | `4fc6dbf9` | Settings closed; diagnostic | — | — | — |
| [Identity checkout and presentation overlap](optimized-overlap.json.gz) | `e2f1c9ec` | Settings closed | 452.328 | 522.236 | 0/20 |

The first three runs were observed with Settings open. Their historical UI condition must not be inferred from absent later probe fields. Subsequent runs used a manual command with Settings closed. The **341 ms and 452 ms results are different runs of different builds**, with changed observation code and substantial scheduling variation; they do not isolate the effect of presentation overlap. They are not a matched regression/improvement estimate. No speedup percentage across those conditions is claimed. Their zero-modal observations do not override the later matched candidate's **10/20** progress openings.

The same-branch and unbound controls help identify layout/storage costs, but their six measured samples are small. An observed unbound median around 130 ms describes this implementation's full native layout workload; it is not a lower bound for every possible implementation:

| Normal run | Same-branch median / p95 | Unbound median / p95 |
| --- | ---: | ---: |
| Baseline | 258.551 / 334.810 | 184.210 / 427.577 |
| First optimization | 207.578 / 262.212 | 159.355 / 222.071 |
| Two durable commits | 216.260 / 257.472 | 122.966 / 144.798 |
| Native reconciliation | 192.531 / 239.421 | 131.142 / 247.082 |
| Presentation overlap | 217.413 / 254.984 | 129.322 / 339.940 |

## Matched performance comparison

Both captures used the same latest probe, the same disposable fixture and counts, manual start, Settings closed, and visible application state throughout. They were separate sequential runs, not randomized repeated trials, so they establish the observed improvement under these matched settings rather than a universal speed guarantee. The original JSON bytes are preserved unchanged with deterministic gzip.

| Identity | Baseline | Candidate |
| --- | --- | --- |
| Report | [baseline-matched.json.gz](baseline-matched.json.gz) | [optimized-matched.json.gz](optimized-matched.json.gz) |
| Start UTC | 03:37:49.698 | 03:38:59.824 |
| Product SHA-256 | `62a226c43d5a9f635c04edd6f0ef92fab572c103ad7bea3e09f53966cc48a0d8` | `e2f1c9ec72f65500957124e5692bf6cc549d2beb2d71e695abb894c348a5f701` |
| Probe SHA-256, both runs | `fb7f9742e038b4926d3d6bc770c1cbd047588cb602a97b97b9021a9c56b52f3b` | Same |
| Verified transitions / final state | 42/42; clean Alpha; `runtime-alpha`; null journal | 42/42; clean Alpha; `runtime-alpha`; null journal |

The measured branch median fell by **904.362 ms (63.4%)**. The slower candidate samples and progress observations remain material:

| Selection to completion, ms | n per build | Baseline median / p95 | Candidate median / p95 | Baseline min–max | Candidate min–max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Branch switches, both directions | 20 | 1426.540 / 1679.286 | 522.178 / 735.477 | 1136.952–1858.174 | 440.634–765.442 |
| Alpha → Beta | 10 | 1411.687 / 1679.286 | 494.447 / 735.477 | 1136.952–1679.286 | 453.377–735.477 |
| Beta → Alpha | 10 | 1426.540 / 1858.174 | 535.483 / 765.442 | 1176.589–1858.174 | 440.634–765.442 |
| Same-branch layout control | 6 | 436.696 / 512.104 | 220.660 / 253.804 | 289.040–512.104 | 183.995–253.804 |
| Unbound layout control | 6 | 232.639 / 375.362 | 135.479 / 199.942 | 136.924–375.362 | 125.168–199.942 |

Branch progress opened **20/20** times in the baseline and **10/20** in the candidate; it was observed connected/visible at an animation-frame opportunity **20/20** and **9/20**, respectively. Same-branch and unbound controls opened progress **6/6 each** in the baseline and **0/6 each** in the candidate. Selection-to-next-frame branch median/p95 was **1433.854/1681.865 ms** versus **526.987/740.284 ms**. The probe-cold first switch was **1492.877 ms** versus **666.480 ms**, and both opened progress.

### Matched normal-run factor attribution

The following outer-stage statistics come from the [analysis utility](../../../scripts/analyze-switch-benchmark.mjs), using all 20 measured branch switches. Presentation contributes only its interval outside the other listed stages. Component medians/p95s must not be summed to reconstruct a median/p95 total.

| Stage, ms | Baseline median / p95 | Candidate median / p95 |
| --- | ---: | ---: |
| Checkout safeguards | 931.382 / 1122.845 | 191.919 / 266.596 |
| Repository identity/inspection outside safeguards | 171.907 / 232.067 | 76.275 / 156.615 |
| Native layout restoration | 104.630 / 160.387 | 91.125 / 172.466 |
| Vault readiness | 9.992 / 106.835 | 68.605 / 94.127 |
| Actual provider checkout | 18.193 / 29.608 | 18.878 / 41.344 |
| Durable state writes | 65.117 / 102.836 | 16.536 / 24.101 |
| Editor unload | 21.588 / 34.628 | 13.104 / 19.289 |
| Presentation outside other stages | 48.877 / 89.648 | 14.598 / 21.839 |
| Editor flush | 0.025 / 0.099 | 0.021 / 0.053 |
| Other controller work and queue wait | 19.523 / 27.323 | 12.115 / 17.610 |

Observed raw Git request count is **69 per baseline branch switch and 20 per candidate switch**; this normal-mode counter is not an operating-system subprocess count. Readiness's higher median does not mean more total work by itself: earlier work used to consume time before readiness started, while provider presentation now overlaps it. The final deep capture below exposes actual contention inside that interval. The control's roughly 135 ms unbound median remains an observed full-layout workload, not proof of a universal lower bound.

These hashes identify the measured performance checkpoint. Later fixes or independent review must record their own installed bundle identity rather than silently inheriting this timing claim.

## What the deep traces establish

Deep tracing is **diagnostic only**: each capture contains one first switch, one warmup, and two measured switches. Wrappers, bounded progress writes, and timer observations perturb execution. No CPU profile was enabled. Synchronous ancestry is recorded directly; associations across asynchronous boundaries are labeled inference or temporal overlap. Process events are renderer-observed delivery times, not kernel CPU measurements.

The [analysis utility](../../../scripts/analyze-switch-benchmark.mjs) selects outer stages and uses interval unions for presentation overlap. Raw Git, filesystem, leaf, and controller spans are nested; adding them all would exceed elapsed time. Averages or medians of component distributions also need not sum to a median total.

### Final performance-checkpoint trace

[optimized-final-deep.json.gz](optimized-final-deep.json.gz), captured at **03:41:04.758 UTC**, uses the same `e2f1c9ec…` product and `fb7f9742…` probe as the matched candidate. All four switches passed and restored clean Alpha. The two measured diagnostic switches took **738.334 ms Alpha→Beta** and **685.829 ms Beta→Alpha**, with progress in both. They explain contributing intervals and are not another latency distribution.

| Observed detail | Alpha → Beta | Beta → Alpha |
| --- | ---: | ---: |
| Git subprocesses / raw requests | 22 / 20 | 22 / 20 |
| Total synchronous renderer process creation | 478.879 ms | 400.949 ms |
| Median synchronous duration per subprocess | 21.049 ms | 16.859 ms |
| Actual repository queue wait | 0.013 ms | 0.012 ms |
| Readiness interval | 149.128 ms | 98.624 ms |
| Synchronous process creation **within** readiness | 118.742 ms | 71.854 ms |
| First native update's queue wait | 111.278 ms | 89.676 ms |
| Full verification after every update settles | 9.597 ms | 7.066 ms |
| Native `changeLayout` / subsequent hydration | 49.881 / 45.401 ms | 66.907 / 61.618 ms |
| Two durable writes / four sync calls within them | 18.788 / 5.844 ms | 20.657 / 3.716 ms |
| Maximum sampled renderer timer delay | 102.712 ms | 84.303 ms |

Rows overlap and must not be added. Presentation spans are **99.203/65.037 ms** inclusive, but only **14.882/24.343 ms** lies outside other selected stages. Provider subprocess creation occupies the renderer while native updates are queued. For Alpha→Beta, the branch-list subprocess alone spends **49.931 ms** inside synchronous creation while readiness is pending. This identifies overlapping renderer stalls; it does not identify a kernel, memory, or CPU root cause. `clearLayout` itself takes **5.900/5.916 ms**, with `setLayout` **43.937/60.956 ms**; hidden loads already overlap, while underlying adapter reads serialize.

Variation is also visible in normal-mode reports, without deep hooks. For the identical `rev-parse --show-toplevel --symbolic-full-name HEAD` request, median returned-promise latency is **9.551 ms** in the earlier 341 ms run, **12.199 ms** in the 452 ms run, and **16.854 ms** in the matched 522 ms run. Their readiness medians are **18.091**, **57.099**, and **68.605 ms**. Invocation count, position, product, and scheduling context differ; these observations demonstrate variability and changed overlap, not an isolated causal comparison. The latest matched result remains the primary performance assessment.

### Git process creation and safeguards

In the [journal-build trace](optimized-deep-native.json.gz), measured Alpha→Beta and Beta→Alpha take **470.864/550.527 ms**. Their **36/38 Git subprocesses** spend **198.532/214.322 ms** inside synchronous renderer `spawn` calls. Each safeguard launches eleven reads; two safeguards plus four other full inspections consume **215.999/276.392 ms**. Actual provider checkout takes only **30.411/9.317 ms**. Repository queue waits are **0.013/0.014 ms**.

Concurrent request submission still creates processes synchronously on the renderer thread. The last request in one seven-read batch waits **52.560 ms** before its spawn begins. One 55-byte root response has **41.878 ms** between observed process exit and stream close; that interval includes scheduling/drain delay, not large-output transfer. Summed raw request durations are **969.178/1207.933 ms**, while their interval unions are **252.404/331.301 ms**. This is why overlapping spans cannot be counted as additive work.

The [candidate trace](candidate-deep.json.gz) reduces measured subprocess count to **23 per switch**, with six reads per safeguard. However, its measured durations vary to **897.645/473.966 ms**, with synchronous spawning at **340.721/225.918 ms** and maximum sampled timer lag **129.219/66.272 ms**. The counts establish eliminated work; these two captures do not establish a timing speedup under matched load. Production command batching and identity reads are in [the Git adapter](../../../src/git/obsidian-git.ts).

### Native file readiness

The earlier trace directly observes native deletion retry delays of **100.112/100.067 ms** between `reconcileDeletion(..., false)` and the subsequent reconciliation. Source notes are absent from disk while still present in the Vault index. Readiness consumes **52.168/54.520 ms** because post-checkout inspection/presentation overlaps the first part of that native delay. Full validation completes **3.853/5.280 ms** after the last delete event; the event-driven waiter is no longer adding a 100 ms polling penalty.

The candidate's optional [native reconciliation hint](../../../src/obsidian/vault-reconcile.ts) uses the inspected Obsidian 1.15.1 adapter's own `update` queue. In measured Beta→Alpha, updates enqueue at selection +292.673 ms, source delete events arrive at +315.797/+316.722 ms, and verification finishes at +321.932 ms. Its **29.538 ms** readiness splits into **24.352 ms** update drain and **5.185 ms** ordinary verification; the first update waits **21.523 ms** in the native queue. Later watcher retries still occur, but are no longer needed to establish readiness. All index/stat/content/removal conditions remain in [the readiness helper](../../../src/obsidian/layout-files.ts); an event or successful update alone never proves readiness.

### Native layout and hidden editors

The earlier build spends **83.425/126.817 ms** restoring layouts. Native `changeLayout` takes **41.453/55.432 ms**, including only **3.356/4.513 ms** for `clearLayout`; the remainder is predominantly `setLayout` and visible editor work. Sequential hydration after `changeLayout` adds **41.788/71.175 ms**.

The candidate [host](../../../src/obsidian/layout.ts) already starts remaining leaf loads together and drains all results. Its measured after-change tails are **109.156/58.936 ms** under that capture's variable load. Three hidden Markdown reads start together, but native adapter tasks still serialize. In Beta→Alpha, relative to `changeLayout` completion, read tasks run at **32.533–33.494**, **33.516–41.222**, and **41.281–53.743 ms**, with hydration finishing at **58.936 ms**. Additional host-level `Promise.all` cannot eliminate that underlying queue or renderer work.

### Storage, notifications, and presentation

In the earlier deep trace, two durable writes cost **16.862/15.438 ms** total; four file/directory sync calls account for **5.209/3.394 ms**. Store location validation costs **0.590/2.524 ms**. The full prepared recovery context remains durable before unloading/checkout; completion commits target identity and clears the journal after restoration/verification. See [controller](../../../src/workspaces/controller.ts), [store](../../../src/storage/store.ts), and [recovery decision](../../adr/0004-workspace-transitions-and-recovery.md).

Fifteen state getter calls and six notifications occur during each measured switch. Getter/notification/phase-update synchronous intervals have a union of **7.281/8.614 ms**; most getters are nested inside notifications. Clean editor flush costs about **0.11 ms**. These are smaller remaining contributors than process creation or layout work.

Awaited presentation costs **36.547/34.462 ms** in the earlier trace. A separate background branch-label refresh overlaps hydration/final inspection; counting it again would overstate cost. The later overlap build starts its explicit branch-indicator refresh within the repository scope and drains that promise before the scope ends. The native refresh event also starts provider-owned asynchronous listeners; the event dispatcher does not return their completion, so they are outside this drainage guarantee. The analysis utility attributes only presentation time outside the other selected stages. A pending presentation promise does not authorize dropping final identity, readiness, durability, or queue-ownership guarantees.

### Remaining opportunities and their boundaries

The evidence prioritizes reducing provider process count and the cost of creating each process. A different transport would need a compatible provider boundary that preserves configured executable/arguments/environment, scheduling, hooks, output handling, and errors. The worker experiment below does not establish such a boundary, and its native failure supplies no speed estimate.

The full native layout rebuild and adapter read queue remain another substantial workload. Incrementally applying a layout could avoid some teardown, construction, or duplicate reads, but would introduce a new restoration contract requiring validation of branch ownership, pins, hidden editors, unload-time saves, cached content, and failure recovery. Existing full-layout timings do not prove that such an implementation cannot be faster.

Durable syncs and state cloning are much smaller measured contributors. Weakening their guarantees would address little of the observed delay. These traces identify where further work should be tested; they establish neither an architectural impossibility of near-instant switching nor an achievable near-instant result.

## Worker transport feasibility: blocked by the host

[git-read-transport-native.json.gz](git-read-transport-native.json.gz) is classified as **unsupported-host feasibility evidence**, not a latency benchmark. At **03:36:45.770 UTC**, the test-only manual probe acquired the actual Obsidian Git queue, then native `Worker` construction failed with:

```text
ERR_MISSING_PLATFORM_FOR_WORKER
Failed to construct 'Worker': The V8 platform used by this instance of Node does not support creating Workers
```

The report finished at **03:36:45.983 UTC** with **zero samples**. It produced no worker-startup measurement, provider/worker version/root equivalence result, or paired timing comparison. Node-only development checks of the worker succeeded, but do not establish native support. The experiment neither changes production transport nor justifies bypassing the host boundary. Even a successful version/root comparison would not reproduce the provider's configured executable, environment, plugins, scheduler, or error behavior.

Original JSON SHA-256: `e6544ed374a5cf35ab91e5dc146710a1a2b9471d8b8c05c052151bdb79555e19`. The [probe](../../../tests/obsidian/git-read-transport-probe.cjs) and [preparer](../../../scripts/prepare-git-read-transport-probe.mjs) remain reproducible, with the expected unsupported result for this host.

## Reproduction

Use the completed disposable fixture described in [Development](../../development.md#quick-switcher-regression-fixture). Disable the benchmark before rearming. Install the intended Workspaces bundle separately while Workspaces is disabled; preparers do not replace it. They reject a non-disposable fixture, remotes, a dirty worktree, a non-Alpha start, and a report inside the vault; prior reports are archived.

From the repository root, run a normal measurement:

```sh
node scripts/prepare-switch-benchmark.mjs /absolute/disposable/vault \
  --phase matched-baseline --manual-start \
  --samples 20 --warmups 3 --baseline-samples 6 \
  --result /absolute/report-directory/matched-baseline.json
```

Enable Workspaces, Quick Switcher++, and **Workspaces Switch Latency Benchmark**. Close Settings and run **Run switch benchmark** through the command palette. Keep the workspace unobscured and avoid concurrent build/test activity. Repeat with the candidate bundle and a new phase/report filename. Preserve reports and hashes before another prepare operation.

For a short diagnostic trace, use a separate report:

```sh
node scripts/prepare-switch-benchmark.mjs /absolute/disposable/vault \
  --phase candidate-deep --manual-start --deep-trace \
  --diagnostic-samples 2 --warmups 1 --baseline-samples 0 \
  --result /absolute/report-directory/candidate-deep.json

node scripts/analyze-switch-benchmark.mjs \
  docs/validation/switch-latency/baseline-matched.json.gz \
  docs/validation/switch-latency/optimized-matched.json.gz
```

The analyzer accepts plain JSON and gzip. Use its output with the UI-condition caveats above; running the command does not make unmatched reports comparable. Deep mode uses bounded spans/events and targeted observation, without `async_hooks` or global timer replacement. A prior broader instrumentation attempt crashed the renderer and was discarded as invalid timing evidence; none of the retained passing reports is that incomplete capture.

The transport feasibility command is separate and never autoruns:

```sh
node scripts/prepare-git-read-transport-probe.mjs /absolute/disposable/vault \
  --result /absolute/report-directory/git-read-transport-native.json
```

Enable **Workspaces Git Read Transport Probe**, close Settings, and invoke **Run Git read transport probe**. It attempts one persistent worker, fixed read-only queries, five warmup pairs, and twenty alternating-order measured pairs under one provider queue task, with output-byte equality checks outside query timing and worker cleanup before releasing the task. Its unsupported native result above is the current evidence.

## Coverage limits

These runs cover a small local fixture on one Linux desktop and the stated installed plugin versions. They do not establish scaling with large repositories, many notes/leaves, third-party editable views, slow storage, different themes, other Obsidian versions, other operating systems, or mobile. The optional reconciliation helper is version/capability gated; ordinary bounded readiness checks remain the fallback. Earlier zero-modal exploratory runs are not a guarantee: the matched candidate opened progress in half of its measured branch switches. Both requested performance objectives remain unmet reliably.
