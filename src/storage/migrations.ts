import {
  emptyState,
  type NativeCatalogBaseline,
  type WorkspaceState,
  type Snapshot,
  type WorkspaceRecord,
} from '../workspaces/model';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const validWorkspaceId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
function validateLayout(value: unknown): void {
  if (!object(value) || !object(value.main))
    throw new Error('Invalid workspace layout: missing main tree.');
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 80) throw new Error('Workspace layout is too deeply nested.');
    if (!object(node)) return;
    if (
      object(node.state) &&
      object(node.state.state) &&
      typeof node.state.state.file === 'string'
    ) {
      const path = node.state.state.file;
      if (
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').includes('..') ||
        /^[A-Za-z]:/.test(path)
      )
        throw new Error('Workspace file paths must be vault-relative.');
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach((item) => walk(item, depth + 1));
      else if (object(child)) walk(child, depth + 1);
    }
  };
  walk(value);
}
function validateSnapshot(value: unknown): asserts value is Snapshot {
  if (
    !object(value) ||
    !['desktop', 'mobile'].includes(String(value.device)) ||
    typeof value.savedAt !== 'number' ||
    !Number.isFinite(value.savedAt)
  )
    throw new Error('Invalid workspace snapshot.');
  validateLayout(value.layout);
  if (
    value.binding !== null &&
    (!object(value.binding) ||
      typeof value.binding.root !== 'string' ||
      !value.binding.root ||
      typeof value.binding.branch !== 'string' ||
      !value.binding.branch)
  )
    throw new Error('Invalid Git binding.');
}
/** The baseline is derived data: an entry for a record that no longer exists is dropped. */
function migrateNativeCatalog(
  value: unknown,
  workspaces: Record<string, unknown>,
): NativeCatalogBaseline {
  if (!object(value) || !object(value.projected))
    throw new Error('Invalid core Workspaces baseline.');
  const baseline: NativeCatalogBaseline = { projected: {} };
  for (const [id, name] of Object.entries(value.projected)) {
    if (typeof name !== 'string' || !name) throw new Error('Invalid core Workspaces baseline.');
    if (validWorkspaceId(id) && Object.hasOwn(workspaces, id)) baseline.projected[id] = name;
  }
  if (value.retired !== undefined) {
    if (!object(value.retired)) throw new Error('Invalid core Workspaces baseline.');
    const retired = Object.entries(value.retired);
    if (retired.some(([, time]) => typeof time !== 'number' || !Number.isFinite(time)))
      throw new Error('Invalid core Workspaces baseline.');
    if (retired.length) baseline.retired = Object.fromEntries(retired) as Record<string, number>;
  }
  return baseline;
}
export function migrateState(value: unknown): WorkspaceState {
  if (value === null || value === undefined) return emptyState();
  if (!object(value) || value.version !== 1)
    throw new Error(
      'Unsupported workspace state version. Preserve the state file and use a compatible plugin version.',
    );
  if (
    !object(value.workspaces) ||
    !Array.isArray(value.order) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.autoSave !== 'boolean'
  )
    throw new Error('Invalid workspace catalog.');
  const ids = Object.keys(value.workspaces);
  if (
    value.order.length !== ids.length ||
    new Set(value.order).size !== ids.length ||
    value.order.some(
      (id) => typeof id !== 'string' || !Object.hasOwn(value.workspaces as object, id),
    )
  )
    throw new Error('Invalid workspace order.');
  if (
    value.activeId !== null &&
    (typeof value.activeId !== 'string' || !Object.hasOwn(value.workspaces, value.activeId))
  )
    throw new Error('Invalid active workspace.');
  for (const [id, record] of Object.entries(value.workspaces)) {
    if (
      !validWorkspaceId(id) ||
      !object(record) ||
      record.id !== id ||
      typeof record.name !== 'string' ||
      !record.name.trim() ||
      !object(record.contexts) ||
      !Array.isArray(record.history)
    )
      throw new Error('Invalid workspace record.');
    for (const key of ['group', 'icon', 'color', 'description'])
      if (typeof record[key] !== 'string') throw new Error(`Invalid workspace ${key}.`);
    if (
      !Object.keys(record.contexts).length ||
      Object.keys(record.contexts).some((key) => key !== 'desktop' && key !== 'mobile')
    )
      throw new Error('Invalid device layouts.');
    for (const [device, context] of Object.entries(record.contexts)) {
      validateSnapshot(context);
      if (context.device !== device) throw new Error('Mismatched device layout.');
    }
    record.history.forEach(validateSnapshot);
  }
  if (value.journal !== null) {
    const journal = value.journal;
    if (
      !object(journal) ||
      !['prepared', 'checkout', 'restoring', 'recovery'].includes(String(journal.phase)) ||
      typeof journal.targetId !== 'string' ||
      !Object.hasOwn(value.workspaces, journal.targetId)
    )
      throw new Error('Invalid recovery journal.');
    if (
      journal.sourceId !== null &&
      (typeof journal.sourceId !== 'string' || !Object.hasOwn(value.workspaces, journal.sourceId))
    )
      throw new Error('Invalid recovery source.');
    if (journal.sourceId !== value.activeId)
      throw new Error('Recovery source does not match the active workspace.');
    validateSnapshot(journal.source);
    validateSnapshot(journal.target);
    if (journal.sourceSaved !== undefined && journal.sourceSaved !== null)
      validateSnapshot(journal.sourceSaved);
    if (
      journal.originalBranch !== null &&
      (!object(journal.originalBranch) ||
        typeof journal.originalBranch.root !== 'string' ||
        !journal.originalBranch.root ||
        typeof journal.originalBranch.branch !== 'string' ||
        !journal.originalBranch.branch)
    )
      throw new Error('Invalid recovery branch.');
  }
  const state = structuredClone(value) as unknown as WorkspaceState;
  if (value.nativeCatalog === undefined) delete state.nativeCatalog;
  else state.nativeCatalog = migrateNativeCatalog(value.nativeCatalog, value.workspaces);
  return state;
}
export function importRecords(value: unknown): WorkspaceRecord[] {
  if (!object(value)) throw new Error('Import must be a JSON object.');
  if (value.version === 1) {
    const state = migrateState(value);
    return state.order.map((id) => state.workspaces[id]);
  }
  if (Object.hasOwn(value, 'version')) throw new Error('Unsupported workspace export version.');
  // Workspace++'s Export action wraps its sessions in { exportedAt, source, data }.
  const payload = object(value.data) && object(value.data.sessions) ? value.data : value;
  const source = object(payload.sessions)
    ? payload.sessions
    : object(payload.workspaces)
      ? payload.workspaces
      : null;
  if (!source) throw new Error('Expected Workspaces, Workspace++, or core Workspaces JSON.');
  const records: WorkspaceRecord[] = [];
  const orderedKeys = Array.isArray(payload.sessionOrder)
    ? [
        ...new Set([
          ...payload.sessionOrder.filter(
            (id): id is string => typeof id === 'string' && Object.hasOwn(source, id),
          ),
          ...Object.keys(source),
        ]),
      ]
    : Object.keys(source);
  for (const key of orderedKeys) {
    const raw = source[key];
    if (!object(raw) || /^mode:/i.test(key)) continue;
    const native = object(raw.main);
    const custom =
      native && object(raw['workspaces-plus:settings-v1'])
        ? raw['workspaces-plus:settings-v1']
        : {};
    const groups = !native && object(payload.groups) ? payload.groups : {};
    const memberships =
      object(payload.sessionGroups) && Array.isArray(payload.sessionGroups[key])
        ? (payload.sessionGroups[key] as unknown[])
        : [];
    const groupRecords = memberships
      .map((id) => (typeof id === 'string' && Object.hasOwn(groups, id) ? groups[id] : null))
      .filter(object);
    const groupNames = groupRecords
      .map((group) => group.name)
      .filter((name): name is string => typeof name === 'string');
    const sourceId = !native && validWorkspaceId(raw.id) ? raw.id : globalThis.crypto.randomUUID();
    const text = (value: unknown, fallback = ''): string =>
      typeof value === 'string' ? value : fallback;
    const record: WorkspaceRecord = {
      id: sourceId,
      name: native ? key : text(raw.name, key),
      group: text(raw.group, groupNames.join(' · ')),
      icon: text(raw.icon, text(custom.icon, text(groupRecords[0]?.icon, 'panels-top-left'))),
      color: text(raw.color, text(custom.iconColor, text(groupRecords[0]?.color))),
      description: text(raw.description, text(custom.description)),
      contexts: {},
      history: [],
    };
    const nativeLayout = structuredClone(raw);
    if (native && object(custom.trackedFiles)) {
      const tracked = custom.trackedFiles;
      const restoreReferences = (node: unknown): void => {
        if (!object(node)) return;
        if (
          node.type === 'leaf' &&
          typeof node.id === 'string' &&
          object(node.state) &&
          object(node.state.state) &&
          !node.state.state.file &&
          typeof tracked[node.id] === 'string'
        )
          node.state.state.file = tracked[node.id];
        if (Array.isArray(node.children)) node.children.forEach(restoreReferences);
      };
      restoreReferences(nativeLayout.main);
    }
    delete nativeLayout['workspaces-plus:settings-v1'];
    const layouts: [string, unknown][] = native
      ? [['desktop', nativeLayout]]
      : [
          ['desktop', raw.layout],
          ['mobile', raw.mobileLayout],
        ];
    for (const [slot, layout] of layouts) {
      if (!object(layout)) continue;
      validateLayout(layout);
      const mobile =
        (object(layout.left) && layout.left.type === 'mobile-drawer') ||
        (object(layout.right) && layout.right.type === 'mobile-drawer');
      const device = slot === 'mobile' || mobile ? 'mobile' : 'desktop';
      const time = device === 'mobile' ? raw.mobileLayoutSavedAt : raw.layoutSavedAt;
      record.contexts[device] = {
        device,
        layout: structuredClone(layout),
        binding: null,
        savedAt: typeof time === 'number' && Number.isFinite(time) ? time : Date.now(),
      };
    }
    const history = Array.isArray(raw.history)
      ? raw.history
      : object(payload.history) && Array.isArray(payload.history[key])
        ? (payload.history[key] as unknown[])
        : [];
    for (const entry of history.slice(0, 30)) {
      if (!object(entry) || !object(entry.layout)) continue;
      validateLayout(entry.layout);
      const device =
        (object(entry.layout.left) && entry.layout.left.type === 'mobile-drawer') ||
        (object(entry.layout.right) && entry.layout.right.type === 'mobile-drawer')
          ? 'mobile'
          : 'desktop';
      const time = entry.savedAt ?? entry.timestamp;
      record.history.push({
        device,
        layout: structuredClone(entry.layout),
        binding: null,
        savedAt: typeof time === 'number' && Number.isFinite(time) ? time : Date.now(),
      });
    }
    if (Object.keys(record.contexts).length) records.push(record);
  }
  if (!records.length) throw new Error('Import contains no usable workspace layouts.');
  return records;
}
