import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { App } from 'obsidian';
import {
  NativeCatalogBridge,
  buildProjection,
  formatMtime,
  parseMtime,
  planReconciliation,
} from '../../src/obsidian/native-catalog.ts';
import { importRecords, migrateState } from '../../src/storage/migrations.ts';
import { WorkspaceController } from '../../src/workspaces/controller.ts';
import {
  emptyState,
  type Device,
  type GitBinding,
  type Journal,
  type Layout,
  type WorkspaceState,
} from '../../src/workspaces/model.ts';
import {
  MemoryStore,
  TestGit,
  TestHost,
  deferred,
  fixture,
  layout,
} from './controller-fixtures.ts';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const EARLIER = formatMtime(T0 - 60_000);
const LATER = formatMtime(T0 + 60_000);
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));
/** A core entry: a native layout plus the `mtime` that core adds. */
const entry = (name: string, mtime: string = formatMtime(T0)): Layout => ({
  ...layout(name),
  mtime,
});

/** Core Workspaces 1.15.1 as the bridge sees it. Methods live on the prototype. */
class FakeCore {
  workspaces: Record<string, unknown> = {};
  activeWorkspace = '';
  /** Calls that reached the unwrapped core methods. */
  readonly native: string[] = [];
  /** Each persisted `workspaces.json` body. */
  readonly writes: string[] = [];
  saveError: Error | undefined;
  /** Models a write that reads the list late, after other work ran. */
  saveGate: Promise<void> | undefined;
  onWrite: (() => void) | undefined;
  constructor(private readonly host: TestHost) {}
  saveWorkspace(name: string): void {
    this.native.push(`save:${name}`);
    this.workspaces[name] = { ...this.host.capture(), mtime: formatMtime(Date.now()) };
    void this.saveData();
  }
  setActiveWorkspace(name: string): void {
    this.native.push(`active:${name}`);
    this.activeWorkspace = name;
    void this.saveData();
  }
  async loadWorkspace(name: string): Promise<void> {
    this.native.push(`load:${name}`);
  }
  async deleteWorkspace(name: string): Promise<void> {
    this.native.push(`delete:${name}`);
    delete this.workspaces[name];
    await this.saveData();
  }
  async saveData(): Promise<void> {
    if (this.saveError) throw this.saveError;
    if (this.saveGate) await this.saveGate;
    this.writes.push(JSON.stringify({ workspaces: this.workspaces, active: this.activeWorkspace }));
    this.onWrite?.();
  }
  get file(): { workspaces: Record<string, Layout>; active: string } {
    return JSON.parse(this.writes.at(-1)!);
  }
}

