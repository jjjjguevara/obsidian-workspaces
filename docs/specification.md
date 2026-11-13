# Product specification

## Purpose

Workspaces preserves an Obsidian working context and restores it as a unit. A context combines a stable workspace identity, native layout, presentation, and an optional local Git branch. The primary branch workflow is switching between sets of pinned notes that exist on different branches of the same vault repository.

## Workspace behavior

Each workspace has a stable ID independent of its editable name. A record can include a group, icon, description, separate desktop/mobile layouts, and a branch binding. Creating or duplicating a record allocates a new ID. Renaming retains its ID, saved layouts, history, and binding.

Duplication copies the selected workspace's presentation, branch association, and layout slots into an independent record. Subsequent changes to either copy do not mutate the other. Import preserves identities from this product where valid and allocates identities for source formats that have none. A matching display name alone does not establish identity.

Users can save explicitly or enable save on switch. Manual mode retains the last saved layout until the user saves again. Layout saves record Obsidian state; they do not persist a Git commit. History records enough context to interpret a snapshot against the branch on which it was captured.

The default restoration scope includes the main editor area and both sidebars. Pin flags, pane relationships, active tabs, and file references travel with the native layout. Shared interface chrome must not overwrite a workspace's branch-specific note leaves. A history restore uses the same transition path as an ordinary activation.

## Branch behavior

Binding is optional and explicit. A bound record identifies the repository and an existing local branch; it does not infer a branch from the workspace name. Ordinary saves preserve the binding. Explicit rebinding associates the current observed branch with a newly captured layout, so that old branch context cannot silently acquire a new ref.

The initial backend is the installed Obsidian Git plugin, with a compatibility surface targeted at version 2.43.0. It must be enabled, initialized, associated with the expected repository, and capable of the required operations. An incompatible or unavailable backend produces a clear error. Unbound workspaces continue to function without it.

Before a checkout, the controller finishes applicable note saves, captures the source layout when requested, checks the actual source branch, validates the target local branch, and checks working-tree status. A dirty working tree blocks a branch change, including untracked changes that make the configured status check dirty. Switching layouts on the already-active branch does not require checkout and may retain pending file changes. Workspaces does not stash, commit, push, force checkout, or create a target branch as a side effect.

An unbound workspace changes only the layout. Activating it leaves the repository's current branch unchanged. On mobile, bound activation is unavailable; unbound workspaces remain usable.

## Transition contract

Only one transition may own workspace activation at a time. A slow valid operation does not lose ownership because a fixed timeout has elapsed. The controller serializes or rejects later requests explicitly.

During activation, background capture, history snapshots, and competing layout changes must not save a partially updated view. The controller records the source and target context, performs the checkout when necessary, observes the resulting vault files, applies the target layout, and then persists the active workspace identity. UI indicators follow committed state.

Failure must leave an accurate outcome. If failure occurs before checkout, retain the source context. If the branch changed but restoration failed, retain the recovery record and report the observed branch and incomplete target. Attempt only recovery that the implementation can verify; do not announce that the source was restored merely because a rollback was attempted.

The journal survives a process interruption. On startup, an incomplete transition is surfaced for recovery without an automatic checkout. Explicit recovery is a controlled operation through the same lifecycle.

## Persistence and transfer

Desktop control state lives outside the vault's Git working tree in an application-data directory keyed by the vault path. Writes use atomic replacement and preserve a backup. The persisted schema is versioned; incompatible future versions must not be silently overwritten.

Mobile uses the plugin's `loadData`/`saveData` storage. This provides mobile persistence, not a concurrent merge protocol. The initial product has no automatic cross-device reconciliation. An external sync service may transport mobile plugin data independently of Workspaces.

Explicit imports support this product's export format, native core Workspaces data, and Workspace++ sessions. Imports validate their shape, preserve desktop/mobile distinctions where available, and do not automatically check out a branch. Imported activation requires a separate controlled transition. Exports retain the context metadata required for later restoration; machine-local credentials or live backend objects are not export data.

## Acceptance cases

| Case | Required result |
| --- | --- |
| Save, rename, duplicate | Identity survives rename; duplicate receives a new ID and independent metadata/layouts. |
| Clean A → B → A | Each branch becomes active before its saved notes and pins are restored. Returning to A restores A's own pin set. |
| Branch-exclusive notes | Notes absent from the current branch remain referenced in inactive saved contexts. |
| Pinned sidebar note | Switching restores the target sidebar's note and pin state instead of retaining the source branch's note. |
| Dirty working tree and different target branch | No checkout occurs; the source context remains identifiable and the reason is shown. |
| Dirty working tree and same target branch | The layout can switch without changing branches or committing pending edits. |
| Missing branch/backend | No partial activation is reported as success. |
| Rapid repeat switching | Requests cannot interleave checkouts or restore a superseded target over a newer one. |
| Long checkout | History/capture cannot replace a saved layout with temporary empty leaves. |
| External branch change | A bound context is not silently recaptured against a different branch. |
| Interrupted process | The journal is recognized after restart; startup does not change Git branches. |
| Import/export | Identities and context metadata round-trip; imports alone do not activate Git. |
| Mobile without Git | Unbound workspaces can be saved and restored using the mobile layout slot. |

Custom interface work and automatic multi-device merge are later product decisions. They must preserve these context and transition guarantees.
