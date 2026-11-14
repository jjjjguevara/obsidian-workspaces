# PR 3: initial blind findings

Recorded on 2026-11-13 (America/Monterrey), at 2026-11-14T04:35:53Z.

Reviewer: independent AI subagent, not the PR author and not a separate human or GitHub-user approval.

- Base: `f061347313c031d03b1491a9072717c7ba80b15d`.
- Reviewed head: `27c7a8d56fa708036248ffcc63120b243703fff4`.
- Isolated detached worktree: `/workspace/scratch/0a8d9baba8ea/repos/pr3-blind-review`.

This record was written before opening the PR description, earlier review comments, or any author/reviewer conclusion documents under `docs/validation`. The required AGENTS instructions, specification, architecture, four adopted ADRs, and development scenarios were read. The production diff and changed regression coverage were inspected independently; the Git safety details and native probe received separate delegated code passes without prior-review material.

## Initial findings

No material correctness defect identified in the inspected changes. This is an initial code finding, not final merge approval.

1. The prepared journal contains source, target, original branch, and saved source before unload. In-memory phase updates retain the durable revision. Completion persists only after restoration and final identity verification. Tests include actual child-process exits before checkout, after checkout, and before final persistence, under both save policies.
2. The checkout method performs its own fresh safety check after outgoing views unload. Identity-only reads are used for branch/root assertions, not as evidence of worktree cleanliness. Complete target coverage is reconstructed from a fresh source-tree/index union and commit-to-commit raw diff; no cross-safeguard ref/index cache was found.
3. Independent unloads and deferred hydrations use `Promise.allSettled`; same-file editable closes remain ordered. Full layout verification still follows native restoration. Event wakeups do not replace filesystem/index/stat/cache checks and are revision-latched across awaited probes.
4. Input protection starts before the 500 ms progress timer, covers activation events and newly opened windows, and is removed on release. The optional native reconciliation is restricted to the inspected Obsidian version and retains complete readiness checks after failed hints.
5. The isolated `npm ci` and `npm run check` completed successfully: typecheck, 272 passing tests, and build. `git diff --check` passed. This is independently reproduced evidence, not reliance on earlier test claims.

## Remaining review work

- Audit raw prior native evidence and its bundle provenance after this blind checkpoint.
- Run a fresh native Linux Obsidian Quick Switcher++ branch roundtrip, including branch-exclusive main/sidebar pins and dirty-state protection, on the reviewed build in the disposable reviewer fixture.
- Inspect required GitHub gates and current merge state.
- Treat latency results separately from correctness: this pass has not yet validated a near-instant or reliably modal-free performance claim.

Fresh build SHA-256: `9dee2cbb8b25f768f81d3b94ec1a7c57ddae55267ae29de459ad00a8d94d3400` (`dist/main.js`).
