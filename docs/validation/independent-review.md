# Second independent review and final native E2E evidence

## Result

**No blocking correctness findings remain in production source commit `bca767994231e1720c2eabc924bd3ba4b5f6453d`.** The independent reviewer did not author or modify production code. The reviewer inspected the implementation, reproduced two defects, verified the author's fixes, independently ran the complete automated gate, and operated the Linux Obsidian deployment to rerun the complete nine-check native fixture on the corrected bundle.

The full, unabridged output from this new native run is [native-e2e-final.json](native-e2e-final.json). It includes every check's timestamps and details, native layouts, editor contents, observed branches, inactive saved pins, deferred-leaf events, the expected dirty-checkout rejection, and final catalog state. This is fresh execution evidence; it does not reuse the earlier native reports.

## Exact implementation and execution

| Item                                  | Value                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Reviewed production source            | `bca767994231e1720c2eabc924bd3ba4b5f6453d`                                         |
| Original reviewed source              | `2ddb6aaf3925a79a81c0973998b4aa68bd3df10f`                                         |
| Built and installed `main.js` SHA-256 | `c5fb5829f892ffa818d7b7b9521ece22309e8ed08e48dc7df914ed207fd745fa`                 |
| Native fixture source                 | `tests/obsidian/runtime-probe.cjs`                                                 |
| Native fixture source SHA-256         | `3ac1c6111c4c8f0f795fd8b6d3813311466e8740179bc5755680de641bf567dc`                 |
| Raw native report SHA-256             | `ef5f4e2709c455981c9a16061aa21cc8aa29aa174351178bd782af712e2cc586`                 |
| Run ID                                | `3d0c0fb0-c1c7-49e2-b98e-a6b436460c3a`                                             |
| Platform                              | Linux desktop                                                                      |
| Obsidian                              | `1.15.1`, confirmed by the native window and runtime API                           |
| Obsidian Git                          | `2.43.0`, confirmed by the installed plugin and runtime probe                      |
| Started                               | `2026-11-13T23:56:24.776Z`                                                         |
| Finished                              | `2026-11-13T23:56:30.186Z`                                                         |
| Disposable vault                      | `/workspace/scratch/0a8d9baba8ea/runtime/reviewer-vault`                           |
| Native control store                  | `/home/agent/.local/share/obsidian-workspaces/01a438bd3d492a66883c3715/state.json` |

The reviewer prepared a fresh vault with `scripts/prepare-runtime-vault.mjs`, reusing the existing official Obsidian Git 2.43.0 assets. The previous test vault and its evidence were preserved. After the fixes were committed, the reviewer rebuilt the project, copied `main.js`, `manifest.json`, and `styles.css` into the fresh fixture, verified the installed and built `main.js` hashes matched, and enabled the fixture plugins through the native Obsidian UI. The hashes were checked again after the run.

The source checkout was clean at the start of review and clean at the final production commit before evidence files were added. The reviewer made no production edits, commits, pushes, or merge actions.

## Independent automated verification

On the final production commit, `npm run check` completed successfully:

- TypeScript checking passed.
- **118 tests passed; 0 failed, 0 cancelled, 0 skipped.**
- The shipping build passed and reproduced the bundle hash above.

The reviewer also independently ran the six regressions added for the two findings before the full final gate. All six passed. They cover rejection of blank own-product IDs without catalog mutation, generation of usable legacy IDs, checkout through a canonical vault alias, refusal of alias retargeting before the first inspection, and refusal of an unavailable repository root before the transaction callback.

The complete automated suite includes real temporary Git repositories; source/target branch coherence; queue ownership through restoration; flush/unload sequencing; disposal races; recovery and committed-write failures; import/path validation; native leaf and pin verification; and evaluation of the complete shipping bundle with Node loading forbidden on mobile.

## Full native E2E observations

The fixture runs inside the real Obsidian application. It invokes the installed Workspaces controller and Obsidian Git provider, reads actual Git branches, captures native layouts, inspects native Markdown editor data, and compares editor contents with disk. Its checks do not substitute mocked layout or Git implementations.