function makeApp(instance: unknown, options: { events?: boolean; enabled?: boolean } = {}) {
  const listeners = new Set<(plugin: unknown) => void>();
  const wrapper = { enabled: options.enabled ?? true, instance };
  const internalPlugins: Record<string, unknown> = { plugins: { workspaces: wrapper } };
  if (options.events ?? true) {
    internalPlugins.on = (name: string, callback: (plugin: unknown) => void) => {
      assert.equal(name, 'change');
      listeners.add(callback);
      return callback;
    };
    internalPlugins.offref = (callback: (plugin: unknown) => void) => listeners.delete(callback);
  }
  return {
    app: { internalPlugins } as unknown as App,
    wrapper,
    listeners,
    toggle(enabled: boolean): void {
      wrapper.enabled = enabled;
      for (const listener of [...listeners]) listener(wrapper);
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
function connect(
  f: Pick<Fixture, 'controller' | 'host' | 'store'>,
  options: { events?: boolean; enabled?: boolean; core?: (core: FakeCore) => void } = {},
) {
  const core = new FakeCore(f.host);
  options.core?.(core);
  const host = makeApp(core, options);
  const notices: string[] = [];
  /** Order of durable writes: the catalog store and the core file. */
  const log: string[] = [];
  f.store.afterSave = () => log.push('state');
  core.onWrite = () => log.push('core');
  const bridge = new NativeCatalogBridge(host.app, f.controller, {
    capture: () => f.host.capture(),
    notify: (message) => notices.push(message),
    delayMs: 0,
  });
  return { core, bridge, notices, log, ...host };
}
/** Two unbound records A (active) and B, already projected to an empty core list. */
async function linked(
  branches: Array<string | null> = [null, null],
  options: Parameters<typeof fixture>[1] = {},
) {
  const f = fixture(branches, options);
  const c = connect(f);
  c.bridge.start();
  await c.bridge.whenSettled();
  return { ...f, ...c };
}
const stored = (f: Pick<Fixture, 'controller'>, id: string, device: Device = 'desktop'): Layout =>
  f.controller.state.workspaces[id]!.contexts[device]!.layout;

// --- Pure projection -------------------------------------------------------

interface Row {
  id: string;
  name: string;
  layout?: Layout;
  savedAt?: number;
  binding?: GitBinding | null;
  device?: Device;
}
function catalog(
  rows: Row[],
  extra: Partial<Pick<WorkspaceState, 'activeId' | 'journal' | 'nativeCatalog'>> = {},
): WorkspaceState {
  const state = emptyState();
  for (const row of rows) {
    const device = row.device ?? 'desktop';
    state.workspaces[row.id] = {
      id: row.id,
      name: row.name,
      group: '',
      icon: 'panels-top-left',
      color: '',
      description: '',
      contexts: {
        [device]: {
          device,
          layout: row.layout ?? layout(row.id, device),
          binding: row.binding ?? null,
          savedAt: row.savedAt ?? T0,
        },
      },
      history: [],
    };
    state.order.push(row.id);
  }
  return { ...state, ...extra };
}

test('core time stamps use the local ISO form that core writes and read back to the second', () => {
  const stamp = formatMtime(T0 + 789);
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(parseMtime(stamp), T0);
  assert.ok(Number.isNaN(parseMtime(undefined)));
  assert.ok(Number.isNaN(parseMtime('not a date')));
});

test('the projection lists catalog records in order with independent layouts and save times', () => {
  const state = catalog(
    [
      { id: 'two', name: 'Second', savedAt: T0 + 5_000 },
      { id: 'one', name: 'First', binding: { root: '/repository', branch: 'alpha' } },
    ],
    { activeId: 'one' },
  );
  const projection = buildProjection(state, 'desktop');
  assert.deepEqual(Object.keys(projection.workspaces), ['Second', 'First']);
  assert.deepEqual(projection.workspaces.Second, {
    ...layout('two'),
    mtime: formatMtime(T0 + 5_000),
  });
  assert.deepEqual(projection.names, { two: 'Second', one: 'First' });
  assert.equal(projection.active, 'First');
  // Core receives its own copy; changing it cannot reach the catalog.
  (projection.workspaces.First!.main as { id: string }).id = 'changed';
  assert.deepEqual(state.workspaces.one!.contexts.desktop!.layout, layout('one'));
  // No binding, history or product metadata leaves the catalog.
  assert.equal(JSON.stringify(projection.workspaces).includes('alpha'), false);
});

test('equal display names get a stable suffix that never takes a real name', () => {
  const state = catalog(
    [
      { id: 'a', name: 'Name' },
      { id: 'b', name: 'Name' },
      { id: 'c', name: 'Name (2)' },
      { id: 'd', name: 'Name' },
      { id: 'e', name: 'Other' },
    ],
    { activeId: 'd' },
  );
  const projection = buildProjection(state, 'desktop');
  assert.deepEqual(projection.names, {
    a: 'Name',
    b: 'Name (3)',
    c: 'Name (2)',
    d: 'Name (4)',
    e: 'Other',
  });
  assert.deepEqual(Object.keys(projection.workspaces), [
    'Name',
    'Name (3)',
    'Name (2)',
    'Name (4)',
    'Other',
  ]);
  assert.equal(projection.active, 'Name (4)');
  assert.deepEqual(buildProjection(state, 'desktop'), projection);
});

test('the projection uses the slot of the current device and reports no active name without one', () => {
  const state = catalog([
    { id: 'phone', name: 'Phone', device: 'mobile' },
    { id: 'desk', name: 'Desk' },
  ]);
  state.workspaces.desk!.contexts.mobile = {
    device: 'mobile',
    layout: layout('desk-mobile', 'mobile'),
    binding: null,
    savedAt: T0 + 1_000,
  };
  const mobile = buildProjection(state, 'mobile');
  assert.deepEqual(mobile.workspaces.Desk, {
    ...layout('desk-mobile', 'mobile'),
    mtime: formatMtime(T0 + 1_000),
  });
  assert.equal(mobile.active, '');
  // A record that has only the other device's layout still appears, with that layout.
  const desktop = buildProjection(state, 'desktop');
  assert.deepEqual(Object.keys(desktop.workspaces), ['Phone', 'Desk']);
  assert.deepEqual(desktop.workspaces.Phone, {
    ...layout('phone', 'mobile'),
    mtime: formatMtime(T0),
  });
  assert.deepEqual(desktop.workspaces.Desk, { ...layout('desk'), mtime: formatMtime(T0) });
});

test('a recovery journal keeps the source workspace as the active core name', () => {
  const state = catalog([
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]);
  const journal = (sourceId: string | null): Journal => ({
    sourceId,
    targetId: 'b',
    source: state.workspaces.a!.contexts.desktop!,
    target: state.workspaces.b!.contexts.desktop!,
    originalBranch: null,
    phase: 'restoring',
  });
  assert.equal(buildProjection({ ...state, activeId: 'b' }, 'desktop').active, 'B');
  assert.equal(
    buildProjection({ ...state, activeId: 'b', journal: journal('a') }, 'desktop').active,
    'A',
  );
  assert.equal(
    buildProjection({ ...state, activeId: 'b', journal: journal(null) }, 'desktop').active,
    '',
  );
});

test('core entries outside the catalog pass through after the catalog entries', () => {
  const state = catalog([{ id: 'a', name: 'A' }]);
  const foreign = { 'mode: Focus': { settings: true }, A: { stale: true } };
  const projection = buildProjection(state, 'desktop', foreign);
  assert.deepEqual(Object.keys(projection.workspaces), ['A', 'mode: Focus']);
  assert.deepEqual(projection.workspaces['mode: Focus'], { settings: true });
  assert.deepEqual(projection.workspaces.A, { ...layout('a'), mtime: formatMtime(T0) });
});

// --- Pure reconciliation ---------------------------------------------------

const summary = (plan: ReturnType<typeof planReconciliation>) => ({
  adopt: plan.adopt.map((item) => item.id),
  add: plan.add.map((record) => record.name),
  remove: plan.remove,
  foreign: plan.foreign,
});
type PlanSummary = ReturnType<typeof summary>;
const none: PlanSummary = { adopt: [], add: [], remove: [], foreign: [] };

const reconciliationCases: Array<{
  name: string;
  state: WorkspaceState;
  core: Record<string, unknown>;
  expected: Partial<PlanSummary>;
}> = [
  {
    name: 'first run with an empty catalog imports every core entry',
    state: catalog([]),
    core: { X: entry('x'), Y: entry('y') },
    expected: { add: ['X', 'Y'] },
  },
  {
    name: 'first run pairs a never-projected record with the one core entry of its name',
    state: catalog([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]),
    core: { A: entry('a'), C: entry('c') },
    // A matches, C is new, and B stays for the projection to add.
    expected: { add: ['C'] },
  },
  {
    name: 'a paired core entry that core saved later replaces the record layout',
    state: catalog([{ id: 'a', name: 'A' }]),
    core: { A: entry('changed', LATER) },
    expected: { adopt: ['a'] },
  },
  {
    name: 'a paired core entry that is older than the record is ignored',
    state: catalog([{ id: 'a', name: 'A' }]),
    core: { A: entry('changed', EARLIER) },
    expected: {},
  },
  {
    name: 'an unchanged projected entry needs nothing',
    state: catalog([{ id: 'a', name: 'A' }], { nativeCatalog: { projected: { a: 'A' } } }),
    core: { A: entry('a') },
    expected: {},
  },
  {
    name: 'a projected entry that core saved later is adopted',
    state: catalog([{ id: 'a', name: 'A' }], { nativeCatalog: { projected: { a: 'A' } } }),
    core: { A: entry('changed', LATER) },
    expected: { adopt: ['a'] },
  },
  {
    name: 'a projected entry older than the record keeps the record (interrupted projection)',
    state: catalog([{ id: 'a', name: 'A' }], { nativeCatalog: { projected: { a: 'A' } } }),
    core: { A: entry('previous', EARLIER) },
    expected: {},
  },
  {
    name: 'a changed entry without a readable time keeps the record',
    state: catalog([{ id: 'a', name: 'A' }], { nativeCatalog: { projected: { a: 'A' } } }),
    core: { A: layout('changed') },
    expected: {},
  },
  {
    name: 'a projected record that core no longer lists was deleted in core',
    state: catalog(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      { activeId: 'a', nativeCatalog: { projected: { a: 'A', b: 'B' } } },
    ),
    core: { B: entry('b') },
    expected: { remove: ['a'] },
  },
  {
    name: 'a record renamed since its projection still owns its old core name',
    state: catalog([{ id: 'a', name: 'Renamed' }], { nativeCatalog: { projected: { a: 'Old' } } }),
    core: { Old: entry('a') },
    expected: {},
  },
  {
    name: 'a core-only entry becomes a new record and unprojected records stay',
    state: catalog(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      { nativeCatalog: { projected: { a: 'A' } } },
    ),
    core: { A: entry('a'), New: entry('new') },
    expected: { add: ['New'] },
  },
  {
    name: 'a name shared by several unprojected records does not establish identity',
    state: catalog([
      { id: 'a', name: 'D' },
      { id: 'b', name: 'D' },
    ]),
    core: { D: entry('a') },
    expected: { add: ['D'] },
  },
  {
    name: 'a projected suffix name belongs to its record and the plain name to the other',
    state: catalog(
      [
        { id: 'a', name: 'D' },
        { id: 'b', name: 'D' },
      ],
      { nativeCatalog: { projected: { a: 'D', b: 'D (2)' } } },
    ),
    core: { 'D (2)': entry('changed', LATER) },
    expected: { adopt: ['b'], remove: ['a'] },
  },
  {
    name: 'modes and malformed entries are left alone',
    state: catalog([]),
    core: {
      'mode: Focus': entry('mode'),
      Broken: { mtime: LATER },
      Unsafe: {
        main: { type: 'leaf', state: { type: 'markdown', state: { file: '/etc/passwd' } } },
      },
      Good: entry('good'),
    },
    expected: { add: ['Good'], foreign: ['mode: Focus', 'Broken', 'Unsafe'] },
  },
  {
    name: 'a record removed before its projection was written does not return',
    state: catalog([{ id: 'a', name: 'A' }], {
      nativeCatalog: { projected: { a: 'A' }, retired: { Gone: T0 } },
    }),
    core: { A: entry('a'), Gone: entry('gone', EARLIER) },
    expected: {},
  },
  {
    name: 'a retired name that core saved again afterwards is a new entry',
    state: catalog([{ id: 'a', name: 'A' }], {
      nativeCatalog: { projected: { a: 'A' }, retired: { Gone: T0 } },
    }),
    core: { A: entry('a'), Gone: entry('gone', LATER) },
    expected: { add: ['Gone'] },
  },
  {
    name: 'an empty core list is a lost file and removes nothing',
    state: catalog(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      { nativeCatalog: { projected: { a: 'A', b: 'B' } } },
    ),
    core: {},
    expected: {},
  },
];

for (const item of reconciliationCases)
  test(`reconciliation: ${item.name}`, () => {
    const before = structuredClone(item.state);
    const plan = planReconciliation(item.state, 'desktop', item.core, T0 + 120_000);
    assert.deepEqual(summary(plan), { ...none, ...item.expected });
    assert.deepEqual(item.state, before, 'planning must not change the catalog');
  });

test('reconciliation converts entries with the explicit core import rules', () => {
  const source = entry('draft', LATER);
  (
    source.main as { children: Array<{ children: Array<{ state: { state: object } }> }> }
  ).children[0]!.children[0]!.state.state = {};
  source['workspaces-plus:settings-v1'] = {
    icon: 'pen',
    iconColor: '#123456',
    description: 'Drafting',
    trackedFiles: { 'draft-note': 'Drafts/Tracked.md' },
  };
  const plan = planReconciliation(
    catalog([{ id: 'a', name: 'A' }]),
    'desktop',
    { Draft: source, A: { ...entry('a-new', LATER) } },
    T0,
  );
  const [record] = plan.add;
  assert.equal(record!.name, 'Draft');
  assert.equal(record!.icon, 'pen');
  assert.equal(record!.color, '#123456');
  assert.equal(record!.description, 'Drafting');
  const context = record!.contexts.desktop!;
  assert.equal(context.binding, null);
  assert.equal(context.savedAt, parseMtime(LATER));
  assert.equal(Object.hasOwn(context.layout, 'mtime'), false);
  assert.equal(Object.hasOwn(context.layout, 'workspaces-plus:settings-v1'), false);
  assert.match(JSON.stringify(context.layout), /Drafts\/Tracked\.md/);
  assert.deepEqual(record!.history, []);
  // The adopted layout carries core's save time and no `mtime` key of its own.
  assert.deepEqual(plan.adopt, [{ id: 'a', layout: layout('a-new'), savedAt: parseMtime(LATER) }]);
});

// --- Routing ---------------------------------------------------------------

test('first start projects a never-projected catalog and then records the baseline', async () => {
  const f = fixture([null, null]);
  const c = connect(f);
  c.bridge.start();
  assert.equal(c.bridge.active, true);
  assert.deepEqual(c.core.workspaces, {}, 'attaching alone changes nothing');
  assert.equal(f.controller.state.nativeCatalog, undefined);
  await c.bridge.whenSettled();
  assert.deepEqual(Object.keys(c.core.workspaces), ['A', 'B']);
  assert.equal(c.core.activeWorkspace, 'A');
  assert.deepEqual(c.core.file, { workspaces: c.core.workspaces, active: 'A' });
  assert.deepEqual(c.core.file.workspaces.B, {
    ...layout('B'),
    mtime: formatMtime(f.state.workspaces[f.ids[1]!]!.contexts.desktop!.savedAt),
  });
  // The baseline lags: one core write, then one catalog commit that names it.
  assert.deepEqual(c.log, ['core', 'state']);
  assert.deepEqual(f.controller.state.nativeCatalog, {
    projected: { [f.ids[0]!]: 'A', [f.ids[1]!]: 'B' },
  });
  assert.deepEqual(c.notices, []);
  assert.equal(f.git.entered, 0);
  assert.deepEqual(f.host.restored, []);
});

test('a core load activates the mapped record through the controller', async () => {
  const f = await linked();
  const writes = f.core.writes.length;
  await f.core.loadWorkspace('B');
  // The promise that core awaits settles after the commit and the projection.
  assert.equal(f.controller.state.activeId, f.ids[1]);
  assert.equal(f.core.activeWorkspace, 'B');
  assert.equal(f.core.file.active, 'B');
  assert.deepEqual(f.host.restored, [layout('B')]);
  assert.deepEqual(f.core.native, [], 'core must not restore a layout itself');
  await f.bridge.whenSettled();
  assert.equal(f.core.writes.length, writes + 1);
  assert.deepEqual(f.notices, []);
});

test('a core load of a bound workspace checks out its branch first', async () => {
  const f = await linked(['alpha', 'beta']);
  await f.core.loadWorkspace('B');
  assert.deepEqual(f.git.checkouts, ['beta']);
  assert.equal(f.controller.state.activeId, f.ids[1]);
  assert.equal(f.core.activeWorkspace, 'B');
  f.git.status.dirty = true;
  await f.core.loadWorkspace('A');
  assert.match(f.notices.at(-1)!, /Uncommitted changes/);
  assert.equal(f.controller.state.activeId, f.ids[1]);
  assert.equal(f.core.activeWorkspace, 'B');
  assert.deepEqual(f.core.native, []);
});

test('a core delete removes the record and the list is current when core renders it', async () => {
  const f = await linked();
  await f.core.deleteWorkspace('B');
  assert.deepEqual(Object.keys(f.controller.state.workspaces), [f.ids[0]]);
  assert.deepEqual(Object.keys(f.core.workspaces), ['A']);
  assert.deepEqual(Object.keys(f.core.file.workspaces), ['A']);
  assert.deepEqual(f.host.restored, []);
  await f.bridge.whenSettled();
  assert.deepEqual(f.controller.state.nativeCatalog, { projected: { [f.ids[0]!]: 'A' } });
  assert.deepEqual(f.core.native, []);
});

test('a core delete of the active workspace opens the replacement like the product does', async () => {
  const f = await linked();
  await f.core.deleteWorkspace('A');
  assert.deepEqual(f.host.restored, [layout('B')]);
  assert.equal(f.controller.state.activeId, f.ids[1]);
  assert.deepEqual(Object.keys(f.core.workspaces), ['B']);
  assert.equal(f.core.activeWorkspace, 'B');
  // The last record has no replacement: the notes stay open with no active workspace.
  await f.core.deleteWorkspace('B');
  assert.equal(f.controller.state.activeId, null);
  assert.deepEqual(f.controller.state.order, []);
  assert.deepEqual(f.core.workspaces, {});
  assert.equal(f.core.activeWorkspace, '');
  assert.deepEqual(f.host.restored, [layout('B')]);
});

test('a core save of the active name saves the active workspace', async () => {
  const f = await linked();
  f.host.current = layout('A-edited');
  f.core.saveWorkspace('A');
  f.core.setActiveWorkspace('A');
  // Core renders its list now, before the controller has run.
  assert.deepEqual(
    { ...(f.core.workspaces.A as Layout), mtime: undefined },
    {
      ...layout('A-edited'),
      mtime: undefined,
    },
  );
  assert.equal(f.core.activeWorkspace, 'A');
  await f.bridge.whenSettled();
  const record = f.controller.state.workspaces[f.ids[0]!]!;
  assert.deepEqual(record.contexts.desktop!.layout, layout('A-edited'));
  assert.deepEqual(record.history[0]!.layout, layout('A'));
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.deepEqual(f.core.file.workspaces.A, {
    ...layout('A-edited'),
    mtime: formatMtime(record.contexts.desktop!.savedAt),
  });
  assert.deepEqual(f.core.native, []);
  assert.deepEqual(f.notices, []);
});

test('a core save of a new name creates a record, shown at once and confirmed afterwards', async () => {
  const f = await linked();
  f.host.current = layout('C');
  f.core.saveWorkspace('C');
  f.core.setActiveWorkspace('C');
  assert.deepEqual(Object.keys(f.core.workspaces), ['A', 'B', 'C']);
  assert.equal(f.core.activeWorkspace, 'C');
  const writes = f.core.writes.length;
  await f.bridge.whenSettled();
  const state = f.controller.state;
  const id = state.order[2]!;
  assert.equal(state.workspaces[id]!.name, 'C');
  assert.equal(state.activeId, id);
  assert.deepEqual(stored(f, id), layout('C'));
  assert.equal(f.core.writes.length, writes + 1);
  assert.deepEqual(Object.keys(f.core.file.workspaces), ['A', 'B', 'C']);
  assert.equal(f.core.file.active, 'C');
  assert.equal(state.nativeCatalog!.projected[id], 'C');
  await f.core.loadWorkspace('C');
  assert.deepEqual(f.notices, []);
});

test('core requests run in order: two quick saves of a new name create one record', async () => {
  const f = await linked();
  f.host.current = layout('C');
  f.core.saveWorkspace('C');
  f.core.setActiveWorkspace('C');
  f.host.current = layout('C-again');
  f.core.saveWorkspace('C');
  // Core's save-and-load shortcut: save the active name, then load another one.
  const loaded = f.core.loadWorkspace('B');
  assert.equal(f.controller.state.order.length, 2, 'nothing has run yet');
  await loaded;
  const state = f.controller.state;
  assert.deepEqual(
    state.order.map((id) => state.workspaces[id]!.name),
    ['A', 'B', 'C'],
  );
  assert.deepEqual(stored(f, state.order[2]!), layout('C-again'));
  assert.equal(state.activeId, f.ids[1]);
  assert.deepEqual(Object.keys(f.core.workspaces), ['A', 'B', 'C']);
  assert.equal(f.core.activeWorkspace, 'B');
  assert.deepEqual(f.notices, []);
});

test('a core save over another unbound workspace stores the live layout there and makes it active', async () => {
  const f = await linked();
  f.host.current = layout('Live');
  f.core.saveWorkspace('B');
  f.core.setActiveWorkspace('B');
  assert.equal(f.core.activeWorkspace, 'B');
  await f.bridge.whenSettled();
  const state = f.controller.state;
  assert.equal(state.activeId, f.ids[1]);
  assert.deepEqual(stored(f, f.ids[1]!), layout('Live'));
  assert.deepEqual(state.workspaces[f.ids[1]!]!.history[0]!.layout, layout('B'));
  // Save on switch keeps the outgoing layout, as it does for a created workspace.
  assert.deepEqual(stored(f, f.ids[0]!), layout('Live'));
  assert.deepEqual(f.host.restored, [], 'no layout is restored for a save');
  assert.equal(f.git.entered, 0);
  assert.equal(f.core.file.active, 'B');
  assert.deepEqual(f.notices, []);
});

test('manual save mode leaves the outgoing workspace unchanged when core saves over another one', async () => {
  const f = await linked([null, null], { autoSave: false });
  f.host.current = layout('Live');
  await f.controller.saveCurrentTo(f.ids[1]!);
  assert.deepEqual(stored(f, f.ids[0]!), layout('A'));
  assert.deepEqual(stored(f, f.ids[1]!), layout('Live'));
  assert.equal(f.controller.state.activeId, f.ids[1]);
});

for (const [title, branches] of [
  ['the active workspace is bound', ['alpha', null]],
  ['the target workspace is bound', [null, 'beta']],
] as const)
  test(`a core save over another workspace is rejected when ${title}`, async () => {
    const f = await linked([...branches]);
    const before = f.controller.state;
    const writes = f.core.writes.length;
    f.host.current = layout('Live');
    f.core.saveWorkspace('B');
    f.core.setActiveWorkspace('B');
    assert.deepEqual((f.core.workspaces.B as Layout).main, layout('Live').main);
    await f.bridge.whenSettled();
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0]!, /Activate “B” first, then save it\./);
    assert.deepEqual(f.controller.state, before);
    // The optimistic entry and active name are corrected in memory. The file never changed.
    assert.deepEqual((f.core.workspaces.B as Layout).main, layout('B').main);
    assert.equal(f.core.activeWorkspace, 'A');
    assert.equal(f.core.writes.length, writes);
    assert.equal(f.git.checkouts.length, 0);
  });

test('a failed core save withdraws its optimistic entry and reports the controller error', async () => {
  const f = await linked();
  const writes = f.core.writes.length;
  f.store.beforeSave = () => {
    throw new Error('The control store is unavailable.');
  };
  f.core.saveWorkspace('C');
  f.core.setActiveWorkspace('C');
  assert.ok(Object.hasOwn(f.core.workspaces, 'C'));
  await f.bridge.whenSettled();
  assert.deepEqual(f.notices, ['The control store is unavailable.']);
  assert.deepEqual(Object.keys(f.core.workspaces), ['A', 'B']);
  assert.equal(f.core.activeWorkspace, 'A');
  assert.equal(f.core.writes.length, writes);
  assert.equal(f.controller.state.order.length, 2);
});

test('an unknown core name is reported and never reaches core or a layout restore', async () => {
  const f = await linked();
  const writes = f.core.writes.length;
  await f.core.loadWorkspace('Missing');
  await f.core.deleteWorkspace('Missing');
  await (f.core.loadWorkspace as (name: unknown) => Promise<void>)(undefined);
  assert.equal(f.notices.length, 3);
  for (const notice of f.notices)
    assert.match(notice, /is not a workspace in the Workspaces catalog/);
  f.core.setActiveWorkspace('B');
  await f.bridge.whenSettled();
  assert.equal(f.core.activeWorkspace, 'A', 'the active name follows the controller');
  assert.deepEqual(f.core.native, []);
  assert.deepEqual(f.host.restored, []);
  assert.equal(f.core.writes.length, writes);
  assert.equal(f.controller.state.order.length, 2);
});

// --- Projection writes -----------------------------------------------------

test('a catalog change that the core list does not show writes nothing', async () => {
  const f = await linked();
  const writes = f.core.writes.length;
  const commits = f.store.writes.length;
  await f.controller.setAutoSave(false);
  await f.controller.update(f.ids[0]!, { description: 'Not part of the core list' });
  await f.bridge.whenSettled();
  assert.equal(f.core.writes.length, writes);
  assert.equal(f.store.writes.length, commits + 2, 'no baseline commit either');
});

test('an ordinary switch writes the core list once and never the baseline', async () => {
  const f = await linked();
  const writes = f.core.writes.length;
  const commits = f.store.writes.length;
  await f.controller.activate(f.ids[1]!);
  await f.bridge.whenSettled();
  assert.equal(f.core.writes.length, writes + 1);
  assert.equal(f.core.file.active, 'B');
  assert.equal(f.store.writes.length, commits + 2, 'the prepared journal and the completion only');
});

test('projection waits for an idle controller and never runs inside an operation', async () => {
  const f = await linked();
  const writes = f.core.writes.length;
  const gate = deferred();
  f.host.restoreHook = () => gate.promise;
  // Save on switch commits a changed source layout while the operation still runs.
  f.host.current = layout('A-edited');
  const switching = f.controller.activate(f.ids[1]!);
  for (let index = 0; index < 5; index += 1) await turn();
  assert.equal(f.controller.busy, 'Switching workspace');
  assert.deepEqual(stored(f, f.ids[0]!), layout('A-edited'));
  assert.equal(f.core.writes.length, writes);
  assert.deepEqual((f.core.workspaces.A as Layout).main, layout('A').main);
  assert.equal(f.core.activeWorkspace, 'A');
  let settledBeforeProjection = false;
  void switching.then(() => {
    settledBeforeProjection = f.core.activeWorkspace === 'A' && f.core.writes.length === writes;
  });
  gate.resolve();
  await switching;
  assert.equal(settledBeforeProjection, true, 'the caller sees settlement before any projection');
  await f.bridge.whenSettled();
  assert.equal(f.core.activeWorkspace, 'B');
  assert.equal(f.core.writes.length, writes + 1);
});

test('product-side create, rename and delete reach the core list and the baseline lags each write', async () => {
  const f = await linked();
  f.log.length = 0;
  const id = await f.controller.create('C');
  assert.equal(Object.hasOwn(f.controller.state.nativeCatalog!.projected, id), false);
  assert.deepEqual(Object.keys(f.core.workspaces), ['A', 'B']);
  await f.bridge.whenSettled();
  assert.deepEqual(f.log, ['state', 'core', 'state']);
  assert.equal(f.controller.state.nativeCatalog!.projected[id], 'C');
  await f.controller.update(id, { name: 'B' });
  await f.bridge.whenSettled();
  assert.deepEqual(Object.keys(f.core.file.workspaces), ['A', 'B', 'B (2)']);
  assert.equal(f.core.file.active, 'B (2)');
  assert.equal(f.controller.state.nativeCatalog!.projected[id], 'B (2)');
  // The suffixed core name still routes to its own record.
  await f.core.loadWorkspace('B');
  assert.equal(f.controller.state.activeId, f.ids[1]);
  await f.core.deleteWorkspace('B (2)');
  assert.deepEqual(f.controller.state.order, f.ids);
  await f.controller.remove(f.ids[0]!);
  await f.bridge.whenSettled();
  assert.deepEqual(Object.keys(f.core.file.workspaces), ['B']);
  assert.deepEqual(f.controller.state.nativeCatalog, { projected: { [f.ids[1]!]: 'B' } });
});

test('a failed core write is retried and the baseline waits for the confirmed write', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture([null, null]);
  const c = connect(f, {
    core: (core) => {
      core.saveError = new Error('The disk is full.');
    },
  });
  c.bridge.start();
  await c.bridge.whenSettled();
  assert.deepEqual(c.notices, [
    'Workspaces could not update the core Workspaces list: The disk is full.',
  ]);
  assert.equal(f.controller.state.nativeCatalog, undefined);
  assert.deepEqual(c.log, []);
  c.core.saveError = undefined;
  await f.controller.setAutoSave(false);
  await c.bridge.whenSettled();
  assert.deepEqual(c.log, ['state', 'core', 'state']);
  assert.deepEqual(Object.keys(c.core.file.workspaces), ['A', 'B']);
  assert.deepEqual(Object.keys(f.controller.state.nativeCatalog!.projected), f.ids);
});

