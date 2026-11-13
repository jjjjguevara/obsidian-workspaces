import type { WorkspaceState } from '../workspaces/model';
import { migrateState } from './migrations';

export interface StateStore {
  location: string | null;
  load(): Promise<WorkspaceState>;
  save(state: WorkspaceState): Promise<void>;
  assertOutsideRepository?(root: string): Promise<void>;
}

/** Atomic replacement occurred, but its directory durability could not be confirmed. */
export class CommittedWriteError extends Error {
  constructor(
    readonly committed: WorkspaceState,
    cause: unknown,
  ) {
    super('Workspace data was replaced, but the directory could not be synced.', { cause });
  }
}

/** Atomic replacement plus one previous generation. Node modules are loaded only on desktop. */
export class FileStateStore implements StateStore {
  private expectedRevision: number | null = null;
  constructor(public readonly location: string) {}
  async load(): Promise<WorkspaceState> {
    const fs = await import('node:fs/promises');
    let state: WorkspaceState;
    try {
      state = migrateState(JSON.parse(await fs.readFile(this.location, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = migrateState(null);
    }
    this.expectedRevision = state.revision;
    return state;
  }
  async assertOutsideRepository(root: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const within = (parent: string, candidate: string): boolean => {
      const relative = path.relative(parent, candidate);
      return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      );
    };
    if (within(path.resolve(root), path.resolve(this.location)))
      throw new Error('The workspace control store is inside the Git repository.');
    await fs.mkdir(path.dirname(this.location), { recursive: true, mode: 0o700 });
    const directory = await fs.realpath(path.dirname(this.location));
    const repo = await fs.realpath(root);
    if (within(repo, directory) || within(repo, path.resolve(this.location))) {
      throw new Error(
        'The workspace control store is inside the Git repository. Move the vault or application-data location before binding a workspace.',
      );
    }
  }
  async save(state: WorkspaceState): Promise<void> {
    migrateState(state);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(this.location), { recursive: true, mode: 0o700 });
    const temp = `${this.location}.${globalThis.crypto.randomUUID()}.tmp`;
    const lockPath = `${this.location}.lock`;
    let lock;
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (cause) {
      throw new Error(
        `Workspace state is locked. Close the other vault instance; after an interrupted process, remove ${lockPath} only when no instance is writing.`,
        { cause },
      );
    }
    let replaced = false;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      let actual: WorkspaceState;
      try {
        actual = migrateState(JSON.parse(await fs.readFile(this.location, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        actual = migrateState(null);
      }
      if (this.expectedRevision !== null && actual.revision !== this.expectedRevision)
        throw new Error(
          'Workspace state changed in another instance. Reload Workspaces before editing it.',
        );
      if (state.revision !== actual.revision + 1)
        throw new Error('Workspace state revision is stale. Reload Workspaces before editing it.');
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.copyFile(this.location, `${this.location}.backup`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.rename(temp, this.location);
      replaced = true;
      this.expectedRevision = state.revision;
      // Sync directory metadata where supported; Windows does not allow opening directories this way.
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(this.location), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      if (replaced) throw new CommittedWriteError(structuredClone(state), error);
      throw error;
    } finally {
      try {
        await lock.close();
        await fs.rm(lockPath, { force: true });
      } catch (error) {
        if (replaced) throw new CommittedWriteError(structuredClone(state), error);
        throw error;
      }
    }
  }
}
export class PluginStateStore implements StateStore {
  readonly location = null;
  constructor(
    private readonly read: () => Promise<unknown>,
    private readonly write: (state: WorkspaceState) => Promise<void>,
  ) {}
  async load(): Promise<WorkspaceState> {
    return migrateState(await this.read());
  }
  async save(state: WorkspaceState): Promise<void> {
    await this.write(migrateState(state));
  }
}
export async function desktopStore(vaultPath: string): Promise<FileStateStore> {
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const canonical = await fs.realpath(vaultPath);
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'));
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return new FileStateStore(path.join(base, 'obsidian-workspaces', key, 'state.json'));
}
