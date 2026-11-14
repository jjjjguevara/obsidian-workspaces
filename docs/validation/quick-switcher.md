# Quick Switcher++ and status regression validation

Validated on **2026-11-14** using the native Linux Obsidian deployment. These are implementation-author runs for the initial fix. The subsequent [blind review](quick-switcher-independent-review.md) found an overlapping-plugin-enable race, verified its correction, and independently reran **142 tests** and all **10 native checks** on the final production source. The original run identities below are retained; use the independent review's final report and bundle hash for the corrected build.

## Build and environment

| Item | Value |
| --- | --- |
| Source and fixture commit | `81d86f11f59655ec1a2f84fb6951f3754aead1fd` |
| Obsidian | 1.15.1, Linux |
| Obsidian Git | 2.43.0, separately installed |
| Quick Switcher++ | 6.3.0, official release assets, separately installed |
| Fixed Workspaces bundle SHA-256 | `4ed691cd0933cf5488558d5ec71dd828afab9c00a569126e8c7b7d790dfd861d` |
| Baseline Workspaces bundle SHA-256 | `c5fb5829f892ffa818d7b7b9521ece22309e8ed08e48dc7df914ed207fd745fa` |
| Quick Switcher++ bundle SHA-256 | `6746dad3d6b132698b04c2a10ea0c2f71c03c8b5af7bec753ca76319c72e3f23` |
| Native probe SHA-256 | `4965256dd77e99b50e4d005233e9bf5ed2271595ff099bec56fe3977949653b9` |

The fixture was the completed disposable `reviewer-vault`, containing existing `alpha` and `beta` branches and no Git remotes. Its application-data control store is outside the vault. Both branches include their own exclusive main note and sidebar note; `shared.md` has branch-specific contents at the same path.

## Before the fix

The [complete baseline report](quick-switcher-baseline.json) records five successful reproduction/setup/cleanup checks, from 01:54:33.222 to 01:54:33.910 UTC. Its success means the original defects were observed, not that the original behavior was correct.

- The Workspaces indicator displayed `Alpha · alpha`, while Obsidian Git independently displayed `alpha`.
- The actual registered command `darlal-switcher-plus:switcher-plus:open-workspaces` opened the upstream workspace chooser. Selecting its core `Beta` row called the native core `loadWorkspace('Beta')` and never called the product controller. Git remained on `alpha`, and the product remained `runtime-alpha` even though the core layout selection completed.
- Original Alpha layout/pins were restored without writing the product catalog.

The core names/layouts were seeded only inside the test fixture to reproduce the native bypass. Production integration does not seed, synchronize, or patch the core catalog.

Baseline report SHA-256: `e77210a3e662d2c6b3e6166ad9ab680af1ec8abc6250450d2f0ca22693620f61`.

## Fixed native run

The [complete fixed report](quick-switcher-fixed.json) records **10/10 passing checks**, from 01:57:11.451 to 01:57:21.767 UTC, run ID `53861356-07da-4cd0-b1e9-dc18411e849e`.

| Scenario | Observed result |
| --- | --- |
| Final bundle loaded before Quick Switcher++ | Adapter attached when Quick Switcher++ was enabled; actual command and required native plugin-manager methods were present. |
| Status ownership | Workspaces displayed exactly `Alpha` or the selected workspace's name. Obsidian Git separately displayed the actual branch. |
| Actual Q++ Enter path: Alpha → Beta → Alpha | Stable-ID selection reached the real controller. Branch and committed workspace identity agreed after each activation. |
| Branch-exclusive pins and editor contents | Main, left-sidebar, and right-sidebar pinned notes matched the target branch. Actual editors contained target content, including the shared path; removed source notes left the vault index. |
| Native save-and-switch key handler | Dispatched `saveAndActivate` and completed the branch/layout transition. |
| Core Workspaces disabled | Q++ continued to list and activate the product catalog in both directions. |
| Duplicate display names | Two `Alpha` labels retained distinct IDs; the duplicated Beta context activated `beta` and its own pinned notes. |
| Dirty native Markdown buffer | Pending content was saved; the checkout rejected before changing branch, target layout, active ID, or journal. Target saved context was unchanged. |
| Subsequent clean roundtrip | Beta and Alpha activated normally after the pending test content was restored. |

The report contains **11 observed controller calls** and **zero native core loader calls** during fixed selection. Observers returned the real promises unchanged. The probe used the actual Quick Switcher++ modal/chooser and installed Git backend; it did not substitute activation or restoration. Starting deferred fixture views were hydrated before testing, but target verification did not load or repair views after activation.

The final state was branch `alpha`, active ID `runtime-alpha`, no recovery journal, and a clean Git worktree. Native core enabled/catalog state was restored. Fixed report SHA-256: `a8458df4239216332940acdad6783748ad7e5327d78df77d5fff0e50e3a0f92a`.

## Manual command-palette verification

After the final native run, the command was opened from Obsidian's visible command palette and Beta was selected using keyboard navigation and Enter. The application displayed the pinned `beta-exclusive.md` note, Workspaces label `Beta`, and Obsidian Git label `beta`. A separate Git command confirmed `beta` and a clean worktree. The same command returned to Alpha, with its exclusive pinned note and labels `Alpha` / `alpha`; Git again confirmed a clean `alpha` worktree.

The final suggestion rows were also visually inspected: group/name occupy the primary line, and branch/description details appear beneath them using Quick Switcher++'s native content container.

## Automated checks and limits

`npm run check` passed TypeScript checking, **139 tests**, and the shipping build. The [automated run log](quick-switcher-automated.txt) is retained. New tests cover the integration's stable IDs, failures, fresh save intent, stale rows, application scope, both provider load orders, provider reload, modal invalidation, teardown descriptors, later wrappers, pending loads, partial-install rollback, and unsupported capabilities. Controller tests cover serialization, explicit saves in manual mode, same-workspace saves, failed saves, and a queued source changing before execution.

The native save-and-switch run confirms the actual upstream handler route. Save failure and queued-source race cases were exercised in automated tests, not by injecting failures into the native app. Provider reload/teardown edge cases have automated coverage; the native runs additionally loaded Workspaces both before and after Quick Switcher++. No macOS, Windows, physical mobile, other Quick Switcher++ releases, or theme matrix was exercised for this change.

Reproduction instructions are in [Development](../development.md#quick-switcher-regression-fixture).
