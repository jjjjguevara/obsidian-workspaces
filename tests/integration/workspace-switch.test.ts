import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { GitBackendError } from '../../src/git/backend.ts';
import { ObsidianGitBackend } from '../../src/git/obsidian-git.ts';
import { FileStateStore, type StateStore } from '../../src/storage/store.ts';
import { addWorkspace } from '../../src/workspaces/catalog.ts';
import { WorkspaceController, type WorkspaceHost } from '../../src/workspaces/controller.ts';
import {
  emptyState,
  snapshot,
  type Layout,
  type WorkspaceState,
} from '../../src/workspaces/model.ts';

const execute = promisify(execFile);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Persists cloned snapshots independently of a controller instance for restart tests. */
class DurableMemoryStore implements StateStore {
  readonly writes: WorkspaceState[] = [];
  private durable: WorkspaceState;

  constructor(
    initial: WorkspaceState,
    readonly location: string,
  ) {
    this.durable = structuredClone(initial);
  }

  async load(): Promise<WorkspaceState> {
    return structuredClone(this.durable);
  }
  async save(state: WorkspaceState): Promise<void> {
    assert.equal(
      state.revision,
      this.durable.revision + 1,
      'Every durable write advances CAS once',
    );
    this.durable = structuredClone(state);
    this.writes.push(structuredClone(state));
  }
  async assertOutsideRepository(root: string): Promise<void> {
    const path = relative(root, this.location);
    assert.ok(
      path.startsWith('..') || isAbsolute(path),
      'The control store must stay outside checkout content',
    );
  }
}

function nativeLayout(branch: 'alpha' | 'beta'): Layout {
  return {
    main: {
      id: `${branch}-main`,
      type: 'split',
      direction: 'vertical',
      children: [
        {
          id: `${branch}-tabs`,
          type: 'tabs',
          currentTab: 0,
          children: [
            {
              id: `${branch}-exclusive`,
              type: 'leaf',
              state: {
                type: 'markdown',
                state: { file: `notes/${branch}-only.md`, mode: 'source' },
                pinned: true,
              },
            },
            {
              id: `${branch}-common`,
              type: 'leaf',
              state: {
                type: 'markdown',
                state: { file: 'common.md', mode: 'source' },
                pinned: true,
              },
            },
          ],
        },
      ],
    },
    left: {
      id: `${branch}-left`,
      type: 'split',
      children: [],
      width: branch === 'alpha' ? 240 : 320,
    },
    right: { id: `${branch}-right`, type: 'split', children: [], collapsed: true },
    active: `${branch}-exclusive`,
  };
}

function notePaths(layout: Layout): string[] {
  const paths = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const value = node as Record<string, unknown>;
    if (typeof value.file === 'string') paths.add(value.file);
    Object.values(value).forEach(visit);
  };
  visit(layout);
  return [...paths];
}

/** A fake Obsidian host whose Vault cache can lag behind the real checkout. */
class TestHost implements WorkspaceHost {
  current: Layout;
  readonly cachedText = new Map<string, string>();
  readonly restored: Layout[] = [];
  readonly hydrations: Array<boolean | undefined> = [];
  readonly events: string[] = [];
  readonly waiting = deferred();
  waitGate: Promise<void> | undefined;
  pendingEdit: { path: string; content: string } | undefined;
  failNextRestore = false;
  blockDepth = 0;
  private readyLayout: string | undefined;

