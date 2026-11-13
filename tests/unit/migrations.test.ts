import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importRecords, migrateState } from '../../src/storage/migrations.ts';
import { addWorkspace } from '../../src/workspaces/catalog.ts';
import {
  emptyState,
  snapshot,
  type Layout,
  type WorkspaceState,
} from '../../src/workspaces/model.ts';

function native(path: string, mobile = false): Layout {
  return {
    main: {
      id: 'main',
      type: 'split',
      children: [
        {
          id: 'tabs',
          type: 'tabs',
          children: [
            {
              id: 'note',
              type: 'leaf',
              state: {
                type: 'markdown',
                pinned: true,
                state: { file: path, mode: 'source', customPluginState: { retain: true } },
              },
            },
          ],
        },
      ],
    },
    left: { id: 'left', type: mobile ? 'mobile-drawer' : 'split', children: [] },
    active: 'note',
  };
}

function ownedState(): WorkspaceState {
  const state = emptyState();
  const first = addWorkspace(
    state,
    'Alpha',
    snapshot(native('alpha.md'), 'desktop', { root: '/repository', branch: 'alpha' }),
    {
      group: 'Projects',
      icon: 'book-open',
      color: '#123456',
      description: 'Research context',
    },
  );
  const second = addWorkspace(
    state,
    'Beta',
    snapshot(native('beta.md'), 'desktop', { root: '/repository', branch: 'beta' }),
  );
  state.workspaces[first]!.contexts.mobile = snapshot(native('alpha-mobile.md', true), 'mobile');
  state.workspaces[first]!.history.push(
    snapshot(native('older.md'), 'desktop', { root: '/repository', branch: 'older' }),
  );
  state.activeId = first;
  state.order = [second, first];
  state.revision = 4;
  return state;
}

test('own catalog round trips native state, metadata, history, bindings and explicit order', () => {
  const original = ownedState();
  const encoded = JSON.parse(JSON.stringify(original)) as unknown;
  const decoded = migrateState(encoded);
  assert.deepEqual(decoded, original);
  const records = importRecords(encoded);
  assert.deepEqual(
    records.map((record) => record.id),
    original.order,
  );
  for (const record of records) assert.deepEqual(record, original.workspaces[record.id]);
  records[0]!.description = 'Changed in imported copy';
  records[1]!.contexts.desktop!.binding!.branch = 'changed';
  assert.equal(original.workspaces[original.order[0]!]!.description, '');
  assert.equal(original.workspaces[original.order[1]!]!.contexts.desktop!.binding!.branch, 'alpha');
});

test('future versions, invalid revisions and malformed own catalogs are refused', () => {
  assert.throws(
    () => migrateState({ ...ownedState(), version: 2 }),
    /Unsupported workspace state version/,
  );
  assert.throws(() => migrateState({ ...ownedState(), revision: -1 }), /Invalid workspace catalog/);
  assert.throws(
    () => migrateState({ ...ownedState(), revision: 1.5 }),
    /Invalid workspace catalog/,
  );
  assert.throws(
    () => migrateState({ ...ownedState(), order: ['missing'] }),
    /Invalid workspace order/,
  );
  assert.throws(
    () => migrateState({ ...ownedState(), activeId: 'missing' }),
    /Invalid active workspace/,
  );
  assert.deepEqual(migrateState(null), emptyState());
});

test('valid recovery journals survive reload while corrupted recovery references are rejected', async (t) => {
  const state = ownedState();
  const sourceId = state.activeId!;
  const targetId = state.order[0]!;
  state.journal = {
    sourceId,
    targetId,
    source: structuredClone(state.workspaces[sourceId]!.contexts.desktop!),
    target: structuredClone(state.workspaces[targetId]!.contexts.desktop!),
    originalBranch: { root: '/repository', branch: 'alpha' },
    phase: 'recovery',
  };
  assert.deepEqual(migrateState(JSON.parse(JSON.stringify(state))), state);
  const cases: Array<[string, (value: WorkspaceState) => void]> = [
    [
      'unknown target',
      (value) => {
        value.journal!.targetId = 'missing';
      },
    ],
    [
      'unknown source',
      (value) => {
        value.journal!.sourceId = 'missing';
      },
    ],
    [
      'source differs from active',
      (value) => {
        value.journal!.sourceId = targetId;
      },
    ],
    [
      'invalid phase',
      (value) => {
        (value.journal as unknown as { phase: string }).phase = 'finished';
      },
    ],
    [
      'invalid source snapshot',
      (value) => {
        value.journal!.source.layout = {};
      },
    ],
    [
      'empty recovery root',
      (value) => {
        value.journal!.originalBranch!.root = '';
      },
    ],
    [
      'empty recovery branch',
      (value) => {
        value.journal!.originalBranch!.branch = '';
      },
    ],
  ];
  for (const [label, corrupt] of cases) {
    await t.test(label, () => {
      const candidate = structuredClone(state);
      corrupt(candidate);
      assert.throws(() => migrateState(candidate));
    });
  }
});

test('path traversal is rejected in saved contexts, history and imported native trees', async (t) => {
  for (const path of [
    '../outside.md',
    'notes/../../outside.md',
    '/outside.md',
    'C:/outside.md',
    'notes\\outside.md',
  ]) {
    await t.test(path, () => {
      const own = ownedState();
      own.workspaces[own.activeId!]!.contexts.desktop!.layout = native(path);
      assert.throws(() => migrateState(own), /vault-relative/);
      assert.throws(
        () => importRecords({ workspaces: { Unsafe: native(path) } }),
        /vault-relative/,
      );
      const historic = ownedState();
      historic.workspaces[historic.activeId!]!.history[0]!.layout = native(path);
      assert.throws(() => migrateState(historic), /vault-relative/);
    });
  }
});

