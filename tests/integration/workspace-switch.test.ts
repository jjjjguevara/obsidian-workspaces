import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { GitBackendError } from '../../src/git/backend.ts';
import { ObsidianGitBackend } from '../../src/git/obsidian-git.ts';
import type { StateStore } from '../../src/storage/store.ts';
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
  async restore(layout: Layout): Promise<void> {
    assert.equal(
      this.readyLayout,
      JSON.stringify(layout),
      "Restoration must follow the target's readiness barrier",
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

async function fixture(t: TestContext) {
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
  const adapter = new ObsidianGitBackend({ resolvePlugin: () => provider, isDesktop: () => true });
  const controller = new WorkspaceController(state, store, host, adapter, 'desktop');
  return {
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

  f.host.waitGate = undefined;
  await f.controller.activate(f.alphaId);
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
  assert.deepEqual(f.host.current, f.alphaLayout);
  assert.equal(f.host.cachedText.get('common.md'), 'ALPHA\n');
  await assert.rejects(access(join(f.root, 'notes', 'beta-only.md')));
  assert.equal(f.host.blockDepth, 0);
  assert.deepEqual(f.checkouts, ['beta', 'alpha']);
  const persisted = await f.store.load();
  assert.equal(persisted.activeId, f.alphaId);
  assert.equal(persisted.journal, null);
  assert.deepEqual(persisted.workspaces[f.alphaId]!.contexts.desktop!.layout, f.alphaLayout);
  assert.deepEqual(persisted.workspaces[f.betaId]!.contexts.desktop!.layout, f.betaLayout);
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
