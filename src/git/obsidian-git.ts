import {
  GitBackendError,
  type GitBackend,
  type GitIdentity,
  type GitRepository,
  type GitStatus,
} from './backend';

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

interface RepositoryObservation {
  status: GitStatus;
  ignored: string[];
  headOID: string | null;
}

interface TargetTree {
  current: string[];
  target: string[];
  changed: string[];
}

const STATUS_ARGUMENTS = [
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=none',
];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function withoutFinalNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fullObjectID(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

/** Read-only queries may overlap, but must all settle before releasing the Git queue. */
async function awaitReads<const T extends readonly unknown[]>(reads: {
  [K in keyof T]: Promise<T[K]>;
}): Promise<T> {
  const results = await Promise.allSettled(reads);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
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
            let result: QueueResult<T>;
            try {
              assertConnected();
              await repository.initialize();
              const value = await operation(repository);
              result = { ok: true, value };
            } catch (error) {
              // Preserve controller errors as well as typed Git failures.
              result = { ok: false, error };
            } finally {
              // A layout failure must not let optional provider refresh reads
              // escape the queue scope. Presentation errors never replace the
              // operation's result, but all refresh work must settle first.
              try {
                await repository.drainPresentation();
              } finally {
                repository.release();
              }
            }
            if (result.ok) {
              try {
                assertConnected();
              } catch (error) {
                return { ok: false, error };
              }
            }
            return result;
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
  private presentationMayOverlap = false;
  private readonly pendingPresentation = new Set<Promise<void>>();
  private readonly expectedRoot: string;
  private expectedCanonicalRoot: string | null = null;

  constructor(
    private readonly plugin: InstalledGitPlugin,
    private readonly manager: NativeGitManager,
    private readonly assertConnected: () => void,
    private readonly native: NativePlatform,
    private readonly checkoutGuard?: ObsidianGitBackendOptions['checkoutGuard'],
  ) {
    this.expectedRoot = native.resolve(manager.absoluteRepoPath);
  }

  async initialize(): Promise<void> {
    this.assertActive();
    // Pin the physical repository before handing ownership to the callback.
    // A vault alias is valid, but retargeting it cannot redefine this transaction.
    this.expectedCanonicalRoot = await this.canonicalRoot(this.expectedRoot);
    this.assertActive();
  }

  private async canonicalRoot(path: string): Promise<string> {
    try {
      return await this.native.realpath(path);
    } catch (cause) {
      throw new GitBackendError(
        'repository-changed',
        "Could not resolve Obsidian Git's repository root. Check that the vault path is available.",
        { cause },
      );
    }
  }

  release(): void {
    this.active = false;
  }

  overlapPresentation(): void {
    this.assertActive();
    this.presentationMayOverlap = true;
  }

  async drainPresentation(): Promise<void> {
    while (this.pendingPresentation.size > 0) {
      await Promise.allSettled([...this.pendingPresentation]);
    }
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
    const [rootOutput, output] = await awaitReads([
      this.raw(['rev-parse', '--show-toplevel']),
      this.raw([...STATUS_ARGUMENTS]),
    ]);
    return (await this.observation(this.pathOutput(rootOutput), output)).status;
  }

  async inspectIdentity(): Promise<GitIdentity> {
    const fallback = async (): Promise<GitIdentity> => {
      const { root, branch } = await this.inspect();
      return { root, branch };
    };
    let output: string;
    try {
      output = await this.raw(['rev-parse', '--show-toplevel', '--symbolic-full-name', 'HEAD']);
    } catch (cause) {
      // Unborn HEAD fails rev-parse, but porcelain status still reports its
      // branch name. Preserve that behavior without inventing dirty flags.
      if (cause instanceof GitBackendError && cause.code === 'git-command-failed')
        return fallback();
      throw cause;
    }
    if (!output.endsWith('\n')) return fallback();
    const result = this.pathOutput(output);
    // Branch names cannot contain newlines; the root can. Only the final
    // separator identifies the symbolic ref, including roots ending in LF.
    const separator = result.lastIndexOf('\n');
    if (separator < 1) return fallback();
    const ref = result.slice(separator + 1);
    let branch: string | null;
    if (ref === 'HEAD') branch = null;
    else if (
      ref.startsWith('refs/heads/') &&
      ref.length > 'refs/heads/'.length &&
      !/[\0\r\n]/.test(ref)
    )
      branch = ref.slice('refs/heads/'.length);
    else return fallback();
    const rootOutput = result.slice(0, separator);
    const reportedRoot = this.native.sep === '\\' ? rootOutput.replace(/\r$/, '') : rootOutput;
    return { root: await this.checkedRoot(reportedRoot), branch };
  }

  private pathOutput(output: string): string {
    // POSIX path components can end in a literal carriage return or newline.
    return output.replace(this.native.sep === '\\' ? /\r?\n$/ : /\n$/, '');
  }

  private async checkedRoot(reportedRoot: string): Promise<string> {
    if (!reportedRoot)
      throw new GitBackendError('invalid-status', 'Git did not report its repository root.');
    const [root, providerRoot] = await awaitReads([
      this.canonicalRoot(this.native.resolve(reportedRoot)),
      this.canonicalRoot(this.expectedRoot),
    ]);
    this.assertActive();
    if (root !== this.expectedCanonicalRoot || providerRoot !== this.expectedCanonicalRoot) {
      throw new GitBackendError(
        'repository-changed',
        "Obsidian Git's current directory does not match its repository root.",
      );
    }
    return root;
  }

  private async observation(
    reportedRoot: string,
    output: string,
    includesIgnored = false,
  ): Promise<RepositoryObservation> {
    const root = await this.checkedRoot(reportedRoot);
    let branch: string | null | undefined;
    let dirty = false;
    let conflicted = false;
    let headOID: string | null = null;
    const ignored: string[] = [];
    const entries = output.split('\0');
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!entry) continue;
      if (entry.startsWith('# branch.head ')) {
        const head = entry.slice('# branch.head '.length);
        branch = head === '(detached)' ? null : head;
      } else if (entry.startsWith('# branch.oid ')) {
        const oid = entry.slice('# branch.oid '.length);
        headOID = fullObjectID(oid) ? oid : null;
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
      } else if (includesIgnored && entry.startsWith('! ') && entry.length > 2) {
        ignored.push(entry.slice(2));
      } else {
        throw new GitBackendError(
          'invalid-status',
          'Git returned an unrecognized repository status.',
        );
      }
    }
    if (branch === undefined || branch === '')
      throw new GitBackendError('invalid-status', 'Git did not report its current branch.');
    return { status: { root, branch, dirty, conflicted }, ignored, headOID };
  }

  private async guardPaths(markers: string[]): Promise<{ root: string; markers: string[] }> {
    const output = await this.raw([
      'rev-parse',
      '--show-toplevel',
      '--show-prefix',
      ...markers.flatMap((marker) => ['--git-path', marker]),
    ]);
    let paths = this.pathOutput(output).split(this.native.sep === '\\' ? /\r?\n/ : /\n/);
    const complete = (values: string[]): boolean =>
      values.length === markers.length + 2 &&
      values.every((path, index) => index === 1 || path !== '');
    if (!complete(paths)) {
      // Repository and Git-directory names may contain newlines. Individual
      // results retain those bytes; strip exactly one command terminator each.
      const individual = await awaitReads([
        this.raw(['rev-parse', '--show-toplevel']),
        this.raw(['rev-parse', '--show-prefix']),
        ...markers.map((marker) => this.raw(['rev-parse', '--git-path', marker])),
      ]);
      paths = individual.map((value) => this.pathOutput(value));
    }
    if (!complete(paths))
      throw new GitBackendError('invalid-status', 'Git did not report its operation paths.');
    const root = paths[0]!;
    // --git-path is relative to the provider's current directory, which can
    // be below the repository root. --show-prefix retains that relationship.
    const cwd = this.native.resolve(root, paths[1]!);
    return { root, markers: paths.slice(2).map((path) => this.native.resolve(cwd, path)) };
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
    const ref = `refs/heads/${branch}`;
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
    const [refsOutput, statusOutput, paths, recurseOutput] = await awaitReads([
      this.raw(['for-each-ref', '--format=%(refname)%00%(objectname)', ref]),
      this.raw([...STATUS_ARGUMENTS, '--ignored=traditional']),
      this.guardPaths(markers),
      this.raw(['config', '--type=bool', '--default=false', '--get', 'submodule.recurse']),
    ]);
    const targetRef = refsOutput
      .split(/\r?\n/)
      .map((line) => line.split('\0'))
      .find((parts) => parts[0] === ref);
    if (!targetRef) {
      // An existing exact refs/heads match already proves that this is a valid
      // local ref. Validate misses separately to retain invalid-name diagnostics
      // without spawning a process for every successful branch switch.
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
      throw new GitBackendError('branch-not-found', `Local branch '${branch}' does not exist.`);
    }
    const targetOID = targetRef[1];
    if (targetRef.length !== 2 || !targetOID || !fullObjectID(targetOID))
      throw new GitBackendError('invalid-status', 'Git did not report the target branch commit.');
    const { status, ignored, headOID } = await this.observation(paths.root, statusOutput, true);

    if (status.conflicted)
      throw new GitBackendError(
        'conflicted-worktree',
        "Resolve the repository's conflicts before switching workspaces.",
        { status },
      );
    for (const [index, marker] of markers.entries()) {
      const gitPath = paths.markers[index]!;
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
    const recurse = recurseOutput.trim();
    if (recurse !== 'false') {
      throw new GitBackendError(
        'unsupported-submodules',
        "Git's submodule.recurse must be false for workspace branch switching.",
        { status },
      );
    }

    // Include every source commit path even if another Git client changes the
    // index after status. Pin both tree reads to the freshly observed commits;
    // applying their raw diff retains the complete target tree plus conservative
    // index-only paths. Recheck everything after view unload in checkout().
    let targetTree: string[] = [];
    if (this.checkoutGuard || ignored.length > 0) {
      if (!headOID)
        throw new GitBackendError('invalid-status', 'Git did not report the source commit.', {
          status,
        });
      targetTree = await this.assertRuntimeFilesStable(headOID, targetOID, status);
    }

    // Native checkout can overwrite ignored files without treating them as dirty.
    // Protect both direct path collisions and file/directory replacements.
    if (ignored.length > 0) {
      const targetPaths = new Set(targetTree);
      const targetParents = new Set<string>();
      for (const path of targetPaths) {
        let slash = path.lastIndexOf('/');
        while (slash !== -1) {
          targetParents.add(path.slice(0, slash));
          slash = path.lastIndexOf('/', slash - 1);
        }
      }
      for (const ignoredPath of ignored) {
        // Ignored nested repositories can be reported as directory entries.
        const path = ignoredPath.replace(/\/$/, '');
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

  private async assertRuntimeFilesStable(
    sourceOID: string,
    targetOID: string,
    status: GitStatus,
  ): Promise<string[]> {
    const guard = this.checkoutGuard;
    if (!guard) return (await this.readTargetTree(sourceOID, targetOID, status)).target;
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
    // Full repository paths avoid interpreting configurable directories as
    // pathspecs, and also include entries expanded from a sparse index.
    const tree = await this.readTargetTree(sourceOID, targetOID, status);
    const trackedRuntime = [...tree.current, ...tree.target].find((path) => runtime.has(path));
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
    const changedRuntime = tree.changed.find((path) =>
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
    // Reuse only within this preflight. The final guard after view unload reads
    // the target tree again, along with refs, index, configuration and status.
    return tree.target;
  }

  private async readTargetTree(
    sourceOID: string,
    targetOID: string,
    status: GitStatus,
  ): Promise<TargetTree> {
    const [indexOutput, diffOutput] = await awaitReads([
      // A fixed top-level pathspec covers the whole repository even if the
      // provider's current directory is nested. --with-tree includes deleted
      // source paths even if the index changes after status. Do not request
      // --sparse: expand directory entries into all their tracked paths.
      this.raw(['ls-files', `--with-tree=${sourceOID}`, '--full-name', '-z', '--', ':/']),
      this.raw([
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-renames',
        '--no-ext-diff',
        '--no-relative',
        '--ignore-submodules=none',
        sourceOID,
        targetOID,
        '--',
      ]),
    ]);
    const invalid = (): never => {
      throw new GitBackendError(
        'invalid-status',
        'Git did not return a complete index and target tree comparison.',
        { status },
      );
    };
    const records = (output: string): string[] => {
      if (!output) return [];
      const values = output.split('\0');
      if (values.pop() !== '') return invalid();
      return values;
    };
    const validPath = (path: string): boolean =>
      path !== '' && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
    const current = records(indexOutput);
    const target = new Set(current);
    if (target.size !== current.length || current.some((path) => !validPath(path))) invalid();
    const differences = records(diffOutput);
    if (differences.length % 2 !== 0) invalid();
    const changed = new Set<string>();
    const modes = new Set(['000000', '100644', '100755', '120000', '160000']);
    for (let index = 0; index < differences.length; index += 2) {
      const header = differences[index]!;
      const path = differences[index + 1]!;
      const match =
        /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([ADMT])([0-9]{1,3})?$/.exec(
          header,
        );
      if (!match || !validPath(path) || changed.has(path)) invalid();
      const [, oldMode, newMode, oldObject, newObject, kind, score] = match!;
      if (
        !modes.has(oldMode!) ||
        !modes.has(newMode!) ||
        oldObject!.length !== newObject!.length ||
        (oldMode === '000000') !== /^0+$/.test(oldObject!) ||
        (newMode === '000000') !== /^0+$/.test(newObject!) ||
        (score !== undefined && (kind !== 'M' || Number(score) > 100))
      )
        invalid();
      if (kind === 'A') {
        if (oldMode !== '000000' || newMode === '000000' || target.has(path)) invalid();
      } else {
        if (oldMode === '000000' || !target.has(path)) invalid();
        if (kind === 'D') {
          if (newMode !== '000000') invalid();
        } else if (
          newMode === '000000' ||
          (kind === 'T') !== (oldMode!.slice(0, 3) !== newMode!.slice(0, 3))
        ) {
          invalid();
        }
      }
      changed.add(path);
      if (kind === 'D') target.delete(path);
      else target.add(path);
    }
    return { current, target: [...target], changed: [...changed] };
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

  private async presentCheckout(): Promise<void> {
    const pending = this.refreshPresentation();
    this.pendingPresentation.add(pending);
    // Attach both handlers immediately, including for callers that permit
    // overlap. Rejected optional hooks must not become unhandled rejections.
    void pending.then(
      () => this.pendingPresentation.delete(pending),
      () => this.pendingPresentation.delete(pending),
    );
    if (!this.presentationMayOverlap) await this.drainPresentation();
  }

  async checkout(branch: string): Promise<GitIdentity> {
    let attempted = false;
    try {
      // A second checkout in the same transaction cannot overtake the first
      // branch label's refresh, even when presentation overlap was requested.
      await this.drainPresentation();
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
      const identity = await this.inspectIdentity();
      if (identity.branch !== branch) {
        throw new GitBackendError(
          'branch-mismatch',
          `Git did not activate the requested branch '${branch}'.`,
        );
      }
      await this.presentCheckout();
      return identity;
    } catch (cause) {
      let status: GitStatus | undefined;
      try {
        status = await this.inspect();
      } catch {
        // Preserve the original failure; unknown state must not imply rollback.
      }
      // A provider may fail after changing HEAD. Refresh from its actual state
      // after any attempted checkout whose result could still be inspected.
      if (attempted && status) await this.presentCheckout();
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