  constructor(
    readonly root: string,
    initial: Layout,
  ) {
    this.current = structuredClone(initial);
  }
  async seedCache(): Promise<void> {
    for (const path of notePaths(this.current))
      this.cachedText.set(path, await readFile(join(this.root, path), 'utf8'));
  }
  /** A started Obsidian has indexed the files that are on disk now. */
  async indexVault(...layouts: Layout[]): Promise<void> {
    for (const path of layouts.flatMap(notePaths)) {
      try {
        this.cachedText.set(path, await readFile(join(this.root, path), 'utf8'));
      } catch {
        this.cachedText.delete(path);
      }
    }
  }
  capture(): Layout {
    return structuredClone(this.current);
  }
  async flush(): Promise<void> {
    this.events.push('flush');
    if (this.pendingEdit) {
      await writeFile(join(this.root, this.pendingEdit.path), this.pendingEdit.content);
      this.cachedText.set(this.pendingEdit.path, this.pendingEdit.content);
      this.pendingEdit = undefined;
    }
  }
  async quiesce(): Promise<void> {
    this.events.push('quiesce');
    this.current = { main: { id: 'transition', type: 'split', children: [] } };
  }
  async waitForFiles(target: Layout, previous: Layout): Promise<void> {
    this.events.push('wait');
    this.waiting.resolve();
    if (this.waitGate) await this.waitGate;
    const targetPaths = notePaths(target);
    // Simulate complete watcher delivery; compare bytes, not just file length.
    for (const path of targetPaths)
      this.cachedText.set(path, await readFile(join(this.root, path), 'utf8'));
    for (const path of notePaths(previous)) {
      if (!targetPaths.includes(path)) {
        try {
          await access(join(this.root, path));
        } catch {
          this.cachedText.delete(path);
        }
      }
    }
    this.readyLayout = JSON.stringify(target);
  }
  async restore(layout: Layout, options: { hydrate?: boolean } = {}): Promise<void> {
    this.hydrations.push(options.hydrate);
    // After a checkout the readiness barrier comes first. Without a checkout
    // there is no wait: no file changed, so the cache already matches disk.
    assert.equal(
      this.readyLayout,
      options.hydrate ? JSON.stringify(layout) : undefined,
      "Restoration after a checkout must follow the target's readiness barrier",
    );
    for (const path of notePaths(layout)) {
      assert.equal(
        this.cachedText.get(path),
        await readFile(join(this.root, path), 'utf8'),
        "The editor cache must match this branch's bytes",
      );
    }
    this.events.push('restore');
    this.readyLayout = undefined;
    if (this.failNextRestore) {
      this.failNextRestore = false;
      this.current = { main: { id: 'failed-restore', type: 'split', children: [] } };
      throw new Error('Injected layout restoration failure');
    }
    this.current = structuredClone(layout);
    this.restored.push(structuredClone(layout));
  }
  block(): () => void {
    this.blockDepth += 1;
    return () => {
      this.blockDepth -= 1;
    };
  }
  async confirmDiscard(): Promise<boolean> {
    return true;
  }
}

function gitBackend(root: string, git: (args: string[]) => Promise<string>, store: StateStore) {
  const checkouts: string[] = [];
  let tail: Promise<void> = Promise.resolve();
  const provider = {
    manifest: { id: 'obsidian-git', version: '2.43.0' },
    gitReady: true,
    settings: { submoduleRecurseCheckout: false },
    gitManager: {
      absoluteRepoPath: root,
      git: { raw: git },
      async checkout(branch: string): Promise<void> {
        const durable = await store.load();
        assert.ok(durable.journal, 'A recovery journal must be durable before checkout');
        checkouts.push(branch);
        await git(['checkout', branch]);
      },
    },
    promiseQueue: {
      addTask<T>(task: () => Promise<T>, callback?: (result: T | undefined) => void): void {
        tail = tail.then(task).then(
          (value) => {
            callback?.(value);
          },
          () => {
            callback?.(undefined);
          },
        );
      },
    },
  };
  return {
    checkouts,
    adapter: new ObsidianGitBackend({ resolvePlugin: () => provider, isDesktop: () => true }),
  };
}

