# Workspaces

Workspaces saves the context of a task in Obsidian: its open notes, pinned tabs, splits, sidebars, and, optionally, its Git branch. Returning to a workspace restores the files and layout that belong together.

The first version uses Obsidian's native controls. A workspace switcher, commands, settings, and a status indicator provide the interface; a single workspace catalog and transition controller manage the state underneath. A custom interface can build on that same foundation later.

## Initial scope

| Capability       | Scope                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Named workspaces | Create, save, rename, duplicate, delete, and assign a group, icon, color, and description.                 |
| Native layouts   | Restore the main editor area and both sidebars, including saved pin state.                                 |
| Save behavior    | Explicit saves and optional save on switch. Saving a layout does not commit files to Git.                  |
| Layout history   | Keep up to 30 previous saved contexts per workspace and restore one through the normal switch flow.        |
| Branch binding   | On desktop, associate a workspace with the current local branch through the installed Obsidian Git plugin. |
| Imports          | Bring in core Workspaces layouts, Workspaces Plus presentation metadata, or Workspace++ session JSON.      |
| Transfer         | Export and import workspace snapshots explicitly.                                                          |
| Mobile           | Use unbound workspaces and a separate mobile layout. Git-bound activation is desktop only.                 |

This is an initial development build targeting **Obsidian 1.13.0+**. Native validation passed on **Obsidian 1.15.1 with Obsidian Git 2.43.0 on Linux**, including branch-exclusive pinned notes in the main area and both sidebars. The Git adapter accepts **Obsidian Git 2.43.x** and targets the inspected **2.43.0** integration surface. See [Validation](docs/validation.md) for tested behavior and platform limits.

## Working with branches

A workspace can stay unbound, or it can remember a local Git branch. Binding is explicit. Once a workspace is bound, ordinary saves preserve that association; changing it is a deliberate action.

Suppose `Research` belongs to `research` and pins `Research/Working notes.md`, while `Writing` belongs to `writing` and pins `Drafts/Chapter.md`. The notes can exist exclusively on their respective branches. Activating `Writing` saves the outgoing context when save on switch is enabled, checks out `writing`, waits for Obsidian to observe the target files, and restores the saved layout and pins. The active workspace changes after that sequence succeeds.

A branch change requires a clean working tree. Switching layouts on the already-active branch can retain pending changes because it does not require checkout. If a branch change encounters pending changes, a missing branch, an unavailable Git backend, or a repository mismatch, the switch stops and explains the cause. Workspaces does not force checkout, create branches, stash changes automatically, commit, or push. Those remain explicit Git operations.

Changing the branch outside Workspaces can leave the displayed context and saved binding out of alignment. The plugin detects that mismatch before capturing or switching a bound context, so that notes from one branch do not silently replace another branch's saved layout.

Before changing branches, Workspaces awaits saves for text-backed note views and unloads outgoing file views. Native media views and the built-in Backlinks, Outgoing links, and Outline panes are supported. Other editable view types with no supported save lifecycle must be closed first; the plugin reports the view that needs attention.

Exclude Obsidian's live layout files, `.obsidian/workspace.json` and `.obsidian/workspace-mobile.json`, from Git tracking in both branches. The checkout preflight enforces this because those files change as the interface changes. Keep `community-plugins.json` and the Workspaces/Obsidian Git plugin files identical across branches, or untracked, so checkout cannot reload the integration. Use the actual configuration directory if different. The named core catalog, `workspaces.json`, is a different file used for import.

## Importing existing workspaces

Imports add records without replacing the current workspace or checking out Git. Workspaces Plus icons, colors, descriptions, and saved tracked-file references are converted from core Workspaces JSON. Workspace++ desktop/mobile layouts and included history are retained; multiple group memberships become one group label joined with `·`. Branch bindings are retained only when importing this product's own export.

Modes, workspace-specific Obsidian configuration overrides, automatic sidebar propagation, and upstream synchronization settings are outside this version's scope. See the [import contract](docs/specification.md#persistence-and-transfer) for conversion details.

## Data and recovery

On desktop, the workspace catalog, history, and transition journal live in `obsidian-workspaces/<vault-key>/state.json` beneath the operating system's application-data location. The vault key is the first 24 hexadecimal characters of SHA-256 over its canonical path. Binding verifies that this store is outside the Git working tree. The previous complete file is preserved as `state.json.backup`; writes use a lock and reject conflicting edits from another vault instance. [Architecture](docs/architecture.md#storage) documents the exact locations and interrupted-lock handling.

Mobile uses Obsidian's plugin data storage. An external sync service may copy that file; this version does not reconcile concurrent edits across devices. Use explicit export/import to transfer contexts. Moving a desktop vault to another path also changes its storage key; export before moving it and import afterward. Imported branch bindings still identify their original repository location. Remove the old binding before activating such a record in another repository, then bind the current workspace explicitly.

An interrupted transition leaves a recovery record. Startup reports it and preserves the saved contexts without checking out a branch automatically.

## Install a development build

```sh
npm ci
npm run check
```

Copy `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` into:

```text
<vault>/.obsidian/plugins/obsidian-workspaces/
```

Use the vault's actual configuration directory if it differs from `.obsidian`, then enable **Workspaces** under Community plugins. Branch-bound workspaces additionally require Obsidian Git to be enabled and initialized for that vault.

The plugin maintains its own catalog. Core Workspaces is an import source; it is not a second catalog that must remain enabled or synchronized.

## Direction

The current work concentrates on dependable workspace restoration, native presentation, and branch-aware switching. A custom workspace interface is a later layer. Automatic cross-device reconciliation, Git switching on mobile, remote-branch creation, and automatic commit/push workflows are outside the initial scope.

## Project documentation

- [Specification](docs/specification.md): behavior and acceptance cases.
- [Architecture](docs/architecture.md): state, storage, and transition boundaries.
- [Development](docs/development.md): build and validation workflow.
- [Validation](docs/validation.md): automated checks, native application results, and remaining platform coverage.
- [Architecture decisions](docs/adr/0001-workspace-authority-and-persistence.md): the four adopted foundations.

## Attribution and license

Workspaces is a personal project maintained by **jjjjguevara**. It adapts selected work from [Workspace++ by s1m4ne](https://github.com/s1m4ne/obsidian-workspace-plus) and [Workspaces Plus by jsmorabito](https://github.com/jsmorabito/obsidian-workspaces-plus), with an integration targeting [Obsidian Git](https://github.com/Vinzent03/obsidian-git).

The combined project is licensed under [GNU GPL version 3](LICENSE). Original notices, source revisions, and the retained MIT license texts are recorded in [Third-party notices](THIRD_PARTY_NOTICES.md).
