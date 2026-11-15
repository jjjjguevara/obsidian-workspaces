# Local Mac performance closure

This is the reproduction and closure contract for the workspace-switch performance issue. A Linux improvement, a merged PR, or a fast subset of samples does not satisfy it. Keep the issue open until the final installed product passes this gate on the user's Mac, its workload scope is recorded, and an independent reviewer has examined the evidence.

The gate evaluates evidence and writes a result. It never changes an issue, merges a PR, or calls GitHub. Use `Refs #…` in an implementation PR while local acceptance remains pending. Do not use an automatic closing keyword for a partial result.

## Acceptance

| Requirement              | Closure rule                                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                     | Actual desktop Obsidian on macOS (`process.platform === "darwin"`), with the declared host version. The inspected versions are Obsidian 1.15.1, Obsidian Git 2.43.0 and Quick Switcher++ 6.3.0.                                                                                                      |
| Product identity         | Exact final `main.js` SHA-256 and full product source commit. Baseline and candidate must differ; both use the identical new benchmark bundle.                                                                                                                                                       |
| Workloads                | Both the small correctness fixture and a generated representative profile. Record tracked-file count, branch-change count, note sizes and the number of open Markdown editors; state any remaining mismatch with normal use.                                                                         |
| Repetition               | At least three distinct native renderer sessions **per profile**, each containing a matched baseline/candidate pair. Each report includes 100 alternating measured branch switches and at least 20 same-branch and 20 unbound controls.                                                              |
| Completion latency       | For each candidate session and each pooled profile, median ≤100 ms, p95 ≤200 ms and p99 ≤300 ms for branch, same-branch and unbound measured switches. Percentiles use nearest rank, with the even-sample midpoint for the median.                                                                   |
| Progress                 | Zero transition-progress openings throughout every candidate report, including first switch, warmups, controls and cleanup. Every candidate switch must settle and reach its next frame opportunity within 500 ms. The production 500 ms progress delay stays unchanged.                             |
| Endpoint correctness     | The exact original controller-promise completion snapshot has the requested file-leaf multiset, main/sidebar/floating ownership and pins, current bytes in every Markdown editor, no deferred views, correct active note/indicators, committed workspace ID, null journal and released input guards. |
| Independent verification | Actual Git branch, disk contents and live native state checked after each endpoint. A fresh ten-scenario Quick Switcher++ safety run for each profile, on the candidate build, must include the dirty-editor checkout rejection and finish clean.                                                    |
| Publication              | Attach raw reports, their hashes, the manifest, gate output, final measured performance and scope, and independent review to the issue **before** closing it.                                                                                                                                        |

Three 100-switch sessions provide 300 measured branch samples per profile. Report every session as well as pooled statistics; do not combine different product or probe builds. The first switch is **probe-cold**, not an OS-cache-cold measurement: fixture initialization hydrates starting views and reads expected contents before timing. A `requestAnimationFrame` timestamp is a rendering opportunity, not proof of physical display scanout.

## Measurement boundary

Before every benchmark or safety run, the fixture invokes Obsidian's native Workspaces disable/enable lifecycle and observes a new plugin instance, controller and constructor. This pre-timing preparation requires idle Alpha and a null journal, preserves the enabled-plugin set and the existing Git/Quick Switcher++ instances, and requires stable installed bytes before and after loading. It prevents an older loaded controller from being labeled with a newly copied file's hash. The loader contract is currently restricted to inspected Obsidian **1.15.1**; an unsupported loader fails before unloading anything. The report records procedural native-load evidence, not a cryptographic in-memory byte attestation. No restart or reload time is hidden inside the claimed switch interval; preparation and probe-cold terminology are explicit.

`tests/obsidian/switch-benchmark.cjs` invokes the installed Quick Switcher++ Workspaces command and chooser Enter method. It observes the unchanged `controller.activate()` promise, including repository-queue ownership and final persistence. Its first settlement observer synchronously copies the native state, layout, active view, all editor buffers/deferred flags, vault-index entries, status indicators and input-listener release. It performs no `await`, frame wait, Git read, file read or repair before that snapshot. The copied snapshot is deeply frozen.

