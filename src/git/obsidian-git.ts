import { GitBackendError, type GitBackend, type GitRepository, type GitStatus } from './backend';

/**
 * Original adapter; no Obsidian Git implementation is copied or bundled.
 * Internal contracts were inspected at Vinzent03/obsidian-git@8d1144ae:
 * src/promiseQueue.ts, src/gitManager/simpleGit.ts, src/gitManager/gitManager.ts,
 * src/gitActions.ts and src/ui/statusBar/branchStatusBar.ts.
 * These are capability-checked internals, not a published third-party API.
 */
export const TESTED_OBSIDIAN_GIT_VERSION = '2.43.0';

export interface ObsidianGitBackendOptions {
  resolvePlugin: () => unknown;
  isDesktop: () => boolean;
  checkoutGuard?: {
    vaultPath: string;
    configDir: string;
    pluginId: string;
  };
}

interface NativeGitManager {
  absoluteRepoPath: string;
  git: { raw(args: string[]): Promise<string> };
  checkout(branch: string): Promise<void>;
}

interface GitQueue {
  addTask<T>(task: () => Promise<T>, onFinished?: (result: T | undefined) => void): void;
}

interface InstalledGitPlugin {
  manifest: { id: string; version: string };
  gitReady: boolean;
  gitManager: NativeGitManager;
  promiseQueue: GitQueue;
  settings: { submoduleRecurseCheckout?: boolean };
  app?: unknown;
  branchBar?: unknown;
}

type QueueResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface NativePlatform {
  access(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function withoutFinalNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ObsidianGitBackend implements GitBackend {
  constructor(private readonly options: ObsidianGitBackendOptions) {}

  private getPlugin(): InstalledGitPlugin {
    if (!this.options.isDesktop()) {
      throw new GitBackendError(
        'unsupported-platform',
        'Git-bound workspaces require Obsidian on desktop.',
      );
    }
    let plugin: unknown;
    try {
      plugin = this.options.resolvePlugin();
    } catch (cause) {
      throw new GitBackendError(
        'plugin-unavailable',
        'Could not access the installed Obsidian Git plugin.',
        { cause },
      );
    }
    if (
      !object(plugin) ||
      !object(plugin.manifest) ||
      plugin.manifest.id !== 'obsidian-git' ||
      plugin.gitReady !== true
    ) {
      throw new GitBackendError(
        'plugin-unavailable',
        'Enable Obsidian Git and wait for its repository to become ready.',
      );
    }
    if (
      typeof plugin.manifest.version !== 'string' ||
      !/^2\.43\.\d+$/.test(plugin.manifest.version)
    ) {
      throw new GitBackendError(
        'unsupported-version',
        `This adapter supports Obsidian Git 2.43.x and was tested against ${TESTED_OBSIDIAN_GIT_VERSION}.`,
      );
    }
    const manager = plugin.gitManager;
    if (
      !object(manager) ||
      typeof manager.absoluteRepoPath !== 'string' ||
      !manager.absoluteRepoPath ||
      !object(manager.git) ||
      typeof manager.git.raw !== 'function' ||
      typeof manager.checkout !== 'function' ||
      !object(plugin.promiseQueue) ||
      typeof plugin.promiseQueue.addTask !== 'function' ||
      !object(plugin.settings)
    ) {
      throw new GitBackendError(
        'unsupported-backend',
        "Obsidian Git's native backend or operation queue is unavailable.",
      );
    }
    return plugin as unknown as InstalledGitPlugin;
  }

  async withRepository<T>(operation: (repository: GitRepository) => Promise<T>): Promise<T> {
    // Keep module evaluation safe for unbound mobile workspaces. Node modules are
    // resolved only after the desktop/provider checks have succeeded.
    const plugin = this.getPlugin();
    const [fileSystem, paths] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);
    const native: NativePlatform = {
      access: fileSystem.access,
      realpath: fileSystem.realpath,
      resolve: paths.resolve,
      relative: paths.relative,
      isAbsolute: paths.isAbsolute,
      sep: paths.sep,
    };
    const manager = plugin.gitManager;
    const queue = plugin.promiseQueue;
    const nativeGit = manager.git;

    const assertConnected = (): void => {
      const current = this.getPlugin();
      if (
        current !== plugin ||
        current.gitManager !== manager ||
        current.promiseQueue !== queue ||
        manager.git !== nativeGit
      ) {
        throw new GitBackendError(
          'repository-changed',
          'Obsidian Git was reloaded or changed repositories during this operation.',
        );
      }
    };

    return new Promise<T>((resolveResult, rejectResult) => {
      let settled = false;
      let started = false;
      let monitor: ReturnType<typeof setInterval> | undefined;
      const stopMonitoring = (): void => {
        if (monitor !== undefined) clearInterval(monitor);
        monitor = undefined;
      };
      const finish = (result: QueueResult<T>): void => {
        if (settled) return;
        settled = true;
        stopMonitoring();
        if (result.ok) resolveResult(result.value);
        else rejectResult(result.error);
      };

      // Obsidian Git clears pending tasks on unload without invoking their callbacks.
      // Only monitor a task that has not started; never release a running transaction
      // on a timer while its checkout or layout restoration is still in flight.
      monitor = setInterval(() => {
        if (started || settled) return;
        try {
          assertConnected();
        } catch (error) {
          finish({ ok: false, error });
        }
      }, 250);

      try {
        queue.addTask<QueueResult<T>>(
          async () => {
            started = true;
            stopMonitoring();
            if (settled)
              return {
                ok: false,
                error: new GitBackendError(
                  'queue-failed',
                  'The queued Git operation was cancelled.',
                ),
              };
            const repository = new QueuedRepository(
              plugin,
              manager,
              assertConnected,
              native,
              this.options.checkoutGuard ? { ...this.options.checkoutGuard } : undefined,
            );
            try {
              assertConnected();
              const value = await operation(repository);
              assertConnected();
              return { ok: true, value };
            } catch (error) {
              // Preserve controller errors as well as typed Git failures.
              return { ok: false, error };
            } finally {
              repository.release();
            }
          },
          (result) => {
            // A successful checkout resolves to undefined, and this queue also uses
            // undefined for rejected tasks. Our explicit envelope removes that ambiguity.
            if (result === undefined) {
              finish({
                ok: false,
                error: new GitBackendError(
                  'queue-failed',
                  'Obsidian Git did not return an operation result.',
                ),
              });
            } else {
              finish(result);
            }
          },
        );
      } catch (cause) {
        finish({
          ok: false,
          error: new GitBackendError('queue-failed', 'Could not enqueue the Git operation.', {
            cause,
          }),
        });
      }
    });
  }
}

class QueuedRepository implements GitRepository {
  private active = true;
  private readonly expectedRoot: string;

  constructor(
    private readonly plugin: InstalledGitPlugin,
    private readonly manager: NativeGitManager,
    private readonly assertConnected: () => void,
    private readonly native: NativePlatform,
    private readonly checkoutGuard?: ObsidianGitBackendOptions['checkoutGuard'],
  ) {
    this.expectedRoot = native.resolve(manager.absoluteRepoPath);
  }

  release(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active)
      throw new GitBackendError(
        'repository-released',
        'The Git repository may only be used inside withRepository().',
      );
    this.assertConnected();
    if (this.native.resolve(this.manager.absoluteRepoPath) !== this.expectedRoot) {
      throw new GitBackendError(
        'repository-changed',
        'Obsidian Git changed its repository root during this operation.',
      );
    }
  }

  private async raw(args: string[]): Promise<string> {
    this.assertActive();
    let result: unknown;
    try {
      result = await this.manager.git.raw(args);
    } catch (cause) {
      throw new GitBackendError('git-command-failed', `Git ${args[0]} failed: ${message(cause)}`, {
        cause,
      });
    }
    this.assertActive();
    if (typeof result !== 'string')
      throw new GitBackendError(
        'unsupported-backend',
        'Obsidian Git returned an unsupported command result.',
      );
    return result;
  }

  async inspect(): Promise<GitStatus> {
    const root = this.native.resolve(
      withoutFinalNewline(await this.raw(['rev-parse', '--show-toplevel'])),
    );
    if (root !== this.expectedRoot) {
      throw new GitBackendError(
        'repository-changed',
        "Obsidian Git's current directory does not match its repository root.",
      );
    }
    const output = await this.raw([
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
    let branch: string | null | undefined;
    let dirty = false;
    let conflicted = false;
    const entries = output.split('\0');
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!entry) continue;
      if (entry.startsWith('# branch.head ')) {
        const head = entry.slice('# branch.head '.length);
        branch = head === '(detached)' ? null : head;
      } else if (entry.startsWith('# ')) {
        continue;
      } else if (entry.startsWith('1 ') || entry.startsWith('? ')) {
        dirty = true;
      } else if (entry.startsWith('2 ')) {
        dirty = true;
        // A renamed/copied entry is followed by a NUL-separated original path.
        index += 1;
      } else if (entry.startsWith('u ')) {
        dirty = true;
        conflicted = true;
      } else {
        throw new GitBackendError(
          'invalid-status',
          'Git returned an unrecognized repository status.',
        );
      }
    }
    if (branch === undefined || branch === '')
      throw new GitBackendError('invalid-status', 'Git did not report its current branch.');
    return { root, branch, dirty, conflicted };
  }

  async assertCanSwitch(branch: string): Promise<void> {
    this.assertActive();
    if (
      typeof branch !== 'string' ||
      !branch ||
      branch.startsWith('-') ||
      branch === 'HEAD' ||
      branch.includes('@{')
    ) {
      throw new GitBackendError(
        'invalid-branch',
        'Choose an existing local branch by its exact name.',
      );
    }
    let checked: string;
    try {
      checked = withoutFinalNewline(await this.raw(['check-ref-format', '--branch', branch]));
    } catch (cause) {
      throw new GitBackendError(
        'invalid-branch',
        'The saved branch name is not a valid local branch name.',
        { cause },
      );
    }
    if (checked !== branch)
      throw new GitBackendError(
        'invalid-branch',
        'Branch aliases and revision expressions are not supported.',
      );
    const ref = `refs/heads/${branch}`;
    const refs = (await this.raw(['for-each-ref', '--format=%(refname)', ref])).split(/\r?\n/);
    if (!refs.includes(ref))
      throw new GitBackendError('branch-not-found', `Local branch '${branch}' does not exist.`);

    const status = await this.inspect();
    if (status.conflicted)
      throw new GitBackendError(
        'conflicted-worktree',
        "Resolve the repository's conflicts before switching workspaces.",
        { status },
      );
    const markers = [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'BISECT_LOG',
      'index.lock',
    ];
    for (const marker of markers) {
      const gitPath = withoutFinalNewline(await this.raw(['rev-parse', '--git-path', marker]));
      const markerPath = this.native.resolve(status.root, gitPath);
      try {
        await this.native.access(markerPath);
      } catch (cause) {
        if (object(cause) && cause.code === 'ENOENT') continue;
        throw new GitBackendError('git-command-failed', `Could not check Git's ${marker} state.`, {
          status,
          cause,
        });
      }
      throw new GitBackendError(
        'operation-in-progress',
        `Finish the existing Git operation (${marker}) before switching workspaces.`,
        { status },
      );
    }
    if (status.branch === null)
      throw new GitBackendError(
        'detached-head',
        'Check out a local branch before switching a Git-bound workspace.',
        { status },
      );
    await this.assertRuntimeFilesStable(ref, status);
    if (status.dirty)
      throw new GitBackendError(
        'dirty-worktree',
        'Commit or otherwise resolve all tracked and untracked changes before switching branches.',
        { status },
      );

    if (this.plugin.settings.submoduleRecurseCheckout) {
      throw new GitBackendError(
        'unsupported-submodules',
        "Disable Obsidian Git's recursive submodule checkout before switching workspaces.",
        { status },
      );
    }
    const recurse = (
      await this.raw(['config', '--type=bool', '--default=false', '--get', 'submodule.recurse'])
    ).trim();
    if (recurse !== 'false') {
      throw new GitBackendError(
        'unsupported-submodules',
        "Git's submodule.recurse must be false for workspace branch switching.",
        { status },
      );
    }

    // Native checkout can overwrite ignored files without treating them as dirty.
    // Protect both direct path collisions and file/directory replacements.
    const ignored = (
      await this.raw(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
    )
      .split('\0')
      .filter(Boolean);
    if (ignored.length > 0) {
      const targetPaths = new Set(
        (await this.raw(['ls-tree', '-r', '--name-only', '-z', ref])).split('\0').filter(Boolean),
      );
      const targetParents = new Set<string>();
      for (const path of targetPaths) {
        let slash = path.lastIndexOf('/');
        while (slash !== -1) {
          targetParents.add(path.slice(0, slash));
          slash = path.lastIndexOf('/', slash - 1);
        }
      }
      for (const path of ignored) {
        let collision = targetPaths.has(path) || targetParents.has(path);
        let slash = path.lastIndexOf('/');
        while (!collision && slash !== -1) {
          collision = targetPaths.has(path.slice(0, slash));
          slash = path.lastIndexOf('/', slash - 1);
        }
        if (collision) {
          throw new GitBackendError(
            'dirty-worktree',
            `Ignored local file '${path}' would be replaced by branch '${branch}'.`,
            { status },
          );
        }
      }
    }
  }

  private async assertRuntimeFilesStable(targetRef: string, status: GitStatus): Promise<void> {
    const guard = this.checkoutGuard;
    if (!guard) return;
    const outside = (parent: string, candidate: string): boolean => {
      const relative = this.native.relative(parent, candidate);
      return (
        relative === '..' ||
        relative.startsWith(`..${this.native.sep}`) ||
        this.native.isAbsolute(relative)
      );
    };
    let root: string;
    let vault: string;
    try {
      root = await this.native.realpath(status.root);
      vault = await this.native.realpath(guard.vaultPath);
    } catch (cause) {
      throw new GitBackendError(
        'unsafe-runtime-files',
        "Could not verify the vault's relationship to the Git repository.",
        { status, cause },
      );
    }
    if (outside(root, vault)) {
      throw new GitBackendError(
        'unsafe-runtime-files',
        'The Obsidian vault must be inside the repository managed by Obsidian Git.',
        { status },
      );
    }
    if (
      !guard.configDir ||
      this.native.isAbsolute(guard.configDir) ||
      guard.configDir.includes('\\') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(guard.pluginId)
    ) {
      throw new GitBackendError(
        'unsafe-runtime-files',
        'The vault configuration directory or plugin ID is not supported for safe checkout.',
        { status },
      );
    }
    const config = this.native.resolve(vault, guard.configDir);
    if (outside(vault, config)) {
      throw new GitBackendError(
        'unsafe-runtime-files',
        'The Obsidian configuration directory must be inside its vault.',
        { status },
      );
    }
    // A symlink can hide the real runtime path from Git's tree names. Refuse
    // aliases for the configuration and integration entry points rather than
    // implying that a tree comparison protects an unrelated destination.
    const integrationDirectories = [guard.pluginId, 'obsidian-git'].map((id) =>
      this.native.resolve(config, 'plugins', id),
    );
    const physicalPaths = [
      config,
      this.native.resolve(config, 'plugins'),
      ...integrationDirectories,
      ...['community-plugins.json', 'workspace.json', 'workspace-mobile.json'].map((name) =>
        this.native.resolve(config, name),
      ),
      ...integrationDirectories.flatMap((directory) =>
        ['main.js', 'manifest.json', 'styles.css', 'data.json'].map((name) =>
          this.native.resolve(directory, name),
        ),
      ),
    ];
    for (const path of physicalPaths) {
      let physical: string;
      try {
        physical = await this.native.realpath(path);
      } catch (cause) {
        if (object(cause) && cause.code === 'ENOENT') continue;
        throw new GitBackendError(
          'unsafe-runtime-files',
          'Could not verify an Obsidian runtime path before checkout.',
          { status, cause },
        );
      }
      if (physical !== path) {
        throw new GitBackendError(
          'unsafe-runtime-files',
          'Symlinked Obsidian configuration or integration files are not supported for safe branch switching.',
          { status },
        );
      }
    }
    const configRelative = this.native.relative(root, config).split(this.native.sep).join('/');
    const prefix = configRelative ? `${configRelative}/` : '';
    const runtime = new Set([`${prefix}workspace.json`, `${prefix}workspace-mobile.json`]);
    // Avoid pathspec interpretation of configurable directory names. NUL-delimited
    // complete-tree paths also make additions, removals and unusual filenames exact.
    const currentTree = (
      await this.raw(['ls-tree', '--full-tree', '-r', '--name-only', '-z', 'HEAD'])
    ).split('\0');
    const targetTree = (
      await this.raw(['ls-tree', '--full-tree', '-r', '--name-only', '-z', targetRef])
    ).split('\0');
    const index = (await this.raw(['ls-files', '-z'])).split('\0');
    const trackedRuntime = [...currentTree, ...targetTree, ...index].find((path) =>
      runtime.has(path),
    );
    if (trackedRuntime) {
      throw new GitBackendError(
        'unsafe-runtime-files',
        `Native layout file '${trackedRuntime}' is tracked by Git. Keep workspace.json and workspace-mobile.json untracked in both branches before switching.`,
        { status },
      );
    }
    const protectedPaths = [
      `${prefix}community-plugins.json`,
      `${prefix}plugins/${guard.pluginId}`,
      `${prefix}plugins/obsidian-git`,
    ];
    // Disable rename detection so a protected file moved elsewhere still reports
    // its removed source path. Ancestor symlink/gitlink changes are protected too.
    const changes = (
      await this.raw([
        'diff',
        '--no-ext-diff',
        '--no-renames',
        '--name-only',
        '-z',
        'HEAD',
        targetRef,
        '--',
      ])
    )
      .split('\0')
      .filter(Boolean);
    const changedRuntime = changes.find((path) =>
      protectedPaths.some(
        (protectedPath) =>
          path === protectedPath ||
          path.startsWith(`${protectedPath}/`) ||
          protectedPath.startsWith(`${path}/`),
      ),
    );
    if (changedRuntime) {
      throw new GitBackendError(
        'unsafe-runtime-files',
        `The destination branch changes '${changedRuntime}', which could reload or disable the workspace/Git integration during checkout. Keep these runtime files identical between branches.`,
        { status },
      );
    }
  }

  private async refreshPresentation(): Promise<void> {
    // The provider's own switchBranch action refreshes its views and awaits the
    // branch label. These optional presentation hooks do not establish Git state.
    const refresh = async (label: string, action: () => unknown): Promise<void> => {
      try {
        await action();
      } catch (cause) {
        console.warn(`Workspaces could not refresh Obsidian Git's ${label}.`, cause);
      }
    };
    await refresh('views', () => {
      const app = this.plugin.app;
      const workspace = object(app) ? app.workspace : undefined;
      if (object(workspace) && typeof workspace.trigger === 'function') {
        return workspace.trigger('obsidian-git:refresh');
      }
    });
    await refresh('branch label', () => {
      const branchBar = this.plugin.branchBar;
      if (object(branchBar) && typeof branchBar.display === 'function') {
        return branchBar.display();
      }
    });
  }

  async checkout(branch: string): Promise<GitStatus> {
    let attempted = false;
    try {
      // Re-check here even if the caller already preflighted before flushing views.
      await this.assertCanSwitch(branch);
      this.assertActive();
      if (this.plugin.settings.submoduleRecurseCheckout) {
        throw new GitBackendError(
          'unsupported-submodules',
          'Recursive submodule checkout was enabled during this operation.',
        );
      }
      attempted = true;
      await this.manager.checkout(branch);
      const status = await this.inspect();
      if (status.branch !== branch) {
        throw new GitBackendError(
          'branch-mismatch',
          `Git did not activate the requested branch '${branch}'.`,
          { status },
        );
      }
      await this.refreshPresentation();
      return status;
    } catch (cause) {
      let status: GitStatus | undefined;
      try {
        status = await this.inspect();
      } catch {
        // Preserve the original failure; unknown state must not imply rollback.
      }
      // A provider may fail after changing HEAD. Refresh from its actual state
      // after any attempted checkout whose result could still be inspected.
      if (attempted && status) await this.refreshPresentation();
      const options = status === undefined ? { cause } : { status, cause };
      if (cause instanceof GitBackendError)
        throw new GitBackendError(cause.code, cause.message, options);
      throw new GitBackendError(
        'checkout-failed',
        `Git could not switch to '${branch}': ${message(cause)}`,
        options,
      );
    }
  }
}
