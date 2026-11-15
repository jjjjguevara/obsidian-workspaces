# Native restore experiment

The performance work evaluated reusing native split/tab containers after safely unloading outgoing file views. It retained only unchanged, allowlisted non-file panes and created fresh file/empty leaf shells, including fresh navigation histories. Unsupported layouts and a failed final whole-layout comparison fell back to native `changeLayout`.

The implementation is preserved in [experiment commit 2765b58](https://github.com/jjjjguevara/obsidian-workspaces/commit/2765b58ff1b9698b94e24102e2893eeadc400fbc). Its source tree is identical to local experiment commit `58cc39960f961a9aed033dd5c2fc7466222385cb`; the built `main.js` SHA-256 is `1c54cf794a997047355539083be6de2fe95e8f29226890a7f42b8bf67d08a04a`.

## Native findings

Initial native traces exposed two reasons for fallback that mocks had not established: an undefined native view-state property outside the serialized layout boundary, and provisional sidebar activation changing the file followed by read-only core panels. After correcting those behaviors, all four diagnostic transitions used the incremental path, with zero full-layout fallback calls and valid exact completion snapshots.

Correctness did not establish a speed improvement. Normal-mode comparisons used the same Linux Obsidian renderer, the same benchmark bundle, fixture commits and installed Obsidian Git/Quick Switcher++ assets. The control retained the Git preflight improvement and used full native layout restoration.

| Normal screening run | Branch samples | Alpha → Beta restore median | Beta → Alpha restore median | Total branch median | Total branch p95 | Progress openings |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full native restore control | 20 | 61.85 ms | 70.54 ms | 355.07 ms | 473.85 ms | 0 |
| Incremental restore, clean retest | 20 | 85.75 ms | 83.95 ms | 478.64 ms | 581.50 ms | 4 |

The earlier incremental screening attempt also had slower restoration but a lower total because its Git intervals were faster. That attempt overlapped a short control-build preparation and remains labeled exploratory. These screening reports also predate the append-only recorder: the old observer repeatedly rewrote its growing result. Their totals and component medians are not final acceptance evidence or a precise estimate of the product's performance difference. Every attempt is retained with the validation evidence.

## Decision

Remove the incremental implementation from the final product change. The normal native evidence did not justify its additional private-capability surface or demonstrate faster restoration. Keep native `changeLayout`, concurrent deferred-leaf hydration, complete file/pin checks and the unchanged safety/recovery boundaries. The adopted optimization reuses the fresh identity returned by the post-flush Git safeguard; it does not change native layout semantics.

This is a rejected optimization experiment, not a Mac performance result or an issue-closure decision. See the [local Mac closure gate](local-mac-closure.md) for the required final acceptance evidence.
