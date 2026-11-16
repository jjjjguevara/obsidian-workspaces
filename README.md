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
| Quick Switcher++ | Select this catalog through Workspaces Mode, including its explicit save-and-switch shortcut.              |
| Core Workspaces  | While the core plugin is enabled, its list and commands show and change this same catalog.                 |

This is an initial development build targeting **Obsidian 1.13.0+**. Native validation passed on **Obsidian 1.15.1 with Obsidian Git 2.43.0 on Linux**, including branch-exclusive pinned notes in the main area and both sidebars. The Git adapter accepts **Obsidian Git 2.43.x** and targets the inspected **2.43.0** integration surface. See [Validation](docs/validation.md) for tested behavior and platform limits.

## Working with branches

A workspace can stay unbound, or it can remember a local Git branch. Binding is explicit. Once a workspace is bound, ordinary saves preserve that association; changing it is a deliberate action.

Suppose `Research` belongs to `research` and pins `Research/Working notes.md`, while `Writing` belongs to `writing` and pins `Drafts/Chapter.md`. The notes can exist exclusively on their respective branches. Activating `Writing` saves the outgoing context when save on switch is enabled, checks out `writing`, waits for Obsidian to observe the target files, and restores the saved layout and pins. The active workspace changes after that sequence succeeds.

A branch change requires a clean working tree. Switching layouts on the already-active branch can retain pending changes because it does not require checkout. If a branch change encounters pending changes, a missing branch, an unavailable Git backend, or a repository mismatch, the switch stops and explains the cause. Workspaces does not force checkout, create branches, stash changes automatically, commit, or push. Those remain explicit Git operations.

Changing the branch outside Workspaces can leave the displayed context and saved binding out of alignment. The plugin detects that mismatch before capturing or switching a bound context, so that notes from one branch do not silently replace another branch's saved layout.

Before changing branches, Workspaces awaits saves for text-backed note views and unloads outgoing file views. Native media views and the built-in Backlinks, Outgoing links, and Outline panes are supported. Other editable view types with no supported save lifecycle must be closed first; the plugin reports the view that needs attention.

Exclude Obsidian's live layout files, `.obsidian/workspace.json` and `.obsidian/workspace-mobile.json`, from Git tracking in both branches. The checkout preflight enforces this because those files change as the interface changes. Keep `community-plugins.json` and the Workspaces/Obsidian Git plugin files identical across branches, or untracked, so checkout cannot reload the integration. Use the actual configuration directory if different.

Keep the named core catalog, `.obsidian/workspaces.json`, untracked or ignored as well when core Workspaces is enabled. Workspaces writes that file after a switch. A tracked copy makes the working tree dirty and blocks the next branch change.

## Importing existing workspaces

Imports add records without replacing the current workspace or checking out Git. The settings action **Import this vault's core workspaces** is for a vault where core Workspaces is disabled; with it enabled, the lists are already the same. Workspaces Plus icons, colors, descriptions, and saved tracked-file references are converted from core Workspaces JSON. Workspace++ desktop/mobile layouts and included history are retained; multiple group memberships become one group label joined with `·`. Branch bindings are retained only when importing this product's own export.

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

The plugin maintains its own catalog. Core Workspaces does not have to be enabled. When it is enabled, it is a second view of this catalog, not a second catalog.

## Core Workspaces

With the core Workspaces plugin enabled (inspected on Obsidian 1.15.1), **Manage workspace layouts**, the core load and save commands, and this plugin's menus work on one catalog:

- Loading a layout in core activates that workspace here, with branch checkout and pin restoration.
- Deleting a layout in core deletes the workspace. Core asks for no confirmation.
- Saving in core saves the active workspace, creates a new one, or stores the current layout in another unbound workspace. Saving over a workspace is rejected when a branch binding is involved; activate that workspace, then save it.
- Workspaces created, renamed, saved, or deleted here appear in the core list. Equal names appear as `Name`, `Name (2)`.

Changes made in core while this plugin is disabled are taken in at the next start: deleted layouts delete their workspaces, new layouts become unbound workspaces, and a layout that core saved later replaces the stored one. On the first start, every core layout that has no workspace with the same name is imported. Branch bindings, history, groups, icons, and descriptions exist only in this plugin.

`mode:` entries from Workspaces Plus stay in the core file and are not imported. If Obsidian changes the core plugin's internal interface, Workspaces shows one notice and leaves the core list alone. Do not sync `workspaces.json` between two devices that both run this plugin; each device projects its own catalog. See [ADR 0006](docs/adr/0006-native-core-catalog-bridge.md) for the rules and limits. This bridge has automated tests only; it has not yet been validated in the native application.

## Quick Switcher++ integration

With **Quick Switcher++ 6.3.x** enabled, **Quick Switcher++: Open in Workspaces Mode** lists this product's workspaces. Selecting one uses the same branch validation, checkout, and pinned-layout restoration as the Workspaces menu. Core Workspaces can remain disabled. The integration targets the inspected **6.3.0** release, which requires **Obsidian 1.15.0+**.

Suggestions show the workspace name, group, and saved branch association. Names can repeat; selection uses each workspace's stable ID. Quick Switcher++'s save-and-switch shortcut (default **Mod+Shift+S**) explicitly saves the source before activating the target, including when save on switch is disabled. A failed save stops the switch. Creating a workspace from an empty search result uses this product's catalog as well.

The Workspaces status indicator shows the active workspace name. Obsidian Git owns the active-branch indicator; Workspaces does not repeat it. Branch associations remain visible in workspace selection and settings.

## Direction

The current work concentrates on dependable workspace restoration, native presentation, and branch-aware switching. A custom workspace interface is a later layer. Automatic cross-device reconciliation, Git switching on mobile, remote-branch creation, and automatic commit/push workflows are outside the initial scope.

## Project documentation

- [Specification](docs/specification.md): behavior and acceptance cases.
- [Architecture](docs/architecture.md): state, storage, and transition boundaries.
- [Development](docs/development.md): build and validation workflow.
- [Validation](docs/validation.md): automated checks, native application results, and remaining platform coverage.
- [Native performance measurements](docs/validation/native-completion-budget/README.md): matched Linux sessions, measured limitations and the current acceptance decision.
- [Local Mac performance gate](docs/performance/local-mac-closure.md): reproduce native benchmarks, compare identified builds and document the result required before performance issue closure.
- [Architecture decisions](docs/adr/0001-workspace-authority-and-persistence.md): state, native integration, Git, transitions, [performance acceptance](docs/adr/0005-performance-measurement-and-closure.md) and the [core Workspaces bridge](docs/adr/0006-native-core-catalog-bridge.md).

## Attribution and license

Workspaces is a personal project maintained by **jjjjguevara**. It adapts selected work from [Workspace++ by s1m4ne](https://github.com/s1m4ne/obsidian-workspace-plus) and [Workspaces Plus by jsmorabito](https://github.com/jsmorabito/obsidian-workspaces-plus), with integrations targeting [Obsidian Git](https://github.com/Vinzent03/obsidian-git) and [Quick Switcher++](https://github.com/darlal/obsidian-switcher-plus).

The combined project is licensed under [GNU GPL version 3](LICENSE). Original notices, source revisions, and the retained MIT license texts are recorded in [Third-party notices](THIRD_PARTY_NOTICES.md).
