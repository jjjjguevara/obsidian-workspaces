import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GitBackendError,
  type GitBackend,
  type GitRepository,
  type GitStatus,
} from '../../src/git/backend.ts';
import { CommittedWriteError, type StateStore } from '../../src/storage/store.ts';
import { addWorkspace } from '../../src/workspaces/catalog.ts';
import { migrateState } from '../../src/storage/migrations.ts';
import { WorkspaceController, type WorkspaceHost } from '../../src/workspaces/controller.ts';
import {
  emptyState,
  snapshot,
  type Device,
  type Layout,
  type WorkspaceState,
} from '../../src/workspaces/model.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function layout(name: string, device: Device = 'desktop'): Layout {
  return {
    main: {
      id: `${name}-main`,
      type: 'split',
      children: [
        {
          id: `${name}-tabs`,
          type: 'tabs',
          children: [
            {
              id: `${name}-note`,
              type: 'leaf',
              state: { type: 'markdown', pinned: true, state: { file: `${name}.md` } },
            },
          ],
        },
      ],
    },
    left: { id: 'left', type: device === 'mobile' ? 'mobile-drawer' : 'split', children: [] },
    active: `${name}-note`,
  };
}

class MemoryStore implements StateStore {
  writes: WorkspaceState[] = [];
  beforeSave: ((state: WorkspaceState) => void) | undefined;
  afterSave: ((state: WorkspaceState) => void) | undefined;
  private persisted: WorkspaceState;

  constructor(
    initial: WorkspaceState,
    readonly location: string | null,
  ) {
    this.persisted = structuredClone(initial);
  }
  async load(): Promise<WorkspaceState> {
    return structuredClone(this.persisted);
  }
  async save(state: WorkspaceState): Promise<void> {
    this.beforeSave?.(state);
    this.persisted = structuredClone(state);
    this.writes.push(structuredClone(state));
    this.afterSave?.(state);
  }
  async assertOutsideRepository(root: string): Promise<void> {
    assert.equal(root, '/repository');
    assert.equal(this.location, '/controls/state.json');
  }
}

class TestGit implements GitBackend, GitRepository {
  status: GitStatus;
  entered = 0;
  active = 0;
  maxActive = 0;
  readonly preflights: string[] = [];
  readonly checkouts: string[] = [];

  constructor(branch = 'alpha') {
    this.status = { root: '/repository', branch, dirty: false, conflicted: false };
  }
  async withRepository<T>(operation: (repository: GitRepository) => Promise<T>): Promise<T> {
    this.entered += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await operation(this);
    } finally {
      this.active -= 1;
    }
  }
  async inspect(): Promise<GitStatus> {
    return structuredClone(this.status);
  }
  async assertCanSwitch(branch: string): Promise<void> {
    this.preflights.push(branch);
    if (this.status.dirty)
      throw new GitBackendError('dirty-worktree', 'Uncommitted changes', {
        status: await this.inspect(),
      });
  }
  async checkout(branch: string): Promise<GitStatus> {
    this.checkouts.push(branch);
    this.status.branch = branch;
    return this.inspect();
  }
}

class TestHost implements WorkspaceHost {
  current: Layout;
  readonly events: string[] = [];
  readonly restored: Layout[] = [];
  flushHook: (() => Promise<void>) | undefined;
  restoreHook: ((layout: Layout) => Promise<void>) | undefined;
  allowDiscard = true;
  blocked = 0;
  activeRestores = 0;
  maxRestores = 0;

  constructor(initial: Layout) {
    this.current = structuredClone(initial);
  }
  capture(): Layout {
    return structuredClone(this.current);
  }
  async flush(): Promise<void> {
    this.events.push('flush');
    await this.flushHook?.();
  }
  async quiesce(): Promise<void> {
    this.events.push('quiesce');
    this.current = { main: { type: 'split', children: [] } };
  }
  async waitForFiles(): Promise<void> {
    this.events.push('wait');
  }
  async restore(target: Layout): Promise<void> {
    this.activeRestores += 1;
    this.maxRestores = Math.max(this.maxRestores, this.activeRestores);
    try {
      await this.restoreHook?.(target);
      this.current = structuredClone(target);
      this.restored.push(structuredClone(target));
      this.events.push('restore');
    } finally {
      this.activeRestores -= 1;
    }
  }
  block(): () => void {
    this.blocked += 1;
    return () => {
      this.blocked -= 1;
    };
  }
  async confirmDiscard(): Promise<boolean> {
    this.events.push('confirm-discard');
    return this.allowDiscard;
  }
}

