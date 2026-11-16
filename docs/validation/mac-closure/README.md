# Workspace switching: local Mac closure run

**Date:** 2026-11-16 UTC. **Runbook:** [local Mac closure](../../performance/local-mac-closure.md). **Performance acceptance:** [issue #4](https://github.com/jjjjguevara/obsidian-workspaces/issues/4).

## Decision

**The closure gate is blocked. The performance budget is not met on this Mac.** The gate ran twice on the complete evidence set and exited with code 1 both times. The first run, with the workload declared suitable, stopped each session at its first failed candidate sample: progress opened, or a switch did not reach a frame opportunity within 500 ms. It reported seven failures and did not evaluate the journals, pairing, budgets or safety reports ([pre-review result](operator/pre-review-closure-result.json)). The independent review rejected the suitability declaration. The final manifest therefore sets `suitabilityConfirmed` to false, and the gate stops at that condition before it reads a session. That unedited output is [closure-result.json](closure-result.json). The [independent review](review.md) made those conditions non-fatal in a scratch copy of the gate: all other checks passed, and 50 of 72 budget checks failed.

| Scope                  | Candidate branch switch, pooled (300 samples) |             Budget |
| ---------------------- | --------------------------------------------: | -----------------: |
| Small fixture          |   415.3 ms median, 527.7 ms p95, 573.2 ms p99 | 100 / 200 / 300 ms |
| Representative fixture |   568.9 ms median, 654.6 ms p95, 725.3 ms p99 | 100 / 200 / 300 ms |

Progress opened in every candidate report: 2 to 8 times in the 100 measured branch switches of each small-fixture report, and 64 to 86 times in each representative report. The candidate is not consistently faster than the baseline: its pooled median is 14.8 ms lower on the small fixture and 39.2 ms higher on the representative fixture. In four of the six pairs, the build that ran second in the renderer was the slower one.

The budget is also not met without Git. A switch between unbound workspaces uses no Git process and has a pooled median of 136.4 to 136.9 ms. Short traced runs put the two durable state writes at 37 to 41 ms and native layout restore at 54 to 57 ms for such a switch. A branch switch adds one Git checkout process: about 25 to 32 ms on the small fixture and 70 to 73 ms on the representative fixture, where vault readiness adds 101 to 108 ms. In the acceptance reports, native restore plus the two writes of an unbound switch have a per-sample median of 111 to 113 ms, and none of the 264 unbound samples (measured and warmup) is at or below 100 ms. These required parts are above 100 ms before any checkout safeguard runs. See [Where the time goes](#where-the-time-goes).

All 1,800 completion observations passed endpoint validation; the independent review confirmed that count with the gate's own validator. Both ten-scenario safety runs passed. Correctness is not in question; latency is.

## Product, probe and host identities

| Item                                                | Identity                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| Baseline source                                     | `6b3ae45589132a7c37da14e94a20a4668b2f28b9`                         |
| Baseline `main.js`                                  | `9dee2cbb8b25f768f81d3b94ec1a7c57ddae55267ae29de459ad00a8d94d3400` |
| Candidate and protocol source                       | `a2d738afaefa38f3e3847963ab768ca83fdeca2f`                         |
| Candidate `main.js`                                 | `f4a862e7fd3c90786e4474a1e7c4a0041cc9d73d8595cda448cf64b10d530020` |
| Benchmark bundle                                    | `375711885e013bd1a0bc8acb48fe4e77c3d75ff87d03c821556d2d6cfe516792` |
| Safety probe bundle                                 | `312307db21297eb859580186123c1f6f03ad02a280f7c449adf4f0f89cfaf652` |
| Obsidian Git 2.43.0 `main.js` (official release)    | `58beb0981875c672fc83350e3b1f20db6ca1df3ca2047a25f49190b1e31e2443` |
| Quick Switcher++ 6.3.0 `main.js` (official release) | `6746dad3d6b132698b04c2a10ea0c2f71c03c8b5af7bec753ca76319c72e3f23` |

The candidate source differs from merged `34d12972da17275000d9bed662afa7bacb7352c5` only in the runtime-probe preparer and one test. Its product bundle is byte-identical to the build that PR #5 merged. Both builds and both probe bundles reproduce the hashes that the Linux record documents.

Host: Apple M2, 8 cores, 24 GB, macOS 27.3 (26C5035r), arm64. Obsidian 1.15.1 (installer 1.15.1), Electron 43.8.9, Node 24.22.1, Chrome 150.0.7871.250. The fixture window was 1024 × 800 at device-pixel ratio 2, default dark theme, no CSS snippets. Git is Homebrew Git 2.52.0. Repository checks on the candidate source with Node 24.21.0: type checking, 397 tests and the build passed ([log](operator/npm-run-check-a2d738a.txt)).

## Workloads

| Profile        | Tracked files per branch | Changed paths | Generated notes                                         | Markdown editors |
| -------------- | -----------------------: | ------------: | ------------------------------------------------------- | ---------------: |
| Small          |                        4 |             5 | None                                                    |                4 |
| Representative |                      194 |            85 | 150 unchanged and 40 unique to each branch, 26 KiB each |                4 |

Each fixture has a pinned branch-exclusive main note, a shared note whose content differs between branches, and a pinned note in each sidebar.

The representative sizes come from counts in the `tyo-bit` vault, taken without reading note contents: 108 to 136 tracked files per branch across six branches, 0 to 69 changed paths between branch pairs, 98 tracked Markdown notes with 13 KiB median and 25.6 KiB mean size, and one or two main-area views in each saved workspace with no pinned sidebar notes. The fixture meets or exceeds each count, but it does not reproduce the view types or the plugin load of normal use, so the manifest sets `suitabilityConfirmed` to false. The [count record](operator/working-vault-counts.md) lists the figures and the commands that produced them.

Remaining mismatch with normal use: the `tyo-bit` layouts hold Canvas and Excalidraw views, and that vault runs 14 community plugins. The Markdown-only fixture does not reproduce those. The `tyo-bit` copies of Obsidian Git and Quick Switcher++ report the same versions but differ from the official release files by 18 bytes each. Other vaults on this Mac were not assessed.

## Measured performance

Times are milliseconds from selection to settlement of the original controller promise. Each report has 100 measured branch switches, 20 same-branch and 20 unbound controls, plus first-switch, warmup and cleanup samples: 150 samples. Control cells show median / p95 / p99. The modal column counts all 150 samples. [summarize.mjs](summarize.mjs) regenerates these tables and [summary.json](summary.json) from the archived reports.

| Session           | Order  | Build     | Branch median / p95 / p99 |     Min–max |           Same-branch |               Unbound | Modals | First switch |
| ----------------- | ------ | --------- | ------------------------: | ----------: | --------------------: | --------------------: | -----: | -----------: |
| Small S1          | First  | Baseline  |     405.9 / 484.9 / 498.1 | 351.6–517.7 | 177.0 / 200.5 / 274.6 | 127.7 / 142.4 / 144.6 |      0 |        460.8 |
| Small S1          | Second | Candidate |     416.7 / 517.0 / 544.8 | 331.1–573.2 | 176.1 / 190.3 / 191.1 | 140.2 / 240.1 / 282.4 |      2 |        430.4 |
| Small S2          | First  | Candidate |     437.5 / 554.3 / 587.0 | 352.2–633.0 | 179.4 / 194.3 / 200.5 | 137.3 / 151.6 / 242.9 |      8 |        498.7 |
| Small S2          | Second | Baseline  |     437.9 / 504.8 / 556.0 | 351.2–567.1 | 182.7 / 196.5 / 197.6 | 138.7 / 193.1 / 282.6 |      3 |        470.8 |
| Small S3          | First  | Baseline  |     454.0 / 555.6 / 576.6 | 387.7–583.8 | 181.3 / 194.1 / 195.1 | 136.9 / 151.4 / 158.6 |     10 |        509.2 |
| Small S3          | Second | Candidate |     402.1 / 521.4 / 548.7 | 343.6–562.2 | 186.3 / 201.3 / 203.8 | 133.3 / 142.9 / 143.4 |      4 |        370.0 |
| Representative S1 | First  | Baseline  |     503.3 / 571.9 / 609.7 | 429.2–682.1 | 169.4 / 250.7 / 261.9 | 132.4 / 140.2 / 146.1 |     23 |        545.3 |
| Representative S1 | Second | Candidate |     557.3 / 647.9 / 675.5 | 445.8–867.5 | 179.0 / 205.3 / 212.9 | 138.2 / 151.3 / 403.9 |     65 |        427.0 |
| Representative S2 | First  | Candidate |     559.7 / 639.1 / 725.3 | 464.2–730.7 | 174.2 / 182.9 / 292.1 | 127.7 / 131.7 / 134.1 |     71 |        568.6 |
| Representative S2 | Second | Baseline  |     556.7 / 624.3 / 666.8 | 465.0–767.5 | 181.9 / 194.7 / 201.4 | 139.6 / 178.7 / 276.3 |     71 |        491.0 |
| Representative S3 | First  | Baseline  |     537.8 / 647.0 / 690.9 | 468.2–708.5 | 177.9 / 195.6 / 201.4 | 135.5 / 142.5 / 143.6 |     60 |        565.2 |
| Representative S3 | Second | Candidate |     587.8 / 667.7 / 700.8 | 483.0–757.4 | 204.3 / 217.6 / 425.7 | 141.9 / 152.4 / 154.7 |     90 |        606.8 |

| Pooled, 300 branch and 60 + 60 control samples | Build     | Branch median / p95 / p99 |           Same-branch |               Unbound |
| ---------------------------------------------- | --------- | ------------------------: | --------------------: | --------------------: |
| Small                                          | Baseline  |     430.1 / 531.6 / 567.1 | 180.2 / 196.5 / 274.6 | 135.2 / 158.6 / 282.6 |
| Small                                          | Candidate |     415.3 / 527.7 / 573.2 | 178.7 / 200.5 / 203.8 | 136.9 / 158.1 / 282.4 |
| Representative                                 | Baseline  |     529.7 / 627.5 / 682.1 | 177.2 / 201.4 / 261.9 | 135.2 / 155.2 / 276.3 |
| Representative                                 | Candidate |     568.9 / 654.6 / 725.3 | 181.0 / 212.9 / 425.7 | 136.4 / 151.3 / 403.9 |

Baseline branch switches used 20 raw Git calls and candidate switches 19. One sample in each report except Small S1 baseline had two more calls from the provider's periodic refresh. The first switch showed progress in four representative reports (S1 baseline, S2 candidate, S3 baseline, S3 candidate). The branch next-frame median was about 3 to 8 ms above the completion median in every report.

### Sessions and memory

| Pair              | Renderer PID | Native session | Order                | Branch-sample renderer RSS, first → last (MiB) |
| ----------------- | -----------: | -------------- | -------------------- | ---------------------------------------------- |
| Small S1          |        17330 | `d9a3aae9…`    | Baseline → candidate | 247 → 746, then 615 → 929                      |
| Small S2          |        83937 | `9bc53c01…`    | Candidate → baseline | 249 → 762, then 701 → 1,019                    |
| Small S3          |        51283 | `1feb65ac…`    | Baseline → candidate | 243 → 644, then 767 → 1,098                    |
| Representative S1 |        28385 | `1ff2d4f9…`    | Baseline → candidate | 285 → 775, then 772 → 1,267                    |
| Representative S2 |        97477 | `5b09d86f…`    | Candidate → baseline | 264 → 758, then 788 → 1,188                    |
| Representative S3 |        66342 | `44155640…`    | Baseline → candidate | 280 → 663, then 834 → 1,256                    |

Renderer memory grows during each run, as in the Linux record. The second report of a pair starts at a higher RSS and was slower in four of six pairs. These runs do not establish the cause. The recorder's own costs were outside the switch timers: across the 12 reports, total sample serialization was 45 to 48 ms and total journal appends 109 to 154 ms for the 150 samples of a report.

## Where the time goes

The acceptance reports record stage spans for every sample. Each cell is the range of the stage median across the three candidate reports of a fixture. Stages overlap and nest, so these medians must not be added to form a total.

| Stage median (ms), candidate                            | Small, branch | Representative, branch | Small, unbound | Representative, unbound |
| ------------------------------------------------------- | ------------: | ---------------------: | -------------: | ----------------------: |
| Selection to completion                                 |   402.1–437.5 |            557.3–587.8 |    133.3–140.2 |             127.7–141.9 |
| Identity reads outside safeguards (three Git processes) |     68.1–73.1 |              71.0–74.9 |              — |                       — |
| Checkout safeguards (two complete preflights)           |   131.4–154.3 |            157.1–171.4 |              — |                       — |
| Native Git checkout                                     |     29.3–32.5 |              70.1–73.2 |              — |                       — |
| Vault readiness                                         |     25.3–37.6 |            100.8–108.1 |        2.0–4.3 |                 2.1–4.3 |
| Native layout restore                                   |     71.7–77.7 |              72.9–79.1 |      60.6–67.3 |               63.8–68.4 |
| Durable state writes (two)                              |     36.1–37.4 |              41.5–44.6 |      45.1–54.1 |               40.6–48.3 |
| Editor unload                                           |       7.4–8.0 |                7.5–7.8 |              — |                       — |
| Other controller work and queue wait                    |     12.8–13.2 |              13.2–14.3 |      18.9–19.2 |               19.8–20.1 |

Same-branch switches (three identity reads, no checkout) had medians of 176.1 to 186.3 ms on the small fixture and 174.2 to 204.3 ms on the representative fixture.

The larger fixture costs about 150 ms more per branch switch. Most of that is in two stages: vault readiness (about 70 ms more) and the Git checkout itself (about 40 ms more). Both scale with the 85 changed paths. A Git process started from the Obsidian renderer costs about 20 to 30 ms on this Mac, and a branch switch runs eight or nine sequential rounds of them. Each durable write syncs the state file and its directory.

Short runs in one renderer were faster than the acceptance reports for the same bundle and fixture: 363 to 367 ms (branch, 20 samples) and 105 to 112 ms (unbound, 6 samples), against 402 to 438 ms and 133 to 140 ms. The short runs had the same operator activity as the acceptance reports. The cause was not established; renderer memory growth over a 150-sample report is one candidate. Four traced diagnostics of 12 to 20 branch switches are in [diagnostics](diagnostics/).

**What this means for the budget.** The unbound switch is a direct measurement of the parts that every switch needs: native restore and two durable writes, with no Git process. Its median is 127.7 to 141.9 ms in the twelve acceptance reports and 105 to 112 ms in short runs. A branch switch needs a checkout process, vault readiness and the checkout safeguards in addition, and ADR 0003, 0004 and 0005 require the safeguards and both writes. The measurements therefore give no path to a 100 ms median for branch switches on this Mac with the present architecture. Layout-only switches are closer but were above 100 ms in every report.

1. Change the budget to what the retained safety contract can deliver on this hardware. The measured figures give a basis: about 105 to 140 ms for layout-only switches and 350 to 570 ms for branch switches.
2. Reduce the durable-write cost: one write per switch, or a cheaper durability level. This changes the crash boundary in ADR 0004.
3. Replace sequential Git processes with fewer or direct reads: for example, read `HEAD` from the file system for identity checks, or use one long-lived Git process. This is a new capability that ADR 0005 requires to be validated separately.
4. Replace native `changeLayout` restore. The earlier incremental experiment did not establish a gain.

None of these is adopted here.

## Rejected optimization: early tree comparison

This run tested one new optimization and removed it. A later checkout safeguard in the same queue scope started its index and tree comparison together with its other reads, pinned to the commits that the earlier safeguard observed, and used the result only when the new status and ref named the same commits. Source: commits `188f91c02151af3c8ed5eccae8b475f5c9f1dcf5` and `bd4366c1a5592dc4c93fa60147d0dfb38b72f036`, bundle `098d3854b89c6968eedc88c174d2fcd946fa78122e428babecd3bdf98321655b`, reverted by `a2d738a`.

| Run in one renderer (small fixture)     |    Previous build | With early comparison |
| --------------------------------------- | ----------------: | --------------------: |
| Normal mode, 20 branch switches, median | 367.2, then 362.9 |     355.6, then 362.6 |
| Traced, checkout safeguard stage median | 136.5, then 112.0 |     117.2, then 132.1 |

The difference is inside run-to-run variation; the independent review computed a pooled difference of −4.2 ms with a 95% interval of −21.6 to +13.2 ms. Obsidian Git 2.43.0 runs at most five Git processes at a time, so the sixth read still waits for the first to finish. An independent review also showed one changed timing property: an index entry that another Git client adds just after the status read was no longer seen by that safeguard. With no measured benefit, the reviewed read order was restored. The traced totals of the build with the early comparison were 349.5 and 405.1 ms, against 366.9 and 347.7 ms for the previous build. The reports are in [diagnostics](diagnostics/).

## Correctness and safety

| Check                                              | Result                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completion endpoints, 12 reports                   | 1,800 of 1,800 passed; every report finished with `restoredAlpha: true`, clean Git and a null journal                                                                                                                                                                                    |
| Runtime probe, both fixtures                       | 9 of 9 checks passed at fixture setup with bundle `098d3854…` (the build with the early comparison), before the final candidate was built; the reports do not record the product hash ([small](reports/small-runtime.json.gz), [representative](reports/representative-runtime.json.gz)) |
| Quick Switcher++ safety, candidate, small          | 10 of 10 passed in renderer 51283, the Small S3 renderer ([report](reports/small-quick-switcher-fixed.json.gz))                                                                                                                                                                          |
| Quick Switcher++ safety, candidate, representative | 10 of 10 passed in renderer 66342, the Representative S3 renderer ([report](reports/representative-quick-switcher-fixed.json.gz))                                                                                                                                                        |
| Command-palette Alpha → Beta → Alpha               | Branch, workspace label, active note, pins and editor text were correct at each step in both fixtures ([records and screenshots](roundtrip/))                                                                                                                                            |

The dirty-editor checkout rejection is one of the ten safety scenarios and passed in both runs.

## How the run was operated

An agent operated this run with the Obsidian command-line interface while the Mac was not in use. These points differ from a human operator and limit what the evidence shows:

- **Input.** The benchmark command and the roundtrip used the native command palette with input events injected through Electron (`sendInputEvent` and `insertText`): Cmd+P, typed text, Enter. The script took focus from inside the renderer with `app.focus({steal: true})`, `show()` and `focus()` one second before Cmd+P. The window then had native focus at each start. No human pressed a key, so this is not physical keyboard evidence.
- **Plugin changes.** Plugins were disabled and enabled through the Obsidian CLI. The probe's own native reload check passed in every report.
- **Independent pairs.** The fixture window was closed and opened again between pairs. Obsidian itself was not quit. Renderer process IDs and native session IDs are different for all six pairs.
- **Conditions.** The other fixture vault stayed open in a second window, and the `tyo-bit` vault stayed open in a third window; an operator CLI call had opened it at 08:25:57 UTC. No build, test or other benchmark ran during the timed reports. The operator script made one Obsidian CLI `eval` call into the fixture renderer 3 to 8 seconds after each benchmark start, and started a Node process every 3 seconds to read the progress file. The runtime-probe plugin stayed enabled in the fixtures; it does nothing after its first completed run. Background processes of the logged-in desktop session were not controlled. Caffeine kept the display on.
- **Configuration.** Default dark theme, no snippets, both sidebars open at 300 px, the preparer's Obsidian Git settings, Workspaces save-on-switch enabled. The [configuration record](operator/config-observation.ndjson) was taken after the run. It does not hold the Quick Switcher++ settings or the split arrangement; both were the defaults that the preparers and probes create. After the run, core Workspaces was enabled in the small fixture and disabled in the representative fixture. The cause of that difference was not established.

The [operator log](operator/operator-log.txt), the automation scripts and each preparer's output are in [operator](operator/).

### Attempts that are not closure evidence

- The first armed run stopped at its focus check with zero timed samples, because the desktop was in use and the window lost focus ([report](diagnostics/diag1-candidate.json.gz)).
- The first setup safety run failed in both fixtures because the operator script had not enabled Quick Switcher++. The same script error wrote both reports to one path, so only the representative one remains ([report](diagnostics/setup-safety-qpp-not-enabled.failed.json.gz)). The rerun passed in both fixtures.
- A short run of the candidate product stopped before its first sample because the small fixture's saved Alpha layout had changed after the first setup (`Missing alpha pinned right note`, [report](diagnostics/diag2-main.failed.json.gz)). The small fixture was then reset.
- Rough background timings taken while the window was hidden were not used. Chromium throttles a hidden window. Their outputs are in [diagnostics](diagnostics/) for the record.

## Runbook and tooling findings

1. **Runtime probe could not load (fixed in this change).** `prepare-runtime-vault.mjs` copied `runtime-probe.cjs` without the `atomic-report.cjs` module that it imports. Obsidian reported `MODULE_NOT_FOUND` and the fixture stayed at `prepared`. The preparer now bundles the probe.
2. **Trust prompt.** A new fixture vault opens in Restricted Mode with a trust prompt. No fixture plugin loads until the operator accepts it.
3. **The gate stops at the first failed condition of a session.** Its output lists the progress and 500 ms failures and leaves `sessions` and `pooled` empty. The budget statistics above come from [summarize.mjs](summarize.mjs).
4. **Focus.** The probe needs native window focus for the whole report. A person who uses the Mac ends the run at the next sample. A CLI `eval` call into the fixture renderer did not end a run: the operator script made one during each timed report.

## Evidence

- [closure-manifest.json](closure-manifest.json) references each compressed report and journal with its SHA-256. [closure-result.json](closure-result.json) is the gate output for that manifest. The [pre-review manifest](operator/pre-review-closure-manifest.json) differs only in the suitability declaration; its [result](operator/pre-review-closure-result.json) holds the seven session failures.
- [reports](reports/) and [journals](journals/) hold the 12 timed reports, their NDJSON journals, both safety reports and both runtime reports, compressed with `gzip -9 -n`. [summary.json](summary.json) lists the SHA-256 of each report's original and compressed bytes, with the recorder's journal and sample digests.
- [SHA256SUMS](SHA256SUMS) covers every file in this directory.

Regenerate the gate result and the tables from the repository root:

```sh
node scripts/check-switch-performance.mjs docs/validation/mac-closure/closure-manifest.json \
  --output /absolute/new/closure-result.json
node docs/validation/mac-closure/summarize.mjs docs/validation/mac-closure
```

## Independent review

[review.md](review.md) is the unedited review by a second AI agent that did not collect the evidence or write this report. No human has reviewed this evidence yet. Verdict: **supports with corrections**. The reviewer reran the gate, checked all 26 manifest hashes, and recomputed every table value from the raw reports with separate code; it found no mismatch in the numbers or the decision.

This report was corrected after the review:

- The operation section now states how focus was taken, the CLI call and the progress polling during each report, and the third open window.
- The budget reasoning now uses direct measurements from the acceptance reports and gives the representative fixture's checkout and readiness costs.
- `suitabilityConfirmed` is false, and the count record is archived.
- The runtime probe row states which bundle the probe ran on.
- The missing failed reports, the background timing outputs and `SHA256SUMS` were added.

Not corrected, because they need a new run: the timed reports were not repeated without the operator's CLI call and polling, and the runtime probe was not repeated on the final candidate bundle. Neither can change a blocked decision.