async function fixture(t: TestContext, autoSave = true) {
  const directory = await mkdtemp(join(tmpdir(), 'obsidian-workspace-transition-'));
  const base = await realpath(directory);
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  await mkdir(join(root, 'notes'), { recursive: true });
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(base, 'absent-global-config'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Workspace controller test',
    GIT_AUTHOR_EMAIL: 'workspaces@example.invalid',
    GIT_COMMITTER_NAME: 'Workspace controller test',
    GIT_COMMITTER_EMAIL: 'workspaces@example.invalid',
  };
  const git = async (args: string[]): Promise<string> =>
    (await execute('git', args, { cwd: root, env: environment, encoding: 'utf8' })).stdout;
  await git(['init', '-b', 'alpha']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.hooksPath', join(root, '.git', 'disabled-hooks')]);
  await writeFile(join(root, 'notes', 'alpha-only.md'), 'A pinned note only on alpha\n');
  await writeFile(join(root, 'common.md'), 'ALPHA\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Alpha context']);
  await git(['checkout', '-b', 'beta']);
  await rm(join(root, 'notes', 'alpha-only.md'));
  await writeFile(join(root, 'notes', 'beta-only.md'), 'A pinned note only on beta\n');
  await writeFile(join(root, 'common.md'), 'BRAVO\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'Beta context']);
  await git(['checkout', 'alpha']);

  const alphaLayout = nativeLayout('alpha');
  const betaLayout = nativeLayout('beta');
  const state = emptyState();
  state.autoSave = autoSave;
  const alphaId = addWorkspace(
    state,
    'Alpha',
    snapshot(alphaLayout, 'desktop', { root, branch: 'alpha' }),
  );
  const betaId = addWorkspace(
    state,
    'Beta',
    snapshot(betaLayout, 'desktop', { root, branch: 'beta' }),
  );
  state.activeId = alphaId;
  const store = new DurableMemoryStore(state, join(base, 'control', 'state.json'));
  const host = new TestHost(root, alphaLayout);
  await host.seedCache();
  const { adapter, checkouts } = gitBackend(root, git, store);
  const controller = new WorkspaceController(state, store, host, adapter, 'desktop');
  return {
    base,
    environment,
    root,
    git,
    store,
    host,
    checkouts,
    adapter,
    controller,
    alphaId,
    betaId,
    alphaLayout,
    betaLayout,
  };
}

test('controller round trips exclusive pinned notes and waits for changed same-size shared content', async (t) => {
  const f = await fixture(t);
  const watchers = deferred();
  f.host.waitGate = watchers.promise;
  let completed = false;
  const transition = f.controller.activate(f.betaId).then(() => {
    completed = true;
  });
  await f.host.waiting.promise;
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'beta');
  assert.equal(f.host.cachedText.get('common.md'), 'ALPHA\n');
  assert.equal(await readFile(join(f.root, 'common.md'), 'utf8'), 'BRAVO\n');
  assert.equal(Buffer.byteLength('ALPHA\n'), Buffer.byteLength('BRAVO\n'));
  assert.equal(
    f.controller.state.activeId,
    f.alphaId,
    'The active workspace must not advance before restoration',
  );
  assert.equal(f.controller.state.journal?.phase, 'restoring');
  assert.equal((await f.store.load()).journal?.phase, 'prepared');
  assert.equal(
    f.store.writes.length,
    1,
    'Only the prepared checkpoint is durable before restoration',
  );
  assert.equal(completed, false);
  assert.deepEqual(f.host.restored, []);
  assert.equal(f.host.blockDepth, 1);
  watchers.resolve();
  await transition;
  assert.deepEqual(
    f.host.current,
    f.betaLayout,
    'Native pin flags, selected leaf, splits and sidebar geometry survive',
  );
  assert.equal(f.host.cachedText.get('common.md'), 'BRAVO\n');
  assert.equal(f.host.cachedText.has('notes/alpha-only.md'), false);
  assert.ok(f.host.cachedText.has('notes/beta-only.md'));
  assert.equal(f.controller.state.activeId, f.betaId);
  assert.equal(f.controller.state.journal, null);
  assert.deepEqual(
    f.store.writes.map((state) => [state.revision, state.journal?.phase ?? null]),
    [
      [1, 'prepared'],
      [2, null],
    ],
  );

  f.host.waitGate = undefined;
  await f.controller.activate(f.alphaId);
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
  assert.deepEqual(f.host.current, f.alphaLayout);
  assert.equal(f.host.cachedText.get('common.md'), 'ALPHA\n');
  await assert.rejects(access(join(f.root, 'notes', 'beta-only.md')));
  assert.equal(f.host.blockDepth, 0);
  assert.deepEqual(f.checkouts, ['beta', 'alpha']);
  assert.deepEqual(f.host.hydrations, [true, true], 'Each checkout loads the restored views');
  const persisted = await f.store.load();
  assert.equal(persisted.activeId, f.alphaId);
  assert.equal(persisted.journal, null);
  assert.deepEqual(persisted.workspaces[f.alphaId]!.contexts.desktop!.layout, f.alphaLayout);
  assert.deepEqual(persisted.workspaces[f.betaId]!.contexts.desktop!.layout, f.betaLayout);
  assert.deepEqual(
    f.store.writes.map((state) => [state.revision, state.journal?.phase ?? null]),
    [
      [1, 'prepared'],
      [2, null],
      [3, 'prepared'],
      [4, null],
    ],
  );
});