function fixture(
  branches: Array<string | null> = ['alpha', 'beta'],
  options: {
    device?: Device;
    autoSave?: boolean;
    configure?: (state: WorkspaceState, ids: string[]) => void;
  } = {},
) {
  const device = options.device ?? 'desktop';
  const state = emptyState();
  state.autoSave = options.autoSave ?? true;
  const ids = branches.map((branch, index) =>
    addWorkspace(
      state,
      String.fromCharCode(65 + index),
      snapshot(
        layout(String.fromCharCode(65 + index), device),
        device,
        branch ? { root: '/repository', branch } : null,
      ),
    ),
  );
  state.activeId = ids[0]!;
  options.configure?.(state, ids);
  const store = new MemoryStore(state, device === 'desktop' ? '/controls/state.json' : null);
  const host = new TestHost(state.workspaces[ids[0]!]!.contexts[device]!.layout);
  const git = new TestGit(branches[0] ?? 'alpha');
  const controller = new WorkspaceController(state, store, host, git, device);
  return { state, ids, store, host, git, controller };
}

test('same-branch layout switches retain dirty note edits without issuing checkout', async () => {
  const f = fixture(['alpha', 'alpha']);
  f.git.status.dirty = true;
  await f.controller.activate(f.ids[1]!);
  assert.equal(f.controller.state.activeId, f.ids[1]);
  assert.equal(f.git.status.dirty, true);
  assert.deepEqual(f.git.preflights, []);
  assert.deepEqual(f.git.checkouts, []);
  assert.deepEqual(f.host.events, ['flush', 'wait', 'restore']);
  assert.deepEqual(f.host.current, layout('B'));
  assert.equal(f.controller.state.journal, null);
});

test('rapid activations remain serialized while the first restoration is unresolved', async () => {
  const f = fixture(['alpha', 'beta', 'gamma']);
  const started = deferred();
  const finish = deferred();
  f.host.restoreHook = async (target) => {
    if (target.active === 'B-note') {
      started.resolve();
      await finish.promise;
    }
  };
  const first = f.controller.activate(f.ids[1]!);
  const second = f.controller.activate(f.ids[2]!);
  await started.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.git.checkouts, ['beta']);
  assert.equal(f.git.entered, 1);
  assert.equal(f.git.active, 1);
  assert.equal(f.host.activeRestores, 1);
  assert.equal(f.controller.state.activeId, f.ids[0]);
  finish.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.git.checkouts, ['beta', 'gamma']);
  assert.deepEqual(
    f.host.restored.map((value) => value.active),
    ['B-note', 'C-note'],
  );
  assert.equal(f.git.maxActive, 1);
  assert.equal(f.host.maxRestores, 1);
  assert.equal(f.git.active, 0);
  assert.equal(f.controller.state.activeId, f.ids[2]);
  assert.equal(f.controller.busy, null);
});

test('history restores its branch binding and preserves the displaced context for another restoration', async () => {
  const older = snapshot(layout('Older'), 'desktop', { root: '/repository', branch: 'alpha' });
  const f = fixture(['beta'], {
    configure(state, ids) {
      state.workspaces[ids[0]!]!.history.push(older);
    },
  });
  await f.controller.restoreHistory(f.ids[0]!, 0);
  let record = f.controller.state.workspaces[f.ids[0]!]!;
  assert.deepEqual(record.contexts.desktop!.layout, layout('Older'));
  assert.equal(record.contexts.desktop!.binding?.branch, 'alpha');
  assert.deepEqual(record.history[0]!.layout, layout('A'));
  assert.equal(record.history[0]!.binding?.branch, 'beta');
  await f.controller.restoreHistory(f.ids[0]!, 0);
  record = f.controller.state.workspaces[f.ids[0]!]!;
  assert.deepEqual(record.contexts.desktop!.layout, layout('A'));
  assert.equal(record.contexts.desktop!.binding?.branch, 'beta');
  assert.deepEqual(record.history[0]!.layout, layout('Older'));
  assert.equal(record.history[0]!.binding?.branch, 'alpha');
  assert.deepEqual(f.git.checkouts, ['alpha', 'beta']);
});

