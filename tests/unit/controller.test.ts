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
    assert.equal(
      state.revision,
      this.persisted.revision + 1,
      'writes must advance durable CAS revision once',
    );
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
    await this.assertCanSwitch(branch);
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

test('fresh identity checks retain branch validation without treating identity as clean status', async () => {
  const { controller, git, host, ids } = fixture();
  let identities = 0;
  Object.assign(git, {
    inspectIdentity: async () => {
      identities += 1;
      return { root: git.status.root, branch: git.status.branch };
    },
  });
  host.flushHook = async () => {
    git.status.dirty = true;
  };
  await assert.rejects(controller.activate(ids[1]!), /Uncommitted changes/);
  assert.equal(identities, 2, 'Identity is re-observed after editor flush');
  assert.deepEqual(git.checkouts, []);
  assert.equal(controller.state.journal, null);
  assert.equal(host.events.includes('quiesce'), false);

  host.flushHook = undefined;
  git.status.dirty = false;
  await controller.activate(ids[1]!);
  assert.equal(identities, 5, 'A successful switch also checks identity after restoration');
  assert.equal(controller.state.activeId, ids[1]);
});

test('a complete post-flush preparation replaces only the adjacent cross-branch identity read', async () => {
  const f = fixture();
  const identities: string[] = [];
  let preparations = 0;
  Object.assign(f.git, {
    inspectIdentity: async () => {
      identities.push(f.git.status.branch!);
      return { root: f.git.status.root, branch: f.git.status.branch };
    },
    prepareSwitch: async (branch: string) => {
      preparations += 1;
      assert.equal(f.host.events.at(-1), 'flush');
      assert.equal(f.store.writes.length, 0, 'Preparation precedes the durable journal');
      await f.git.assertCanSwitch(branch);
      return { root: f.git.status.root, branch: f.git.status.branch };
    },
  });
  await f.controller.activate(f.ids[1]!);
  assert.equal(preparations, 1);
  assert.deepEqual(identities, ['alpha', 'beta'], 'Initial and final identity checks remain');
  assert.deepEqual(f.git.preflights, ['beta', 'beta'], 'Checkout still validates after unload');
  assert.equal(f.store.writes.length, 2);
  assert.equal(f.controller.state.activeId, f.ids[1]);
  assert.equal(f.controller.state.journal, null);
});

test('prepared identity rejects source drift before journaling or unload', async (t) => {
  for (const drift of ['branch', 'root'] as const) {
    await t.test(drift, async () => {
      const f = fixture();
      Object.assign(f.git, {
        prepareSwitch: async (branch: string) => {
          await f.git.assertCanSwitch(branch);
          return { root: f.git.status.root, branch: f.git.status.branch };
        },
      });
      f.host.flushHook = async () => {
        if (drift === 'branch') f.git.status.branch = 'external';
        else f.git.status.root = '/external-repository';
      };
      await assert.rejects(
        f.controller.activate(f.ids[1]!),
        drift === 'branch' ? /Git is on “external”/ : /different Git repository/,
      );
      assert.deepEqual(f.git.checkouts, []);
      assert.equal(f.host.events.includes('quiesce'), false);
      assert.equal(f.store.writes.length, 0);
      assert.equal(f.controller.state.activeId, f.ids[0]);
      assert.equal(f.controller.state.journal, null);
      assert.equal(f.host.blocked, 0);
    });
  }
});

test('preparation capability preserves the initial drift check and final unload-time safeguard', async (t) => {
  for (const phase of ['before-flush', 'during-unload'] as const) {
    await t.test(phase, async () => {
      const f = fixture();
      let preparations = 0;
      Object.assign(f.git, {
        prepareSwitch: async (branch: string) => {
          preparations += 1;
          await f.git.assertCanSwitch(branch);
          return { root: f.git.status.root, branch: f.git.status.branch };
        },
      });
      if (phase === 'before-flush') f.git.status.branch = 'external';
      else {
        const quiesce = f.host.quiesce.bind(f.host);
        f.host.quiesce = async () => {
          await quiesce();
          f.git.status.dirty = true;
        };
      }
      await assert.rejects(
        f.controller.activate(f.ids[1]!),
        phase === 'before-flush' ? /Git is on “external”/ : /Uncommitted changes/,
      );
      assert.deepEqual(f.git.checkouts, []);
      assert.equal(f.controller.state.activeId, f.ids[0]);
      if (phase === 'before-flush') {
        assert.equal(preparations, 0);
        assert.deepEqual(f.host.events, []);
        assert.equal(f.store.writes.length, 0);
      } else {
        assert.equal(preparations, 1);
        assert.deepEqual(f.git.preflights, ['beta', 'beta']);
        assert.equal(f.store.writes[0]!.journal?.phase, 'prepared');
        assert.equal(f.controller.state.journal?.phase, 'recovery');
      }
    });
  }
});