test('dirty editor content is flushed and blocks the transition before checkout or journaling', async (t) => {
  const f = await fixture(t);
  f.host.pendingEdit = { path: 'common.md', content: 'Uncommitted editor changes\n' };
  await assert.rejects(
    f.controller.activate(f.betaId),
    (error: unknown) => error instanceof GitBackendError && error.code === 'dirty-worktree',
  );
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
  assert.equal(await readFile(join(f.root, 'common.md'), 'utf8'), 'Uncommitted editor changes\n');
  assert.deepEqual(f.checkouts, []);
  assert.deepEqual(f.host.events, ['flush']);
  assert.deepEqual(f.host.current, f.alphaLayout);
  assert.equal(f.host.blockDepth, 0);
  assert.equal(f.controller.state.activeId, f.alphaId);
  assert.equal(f.controller.state.journal, null);
  assert.deepEqual(f.store.writes, []);
});

test('failed restoration retains a durable journal and explicit recovery survives controller restart', async (t) => {
  const f = await fixture(t);
  f.host.failNextRestore = true;
  await assert.rejects(f.controller.activate(f.betaId), /Injected layout restoration failure/);
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'beta');
  const failed = await f.store.load();
  assert.equal(failed.activeId, f.alphaId);
  assert.equal(failed.journal?.phase, 'recovery');
  assert.equal(failed.journal?.originalBranch?.branch, 'alpha');
  assert.equal(failed.journal?.target.binding?.branch, 'beta');
  assert.match(failed.journal?.error ?? '', /Observed branch: beta/);
  assert.deepEqual(failed.journal?.source.layout, f.alphaLayout);
  assert.deepEqual(failed.journal?.target.layout, f.betaLayout);
  assert.deepEqual(failed.workspaces[f.alphaId]!.contexts.desktop!.layout, f.alphaLayout);
  assert.deepEqual(failed.workspaces[f.betaId]!.contexts.desktop!.layout, f.betaLayout);
  assert.equal(f.host.blockDepth, 0);
  await assert.rejects(f.controller.saveActive(), /needs recovery/);

  f.controller.dispose();
  const restarted = new WorkspaceController(failed, f.store, f.host, f.adapter, 'desktop');
  await assert.rejects(restarted.activate(f.alphaId), /needs recovery/);
  await restarted.recover();
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
  assert.deepEqual(f.host.current, f.alphaLayout);
  assert.equal(f.host.cachedText.get('common.md'), 'ALPHA\n');
  assert.equal(restarted.state.activeId, f.alphaId);
  assert.equal(restarted.state.journal, null);
  assert.equal((await f.store.load()).journal, null);
  await assert.rejects(access(join(f.root, 'notes', 'beta-only.md')));
  assert.deepEqual(f.checkouts, ['beta', 'alpha']);
  assert.equal(f.host.blockDepth, 0);
});