The independent `completion-endpoint.cjs` validator checks that saved snapshot later; a late editor hydration cannot turn an incorrect endpoint into a pass. After timing, the existing native verifier checks actual Git and disk state without repairing target views. Extra representative Markdown editors use expected bytes read from pinned fixture commit objects **before** timing. All expected and observed values remain in the raw report for audit.

Snapshot duration is recorded separately. The controller interval ends before observation cost; the next-frame interval includes that synchronous observation. Input release is recorded separately. Modal observations, endpoint state and later Git/disk verification are distinct evidence, not interchangeable claims.

### Recorder protocol and observer cost

The required recorder is `obsidian-workspaces-sample-recorder-v1`, mode `append-only-streamed-final`. Preparation prints an external journal path of the form `REPORT.json.RUN_ID.samples.ndjson`. The run creates that journal exclusively, records each attempt before its timer starts, and appends its immutable completed raw sample once after verification. Failed samples and cleanup attempts remain in order. Between switches, the probe retains compact numeric summary data and releases the detailed sample and per-repository observer descriptors. It replaces only a small progress JSON at the selected report path while running; this file has `kind: "benchmark-progress"`, `complete: false`, and no sample array.

After all timed work and fixture cleanup, the recorder seals the journal and streams the final original-schema JSON from it, processing one sample at a time with filesystem backpressure. It validates start/completion/observation order, exact counts and the journal hash before atomically publishing the complete report. The final `recorder` field identifies the protocol and raw-sample digest. An incomplete start, failed append, corrupt journal or interrupted final assembly cannot publish a successful final report. Retain both the final JSON and NDJSON journal: both are mandatory closure artifacts. Each baseline/candidate report reference has a nested `journal: { "path": "relative/path.samples.ndjson", "sha256": "..." }` reference. This portable manifest path identifies the archived journal; the report's original absolute `recorder.journalFile` is provenance, not an instruction to read that old machine path.

The raw sample records renderer `process.memoryUsage()` before timing and after verification, and its `recorderObservation` records memory after the append, serialization cost and append cost. Final recorder metadata includes initial/final memory and total compact-progress cost. These observations are outside the switch timers; they are not evidence that recording has zero subsequent effect on GC, process memory, scheduling or filesystem load. Do not force GC, add cooling sleeps or subtract an estimated observer cost from measured switch times. Compare memory and sample-order trends as well as the latency distribution.

Earlier runs that repeatedly serialized and replaced the complete growing result are retained as observer diagnostics. Their cumulative allocation and writes grew quadratically with sample count. They are ineligible for performance closure even when their endpoint checks passed; the gate explicitly requires the append-only recorder. Rerun both product builds with the same final probe hash.

## 1. Prepare source, assets and report directories

Use a new directory outside every personal vault. Never run the fixture preparers against the user's working vault. They create local branches and test files only in an identified disposable directory, without remotes. Do not use `--reset` on an open fixture.

Use Node.js 24 and the committed npm lockfile. Check out the exact candidate commit identified by the PR; obtain the baseline from the same repository. These example shell variables are task-specific and may be changed to suitable absolute paths:

```sh
export PERF_ROOT="$HOME/Workspaces-performance"
export PERF_REPO="$PERF_ROOT/repo"
export PERF_REPORTS="$PERF_ROOT/reports"
export PERF_ASSETS="$PERF_ROOT/assets"
export PERF_BASELINE_COMMIT=6b3ae45589132a7c37da14e94a20a4668b2f28b9
export PERF_CANDIDATE_COMMIT=3f0c0ed8df50efb1fb29b6bf402ad1084b2e9939
mkdir -p "$PERF_REPORTS" "$PERF_ASSETS"
git clone https://github.com/jjjjguevara/obsidian-workspaces.git "$PERF_REPO"
cd "$PERF_REPO"
git checkout "$PERF_CANDIDATE_COMMIT"
npm ci
npm run check
git status --short
```

The candidate above pins PR #5's product and hardened benchmark protocol. For a later product or protocol change, replace it with the new full commit and collect new evidence. Preserve the complete check output and commit identity. The benchmark source checkout must be clean. Keep reports outside it until collecting evidence is finished. Build the baseline in a separate checkout:

