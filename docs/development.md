# Development

## Build

Use Node.js with the committed npm lockfile.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run check` runs the repository's combined verification. The build emits `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`. Install those three files under the vault's plugin directory named `obsidian-workspaces`.

Obsidian is provided by the application and remains external to the bundle. The desktop Git backend is the separately installed Obsidian Git plugin; this repository does not bundle that plugin or its credentials.

## Test boundaries

Model tests verify identity, independent duplication, metadata retention, migration, and history. Transition tests use controllable backends to exercise slow requests, checkout failure, missing branches, repository mismatch, persistence failure, and interrupted recovery. Layout fixtures must include pins and branch-exclusive file paths.

An adapter test should check the exact backend capability assumptions, including serialized operation behavior. A passing fake-backend test does not prove compatibility with an installed plugin. Likewise, a mocked layout restore cannot establish that Obsidian's filesystem observer has populated the expected files.

## Desktop validation

Use a disposable vault with two existing local branches and the targeted Obsidian Git version. Create a different note on each branch, commit both branch states, and keep the control store outside that repository.

Keep the live layout files out of Git tracking. For the default configuration directory, the ignore entries are:

```gitignore
/.obsidian/workspace.json
/.obsidian/workspace-mobile.json
/.obsidian/workspaces.json
```

Use the actual configuration directory for the vault. Ignore rules do not stop tracking files already in the index; remove those runtime files from the index separately. The named core catalog `workspaces.json` is written by the core Workspaces bridge after a switch, so it must be untracked too when core Workspaces is enabled. The checkout preflight does not enforce this for `workspaces.json`. Do not use a blanket ignore rule for all configuration merely to hide a dirty-state failure.

| Scenario                                          | Observe                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Save A and B with different pins                  | Each record retains its own main-area and sidebar pin state.                                                         |
| Switch A → B → A                                  | Actual Git branch, visible notes, pin flags, active workspace, and saved state agree after each transition.          |
| Switch between unbound workspaces with many tabs  | The switch does not load hidden tabs. A hidden tab loads when it is shown, with current content.                     |
| Delete a saved note, then open its workspace      | The layout opens, one notice names the note, and no recovery is required.                                            |
| Edit a tracked note                               | A checkout is blocked until changes are handled explicitly through Git.                                              |
| Add an untracked note                             | The dirty-status check blocks checkout and preserves the source context.                                             |
| Disable Git or select a missing branch            | The error identifies the missing capability/ref; no target is reported active.                                       |
| Switch repeatedly                                 | No overlapping checkout or stale target restoration occurs.                                                          |
| Delay checkout or vault observation               | Incidental layout events cannot save an empty or intermediate workspace.                                             |
| Open an unsupported editable view                 | Preflight stops before checkout or journal creation and identifies the view to close; close it and retry the switch. |
| Change contents at the same path between branches | The target opens current content after vault metadata and cached text catch up.                                      |
| Change branches externally                        | Saving a bound workspace detects the mismatch.                                                                       |
| Interrupt after checkout                          | Restart surfaces the journal and leaves the actual branch unchanged.                                                 |
| Restore history and import data                   | Restores use the controller; importing records alone does not check out Git.                                         |

Also test an unbound workspace with Git disabled, a same-branch layout switch with pending file edits, an unbound mobile save/restore, and export/import round-trips. Import fixtures should cover multiple Workspace++ groups, Workspaces Plus presentation/tracked-file metadata, skipped Modes, colliding IDs, and foreign repository bindings.

Confirm that a corrupt primary JSON is rejected without silent overwrite and that its preserved backup remains available for explicit recovery. Test competing desktop writes and a leftover `state.json.lock`: a stale writer must be rejected, and the plugin must not steal the lock. Remove a leftover lock manually only after closing every instance that could write that vault's state. When a verification step cannot run, report that limitation instead of substituting a source inspection result.

### Core Workspaces bridge

Unit tests use a fake core instance. They do not prove the behavior of the native core dialogs. Run these scenarios in a disposable vault with core Workspaces enabled, and keep `workspaces.json` untracked. No native probe exists for the bridge yet. The Quick Switcher++ probe seeds and wraps the core catalog directly; review it against the bridge before the next run.

| Scenario                                                 | Observe                                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| First start with existing core layouts                   | Each core layout is a workspace; the core list is unchanged; one notice gives the counts.                                           |
| Core **Manage workspace layouts** → Load on a bound one  | Actual branch, visible notes, pins, and the product status agree. A dirty tree blocks it with a notice.                             |
| Core dialog → Save under a new name                      | The entry appears at once; the product lists the new active workspace.                                                              |
| Core dialog → Save over another bound workspace          | Core shows its own message, then the product error; the list returns to the catalog's content.                                      |
| Core dialog → Delete, including the active layout        | The product record is gone; the replacement opens first for the active one; the list updates in place.                              |
| Create, rename, duplicate, delete in the product         | The open or reopened core list shows the same names; equal names carry suffixes.                                                    |
| Switch workspaces repeatedly                             | `workspaces.json` changes only its active name and saved times; no modal appears; the status bar item shows the transition message. |
| Disable Workspaces, change the core list, enable it      | Deletions, new layouts, and later saves arrive in one step with no layout change or checkout.                                       |
| Disable core Workspaces, delete a record, enable core    | The deleted record does not return.                                                                                                 |
| Disable and enable core Workspaces while Workspaces runs | Core methods are restored on disable and routed again on enable.                                                                    |
| Interrupted switch at start                              | Core requests are refused with the recovery message until recovery completes.                                                       |

The bridge writes the core file in a timer task after the controller promise settles. Measure switch latency again with core Workspaces enabled before a performance claim; earlier measurements did not include that write.

### Quick Switcher++ regression fixture

Use a completed disposable fixture from `scripts/prepare-runtime-vault.mjs`, on its clean `alpha` branch with `runtime-alpha` active. Obtain the official Quick Switcher++ **6.3.0** release's `main.js`, `manifest.json`, and `styles.css` in a separate directory. Its minimum host version is **Obsidian 1.15.0**.

```sh
node scripts/prepare-quick-switcher-probe.mjs /absolute/disposable/vault \
  --phase fixed \
  --quick-switcher-plugin /absolute/quick-switcher-plugin
