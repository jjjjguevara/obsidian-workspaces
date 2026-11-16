# Working-vault counts used to size the representative fixture

Taken on 2026-11-15 in the `tyo-bit` vault. No note content was read or copied.

| Quantity                                         | Value                                                                                          | Command                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Tracked files per branch                         | 108, 133, 108, 136, 108, 128 (six local branches)                                              | `git ls-tree -r --name-only <branch> \| wc -l`       |
| Changed paths between branch pairs               | 0 to 69 across the 15 pairs (0, 1, 1, 21, 22, 22, 30, 31, 31, 39, 39, 40, 50, 60, 69)          | `git diff --name-only --no-renames <a> <b> \| wc -l` |
| Tracked Markdown notes on the checked-out branch | 98                                                                                             | `git ls-files '*.md' \| wc -l`                       |
| Markdown note size                               | 13,491 bytes median, 45,869 bytes at the 90th percentile, 287,761 bytes maximum, 25.6 KiB mean | `stat -f %z` on those 98 files                       |
| Saved workspaces                                 | 4, each bound to a branch                                                                      | Workspaces control state                             |
| Main-area views per saved workspace              | 1 or 2: Canvas, Markdown, Excalidraw, or an empty tab                                          | Workspaces control state, leaf types only            |
| Pinned sidebar notes                             | None; the sidebars hold core panels and the Git view                                           | Workspaces control state                             |
| Enabled community plugins                        | 14                                                                                             | `.obsidian/community-plugins.json`                   |

Fixture: 194 tracked files per branch, 85 changed paths, 26 KiB generated notes, four Markdown editors.

Not reproduced by the fixture: Canvas and Excalidraw views, the 14 plugins, and one 281 KiB note. The provider plugins in this vault report versions 2.43.0 and 6.3.0 but their `main.js` files are 18 bytes longer than the official release files used in the fixtures.
