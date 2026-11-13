# ADR 0004 — Workspace transitions and recovery

**Status:** Accepted

**Date:** 2026-11-13

## Context

Checkout, filesystem observation, layout restoration, and persistence complete at different times. File deletion events and periodic captures can otherwise replace a valid saved layout with an intermediate view. Reporting the target active before the operation succeeds hides failures and makes recovery ambiguous.

## Decision

Give one serialized controller ownership of activation. Every switch, history restoration, imported-context activation, and active-workspace replacement uses that controller. Future UI or frontmatter entry points must use it too. Passive imports and storage arrival do not activate Git.

The controller prepares source/target contexts, finishes applicable note saves, and captures the outgoing live layout before checkout. Save-on-switch policy determines whether that capture replaces the source's saved layout. The recovery journal retains the context necessary to identify an incomplete transition.

Await supported text-backed editor saves and unload outgoing file views before checkout. Reject unsupported editable views with an instruction to close them. Recheck Git status after unloading, then require observed filesystem/index/cache readiness before restoring the target. A fixed delay cannot substitute for those checks.

Suspend incidental layout captures and competing activation while the operation owns the transition. Validate branch/status, persist the journal, perform any required checkout, observe the target branch and vault files, restore the native layout, and persist the active identity only after successful restoration. Indicators follow committed state.

A fixed elapsed timeout does not revoke ownership of a valid operation. Later requests are serialized or rejected explicitly. A failed checkout cannot fall through into target layout loading. If failure follows checkout, preserve the journal and report the actual branch and incomplete restoration. Report successful recovery only after verifying it.

On startup, detect the incomplete journal and offer explicit recovery without automatic checkout. A crash or persistence failure must not be mistaken for a completed activation.

## Consequences

The transition controller is more substantial than a workspace-load event listener, but it provides one place to enforce branch/layout ordering. History timers, import paths, native UI, and any later custom interface cannot implement their own restore sequences.

Tests must cover slow operations, repeat requests, checkout and persistence failures, missing files, external branch drift, and interruption between checkout and layout restoration. Real Obsidian validation remains necessary for filesystem observation and pinned-leaf behavior.
