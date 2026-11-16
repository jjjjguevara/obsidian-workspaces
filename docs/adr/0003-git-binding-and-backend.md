# ADR 0003 — Git binding and backend

**Status:** Accepted

**Date:** 2026-11-13

## Context

A workspace can contain notes that exist only on a particular branch. Restoring that workspace requires the branch to be present before Obsidian opens those notes. Git operations can fail, and ordinary editor changes can make a checkout unsafe or impossible.

## Decision

Make branch binding optional and explicit. A bound context records an existing local branch and repository identity. Capture the observed branch when binding a saved context. Ordinary autosaves retain its binding; an external branch change requires explicit reconciliation instead of silently changing the association.

Use the installed Obsidian Git plugin as the initial desktop backend. Target its inspected 2.43.0 capability surface through a narrow adapter. Validate availability, initialization, required operations, and repository identity before use. Put the complete Git-aware transition inside the backend's operation queue through `withRepository`; do not release that scope between status validation, checkout, and restoration. Await an unambiguous operation result instead of treating a command dispatch as checkout completion.

A dirty working tree blocks a branch change. A layout switch on the already-active branch does not require checkout and can retain pending file edits. Missing branches and repository/backend mismatches produce a reported failure. Workspaces does not create branches, automatically stash, force checkout, commit, push, or check out a branch during startup. Saving a workspace records layout/context state and does not commit note content.

An unbound activation changes the layout while leaving Git untouched. Initial mobile support is for unbound workspaces; bound activation is unavailable there. External Git changes are observed at operation boundaries, since the plugin cannot serialize an unrelated terminal process.

Keep reads proportional to the information a caller needs. Binding checks may use a fresh identity-only observation; this carries no assertion of cleanliness. Checkout safeguards still read dirty/conflict state, exact local refs, operation markers, recursive-submodule settings, ignored paths, and protected runtime paths. Batch compatible Git outputs and await all parallel reads before releasing queue ownership, including on failure.

For a known bound source and target in the same repository on different branches, preparation may return the freshly verified source identity from the complete first safeguard. The controller uses that observation at the post-flush boundary instead of immediately repeating an identity query. Retain the initial source check before editor saves, the final complete safeguard after unload, and the separate post-checkout and post-restoration identity observations. Same-branch and unbound layout paths keep their identity-only behavior so pending edits remain supported.

Successful checkout returns freshly verified repository/branch identity. Failure diagnostics still attempt a full status observation. The controller may opt into overlapping its explicit provider branch-indicator refresh with vault readiness and layout restoration. The repository scope owns and drains that promise before releasing the provider queue on success or failure; a later checkout cannot overtake it. Direct checkout calls retain awaited presentation by default. The native refresh event is also triggered, but Obsidian's event dispatcher does not expose asynchronous listener completion. Those provider-owned background listeners are not included in this drainage guarantee.

Within each safeguard, observe full source and target object IDs, then reconstruct the complete target path set from a fresh source-tree/index union and their raw diff. Including the source tree preserves protection when an external process removes an index entry after status was read. Extra index paths are treated conservatively. Do not replace complete target coverage with only changed paths, or cache mutable refs, index, configuration, or status across safeguards. The final checkout safeguard remains fresh after outgoing views unload.

A later safeguard in the same queue scope may start that tree comparison together with its other reads. It pins the early comparison to the two commit IDs that the earlier safeguard observed for the same target. Commit objects cannot change, and the early index read is as recent as the status read beside it. The safeguard uses the early result only when its own new status and ref output name the same two commits. A moved ref, a new source commit, or a failed or malformed early read makes it repeat the comparison against the new commits. Every safeguard still rereads status, the target ref, operation markers, configuration and the index; the earlier commit IDs are not a record of current repository state and do not survive the queue scope. This removes one sequential round of Git processes from the post-unload safeguard.

One timing property changes. The early index read runs beside the status read, not after it. An index entry that an external Git client adds after status has read the index is then not seen by that safeguard. Before this change, the safeguard still saw such an entry until its later index read, about one process round. An entry added before the status read makes the worktree dirty and blocks the switch, as before. Index entries removed by another client stay covered through the source tree. External Git processes are outside the provider queue in both designs, so each design has an interval in which a late external change is not observed. Obsidian Git 2.43.0 runs at most five Git processes at a time, so the sixth read of a combined round starts when the first one finishes.

## Consequences

The integration adds no separate credential store or Git implementation. It depends on a tested compatibility boundary with Obsidian Git and must fail clearly when that boundary changes. Users handle pending file changes through explicit Git operations before switching branches.

Git is a participant in the controller defined by [ADR 0004](0004-workspace-transitions-and-recovery.md); the adapter does not choose the active workspace.
