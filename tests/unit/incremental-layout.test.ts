import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreInPlace } from '../../src/obsidian/incremental-layout.ts';
import type { Layout } from '../../src/workspaces/model.ts';

type ObjectState = Record<string, any>;
const clone = <T>(value: T): T => structuredClone(value);
const leaf = (id: string, file?: string, pinned = false): ObjectState => ({
  id,
  type: 'leaf',
  ...(pinned ? { pinned: true } : {}),
  state: {
    type: file ? 'markdown' : 'empty',
    state: file ? { file, mode: 'source' } : {},
    ...(pinned ? { pinned: true } : {}),
  },
});
function layout(prefix: string, notes = true): ObjectState {
  const area = (name: string, children: ObjectState[], currentTab = 0): ObjectState => ({
    id: `${prefix}-${name}`,
    type: 'split',
    direction: name === 'main' ? 'vertical' : 'horizontal',
    ...(name === 'main' ? {} : { width: 300 }),
    children: [
      {
        id: `${prefix}-${name}-tabs`,
        type: 'tabs',
        children,
        ...(currentTab ? { currentTab } : {}),
      },
    ],
  });
  return {
    main: area('main', [
      leaf(`${prefix}-one`, notes ? 'shared.md' : undefined, true),
      leaf(`${prefix}-two`),
    ]),
    left: area(
      'left',
      [
        {
          id: `${prefix}-files`,
          type: 'leaf',
          state: { type: 'file-explorer', state: { sortOrder: 'alphabetical' } },
        },
        leaf(`${prefix}-left-note`, notes ? 'left.md' : undefined, true),
      ],
      1,
    ),
    right: area('right', [leaf(`${prefix}-right-note`, notes ? 'right.md' : undefined, true)]),
    'left-ribbon': { hiddenItems: { command: false } },
    active: `${prefix}-one`,
  };
}