test('standard wrapped Workspace++ export preserves order, both device layouts and group presentation', () => {
  // Upstream createExportPayload uses { exportedAt, source, data } and deliberately
  // strips history; explicit legacy history payloads are covered separately below.
  const desktop = native('research.md');
  const mobile = native('mobile-research.md', true);
  const payload = {
    exportedAt: 1_700_000_000_000,
    source: 'workspace-plus-plus',
    data: {
      sessions: {
        research: {
          id: 'research',
          name: 'Research',
          layout: desktop,
          mobileLayout: mobile,
          layoutSavedAt: 101,
          mobileLayoutSavedAt: 202,
        },
        writing: {
          id: 'writing',
          name: 'Writing',
          layout: native('writing.md'),
          layoutSavedAt: 303,
        },
      },
      sessionOrder: ['writing', 'research', 'writing', 'missing'],
      groups: {
        projects: { id: 'projects', name: 'Projects', icon: 'folder', color: '#112233' },
        reading: { id: 'reading', name: 'Reading', icon: 'book-open', color: '#445566' },
      },
      sessionGroups: { research: ['projects', 'reading'], writing: ['reading'] },
    },
  };
  const records = importRecords(payload);
  assert.deepEqual(
    records.map((record) => record.id),
    ['writing', 'research'],
  );
  const research = records[1]!;
  assert.equal(research.group, 'Projects · Reading');
  assert.equal(research.icon, 'folder');
  assert.equal(research.color, '#112233');
  assert.deepEqual(research.contexts.desktop!.layout, desktop);
  assert.deepEqual(research.contexts.mobile!.layout, mobile);
  assert.equal(research.contexts.desktop!.savedAt, 101);
  assert.equal(research.contexts.mobile!.savedAt, 202);
  assert.equal(research.contexts.desktop!.binding, null);
  assert.deepEqual(research.history, []);
  assert.equal(records[0]!.group, 'Reading');
  assert.equal(records[0]!.icon, 'book-open');
});

test('explicit Workspace++ history imports legacy timestamps and device-specific layouts', () => {
  const desktopHistory = native('old-desktop.md');
  const mobileHistory = native('old-mobile.md', true);
  const records = importRecords({
    sessions: {
      inline: {
        id: 'inline',
        name: 'Inline history',
        layout: native('current.md'),
        history: [
          { timestamp: 11, layout: desktopHistory },
          { savedAt: 22, layout: mobileHistory },
        ],
      },
      separate: { id: 'separate', name: 'Separate history', layout: native('other.md') },
    },
    history: { separate: [{ savedAt: 33, layout: desktopHistory }] },
  });
  assert.deepEqual(records[0]!.history, [
    { device: 'desktop', layout: desktopHistory, binding: null, savedAt: 11 },
    { device: 'mobile', layout: mobileHistory, binding: null, savedAt: 22 },
  ]);
  assert.deepEqual(records[1]!.history, [
    { device: 'desktop', layout: desktopHistory, binding: null, savedAt: 33 },
  ]);
});

test('native core workspaces import while capitalized and compact Mode entries are excluded', () => {
  const main = native('core.md');
  const mobile = native('phone.md', true);
  const records = importRecords({
    workspaces: {
      'Mode: Focus': native('mode.md'),
      'mode:Quiet': native('other-mode.md'),
      'Core workspace': main,
      'Phone workspace': mobile,
    },
  });
  assert.deepEqual(
    records.map((record) => record.name),
    ['Core workspace', 'Phone workspace'],
  );
  assert.deepEqual(records[0]!.contexts.desktop!.layout, main);
  assert.equal(records[0]!.contexts.desktop!.binding, null);
  assert.deepEqual(records[1]!.contexts.mobile!.layout, mobile);
  assert.equal(records[1]!.contexts.desktop, undefined);
});

test('Workspaces Plus metadata and missing tracked references migrate without executing mode or override settings', () => {
  const source = native('current.md');
  const leaf = (
    source.main as {
      children: Array<{ children: Array<{ state: { state: { file: string | null } } }> }>;
    }
  ).children[0]!.children[0]!;
  leaf.state.state.file = null;
  source['workspaces-plus:settings-v1'] = {
    description: 'Daily drafting',
    icon: 'pencil',
    iconColor: '#abcdef',
    trackedFiles: { note: 'tracked.md' },
    fileOverrides: { note: 'Journal/{{date:YYYY-MM-DD}}.md' },
    mode: 'Mode: Focus',
    app: { theme: 'dark' },
  };
  const original = structuredClone(source);
  const record = importRecords({ workspaces: { Drafting: source } })[0]!;
  assert.equal(record.description, 'Daily drafting');
  assert.equal(record.icon, 'pencil');
  assert.equal(record.color, '#abcdef');
  assert.equal(record.contexts.desktop!.binding, null);
  const imported = record.contexts.desktop!.layout;
  const importedLeaf = (
    imported.main as {
      children: Array<{ children: Array<{ state: { pinned: boolean; state: { file: string } } }> }>;
    }
  ).children[0]!.children[0]!;
  assert.equal(importedLeaf.state.state.file, 'tracked.md');
  assert.equal(importedLeaf.state.pinned, true);
  assert.equal(Object.hasOwn(imported, 'workspaces-plus:settings-v1'), false);
  assert.deepEqual(source, original);
  (
    source['workspaces-plus:settings-v1'] as { trackedFiles: Record<string, string> }
  ).trackedFiles.note = '../escape.md';
  assert.throws(() => importRecords({ workspaces: { Drafting: source } }), /vault-relative/);
});
