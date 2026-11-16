# Product specification

## Purpose

Workspaces preserves an Obsidian working context and restores it as a unit. A context combines a stable workspace identity, native layout, presentation, and an optional local Git branch. The primary branch workflow is switching between sets of pinned notes that exist on different branches of the same vault repository.

## Workspace behavior

Each workspace has a stable ID independent of its editable name. A record can include one group label, icon, color, description, separate desktop/mobile layouts, and a branch binding. Creating or duplicating a record allocates a new ID. Renaming retains its ID, saved layouts, history, and binding.

Duplication copies the selected workspace's presentation, branch association, layout slots, and history into an independent record. Subsequent changes to either copy do not mutate the other. Import preserves identities from this product where valid and allocates identities for source formats that have none. A matching display name alone does not establish identity. The one exception is the first contact with the core Workspaces list: a core entry and a record are paired when exactly one never-projected record has that name.

Users can save explicitly or enable save on switch. Manual mode retains the last saved layout until the user saves again and asks before discarding changed layout state during activation. Layout saves record Obsidian state; they do not persist a Git commit. Saving a changed layout or binding retains the previous context in history, bounded to 30 entries per workspace. There is no periodic or layout-change autosave.

The default restoration scope includes the main editor area and both sidebars. Pin flags, pane relationships, active tabs, and file references travel with the native layout. Shared interface chrome must not overwrite a workspace's branch-specific note leaves. A history restore uses the same transition path as an ordinary activation.

If an unbound workspace lacks a layout for the current platform, its main area is applied over the current platform's sidebars and saved as a new platform slot. Full sidebar restoration then uses that slot. A branch-bound snapshot cannot use this cross-platform fallback.

## Workspace selection integrations

The status bar shows the committed workspace name without a branch suffix. Obsidian Git displays the live branch. Workspace selectors and settings may show saved branch associations to distinguish target contexts.

With supported Quick Switcher++ 6.3.x enabled (tested with 6.3.0), **Open in Workspaces Mode** lists this product's catalog even when core Workspaces is disabled. Selecting a suggestion activates its stable ID through the transition controller, including branch checkout and pinned-layout restoration. Equal display names remain separate records. Search includes names, groups, branch associations, and descriptions.

Quick Switcher++'s save-and-switch action explicitly saves the source and activates the target under one controller queue owner. It applies in manual-save mode and still saves when the target is already active. A failed save or changed queued source prevents activation. Its no-results create action creates a record in this product. Stale suggestions from a replaced provider are rejected; provider reload and plugin disable restore the relevant hooks. Unsupported versions or missing private capabilities produce an integration notice. Core Workspaces commands follow the bridge below.

While core Workspaces is enabled (inspected on Obsidian 1.15.1), its list and this catalog behave as one catalog. The catalog is the authority. The core list shows every record in catalog order under its display name; equal names get a suffix such as `Name (2)`. The core dialogs, commands and CLI handlers go to the controller:

| Core action                           | Result                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load a layout                         | Activates that workspace through the transition controller, with branch checkout and pin restoration.                                                                     |
| Delete a layout                       | Deletes that workspace. The active workspace is replaced first, as in the product's own delete. Core asks for no confirmation.                                            |
| Save under the active name            | Saves the active workspace.                                                                                                                                               |
| Save under a new name                 | Creates a workspace from the current layout and makes it active.                                                                                                          |
| Save under the name of another record | Stores the current layout in that workspace and makes it active. Rejected when that workspace or the active workspace has a branch binding; activate it first, then save. |

A rejected action shows the controller's error and the core list returns to the catalog's content. A change made in the product (create, save, rename, duplicate, delete, import, switch) appears in the core list after the controller is idle. Bindings, history and product metadata stay in the catalog.

Changes made in core while Workspaces is not running are taken in at the next start, in one commit and with no activation: a deleted entry deletes its record, a new entry becomes an unbound record, and a layout that core saved later than the record replaces the record's layout with the binding kept. If core lists nothing at all, no record is deleted. Reconciliation waits until an interrupted switch is recovered. An Obsidian version with a different core Workspaces interface gets one notice and no bridge. [ADR 0006](adr/0006-native-core-catalog-bridge.md) has the complete rules and limits.

## Branch behavior

Binding is optional and explicit. A bound record identifies the repository and an existing local branch; it does not infer a branch from the workspace name. Ordinary saves preserve the binding. Explicit rebinding associates the current observed branch with a newly captured layout, so that old branch context cannot silently acquire a new ref.