test('external branch drift blocks saving before the workspace snapshot can be overwritten', async () => {
  const f = fixture();
  f.git.status.branch = 'foreign';
  f.host.current = layout('Unrelated');
  await assert.rejects(f.controller.saveActive(), /active workspace belongs to/);
  assert.deepEqual(f.store.writes, []);
  assert.deepEqual(f.host.events, []);
  assert.deepEqual(f.controller.state.workspaces[f.ids[0]!]!.contexts.desktop!.layout, layout('A'));
});

test('activating the already active workspace still detects external branch drift', async () => {
  const f = fixture();
  f.git.status.branch = 'foreign';
  await assert.rejects(f.controller.activate(f.ids[0]!), /active workspace belongs to/);
  assert.equal(f.git.entered, 1);
  assert.deepEqual(f.git.checkouts, []);
  assert.deepEqual(f.host.events, []);
  assert.deepEqual(f.store.writes, []);
  assert.equal(f.controller.state.activeId, f.ids[0]);
});

test('source validation is repeated after flushing before save and create', async (t) => {
  for (const action of ['save', 'create'] as const) {
    await t.test(action, async () => {
      const f = fixture();
      f.host.flushHook = async () => {
        f.git.status.branch = 'foreign';
        f.host.current = layout('Unrelated');
      };
      await assert.rejects(
        action === 'save' ? f.controller.saveActive() : f.controller.create('Accidental'),
        /active workspace belongs to/,
      );
      assert.deepEqual(f.store.writes, []);
      assert.equal(f.controller.state.order.length, 2);
      assert.deepEqual(
        f.controller.state.workspaces[f.ids[0]!]!.contexts.desktop!.layout,
        layout('A'),
      );
    });
  }
});

test('duplicate preserves metadata and branch/history values without sharing mutable nested objects', async () => {
  const f = fixture(['alpha'], {
    configure(state, ids) {
      const record = state.workspaces[ids[0]!]!;
      Object.assign(record, {
        group: 'Research',
        icon: 'book-open',
        color: '#335577',
        description: 'Pinned research context',
      });
      record.history.push(
        snapshot(layout('Earlier'), 'desktop', { root: '/repository', branch: 'old' }),
      );
    },
  });
  const copyId = await f.controller.duplicate(f.ids[0]!);
  const state = f.controller.state;
  const original = state.workspaces[f.ids[0]!]!;
  const copy = state.workspaces[copyId]!;
  assert.equal(copy.name, 'A copy');
  for (const key of ['group', 'icon', 'color', 'description'] as const)
    assert.equal(copy[key], original[key]);
  assert.deepEqual(copy.contexts, original.contexts);
  assert.deepEqual(copy.history, original.history);
  assert.notStrictEqual(copy.contexts.desktop, original.contexts.desktop);
  assert.notStrictEqual(copy.contexts.desktop!.binding, original.contexts.desktop!.binding);
  assert.notStrictEqual(copy.contexts.desktop!.layout, original.contexts.desktop!.layout);
  assert.notStrictEqual(copy.history[0], original.history[0]);
  copy.contexts.desktop!.binding!.branch = 'mutated';
  copy.history[0]!.layout = layout('Mutated');
  assert.equal(original.contexts.desktop!.binding!.branch, 'alpha');
  assert.deepEqual(original.history[0]!.layout, layout('Earlier'));
  assert.equal(f.controller.state.workspaces[copyId]!.contexts.desktop!.binding!.branch, 'alpha');
  assert.equal(f.controller.state.activeId, f.ids[0]);
});

test('cancelling manual discard also cancels deletion of the active workspace', async () => {
  const f = fixture([null, null], { autoSave: false });
  f.host.current = layout('Unsaved');
  f.host.allowDiscard = false;
  await f.controller.remove(f.ids[0]!);
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.deepEqual(f.controller.state.order, f.ids);
  assert.ok(f.controller.state.workspaces[f.ids[0]!]);
  assert.deepEqual(f.host.current, layout('Unsaved'));
  assert.deepEqual(f.host.events, ['confirm-discard']);
  assert.deepEqual(f.store.writes, []);
});