class NativeLeaf {
  buffer: string | null = null;
  history: string[] = [];
  pinned = false;
  dimension: number | null = null;
  state: ObjectState;
  constructor(
    readonly owner: NativeWorkspace,
    readonly id: string,
    readonly parent: NativeTabs,
    data: ObjectState,
  ) {
    this.state = clone(data.state);
    this.pinned = data.pinned === true || this.state.pinned === true;
  }
  getViewState() {
    return { ...clone(this.state), ...(this.pinned ? { pinned: true } : {}) };
  }
  async setViewState(state: ObjectState) {
    this.owner.actions.push(`state:${this.id}:${state.type}`);
    await this.owner.onSet?.(this, state);
    this.state = clone(state);
    this.buffer = null;
  }
  setPinned(pinned: boolean) {
    this.owner.actions.push(`pin:${this.id}:${pinned}`);
    this.pinned = pinned;
    delete this.state.pinned;
  }
  setDimension(dimension: number | null) {
    this.owner.actions.push(`dimension:${this.id}:${dimension}`);
    this.dimension = dimension;
  }
  async loadIfDeferred() {
    this.owner.actions.push(`load:${this.id}`);
    await this.owner.onLoad?.(this);
    const file = this.state.state.file;
    if (file) this.buffer = this.owner.disk.get(file) ?? `current:${file}`;
  }
  detach() {
    this.owner.actions.push(`detach:${this.id}`);
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    assert.ok(this.parent.children.length > 0, 'Never empty a native tab group during replacement');
  }
  serialize() {
    return {
      id: this.id,
      type: 'leaf',
      ...(this.pinned ? { pinned: true } : {}),
      ...(this.dimension ? { dimension: this.dimension } : {}),
      state: this.getViewState(),
    };
  }
}
class NativeTabs {
  children: NativeLeaf[];
  currentTab: number;
  constructor(
    readonly owner: NativeWorkspace,
    readonly data: ObjectState,
  ) {
    this.currentTab = data.currentTab ?? 0;
    this.children = data.children.map(
      (node: ObjectState) => new NativeLeaf(owner, node.id, this, node),
    );
  }
  selectTabIndex(index: number) {
    this.owner.actions.push(`select:${this.data.id}:${index}`);
    this.currentTab = index;
  }
  serialize() {
    const result: ObjectState = {
      ...clone(this.data),
      children: this.children.map((node) => node.serialize()),
    };
    delete result.currentTab;
    if (this.currentTab) result.currentTab = this.currentTab;
    return result;
  }
}
class NativeWorkspace {
  actions: string[] = [];
  tabs: NativeTabs[] = [];
  disk = new Map<string, string>();
  active: string;
  onSet?: (leaf: NativeLeaf, state: ObjectState) => Promise<void>;
  onLoad?: (leaf: NativeLeaf) => Promise<void>;
  onCapture?: (layout: ObjectState) => void;
  newCount = 0;
  constructor(readonly data: ObjectState) {
    this.active = data.active;
    const collect = (node: ObjectState) => {
      if (node.type === 'tabs') this.tabs.push(new NativeTabs(this, node));
      else node.children?.forEach(collect);
    };
    ['main', 'left', 'right'].forEach((region) => collect(data[region]));
  }
  getLayout(): Layout {
    const result = clone(this.data);
    const update = (node: ObjectState): ObjectState =>
      node.type === 'tabs'
        ? this.tabs.find((tab) => tab.data.id === node.id)!.serialize()
        : { ...node, children: node.children.map(update) };
    ['main', 'left', 'right'].forEach((region) => {
      result[region] = update(result[region]);
    });
    result.active = this.active;
    this.onCapture?.(result);
    return result;
  }
  getLeafById(id: string) {
    return this.tabs.flatMap((tab) => tab.children).find((node) => node.id === id) ?? null;
  }
  getFileLeaf(path: string) {
    return this.tabs.flatMap((tab) => tab.children).find((leaf) => leaf.state.state.file === path)!;
  }
  createLeafInParent(parent: NativeTabs, index: number) {
    const result = new NativeLeaf(this, `new-${this.newCount++}`, parent, leaf('new'));
    result.dimension = 100 / parent.children.length;
    parent.children.splice(index, 0, result);
    this.actions.push(`create:${result.id}`);
    this.active = result.id;
    return result;
  }
  setActiveLeaf(leaf: NativeLeaf) {
    this.actions.push(`active:${leaf.id}`);
    this.active = leaf.id;
    leaf.parent.selectTabIndex(leaf.parent.children.indexOf(leaf));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('native shells retain geometry while branch target notes, pins and selected tabs reload', async () => {
  const native = new NativeWorkspace(layout('live', false));
  const target = layout('saved');
  target.main.children[0].currentTab = 1;
  target.main.children[0].children[1] = leaf('saved-two', 'active.md');
  target.active = 'saved-two';
  native.disk.set('shared.md', 'BRAVO\n');
  native.getLeafById('live-one')!.buffer = 'ALPHA\n';
  native.getLeafById('live-one')!.history = ['alpha-exclusive.md'];
  const originalTabs = native.tabs.slice();
  assert.equal(await restoreInPlace(native, target), true);
  assert.deepEqual(native.tabs, originalTabs, 'Reuse the native containers');
  assert.equal(
    native.getLeafById('live-one'),
    null,
    'Retire the source shell with its navigation history',
  );
  assert.equal(native.getFileLeaf('shared.md').buffer, 'BRAVO\n');
  assert.deepEqual(native.getFileLeaf('shared.md').history, []);
  assert.equal(native.getFileLeaf('left.md').pinned, true);
  assert.equal(native.getFileLeaf('right.md').pinned, true);
  assert.equal(native.getLeafById(native.active)!.state.state.file, 'active.md');
  assert.deepEqual(
    native.tabs.map((tab) => tab.currentTab),
    [1, 1, 0],
  );
  assert.ok(
    !native.actions.some((action) => action === 'state:live-files:file-explorer'),
    'Keep an unchanged non-file view',
  );
});

test('target leaf additions and removals remain inside the original tab containers', async () => {
  const source = layout('live', false);
  source.right.children[0].children.push(leaf('retire'));
  const native = new NativeWorkspace(source);
  const target = layout('saved');
  target.main.children[0].children.push(leaf('saved-three', 'third.md', true));
  const containers = native.tabs.slice();
  assert.equal(await restoreInPlace(native, target), true);
  assert.deepEqual(native.tabs, containers);
  assert.equal(native.getLeafById('retire'), null);
  assert.ok(native.actions.indexOf('state:retire:empty') < native.actions.indexOf('detach:retire'));
  assert.equal(native.getFileLeaf('third.md').pinned, true);
  assert.equal(
    native.getLeafById('new-0')!.dimension,
    null,
    'Match native deserialization of a tab leaf',
  );
  const dimensions = native.actions.filter((action) => action.startsWith('dimension:'));
  assert.equal(dimensions.length, 5);
  assert.ok(
    dimensions.every((action) => /^dimension:new-\d+:null$/.test(action)),
    'Only newly created shells receive the native deserialize default',
  );
});

test('live file-backed source buffers reject the fast path before any mutation', async () => {
  const native = new NativeWorkspace(layout('live'));
  assert.equal(await restoreInPlace(native, layout('saved')), false);
  assert.deepEqual(native.actions, []);
});

test('unsupported shape, views, state and selected-tab inconsistencies use full restoration', async (t) => {
  const cases: Array<[string, (target: ObjectState) => void]> = [
    [
      'floating',
      (target) => {
        target.floating = { type: 'floating', children: [] };
      },
    ],
    [
      'linked leaf',
      (target) => {
        target.main.children[0].children[0].group = 'linked';
      },
    ],
    [
      'stacked tabs',
      (target) => {
        target.main.children[0].stacked = true;
      },
    ],
    [
      'unknown view',
      (target) => {
        target.main.children[0].children[0].state.type = 'community-editor';
      },
    ],
    [
      'unknown view state',
      (target) => {
        target.main.children[0].children[0].state.state.scroll = 42;
      },
    ],
    [
      'unknown layout field',
      (target) => {
        target.newNativeFeature = true;
      },
    ],
    [
      'changed geometry',
      (target) => {
        target.left.width = 450;
      },
    ],
    [
      'changed ribbon',
      (target) => {
        target['left-ribbon'].hiddenItems.command = true;
      },
    ],
    [
      'inconsistent active tab',
      (target) => {
        target.main.children[0].currentTab = 1;
      },
    ],
    [
      'duplicate ids',
      (target) => {
        target.left.children[0].id = target.main.children[0].id;
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async () => {
      const native = new NativeWorkspace(layout('live', false));
      const target = layout('saved');
      mutate(target);
      assert.equal(await restoreInPlace(native, target), false);
      assert.deepEqual(native.actions, []);
    });
});

test('supported non-file state changes are applied rather than retained from the source', async () => {
  const native = new NativeWorkspace(layout('live', false));
  const target = layout('saved');
  target.left.children[0].children[0].state.state.sortOrder = 'modified';
  assert.equal(await restoreInPlace(native, target), true);
  assert.equal(native.tabs[1]!.children[0]!.state.state.sortOrder, 'modified');
});

test('a rejected target update drains added and existing views before allowing fallback', async () => {
  const source = layout('live', false);
  const native = new NativeWorkspace(source);
  const target = layout('saved');
  target.main.children[0].children.push(leaf('saved-added', 'added.md'));
  const delayed = deferred();
  let finished = false;
  native.onSet = async (leaf) => {
    if (leaf.id === 'new-0') throw new Error('open failed');
    if (leaf.id === 'new-2') await delayed.promise;
  };
  const pending = restoreInPlace(native, target).finally(() => {
    finished = true;
  });
  await turn();
  assert.equal(finished, false);
  assert.ok(native.actions.includes('state:new-2:markdown'));
  delayed.resolve();
  assert.equal(await pending, false);
  assert.ok(native.actions.includes('load:new-2'), 'Drain every started view before fallback');
  assert.equal(
    native.actions.filter((action) => action.startsWith('active:')).length,
    1,
    'Only preparatory selection occurs; failure cannot report final restoration',
  );
});

test('native optional undefined properties use the persisted JSON comparison boundary', async () => {
  const native = new NativeWorkspace(layout('live', false));
  native.onCapture = (actual) => {
    actual.main.children[0].children[0].state.state.backlinks = undefined;
  };
  assert.equal(await restoreInPlace(native, layout('saved')), true);
  const defined = new NativeWorkspace(layout('live', false));
  defined.onCapture = (actual) => {
    actual.main.children[0].children[0].state.state.backlinks = false;
  };
  assert.equal(
    await restoreInPlace(defined, layout('saved')),
    false,
    'A defined unsupported preference still requires native full restoration',
  );
  assert.deepEqual(defined.actions, []);
});

test('file-following panes see the target active editor while sidebar replacements hydrate', async () => {
  const native = new NativeWorkspace(layout('live', false));
  const target = layout('saved');
  target.right.children[0].children = [
    { id: 'saved-follow', type: 'leaf', state: { type: 'outline', state: { file: 'shared.md' } } },
    leaf('saved-side', 'right.md', true),
  ];
  native.onLoad = async (leaf) => {
    if (leaf.state.type === 'outline') {
      leaf.state.state.file = native.getLeafById(native.active)!.state.state.file;
    }
  };
  assert.equal(await restoreInPlace(native, target), true);
  assert.equal(native.tabs[2]!.children[0]!.state.state.file, 'shared.md');
  assert.equal(native.getLeafById(native.active)!.state.state.file, 'shared.md');
});

test('a rejected removal drains every close and never detaches any unsettled leaf', async () => {
  const source = layout('live', false);
  source.main.children[0].children.push(leaf('remove-one'), leaf('remove-two'));
  const native = new NativeWorkspace(source);
  const delayed = deferred();
  let finished = false;
  native.onSet = async (leaf) => {
    if (leaf.id === 'remove-one') throw new Error('close failed');
    if (leaf.id === 'remove-two') await delayed.promise;
  };
  const pending = restoreInPlace(native, layout('saved')).finally(() => {
    finished = true;
  });
  await turn();
  assert.equal(finished, false);
  assert.ok(!native.actions.some((action) => action.startsWith('detach:')));
  delayed.resolve();
  assert.equal(await pending, false);
  assert.ok(!native.actions.some((action) => action.startsWith('detach:')));
});

test('post-application selection, geometry and extra-state discrepancies cannot report success', async (t) => {
  const cases: Array<[string, (actual: ObjectState) => void]> = [
    [
      'selected tab',
      (actual) => {
        actual.left.children[0].currentTab = 0;
      },
    ],
    [
      'active view',
      (actual) => {
        actual.active = 'live-two';
      },
    ],
    [
      'geometry',
      (actual) => {
        actual.left.width = 301;
      },
    ],
    [
      'leaf dimension',
      (actual) => {
        actual.main.children[0].children[0].dimension = 50;
      },
    ],
    [
      'extra note',
      (actual) => {
        actual.right.children[0].children.push(leaf('unexpected', 'stale.md'));
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async () => {
      const native = new NativeWorkspace(layout('live', false));
      native.onCapture = (actual) => {
        if (native.actions.length) mutate(actual);
      };
      assert.equal(await restoreInPlace(native, layout('saved')), false);
    });
});

test('missing native capabilities and mismatched native child ownership reject before mutation', async () => {
  const native = new NativeWorkspace(layout('live', false));
  const first = native.tabs[0]!.children[0]!;
  first.parent.children[0] = native.tabs[1]!.children[0]!;
  assert.equal(await restoreInPlace(native, layout('saved')), false);
  assert.deepEqual(native.actions, []);
  assert.equal(
    await restoreInPlace(
      {
        getLayout() {
          throw new Error('must not read');
        },
      },
      layout('saved'),
    ),
    false,
  );
  const sizing = new NativeWorkspace(layout('live', false));
  const growth = layout('saved');
  growth.main.children[0].children.push(leaf('added'));
  Object.defineProperty(sizing.tabs[0]!.children[0]!, 'setDimension', { value: undefined });
  assert.equal(await restoreInPlace(sizing, growth), false);
  assert.deepEqual(
    sizing.actions,
    [],
    'Check new-shell sizing capability before removing or adding leaves',
  );
});