The initial backend is the installed Obsidian Git plugin. The adapter accepts 2.43.x and targets the inspected version 2.43.0 contracts. It must be enabled, initialized, associated with the expected repository, and capable of the required operations. An incompatible or unavailable backend produces a clear error. Unbound workspaces continue to function without it.

Before a checkout, the controller finishes applicable note saves, captures the source layout, checks the actual source branch, validates the target local branch, and checks working-tree status. A dirty working tree blocks a branch change, including tracked and untracked changes reported by Git. Switching layouts on the already-active branch does not require checkout and may retain pending file changes. Workspaces does not stash, commit, push, force checkout, or create a target branch as a side effect.

The host awaits the public save operation for `TextFileView` instances. Before checkout it unloads outgoing file views; native PDF, image, audio, and video views are supported. Other editable file views and file-backed views with no supported save lifecycle must be closed first. Their presence blocks checkout with a view-specific error. This is not a universal flush contract for arbitrary community-plugin editors.

Status and checkout protections also reject conflicts, detached HEAD, an ongoing merge/rebase or similar Git operation, recursive submodule checkout, and ignored local files that the target branch would replace. Checkout requires native `workspace.json` and `workspace-mobile.json` to be untracked in both branches. Changes to the integration plugin directories or `community-plugins.json` across branches are rejected so checkout cannot reload its own runtime. Symlink aliases for these runtime paths are also rejected. The adapter refreshes Obsidian Git's source-control view and branch indicator after checkout; presentation failure does not change the reported Git outcome.

An unbound workspace changes only the layout. Activating it leaves the repository's current branch unchanged. On mobile, bound activation is unavailable; unbound workspaces remain usable.

## Transition contract

Only one transition may own workspace activation at a time. A slow valid operation does not lose ownership because a fixed timeout has elapsed. The controller serializes or rejects later requests explicitly.

During activation, background capture, history snapshots, and competing layout changes must not save a partially updated view. The controller records the source and target context, performs the checkout when necessary, observes the resulting vault files, applies the target layout, and then persists the active workspace identity. UI indicators follow committed state.

Short transitions do not open a progress modal. Input protection begins immediately; “Switching workspace” appears only if the protected operation remains active after 500 ms. File observation reacts to vault events and still verifies every readiness condition before loading the target.

Failure must leave an accurate outcome. If failure occurs before checkout, retain the source context. If the branch changed but restoration failed, retain the recovery record and report the observed branch and incomplete target. Attempt only recovery that the implementation can verify; do not announce that the source was restored merely because a rollback was attempted.

The journal survives a process interruption. On startup, an incomplete transition is surfaced for recovery without an automatic checkout. Explicit recovery is a controlled operation through the same lifecycle.

The complete journal is durable before views are unloaded. A successful switch writes again only after the target has been restored and verified. An interrupted prepared journal may therefore describe a checkout that already happened; recovery checks the actual branch instead of inferring it from the journal phase.

## Persistence and transfer

Desktop control state uses an application-data directory keyed by the canonical vault path. Git binding verifies that it lies outside the repository. Writes use atomic replacement, preserve one previous generation, and require an exclusive write lock plus the expected state revision. A competing write is rejected instead of merged. The persisted schema is versioned; incompatible future versions must not be silently overwritten.

The state also holds the optional `nativeCatalog` baseline of the core Workspaces bridge: the names that the core list last received, and the names of records removed since. It is local to the device. An entry for an unknown record is dropped on load. Exports omit it and imports never carry it.

The bridge writes `<config-dir>/workspaces.json` through the core plugin when the projected list changes, including after a switch. With branch-bound workspaces, keep that file untracked or ignored, like `workspace.json`: a write to a tracked file makes the working tree dirty and blocks the next branch change.

Mobile uses the plugin's `loadData`/`saveData` storage. This provides mobile persistence, not a concurrent merge protocol. The initial product has no automatic cross-device reconciliation. An external sync service may transport mobile plugin data independently of Workspaces.

Explicit imports support this product's export format, native core Workspaces data, and Workspace++ sessions. Imports validate their shape, preserve desktop/mobile distinctions where available, and do not automatically check out a branch. Imported activation requires a separate controlled transition. Exports retain the context metadata required for later restoration; machine-local credentials or live backend objects are not export data.

