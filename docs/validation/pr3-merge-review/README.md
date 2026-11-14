# PR 3: fresh independent merge review

**Review date:** 2026-11-13 (America/Monterrey). Raw timestamps use UTC.

**Recommendation:** merge as a partial performance improvement under the user's current instruction to review and merge. No material correctness blocker was found in this review. **Near-instant, reliably modal-free switching remains an unmet objective.** This recommendation does not declare that objective complete.

This is a fresh independent AI subagent review. The reviewer did not author the PR or modify production code. It is not a separate human or GitHub-user approval. GitHub operations used the CLI. The merge owner is responsible for checking the final evidence commit and its CI before merging; no release publication is requested.

## Independence and identity

The [initial blind findings](initial-blind-findings.md) were recorded before opening the PR description, earlier review comments, or author/reviewer conclusions under `docs/validation`. The reviewer first read AGENTS.md, the specification, architecture, and all four adopted ADRs, then inspected the production diff and tests. Two delegated blind code passes separately examined Git safeguards and native-probe validity without reading prior conclusions.

| Item | Reviewed identity |
| --- | --- |
| Base commit | `f061347313c031d03b1491a9072717c7ba80b15d` |
| Reviewed PR head | `27c7a8d56fa708036248ffcc63120b243703fff4` |
| Freshly built and installed Workspaces SHA-256 | `9dee2cbb8b25f768f81d3b94ec1a7c57ddae55267ae29de459ad00a8d94d3400` |
| Native host | Linux Obsidian 1.15.1 |
| Installed Git provider | Obsidian Git 2.43.0 |
| Installed chooser | Quick Switcher++ 6.3.0 |
| Fresh native run | `939f0eaa-9c16-4cfc-8504-5b4bf4f3a75a` |
| Fresh native interval | `2026-11-14T04:37:49.833Z`–`2026-11-14T04:37:58.048Z` |

The detached review worktree was isolated from the author's checkout. Workspaces and the native probe were disabled through the fixture's native settings before the freshly built files were installed/rearmed. Workspaces was then enabled again before the new probe ran. The installed bundle hash matches the isolated build and the native report. Fixture paths, branch commit IDs, and all three installed artifact hashes are in [provenance.json](provenance.json).

## Correctness assessment

No actionable correctness regression was found in the reviewed changes:

- **Git safety:** `checkout()` retains fresh final validation after view unload. Identity-only observations do not assert cleanliness. Source-tree/index union plus pinned-commit raw diff retains complete target coverage, including unchanged paths; ignored collisions and protected runtime paths remain guarded. Parallel reads and the explicit branch-indicator refresh promise drain before provider queue release. Native asynchronous refresh-event listeners are outside this returned-promise guarantee, as recorded in ADR 0003.
- **Recovery:** the complete prepared journal is durable before unload/checkout. Diagnostic phases retain the persisted revision; final identity is committed only after restoration and verification. Actual process-exit tests cover interruption before checkout, after checkout, and before final persistence under both save policies.
- **Native ownership:** independent unloads/hydrations drain on failure; editable views of the same file remain ordered. Event wakeups latch changes during asynchronous probes and do not replace disk/index/stat/content readiness. Optional native reconciliation remains version-scoped and falls back to the ordinary checks.
- **Input:** protection precedes the delayed modal, captures native activation events, and covers newly opened windows. The prior trusted-click regression report was audited after the blind checkpoint; it identifies the same final bundle. This fresh native run did not repeat the isolated input-guard experiment or native popout experiment.

These are scoped review findings, not a guarantee for every host, vault, or community editor.

## Independently reproduced verification

### Full repository gate

`npm ci` and `npm run check` passed in the isolated checkout: typecheck, **272 tests passed, zero failed/skipped**, and build. `git diff --check` also passed. The full output is attached in [npm-run-check.txt](npm-run-check.txt). Node was `v24.22.1`; npm was `11.9.0`.

The inspected GitHub head was mergeable with a successful `Check / check` run. `gh pr checks --required` reported no configured required checks; this does not waive the repository's verification gate. [github-gates.json](github-gates.json) records this observation before the forthcoming evidence commit.

### Fresh native end-to-end run

The [complete fresh native report](quick-switcher-fresh.json.gz) passed **10/10 scenario checks**, using the actual registered Quick Switcher++ command and native chooser methods, installed Workspaces controller, and installed Git backend:

