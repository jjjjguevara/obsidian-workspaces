# Workspaces development

Workspaces is the personal Obsidian plugin maintained in this repository. Its plugin ID is `obsidian-workspaces`. Keep product documentation about its behavior; put upstream provenance in `THIRD_PARTY_NOTICES.md` and retain original notices for adapted code.

Read `docs/specification.md`, `docs/architecture.md`, and the four records in `docs/adr/` before changing workspace state, storage, Git integration, or activation behavior. These records describe adopted decisions. Update the relevant record when an authorized product decision changes; do not silently introduce a competing model.

## Implementation boundaries

- Maintain one workspace catalog with stable IDs. Renames do not change identity.
- Route every activation and history restore through the serialized transition controller. UI callbacks must not call checkout or layout restoration independently.
- Keep native Obsidian UI separate from state transitions. Prefer its supported controls; isolate unavoidable private interfaces in the compatibility boundary.
- Capture source layouts before checkout removes files. Preserve pin state and branch-owned sidebar leaves. Do not propagate those leaves across every workspace.
- Treat a branch binding and its layout revision as one context. Preserve presentation and binding metadata through duplication, history, imports, and exports.
- Persist desktop control data outside the vault/repository. Use atomic replacement and a backup, and retain a journal for incomplete transitions.
- Bound activation initially supports desktop through the installed Obsidian Git adapter. Unbound workspaces remain usable without Git and on mobile.
- A dirty working tree blocks branch changes; a layout switch on the current branch may retain pending changes. Saving a workspace is not a Git commit. Do not add implicit stash, force checkout, branch creation, commit, push, or startup checkout.
- Suspend incidental captures during transitions. Passive imports, external storage changes, and lifecycle events must not bypass transition ownership.

## Changes and verification

Use `npm run check` for the repository's typecheck, tests, and build. Add tests for state transitions, migrations, or recovery behavior when those contracts change. Keep fixtures small and focused on real failure cases.

Application behavior requires the scenarios in `docs/development.md`; mocked host tests do not establish that Obsidian has restored actual pinned tabs or completed filesystem observation. Report which checks ran and which require a desktop session.

Keep README claims aligned with implemented behavior. Mark deferred features explicitly. Do not import upstream agent instructions, unrelated workflows, complete source trees, or documentation merely because they are present in an upstream repository. Repository visibility and release publication are controlled by the user's instructions.
