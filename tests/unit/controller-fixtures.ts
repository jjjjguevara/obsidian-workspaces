import assert from 'node:assert/strict';
import {
  GitBackendError,
  type GitBackend,
  type GitRepository,
  type GitStatus,
} from '../../src/git/backend.ts';
import { type StateStore } from '../../src/storage/store.ts';
import { addWorkspace } from '../../src/workspaces/catalog.ts';
import { WorkspaceController, type WorkspaceHost } from '../../src/workspaces/controller.ts';
import {
  emptyState,
  snapshot,
  type Device,
  type Layout,
  type WorkspaceState,
} from '../../src/workspaces/model.ts';

/** Controllable store, Git backend and host shared by the controller-level tests. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function layout(name: string, device: Device = 'desktop'): Layout {
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

export class MemoryStore implements StateStore {
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

export class TestGit implements GitBackend, GitRepository {
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

export class TestHost implements WorkspaceHost {
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

export function fixture(
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