test('a core request made during a projection write does not let the baseline lead', async () => {
  const f = fixture([null, null]);
  const c = connect(f);
  const gate = deferred();
  c.core.saveGate = gate.promise;
  c.bridge.start();
  for (let index = 0; index < 5; index += 1) await turn();
  assert.deepEqual(Object.keys(c.core.workspaces), ['A', 'B'], 'the first write is in flight');
  f.host.current = layout('C');
  c.core.saveWorkspace('C');
  c.core.saveGate = undefined;
  gate.resolve();
  await c.bridge.whenSettled();
  const state = f.controller.state;
  // The late write held the pending entry, so it confirmed nothing. The next write did.
  assert.deepEqual(Object.keys(c.core.file.workspaces), ['A', 'B', 'C']);
  assert.deepEqual(c.core.file, { workspaces: c.core.workspaces, active: 'C' });
  assert.deepEqual(Object.keys(state.nativeCatalog!.projected), state.order);
  assert.deepEqual(c.log, ['core', 'state', 'core', 'state']);
  assert.deepEqual(c.notices, []);
});

// --- Reconciliation through the controller ---------------------------------

test('first start with an empty catalog imports the core list in one commit and leaves core as it is', async () => {
  const state = emptyState();
  const store = new MemoryStore(state, '/controls/state.json');
  const host = new TestHost(layout('Live'));
  const git = new TestGit();
  const controller = new WorkspaceController(state, store, host, git, 'desktop');
  const c = connect(
    { controller, host, store },
    {
      core: (core) => {
        core.workspaces = { X: entry('x'), 'mode: Focus': entry('mode'), Y: entry('y', LATER) };
        core.activeWorkspace = 'Y';
      },
    },
  );
  c.bridge.start();
  await c.bridge.whenSettled();
  const next = controller.state;
  assert.deepEqual(
    next.order.map((id) => next.workspaces[id]!.name),
    ['X', 'Y'],
  );
  assert.equal(next.activeId, null, 'the core active name does not activate anything');
  assert.deepEqual(next.workspaces[next.order[1]!]!.contexts.desktop, {
    device: 'desktop',
    layout: layout('y'),
    binding: null,
    savedAt: parseMtime(LATER),
  });
  assert.equal(store.writes[0]!.order.length, 2, 'one commit holds the whole import');
  assert.deepEqual(c.notices, ['Workspaces matched the core Workspaces list: 2 imported.']);
  // Entries keep their content; the mode entry moves after the catalog entries.
  assert.deepEqual(c.core.file.workspaces, {
    X: entry('x'),
    Y: entry('y', LATER),
    'mode: Focus': entry('mode'),
  });
  assert.equal(c.core.file.active, '');
  assert.deepEqual(next.nativeCatalog, {
    projected: { [next.order[0]!]: 'X', [next.order[1]!]: 'Y' },
  });
  assert.deepEqual(host.restored, []);
  assert.equal(git.entered, 0);
  // A mode entry is not a workspace. Core can still delete it.
  await c.core.loadWorkspace('mode: Focus');
  assert.match(c.notices.at(-1)!, /is not a workspace in the Workspaces catalog/);
  await c.core.deleteWorkspace('mode: Focus');
  assert.deepEqual(Object.keys(c.core.file.workspaces), ['X', 'Y']);
  assert.equal(controller.state.order.length, 2);
});