test('same-branch and unbound paths do not opt into cross-branch preparation', async (t) => {
  for (const branches of [
    ['alpha', 'alpha'],
    [null, null],
    ['alpha', null],
    [null, 'alpha'],
  ] as const) {
    await t.test(JSON.stringify(branches), async () => {
      const f = fixture([...branches]);
      f.git.status.dirty = true;
      Object.assign(f.git, {
        prepareSwitch: async () => {
          throw new Error('A layout-only activation must not perform a switch preflight');
        },
      });
      await f.controller.activate(f.ids[1]!);
      assert.equal(f.controller.state.activeId, f.ids[1]);
      assert.equal(f.git.status.dirty, true);
      assert.deepEqual(f.git.preflights, []);
      assert.deepEqual(f.git.checkouts, []);
      assert.deepEqual(f.host.events, ['flush', 'wait', 'restore']);
      assert.equal(f.controller.state.journal, null);
    });
  }
});

test('a branch change during flush is rejected by the identity observation before unload', async () => {
  const { controller, git, host, ids } = fixture();
  Object.assign(git, {
    inspectIdentity: async () => ({ root: git.status.root, branch: git.status.branch }),
  });
  host.flushHook = async () => {
    git.status.branch = 'external';
  };
  await assert.rejects(controller.activate(ids[1]!), /Git is on “external”/);
  assert.deepEqual(git.checkouts, []);
  assert.equal(host.events.includes('quiesce'), false);
  assert.equal(controller.state.activeId, ids[0]);
  assert.equal(controller.state.journal, null);
});

test('identity mismatch after native restoration retains recovery rather than completing', async () => {
  const { controller, git, host, ids } = fixture();
  Object.assign(git, {
    inspectIdentity: async () => ({ root: git.status.root, branch: git.status.branch }),
  });
  host.restoreHook = async () => {
    git.status.branch = 'external';
  };
  await assert.rejects(controller.activate(ids[1]!), /Git is on “external”/);
  assert.equal(controller.state.activeId, ids[0]);
  assert.equal(controller.state.journal?.phase, 'recovery');
  assert.equal(git.active, 0);
  assert.equal(host.blocked, 0);
});

test('readiness accelerates only a completed checkout, including explicit recovery', async () => {
  const { controller, git, host, ids } = fixture(['alpha', 'beta', 'alpha', null]);
  const observed: Array<{ branch: string | null; afterCheckout?: boolean }> = [];
  host.waitForFiles = async (
    _target?: Layout,
    _previous?: Layout,
    options?: { afterCheckout?: boolean },
  ) => {
    observed.push({ branch: git.status.branch, afterCheckout: options?.afterCheckout });
  };
  await controller.activate(ids[2]!);
  await controller.activate(ids[3]!);
  await controller.activate(ids[0]!);
  assert.deepEqual(
    observed.map((entry) => entry.afterCheckout),
    [false, false, false],
  );
  host.restoreHook = async () => {
    throw new Error('Native restore failed');
  };
  await assert.rejects(controller.activate(ids[1]!), /Native restore failed/);
  assert.deepEqual(observed.at(-1), { branch: 'beta', afterCheckout: true });
  host.restoreHook = undefined;
  await controller.recover();
  assert.deepEqual(observed.at(-1), { branch: 'alpha', afterCheckout: true });
  assert.equal(controller.state.journal, null);
});

test('a malformed imported workspace ID cannot mutate the catalog or disable saving', async () => {
  const { controller, store, ids, host, git } = fixture([null]);
  const original = controller.state;
  for (const id of ['', '   ']) {
    const incoming = structuredClone(original);
    incoming.workspaces[id] = { ...incoming.workspaces[ids[0]!]!, id };
    incoming.order.push(id);
    incoming.activeId = id;
    await assert.rejects(
      controller.importJson(JSON.stringify(incoming)),
      /Invalid workspace record/,
    );
    assert.deepEqual(controller.state, original);
    assert.deepEqual(await store.load(), original);
    assert.equal(store.writes.length, 0);
    assert.equal(host.restored.length, 0);
    assert.equal(git.entered, 0);
  }
  await controller.saveActive();
  assert.equal(controller.state.activeId, ids[0]);
  assert.equal(store.writes.length, 1);
});

