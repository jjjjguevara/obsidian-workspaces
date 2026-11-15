# Independent native performance review

**Review date:** 2026-11-15 UTC. **Verdict:** no remaining material correctness or data-safety blocker was found. Merge is acceptable as a partial optimization and measurement framework. The performance budget and actual Mac validation remain unmet, so issue #4 must remain open.

## Scope and independence

The reviewer used a separate detached worktree, read the repository instructions, specification, architecture and ADRs before inspecting the implementation, and recorded initial findings before consulting author validation reports. The reviewer did not author or modify production code. Native runs were performed after an explicit UI handoff, with no overlapping builds, tests or bulk evidence processing during the long comparisons.

The production comparison is base `6b3ae45589132a7c37da14e94a20a4668b2f28b9` against the candidate product declared as `d7399c2dd7b642e4e2c904bb55a02ad38039a67d`. The candidate bundle is `f4a862e7fd3c90786e4474a1e7c4a0041cc9d73d8595cda448cf64b10d530020`. Subsequent protocol and evidence changes leave those production bytes unchanged.

The six long comparisons used benchmark `394466fd2c824d4f2f49a46f1b7848c91303f27ccf77cdf03a34233bddf80431`, prepared from clean reviewer source `026efdb60c6862f091dd2e382589e881a50875bf`. Hardened smoke and safety runs used clean source `2aa992a352933267aaea748994a54db636de39ba`, benchmark `375711885e013bd1a0bc8acb48fe4e77c3d75ff87d03c821556d2d6cfe516792`, and safety probe `312307db21297eb859580186123c1f6f03ad02a280f7c449adf4f0f89cfaf652`. Full product, provider, runtime and source identities remain in the raw reports and [main evidence report](../README.md).

The final offline journal fix was independently reviewed at clean source `1baf59ed89f733af5972524d11033ef84118d447`. The published reproduction source is `3f0c0ed8df50efb1fb29b6bf402ad1084b2e9939`, tree `3d17bfaf840ecaabc0cfc6416fe8a6b8db151d82`; its exact tree and the additional bootstrap-preparer use of the reviewed safe-output helper were checked. This offline fix changes none of the recorded product or probe hashes.

## Production assessment

No remaining production correctness or data-safety finding was identified. The retained change is limited to returning the freshly observed source identity from the complete post-flush switch preflight and reusing it for a known bound cross-branch transition within the same repository. The initial source-binding check and the fresh checkout safeguard after view unload remain. Same-branch and unbound transitions keep their existing behavior.

The reviewer rechecked the final [controller](../../../../src/workspaces/controller.ts), [queued Git adapter](../../../../src/git/obsidian-git.ts), and [repository interface](../../../../src/git/backend.ts) against the base. Final native layout restoration is unchanged from the base; the incremental layout experiment was removed. The ordinary observed branch path loses one raw Git call, from 20 to 19. This is a reduction in work, without a demonstrated consistent end-to-end latency improvement.

## Independent native evidence

The reviewer completed two small-vault pairs in reversed order and one larger synthetic pair. All six reports have 150 preserved attempts: 100 measured alternating branch transitions, 20 same-branch controls, 20 unbound controls, and first-switch/warmup/setup/cleanup observations. Each pair used one renderer; the three pair PIDs were 11744, 17153 and 22217, with distinct native-session UUIDs.

All **900** completion snapshots were independently replayed against their requested endpoints. The audit checked actual controller target and settlement timestamps, native active file/leaf, complete file/editor/pin multisets, contents and index state, input release, native focus/Settings observations, loaded-product provenance, clean source context, final clean Alpha/null-journal state, report sample digests, and actual journal byte hashes. The [complete journals](../journals/) have exact header, checkpoint, ordered start/sample/observation records and final seals agreeing with the finalized reports. The final verifier independently [replayed all six journals and 900 samples](final-native-journal-replay.json). Source and target file-leaf workloads match within each pair, including editor multiplicity and sidebar ownership.

### Measured branch results

Times are milliseconds. Quartiles are chronological blocks of 25 measured branch transitions; percentile calculation uses nearest rank. The linked files preserve every unrounded observation.

| Report and order | Median | p95 | First 25 median | Last 25 median | Branch modals / 100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Small S1 baseline, first](../reports/final-small-s1-baseline.json.gz) | 425.918 | 624.671 | 421.734 | 482.769 | 15 |
| [Small S1 candidate, second](../reports/final-small-s1-candidate.json.gz) | 733.679 | 921.255 | 608.956 | 849.396 | 95 |
| [Small S2 candidate, first](../reports/final-small-s2-candidate.json.gz) | 404.629 | 594.413 | 329.785 | 460.208 | 10 |
| [Small S2 baseline, second](../reports/final-small-s2-baseline.json.gz) | 714.492 | 866.545 | 652.539 | 771.964 | 98 |
| [Larger baseline, first](../reports/final-scale-s1-baseline.json.gz) | 453.471 | 581.893 | 386.127 | 476.995 | 17 |
| [Larger candidate, second](../reports/final-scale-s1-candidate.json.gz) | 712.359 | 896.162 | 748.777 | 706.389 | 100 |