test('an import that matches the loaded core list needs no core write before the baseline', async () => {
  const state = emptyState();
  const store = new MemoryStore(state, '/controls/state.json');
  const host = new TestHost(layout('Live'));
  const controller = new WorkspaceController(state, store, host, new TestGit(), 'desktop');
  const c = connect(
    { controller, host, store },
    {
      core: (core) => {
        core.workspaces = { X: entry('x') };
      },
    },
  );
  c.bridge.start();
  await c.bridge.whenSettled();
  assert.deepEqual(c.core.writes, []);
  assert.deepEqual(c.log, ['state', 'state']);
  assert.deepEqual(Object.values(controller.state.nativeCatalog!.projected), ['X']);
});

test('a deletion made in core while the plugin was off removes the record without a transition', async () => {
  const f = fixture([null, null], {
    configure: (state, ids) => {
      state.nativeCatalog = { projected: { [ids[0]!]: 'A', [ids[1]!]: 'B' } };
    },
  });
  const projected = buildProjection(f.state, 'desktop');
  const c = connect(f, {
    core: (core) => {
      core.workspaces = { B: projected.workspaces.B };
      core.activeWorkspace = 'B';
    },
  });
  c.bridge.start();
  await c.bridge.whenSettled();
  const state = f.controller.state;
  assert.deepEqual(state.order, [f.ids[1]]);
  assert.equal(state.activeId, null, 'the deleted active record leaves no active workspace');
  assert.equal(f.store.writes.length, 1, 'one commit; the baseline already matches');
  assert.deepEqual(state.nativeCatalog, { projected: { [f.ids[1]!]: 'B' } });
  assert.deepEqual(f.host.restored, []);
  assert.deepEqual(f.host.events, []);
  assert.equal(f.git.entered, 0);
  assert.equal(c.core.activeWorkspace, '');
  assert.deepEqual(c.notices, ['Workspaces matched the core Workspaces list: 1 removed.']);
});

