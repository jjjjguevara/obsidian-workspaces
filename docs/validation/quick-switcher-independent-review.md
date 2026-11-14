# Independent review: Quick Switcher++ workspace activation

**Date:** 2026-11-14  
**Pull request:** [#2](https://github.com/jjjjguevara/obsidian-workspaces/pull/2)  
**Initially reviewed source:** `31daab7a5f9cb8f409639e31466320d2c3839abc`  
**Corrected source reviewed and tested:** `5ae8cee43cf48ef3d92f79900609510bad49668f`

## Verdict

No remaining blocking findings in the corrected source. The independent review identified one P2 lifecycle defect in the initial commit; the implementation author corrected it, and the reviewer verified the correction with the actual Quick Switcher++ provider and a fresh native run. The reviewer did not implement the feature or its correction. This is an independent technical assessment, not a formal GitHub approval by another account.

The status label now contains only the workspace name. Quick Switcher++ selection reaches the product transition controller, and the final native checks show agreement among the active workspace, actual Git branch, pinned main/sidebar notes, and editor contents.

## P2 finding and resolution

In the initial source, `QuickSwitcherIntegration.start()` wrapped future `loadPlugin()` calls and performed one immediate reconciliation. A Quick Switcher++ enable already in progress could escape both mechanisms. Obsidian 1.15.1 publishes the plugin instance before awaiting its load, while Quick Switcher++ 6.3.0 publishes `commandDefinitions` only after awaiting its settings load. Reconciliation during that interval failed, and completion of the original unwrapped load never retried it. A still earlier reconciliation could see no instance at all.

This ordering is reachable through overlapping live plugin enables. The inspected native settings code gives individual toggles asynchronous enable callbacks; it does not serialize all toggle operations. Standard application startup loads plugins serially and is unaffected.

The independent [official-provider harness](../../tests/integration/quick-switcher-provider.cjs) runs the actual Quick Switcher++ 6.3.0 bundle with host sequencing stubs. It tests both intervals: before instance publication and during provider initialization. Both intervals reproduced core-catalog selection and a core-loader call on the original source; see the [baseline result](quick-switcher-provider-baseline.json).

Commit `5ae8cee43cf48ef3d92f79900609510bad49668f` subscribes to the native plugin manager's `changed` completion event before initial discovery, defers incompletely initialized definitions, and removes the subscription on disposal. The native manager calls that event after successful `enablePlugin()` completion. The [corrected result](quick-switcher-provider-fixed.json) shows product-ID selection and product activation in both intervals, zero core-loader calls, no spurious compatibility notices, and zero remaining event listeners after disposal.

This lifecycle reproduction is an automated test using the real provider and simulated host sequencing. It is not a native UI fault-injection run.

## Checks independently performed

| Check | Result |
| --- | --- |
| Source and architecture review | Read repository instructions, specification, architecture, four ADRs, production changes, tests, and fixture implementation. Checked adapter assumptions against the installed official Quick Switcher++ bundle and native Obsidian lifecycle implementation. |
| Initial detached commit | `npm run check` passed 139 tests; independent native fixed fixture passed 10/10. [Initial native report](quick-switcher-independent.json). |
| Corrected detached commit | `npm run check` passed typechecking, 142 tests, and build. [Independent final log](quick-switcher-independent-automated.txt). |
| Lifecycle regression | Actual official provider reproduced both pending-load failures on the initial source and passed both cases on corrected source. |
| Corrected native bundle | Disabled Workspaces, installed the independently built bundle, re-enabled it with Quick Switcher++ already loaded, and reran the documented native fixture. **10/10 passed.** [Final native report](quick-switcher-independent-final.json). |
| Visible command palette | Independently selected Beta and returned to Alpha through the visible Q++ chooser on the initial reviewed bundle. Observed each pinned exclusive note and separate workspace/Git labels; shell Git checks confirmed clean `beta` and clean `alpha`. The corrected bundle was subsequently covered by the fresh native chooser fixture. |
| Author evidence inspection | Checked original baseline and fixed report hashes against the documented values and inspected the probe's actual chooser/controller observation path. The review did not rerun the author's original pre-feature baseline. |

The final native run exercised the actual registered Q++ command and chooser Enter path, both branch directions, exclusive pinned main/left/right notes, current shared-path editor content, the actual save-and-switch handler, core Workspaces disabled, duplicate display names, dirty native-editor rejection, and a subsequent clean roundtrip. It recorded 11 product-controller calls and zero core-loader calls. Observers returned the original promises unchanged. Target verification did not hydrate or repair views.

Final fixture state was clean `alpha`, active ID `runtime-alpha`, no recovery journal, Workspaces text `Alpha`, and Git text `alpha`. Native core state and test edits were restored.

## Final native evidence identity

| Item | Value |
| --- | --- |
| Source | `5ae8cee43cf48ef3d92f79900609510bad49668f` |
| Environment | Linux Obsidian 1.15.1; Obsidian Git 2.43.0; Quick Switcher++ 6.3.0 |
| Run ID | `07396f23-dd7e-4285-a125-8f8936c87308` |
| Run interval | 2026-11-14 02:07:10.537–02:07:20.906 UTC |
| Workspaces bundle SHA-256 | `62a226c43d5a9f635c04edd6f0ef92fab572c103ad7bea3e09f53966cc48a0d8` |
| Quick Switcher++ bundle SHA-256 | `6746dad3d6b132698b04c2a10ea0c2f71c03c8b5af7bec753ca76319c72e3f23` |
| Obsidian Git bundle SHA-256 | `58beb0981875c672fc83350e3b1f20db6ca1df3ca2047a25f49190b1e31e2443` |
| Native probe SHA-256 | `8d1e89f59540963c906434f056d4888fe59f1d1f0d549416c62f475b66eb08f3` |
| Final native report SHA-256 | `c837f3f2153c6dd1f09850904e2898b2139d15d221a53c65477e51b0da035959` |

## Limits

Native execution covers the stated Linux versions and the disposable fixture. macOS, Windows, physical mobile, other Quick Switcher++ releases, and a theme matrix were not exercised. Save failure, queued-source changes, stale suggestions, and descriptor teardown have automated coverage; those failures were not injected into the native app during this review. The integration remains a capability-checked adapter to private APIs and requires renewed compatibility validation when those contracts change.
