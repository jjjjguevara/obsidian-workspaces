# ADR 0002 — Obsidian integration and native interface

**Status:** Accepted

**Date:** 2026-11-13

## Context

Workspaces should behave like part of Obsidian while providing a catalog and lifecycle that can coordinate Git. Native presentation, native layout restoration, and live interoperability with the core Workspaces catalog are different integration choices. A second independent writer could load a branch-bound layout before its files exist.

## Decision

Build the initial interface from Obsidian's native modal, suggestion, menu, settings, command, ribbon, and status controls. Keep these controls separate from catalog and activation logic. They submit operations and render resulting state. A later custom interface must use the same operations.

Capture and restore native Obsidian layout state, preserving pin flags and leaf relationships. Keep desktop/mobile layout handling explicit. Isolate unavoidable private APIs in a narrow compatibility boundary with targeted tests and version expectations.

Own the workspace catalog described in [ADR 0001](0001-workspace-authority-and-persistence.md). Support explicit import of core Workspaces and Workspace++ data. Do not monkey-patch the core Workspaces catalog or maintain two writable catalogs. The core plugin is not required for normal operation.

Convert compatible source presentation and layout metadata into this model. The initial group model is one label per workspace, so imports flatten multiple memberships. Modes and workspace-specific global configuration replacement are outside the initial scope.

Restore branch-owned note leaves with their workspace, including sidebar pins. Any future shared-sidebar option must distinguish common interface elements from note leaves that belong to a branch. Copying a sidebar's pinned notes into every saved workspace is incompatible with the primary workflow.

## Consequences

The product gets native interaction patterns without inheriting a second lifecycle. Native core workspace commands remain separate from this product's commands. Live core-catalog interoperability would require a new decision and an adapter that routes activation before layout restoration.

UI changes cannot bypass Git validation or recovery by calling the underlying layout APIs directly. [ADR 0004](0004-workspace-transitions-and-recovery.md) owns all activation paths.
