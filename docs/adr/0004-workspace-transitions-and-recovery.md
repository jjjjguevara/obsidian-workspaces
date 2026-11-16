# ADR 0004 — Workspace transitions and recovery

**Status:** Accepted

**Date:** 2026-11-13

**Amended:** 2026-11-16. See [the amendment](#amendment-2026-11-16-switches-with-no-checkout-and-missing-notes) at the end. Notes in italics mark the sentences that it supersedes.

## Context

Checkout, filesystem observation, layout restoration, and persistence complete at different times. File deletion events and periodic captures can otherwise replace a valid saved layout with an intermediate view. Reporting the target active before the operation succeeds hides failures and makes recovery ambiguous.

## Decision

Give one serialized controller ownership of activation. Every switch, history restoration, imported-context activation, and active-workspace replacement uses that controller. Future UI or frontmatter entry points must use it too. Passive imports and storage arrival do not activate Git.

The controller prepares source/target contexts, finishes applicable note saves, and captures the outgoing live layout before checkout. Save-on-switch policy determines whether that capture replaces the source's saved layout. The recovery journal retains the context necessary to identify an incomplete transition.

Await supported text-backed editor saves and unload outgoing file views before checkout. Reject unsupported editable views with an instruction to close them. Recheck Git status after unloading, then require observed filesystem/index/cache readiness before restoring the target. A fixed delay cannot substitute for those checks.

Flush editors in order. _Superseded in part on 2026-11-16: the flush saves loaded text views only; the checkout preflight loads the deferred views._ After the complete supported-view preflight, independent file views may unload concurrently. Keep editable views of the same file in their existing close/save order, and stop that file's remaining closes if one fails. Drain all started independent unloads before reporting failure or beginning the final checkout safeguard.

Suspend incidental layout captures and competing activation while the operation owns the transition. Validate branch/status, persist the journal, perform any required checkout, observe the target branch and vault files, restore the native layout, and persist the active identity only after successful restoration. Indicators follow committed state. _Superseded in part on 2026-11-16: the controller observes vault files only after a checkout._

A successful activation uses two durable state writes: the complete prepared journal before unloading views, and the completed target identity with the journal cleared after restoration and final branch verification. Checkout/restoration phases update in memory without advancing the persisted revision. After an interruption, the durable phase is a record of pending intent, not proof of which side effects completed; recovery always inspects Git and uses the saved source/target contexts. Errors may persist an additional recovery record. This avoids redundant full-catalog writes without weakening the crash boundary or conflict detection.

Block input as soon as the transition owns the native views. Delay the visible progress modal by 500 ms and cancel it when the operation finishes sooner. A slow operation retains the same ownership and progress indicator. Vault create, delete, rename, and modify events wake readiness checks; the checks still compare indexed files, metadata, and cached bytes with disk, with bounded polling when no event arrives.

Input protection covers keyboard editing and mouse activation events in the main window, existing popouts, and windows opened during restoration. Preventing pointer-down alone is insufficient for native click handlers. Release removes every document listener and the temporary window-open subscription, including when progress never opened.

After a completed checkout, the inspected desktop Obsidian 1.15.1 filesystem adapter may be asked to reconcile the source and target file paths immediately through its own queued `update(path)` method. This optional compatibility hook avoids the watcher's deletion-confirmation delay. It reads filesystem state and emits native events; it does not alter files or manually populate the vault index. Other versions/adapters, unavailable methods, and failed hints retain the ordinary readiness path. Drain every started reconciliation and always run the full readiness checks afterward.

Let native `changeLayout` finish before hydrating its remaining deferred leaves concurrently. Drain every started hydration before reporting failure or releasing ownership. Verify the complete requested file-leaf set, including hidden and pinned sidebar notes; faster restoration must not rely on leaving those views unverified. _Superseded in part on 2026-11-16: hydration runs only after a checkout, and verification ignores notes that no longer exist. Verification itself still runs on every switch._

A fixed elapsed timeout does not revoke ownership of a valid operation. Later requests are serialized or rejected explicitly. A failed checkout cannot fall through into target layout loading. If failure follows checkout, preserve the journal and report the actual branch and incomplete restoration. Report successful recovery only after verifying it.

On startup, detect the incomplete journal and offer explicit recovery without automatic checkout. A crash or persistence failure must not be mistaken for a completed activation.

## Consequences

The transition controller is more substantial than a workspace-load event listener, but it provides one place to enforce branch/layout ordering. History timers, import paths, native UI, and any later custom interface cannot implement their own restore sequences.

Tests must cover slow operations, repeat requests, checkout and persistence failures, missing files, external branch drift, and interruption between checkout and layout restoration. Real Obsidian validation remains necessary for filesystem observation and pinned-leaf behavior.

## Amendment 2026-11-16: switches with no checkout, and missing notes

**Status:** Accepted. The owner authorized this change.

### Context

The owner's vault has no Git plugin and only unbound workspaces. A switch there took several seconds. Some switches ended in "Recovery required". Core Workspaces does the same switch almost at once, because it only calls `workspace.changeLayout`. Two causes were found.

1. **Slow switch.** Each switch loaded every deferred view two times. The flush loaded each leaf of the outgoing layout. The restore loaded each leaf of the incoming layout. The vault has 36 community plugins and layouts with 12 to 20 leaves. Some leaves are heavy hidden panels.
2. **Recovery.** A saved layout referred to a note that no longer existed. The readiness wait used its full 15 seconds for that file and then failed. The controller wrote a recovery journal. Without the wait, the restore verification would have failed for the same note.

The loading in the flush, the readiness wait and the hydration exist for a checkout. Before a checkout, buffers must be saved and views unloaded. After a checkout, editors must show the bytes of the new branch. With no checkout, no file changes. These steps then cost time and give nothing.

### Decision

A switch does a checkout when the target is bound and its branch is not the current branch. An unbound target does no checkout. A bound target on the current branch does no checkout.

A switch with no checkout restores the layout as Obsidian does. A switch with a checkout keeps the earlier behavior. A note that no longer exists never fails a switch.

- **Flush.** The flush awaits `save()` for each loaded `TextFileView`. It does not load a deferred leaf. A deferred leaf has no editor buffer.
- **Checkout preflight.** `assertCanQuiesce()` first loads every deferred leaf, one after the other. Then it runs its checks without change. `quiesce()` still calls it. A checkout thus loads the same views as before, at the point where this is necessary.
- **Readiness.** The controller waits for vault files only after a checkout. Recovery waits only when it checked out the original branch.
- **Hydration.** The host restore has a `hydrate` option. The controller sets it only after a checkout, in a switch and in recovery. Without it, the restore awaits `changeLayout` and loads no deferred view. Obsidian loads a hidden view when the view is shown.
- **Verification.** The file-leaf verification runs on every switch. It reads the native layout, which includes deferred leaves.
- **Missing notes.** Readiness does not wait for a target path that is absent from disk and absent from the vault index. If the index still lists the path, readiness waits until the index drops it. Verification ignores owned file leaves of a missing path on the two sides. Obsidian can keep such a leaf with its saved state, or it can open an empty tab. A path is missing when the vault index holds no file for it immediately before `changeLayout`. After a successful restore, one notice gives the number of missing notes and at most three names.

These items did not change: the two durable writes, the input block, the journal, the Git adapter, the order of the checkout safeguards, and each step of a switch that does a checkout.

### Consequences

- A switch with no checkout now costs the saves of loaded editors, the native layout change and the two state writes.
- After a switch with no checkout, hidden views can be deferred. ADR 0005 now requires "no deferred views" in the completion snapshot only when the branch changed.
- A missing note stays in the saved snapshot until the workspace is saved again.
- Recovery does no checkout when the repository is already on the original branch. It then does not wait and does not hydrate.
- The native probes under `tests/obsidian/` were changed for this rule. They were not run in native Obsidian after the change. See [Validation](../validation.md).
