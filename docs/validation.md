# Initial implementation validation

Validated on 2026-11-13. This document distinguishes native application observations from automated simulations.

## Core Workspaces bridge — 2026-11-16

`npm run check` passed **459 tests**, type checking and the build. The 60 [bridge](adr/0006-native-core-catalog-bridge.md) tests use a fake core instance with the real controller. They cover each routed method, the optimistic save entry, projection content and timing, every reconciliation rule, the baseline, lifecycle, an unsupported core shape and state migration.

The bridge also ran in native Obsidian 1.15.1 on macOS (arm64) in a disposable vault with unbound workspaces and no Git. An agent drove it through the Obsidian CLI; the window was minimized. Build `ae5b531e…`, source `4a2e223`. Every observation matched the catalog, the in-memory core list and `workspaces.json`:

| Scenario                                                                           | Observed                                                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Core alone saves two layouts, then Workspaces is enabled                           | Both entries were imported; the baseline named both.                                                 |
| Core `loadWorkspace`                                                               | The controller activated the record; the saved note opened; no journal remained.                     |
| Core save of a new name                                                            | The entry was in the core list at once; the catalog then held the record as active.                  |
| Rename and delete in the product                                                   | The core list and file showed the new name and lost the deleted entry.                               |
| Workspaces disabled; core saves one layout and deletes another; Workspaces enabled | The new entry was imported and the deleted record was removed, without a transition.                 |
| The real "Manage workspace layouts" dialog: Save, the delete icon, Load            | The list was correct after each action; Load closed the dialog and activated through the controller. |
| Core Workspaces disabled, then enabled                                             | The bridge detached and restored the core methods, then attached again.                              |

Not observed natively: branch-bound workspaces through the core dialog, mobile, the notices after a reconciliation, and a core list with Workspaces Plus `mode:` entries. The Quick Switcher++ probe and the switch benchmark were not run again; switch latency with core Workspaces enabled is not measured.

## Completion benchmark and performance closure — 2026-11-15

The [native completion benchmark report](validation/native-completion-budget/README.md) records six matched Linux runs with the real Obsidian Git and Quick Switcher++ plugins: 900 successful exact completion observations, including 600 measured branch switches. The product removes one redundant Git identity query while retaining its safeguards. The final product/protocol source passed **396 tests**, type checking and build; independent review includes native safety, separate-Settings rejection, complete raw reports and journals.

Near-instant, consistently modal-free switching remains **unmet**. Candidate medians ranged from 404.629 to 733.679 ms across the long runs, with substantial session/order effects and progress openings. The [local Mac closure gate](performance/local-mac-closure.md) requires fresh paired sessions, representative workload evidence, final performance publication and independent review before issue #4 can close. Actual Mac acceptance remains pending. Earlier validation records below retain their original scope and build identities.

## Quick Switcher++ regression validation — 2026-11-14

The subsequent status/Quick Switcher++ fixes passed **142 automated tests** and **10 native checks** on Linux with Obsidian **1.15.1**, Obsidian Git **2.43.0**, and Quick Switcher++ **6.3.0**. Both reported bugs were reproduced with the original build before the fixed build was installed. A separate blind reviewer identified an overlapping-plugin-enable race; the correction passed the reviewer's official-provider regression harness and a fresh full native run. The [independent review](validation/quick-switcher-independent-review.md) records the resolved finding, exact final bundle hashes, and [final native report](validation/quick-switcher-independent-final.json). The [original regression validation](validation/quick-switcher.md) retains the author's before/after results and manual observations. The initial implementation evidence below remains unchanged.

## Automated verification

`npm run check` runs TypeScript checking, the Node test suite, and the shipping build. Tests use real temporary Git repositories for the installed-provider adapter, deterministic host doubles for transition failures, temporary filesystem stores, and the actual generated CommonJS bundle for desktop/mobile loading.

The implementation and independent review runs passed **118 tests**, with no failures or skipped tests; type checking and the shipping build also passed.

Covered risks include dirty and conflicting worktrees, ignored-file collisions, unfinished Git operations, native runtime file tracking, canonical repository identity through vault aliases, alias retargeting, provider queues, rapid activation, source drift during saves, cancellation, stale confirmations, history identity, failed writes before and after atomic replacement, recovery across controller reconstruction, competing stores, symlink containment, malformed import identities, cache readiness, and pin/leaf preservation. Mobile bundle tests forbid Node module loading.