```

The preparer installs Quick Switcher++ and a test-only probe; it leaves the installed Workspaces bundle unchanged. Install the intended `dist` build separately while Workspaces is disabled. Enable Quick Switcher++, Workspaces, and **Workspaces Quick Switcher Native Probe** in the native app. Rearming requires disabling the probe first. Reports are outside the vault, and earlier completed reports are preserved.

The probe invokes the actual registered Workspaces Mode command and the native chooser's Enter path. It observes the real controller promises, actual Git branch, native layouts, editor contents, main/sidebar pins, status text, and journal. It also tests the actual save-and-switch key handler, core Workspaces disabled, duplicate display names, and a rejected dirty editor checkout followed by a clean roundtrip. Core catalog seeding is confined to the fixture, and its original state is restored afterward. The probe does not substitute a mocked handler, controller, or Git backend, and it does not repair target views before verification.

For reproduction against the original implementation, install the pre-fix bundle and use `--phase baseline`. That phase succeeds only when it observes both reported defects: a duplicated branch suffix and a Quick Switcher++ core selection that leaves the product workspace/Git branch unchanged. It restores the original Alpha layout afterward. Baseline success therefore means the defects were reproduced, not that the original behavior met the product contract.

Also open the command through the visible command palette, select Beta and return to Alpha, and inspect the status label and suggested details. Record exact versions and installed bundle hashes with the results. Automated adapter tests additionally cover load order, provider reload, stale suggestions, failed saves, and teardown; do not describe those as native runs unless exercised in the app.

The independent review's optional provider harness exercises the official Quick Switcher++ bundle against controlled host sequencing. It starts native-style enable before the adapter, once before instance registration and once during asynchronous provider initialization:

```sh
node tests/integration/quick-switcher-provider.cjs /absolute/checkout \
  /absolute/quick-switcher-plugin product
```

Both cases must list/activate the product ID, leave core loading untouched, and release the manager event subscription on disposal. This is a host-stub regression check using the actual provider bundle; it is separate from native application evidence. The ordinary `npm run check` covers these races with deterministic unit fixtures and does not download or require external plugin assets.

### Workspace switch performance fixture

Use the same completed disposable Alpha/Beta fixture and installed plugin versions as the Quick Switcher++ regression. The [latency evidence and limitations](validation/switch-latency/README.md) retain individual native samples, installed bundle hashes, historical UI conditions, and diagnostic traces.

The [local Mac closure contract](performance/local-mac-closure.md) defines completion-aware measurement, matched repeated sessions, a generated representative workload, required native safety evidence and the executable closure gate. Linux results and a merged implementation PR do not close the performance issue. Preserve final Mac measurements and independent review before closure.

The earlier PR #3 checkpoint recorded median branch switching from 1426.540 ms to 522.178 ms, with candidate p95 735.477 ms and progress openings in 10/20 measured switches. Those historical measurements predate the completion and recorder protocol below. Use the [matched completion benchmark report](validation/native-completion-budget/README.md) for the later identified builds, per-session results and observed session effects. Near-instant and consistently modal-free switching remain unmet objectives. Any later bundle must retain its own validation identity.

Disable the benchmark before rearming it. Install the intended Workspaces bundle separately while Workspaces is disabled **before** running the preparer; it leaves that bundle unchanged and pins its SHA-256 for the run. Reports must remain outside the vault, and earlier reports are preserved. Use `--product-commit FULL_SHA` to record the installed product's source commit; closure requires that provenance.

```sh
node scripts/prepare-switch-benchmark.mjs /absolute/disposable/vault \
  --phase candidate --manual-start \
  --samples 20 --warmups 3 --baseline-samples 6 \
  --result /absolute/report-directory/switch-candidate.json
