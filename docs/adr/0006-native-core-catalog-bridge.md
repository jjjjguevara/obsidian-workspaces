# ADR 0006 — Native core catalog bridge

**Status:** Accepted

**Date:** 2026-11-16

## Context

Workspaces keeps its catalog in a control store outside the vault. Obsidian's core Workspaces plugin keeps a second list in `<config-dir>/workspaces.json`. The two lists drifted. A layout that was saved or deleted in the core "Manage workspace layouts" dialog did not change the product catalog. A change in the product did not change the core list.

The owner decided that the two menus must behave as one catalog. Delete, save, load and other management in either place must take effect in both.

[ADR 0001](0001-workspace-authority-and-persistence.md) and [ADR 0002](0002-obsidian-integration-and-native-interface.md) did not permit this. ADR 0002 said that live interoperability needs a new decision and an adapter that routes activation before layout restoration. This record is that decision.

The core plugin in Obsidian 1.15.1 has no public API and fires no events. All core UI, commands and CLI handlers read `instance.workspaces` and `instance.activeWorkspace`. They call `saveWorkspace`, `setActiveWorkspace`, `loadWorkspace` and `deleteWorkspace` on the plugin instance. `loadWorkspace` restores a layout directly. It does not know about branches, pins that belong to a branch, or the recovery journal.

## Decision

### Authority

The product catalog stays the only authority. It holds stable IDs, branch bindings and history, and it must stay outside the repository. The core list cannot hold that data.

While Workspaces and core Workspaces are both enabled, the core list is a projection of the catalog. Core operations are routed to the transition controller. `src/obsidian/native-catalog.ts` is the compatibility boundary. The bridge never restores a layout itself.

### Routing

The bridge checks the core instance first. The four methods and `saveData` must be functions and `workspaces` must be an object. If not, the bridge does not touch core, shows one notice and stays inactive.

The bridge replaces the four methods on the instance. It keeps the original descriptors and restores them only when the method is still its own wrapper.