// Run the real controller/store/adapter in a separate process. Exiting at the
// selected checkpoint prevents catch/finally from turning a crash into a handled
// transition error that happens to persist an additional recovery record.
const crashRunner = String.raw`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
const config = JSON.parse(await readFile(process.argv[1], 'utf8'));
const { WorkspaceController } = await import(config.modules.controller);
const { FileStateStore } = await import(config.modules.store);
const { ObsidianGitBackend } = await import(config.modules.backend);
const execute = promisify(execFile);
const git = async (args) => (await execute('git', args, {
  cwd: config.root, encoding: 'utf8', env: process.env,
})).stdout;
const diskStore = new FileStateStore(config.controlFile);
let controller;
const notePaths = (layout) => {
  const paths = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.file === 'string') paths.add(node.file);
    for (const child of Object.values(node)) visit(child);
  };
  visit(layout);
  return paths;
};
const host = {
  current: structuredClone(config.liveLayout),
  events: [],
  capture() { return structuredClone(this.current); },
  async flush() { this.events.push('flush'); },
  async quiesce() {
    const durable = JSON.parse(await readFile(config.controlFile, 'utf8'));
    assert.equal(durable.journal?.phase, 'prepared');
    assert.equal(durable.revision, 1);
    assert.deepEqual(durable.journal.source.layout, config.liveLayout);
    this.events.push('quiesce');
    this.current = { main: { id: 'transition', type: 'split', children: [] } };
  },
  async waitForFiles(target) {
    this.events.push('wait');
    for (const path of notePaths(target)) await readFile(join(config.root, path));
  },
  async restore(target) {
    assert.equal(this.events.at(-1), 'wait');
    this.events.push('restore');
    this.current = structuredClone(target);
  },
  block() { return () => {}; },
  async confirmDiscard() { return true; },
};
async function crash(point) {
  if (config.checkpoint !== point) return;
  await writeFile(config.checkpointFile, JSON.stringify({
    point,
    branch: (await git(['branch', '--show-current'])).trim(),
    phase: controller.state.journal?.phase,
    revision: controller.state.revision,
    liveLayout: host.current,
    events: host.events,
  }));
  process.exit(86);
}
const store = {
  location: diskStore.location,
  load: () => diskStore.load(),
  assertOutsideRepository: (root) => diskStore.assertOutsideRepository(root),
  async save(state) {
    if (state.journal === null && state.activeId === config.betaId) {
      assert.equal(host.events.at(-1), 'restore');
      await crash('before-final-commit');
    }
    return diskStore.save(state);
  },
};
let tail = Promise.resolve();
const provider = {
  manifest: { id: 'obsidian-git', version: '2.43.0' },
  gitReady: true,
  settings: { submoduleRecurseCheckout: false },
  gitManager: {
    absoluteRepoPath: config.root,
    git: { raw: git },
    async checkout(branch) {
      assert.equal(host.events.at(-1), 'quiesce');
      await crash('before-checkout');
      await git(['checkout', branch]);
      await crash('after-checkout');
    },
  },
  promiseQueue: {
    addTask(task, callback) {
      tail = tail.then(task).then(
        (result) => { callback?.(result); },
        () => { callback?.(undefined); },
      );
    },
  },
};
const backend = new ObsidianGitBackend({ resolvePlugin: () => provider, isDesktop: () => true });
controller = new WorkspaceController(await store.load(), store, host, backend, 'desktop');
await controller.activate(config.betaId);
throw new Error('The requested crash checkpoint was not reached');
`;