test('a layout that core saved later is adopted with the binding kept and the old layout in history', async () => {
  const f = fixture(['alpha', null], {
    configure: (state, ids) => {
      state.nativeCatalog = { projected: { [ids[0]!]: 'A', [ids[1]!]: 'B' } };
    },
  });
  const projected = buildProjection(f.state, 'desktop');
  const future = formatMtime(Date.now() + 120_000);
  const c = connect(f, {
    core: (core) => {
      core.workspaces = {
        A: { ...layout('A-core'), mtime: future },
        // An older differing entry is what an interrupted projection leaves behind.
        B: { ...layout('B-stale'), mtime: formatMtime(Date.now() - 120_000) },
      };
      core.activeWorkspace = 'A';
    },
  });
  c.bridge.start();
  await c.bridge.whenSettled();
  const record = f.controller.state.workspaces[f.ids[0]!]!;
  assert.deepEqual(record.contexts.desktop, {
    device: 'desktop',
    layout: layout('A-core'),
    binding: { root: '/repository', branch: 'alpha' },
    savedAt: parseMtime(future),
  });
  assert.deepEqual(record.history[0]!.layout, layout('A'));
  assert.deepEqual(record.history[0]!.binding, { root: '/repository', branch: 'alpha' });
  assert.deepEqual(stored(f, f.ids[1]!), layout('B'), 'the catalog wins over an older core entry');
  assert.deepEqual(c.core.file.workspaces.B, projected.workspaces.B);
  assert.deepEqual(c.core.file.workspaces.A, { ...layout('A-core'), mtime: future });
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.equal(f.git.entered, 0);
  assert.deepEqual(f.host.restored, []);
  assert.deepEqual(c.notices, ['Workspaces matched the core Workspaces list: 1 updated.']);
});

