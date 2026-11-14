# Git process census

Supplemental analysis of [the final diagnostic trace](optimized-final-deep.json.gz), run `f58ef562-58b6-407c-93de-d8c3d92778a6`, product `e2f1c9ec…`, captured on 2026-11-14. Measured samples 2 (Alpha → Beta) and 3 (Beta → Alpha) each contain **22 subprocesses and 20 `git.raw` requests**. These are two instrumented observations, not a latency distribution. The [matched normal result](README.md#matched-performance-comparison) remains 522.178 ms median, 735.477 ms p95 and progress in 10/20 branch switches; the intended latency/modal outcome remains unmet.

## Per-switch accounting

Ordinals below are each sample's `process.spawn` spans in start order. Both samples have the same sequence. The [controller](../../../src/workspaces/controller.ts) defines the observation boundaries; the [adapter](../../../src/git/obsidian-git.ts) defines the reads and checkout. All preserved process arguments include the provider's `-c core.quotepath=off` prefix.

| Process ordinal | Purpose | Processes | Raw requests |
| --- | --- | ---: | ---: |
| 1 | Initial source repository/branch identity | 1 | 1 |
| 2 | Identity after outgoing editor flush | 1 | 1 |
| 3–8 | Preflight before journal preparation and view unload | 6 | 6 |
| 9–14 | Authoritative preflight inside checkout, after unload | 6 | 6 |
| 15 | Provider-native `checkout <branch> --progress` | 1 | 0 |
| 16 | Verify successful checkout identity | 1 | 1 |
| 17 | Provider background read; commit-timestamp `log` is inferred | 1 | 0 |
| 18 | Branch-label current-branch read; `symbolic-ref` is inferred | 1 | 1 |
| 19 | Branch label's `branch --list --no-color --format=%(refname)%00%(upstream:short)` | 1 | 1 |
| 20 | Provider background current-branch read for unpushed count; `symbolic-ref` is inferred | 1 | 1 |
| 21 | Provider background `for-each-ref --format=%(push) refs/heads/<branch>` | 1 | 1 |
| 22 | Final identity after file readiness and layout restoration | 1 | 1 |
| **Total** | **12 guard reads + 4 identity reads + checkout + 5 presentation/background processes** | **22** | **20** |

Each identity query is `rev-parse --show-toplevel --symbolic-full-name HEAD`. No identity fallback or failure-diagnostic full inspection occurred in these samples.

Each six-read safeguard consists of the following. The first four reads are submitted concurrently, then the last two follow validation; every batch drains with `allSettled` before an error is returned.

| Ordinals, first / final guard | Read and purpose | Freshness requirement |
| --- | --- | --- |
| 3 / 9 | `for-each-ref` with exact local ref and full object ID | Fresh destination ref; also proves valid existing branch syntax. |
| 4 / 10 | Porcelain-v2 status with branch, all untracked files, submodule changes and traditional ignored entries | Fresh branch/source ID, dirtiness, conflicts and ignored paths. |
| 5 / 11 | `rev-parse --show-toplevel --show-prefix` plus eight `--git-path` values | Fresh repository/cwd mapping; canonical-root and marker-existence filesystem checks follow. |
| 6 / 12 | `config --type=bool --default=false --get submodule.recurse` | Fresh effective configuration. |
| 7 / 13 | `ls-files --with-tree=<sourceOID> --full-name -z -- :/` | Source-commit paths **plus mutable index paths**; the complete output cannot be cached as immutable. |
| 8 / 14 | `diff --raw -z --no-abbrev --no-renames --no-ext-diff --no-relative --ignore-submodules=none <sourceOID> <targetOID> --` | Commit comparison used to reconstruct target paths and protect runtime files and ignored collisions. Conditional reuse requires more than equal OIDs. |

The eight markers are `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply`, `sequencer`, `BISECT_LOG` and `index.lock`. Marker filesystem checks do not create Git processes. Newline-path fallback, missing-ref syntax diagnostics, detached/unborn cases, recovery and checkout failure can add reads; 22 is the observed successful-path count, not a universal maximum.

## Attribution limits

The [probe's `safeGitArguments`](../../../tests/obsidian/switch-benchmark.cjs) does not retain `log` or `symbolic-ref` arguments. Process 17 is `2:265` / `3:255`; processes 18 and 20 are `2:284`, `2:287` / `3:274`, `3:277`. Their exact argv and process-to-raw correlations are absent. The two omitted raw-command spans are `2:267`, `2:286` / `3:257`, `3:276`.

The inferred purposes agree with the inspected provider's [status-bar refresh](https://github.com/Vinzent03/obsidian-git/blob/8d1144aef2d41ffca6245a60199656e7a0c5ab17/src/statusBar.ts), [branch-label display](https://github.com/Vinzent03/obsidian-git/blob/8d1144aef2d41ffca6245a60199656e7a0c5ab17/src/ui/statusBar/branchStatusBar.ts), and [`getLastCommitTime`, `branchInfo`, `getUnpushedCommits` and `getPushTarget`](https://github.com/Vinzent03/obsidian-git/blob/8d1144aef2d41ffca6245a60199656e7a0c5ab17/src/gitManager/simpleGit.ts). Source structure, timing and output byte counts support those associations; the trace does not establish their exact asynchronous ancestry.

The adapter drains its returned presentation promise before releasing the repository scope. The provider's [refresh-event listeners](https://github.com/Vinzent03/obsidian-git/blob/8d1144aef2d41ffca6245a60199656e7a0c5ab17/src/main.ts) can start background promises that `workspace.trigger()` does not return. Those observed processes finish before the final identity read here; this does not prove that all provider background work is generally owned by the adapter's promise.

## Duplicate work and bounded opportunities

- **Two safeguards:** Their commands and source/target OIDs match within each sample, but they straddle unloading, which may save files. Status, refs, index, configuration, operation state and root protections must remain authoritative after unload. Removing that second guard would change the safety contract.
- **Immutable object results:** A bounded reuse of commit-tree/comparison results could avoid repeated work when fresh source/target OIDs match. Full OIDs alone do not prove equivalent Git output: replacement refs and effective object-lookup/configuration context can change interpretation. Preserve repository identity and those semantics, and retain a fresh index read. No such cache is implemented or benchmarked here.
- **Identity overlap:** The post-flush identity and ensuing preflight both read root/branch information. A future API could return the preflight's verified identity and combine these observations, provided branch-change decisions and source validation still occur before journaling/unloading. Identity cannot simply be reused across flush, checkout or restoration.
- **Presentation duplication:** Current branch is read after checkout, by the label, by unpushed-count refresh, and after restoration. The first and last are correctness checks at different boundaries. A provider-supported refresh accepting verified identity, coalescing background reads, and returning a complete drain promise could reduce presentation work. The existing `display()` interface reads the entire branch list; directly changing provider state is not an equivalent optimization.

Normal Git query consolidation through the provider's existing `raw` transport is the supported direction for further process-count reduction. It must preserve executable/environment/configuration handling, fail-closed parsing, queue ownership and the provider's command guards. Parallel submission already exists and does not remove synchronous renderer process creation. A different execution transport requires a compatible provider capability; no supported worker bridge is established, and the [native worker probe](README.md#worker-transport-feasibility-blocked-by-the-host) produced zero samples. The trace measures renderer-observed spawn intervals, not their kernel/CPU cause, and supplies no guaranteed savings for these unimplemented options.
