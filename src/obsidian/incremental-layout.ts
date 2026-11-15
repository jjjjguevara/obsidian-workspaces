import type { Layout } from '../workspaces/model';
import { cloneJson } from './clone-json';

type JsonObject = Record<string, unknown>;

interface LeafState extends JsonObject {
  type: string;
  state: JsonObject;
  pinned?: boolean;
}
interface LeafLayout extends JsonObject {
  id: string;
  type: 'leaf';
  state: LeafState;
  pinned?: boolean;
}
interface ContainerLayout extends JsonObject {
  id: string;
  type: 'split' | 'tabs';
  children: Array<ContainerLayout | LeafLayout>;
  currentTab?: number;
}
interface ParsedLayout {
  value: Layout;
  leaves: Map<string, LeafLayout>;
  tabs: ContainerLayout[];
  active: string;
}

/** Inspected native 1.15.1 capabilities; the caller owns the version check. */
interface NativeLeaf {
  id: string;
  parent: NativeTabs;
  getViewState(): LeafState;
  setViewState(state: LeafState): Promise<void>;
  setPinned(pinned: boolean): void;
  setDimension(dimension: number | null): void;
  loadIfDeferred(): Promise<void>;
  detach(): void;
}
interface NativeTabs {
  children: NativeLeaf[];
  selectTabIndex(index: number): void;
}
interface NativeWorkspace {
  getLayout(): Layout;
  getLeafById(id: string): NativeLeaf | null;
  createLeafInParent(parent: NativeTabs, index: number): NativeLeaf;
  setActiveLeaf(leaf: NativeLeaf, options: { focus: boolean }): void;
}

const RETAINED_PANES = new Set(['file-explorer', 'search', 'bookmarks', 'tag', 'all-properties']);