test('storage failure after checkout retains the durable journal and blocks in-memory mutation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  let fail = true;
  f.store.beforeSave = (next) => {
    if (fail && (next.journal?.phase === 'restoring' || next.journal?.phase === 'recovery'))
      throw new Error('Storage unavailable');
  };
  await assert.rejects(f.controller.activate(f.ids[1]!), /Storage unavailable/);
  assert.equal(f.git.status.branch, 'beta');
  assert.equal((await f.store.load()).journal?.phase, 'checkout');
  assert.equal(f.controller.state.journal?.phase, 'recovery');
  assert.equal(f.controller.state.journal?.originalBranch?.branch, 'alpha');
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.deepEqual(f.host.restored, []);
  assert.equal(f.host.blocked, 0);
  await assert.rejects(f.controller.saveActive(), /needs recovery/);
  await assert.rejects(f.controller.update(f.ids[0]!, { name: 'Unsafe' }), /needs recovery/);
  fail = false;
  await f.controller.recover();
  assert.equal(f.git.status.branch, 'alpha');
  assert.deepEqual(f.host.current, layout('A'));
  assert.equal(f.controller.state.journal, null);
});

test('a committed write with uncertain durability retains a recovery path and correct revision', async () => {
  const f = fixture();
  let fail = true;
  f.store.afterSave = (next) => {
    if (fail && next.activeId === f.ids[1] && next.journal === null) {
      fail = false;
      throw new CommittedWriteError(structuredClone(next), new Error('Directory sync failed'));
    }
  };
  await assert.rejects(f.controller.activate(f.ids[1]!), CommittedWriteError);
  assert.equal(f.git.status.branch, 'beta');
  assert.equal(f.controller.state.journal?.phase, 'recovery');
  assert.equal(f.controller.state.journal?.sourceId, f.ids[0]);
  assert.equal((await f.store.load()).journal?.phase, 'recovery');
  assert.deepEqual(
    f.store.writes.map((state) => state.revision),
    [1, 2, 3, 4, 5],
  );
  await f.controller.recover();
  assert.equal(f.git.status.branch, 'alpha');
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.equal(f.controller.state.journal, null);
});

test('same-workspace history recovery restores the source binding and honors the autosave policy after a committed-write failure', async (t) => {
  for (const autoSave of [true, false]) {
    await t.test(`autoSave=${autoSave}`, async () => {
      const historical = snapshot(layout('Historical'), 'desktop', {
        root: '/repository',
        branch: 'beta',
      });
      const f = fixture(['alpha'], {
        autoSave,
        configure(state, ids) {
          state.workspaces[ids[0]!]!.history.push(historical);
        },
      });
      const id = f.ids[0]!;
      f.host.current = layout('Live');
      let fail = true;
      f.store.afterSave = (next) => {
        if (
          fail &&
          next.journal === null &&
          next.workspaces[id]!.contexts.desktop!.binding?.branch === 'beta'
        ) {
          fail = false;
          throw new CommittedWriteError(
            structuredClone(next),
            new Error('Final directory sync failed'),
          );
        }
      };

      await assert.rejects(f.controller.restoreHistory(id, 0), CommittedWriteError);
      const interrupted = f.controller.state;
      assert.equal(f.git.status.branch, 'beta');
      assert.deepEqual(f.host.current, layout('Historical'));
      assert.equal(interrupted.activeId, id);
      assert.equal(interrupted.journal?.sourceId, id);
      assert.equal(interrupted.journal?.targetId, id);
      assert.equal(interrupted.journal?.phase, 'recovery');
      assert.equal(interrupted.journal?.sourceSaved?.binding?.branch, 'alpha');
      assert.deepEqual(interrupted.journal?.source.layout, layout('Live'));
      assert.deepEqual(interrupted.journal?.sourceSaved?.layout, layout(autoSave ? 'Live' : 'A'));

      await f.controller.recover();
      const recovered = f.controller.state;
      const context = recovered.workspaces[id]!.contexts.desktop!;
      assert.equal(f.git.status.branch, 'alpha');
      assert.deepEqual(f.host.current, layout('Live'));
      assert.equal(recovered.activeId, id);
      assert.equal(recovered.journal, null);
      assert.equal(context.binding?.branch, 'alpha');
      assert.deepEqual(context.layout, layout(autoSave ? 'Live' : 'A'));
      assert.deepEqual((await f.store.load()).workspaces[id]!.contexts.desktop, context);
      assert.ok(
        recovered.workspaces[id]!.history.some(
          (entry) => entry.binding?.branch === 'beta' && entry.layout.active === 'Historical-note',
        ),
      );
      assert.deepEqual(f.git.checkouts, ['beta', 'alpha']);
      // The saved binding now agrees with the restored branch, so ordinary saves
      // must be available again instead of reporting false external branch drift.
      await f.controller.saveActive();
    });
  }
});