test('reconciliation waits for recovery and core requests are refused until then', async () => {
  const f = fixture([null, null], {
    configure: (state, ids) => {
      const source = state.workspaces[ids[0]!]!.contexts.desktop!;
      state.journal = {
        sourceId: ids[0]!,
        targetId: ids[1]!,
        source,
        sourceSaved: source,
        target: state.workspaces[ids[1]!]!.contexts.desktop!,
        originalBranch: null,
        phase: 'recovery',
        error: 'Interrupted',
      };
    },
  });
  const c = connect(f, {
    core: (core) => {
      core.workspaces = { 'Core only': entry('core-only') };
    },
  });
  c.bridge.start();
  await c.bridge.whenSettled();
  assert.deepEqual(Object.keys(c.core.workspaces), ['Core only']);
  assert.deepEqual(c.core.writes, []);
  assert.equal(f.store.writes.length, 0);
  c.core.saveWorkspace('Draft');
  assert.ok(Object.hasOwn(c.core.workspaces, 'Draft'));
  await c.core.loadWorkspace('Core only');
  await c.bridge.whenSettled();
  assert.equal(c.notices.length, 2);
  for (const notice of c.notices) assert.match(notice, /Recover interrupted switch/);
  assert.deepEqual(Object.keys(c.core.workspaces), ['Core only'], 'the pending entry is withdrawn');
  assert.deepEqual(c.core.native, []);
  assert.deepEqual(c.core.writes, []);
  await f.controller.recover();
  await c.bridge.whenSettled();
  assert.deepEqual(Object.keys(c.core.file.workspaces), ['A', 'B', 'Core only']);
  assert.equal(c.core.file.active, 'A');
  assert.equal(f.controller.state.order.length, 3);
});