```sh
git worktree add --detach "$PERF_ROOT/baseline-source" "$PERF_BASELINE_COMMIT"
cd "$PERF_ROOT/baseline-source"
npm ci
npm run build
cd "$PERF_REPO"
shasum -a 256 "$PERF_ROOT/baseline-source/dist/main.js" "$PERF_REPO/dist/main.js"
```

Obtain the official [Obsidian Git](https://github.com/Vinzent03/obsidian-git/releases) **2.43.0** and [Quick Switcher++](https://github.com/darlal/obsidian-switcher-plus/releases) **6.3.0** release assets. Put `main.js`, `manifest.json` and `styles.css` under `$PERF_ASSETS/obsidian-git` and `$PERF_ASSETS/quick-switcher`. The Git stylesheet is optional if absent from its release. These are the actual installed plugins used by the tests; there is no replacement Git implementation. Record their hashes and the actual Obsidian version.

## 2. Establish both disposable workload profiles

Create the small fixture with the intended product build already in `dist`:

```sh
node scripts/prepare-runtime-vault.mjs "$PERF_ROOT/vault-small" \
  --profile small \
  --git-plugin "$PERF_ASSETS/obsidian-git" \
  --results "$PERF_REPORTS/small-runtime.json"
```

Open this **disposable** vault in native Obsidian, enable community plugins, and allow its runtime probe to finish. Continue only when the external runtime JSON says `status: "passed"`, the actual branch is `alpha`, `runtime-alpha` is active and Git is clean. The native plugin stores its control data under the Mac application-data directory, outside this test repository.

Choose the representative size from the user's normal workload. Counts can be collected without reading or copying note contents. Record the source of the file-count, branch-change-volume, note-size and editor-count estimates in the closure manifest. The following values are an example, not an assertion about the user's vault:

```sh
node scripts/prepare-runtime-vault.mjs "$PERF_ROOT/vault-representative" \
  --profile representative \
  --unchanged-notes 5000 --branch-notes 200 --note-kib 8 \
  --git-plugin "$PERF_ASSETS/obsidian-git" \
  --results "$PERF_REPORTS/representative-runtime.json"
```

This profile adds deterministic synthetic files under `benchmark-notes/`; it preserves the primary Alpha/Beta notes and shared-path content test. The marker records declared dimensions and Git counts. The benchmark independently records the actual tracked-file and changed-path counts outside timing.

**File volume and layout size are separate dimensions.** The default layout has four Markdown editors: the active exclusive note, shared background note, and both pinned sidebar editors. If normal work uses more editors, open additional generated Markdown notes in the disposable Alpha layout, retain its original pins, select `alpha-exclusive.md`, and run **Workspaces: Save current workspace**. Repeat on Beta through the product switcher, retain Beta's original pins, select `beta-exclusive.md`, and save. Return cleanly to Alpha. The benchmark reads each additional saved Markdown note's expected contents from that branch's commit before timing. It validates every matching editor at completion.

Use identical layouts for baseline and candidate, including the same representative editor count. Do not count a four-editor test as evidence for a much larger layout. If the representative profile cannot reasonably reflect normal use, leave `suitabilityConfirmed` false and the issue open; record exactly what was measured.

Install and run Quick Switcher++'s native regression probe in each completed fixture:

```sh
node scripts/prepare-quick-switcher-probe.mjs "$PERF_ROOT/vault-small" \
  --phase fixed --quick-switcher-plugin "$PERF_ASSETS/quick-switcher"
```

The command prints its external report location and safety-probe hash. Enable **Workspaces Quick Switcher Native Probe** and wait for all ten checks to pass. Repeat for the representative fixture. The preparer leaves Workspaces files unchanged; the native probe performs the explicit pre-test reload described above. After completion, disable the safety probe for timing. Repeat the final safety run on the exact candidate build in the final measured session for that profile, preserving the report as `small-quick-switcher-fixed.json` or `representative-quick-switcher-fixed.json`. Its own probe hash, native session, provider hashes and workload must match the closure manifest and measured profile.

## 3. Run matched native sessions

For each profile, collect three paired sessions. Close and reopen that disposable vault window between pairs; both the native session identity and renderer process ID must change. **Reload app** can change the session UUID while retaining the renderer process and its memory. If closing a vault window also leaves that process alive or reuses it, quit and relaunch Obsidian between pairs. The gate requires distinct renderer PIDs across independent pairs and the same PID/session within each pair. This establishes a fresh renderer, not an OS-cache-cold sample. Keep the fixture window visible and focused, Settings closed, the viewport/theme/provider settings unchanged, and avoid concurrent builds or benchmarks. A session pair uses the same fixture commits, plugin assets and benchmark hash for both builds.

Keep a configuration observation record with the reports: enabled community plugins, performance-relevant Obsidian Git and Quick Switcher++ settings, theme/CSS snippets, layout split arrangement, selected sidebar tabs, sidebar widths and collapsed states. The raw report captures plugin versions and JavaScript hashes, viewport, Workspaces auto-save, and native load/session evidence. It does not capture all provider/theme settings or stylesheet bytes. Their equality, along with full layout topology, must therefore be maintained by the operator and checked in independent review; the gate's normalized file-leaf comparison is narrower than full visual-layout equality.

Alternate installation order to reduce order bias: baseline→candidate, candidate→baseline, baseline→candidate. For **each** report:

1. Disable **Workspaces Switch Latency Benchmark** and **Workspaces** in the disposable vault.
2. Copy the chosen build's `dist/main.js`, `dist/manifest.json` and `dist/styles.css` into that vault's `.obsidian/plugins/obsidian-workspaces/` directory. Copying files without disabling/reloading the plugin is insufficient to establish the running build.
3. Enable Workspaces and confirm Alpha, null recovery journal and clean Git. Keep Obsidian Git and Quick Switcher++ enabled and ready.
4. Prepare the benchmark from the **candidate protocol checkout**, even when measuring the baseline product. The preparer pins the currently installed product SHA; install before preparation.

Example for small profile, session 1, candidate:

```sh
node scripts/prepare-switch-benchmark.mjs "$PERF_ROOT/vault-small" \
  --phase small-s1-candidate --manual-start \
  --product-commit "$PERF_CANDIDATE_COMMIT" \
  --samples 100 --warmups 3 --baseline-samples 20 \
  --result "$PERF_REPORTS/small-s1-candidate.json"
```

For baseline use `--product-commit "$PERF_BASELINE_COMMIT"` and a baseline report name. Enable **Workspaces Switch Latency Benchmark**, close Settings, and invoke **Workspaces Switch Latency Benchmark: Run switch benchmark** through the native command palette. The report runs the real Quick Switcher++ selection route automatically. While it runs, inspect the compact progress record's `startedSamples`, `completedSamples`, `currentSample`, `lastSample` and `journalFile`; the growing raw evidence is in NDJSON. A completed run must publish the final report with `status: "passed"`, `recorder.complete: true`, `restoredAlpha: true`, an empty `finalGitStatus`, and every endpoint validated. Retain failed attempts too; never delete slow samples or edit a report into a pass.

Before every timed attempt, the probe requires both a focused document and a focused native window. On inspected Obsidian 1.15.1, it also checks Settings' own lifecycle, popout reference/window and actual `modalEl` connection. A main-document selector cannot establish that a separate Settings window is closed. An open Settings signal, false focus flag or unsupported capability records a failed attempt and stops before selection; the probe never closes Settings or focuses a window to repair the observation. Inspect `nativeSettingsObservation` and `nativeWindowFocus` in that failed report, close Settings completely, focus the workspace and prepare a new run. A different host capability needs a separately inspected probe revision and matched reruns, not an edited result.

After a process crash, preserve the incomplete progress JSON, journal and any `.partial` output. They do not qualify as completed evidence. Confirm the disposable Obsidian process has exited, archive its progress JSON to a new filename ending in `.incomplete.json`, and prepare a new run with a new report name. Archiving the interrupted progress path also allows the preparer's stale `running` check to resolve; do not change its contents to `passed`. Inspect and recover the product's own transition journal explicitly before rearming if the fixture needs recovery.

Record the benchmark bundle hash printed by preparation and the safety-probe hash printed by its preparer. Each must be identical across its respective closure reports. A changed benchmark requires new matched baseline/candidate reports for acceptance with that probe. Preserve historical comparisons under their original identity; never combine probe hashes in one closure result. Any product change requires a new exact candidate identity and new candidate evidence. Never reuse historical Linux results as Mac reports.

Inspect each report independently:

```sh
node scripts/analyze-switch-benchmark.mjs "$PERF_REPORTS/small-s1-candidate.json"
```

Do not run deep tracing or CPU profiling during acceptance. Those modes remain available for separate diagnostics, but the closure gate rejects them. Stage spans overlap; the analyzer treats nested safety checks and presentation overlap explicitly rather than adding every span.

For each profile, finish its final baseline/candidate pair, reinstall the candidate if necessary, and rerun the native safety probe **before closing that renderer process or moving to the other profile**. The safety report must share a native session UUID and renderer PID with one of that profile's measured pairs. If the process exits before this check, collect a new complete pair and its safety report in the replacement process; do not combine the new safety report with an old renderer's timings. Also make a physical command-palette Alpha→Beta→Alpha roundtrip and inspect the main and both sidebar pins, current text and Git/workspace labels. Preserve a concise observation record and screenshots for the independent review; automated chooser-method calls are not physical keyboard evidence.

## 4. Evaluate the closure gate

Copy [closure-manifest.example.json](closure-manifest.example.json) into the report directory as `closure-manifest.json`. Fill in the final product/probe identities, declared versions, real profile dimensions, paired report paths and hashes, and each report's nested journal path/hash. Use the exact journal filename printed by preparation or recorded in the completed report, then express its archive location relative to the manifest. Set representative `suitabilityConfirmed` to true only after documenting how its file, change, note-size and layout dimensions represent normal use. The template deliberately cannot pass as supplied.

```sh
shasum -a 256 "$PERF_REPORTS"/*.json "$PERF_REPORTS"/*.ndjson
node scripts/check-switch-performance.mjs "$PERF_REPORTS/closure-manifest.json" \
  --output "$PERF_REPORTS/closure-result.json"
```

Paths in the manifest resolve relative to the manifest file; journal references must be relative portable paths. Hash the exact bytes supplied: for `.json.gz` or `.ndjson.gz`, record the compressed file's SHA-256 in the manifest. The gate separately verifies the decompressed journal SHA-256 and byte count against the report's recorder metadata. Copying or gzipping an artifact does not justify editing its internal contents or recorded identities.

The evaluator reads every journal and requires its header, one pre-timing metadata checkpoint, ordered start/sample/observation triples, and final complete seal. It compares artifact identities, every raw sample and observation, counts and sealed final metadata against the JSON report; missing, truncated, reused, reordered, mismatched or unsealed journals block closure. It also recomputes medians/percentiles and reruns endpoint validation independently rather than trusting a summary's `passed` label. Choose a new closure output filename for each attempt: exclusive creation prevents overwriting manifests, reports or journals through ordinary paths, symlink aliases or hardlinks.

Exit code **0** means the supplied local performance evidence meets this contract. Exit code **1** means closure is blocked. Missing Mac reports, old schemas/recorders, incomplete or reordered attempts, wrong hashes, missing controls, reused renderer processes, failed transitions, stale endpoint content, progress openings and exceeded budgets all block closure. A faster median with an unacceptable tail still fails. The gate is an evidence evaluator, not cryptographic attestation that a local operator actually followed the procedure.

## 5. Document the final result before issue closure

Commit a validation report and the raw evidence under `docs/validation/`, then attach the report and independent review to the issue. Include:

- Product commit and installed `main.js` hash; benchmark hash; Mac architecture/OS, Obsidian/Git/Q++ versions and asset hashes.
- Explicit small and representative workload dimensions, saved layout sizes, and their relationship to normal use.
- Baseline and candidate per-session and pooled sample counts, median/p95/p99, min/max, first-switch timings, frame opportunities and progress counts. Keep baseline and candidate builds separate.
- Endpoint and native safety results, physical roundtrip observations, repository check results, raw report hashes, and the unedited closure result.
- Recorder protocol, NDJSON journal hashes, renderer process/session identities, memory trends and outside-timer recorder costs; preserve superseded observer experiments separately.
- Any remaining limitations or failed attempts and the final acceptance decision.

Request an independent review of the final code and these exact local reports. Close the performance issue only after the result is published and the review accepts it. A blocked or unavailable Mac gate must be recorded as **pending**; the implementation PR may still describe a measured partial improvement without closing the issue.