const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keysWithin = (value: JsonObject, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

// Limit the fast path to inspected core view state. Unknown view types or added
// native features retain full changeLayout; plugin-owned state is never guessed.
const VIEW_KEYS: Record<string, readonly string[]> = {
  empty: [],
  markdown: ['file', 'mode', 'source'],
  'file-explorer': ['sortOrder', 'autoReveal', 'showSearch', 'searchQuery'],
  search: ['query', 'matchingCase', 'explainSearch', 'collapseAll', 'extraContext', 'sortOrder'],
  bookmarks: ['showSearch', 'searchQuery'],
  tag: ['sortOrder', 'useHierarchy', 'showSearch', 'searchQuery'],
  'all-properties': ['sortOrder', 'showSearch', 'searchQuery'],
  backlink: [
    'file',
    'collapseAll',
    'extraContext',
    'sortOrder',
    'showSearch',
    'searchQuery',
    'backlinkCollapsed',
    'unlinkedCollapsed',
  ],
  'outgoing-link': ['file', 'linksCollapsed', 'unlinkedCollapsed'],
  outline: ['file', 'followCursor', 'showSearch', 'searchQuery'],
};

function supportedView(value: unknown): value is LeafState {
  if (
    !object(value) ||
    !keysWithin(value, ['type', 'state', 'pinned', 'icon', 'title']) ||
    typeof value.type !== 'string' ||
    !Object.hasOwn(VIEW_KEYS, value.type) ||
    !object(value.state) ||
    !keysWithin(value.state, VIEW_KEYS[value.type]!) ||
    (value.pinned !== undefined && typeof value.pinned !== 'boolean')
  )
    return false;
  const path = value.state.file;
  if (
    path !== undefined &&
    (typeof path !== 'string' ||
      !path ||
      path.startsWith('/') ||
      path.startsWith('file:') ||
      /^[A-Za-z]:/.test(path) ||
      path.includes('\\') ||
      path.includes('\0') ||
      /(^|\/)\.{1,2}(\/|$)/.test(path))
  )
    return false;
  return value.type !== 'markdown' || typeof path === 'string';
}

function parse(layout: Layout): ParsedLayout | null {
  if (
    !keysWithin(layout, ['main', 'left', 'right', 'left-ribbon', 'active']) ||
    typeof layout.active !== 'string'
  )
    return null;
  const leaves = new Map<string, LeafLayout>();
  const tabs: ContainerLayout[] = [];
  const ids = new Set<string>();
  const walk = (value: unknown, parentType: string, depth: number): boolean => {
    if (
      !object(value) ||
      depth > 16 ||
      typeof value.id !== 'string' ||
      !value.id ||
      ids.has(value.id)
    )
      return false;
    ids.add(value.id);
    if (value.type === 'leaf') {
      if (
        parentType !== 'tabs' ||
        !keysWithin(value, ['id', 'type', 'state', 'pinned']) ||
        (value.pinned !== undefined && typeof value.pinned !== 'boolean') ||
        !supportedView(value.state)
      )
        return false;
      leaves.set(value.id, value as LeafLayout);
      return true;
    }
    if (value.type !== 'split' && value.type !== 'tabs') return false;
    if (parentType === 'tabs') return false;
    if (
      !keysWithin(
        value,
        value.type === 'split'
          ? ['id', 'type', 'children', 'direction', 'dimension', 'width', 'collapsed']
          : ['id', 'type', 'children', 'dimension', 'currentTab', 'stacked'],
      ) ||
      !Array.isArray(value.children)
    )
      return false;
    if (value.type === 'split') {
      if (value.direction !== 'horizontal' && value.direction !== 'vertical') return false;
    } else {
      if (
        !value.children.length ||
        value.stacked === true ||
        (value.stacked !== undefined && value.stacked !== false) ||
        (value.currentTab !== undefined &&
          (!Number.isInteger(value.currentTab) ||
            (value.currentTab as number) < 0 ||
            (value.currentTab as number) >= value.children.length))
      )
        return false;
      tabs.push(value as unknown as ContainerLayout);
    }
    return value.children.every((child) => walk(child, value.type as string, depth + 1));
  };
  for (const region of ['main', 'left', 'right']) {
    const tree = layout[region];
    if (!object(tree) || tree.type !== 'split' || !walk(tree, '', 0)) return null;
  }
  if (!leaves.has(layout.active)) return null;
  // Native activation selects its tab. Reject an inconsistent saved selection
  // rather than silently deciding which of its two states should win.
  const activeTabs = tabs.find((tab) => tab.children.some((leaf) => leaf.id === layout.active));
  if (activeTabs?.children[activeTabs.currentTab ?? 0]?.id !== layout.active) return null;
  for (const region of ['left', 'right']) {
    const tree = layout[region] as ContainerLayout;
    if (tree.collapsed === true && JSON.stringify(tree).includes(`"id":"${layout.active}"`))
      return null;
  }
  return { value: layout, leaves, tabs, active: layout.active };
}

/** Stable object ordering without dropping opaque view-state data. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function containerShape(value: ContainerLayout): unknown {
  const { id: _id, currentTab: _selected, stacked: _stacked, children, ...attributes } = value;
  if (attributes.collapsed === false) delete attributes.collapsed;
  return {
    ...attributes,
    children:
      value.type === 'tabs'
        ? []
        : children.map((child) => containerShape(child as ContainerLayout)),
  };
}

function sameContainers(source: ParsedLayout, target: ParsedLayout): boolean {
  if (canonical(source.value['left-ribbon']) !== canonical(target.value['left-ribbon']))
    return false;
  return ['main', 'left', 'right'].every(
    (region) =>
      canonical(containerShape(source.value[region] as ContainerLayout)) ===
      canonical(containerShape(target.value[region] as ContainerLayout)),
  );
}

function pinned(leaf: LeafLayout): boolean {
  return leaf.pinned === true || leaf.state.pinned === true;
}

/** Normalize only mapped native IDs and documented absent boolean/index defaults. */
function normalized(layout: ParsedLayout): unknown {
  const positions = new Map<string, string>();
  const walk = (node: ContainerLayout | LeafLayout, position: string): unknown => {
    positions.set(node.id, position);
    const { id: _id, ...attributes } = node;
    if (node.type === 'leaf') {
      const { pinned: _statePin, ...state } = node.state;
      return { ...attributes, pinned: pinned(node), state };
    }
    if (node.type === 'tabs') {
      attributes.currentTab = node.currentTab ?? 0;
      attributes.stacked = false;
    } else if (attributes.collapsed === false) delete attributes.collapsed;
    attributes.children = node.children.map((child, index) => walk(child, `${position}/${index}`));
    return attributes;
  };
  const result: JsonObject = {};
  for (const region of ['main', 'left', 'right'])
    result[region] = walk(layout.value[region] as ContainerLayout, region);
  result['left-ribbon'] = layout.value['left-ribbon'];
  result.active = positions.get(layout.active);
  return result;
}

async function drain(operations: Array<() => Promise<void>>): Promise<void> {
  const settled = await Promise.allSettled(operations.map(async (operation) => operation()));
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
}

/**
 * Restore inspected core leaves inside unchanged native split/tab containers.
 * Call only after outgoing file views have been successfully quiesced. A false
 * result requests full native changeLayout; every started async operation has
 * settled before that fallback, including partially applied/failed updates.
 */
export async function restoreInPlace(
  workspaceValue: unknown,
  targetValue: Layout,
): Promise<boolean> {
  if (!object(workspaceValue)) return false;
  for (const method of ['getLayout', 'getLeafById', 'createLeafInParent', 'setActiveLeaf'])
    if (typeof workspaceValue[method] !== 'function') return false;
  const workspace = workspaceValue as unknown as NativeWorkspace;
  try {
    // Native getState() may include optional own properties whose value is
    // undefined (for example Markdown's backlinks preference). Compare the
    // same JSON state that capture() and native layout persistence preserve.
    const source = parse(cloneJson(workspace.getLayout()));
    const target = parse(targetValue);
    if (!source || !target || !sameContainers(source, target)) return false;
    const plans: Array<{
      tab: NativeTabs;
      current: NativeLeaf[];
      retained: Array<NativeLeaf | undefined>;
      target: ContainerLayout;
    }> = [];
    const owned = new Set<NativeLeaf>();
    for (let index = 0; index < source.tabs.length; index++) {
      const sourceTab = source.tabs[index]!;
      const current = sourceTab.children.map((leaf) => workspace.getLeafById(leaf.id));
      const tab = current[0]?.parent;
      if (
        !tab ||
        !Array.isArray(tab.children) ||
        typeof tab.selectTabIndex !== 'function' ||
        tab.children.length !== current.length
      )
        return false;
      for (let slot = 0; slot < current.length; slot++) {
        const leaf = current[slot];
        if (!leaf || leaf.parent !== tab || tab.children[slot] !== leaf || owned.has(leaf))
          return false;
        for (const method of [
          'getViewState',
          'setViewState',
          'setPinned',
          'loadIfDeferred',
          'detach',
        ] as const)
          if (typeof leaf[method] !== 'function') return false;
        // No file buffer may survive the checkout boundary. Never attempt this
        // fast path on same-path/source editor reuse or a stale quiesce token.
        if (typeof leaf.getViewState().state?.file === 'string') return false;
        // Native createLeafInParent assigns a tab leaf a split dimension. Its
        // deserializeLayout path does not. New shells must support resetting
        // that default; existing leaf/container geometry remains untouched.
        if (typeof leaf.setDimension !== 'function') return false;
        owned.add(leaf);
      }
      const requested = target.tabs[index]!;
      const retained = requested.children.map((node, slot) => {
        const leaf = current[slot];
        const view = (node as LeafLayout).state;
        return leaf &&
          RETAINED_PANES.has(view.type) &&
          canonical(cloneJson(leaf.getViewState())) === canonical(view)
          ? leaf
          : undefined;
      });
      plans.push({ tab, current: current as NativeLeaf[], retained, target: requested });
    }

    // Preserve only unchanged non-file panes. Fresh file/empty shells also
    // discard the source workspace's Back/Forward history, as changeLayout does.
    const removed = plans.flatMap((plan) =>
      plan.current.filter((leaf) => !plan.retained.includes(leaf)),
    );
    await drain(
      removed.map((leaf) => async () => {
        await leaf.setViewState({ type: 'empty', state: {} });
        if (leaf.getViewState().type !== 'empty') throw new Error('Native view did not unload.');
      }),
    );
    const byTargetID = new Map<string, NativeLeaf>();
    const updates: Array<() => Promise<void>> = [];
    for (const plan of plans) {
      let previous: NativeLeaf | undefined;
      for (let slot = 0; slot < plan.target.children.length; slot++) {
        let leaf = plan.retained[slot];
        if (!leaf) {
          const position = previous ? plan.tab.children.indexOf(previous) + 1 : 0;
          leaf = workspace.createLeafInParent(plan.tab, position);
          if (!leaf || owned.has(leaf) || leaf.parent !== plan.tab || typeof leaf.id !== 'string')
            throw new Error('Native leaf creation did not return a new tab.');
          if (typeof leaf.setDimension !== 'function')
            throw new Error('Native leaf sizing is unavailable.');
          leaf.setDimension(null);
          owned.add(leaf);
        }
        previous = leaf;
        const requested = plan.target.children[slot] as LeafLayout;
        byTargetID.set(requested.id, leaf);
        updates.push(async () => {
          if (canonical(cloneJson(leaf.getViewState())) !== canonical(requested.state))
            await leaf.setViewState(cloneJson(requested.state));
          leaf.setPinned(pinned(requested));
          await leaf.loadIfDeferred();
        });
      }
    }
    // New placeholders keep each native tabs container nonempty throughout
    // retirement. Removing its final child would collapse the split topology.
    for (const leaf of removed.toReversed()) leaf.detach();
    // createLeafInParent temporarily activates each new shell, including those
    // in sidebars. Select the requested editor before any file view hydrates so
    // native file-following panes observe the target active file throughout.
    for (const plan of plans) plan.tab.selectTabIndex(plan.target.currentTab ?? 0);
    workspace.setActiveLeaf(byTargetID.get(target.active)!, { focus: false });
    await drain(updates);
    for (const plan of plans) plan.tab.selectTabIndex(plan.target.currentTab ?? 0);
    workspace.setActiveLeaf(byTargetID.get(target.active)!, { focus: true });
    const restored = parse(cloneJson(workspace.getLayout()));
    return !!restored && canonical(normalized(restored)) === canonical(normalized(target));
  } catch {
    return false;
  }
}