test('a failed switch projects the recovery source as the active core name', async () => {
  const f = await linked();
  f.host.restoreHook = async () => {
    throw new Error('Restore failed.');
  };
  await f.core.loadWorkspace('B');
  assert.match(f.notices[0]!, /Restore failed\./);
  assert.ok(f.controller.state.journal);
  await f.bridge.whenSettled();
  assert.equal(f.core.activeWorkspace, 'A');
  assert.deepEqual(Object.keys(f.core.workspaces), ['A', 'B']);
});

test('a record deleted in the product while core is disabled does not return when core is enabled', async () => {
  const f = await linked();
  f.toggle(false);
  assert.equal(f.bridge.active, false);
  const writes = f.core.writes.length;
  await f.controller.remove(f.ids[1]!);
  await f.controller.create('C');
  await f.bridge.whenSettled();
  assert.equal(f.core.writes.length, writes, 'a disabled core list is not written');
  assert.equal(typeof f.controller.state.nativeCatalog!.retired!.B, 'number');
  f.toggle(true);
  await f.bridge.whenSettled();
  const state = f.controller.state;
  assert.deepEqual(
    state.order.map((id) => state.workspaces[id]!.name),
    ['A', 'C'],
  );
  assert.deepEqual(Object.keys(f.core.file.workspaces), ['A', 'C']);
  assert.deepEqual(Object.keys(state.nativeCatalog!.projected), state.order);
  assert.equal(state.nativeCatalog!.retired, undefined);
  assert.deepEqual(f.notices, []);
});

// --- Lifecycle and compatibility -------------------------------------------

test('disposal restores the core methods and keeps the last projected file', async () => {
  const f = await linked();
  for (const key of ['loadWorkspace', 'deleteWorkspace', 'saveWorkspace', 'setActiveWorkspace'])
    assert.ok(Object.hasOwn(f.core, key), `${key} is routed while attached`);
  assert.equal(Object.hasOwn(f.core, 'saveData'), false, 'persistence is not wrapped');
  const writes = f.core.writes.length;
  const file = f.core.writes.at(-1);
  f.core.saveWorkspace('Pending');
  f.core.setActiveWorkspace('Pending');
  // Unload order of the plugin: the bridge first, then the controller.
  f.bridge.dispose();
  f.controller.dispose();
  assert.equal(f.bridge.active, false);
  for (const key of ['loadWorkspace', 'deleteWorkspace', 'saveWorkspace', 'setActiveWorkspace'])
    assert.equal(Object.hasOwn(f.core, key), false, `${key} is the core method again`);
  assert.equal(f.listeners.size, 0);
  // The unsaved optimistic entry is withdrawn; nothing is written on the way out.
  assert.deepEqual(Object.keys(f.core.workspaces), ['A', 'B']);
  assert.equal(f.core.activeWorkspace, 'A');
  await f.bridge.whenSettled();
  await turn();
  assert.deepEqual(f.notices, []);
  assert.deepEqual(Object.keys(f.core.workspaces), ['A', 'B']);
  assert.equal(f.core.writes.length, writes);
  assert.equal(f.core.writes.at(-1), file);
  await f.core.loadWorkspace('B');
  assert.deepEqual(f.core.native, ['load:B']);
  assert.equal(f.controller.state.activeId, f.ids[0]);
  assert.equal(f.controller.state.order.length, 2);
});

test('disposal does not clobber a wrapper that another plugin installed later', async () => {
  const f = await linked();
  const ours = f.core.loadWorkspace;
  const later = function (this: FakeCore, name: string): Promise<void> {
    return ours.call(this, name);
  };
  f.core.loadWorkspace = later;
  f.bridge.dispose();
  assert.equal(f.core.loadWorkspace, later);
  assert.equal(Object.hasOwn(f.core, 'deleteWorkspace'), false);
  // The stale inner wrapper passes the call to core instead of the disposed bridge.
  await f.core.loadWorkspace('B');
  assert.deepEqual(f.core.native, ['load:B']);
  assert.deepEqual(f.host.restored, []);
});