test('a committed-write failure while finishing recovery retains a durable journal until a successful retry', async () => {
  const f = fixture();
  f.host.restoreHook = async (target) => {
    if (target.active === 'B-note') throw new Error('Target restoration failed');
  };
  await assert.rejects(f.controller.activate(f.ids[1]!), /Target restoration failed/);
  assert.equal(f.git.status.branch, 'beta');
  f.host.restoreHook = undefined;
  let fail = true;
  f.store.afterSave = (next) => {
    if (fail && next.journal === null && next.activeId === f.ids[0]) {
      fail = false;
      throw new CommittedWriteError(
        structuredClone(next),
        new Error('Recovery directory sync failed'),
      );
    }
  };

  await assert.rejects(f.controller.recover(), CommittedWriteError);
  assert.equal(f.git.status.branch, 'alpha');
  assert.deepEqual(f.host.current, layout('A'));
  assert.equal(f.controller.state.journal?.phase, 'recovery');
  assert.equal(f.controller.state.journal?.originalBranch?.branch, 'alpha');
  const durable = await f.store.load();
  assert.equal(durable.journal?.phase, 'recovery');
  assert.equal(durable.journal?.sourceId, f.ids[0]);
  assert.equal(durable.journal?.targetId, f.ids[1]);
  await assert.rejects(f.controller.saveActive(), /needs recovery/);

  f.controller.dispose();
  const restarted = new WorkspaceController(durable, f.store, f.host, f.git, 'desktop');
  await restarted.recover();
  assert.equal(restarted.state.activeId, f.ids[0]);
  assert.equal(restarted.state.journal, null);
  assert.equal((await f.store.load()).journal, null);
  assert.equal(restarted.state.workspaces[f.ids[0]!]!.contexts.desktop!.binding?.branch, 'alpha');
  assert.deepEqual(f.git.checkouts, ['beta', 'alpha']);
});

test('disposing while waiting for the provider queue prevents all later workspace side effects', async (t) => {
  for (const action of ['save', 'create', 'activate', 'bind', 'recover'] as const) {
    await t.test(action, async () => {
      const f = fixture(['alpha', 'beta'], {
        configure(state, ids) {
          if (action === 'recover') {
            state.journal = {
              sourceId: ids[0]!,
              targetId: ids[1]!,
              source: structuredClone(state.workspaces[ids[0]!]!.contexts.desktop!),
              target: structuredClone(state.workspaces[ids[1]!]!.contexts.desktop!),
              originalBranch: { root: '/repository', branch: 'alpha' },
              phase: 'recovery',
            };
          }
        },
      });
      if (action === 'recover') {
        f.git.status.branch = 'beta';
        f.host.current = layout('B');
      }
      const before = f.controller.state;
      const liveBefore = structuredClone(f.host.current);
      const branchBefore = f.git.status.branch;
      let captures = 0;
      const capture = f.host.capture.bind(f.host);
      f.host.capture = () => {
        captures += 1;
        return capture();
      };
      const queued = deferred();
      const release = deferred();
      const withRepository = f.git.withRepository.bind(f.git);
      f.git.withRepository = async <T>(
        operation: (repository: GitRepository) => Promise<T>,
      ): Promise<T> => {
        queued.resolve();
        await release.promise;
        return withRepository(operation);
      };
      const pending =
        action === 'save'
          ? f.controller.saveActive()
          : action === 'create'
            ? f.controller.create('After unload')
            : action === 'activate'
              ? f.controller.activate(f.ids[1]!)
              : action === 'bind'
                ? f.controller.bindActive()
                : f.controller.recover();
      const rejected = assert.rejects(pending, /unloaded/);
      await queued.promise;
      f.controller.dispose();
      release.resolve();
      await rejected;

      assert.equal(captures, 0);
      assert.deepEqual(f.host.events, []);
      assert.deepEqual(f.host.restored, []);
      assert.equal(f.host.blocked, 0);
      assert.deepEqual(f.host.current, liveBefore);
      assert.deepEqual(f.git.preflights, []);
      assert.deepEqual(f.git.checkouts, []);
      assert.equal(f.git.status.branch, branchBefore);
      assert.deepEqual(f.store.writes, []);
      assert.deepEqual(f.controller.state, before);
      assert.equal(f.controller.busy, null);
    });
  }
});