test('save-and-switch saves in manual mode before activating with one mutation owner', async () => {
  const f = fixture(['alpha', 'beta'], { autoSave: false });
  f.host.current = layout('Unsaved source');
  const entered = deferred();
  const release = deferred();
  let first = true;
  f.host.flushHook = async () => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
  };
  const switchToBeta = f.controller.saveAndActivate(f.ids[1]!);
  await entered.promise;
  const returnToAlpha = f.controller.activate(f.ids[0]!);
  release.resolve();
  await Promise.all([switchToBeta, returnToAlpha]);
  assert.deepEqual(f.git.checkouts, ['beta', 'alpha']);
  assert.deepEqual(
    f.controller.state.workspaces[f.ids[0]!]!.contexts.desktop!.layout,
    layout('Unsaved source'),
  );
  assert.deepEqual(f.host.current, layout('Unsaved source'));
  assert.equal(f.host.events.includes('confirm-discard'), false);
});

test('save-and-switch stops on a failed save before attempting activation', async () => {
  const f = fixture();
  f.store.beforeSave = () => {
    throw new Error('Save failed');
  };
  await assert.rejects(f.controller.saveAndActivate(f.ids[1]!), /Save failed/);
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.equal(f.controller.state.journal, null);
  assert.deepEqual(f.git.checkouts, []);
  assert.deepEqual(f.host.restored, []);
});

test('save-and-switch on the active workspace still performs its explicit save', async () => {
  const f = fixture([null], { autoSave: false });
  f.host.current = layout('Changed');
  await f.controller.saveAndActivate(f.ids[0]!);
  assert.equal(f.store.writes.length, 1);
  assert.deepEqual(
    f.controller.state.workspaces[f.ids[0]!]!.contexts.desktop!.layout,
    layout('Changed'),
  );
  assert.deepEqual(f.host.restored, []);
});

test('save-and-switch refuses a source that changed while the request was queued', async () => {
  const f = fixture([null, null]);
  const creation = f.controller.create('New context');
  const request = f.controller.saveAndActivate(f.ids[1]!, f.ids[0]!);
  const createdId = await creation;
  await assert.rejects(request, /active workspace changed/);
  assert.equal(f.controller.state.activeId, createdId);
  assert.equal(f.store.writes.length, 1);
  assert.deepEqual(f.host.restored, []);
});

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

test('transitions durably prepare before side effects and commit completion with two consecutive revisions', async (t) => {
  for (const scenario of [
    { name: 'branch change', branches: ['alpha', 'beta'], device: 'desktop' },
    { name: 'same branch', branches: ['alpha', 'alpha'], device: 'desktop' },
    { name: 'unbound desktop', branches: [null, null], device: 'desktop' },
    { name: 'unbound mobile', branches: [null, null], device: 'mobile' },
  ] as const) {
    await t.test(scenario.name, async () => {
      const f = fixture([...scenario.branches], { device: scenario.device });
      const observed: Array<{ phase: string | null; revision: number; activeId: string | null }> =
        [];
      f.controller.subscribe(() => {
        const state = f.controller.state;
        observed.push({
          phase: state.journal?.phase ?? null,
          revision: state.revision,
          activeId: state.activeId,
        });
      });
      f.store.beforeSave = (next) => {
        if (next.journal) {
          assert.equal(next.journal.phase, 'prepared');
          assert.equal(next.activeId, f.ids[0]);
          assert.deepEqual(f.host.restored, []);
          assert.deepEqual(f.git.checkouts, []);
          assert.equal(f.host.events.includes('quiesce'), false);
        } else {
          assert.equal(next.activeId, f.ids[1]);
          assert.deepEqual(f.host.current, layout('B', scenario.device));
          assert.deepEqual(f.host.restored, [layout('B', scenario.device)]);
          if (scenario.branches[1]) assert.equal(f.git.status.branch, scenario.branches[1]);
        }
      };
      const quiesce = f.host.quiesce.bind(f.host);
      f.host.quiesce = async () => {
        const persisted = await f.store.load();
        assert.equal(persisted.journal?.phase, 'prepared');
        assert.equal(persisted.activeId, f.ids[0]);
        assert.equal(persisted.revision, 1);
        await quiesce();
      };
      const waitForFiles = f.host.waitForFiles.bind(f.host);
      f.host.waitForFiles = async () => {
        const persisted = await f.store.load();
        assert.equal(persisted.journal?.phase, 'prepared');
        assert.equal(persisted.activeId, f.ids[0]);
        assert.equal(persisted.revision, 1);
        assert.equal(f.controller.state.journal?.phase, 'restoring');
        assert.equal(
          f.controller.state.revision,
          1,
          'live phase updates must not advance CAS revision',
        );
        await waitForFiles();
      };
      await f.controller.activate(f.ids[1]!);
      assert.deepEqual(
        f.store.writes.map((state) => [
          state.revision,
          state.journal?.phase ?? null,
          state.activeId,
        ]),
        [
          [1, 'prepared', f.ids[0]],
          [2, null, f.ids[1]],
        ],
      );
      assert.ok(
        observed.some(
          (state) =>
            state.phase === 'restoring' && state.revision === 1 && state.activeId === f.ids[0],
        ),
      );
      assert.equal(
        observed.some((state) => state.phase === 'checkout'),
        scenario.name === 'branch change',
      );
      assert.equal(f.controller.state.revision, 2);
      assert.equal(f.controller.state.journal, null);
      assert.equal((await f.store.load()).journal, null);
      assert.equal(f.host.blocked, 0);
    });
  }
});