| Check                                    | Actual observation                                                                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed plugins and fixture readiness  | Empty workspace catalog, clean `alpha` branch, no Git remotes, initialized Obsidian Git 2.43.0, and an external control store.                                                                                                                  |
| Capture native alpha and beta layouts    | Captured branch-exclusive pinned main notes and pinned notes in both native sidebars. `shared.md` contains six bytes on each branch: `ALPHA\n` or `BRAVO\n`.                                                                                    |
| Import without activation                | Imported two bound records while Git remained on `beta` and the active workspace remained `null`.                                                                                                                                               |
| Activate alpha                           | Git reported `alpha`; active ID was `runtime-alpha`; `alpha-exclusive.md` was active and pinned; both sidebars held pinned `sidebar-alpha.md`; the background editor contained `ALPHA\n`.                                                       |
| Activate beta                            | Git reported `beta`; active ID was `runtime-beta`; `beta-exclusive.md` was active and pinned; both sidebars held pinned `sidebar-beta.md`; the background editor contained `BRAVO\n`.                                                           |
| Return to alpha                          | Git, active identity, main/sidebar pins, and visible editor data returned to the alpha context.                                                                                                                                                 |
| Flush dirty editor and reject checkout   | The editor change was saved to disk. Beta activation rejected with “Commit or otherwise resolve all tracked and untracked changes before switching branches.” Git stayed on `alpha`, active ID stayed `runtime-alpha`, and no journal remained. |
| Dirty same-branch layout activation      | Activated a duplicate alpha workspace while retaining the pending note edit in the native editor and on disk. Git stayed on `alpha`; the edit remained uncommitted.                                                                             |
| Restore fixture content and switch again | Restored the original note, verified a clean worktree, switched to beta and back to alpha, and verified the final alpha pins, native editor data, committed active identity, and cleared journal.                                               |

For each verified workspace, the runtime assertions confirmed the requested note was active, all inspected Markdown leaves were loaded, native editor contents matched expected text and disk, the removed other-branch note was absent from the vault index, and inactive workspace snapshots retained their own branch-exclusive pins. The raw report records the layouts and view states used for those assertions.

Real deferred leaves were observed for `sidebar-alpha.md` and `sidebar-beta.md`. The background `shared.md` contents were verified after switching, including equal-length content changes; this run did **not** observe `shared.md` itself becoming deferred.

The reviewer observed the native “Workspaces native validation passed” notice, the pinned `alpha-exclusive` tab, and final status indicators showing Workspaces `Alpha · alpha` and Git `alpha`. After completion, an independent shell read of the disposable repository corroborated branch `alpha`, an empty porcelain status, and no remotes. The final recorded catalog has active ID `runtime-alpha`, revision `26`, and `journal: null`.

## Findings resolved during this review

1. **P2: blank IDs in own-product imports.** The original validator accepted an empty record/key ID. Activating it committed `activeId: ''`, after which saving failed because the controller interpreted it as no active workspace. The failure survived serialization/reload. The author fixed validation in `src/storage/migrations.ts`; own malformed catalogs now fail before mutation, and legacy invalid IDs receive fresh identities. The reviewer inspected the fix and independently ran the regression coverage.
2. **P2: vault aliases rejected as repository changes.** The original adapter compared a lexical provider root with Git's physical root. A vault opened through a directory symlink therefore failed inspection despite referring to the same repository. The author fixed `src/git/obsidian-git.ts` to pin canonical identity before the callback, preserve lexical/provider identity checks, reject alias retargeting, fail closed when resolution fails, and return canonical roots. The reviewer inspected the fix and independently ran real-Git regressions.

No additional concrete blocker was found in source/target context handling, supported editor flush and unload order, provider queue ownership, recovery/persistence failures, native/core sidebar handling, imports/path checks, or mobile load boundaries. The specification, architecture, and four ADRs were read as the adopted design constraints.

## Limits

- Native execution covers Linux, Obsidian 1.15.1, and Obsidian Git 2.43.0. Windows, macOS, physical mobile devices, and Obsidian 1.13/1.14 were not independently exercised.
- This new native run is the complete nine-check branch/pin/content/dirty-buffer fixture. The separate Backlinks, Outgoing links, Outline, and manual-menu evidence in `native-final.json` predates the two validation/path fixes and is recorded evidence, not a rerun claimed by this reviewer.
- Recovery and process-restart behavior were exercised with automated injected failures. Native process termination at every journal boundary and power-loss durability were not tested.
- Native binary/media and floating-window acceptance runs were not performed; the relevant state/readiness contracts have automated coverage. Arbitrary community-plugin editors remain outside the supported universal save lifecycle.
- The Obsidian Git queue cannot serialize unrelated external Git processes. Integration depends on the inspected internal Obsidian Git 2.43.x contract.

The source commit, bundle identity, complete raw native evidence, and these limits support merging this scoped initial implementation.
