# ADR 0004 — Workspace transitions and recovery

**Status:** Accepted

**Date:** 2026-11-13

## Context

Checkout, filesystem observation, layout restoration, and persistence complete at different times. File deletion events and periodic captures can otherwise replace a valid saved layout with an intermediate view. Reporting the target active before the operation succeeds hides failures and makes recovery ambiguous.

## Decision

Give one serialized controller ownership of activation. Every switch, history restoration, imported-context activation, and active-workspace replacement uses that controller. Future UI or frontmatter entry points must use it too. Passive imports and storage arrival do not activate Git.

The controller prepares source/target contexts, finishes applicable note saves, and captures the outgoing live layout before checkout. Save-on-switch policy determines whether that capture replaces the source's saved layout. The recovery journal retains the context necessary to identify an incomplete transition.

Await supported text-backed editor saves and unload outgoing file views before checkout. Reject unsupported editable views with an instruction to close them. Recheck Git status after unloading, then require observed filesystem/index/cache readiness before restoring the target. A fixed delay cannot substitute for those checks.

Flush editors in order. After the complete supported-view preflight, independent file views may unload concurrently. Keep editable views of the same file in their existing close/save order, and stop that file's remaining closes if one fails. Drain all started independent unloads before reporting failure or beginning the final checkout safeguard.

Suspend incidental layout captures and competing activation while the operation owns the transition. Validate branch/status, persist the journal, perform any required checkout, observe the target branch and vault files, restore the native layout, and persist the active identity only after successful restoration. Indicators follow committed state.

A successful activation uses two durable state writes: the complete prepared journal before unloading views, and the completed target identity with the journal cleared after restoration and final branch verification. Checkout/restoration phases update in memory without advancing the persisted revision. After an interruption, the durable phase is a record of pending intent, not proof of which side effects completed; recovery always inspects Git and uses the saved source/target contexts. Errors may persist an additional recovery record. This avoids redundant full-catalog writes without weakening the crash boundary or conflict detection.

Block input as soon as the transition owns the native views. Delay the visible progress modal by 500 ms and cancel it when the operation finishes sooner. A slow operation retains the same ownership and progress indicator. Vault create, delete, rename, and modify events wake readiness checks; the checks still compare indexed files, metadata, and cached bytes with disk, with bounded polling when no event arrives.

Input protection covers keyboard editing and mouse activation events in the main window, existing popouts, and windows opened during restoration. Preventing pointer-down alone is insufficient for native click handlers. Release removes every document listener and the temporary window-open subscription, including when progress never opened.

After a completed checkout, the inspected desktop Obsidian 1.15.1 filesystem adapter may be asked to reconcile the source and target file paths immediately through its own queued `update(path)` method. This optional compatibility hook avoids the watcher's deletion-confirmation delay. It reads filesystem state and emits native events; it does not alter files or manually populate the vault index. Other versions/adapters, unavailable methods, and failed hints retain the ordinary readiness path. Drain every started reconciliation and always run the full readiness checks afterward.

Let native `changeLayout` finish before hydrating its remaining deferred leaves concurrently. Drain every started hydration before reporting failure or releasing ownership. Verify the complete requested file-leaf set, including hidden and pinned sidebar notes; faster restoration must not rely on leaving those views unverified.

A fixed elapsed timeout does not revoke ownership of a valid operation. Later requests are serialized or rejected explicitly. A failed checkout cannot fall through into target layout loading. If failure follows checkout, preserve the journal and report the actual branch and incomplete restoration. Report successful recovery only after verifying it.

On startup, detect the incomplete journal and offer explicit recovery without automatic checkout. A crash or persistence failure must not be mistaken for a completed activation.

## Consequences

The transition controller is more substantial than a workspace-load event listener, but it provides one place to enforce branch/layout ordering. History timers, import paths, native UI, and any later custom interface cannot implement their own restore sequences.

Tests must cover slow operations, repeat requests, checkout and persistence failures, missing files, external branch drift, and interruption between checkout and layout restoration. Real Obsidian validation remains necessary for filesystem observation and pinned-leaf behavior.