test('checkout rejects a view-unload write and retains recovery instead of loading the target', async () => {
  const f = fixture();
  const quiesce = f.host.quiesce.bind(f.host);
  f.host.quiesce = async () => {
    await quiesce();
    f.git.status.dirty = true;
  };
  await assert.rejects(f.controller.activate(f.ids[1]!), /Uncommitted changes/);
  assert.equal(f.git.status.branch, 'alpha');
  assert.deepEqual(f.git.checkouts, []);
  assert.deepEqual(f.host.restored, []);
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.equal(f.controller.state.journal?.phase, 'recovery');
  assert.deepEqual(f.controller.state.journal?.source.layout, layout('A'));
  assert.equal(f.host.blocked, 0);
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

test('readiness failure after checkout with unavailable storage retains the durable journal and blocks mutation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  let fail = true;
  f.store.beforeSave = (next) => {
    if (fail && next.journal?.phase === 'recovery') throw new Error('Storage unavailable');
  };
  const waitForFiles = f.host.waitForFiles.bind(f.host);
  f.host.waitForFiles = async () => {
    if (fail) throw new Error('Vault observation failed');
    await waitForFiles();
  };
  await assert.rejects(f.controller.activate(f.ids[1]!), /Vault observation failed/);
  assert.equal(f.git.status.branch, 'beta');
  assert.equal((await f.store.load()).journal?.phase, 'prepared');
  assert.equal((await f.store.load()).revision, 1);
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

test('a failed final commit leaves the prepared journal durable after target restoration', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  let fail = true;
  f.store.beforeSave = (next) => {
    if (fail && (next.journal === null || next.journal.phase === 'recovery'))
      throw new Error('Storage unavailable');
  };
  await assert.rejects(f.controller.activate(f.ids[1]!), /Storage unavailable/);
  assert.equal(f.git.status.branch, 'beta');
  assert.deepEqual(f.host.current, layout('B'));
  assert.deepEqual(f.host.restored, [layout('B')]);
  const durable = await f.store.load();
  assert.equal(durable.activeId, f.ids[0]);
  assert.equal(durable.revision, 1);
  assert.equal(durable.journal?.phase, 'prepared');
  assert.deepEqual(durable.journal?.source.layout, layout('A'));
  assert.deepEqual(durable.journal?.sourceSaved?.layout, layout('A'));
  assert.deepEqual(durable.journal?.target.layout, layout('B'));
  assert.deepEqual(durable.journal?.originalBranch, { root: '/repository', branch: 'alpha' });
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.equal(f.controller.state.journal?.phase, 'recovery');
  assert.equal(f.host.blocked, 0);
  await assert.rejects(f.controller.saveActive(), /needs recovery/);
  await assert.rejects(f.controller.update(f.ids[0]!, { name: 'Unsafe' }), /needs recovery/);
  fail = false;
  await f.controller.recover();
  assert.equal(f.git.status.branch, 'alpha');
  assert.deepEqual(f.host.current, layout('A'));
  assert.equal(f.controller.state.journal, null);
  assert.deepEqual(
    f.store.writes.map((state) => state.revision),
    [1, 2],
  );
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
    [1, 2, 3],
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