## Native application verification

The independent reviewer ran the complete native fixture using **Obsidian 1.15.1** and **Obsidian Git 2.43.0** on Linux, in a fresh disposable local vault with no Git remotes. All nine checks passed on source commit `bca767994231e1720c2eabc924bd3ba4b5f6453d`, after the import-identity and canonical-repository fixes. The complete [machine-readable result](validation/native-e2e-final.json) retains the branch, layout, pin, editor-content, and failure-path observations.

The rebuilt and installed bundle matched SHA-256 `c5fb5829f892ffa818d7b7b9521ece22309e8ed08e48dc7df914ed207fd745fa`. The run completed on 2026-11-13 at 23:56:30 UTC. Native UI inspection and a separate Git command confirmed the final alpha branch, Alpha workspace indicator, and clean worktree.

The [independent review](validation/independent-review.md) records the source, fixture, bundle, and raw-report hashes, complete observations, resolved findings, and remaining coverage limits.

| Scenario                                    | Observed result                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Load the development bundle                 | The final CommonJS bundle loaded in the native application.                                                                                |
| Capture and import two bound native layouts | Import retained layouts and pins without activating either workspace.                                                                      |
| Switch alpha → beta → alpha                 | Actual Git branch, committed workspace, and visible editor content agreed.                                                                 |
| Branch-exclusive main and sidebar notes     | Each branch restored its own pinned main note and pinned notes in both sidebars. Inactive snapshots retained their absent file references. |
| Same-length changes to `shared.md`          | The visible editor showed `ALPHA` or `BRAVO` as appropriate, despite equal byte lengths.                                                   |
| Deferred sidebar notes                      | Native deferred markdown leaves were observed and loaded before activation completed.                                                      |
| Dirty editor buffer                         | The buffer was saved, checkout was rejected, and source identity/journal state remained correct.                                           |
| Dirty same-branch activation                | The new layout opened and the note edit remained intact without checkout.                                                                  |
| Return to a clean fixture                   | Further clean branch switching succeeded.                                                                                                  |

The native run did not observe `shared.md` itself becoming deferred; its background editor content was verified. Deferred sidebar markdown leaves were observed separately.

### Additional native checks

Backlinks, Outgoing links, and Outline were also tested while following an active note; all three permitted branch switching. A manual Alpha → Beta menu activation showed the pinned `beta-exclusive.md` note with both branch indicators displaying `beta`.

The [sidebar and menu result](validation/native-final.json) records those checks against the earlier bundle identified by its own hash. The [initial scenario result](validation/native-initial.json) is retained separately. The independent full run linked above is the acceptance evidence for the final implementation.

## Reproduce the native run

Build the project and obtain the official Obsidian Git 2.43.x plugin assets. Use a new disposable directory, never a personal vault:

```sh
npm ci
npm run check
node scripts/prepare-runtime-vault.mjs /absolute/disposable/vault \
  --git-plugin /absolute/obsidian-git-plugin \
  --results /absolute/results/native-validation.json
```

Open that vault in Obsidian and enable its three fixture plugins. The test-only probe runs after layout/plugin readiness and writes its results outside the vault. If the app was already open before preparation, refresh the installed-plugin list before enabling them. To repeat the test, close the fixture vault and invoke the preparer with `--reset`; it refuses to reset an unidentified vault. Test plugins are not bundled into `dist/main.js`.

After the baseline run passes, install the additional core-sidebar probe with `node scripts/prepare-native-extras.mjs /absolute/disposable/vault` and enable **Workspaces Native Sidebar Probe**. To repeat it, disable that probe first and rerun its preparer. The preparer preserves the previous result and refuses to rearm a running probe.

## Limits

Native validation here covers Linux and the versions above. macOS, Windows, physical mobile devices, and Obsidian 1.13/1.14 were not exercised. Binary/media restoration and floating-window layouts have automated coverage of the relevant state/readiness contracts, but no complete native acceptance run here. Arbitrary community-plugin editors do not have a universal save contract; unsupported views must be closed before changing branches.

Recovery failures and restarts were injected in automated tests; the native application was not killed at every journal boundary. Power-loss behavior was not tested. An unrelated Git process is outside Obsidian Git's queue, so the controller rechecks observed state at operation boundaries instead of claiming an external-process lock.
