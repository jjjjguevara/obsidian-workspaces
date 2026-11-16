/* Independent, synchronous benchmark observations. No production code or host import. */
const SCHEMA = 'workspaces-completion-endpoint-v1';
const clone = (value) => JSON.parse(JSON.stringify(value));
const insist = (condition, message) => {
  if (!condition) throw new Error(`Completion endpoint: ${message}`);
};

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function fileLeaves(layout) {
  const result = [];
  const visit = (node, region) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((child) => visit(child, region));
    if (node.type === 'leaf' && typeof node.state?.state?.file === 'string') {
      result.push({
        id: node.id ?? null,
        region,
        path: node.state.state.file,
        type: node.state.type,
        pinned: node.pinned === true || node.state.pinned === true,
      });
    } else Object.values(node).forEach((child) => visit(child, region));
  };
  for (const region of ['main', 'left', 'right', 'floating']) visit(layout?.[region], region);
  return result;
}

/** All callbacks must be synchronous. Copy before returning so later hydration cannot repair evidence. */
function captureCompletionEndpoint(port) {
  const startedMs = port.now();
  const data = port.read();
  insist(!data?.then, 'capture callback returned a promise');
  const copied = clone(data);
  const finishedMs = port.now();
  return freeze({
    schema: SCHEMA,
    boundary: 'first-controller-settlement-observer',
    ...copied,
    captureStartedMs: startedMs,
    captureFinishedMs: finishedMs,
    captureDurationMs: finishedMs - startedMs,
  });
}

const key = (leaf) => JSON.stringify([leaf.region, leaf.path, leaf.type, leaf.pinned]);
const multiset = (values, serialize) => values.map(serialize).sort();

/**
 * Reusable offline: assertions use the immutable endpoint, never the later live UI.
 *
 * `expected.branchChanged === false` marks a switch that did no checkout
 * (same-branch and unbound samples). The product then restores the layout as
 * Obsidian does, so a hidden view may still be deferred. The active view must
 * be loaded, and each loaded Markdown editor must hold the expected bytes.
 * Without the flag, or with `true`, every requirement applies.
 */
function assertCompletionEndpoint(endpoint, expected) {
  insist(
    expected?.branchChanged === undefined || typeof expected.branchChanged === 'boolean',
    'invalid branch-change expectation',
  );
  const branchChanged = expected.branchChanged !== false;
  insist(endpoint?.schema === SCHEMA, 'missing or unsupported snapshot');
  insist(endpoint.boundary === 'first-controller-settlement-observer', 'wrong capture boundary');
  insist(
    Number.isFinite(endpoint.controllerCompleteMs) &&
      Number.isFinite(endpoint.captureStartedMs) &&
      Number.isFinite(endpoint.captureFinishedMs) &&
      endpoint.captureStartedMs >= endpoint.controllerCompleteMs &&
      endpoint.captureFinishedMs >= endpoint.captureStartedMs,
    'invalid observation timestamps',
  );
  insist(
    endpoint.activeId === expected.id && endpoint.journal === null,
    'identity or journal is incomplete',
  );
  insist(endpoint.busy === null, 'controller is still busy');
  insist(
    Number.isSafeInteger(endpoint.revision) && endpoint.revision >= 0,
    'missing state revision',
  );
  insist(endpoint.input?.released === true, 'input protection has not been released');
  insist(
    Array.isArray(endpoint.input.blocks) && endpoint.input.blocks.length === 1,
    'input guard was not observed exactly once',
  );
  for (const block of endpoint.input.blocks) {
    insist(
      block.status === 'fulfilled' &&
        block.listenerCount === 0 &&
        Number.isFinite(block.startMs) &&
        Number.isFinite(block.endMs) &&
        block.endMs >= block.startMs &&
        block.endMs <= endpoint.controllerCompleteMs,
      'input listeners remain at completion',
    );
  }
  const requested = fileLeaves(expected.layout);
  const actual = fileLeaves(endpoint.layout);
  insist(requested.length > 0, 'requested file-leaf set is empty');
  insist(
    JSON.stringify(multiset(actual, key)) === JSON.stringify(multiset(requested, key)),
    'file leaves, regions, types, multiplicities or pins differ from the requested layout',
  );
  insist(endpoint.activeFile === expected.activeFile, 'wrong active file');
  insist(
    endpoint.activeView?.state?.state?.file === expected.activeFile,
    'active view is not the expected note',
  );
  insist(endpoint.activeView?.deferred === false, 'active view is still deferred');
  insist(
    typeof endpoint.layout?.active === 'string' &&
      endpoint.layout.active === endpoint.activeView?.id,
    'native active leaf disagrees with the observed active view',
  );
  const activeLeaves = actual.filter((leaf) => leaf.id === endpoint.layout.active);
  insist(
    activeLeaves.length === 1 && activeLeaves[0].path === expected.activeFile,
    'native active leaf is missing or points to another file',
  );
  insist(endpoint.status?.git === expected.branch, 'Obsidian Git branch indicator is stale');
  insist(
    Array.isArray(endpoint.status?.workspaces) &&
      endpoint.status.workspaces.length === 1 &&
      endpoint.status.workspaces[0] === expected.name,
    'workspace indicator is stale or duplicated',
  );
  insist(Array.isArray(endpoint.views), 'missing native views');
  insist(
    endpoint.views.every((view) => typeof view.deferred === 'boolean'),
    'a native view has no deferred flag',
  );
  if (branchChanged)
    insist(
      endpoint.views.every((view) => view.deferred === false),
      'a hidden native view is still deferred',
    );
  const expectedEditors = requested.filter((leaf) => leaf.type === 'markdown');
  const editors = endpoint.views.filter(
    (view) => view.state?.type === 'markdown' && typeof view.state?.state?.file === 'string',
  );
  insist(
    JSON.stringify(multiset(editors, (view) => view.state.state.file)) ===
      JSON.stringify(multiset(expectedEditors, (leaf) => leaf.path)),
    'native Markdown editor multiplicities differ from the saved layout',
  );
  insist(
    expected.notes && Object.keys(expected.notes).length > 0,
    'missing independent expected contents',
  );
  for (const leaf of requested)
    insist(endpoint.indexed?.[leaf.path] === true, `${leaf.path} is not indexed`);
  for (const editor of editors) {
    const name = editor.state.state.file;
    insist(Object.hasOwn(expected.notes, name), `${name} has no independent expected contents`);
    // A deferred editor has no buffer yet. It is permitted only without a checkout.
    if (!branchChanged && editor.deferred) continue;
    insist(
      editor.content === expected.notes[name],
      `${name} editor contains stale or missing bytes`,
    );
  }
  for (const name of Object.keys(expected.notes))
    insist(
      editors.some((view) => view.state.state.file === name),
      branchChanged ? `${name} has no hydrated editor` : `${name} has no editor`,
    );
  for (const name of expected.absentPaths ?? [])
    insist(endpoint.indexed?.[name] === false, `${name} remains in the native index`);
  return {
    status: 'passed',
    fileLeaves: actual.length,
    editors: editors.length,
    branchChanged,
    deferredViews: endpoint.views.filter((view) => view.deferred).length,
    capturedBeforeAnyAwait: true,
  };
}

module.exports = { SCHEMA, captureCompletionEndpoint, assertCompletionEndpoint, fileLeaves };
