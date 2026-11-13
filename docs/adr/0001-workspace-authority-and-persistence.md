# ADR 0001 — Workspace authority and persistence

**Status:** Accepted

**Date:** 2026-11-13

## Context

A workspace must retain its identity when renamed and retain references to notes that temporarily disappear during a branch checkout. The catalog that describes both branches cannot depend on the contents of the currently checked-out branch. Presentation fields, layouts, and branch associations also need consistent duplication and recovery behavior.

## Decision

Maintain one authoritative catalog with stable workspace IDs. Names are presentation. A saved context contains its branch association, native desktop/mobile layout slots, and the revision information needed to interpret them together. Group membership belongs to the workspace record and survives its rename. History stores context snapshots rather than an unqualified list of file paths.

Version the persisted schema and implement explicit migrations. Duplication creates a new identity and copies supported metadata and layouts independently. Imports preserve valid product identities and allocate IDs for source formats that lack them; equal names do not silently coalesce records. Unknown future schema versions must not be overwritten as though they were current data.

On desktop, store the catalog, backup, and transition journal outside the vault/repository, beneath the operating system's application-data location. Derive the vault-specific key from its canonical local path and verify the store lies outside the Git repository before using Git bindings. Use atomic replacement, preserve a backup, and reject conflicting writes through an exclusive lock and expected revision. Do not expire locks automatically. On mobile, use the plugin's `loadData`/`saveData` persistence.

Provide explicit export/import. Automatic cross-device merge is outside the initial implementation: independently merging a branch association and a layout can create a context that never existed. External transport of mobile plugin data does not establish a supported merge protocol.

## Consequences

Checkout cannot replace desktop control data. A renamed or moved vault needs export/import because its path-derived key changes. Devices do not automatically share workspace state. New fields require defined migration, duplication, history, and transfer behavior.

Core Workspaces and Workspace++ are import formats; the live core catalog is not a second authority. [ADR 0002](0002-obsidian-integration-and-native-interface.md) defines that integration boundary.