| Core request                        | Routed to                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadWorkspace(name)`               | `activate(id)`. Checkout, file readiness and restoration follow [ADR 0004](0004-workspace-transitions-and-recovery.md).                                                                |
| `deleteWorkspace(name)`             | `remove(id)`. Deletion of the active workspace opens the replacement first, as the product does. Core has no confirmation step and the bridge adds none.                               |
| `saveWorkspace(name)`, active name  | `saveActive()`.                                                                                                                                                                        |
| `saveWorkspace(name)`, new name     | `create(name)`.                                                                                                                                                                        |
| `saveWorkspace(name)`, other record | `saveCurrentTo(id)`. The live layout becomes that record's layout for this device and the record becomes active. Permitted only when that record and the active workspace are unbound. |
| `setActiveWorkspace(name)`          | Nothing is persisted. The active name follows the controller.                                                                                                                          |

`saveCurrentTo` does no checkout and no restoration. A bound record on either side is rejected. The message tells the user to activate that workspace and save it.

Core calls `saveWorkspace` synchronously and renders its list directly afterwards. The bridge puts an optimistic entry in the in-memory list. The projection replaces or removes that entry when the controller operation settles.

The promises that core awaits settle after the catalog commit and the next projection. They never reject. A rejected controller operation shows a notice with the error message. A name that the bridge cannot map shows a notice and the list is projected again.

Core requests run in order inside the bridge. Each request maps its name against the list that the previous request left.

### Projection

The bridge subscribes to the controller. The listener only schedules a timer task. A projection runs only when the controller is idle, so it never runs inside an activation promise. A projection that follows a controller notification waits 50 ms. A projection that follows a core request does not wait.

The projection lists catalog records in catalog order. Each entry is a copy of the record's layout for the current device, with `mtime` set from the saved time in the format that core writes. Equal display names get a suffix in catalog order: `Name`, `Name (2)`. A suffix never takes the real name of another record. The active name is the projected name of the committed workspace. While a recovery journal exists it is the journal's source.

The bridge writes the core file with the original `saveData`, and only when the projection differs from the content that it knows is on disk. Bindings, history, IDs and product metadata do not leave the catalog.

### Reconciliation

Core can change while Workspaces is not running. The bridge reconciles when it starts: at plugin load, and when core Workspaces is enabled later.

The state has an optional `nativeCatalog` field. `projected` maps a record ID to the name that the last confirmed projection gave it. This baseline lags. A record enters it only after its projection was written. The schema version stays 1. Exports do not contain the field and imports do not carry it.

A pure function computes the plan. One controller operation applies it in one commit. It does no activation, no layout change and no Git call. It does not run while a recovery journal exists or while the controller is busy. It runs after recovery completes.

| Core list compared with the catalog                                         | Result                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry name is in the baseline for record R, same layout (ignoring `mtime`)  | Nothing.                                                                                                                                                                                                                                                                      |
| Same, different layout, core `mtime` later than R's saved time              | R adopts the core layout. The binding stays. The old layout goes to history.                                                                                                                                                                                                  |
| Same, different layout, core `mtime` not later                              | R stays. The projection overwrites the core entry.                                                                                                                                                                                                                            |
| Entry name not in the baseline, exactly one unprojected record has the name | Pair them and apply the same comparison.                                                                                                                                                                                                                                      |
| Entry name not in the baseline, no pair                                     | Import as a new unbound record with the explicit core import conversion (Workspaces Plus metadata included).                                                                                                                                                                  |
| Record in the baseline, its projected name absent from core                 | An unbound record was deleted in core. Remove it. If it was active, there is no active workspace and no transition. A branch-bound record is kept and projected again: the core file cannot hold its binding, and a file that Git or a sync tool replaced must not delete it. |
| Record not in the baseline and not paired                                   | Keep it. The projection adds it to core.                                                                                                                                                                                                                                      |
| Empty catalog and no baseline                                               | Every core entry is imported.                                                                                                                                                                                                                                                 |

The implementation adds four safeguards to these rules:

- **Retired names.** A record that the product removes leaves the baseline. Its projected name is kept in `nativeCatalog.retired` with the removal time until the next confirmed projection. A core entry with a retired name is not imported again, unless core saved it after the removal. Without this, a record deleted while core Workspaces was disabled would return when core is enabled.
- **Empty core list.** If core lists no entry at all, no record is removed. The file is treated as lost or reset. The projection writes the catalog back.
- **Entries that are not layouts.** `mode:` records and malformed entries are not imported and not removed. They stay in the core list after the catalog entries. Core can delete them. Core cannot load them through the bridge.
- **Other-device layouts.** A record with no layout for the current device is projected with its other-device layout. Otherwise a core entry that was saved on the other device kind would leave the core list after its import.

### Lifecycle

The bridge starts after layout-ready. `app.internalPlugins` triggers `change` after an enable has loaded its data and after a disable. The bridge attaches and detaches on that event. Without the event it checks again on controller notifications and when the product interface opens. No polling timer exists.

On detach or unload the bridge restores the core methods and withdraws unsaved in-memory entries. `workspaces.json` stays as last projected. The settings action "Import this vault's core workspaces" stays for a vault where core Workspaces is disabled. It is disabled while the bridge is attached, because the core list is then already this catalog.

## Consequences

Core Workspaces commands, its dialogs, its CLI handlers and other plugins that call the core instance now use the transition controller. A core load of a bound workspace checks out its branch first. A dirty working tree blocks it with the same message as the product menu.

Limits:

- Core changes made while Workspaces is disabled are reconciled at the next start, not earlier. While Workspaces is disabled, core loads layouts by itself.
- Pairing on first contact uses the display name. Two unprojected records with the same name are not paired; the core entry is imported as one more record.
- A crash between a catalog commit and its projection is repaired at the next start. The catalog wins, unless core holds a later `mtime` for that entry.
- Core `mtime` has a resolution of one second. A core save in the same second as a product save of the same record can lose.
- The active name in core is not read. Reconciliation never activates a workspace.
- Core saves a layout without a branch check. An adopted layout keeps the record's binding even if core saved it on another branch. The previous context stays in history.
- Core's CLI handlers print success when the routed promise settles, also after a rejected request. The notice has the error.
- Core shows its own "saved" message before the controller runs. A rejected save shows the product error after it.
- Core's save-and-load shortcut becomes a save followed by a load. A failed save does not stop the load; the controller's own checks still apply to it.
- The core file is the projection of one device's catalog. Each device has its own control store. Do not sync `workspaces.json` between two devices that both run Workspaces: a projection from the other device looks like deletions and additions made in core.
- The bridge uses private interfaces of Obsidian 1.15.1. Another version can fail the capability check; then the lists are separate again and the user sees one notice.

Operational note: with branch-bound workspaces, `workspaces.json` must be untracked or ignored, like `workspace.json`. The projection writes the file after a switch. A write to a tracked file makes the working tree dirty and blocks the next branch change. A tracked file that differs between branches is also read as core edits at the next start.

Mocked tests cover routing, projection, reconciliation, lifecycle and migration. They do not prove the behavior of the native core dialogs. Native validation uses the scenarios in [Development](../development.md#core-workspaces-bridge).
