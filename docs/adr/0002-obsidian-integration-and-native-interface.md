# ADR 0002 — Obsidian integration and native interface

**Status:** Accepted

**Date:** 2026-11-13

**Updated:** 2026-11-14 — Quick Switcher++ activation and status ownership.

## Context

Workspaces should behave like part of Obsidian while providing a catalog and lifecycle that can coordinate Git. Native presentation, native layout restoration, and live interoperability with the core Workspaces catalog are different integration choices. A second independent writer could load a branch-bound layout before its files exist.

## Decision

Build the initial interface from Obsidian's native modal, suggestion, menu, settings, command, ribbon, and status controls. Keep these controls separate from catalog and activation logic. They submit operations and render resulting state. A later custom interface must use the same operations.

Capture and restore native Obsidian layout state, preserving pin flags and leaf relationships. Keep desktop/mobile layout handling explicit. Isolate unavoidable private APIs in a narrow compatibility boundary with targeted tests and version expectations.

Own the workspace catalog described in [ADR 0001](0001-workspace-authority-and-persistence.md). Support explicit import of core Workspaces and Workspace++ data. Do not monkey-patch the core Workspaces catalog or maintain two writable catalogs. The core plugin is not required for normal operation.

Integrate Quick Switcher++ through its workspace handler in a separate compatibility adapter. Its Workspaces Mode presents this catalog using stable IDs and routes selection and creation through the controller. Its synchronous save-then-load shortcut maps to one serialized save-and-activate operation: a failed save must not proceed to activation, and a queued request must not save a different source workspace. Do not populate or intercept the core Workspaces catalog to achieve this integration.

Quick Switcher++ exposes no public workspace-provider registration API at the inspected version. Target its 6.3.x handler capabilities, tested against 6.3.0, and narrowly wrap community-plugin load/unload methods to handle either load order and provider reload. Subscribe to the native plugin manager's `changed` event as well: an enable already in progress before those wrappers were installed must be reconciled when initialization completes. An instance without its command definitions is still loading, not yet an incompatible provider. Close existing workspace suggestions when the provider changes, reject stale suggestions, and restore method descriptors and event subscriptions on teardown without overwriting later wrappers. Other Quick Switcher++ modes remain under its own implementation.

Show workspace identity in this product's status indicator. Leave the actual branch indicator to Obsidian Git; a workspace's saved branch association belongs in selection and settings details.

Convert compatible source presentation and layout metadata into this model. The initial group model is one label per workspace, so imports flatten multiple memberships. Modes and workspace-specific global configuration replacement are outside the initial scope.

Restore branch-owned note leaves with their workspace, including sidebar pins. Any future shared-sidebar option must distinguish common interface elements from note leaves that belong to a branch. Copying a sidebar's pinned notes into every saved workspace is incompatible with the primary workflow.

## Consequences

The product gets native interaction patterns without inheriting a second lifecycle. Native core workspace commands remain separate from this product's commands; Quick Switcher++ Workspaces Mode uses the explicit adapter above. Live core-catalog interoperability would require a new decision and an adapter that routes activation before layout restoration. Quick Switcher++ compatibility requires version/capability checks and native regression evidence when its internal contract changes.

UI changes cannot bypass Git validation or recovery by calling the underlying layout APIs directly. [ADR 0004](0004-workspace-transitions-and-recovery.md) owns all activation paths.