test('unbound mobile contexts work without Git and a bound import requires explicit unbinding', async () => {
  const f = fixture([null, null], { device: 'mobile' });
  await f.controller.activate(f.ids[1]!);
  await f.controller.saveActive();
  assert.equal(f.git.entered, 0);
  const foreign = emptyState();
  const foreignLayout = layout('Foreign');
  const foreignId = addWorkspace(
    foreign,
    'Foreign',
    snapshot(foreignLayout, 'desktop', { root: '/different-repository', branch: 'foreign' }),
  );
  assert.equal(await f.controller.importJson(JSON.stringify(foreign)), 1);
  await assert.rejects(f.controller.activate(foreignId), /bound to Git.*mobile/);
  assert.equal(f.git.entered, 0);
  assert.equal(f.controller.state.activeId, f.ids[1]);
  await f.controller.unbind(foreignId);
  const unbound = f.controller.state.workspaces[foreignId]!;
  assert.deepEqual(unbound.contexts.desktop!.layout, foreignLayout);
  assert.equal(unbound.contexts.desktop!.binding, null);
  assert.equal(unbound.history[0]!.binding?.branch, 'foreign');
  await f.controller.activate(foreignId);
  assert.equal(f.git.entered, 0);
  assert.deepEqual(f.host.current.main, foreignLayout.main);
  assert.deepEqual(f.host.current.left, layout('B', 'mobile').left);
  assert.equal(f.controller.state.workspaces[foreignId]!.contexts.mobile!.binding, null);
});

test('a confirmed binding cannot follow an earlier queued activation to another identity', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.host.restoreHook = async () => {
    entered.resolve();
    await release.promise;
  };
  const switching = f.controller.activate(f.ids[1]!);
  await entered.promise;
  const binding = assert.rejects(f.controller.bindActive(), /active workspace changed/);
  release.resolve();
  await switching;
  await binding;
  assert.equal(f.git.entered, 1);
  assert.equal(f.controller.state.activeId, f.ids[1]);
});

test('confirmation revisions are checked inside the mutation queue', async (t) => {
  for (const operation of ['delete', 'details', 'unbind'] as const) {
    await t.test(operation, async () => {
      const f = fixture();
      const revision = f.controller.state.revision;
      const earlier = f.controller.update(f.ids[0]!, { name: 'Updated elsewhere' });
      const pending =
        operation === 'delete'
          ? f.controller.remove(f.ids[0]!, revision)
          : operation === 'details'
            ? f.controller.update(f.ids[0]!, { name: 'Stale form' }, revision)
            : f.controller.unbind(f.ids[0]!, revision);
      await earlier;
      await assert.rejects(pending, /changed while this action was pending/);
      assert.equal(f.store.writes.length, 1);
      assert.equal(f.controller.state.workspaces[f.ids[0]!]!.name, 'Updated elsewhere');
      assert.equal(
        f.controller.state.workspaces[f.ids[0]!]!.contexts.desktop!.binding!.branch,
        'alpha',
      );
    });
  }
});

test('history selection retains its snapshot while an earlier save prepends history', async () => {
  const f = fixture(['alpha'], {
    configure(state, ids) {
      state.workspaces[ids[0]!]!.history = [
        snapshot(layout('Chosen'), 'desktop', { root: '/repository', branch: 'alpha' }),
      ];
    },
  });
  const entered = deferred();
  const release = deferred();
  f.host.current = layout('Live');
  f.host.flushHook = async () => {
    entered.resolve();
    await release.promise;
  };
  const saving = f.controller.saveActive();
  await entered.promise;
  const restoring = f.controller.restoreHistory(f.ids[0]!, 0);
  release.resolve();
  await saving;
  await restoring;
  assert.deepEqual(f.host.current, layout('Chosen'));
});

test('a failed recovery write after target replacement keeps valid in-memory source identity', async () => {
  const f = fixture();
  let published = false;
  f.store.afterSave = (next) => {
    if (next.activeId === f.ids[1] && !next.journal) {
      published = true;
      throw new CommittedWriteError(structuredClone(next), new Error('Directory sync failed'));
    }
  };
  f.store.beforeSave = (next) => {
    if (published && next.journal) throw new Error('Storage unavailable');
  };
  await assert.rejects(f.controller.activate(f.ids[1]!), CommittedWriteError);
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.equal(f.controller.state.journal!.sourceId, f.ids[0]);
  assert.doesNotThrow(() => migrateState(JSON.parse(f.controller.exportJson())));
  await assert.rejects(f.controller.saveActive(), /needs recovery/);
  f.store.afterSave = undefined;
  f.store.beforeSave = undefined;
  await f.controller.recover();
  assert.equal(f.git.status.branch, 'alpha');
  assert.equal(f.controller.state.journal, null);
});
