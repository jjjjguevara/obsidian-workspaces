import type { Layout } from '../workspaces/model';

export interface FileLeaf {
  id: string;
  path: string;
  type: string;
  pinned: boolean;
  region: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// These core panes follow the active file. Obsidian saves them without an
// explicit file while unfocused and resolves that file again during restore,
// so a restored pane is not an extra file leaf.
const FOLLOW_ACTIVE_FILE_VIEWS = new Set(['backlink', 'outgoing-link', 'outline']);

/** Read only the leaf contract; retain all unknown native state in the original snapshot. */
export function fileLeaves(layout: Layout): FileLeaf[] {
  const result: FileLeaf[] = [];
  const walk = (node: unknown, region: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, region));
      return;
    }
    if (!object(node)) return;
    if (
      node.type === 'leaf' &&
      object(node.state) &&
      object(node.state.state) &&
      typeof node.state.state.file === 'string'
    ) {
      result.push({
        id: typeof node.id === 'string' ? node.id : '',
        path: node.state.state.file,
        type: String(node.state.type),
        pinned: node.pinned === true || node.state.pinned === true,
        region,
      });
      return;
    }
    for (const child of Object.values(node))
      if (object(child) || Array.isArray(child)) walk(child, region);
  };
  for (const [region, tree] of Object.entries(layout))
    if (['main', 'left', 'right', 'floating'].includes(region)) walk(tree, region);
  return result;
}

export function assertRestoredFiles(expected: Layout, actual: Layout): void {
  // Obsidian resolves file-following panes against the restored active file, so
  // their saved path is not a restoration guarantee. Compare those panes by
  // presence, region, type and pin state only; compare real file views by path.
  const key = (leaf: FileLeaf): string =>
    JSON.stringify([
      leaf.region,
      leaf.type,
      leaf.pinned,
      FOLLOW_ACTIVE_FILE_VIEWS.has(leaf.type) ? '' : leaf.path,
    ]);
  const actualLeaves = fileLeaves(actual);
  const matched = actualLeaves.map(() => false);
  for (const leaf of fileLeaves(expected)) {
    const index = actualLeaves.findIndex(
      (candidate, position) => !matched[position] && key(candidate) === key(leaf),
    );
    if (index === -1)
      throw new Error(
        FOLLOW_ACTIVE_FILE_VIEWS.has(leaf.type)
          ? `Obsidian did not restore the ${leaf.type} pane in ${leaf.region}. The saved snapshot is retained for recovery.`
          : `Obsidian did not restore ${leaf.pinned ? 'the pinned note' : 'the note'} “${leaf.path}” in ${leaf.region}. The saved snapshot is retained for recovery.`,
      );
    matched[index] = true;
  }
  const extra = actualLeaves.filter(
    (leaf, position) => !matched[position] && !FOLLOW_ACTIVE_FILE_VIEWS.has(leaf.type),
  );
  if (extra.length)
    throw new Error(
      'Obsidian retained a file leaf outside the requested workspace. The saved snapshot is retained for recovery.',
    );
}

export interface VaultReadinessPort {
  hasFile(path: string): boolean;
  exists(path: string): Promise<boolean>;
  cachedRead(path: string): Promise<string>;
  diskRead(path: string): Promise<string>;
  matchesStat?(path: string): Promise<boolean>;
  /** Observation hints only: every notification must be followed by fresh probes. */
  subscribe?(onChange: () => void): () => void;
}

/** File/cache probes establish readiness; events wake them early, with polling as a fallback. */
export async function waitForVaultFiles(
  target: Layout,
  previous: Layout,
  vault: VaultReadinessPort,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  // A follower pane re-resolves to the restored active file. Its saved path may
  // only exist on the outgoing branch, so it is not a readiness requirement.
  const targetLeaves = fileLeaves(target).filter(
    (leaf) => !FOLLOW_ACTIVE_FILE_VIEWS.has(leaf.type),
  );
  const targetPaths = new Set(targetLeaves.map((leaf) => leaf.path));
  const textPaths = new Set(
    targetLeaves
      .filter((leaf) => leaf.type === 'markdown' || /\.(md|txt|canvas|base)$/i.test(leaf.path))
      .map((leaf) => leaf.path),
  );
  const previousPaths = new Set(fileLeaves(previous).map((leaf) => leaf.path));
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let reason = 'files are still being observed';
  let revision = 0;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const clearWait = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    wake = undefined;
  };
  const onChange = (): void => {
    revision += 1;
    wake?.();
  };
  const wait = (observedRevision: number): Promise<void> =>
    new Promise((resolve) => {
      wake = () => {
        clearWait();
        resolve();
      };
      // A notification during an awaited probe must not be lost just because
      // there was no sleeping waiter yet. Register the waiter before rechecking.
      if (revision !== observedRevision) {
        wake();
        return;
      }
      timer = setTimeout(wake, Math.max(0, Math.min(options.pollMs ?? 100, deadline - Date.now())));
    });
  try {
    // Subscribe before the first probe, including one that awaits file/cache I/O.
    unsubscribe = vault.subscribe?.(onChange);
    while (true) {
      const observedRevision = revision;
      let ready = true;
      for (const path of targetPaths) {
        if (!vault.hasFile(path) || !(await vault.exists(path))) {
          ready = false;
          reason = `“${path}” is not available in the vault`;
          break;
        }
        if (vault.matchesStat && !(await vault.matchesStat(path))) {
          ready = false;
          reason = `“${path}” still has stale file metadata`;
          break;
        }
        if (textPaths.has(path)) {
          try {
            const [cached, disk] = await Promise.all([
              vault.cachedRead(path),
              vault.diskRead(path),
            ]);
            if (cached !== disk) {
              ready = false;
              reason = `“${path}” still has cached content from another branch`;
              break;
            }
          } catch {
            ready = false;
            reason = `“${path}” cannot be read yet`;
            break;
          }
        }
      }
      if (ready)
        for (const path of previousPaths) {
          if (!targetPaths.has(path) && !(await vault.exists(path)) && vault.hasFile(path)) {
            ready = false;
            reason = `the removed note “${path}” is still in the vault index`;
            break;
          }
        }
      // A change during an otherwise successful pass may invalidate an earlier
      // file in that pass. Recheck all conditions before reporting success.
      if (ready && revision === observedRevision) return;
      if (Date.now() >= deadline)
        throw new Error(`Workspace files did not become ready: ${reason}.`);
      await wait(observedRevision);
    }
  } finally {
    clearWait();
    unsubscribe?.();
  }
}