| Source                                | Conversion                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces export                     | Preserve record order, metadata, layout slots, bindings, and history. Add records to the current catalog; allocate a new ID when an imported ID already exists. The imported active ID, preferences, and recovery journal do not become live state.                                                                    |
| Core Workspaces JSON                  | Convert named layouts to new stable IDs. The settings action reads `<config-dir>/workspaces.json`; file and pasted JSON imports use the same conversion. With core Workspaces enabled, the bridge already links both lists and the settings action is off.                                                             |
| Workspaces Plus metadata in core JSON | Convert icon, icon color, and description. Reinstate available tracked-file references in main-area leaves, then remove the upstream metadata payload from the native layout. Skip `mode:` records; do not apply configuration overrides or Modes.                                                                     |
| Workspace++ JSON                      | Read direct session data or its export wrapper. Preserve valid session IDs, session order, desktop/mobile slots, and history included in that JSON. Convert multiple group memberships to one label joined with `·`; use the first group's icon/color as fallbacks. Separate history files are not read automatically. |

Core and Workspace++ imports start unbound. Imported product bindings retain their original repository paths; users can remove a binding from an inactive record before activating it elsewhere. Binding the active record then captures the current repository, branch, and layout. Removing a binding preserves earlier bound history snapshots.

No import format enables live catalog synchronization, Modes, workspace-specific global configuration replacement, or automatic propagation of one workspace's sidebars to another. The only live link is the core Workspaces bridge on the same device. `mode:` entries in the core list are not imported; the bridge leaves them in the core file.

## Acceptance cases

| Case                                           | Required result                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Save, rename, duplicate                        | Identity survives rename; duplicate receives a new ID and independent metadata/layouts.                           |
| Clean A → B → A                                | Each branch becomes active before its saved notes and pins are restored. Returning to A restores A's own pin set. |
| Branch-exclusive notes                         | Notes absent from the current branch remain referenced in inactive saved contexts.                                |
| Pinned sidebar note                            | Switching restores the target sidebar's note and pin state instead of retaining the source branch's note.         |
| Dirty working tree and different target branch | No checkout occurs; the source context remains identifiable and the reason is shown.                              |
| Dirty working tree and same target branch      | The layout can switch without changing branches or committing pending edits.                                      |
| Missing branch/backend                         | No partial activation is reported as success.                                                                     |
| Rapid repeat switching                         | Requests cannot interleave checkouts or restore a superseded target over a newer one.                             |
| Long checkout                                  | History/capture cannot replace a saved layout with temporary empty leaves.                                        |
| External branch change                         | A bound context is not silently recaptured against a different branch.                                            |
| Interrupted process                            | The journal is recognized after restart; startup does not change Git branches.                                    |
| Import/export                                  | Identities and context metadata round-trip; imports alone do not activate Git.                                    |
| Mobile without Git                             | Unbound workspaces can be saved and restored using the mobile layout slot.                                        |
| Unsupported editable view                      | Branch checkout is blocked and the user is told which view to close; the saved context remains available.         |
| Concurrent desktop writer                      | Lock or revision conflict is reported; neither instance silently overwrites the other's catalog.                  |
| Quick Switcher++ selection                     | The product workspace, actual branch, and restored pins agree, including with core Workspaces disabled.           |
| Quick Switcher++ save-and-switch               | The source is saved before target activation; save failure or a changed queued source prevents activation.        |
| Duplicate display names in Quick Switcher++    | Suggestions activate their own stable IDs rather than a same-name core or product record.                         |
| Workspace status indicator                     | Workspace name appears once; the active branch is left to Obsidian Git's indicator.                               |
| Core Workspaces load                           | The product workspace, actual branch, and restored pins agree; core never restores a layout by itself.            |
| Core Workspaces save                           | The active name saves; a new name creates; another unbound name takes the layout; a bound side is rejected.       |
| Core Workspaces delete                         | The record is deleted and the core list shows the result when the dialog renders again.                           |
| Product change with core enabled               | Create, rename, delete, and switch appear in the core list; equal names get stable suffixes.                      |
| Core change while Workspaces is disabled       | Next start takes deletions, new entries, and later saves into the catalog in one commit without activation.       |
| Interrupted projection                         | Next start keeps the catalog's content unless core holds a later save for that entry.                             |
| Unsupported core Workspaces interface          | One notice; core is not changed and the lists stay separate.                                                      |

Custom interface work and automatic multi-device merge are later product decisions. They must preserve these context and transition guarantees.