- Alpha → Beta → Alpha with branch-exclusive pinned main notes and pinned notes in both sidebars.
- Current `shared.md` bytes checked on disk and in every corresponding hydrated Markdown editor.
- Save-and-switch routed through the serialized controller operation.
- Product selection with core Workspaces disabled.
- Duplicate display names selected by stable workspace ID.
- A real native Markdown editor edit blocked checkout; Alpha identity, pins, and journal remained intact, the target snapshot was unchanged, and the pending text was flushed and preserved.
- A clean roundtrip succeeded after the rejected dirty checkout.

The raw dirty call rejected with “Commit or otherwise resolve all tracked and untracked changes before switching branches.” The report ended on actual `alpha`, `runtime-alpha` active, journal `null`, **empty `finalGitStatus`**, and no error or cleanup error.

The reviewer separately walked every raw file-leaf set: **14 captured snapshots** contain exactly the expected four Markdown leaves and pin flags, with no stale source file references. Alpha also retains native read-only Backlinks, Outgoing links, and Outline references to its current note; these are not extra editable notes. The probe itself checks required pin presence; the complete-set audit is independently implemented in [audit-native-evidence.py](audit-native-evidence.py), with results in [evidence-audit.json](evidence-audit.json).

### Visible command-palette and physical Enter path

After the probe completed, the reviewer used native desktop keyboard input to open the command palette, invoke **Quick Switcher++: Open in Workspaces Mode**, select Beta with the arrow keys and Enter, and return to Alpha through the same route. The visible note, main pin, branch label, and Workspaces label agreed in both directions. Both Beta sidebar note tabs were also displayed and inspected.

[Command palette](command-palette.jpg) · [actual workspace chooser](quick-switcher-chooser.jpg) · [Beta main and both sidebar notes](physical-beta-pins.jpg).

Independent Git and live native `workspace.json` observations are attached for [Beta](physical-beta.json) and the [returned Alpha](physical-alpha.json). Both have clean Git status, the correct branch, the expected four Markdown file leaves/pins, and only the current branch's note files on disk. These physical observations are separate from the automated chooser-method calls.

## Raw historical evidence audit and remaining performance work

All archived report-manifest hashes and prior independent-review evidence hashes verified. The reviewer recomputed timings from each raw sample's selection and controller-completion timestamps, checked all 42 correctness snapshots in each listed benchmark, and kept bundle identities separate. No broad latency study was rerun for this merge review.

| Historical report | Product bundle prefix | Measured branch n | Median / p95 | Progress opened |
| --- | --- | ---: | ---: | ---: |
| Matched baseline | `62a226c43d5a` | 20 | 1426.540 / 1679.286 ms | 20/20 |
| Matched performance checkpoint | `e2f1c9ec72f6` | 20 | 522.178 / 735.477 ms | 10/20 |
| Prior independent final-build run | `9dee2cbb8b25` | 20 | 563.472 / 680.750 ms | 14/20 |

The final row matches this review's freshly rebuilt product bundle. It supports the documented partial improvement and the unresolved latency/modal objective. It does not support a near-instant or reliably modal-free claim. Earlier draft recommendations remain historical review records; the user's current explicit instruction is to review and merge the partial improvement.

## Evidence boundaries

- The automated native report invokes actual chooser/shortcut methods; the separate physical roundtrip verifies real desktop command-palette/Enter input. The fresh dirty-edit scenario was automated inside the native app, not manually typed.
- Text freshness is verified through disk bytes and every loaded Markdown buffer, not an independent direct `vault.cachedRead()` observation in this probe.
- The probe explicitly checks source-only main-note removal from the native index. Removed sidebar notes are absent from all live file-leaf sets and opposite-branch disk observations; a separate sidebar-index inventory was not captured. Production readiness checks and unit coverage retain that condition.
- Native snapshots establish controller identity/journal. The shell could not directly access the native app's separate home-directory control store; physical snapshots therefore do not claim a separate persisted-store read. Filesystem persistence/recovery is covered by the independently run repository tests.
- Fresh native testing covers this disposable Linux fixture and the stated plugin versions. Native Windows/macOS/mobile, large-vault scaling, unsupported community editors, and fresh native popouts were not exercised.

Reproduce the attached audit without launching Obsidian:

```sh
python docs/validation/pr3-merge-review/audit-native-evidence.py
```