```

Enable **Workspaces Switch Latency Benchmark**, close Settings, and invoke **Run switch benchmark** from the command palette. Keep the main workspace focused and unobscured and avoid concurrent build/test activity. For a before/after comparison, use the same probe, fixture, UI state, and counts for both installed product bundles. The first observer on the original controller promise synchronously captures and freezes layout, every editor's contents/deferred state, vault index, indicators, identity/journal and input release. An independent validator later checks that endpoint; it cannot be repaired by subsequent hydration. Actual Git, disk and live-state verification follows timing, then the probe restores clean Alpha. The independent verifier does not separately call `vault.cachedRead()`; production readiness retains its own cache checks. A passing mocked host test is not a native latency measurement.

The primary interval is actual chooser selection to controller-promise settlement; the report separately records command/chooser timings, input release, endpoint-capture overhead and the next animation-frame opportunity. Its first switch is probe-cold, not process/OS-cache cold. Normal exploratory runs default to 20 alternating measured branch switches and six measured same-branch/unbound controls each. Complete directions, warmups, individual samples, and median/p95/p99/min/max remain in the external report. Mac closure requires the larger session counts and budgets in its contract; a default exploratory run cannot satisfy it.

The append-only recorder creates `REPORT.json.RUN_ID.samples.ndjson` exclusively outside the vault. During timing, `REPORT.json` contains only compact progress (`startedSamples`, `completedSamples`, current/last attempt), while each raw sample is serialized and appended once after verification. Detailed history and per-transition repository observer descriptors are released; only numeric summaries remain in the probe. After timing, final assembly streams the original report schema from the journal, validates complete ordered attempts and hashes, then publishes it atomically. Preserve failed attempts, crash journals and partial outputs; none can become a passing report without complete evidence.

Renderer memory is observed before each sample, after verification and after its journal append; serialization/append/progress costs remain outside switch timing and are reported separately. This exposes observer effects without forced GC or sleeps. Earlier whole-report-per-sample runs are retained as diagnostic observer experiments and rejected by the closure gate. Matched acceptance pairs require new renderer process IDs as well as new native session IDs between pairs; **Reload app** alone may retain the process. Follow the Mac runbook's close/relaunch instructions.

Each sample refuses to begin selection if its document/native window is unfocused, Settings is open (including a separate native Settings popout), or the inspected 1.15.1 observation capability is missing. Failed preconditions remain recorded in the journal and failed final report. The probe does not close or focus native windows to manufacture eligible timing conditions. Preparation rejects symlink/nonregular report targets and atomically publishes its prepared marker so an external hardlink cannot overwrite linked fixture content.

Use `--deep-trace --diagnostic-samples 2 --warmups 1 --baseline-samples 0` for a short separate diagnostic capture. Deep observation perturbs execution and is not a replacement for the normal distribution. Inspect reports with:

```sh
node scripts/analyze-switch-benchmark.mjs /absolute/report-directory/switch-candidate.json
```

Spans can overlap: do not add raw Git, filesystem, native leaf, and presentation durations to infer elapsed time. The analyzer accounts for presentation overlap. The separate `prepare-git-read-transport-probe.mjs` experiment uses only fixed Git reads; native Obsidian 1.15.1 rejected its Node worker construction with `ERR_MISSING_PLATFORM_FOR_WORKER`, so it produced no transport timing comparison. See the archived feasibility report before attempting that optional diagnostic.

## Adding a feature

Place state changes in the catalog or controller and let native UI call them. A new activation entry point must not invoke checkout or layout restoration directly. A later custom interface should reuse the same operations.

When adding a model field, trace creation, explicit save, duplication, history, migration, import, export, and persistence. A TypeScript index signature does not establish that every route preserves the field. Branch/layout revisions require a defined policy rather than a generic metadata merge.

Keep meaningful failure tests next to the behavior they protect. Avoid carrying upstream test harnesses or checks that test a source layout the product no longer uses.

## Adapted source

Retain source notices in copied or substantially adapted code. Record new upstream revisions and affected areas in `THIRD_PARTY_NOTICES.md`. Keep complete third-party license texts under `LICENSES/`. The product README contains a short attribution section at the bottom; implementation history belongs in commits and notices.

The repository is maintained for personal use. Publishing a release or changing repository visibility is a separate action governed by the user's instructions.