The small-vault order reversal is material: whichever build ran second was slower. Raw Git returned-promise interval unions grew from medians of approximately 227–236 ms in the first small runs to 495–499 ms in the second runs. Native restore medians stayed approximately 67–74 ms. In the larger pair, raw Git interval union medians were 230.499 and 449.794 ms, while native restore medians were 87.100 and 86.016 ms. These observations identify where additional elapsed time appears; they do not establish a causal memory, process-creation, provider, or instrumentation explanation.

Desktop idle blanking was observed after Small S2 had completed. For each larger long run, the reviewer made one benign pointer movement outside the app, without clicking or typing, at approximately 45 and 48 seconds after the respective starts. All recorded sample focus and Settings checks passed. Screenshot timing does not establish the exact instant at which idle blanking began after Small S2.

### Hardened protocol checks

The later writer change affects inherited safety/runtime report publication and deep diagnostic checkpoints. Normal benchmarking overrides the inherited safety writer, and its measurement boundary and append-only recorder are unchanged. Retaining the six long comparisons under their actual `394466fd…` identity is therefore justified. They do not certify the later probe's timing and cannot be relabeled as final Mac closure evidence.

The [hardened scale smoke](../hardened-protocol/hardened-scale-smoke.json.gz) and [hardened small smoke](../hardened-protocol/hardened-small-smoke.json.gz) each passed 34 complete attempts. A second independent agent replayed all **68** endpoints and measurement-environment observations, and checked each journal against its finalized report. These are correctness smoke runs with inadequate sample/session counts for closure; their measured branch medians/p95 were 916.106/1,045.659 ms on scale and 430.230/573.477 ms on small, with 20/20 and 2/20 branch modal openings.

Both [hardened scale safety](../hardened-protocol/hardened-scale-safety.json.gz) and [hardened small safety](../hardened-protocol/hardened-small-safety.json.gz) passed the exact ten required scenarios and match their respective hardened smoke's session, vault, workload, provider hashes and product bytes. Scale retained PID 22217. Small used a new PID 30157/session `98bcd6a7-a2fa-477f-95a9-4346f5d78efb`; it is separate from the earlier small long-run pairs. The earlier [Small S1 safety report](../safety/final-small-s1-safety.json.gz), with safety hash `14f3396a…`, remains historical same-session evidence for that long run.

The ten safety cases are:

1. Installed native plugins and disposable fixture readiness.
2. Test-only core names/layouts seeded for exact upstream reproduction.
3. Fixed source status contains only the workspace name.
4. Real Q++ Enter selects Beta and its pinned main/sidebar notes.
5. Real Q++ Enter selects Alpha and its pinned main/sidebar notes.
6. Q++ save-and-switch uses the atomic controller operation.
7. Q++ lists and switches product workspaces with core Workspaces disabled.
8. Duplicate display names select independent stable workspace IDs.
9. A dirty native editor rejects Q++ checkout without target-layout or recovery-journal drift.
10. Clean Q++ switching still works after that rejected checkout.

### Physical UI observations

After Small S1 safety and again after hardened scale safety, the reviewer opened the actual command palette, chose **Quick Switcher++: Open in Workspaces Mode**, and used native keyboard Enter selection. Two Down presses selected Beta from the Alpha/Alpha copy/Beta list; a subsequent invocation selected Alpha with Enter.

Whole-desktop observations showed the appropriate pinned `beta-exclusive` or `alpha-exclusive` main tab and note, corresponding branch-exclusive/sidebar filenames in the file explorer, and matching `Beta`/`beta` or `Alpha`/`alpha` workspace/branch status. Hidden sidebar editor contents and pins are additionally verified in the machine-readable native snapshots. The screenshot API emitted images into the UI observation record but did not expose supported saved image-file paths; no screenshot attachment or exported image artifact is claimed.

### Deliberate rejection attempts

The [Settings-open report](../failed-attempts/hardened-native-settings-open.json.gz) is a successful negative check: the workspace document was visible, both document and native-window focus were true, and both legacy main-window Settings booleans were false. The inspected lifecycle observation nevertheless recorded an open, connected, live separate Settings popout outside the main document. The probe rejected the first attempt before any Q++ command timestamp, selection timestamp or controller call. Initial and final state remained clean Alpha, `runtime-alpha`, revision 770, with no recovery journal. Its one failed attempt and complete journal are preserved.