test('an unsupported core shape is left untouched with one notice', async () => {
  const f = fixture([null, null]);
  const core = {
    workspaces: { Kept: entry('kept') },
    activeWorkspace: 'Kept',
    saves: 0,
    saveWorkspace(): void {},
    setActiveWorkspace(): void {},
    async loadWorkspace(): Promise<void> {},
    // deleteWorkspace is missing in this version.
    async saveData(): Promise<void> {
      this.saves += 1;
    },
  };
  const before = structuredClone(core.workspaces);
  const host = makeApp(core);
  const notices: string[] = [];
  const bridge = new NativeCatalogBridge(host.app, f.controller, {
    capture: () => f.host.capture(),
    notify: (message) => notices.push(message),
    delayMs: 0,
  });
  const descriptors = Object.getOwnPropertyDescriptors(core);
  bridge.start();
  host.toggle(true);
  await f.controller.setAutoSave(false);
  await bridge.whenSettled();
  assert.equal(bridge.active, false);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Core Workspaces integration is unavailable/);
  assert.deepEqual(Object.getOwnPropertyDescriptors(core), descriptors);
  assert.deepEqual(core.workspaces, before);
  assert.equal(core.saves, 0);
  assert.equal(f.controller.state.order.length, 2);
  bridge.dispose();
});

test('the bridge follows core Workspaces being enabled and disabled later', async () => {
  const f = fixture([null, null]);
  const c = connect(f, { enabled: false });
  c.bridge.start();
  await f.controller.setAutoSave(false);
  await c.bridge.whenSettled();
  assert.equal(c.bridge.active, false);
  assert.equal(Object.hasOwn(c.core, 'loadWorkspace'), false);
  assert.deepEqual(c.core.writes, []);
  // Core loads its file on enable, then announces the change.
  c.core.workspaces = { Extra: entry('extra') };
  c.toggle(true);
  assert.equal(c.bridge.active, true);
  await c.bridge.whenSettled();
  assert.deepEqual(Object.keys(c.core.file.workspaces), ['A', 'B', 'Extra']);
  c.toggle(false);
  assert.equal(c.bridge.active, false);
  assert.equal(Object.hasOwn(c.core, 'loadWorkspace'), false);
  const writes = c.core.writes.length;
  await f.controller.activate(f.ids[1]!);
  await c.bridge.whenSettled();
  assert.equal(c.core.writes.length, writes);
  c.toggle(true);
  await c.bridge.whenSettled();
  assert.equal(c.core.file.active, 'B');
  assert.equal(f.controller.state.order.length, 3, 'a second start imports nothing twice');
  c.bridge.dispose();
});

test('without a host change event the bridge re-checks on notifications and when the interface opens', async () => {
  const f = fixture([null, null]);
  const c = connect(f, { enabled: false, events: false });
  c.bridge.start();
  c.wrapper.enabled = true;
  assert.equal(c.bridge.active, false);
  c.bridge.refresh();
  assert.equal(c.bridge.active, true);
  await c.bridge.whenSettled();
  assert.deepEqual(Object.keys(c.core.file.workspaces), ['A', 'B']);
  c.wrapper.enabled = false;
  await f.controller.setAutoSave(false);
  await c.bridge.whenSettled();
  assert.equal(c.bridge.active, false);
  assert.equal(Object.hasOwn(c.core, 'saveWorkspace'), false);
  c.bridge.dispose();
});

test('mobile projects the mobile slot and routes unbound workspaces', async () => {
  const f = await linked([null, null], { device: 'mobile' });
  assert.deepEqual(f.core.file.workspaces.B!.left, {
    id: 'left',
    type: 'mobile-drawer',
    children: [],
  });
  await f.core.loadWorkspace('B');
  assert.equal(f.controller.state.activeId, f.ids[1]);
  assert.deepEqual(f.host.restored, [layout('B', 'mobile')]);
  f.host.current = layout('C', 'mobile');
  f.core.saveWorkspace('C');
  await f.bridge.whenSettled();
  const state = f.controller.state;
  assert.deepEqual(
    state.workspaces[state.order[2]!]!.contexts.mobile!.layout,
    layout('C', 'mobile'),
  );
  assert.equal(f.git.entered, 0);
  assert.deepEqual(f.notices, []);
});

// --- State model -----------------------------------------------------------

test('the baseline is validated, loses unknown records and round-trips through storage', () => {
  const f = fixture([null, null]);
  const state = f.controller.state;
  state.nativeCatalog = {
    projected: { [f.ids[0]!]: 'A', [f.ids[1]!]: 'B (2)' },
    retired: { Gone: T0 },
  };
  const migrated = migrateState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(migrated, state);
  assert.equal(migrated.version, 1);
  assert.deepEqual(migrateState(migrated), migrated);

  const withUnknown = structuredClone(state);
  withUnknown.nativeCatalog!.projected.missing = 'Deleted';
  withUnknown.nativeCatalog!.retired = {};
  assert.deepEqual(migrateState(withUnknown).nativeCatalog, {
    projected: { [f.ids[0]!]: 'A', [f.ids[1]!]: 'B (2)' },
  });
  assert.equal(Object.hasOwn(migrateState(f.controller.state), 'nativeCatalog'), false);
  for (const invalid of [
    null,
    [],
    'A',
    {},
    { projected: [] },
    { projected: { [f.ids[0]!]: 7 } },
    { projected: { [f.ids[0]!]: '' } },
    { projected: {}, retired: [] },
    { projected: {}, retired: { Gone: 'yesterday' } },
  ])
    assert.throws(
      () => migrateState({ ...structuredClone(state), nativeCatalog: invalid }),
      /Invalid core Workspaces baseline/,
    );
});

test('exports omit the baseline and imports never carry one into live state', async () => {
  const f = await linked();
  const baseline = f.controller.state.nativeCatalog;
  assert.ok(baseline);
  const exported = JSON.parse(f.controller.exportJson());
  assert.equal(Object.hasOwn(exported, 'nativeCatalog'), false);
  assert.deepEqual(migrateState(exported).order, f.ids);

  const foreign = structuredClone(f.controller.state);
  foreign.nativeCatalog = { projected: { [f.ids[0]!]: 'Elsewhere' }, retired: { Old: T0 } };
  assert.equal(importRecords(foreign).length, 2);
  for (const record of importRecords(foreign))
    assert.equal(Object.hasOwn(record, 'nativeCatalog'), false);
  assert.equal(await f.controller.importJson(JSON.stringify(foreign)), 2);
  assert.deepEqual(f.controller.state.nativeCatalog, baseline);
  await f.bridge.whenSettled();
  // The imported copies are new records. They enter the baseline after their projection.
  const state = f.controller.state;
  assert.equal(state.order.length, 4);
  assert.deepEqual(Object.keys(f.core.file.workspaces), ['A', 'B', 'A (2)', 'B (2)']);
  assert.deepEqual(Object.keys(state.nativeCatalog!.projected), state.order);
  assert.equal(state.nativeCatalog!.retired, undefined);
});
