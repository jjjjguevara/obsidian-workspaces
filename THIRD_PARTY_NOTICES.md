# Third-party notices

Workspaces is a modified and consolidated project maintained by **jjjjguevara**. Initial consolidation and product-specific changes are dated **2026-11-13**. The project uses selected upstream work as a basis for its catalog, native interface, and compatibility adapters. It does not represent an official release of any upstream project.

The combined project is provided under the GNU General Public License, version 3, reproduced in [LICENSE](LICENSE) and [LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt). Original notices for MIT-licensed material remain applicable to those portions and are retained below and in the license copies.

## Source baselines

| Project | Inspected source revision | License | Consolidation area |
| --- | --- | --- | --- |
| [Workspace++ — s1m4ne](https://github.com/s1m4ne/obsidian-workspace-plus) | [`b8bd11c9ee427b17770f386944e67ba0dd98e414`](https://github.com/s1m4ne/obsidian-workspace-plus/tree/b8bd11c9ee427b17770f386944e67ba0dd98e414) | MIT | Stable session identity, native layout handling, save/history behavior, and interpretation of existing session exports. |
| [Workspaces Plus — jsmorabito](https://github.com/jsmorabito/obsidian-workspaces-plus) | [`dfdb79c0de5c8dde592685eb1a829d204e3c1eba`](https://github.com/jsmorabito/obsidian-workspaces-plus/tree/dfdb79c0de5c8dde592685eb1a829d204e3c1eba) | GNU GPL v3 | Native suggestion/modal/menu patterns, workspace presentation, commands and indicators, and interpretation of core workspace metadata. |
| [Obsidian Git — Vinzent03 and contributors](https://github.com/Vinzent03/obsidian-git) | [`8d1144aef2d41ffca6245a60199656e7a0c5ab17`](https://github.com/Vinzent03/obsidian-git/tree/8d1144aef2d41ffca6245a60199656e7a0c5ab17) | MIT | Compatibility reference for the installed version 2.43.0 plugin's desktop Git operations. The plugin itself is not bundled. |

## Workspace++

Original notice:

> Copyright (c) 2025-2026 s1m4ne

The complete original MIT license is retained verbatim in [LICENSES/workspace-plus-plus-MIT.txt](LICENSES/workspace-plus-plus-MIT.txt).

The consolidation reworks the product's state and activation boundaries. It does not import the complete upstream application or promise compatibility with every feature or storage synchronization behavior of that application. Source attribution should remain in substantially adapted code, and later imports should identify their source revision here.

## Workspaces Plus

Source: [jsmorabito/obsidian-workspaces-plus](https://github.com/jsmorabito/obsidian-workspaces-plus). The upstream GPL version 3 license text is copied verbatim into [LICENSE](LICENSE). Upstream authors and contributors retain their rights in adapted material.

Native presentation is integrated with this project's own catalog and serialized lifecycle. The upstream core-plugin monkey patches, name-keyed live catalog, and configuration-replacement machinery are not the product's state authority.

## Obsidian Git

Original notice:

> Copyright (c) 2020 Vinzent03, Denis Olehov

The complete original MIT license is retained verbatim in [LICENSES/obsidian-git-MIT.txt](LICENSES/obsidian-git-MIT.txt). Obsidian Git remains a separately installed plugin. This project's adapter is a compatibility integration; it does not claim authorship of or redistribute the entire backend.

## Dependencies and modifications

The npm lockfile records build and test dependency versions. Those packages retain their respective licenses. Obsidian's runtime API is supplied by the host application and is not bundled as part of Workspaces.

New product-specific modifications are maintained by jjjjguevara. Preserve original notices when copying or adapting additional source, and update this file when a new upstream baseline or component is incorporated.
