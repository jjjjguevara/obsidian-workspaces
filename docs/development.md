# Development

## Build

Use Node.js with the committed npm lockfile.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run check` runs the repository's combined verification. The build emits `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`. Install those three files under the vault's plugin directory named `obsidian-workspaces`.

Obsidian is provided by the application and remains external to the bundle. The desktop Git backend is the separately installed Obsidian Git plugin; this repository does not bundle that plugin or its credentials.

## Test boundaries

Model tests verify identity, independent duplication, metadata retention, migration, and history. Transition tests use controllable backends to exercise slow requests, checkout failure, missing branches, repository mismatch, persistence failure, and interrupted recovery. Layout fixtures must include pins and branch-exclusive file paths.

An adapter test should check the exact backend capability assumptions, including serialized operation behavior. A passing fake-backend test does not prove compatibility with an installed plugin. Likewise, a mocked layout restore cannot establish that Obsidian's filesystem observer has populated the expected files.

## Desktop validation

Use a disposable vault with two existing local branches and the targeted Obsidian Git version. Create a different note on each branch, commit both branch states, and keep the control store outside that repository.

Keep the live layout files out of Git tracking. For the default configuration directory, the ignore entries are:

```gitignore
/.obsidian/workspace.json
/.obsidian/workspace-mobile.json
```

Use the actual configuration directory for the vault. Ignore rules do not stop tracking files already in the index; remove those runtime files from the index separately. The named core catalog `workspaces.json` is a distinct import source. Do not use a blanket ignore rule for all configuration merely to hide a dirty-state failure.

| Scenario                                          | Observe                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Save A and B with different pins                  | Each record retains its own main-area and sidebar pin state.                                                         |
| Switch A → B → A                                  | Actual Git branch, visible notes, pin flags, active workspace, and saved state agree after each transition.          |
| Edit a tracked note                               | A checkout is blocked until changes are handled explicitly through Git.                                              |
| Add an untracked note                             | The dirty-status check blocks checkout and preserves the source context.                                             |
| Disable Git or select a missing branch            | The error identifies the missing capability/ref; no target is reported active.                                       |
| Switch repeatedly                                 | No overlapping checkout or stale target restoration occurs.                                                          |
| Delay checkout or vault observation               | Incidental layout events cannot save an empty or intermediate workspace.                                             |
| Open an unsupported editable view                 | Preflight stops before checkout or journal creation and identifies the view to close; close it and retry the switch. |
| Change contents at the same path between branches | The target opens current content after vault metadata and cached text catch up.                                      |
| Change branches externally                        | Saving a bound workspace detects the mismatch.                                                                       |
| Interrupt after checkout                          | Restart surfaces the journal and leaves the actual branch unchanged.                                                 |
| Restore history and import data                   | Restores use the controller; importing records alone does not check out Git.                                         |

Also test an unbound workspace with Git disabled, a same-branch layout switch with pending file edits, an unbound mobile save/restore, and export/import round-trips. Import fixtures should cover multiple Workspace++ groups, Workspaces Plus presentation/tracked-file metadata, skipped Modes, colliding IDs, and foreign repository bindings.

Confirm that a corrupt primary JSON is rejected without silent overwrite and that its preserved backup remains available for explicit recovery. Test competing desktop writes and a leftover `state.json.lock`: a stale writer must be rejected, and the plugin must not steal the lock. Remove a leftover lock manually only after closing every instance that could write that vault's state. When a verification step cannot run, report that limitation instead of substituting a source inspection result.

## Adding a feature

Place state changes in the catalog or controller and let native UI call them. A new activation entry point must not invoke checkout or layout restoration directly. A later custom interface should reuse the same operations.

When adding a model field, trace creation, explicit save, duplication, history, migration, import, export, and persistence. A TypeScript index signature does not establish that every route preserves the field. Branch/layout revisions require a defined policy rather than a generic metadata merge.

Keep meaningful failure tests next to the behavior they protect. Avoid carrying upstream test harnesses or checks that test a source layout the product no longer uses.

## Adapted source

Retain source notices in copied or substantially adapted code. Record new upstream revisions and affected areas in `THIRD_PARTY_NOTICES.md`. Keep complete third-party license texts under `LICENSES/`. The product README contains a short attribution section at the bottom; implementation history belongs in commits and notices.

The repository is maintained for personal use. Publishing a release or changing repository visibility is a separate action governed by the user's instructions.