test('the prepared journal recovers actual process interruptions at every checkout/commit boundary', async (t) => {
  for (const checkpoint of ['before-checkout', 'after-checkout', 'before-final-commit'] as const) {
    for (const autoSave of [true, false]) {
      await t.test(`${checkpoint}, autoSave=${autoSave}`, async (t) => {
        const f = await fixture(t, autoSave);
        const initial = await f.store.load();
        const liveLayout = structuredClone(f.alphaLayout);
        (liveLayout.left as { width: number }).width = 280;
        const controlFile = f.store.location;
        const checkpointFile = join(f.base, 'checkpoint.json');
        const configFile = join(f.base, 'crash-input.json');
        await mkdir(dirname(controlFile), { recursive: true });
        await writeFile(controlFile, JSON.stringify(initial));
        await writeFile(
          configFile,
          JSON.stringify({
            checkpoint,
            root: f.root,
            controlFile,
            checkpointFile,
            betaId: f.betaId,
            liveLayout,
            modules: {
              controller: new URL('../../src/workspaces/controller.ts', import.meta.url).href,
              store: new URL('../../src/storage/store.ts', import.meta.url).href,
              backend: new URL('../../src/git/obsidian-git.ts', import.meta.url).href,
            },
          }),
        );
        await assert.rejects(
          execute(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', crashRunner, configFile],
            {
              env: f.environment,
              encoding: 'utf8',
              timeout: 20_000,
            },
          ),
          (error: unknown) => error instanceof Error && 'code' in error && error.code === 86,
          'The child must exit at the checkpoint, without unwinding controller recovery',
        );
        const stopped = JSON.parse(await readFile(checkpointFile, 'utf8')) as {
          point: string;
          branch: string;
          phase: string;
          revision: number;
          liveLayout: Layout;
          events: string[];
        };
        const expectedBranch = checkpoint === 'before-checkout' ? 'alpha' : 'beta';
        assert.equal(stopped.point, checkpoint);
        assert.equal(stopped.branch, expectedBranch);
        assert.equal((await f.git(['branch', '--show-current'])).trim(), expectedBranch);
        assert.equal(
          stopped.phase,
          checkpoint === 'before-final-commit' ? 'restoring' : 'checkout',
        );
        assert.equal(stopped.revision, 1, 'Diagnostic phase changes must not advance durable CAS');
        assert.deepEqual(
          stopped.events,
          checkpoint === 'before-final-commit'
            ? ['flush', 'quiesce', 'wait', 'restore']
            : ['flush', 'quiesce'],
        );
        const diskStore = new FileStateStore(controlFile);
        const interrupted = await diskStore.load();
        assert.equal(interrupted.revision, 1);
        assert.equal(interrupted.activeId, f.alphaId);
        assert.equal(interrupted.journal?.phase, 'prepared');
        assert.equal(interrupted.journal?.sourceId, f.alphaId);
        assert.equal(interrupted.journal?.targetId, f.betaId);
        assert.deepEqual(interrupted.journal?.originalBranch, { root: f.root, branch: 'alpha' });
        assert.deepEqual(interrupted.journal?.source.layout, liveLayout);
        assert.deepEqual(interrupted.journal?.source.binding, { root: f.root, branch: 'alpha' });
        assert.deepEqual(
          interrupted.journal?.target,
          initial.workspaces[f.betaId]!.contexts.desktop,
        );
        const sourceSaved = autoSave
          ? interrupted.journal!.source
          : initial.workspaces[f.alphaId]!.contexts.desktop;
        assert.deepEqual(interrupted.journal?.sourceSaved, sourceSaved);
        assert.deepEqual(interrupted.workspaces[f.alphaId]!.contexts.desktop, sourceSaved);
        assert.deepEqual(interrupted.workspaces[f.betaId], initial.workspaces[f.betaId]);
        assert.deepEqual(JSON.parse(await readFile(`${controlFile}.backup`, 'utf8')), initial);
        await assert.rejects(
          access(`${controlFile}.lock`),
          'The prepared commit must release its lock before checkout',
        );

        const host = new TestHost(f.root, stopped.liveLayout);
        // Recovery waits for files only after its own checkout. Model the
        // restarted application: its cache holds the files that are on disk.
        await host.indexVault(
          interrupted.journal!.source.layout,
          interrupted.journal!.target.layout,
        );
        const { adapter, checkouts } = gitBackend(f.root, f.git, diskStore);
        const restarted = new WorkspaceController(interrupted, diskStore, host, adapter, 'desktop');
        assert.deepEqual(checkouts, [], 'Constructing a controller never checks out a branch');
        assert.equal((await f.git(['branch', '--show-current'])).trim(), expectedBranch);
        await assert.rejects(restarted.activate(f.betaId), /needs recovery/);
        assert.deepEqual(checkouts, []);
        await restarted.recover();
        assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
        assert.deepEqual(checkouts, checkpoint === 'before-checkout' ? [] : ['alpha']);
        assert.deepEqual(
          host.events,
          checkpoint === 'before-checkout'
            ? ['flush', 'restore']
            : ['flush', 'quiesce', 'wait', 'restore'],
          'Recovery waits for files only when it checked out the original branch',
        );
        assert.deepEqual(host.hydrations, [checkpoint !== 'before-checkout']);
        assert.deepEqual(
          host.current,
          liveLayout,
          'Recovery restores the complete live source layout and its pins',
        );
        assert.equal(host.cachedText.get('common.md'), 'ALPHA\n');
        assert.equal(host.cachedText.get('notes/alpha-only.md'), 'A pinned note only on alpha\n');
        assert.equal(host.cachedText.has('notes/beta-only.md'), false);
        assert.equal(host.blockDepth, 0);
        const recovered = await diskStore.load();
        assert.equal(recovered.revision, 2, 'Recovery advances the prepared revision exactly once');
        assert.equal(recovered.activeId, f.alphaId);
        assert.equal(recovered.journal, null);
        assert.deepEqual(recovered.workspaces[f.alphaId]!.contexts.desktop, sourceSaved);
        assert.deepEqual(recovered.workspaces[f.alphaId], interrupted.workspaces[f.alphaId]);
        assert.deepEqual(recovered.workspaces[f.betaId], initial.workspaces[f.betaId]);
        assert.deepEqual(JSON.parse(await readFile(`${controlFile}.backup`, 'utf8')), interrupted);
        assert.equal((await f.git(['status', '--porcelain'])).trim(), '');
        await assert.rejects(access(join(f.root, 'notes', 'beta-only.md')));
      });
    }
  }
});