An earlier [setup rejection](../failed-attempts/hardened-native-settings-rejection.json.gz) is also preserved. Focusing an exposed empty right sidebar selected that leaf, so initial readiness rejected “Wrong active pinned note” before any sample. This report contains no observed environment/provenance block; its journal header contains declared identities only. It is failed setup evidence and does not prove the Settings-specific guard. The reviewer then rearmed a distinct report and focused the pinned Alpha tab to perform the actual negative check.

## Review findings and verification

Material findings raised during the review led to these corrections:

- Safety acceptance now checks the exact scenario-name multiset and safety-probe/product/provider/session/vault provenance.
- Completion acceptance now checks the actual controller target, synchronous capture interval before the next frame, and a real native active leaf matching the observed active view/file.
- Native product reload proves newly evaluated plugin/controller/constructor identities while preserving provider instances, enablement and committed source state.
- Independent sessions require different renderer PIDs; a new UUID after renderer reload is insufficient.
- Native Settings/focus checks cover the inspected separate-window lifecycle and fail before timed selection when unsupported or invalid.
- The recorder appends each immutable sample once and streams the final report, replacing repeated growing-report serialization. Memory and recorder costs are observed outside switch timers.
- Changed-path counts disable rename detection. Source/target layout comparisons preserve duplicate editor counts, file paths, ownership regions, types and pins.
- Preparers, report publication, diagnostic checkpoints and closure output protect preexisting file aliases through validated paths, exclusive creation and atomic publication where applicable.
- The offline gate now reads actual portable journal files, validates compressed and raw hashes, and reconstructs the complete ordered attempts and final seal against the report. The preserved [synthetic counterexample](missing-journal-counterexample.md) demonstrated that the prior CLI accepted twelve reports with no physical NDJSON journals. Rerunning that original, unmodified fixture at the final fix exits 1 with [closure blocked](missing-journals-after-fix.json). The [original archive](missing-journal-counterexample.tar.gz) and all later synthetic corruption cases are test evidence, not native or Mac performance measurements.

The reviewer independently passed 61 focused recorder/closure/endpoint/reload tests at the recorder revision, 60 focused environment/output/closure/recorder tests at `026efdb…`, 51 focused writer/closure tests at `2aa992a…`, and [55 focused closure/journal tests](focused-journal-tests.log) at `1baf59ed…`. The original and hardened native reports were separately audited. All 40 original indexed native compressed artifacts matched both their compressed and decompressed byte counts and SHA-256 values.

A second independent agent exercised [28 semantic corruption cases](semantic-corruption-results.json) against the final journal verifier and full closure evaluator. Every case was rejected after consistently recomputing journal hashes and byte counts, sample byte totals, report digests and manifest hashes. Cases covered wrong header identities, missing/duplicate checkpoints, reordered or omitted attempts, start/raw/observation disagreements, contradictory footer counts or metadata, missing seals, trailing records, truncation, invalid UTF-8 and duplicate JSON keys. The valid synthetic control and both actual hardened smoke journals passed, preserving all 68 samples.

Five additional [real CLI checks](cli-journal-audit.json) accepted complete plain and gzip synthetic evidence and blocked a missing journal file, omitted references, and a consistently rehashed contradictory gzip footer. Published source `3f0c0ed8…` also passed the full [396-test CI job](https://github.com/jjjjguevara/obsidian-workspaces/actions/runs/43767863039/job/132976909097), including type checking and the shipping build. These checks close the reproduced evidence-gate acceptance gap without changing the unmet performance result.

## Replaying the long comparison

The [original independent analysis](independent-394-analysis.json) preserves the review-time observations and full component distributions. The portable [replay script](independent-394-analysis.mjs) accepts explicit checkout and evidence-root arguments, resolves unique raw or gzip artifact basenames, and validates the actual journals. It writes stdout by default; `--output` exclusively creates a new file and refuses to overwrite an existing one.

From the repository root:

```sh
node docs/validation/native-completion-budget/review/independent-394-analysis.mjs \
  --checkout "$PWD" \
  --evidence-dir "$PWD/docs/validation/native-completion-budget" \
  --output /tmp/independent-native-replay.json
```

The reviewer also ran it from outside the checkout against the packaged gzip reports/journals. The replay exactly matched the original observations and metrics; only the replay timestamp differed. Raw and compressed artifact hashes are listed in the [evidence index](../evidence-index.json).

## Performance acceptance remains open

The candidate does not meet median ≤100 ms, p95 ≤200 ms, p99 ≤300 ms, zero progress openings, or the requirement that every completion/next-frame opportunity stay below 500 ms. Actual Mac evidence is absent. The larger generated fixture describes a synthetic Linux workload, not the user's normal vault.

Merging the limited production optimization and measurement framework must not be treated as performance acceptance. Issue #4 must remain open until the [local Mac procedure](../../../performance/local-mac-closure.md) produces the required final-bundle pairs, real journals, exact safety evidence, passing unedited gate output, published final performance and independent review.
