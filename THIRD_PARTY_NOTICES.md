# Third-party notices

Workspaces is a modified and consolidated project maintained by **jjjjguevara**. Initial consolidation and product-specific changes are dated **2026-11-13**. The project uses selected upstream work as a basis for its catalog, native interface, and compatibility adapters. It does not represent an official release of any upstream project.

The combined project is provided under the GNU General Public License, version 3, reproduced in [LICENSE](LICENSE) and [LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt). Original notices for MIT-licensed material remain applicable to those portions and are retained below and in the license copies.

## Source baselines

| Project                                                                                | Inspected source revision                                                                                                                          | License    | Consolidation area                                                                                                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Workspace++ — s1m4ne](https://github.com/s1m4ne/obsidian-workspace-plus)              | [`b8bd11c9ee427b17770f386944e67ba0dd98e414`](https://github.com/s1m4ne/obsidian-workspace-plus/tree/b8bd11c9ee427b17770f386944e67ba0dd98e414)      | MIT        | Adapted pure layout comparison/merging and JSON-cloning utilities; reference for stable identity, platform slots, and session export conversion. |
| [Workspaces Plus — jsmorabito](https://github.com/jsmorabito/obsidian-workspaces-plus) | [`dfdb79c0de5c8dde592685eb1a829d204e3c1eba`](https://github.com/jsmorabito/obsidian-workspaces-plus/tree/dfdb79c0de5c8dde592685eb1a829d204e3c1eba) | GNU GPL v3 | Adapted native suggestion/menu and icon presentation patterns; reference for core workspace metadata conversion.                                 |
| [Obsidian Git — Vinzent03 and contributors](https://github.com/Vinzent03/obsidian-git) | [`8d1144aef2d41ffca6245a60199656e7a0c5ab17`](https://github.com/Vinzent03/obsidian-git/tree/8d1144aef2d41ffca6245a60199656e7a0c5ab17)              | MIT        | Compatibility reference for the installed version 2.43.0 plugin's desktop Git operations. The plugin itself is not bundled.                      |

## Workspace++

Original notice:

> Copyright (c) 2025-2026 s1m4ne

The complete original MIT license is retained verbatim in [LICENSES/workspace-plus-plus-MIT.txt](LICENSES/workspace-plus-plus-MIT.txt).

Adapted utility code is in `src/obsidian/layout-data.ts` and `src/obsidian/clone-json.ts`, each retaining its source revision and copyright notice. The catalog, persistence schema, journal, and Git-aware controller are product-specific implementations; they are not a wholesale import of the upstream managers.

The consolidation reworks the product's state and activation boundaries. It does not import the complete upstream application or promise compatibility with every feature or storage synchronization behavior of that application. Source attribution should remain in substantially adapted code, and later imports should identify their source revision here.

## Workspaces Plus

Source: [jsmorabito/obsidian-workspaces-plus](https://github.com/jsmorabito/obsidian-workspaces-plus). The upstream GPL version 3 license text is copied verbatim into [LICENSE](LICENSE). Upstream authors and contributors retain their rights in adapted material.

Native presentation is integrated with this project's own catalog and serialized lifecycle. The upstream core-plugin monkey patches, name-keyed live catalog, and configuration-replacement machinery are not the product's state authority.

Adapted code is identified in `src/ui/menu.ts` (native workspace menu), `src/ui/switcher.ts` (native fuzzy suggestion presentation), and `src/ui/dialogs.ts` (icon treatment from upstream settings). These files route actions through stable IDs and this project's controller. Import conversion reads compatible `workspaces-plus:settings-v1` metadata without carrying over Modes or configuration replacement.

## Obsidian Git

Original notice:

> Copyright (c) 2020 Vinzent03, Denis Olehov

The complete original MIT license is retained verbatim in [LICENSES/obsidian-git-MIT.txt](LICENSES/obsidian-git-MIT.txt). Obsidian Git remains a separately installed plugin. This project's adapter is a compatibility integration; it does not claim authorship of or redistribute the entire backend.

`src/git/obsidian-git.ts` is an original adapter informed by the inspected `promiseQueue`, `simpleGit`, and `gitManager` internal contracts. No Obsidian Git implementation is copied or bundled. Its MIT text is retained here with the integration's source provenance.

## Dependencies and modifications

### Quick Switcher++ compatibility

The original adapter in `src/obsidian/quick-switcher.ts` targets [Quick Switcher++ by darlal](https://github.com/darlal/obsidian-switcher-plus), version **6.3.0**, inspected at [`ca9d8745f8fb9920493f659aa09d2815eca3b82a`](https://github.com/darlal/obsidian-switcher-plus/tree/ca9d8745f8fb9920493f659aa09d2815eca3b82a). The inspected contracts are its `WorkspaceHandler`, command definitions, `HandlerRegistry`, and save-and-switch keymap. Quick Switcher++ is GPL-3.0-only and remains separately installed; no implementation or release asset is bundled here. Its source informed this compatibility boundary, added on **2026-11-14**. The native test fixture uses separately obtained official release assets.

### Build dependencies

The npm lockfile records build and test dependency versions. Those packages retain their respective licenses. Obsidian's runtime API is supplied by the host application and is not bundled as part of Workspaces.

New product-specific modifications are maintained by jjjjguevara. Preserve original notices when copying or adapting additional source, and update this file when a new upstream baseline or component is incorporated.
