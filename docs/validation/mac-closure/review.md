# Independent review of the Mac closure evidence

The reviewer is an AI agent that did not collect the evidence and did not write the report. Date: 2026-11-16.

**Verdict: SUPPORTS WITH CORRECTIONS.** The blocked decision and all table numbers are correct. The operation disclosures, the budget wording and the suitability flag are not.

## What I verified

- **Gate.** Rerun: exit 1, `blocked`, the same 7 failures as `closure-result.json`.
- **Hashes.** 26 of 26 manifest SHA-256 values match.
- **Statistics.** My own code recomputed every table value from the 12 raw reports (12 session rows, 4 pooled rows, modals, first switches, Git calls). No mismatch.
- **Identities, 12 reports.** Platform, versions, all bundle hashes, clean source `a2d738a`, PID and session per pair, 6 distinct pairs, report order, 100 + 20 + 20 samples, recorder, tracing off, final state. All correct.
- **Endpoints, journals, safety.** A scratch copy of the gate, with its progress, 500 ms and budget conditions made non-fatal, passed all other checks: 1,800 of 1,800 endpoints, 12 journals, both safety reports (10 of 10, candidate bundle, S3 renderers). 50 of 72 budget checks fail.
- **Diagnostics.** Both diagnostic tables match the files. The traced runs used bundle `f4a862e7`.

## Findings

1. **Undisclosed activity during every timed report.** `README.md` "How the run was operated"; `operator/closure.sh` lines 65 and 85 to 87. Confirmed by timestamps and the process table.
   - The script made an Obsidian CLI `eval` call into the fixture renderer 3 to 8 s after each start, during measured samples, in 12 of 12 reports. No run stopped. Tooling finding 4 ("A CLI call ... ends the run") is false.
   - `wait_report` started a Node process every 3 s during each report.
   - The script took focus with `app.focus({steal:true})`. The README omits this.
   - A third renderer (PID 44264, started 08:25:57 UTC, alive at 09:16 UTC) existed through the run. Obsidian's vault list marks only `tyo-bit` as open. The README names only two windows.
   - The same bundle and fixture gave medians of 363 to 367 ms (branch) and 105 to 112 ms (unbound) in short normal-mode runs, but 402 to 438 ms and 133 to 140 ms in the acceptance reports. The decision does not change.

2. **Budget reasoning: conclusion supported, evidence stated incorrectly.** `README.md` "Decision" and "What this means for the budget". Confirmed by computation.
   - Supported: in the acceptance reports, restore plus both writes of an unbound switch have a per-sample median of 111 to 113 ms. None of 264 unbound samples is at or below 100 ms.
   - Understated: "about 25 ms" for checkout applies only to the small fixture. On the representative fixture, candidate checkout is 70 to 73 ms and vault readiness 101 to 108 ms.
   - Overstated for layout-only switches: short-run unbound medians were 104.6 and 111.9 ms.
   - The traced control medians have 6 samples each. The text adds stage medians, which ADR 0005 prohibits.

3. **`suitabilityConfirmed: true` is not defensible.** `closure-manifest.json`. Judgment. The disclosed mismatches (Canvas and Excalidraw views, 14 plugins) can affect layout restore, the largest fixed cost. No record of the counts is archived. An easier fixture is safe for a blocked result, not for a later pass. Set it to `false`.

4. **Runtime probe did not run on the final candidate.** `README.md` "Correctness and safety". Inferred from timestamps. The runtime reports are from 08:33 to 08:34 UTC and contain no product hash. Commit `a2d738a` is from 08:42:57 UTC. Bundle `098d3854` was installed at 08:35.

5. **Gate coverage.** `README.md` "Decision". The gate stopped each session at its first failed sample. It did not check journals, pairs, budgets or safety reports. The README's 1,800 count is the probe's own label. Confirmed by my rerun.

6. **Missing files.** `README.md` "Evidence". Confirmed by file listing. `SHA256SUMS` does not exist. The failed `diag2-main` report, the failed small setup safety report and the rough-profile outputs are not archived.

7. **Minor.** Confirmed by computation. 13 of 240 unbound samples had Git calls. "Inside run-to-run variation" is fair: pooled difference −4.2 ms, 95% interval −21.6 to +13.2 ms.

## Not checked

Official-release origin of provider assets. The `tyo-bit` counts. Two of four screenshots. The cause of the slowdown.
