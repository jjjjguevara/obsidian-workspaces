import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { App } from 'obsidian';
import type { WorkspaceController } from '../../src/workspaces/controller.ts';
import { emptyState, snapshot, type WorkspaceState } from '../../src/workspaces/model.ts';

const providerId = 'darlal-switcher-plus';
const workspaceMode = 8;

interface Integration {
  start(): void;
  dispose(): void;
}
type IntegrationConstructor = new (
  app: App,
  controller: WorkspaceController,
  notify?: (message: string) => void,
) => Integration;

interface SearchMatch {
  score: number;
  matches: Array<[number, number]>;
}
interface Suggestion {
  type: string;
  item: { type: string; id: string; name?: string; label?: string; detail?: string };
  match: SearchMatch | null;
}
interface WorkspaceAPI {
  readonly activeWorkspace: string | null;
  readonly workspaces: Record<string, unknown>;
  loadWorkspace(id: unknown): void;
  saveWorkspace(id: unknown): void;
  setActiveWorkspace?(id: unknown): void;
}
interface Input {
  parsedInputQuery: { query: string; hasSearchTerm: boolean };
  parsedCommand(mode?: number): { parsedInput: string };
}

let bundle: string;

before(async () => {
  // Exercise the real adapter with Obsidian supplied by its renderer host.
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../src/obsidian/quick-switcher.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    external: ['obsidian'],
    write: false,
  });
  bundle = result.outputFiles[0]!.text;
});

function loadIntegration(): IntegrationConstructor {
  const module = { exports: {} as { QuickSwitcherIntegration: IntegrationConstructor } };
  runInNewContext(bundle, {
    module,
    exports: module.exports,
    Error,
    console,
    structuredClone,
    require(name: string) {
      assert.equal(name, 'obsidian', 'The compatibility adapter must not load a second runtime.');
      return {
        Notice: class {},
        prepareFuzzySearch:
          (query: string) =>
          (text: string): SearchMatch | null => {
            const index = text.toLowerCase().indexOf(query.trim().toLowerCase());
            return index < 0
              ? null
              : { score: 100 - index, matches: [[index, index + query.trim().length]] };
          },
        sortSearchResults: (results: Suggestion[]) =>
          results.sort((a, b) => (b.match?.score ?? -Infinity) - (a.match?.score ?? -Infinity)),
      };
    },
  });
  return module.exports.QuickSwitcherIntegration;
}

class SuggestionElement {
  classes: string[] = [];
  content: string[] = [];
  createDiv(options: { cls?: string; text?: string }): SuggestionElement {
    if (options.cls) this.classes.push(options.cls);
    if (options.text) this.content.push(options.text);
    return this;
  }
}

interface FakeApp {
  plugins: PluginManager;
  internalPlugins: { getEnabledPluginById(id: string): WorkspaceAPI | undefined };
}

/** Models the two upstream activation paths, including the synchronous keymap API. */
class NativeWorkspaceHandler {
  constructor(readonly app: FakeApp) {}
  static getEnabledWorkspacesPluginInstance(app: FakeApp): WorkspaceAPI | undefined {
    return app.internalPlugins.getEnabledPluginById('workspaces');
  }
  getEnabledWorkspacesPluginInstance(): WorkspaceAPI | undefined {
    return (this.constructor as typeof NativeWorkspaceHandler).getEnabledWorkspacesPluginInstance(
      this.app,
    );
  }
  getSuggestions(_input: Input): Suggestion[] {
    return Object.keys(this.getEnabledWorkspacesPluginInstance()?.workspaces ?? {}).map((id) => ({
      type: 'workspaceList',
      item: { type: 'workspaceInfo', id },
      match: null,
    }));
  }
  renderSuggestion(suggestion: Suggestion, parent: SuggestionElement): boolean {
    this.renderContent(parent, suggestion.item.id, suggestion.match);
    return true;
  }
  onChooseSuggestion(suggestion: Suggestion, _event?: unknown): boolean {
    this.getEnabledWorkspacesPluginInstance()?.loadWorkspace(suggestion.item.id);
    return true;
  }
  onNoResultsCreateAction(input: Input): boolean {
    const workspace = this.getEnabledWorkspacesPluginInstance();
    const name = input.parsedCommand(workspaceMode).parsedInput;
    workspace?.saveWorkspace(name);
    workspace?.setActiveWorkspace?.(name);
    return true;
  }
  addClassesToSuggestionContainer(parent: SuggestionElement, classes: string[]): void {
    parent.classes.push(...classes);
  }
  renderContent(
    parent: SuggestionElement,
    text: string,
    _match: SearchMatch | null,
  ): SuggestionElement {
    parent.content.push(text);
    return parent;
  }
}

function makeModal(mode: number, values: Suggestion[] = []) {
  return {
    exMode: { inputInfo: { mode } },
    chooser: { values },
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
}

function makeProvider(version = '6.3.0') {
  // An independent constructor also checks that reloads do not retain old hooks.
  class WorkspaceHandler extends NativeWorkspaceHandler {}
  return {
    manifest: { id: providerId, version },
    commandDefinitions: [
      {
        commandId: 'switcher-plus:open-workspaces',
        mode: workspaceMode,
        ownSuggestionTypes: ['workspaceList'],
        handlerClass: WorkspaceHandler,
      },
    ],
    activeModal: null as ReturnType<typeof makeModal> | null,
  };
}
type Provider = ReturnType<typeof makeProvider>;

class PluginManager {
  readonly instances = new Map<string, Provider>();
  readonly listeners = new Set<() => void>();
  readonly calls: Array<{ operation: string; id: string; extra: unknown[] }> = [];
  nextProvider = makeProvider();
  loadGate: Promise<void> | undefined;
  loadError: Error | undefined;
  unloadError: Error | undefined;
  readonly loadResult = { loaded: true };
  readonly unloadResult = { unloaded: true };
  getPlugin(id: string): Provider | undefined {
    return this.instances.get(id);
  }
  on(name: string, callback: () => void): () => void {
    assert.equal(name, 'changed');
    this.listeners.add(callback);
    return callback;
  }
  offref(callback: () => void): void {
    this.listeners.delete(callback);
  }
  changed(): void {
    for (const callback of this.listeners) callback();
  }
  async enablePlugin(id: string): Promise<object> {
    const result = await this.loadPlugin(id);
    this.changed();
    return result;
  }
  async loadPlugin(id: string, ...extra: unknown[]): Promise<object> {
    this.calls.push({ operation: 'load', id, extra });
    if (this.loadGate) await this.loadGate;
    if (this.loadError) throw this.loadError;
    if (id === providerId) this.instances.set(id, this.nextProvider);
    return this.loadResult;
  }
  async unloadPlugin(id: string, ...extra: unknown[]): Promise<object> {
    this.calls.push({ operation: 'unload', id, extra });
    if (this.unloadError) throw this.unloadError;
    this.instances.delete(id);
    return this.unloadResult;
  }
}

function catalog(): WorkspaceState {
  const state = emptyState();
  for (const [id, group, branch] of [
    ['writing-id', 'Writing', 'alpha'],
    ['research-id', 'Research', 'beta'],
  ]) {
    state.workspaces[id!] = {
      id: id!,
      name: 'Shared name',
      group: group!,
      icon: 'book-open',
      color: '',
      description: `${group} notes`,
      contexts: {
        desktop: snapshot({ main: { id, type: 'split', children: [] } }, 'desktop', {
          root: '/fixture/vault',
          branch: branch!,
        }),
      },
      history: [],
    };
    state.order.push(id!);
  }
  state.activeId = state.order[0]!;
  return state;
}

class ControllerDouble {
  readonly device = 'desktop';
  readonly mutable = catalog();
  readonly activations: string[] = [];
  readonly compound: Array<{ target: string; source: string | null }> = [];
  readonly creations: string[] = [];
  activationError: Error | undefined;
  compoundError: Error | undefined;
  get state(): WorkspaceState {
    return structuredClone(this.mutable);
  }
  async activate(id: string): Promise<void> {
    if (!Object.hasOwn(this.mutable.workspaces, id)) throw new Error('Workspace no longer exists.');
    this.activations.push(id);
    if (this.activationError) throw this.activationError;
    this.mutable.activeId = id;
  }
  async saveAndActivate(id: string, expectedSource: string | null): Promise<void> {
    this.compound.push({ target: id, source: expectedSource });
    if (this.mutable.activeId !== expectedSource) throw new Error('The source workspace changed.');
    if (this.compoundError) throw this.compoundError;
    this.mutable.activeId = id;
  }
  async create(name: string): Promise<string> {
    this.creations.push(name);
    return 'new-id';
  }
}

function fixture(options: { installed?: boolean; coreEnabled?: boolean; version?: string } = {}) {
  const nativeCalls: Array<{ operation: string; id: unknown }> = [];
  const core = Object.freeze({
    activeWorkspace: 'Shared name',
    workspaces: Object.freeze({
      'Shared name': Object.freeze({ main: { id: 'core-layout' } }),
      'writing-id': Object.freeze({ main: { id: 'core-name-equals-product-id' } }),
    }),
    loadWorkspace(id: unknown) {
      nativeCalls.push({ operation: 'load', id });
    },
    saveWorkspace(id: unknown) {
      nativeCalls.push({ operation: 'save', id });
    },
    setActiveWorkspace(id: unknown) {
      nativeCalls.push({ operation: 'active', id });
    },
  });
  const manager = new PluginManager();
  const provider = makeProvider(options.version);
  manager.nextProvider = provider;
  if (options.installed !== false) manager.instances.set(providerId, provider);
  const app: FakeApp = {
    plugins: manager,
    internalPlugins: {
      getEnabledPluginById: (id) =>
        id === 'workspaces' && options.coreEnabled !== false ? core : undefined,
    },
  };
  const controller = new ControllerDouble();
  const notices: string[] = [];
  const Integration = loadIntegration();
  const integration = new Integration(
    app as unknown as App,
    controller as unknown as WorkspaceController,
    (message) => notices.push(message),
  );
  const Handler = provider.commandDefinitions[0]!.handlerClass;
  const handler = new Handler(app);
  return {
    app,
    manager,
    provider,
    Handler,
    handler,
    integration,
    controller,
    notices,
    core,
    nativeCalls,
  };
}

function input(query = ''): Input {
  return {
    parsedInputQuery: { query, hasSearchTerm: query.length > 0 },
    parsedCommand: () => ({ parsedInput: query }),
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const ids = (suggestions: Suggestion[]) =>
  Array.from(suggestions, (suggestion) => suggestion.item.id);

test('lists stable IDs with duplicate names, group and branch search, without core Workspaces', (t) => {
  const f = fixture({ coreEnabled: false });
  t.after(() => f.integration.dispose());
  f.integration.start();
  assert.ok(f.Handler.getEnabledWorkspacesPluginInstance(f.app));
  const suggestions = f.handler.getSuggestions(input());
  assert.deepEqual(ids(suggestions), ['writing-id', 'research-id']);
  assert.deepEqual(ids(f.handler.getSuggestions(input('research'))), ['research-id']);
  assert.deepEqual(ids(f.handler.getSuggestions(input('beta'))), ['research-id']);
  assert.deepEqual(ids(f.handler.getSuggestions(input('not present'))), []);
  const row = new SuggestionElement();
  assert.equal(f.handler.renderSuggestion(suggestions[1]!, row), true);
  assert.match(row.content.join(' '), /Research.*Shared name/);
  assert.match(row.content.join(' '), /Branch: beta/);
  assert.doesNotMatch(row.content.join(' '), /research-id/);
  assert.deepEqual(f.notices, []);
});

test('chooses duplicate names by their own IDs and observes renames without touching the core catalog', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  const coreBefore = JSON.stringify(f.core);
  f.integration.start();
  const suggestions = f.handler.getSuggestions(input());
  assert.equal(f.handler.onChooseSuggestion(suggestions[1]!, { type: 'click' }), true);
  await settle();
  assert.equal(
    f.handler.onChooseSuggestion(suggestions[0]!, { type: 'keydown', key: 'Enter' }),
    true,
  );
  await settle();
  assert.deepEqual(f.controller.activations, ['research-id', 'writing-id']);
  f.controller.mutable.workspaces['research-id']!.name = 'Renamed';
  assert.deepEqual(ids(f.handler.getSuggestions(input('renamed'))), ['research-id']);
  assert.deepEqual(f.nativeCalls, []);
  assert.equal(JSON.stringify(f.core), coreBefore);
});

test('consumes failed activation and deleted suggestions without falling through to native loading', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  f.integration.start();
  const suggestion = f.handler.getSuggestions(input())[1]!;
  f.controller.activationError = new Error('Resolve tracked changes before checkout.');
  assert.equal(f.handler.onChooseSuggestion(suggestion), true);
  await settle();
  assert.match(f.notices[0]!, /tracked changes/);
  delete f.controller.mutable.workspaces['research-id'];
  assert.equal(f.handler.onChooseSuggestion(suggestion), true);
  await settle();
  assert.match(f.notices[1]!, /no longer exists|changed|choose again/i);
  assert.deepEqual(f.nativeCalls, []);
});

test('save-and-switch calls one atomic controller operation and keeps save intent local to its facade', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  f.integration.start();
  const saveAndSwitch = f.Handler.getEnabledWorkspacesPluginInstance(f.app)!;
  saveAndSwitch.saveWorkspace(saveAndSwitch.activeWorkspace);
  saveAndSwitch.loadWorkspace('research-id');
  await settle();
  assert.deepEqual(f.controller.compound, [{ target: 'research-id', source: 'writing-id' }]);
  assert.deepEqual(f.controller.activations, []);

  const ordinary = f.Handler.getEnabledWorkspacesPluginInstance(f.app)!;
  assert.notEqual(ordinary, saveAndSwitch);
  ordinary.loadWorkspace('writing-id');
  await settle();
  assert.deepEqual(f.controller.activations, ['writing-id']);
  const sameWorkspace = f.Handler.getEnabledWorkspacesPluginInstance(f.app)!;
  sameWorkspace.saveWorkspace(sameWorkspace.activeWorkspace);
  sameWorkspace.loadWorkspace('writing-id');
  await settle();
  assert.deepEqual(f.controller.compound[1], { target: 'writing-id', source: 'writing-id' });
  assert.deepEqual(f.nativeCalls, []);
});

test('save failure and a stale save source prevent fallback activation', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  f.integration.start();
  const failedSave = f.Handler.getEnabledWorkspacesPluginInstance(f.app)!;
  f.controller.compoundError = new Error('Saving the source layout failed.');
  failedSave.saveWorkspace(failedSave.activeWorkspace);
  failedSave.loadWorkspace('research-id');
  await settle();
  assert.match(f.notices[0]!, /Saving the source layout failed/);
  assert.deepEqual(f.controller.activations, []);
  assert.equal(f.controller.mutable.activeId, 'writing-id');

  f.controller.compoundError = undefined;
  const stale = f.Handler.getEnabledWorkspacesPluginInstance(f.app)!;
  stale.saveWorkspace(stale.activeWorkspace);
  f.controller.mutable.activeId = 'research-id';
  stale.loadWorkspace('writing-id');
  await settle();
  assert.deepEqual(f.controller.compound[1], { target: 'writing-id', source: 'writing-id' });
  assert.match(f.notices[1]!, /source workspace changed/i);

  const invalid = f.Handler.getEnabledWorkspacesPluginInstance(f.app)!;
  invalid.saveWorkspace('writing-id');
  invalid.loadWorkspace('writing-id');
  await settle();
  assert.equal(
    f.controller.compound.length,
    2,
    'A request to save a different ID must be rejected.',
  );
  assert.deepEqual(f.controller.activations, []);
  assert.deepEqual(f.nativeCalls, []);
});

test('rejects unmarked native rows even when a core name exactly equals a stable product ID', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  const nativeRows = f.handler.getSuggestions(input());
  assert.ok(nativeRows.some((suggestion) => suggestion.item.id === 'writing-id'));
  f.integration.start();
  for (const suggestion of nativeRows) assert.equal(f.handler.onChooseSuggestion(suggestion), true);
  await settle();
  assert.deepEqual(f.controller.activations, []);
  assert.deepEqual(f.nativeCalls, []);
  assert.equal(f.notices.length, nativeRows.length);
});

test('creates unmatched workspaces through the controller without native save or active-state writes', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  f.integration.start();
  assert.equal(f.handler.onNoResultsCreateAction(input('New workspace')), true);
  await settle();
  assert.deepEqual(f.controller.creations, ['New workspace']);
  assert.deepEqual(f.nativeCalls, []);
});

test('hooks apply only to their app and do not redirect a foreign app selection', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  const foreignCalls: unknown[] = [];
  const foreignCore: WorkspaceAPI = {
    activeWorkspace: 'Foreign',
    workspaces: { Foreign: {} },
    loadWorkspace: (id) => foreignCalls.push(id),
    saveWorkspace: () => {},
  };
  const foreignApp: FakeApp = {
    plugins: f.manager,
    internalPlugins: { getEnabledPluginById: () => foreignCore },
  };
  const foreignHandler = new f.Handler(foreignApp);
  f.integration.start();
  assert.equal(f.Handler.getEnabledWorkspacesPluginInstance(foreignApp), foreignCore);
  const nativeRows = foreignHandler.getSuggestions(input());
  assert.deepEqual(ids(nativeRows), ['Foreign']);
  foreignHandler.onChooseSuggestion(nativeRows[0]!);
  assert.deepEqual(foreignCalls, ['Foreign']);
  const owned = f.handler.getSuggestions(input())[1]!;
  foreignHandler.onChooseSuggestion(owned);
  await settle();
  assert.deepEqual(
    f.controller.activations,
    [],
    'A foreign handler cannot activate our controller.',
  );
  assert.deepEqual(foreignCalls, ['Foreign'], 'Foreign core must not receive a product stable ID.');
});

test('attaches after provider load, preserves manager results and arguments, and restores after unload', async (t) => {
  const f = fixture({ installed: false });
  t.after(() => f.integration.dispose());
  const original = f.Handler.prototype.getSuggestions;
  f.integration.start();
  assert.equal(f.Handler.prototype.getSuggestions, original);
  const token = { caller: 'plugin manager' };
  assert.equal(await f.manager.loadPlugin(providerId, token), f.manager.loadResult);
  assert.deepEqual(ids(f.handler.getSuggestions(input())), ['writing-id', 'research-id']);
  assert.deepEqual(f.manager.calls[0], { operation: 'load', id: providerId, extra: [token] });
  assert.equal(await f.manager.unloadPlugin(providerId, token), f.manager.unloadResult);
  assert.equal(f.Handler.prototype.getSuggestions, original);
  assert.equal(f.Handler.getEnabledWorkspacesPluginInstance(f.app), f.core);
  assert.deepEqual(f.manager.calls[1], { operation: 'unload', id: providerId, extra: [token] });
});

test('provider reload replaces cached-handler hooks and rejects suggestions issued by the old provider', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  const original = f.Handler.prototype.getSuggestions;
  f.integration.start();
  const oldSuggestion = f.handler.getSuggestions(input())[1]!;
  await f.manager.unloadPlugin(providerId);
  assert.equal(f.Handler.prototype.getSuggestions, original);
  const next = makeProvider('6.3.1');
  f.manager.nextProvider = next;
  await f.manager.loadPlugin(providerId);
  const Handler = next.commandDefinitions[0]!.handlerClass;
  const handler = new Handler(f.app);
  assert.deepEqual(ids(handler.getSuggestions(input())), ['writing-id', 'research-id']);
  handler.onChooseSuggestion(oldSuggestion);
  await settle();
  assert.deepEqual(f.controller.activations, []);
  assert.deepEqual(f.nativeCalls, []);
  handler.onChooseSuggestion(handler.getSuggestions(input())[1]!);
  await settle();
  assert.deepEqual(f.controller.activations, ['research-id']);
});

test('attaches when native provider enable was already in progress before integration starts', async (t) => {
  const f = fixture({ installed: false });
  t.after(() => f.integration.dispose());
  const definitions = f.provider.commandDefinitions;
  let initialized = false;
  Object.defineProperty(f.provider, 'commandDefinitions', {
    configurable: true,
    get: () => (initialized ? definitions : undefined),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Native Obsidian publishes the instance before awaiting its onload. Q++ only
  // publishes commandDefinitions after its asynchronous settings read finishes.
  f.manager.loadPlugin = async function (id: string) {
    this.instances.set(id, f.provider);
    await gate;
    initialized = true;
    return this.loadResult;
  };
  const pending = f.manager.enablePlugin(providerId);
  assert.equal(f.manager.getPlugin(providerId), f.provider);
  assert.equal(f.provider.commandDefinitions, undefined);
  f.integration.start();
  assert.deepEqual(f.notices, [], 'A partially loaded provider is not an incompatible provider.');
  release();
  assert.equal(await pending, f.manager.loadResult);
  const suggestions = f.handler.getSuggestions(input());
  assert.deepEqual(ids(suggestions), ['writing-id', 'research-id']);
  f.handler.onChooseSuggestion(suggestions[1]!);
  await settle();
  assert.deepEqual(f.controller.activations, ['research-id']);
  assert.deepEqual(f.nativeCalls, []);
});

test('attaches when native enable starts before integration and publishes its instance later', async (t) => {
  const f = fixture({ installed: false });
  t.after(() => f.integration.dispose());
  let release!: () => void;
  f.manager.loadGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = f.manager.enablePlugin(providerId);
  assert.equal(f.manager.getPlugin(providerId), undefined);
  f.integration.start();
  release();
  await pending;
  const suggestions = f.handler.getSuggestions(input());
  assert.deepEqual(ids(suggestions), ['writing-id', 'research-id']);
  f.handler.onChooseSuggestion(suggestions[1]!);
  await settle();
  assert.deepEqual(f.controller.activations, ['research-id']);
  assert.deepEqual(f.nativeCalls, []);
  assert.deepEqual(f.notices, []);
});

test('native lifecycle events reconcile replacements and stop observing after disposal', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  const original = f.Handler.prototype.getSuggestions;
  f.integration.start();
  assert.equal(f.manager.listeners.size, 1);
  f.manager.instances.delete(providerId);
  f.manager.changed();
  assert.equal(f.Handler.prototype.getSuggestions, original);
  f.manager.instances.set(providerId, f.provider);
  f.manager.changed();
  assert.deepEqual(ids(f.handler.getSuggestions(input())), ['writing-id', 'research-id']);
  const queuedEvent = [...f.manager.listeners][0]!;
  f.integration.dispose();
  assert.equal(f.manager.listeners.size, 0);
  queuedEvent();
  f.manager.changed();
  assert.equal(f.Handler.prototype.getSuggestions, original);
  assert.deepEqual(f.notices, []);
});

test('invalidates workspace modals on install and teardown while leaving another mode open', (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  const existing = makeModal(workspaceMode);
  f.provider.activeModal = existing;
  f.integration.start();
  assert.equal(existing.closed, 1);
  const current = makeModal(workspaceMode, f.handler.getSuggestions(input()));
  f.provider.activeModal = current;
  f.integration.dispose();
  assert.equal(current.closed, 1);

  const other = makeModal(1);
  f.provider.activeModal = other;
  f.integration.start();
  f.integration.dispose();
  assert.equal(other.closed, 0);
});

test('dispose restores inherited and own descriptors and makes previously captured operations harmless', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  const originalLoad = f.manager.loadPlugin;
  Object.defineProperty(f.manager, 'loadPlugin', {
    value: originalLoad,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  const beforeManager = Object.getOwnPropertyDescriptor(f.manager, 'loadPlugin');
  const beforeHandler = Object.getOwnPropertyDescriptors(f.Handler.prototype);
  const beforeClass = Object.getOwnPropertyDescriptors(f.Handler);
  f.integration.start();
  f.integration.start();
  const choose = f.handler.onChooseSuggestion;
  const suggestion = f.handler.getSuggestions(input())[1]!;
  const facade = f.Handler.getEnabledWorkspacesPluginInstance(f.app)!;
  // Both operations are scheduled by upstream before teardown finishes.
  choose.call(f.handler, suggestion);
  f.integration.dispose();
  facade.loadWorkspace('research-id');
  choose.call(f.handler, suggestion);
  await settle();
  assert.deepEqual(f.controller.activations, []);
  assert.deepEqual(f.nativeCalls, []);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.manager, 'loadPlugin'), beforeManager);
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.Handler.prototype), beforeHandler);
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.Handler), beforeClass);
});

test('a provider load completing after disposal does not reinstall hooks', async (t) => {
  const f = fixture({ installed: false });
  t.after(() => f.integration.dispose());
  let release!: () => void;
  f.manager.loadGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.Handler.prototype.getSuggestions;
  f.integration.start();
  const pending = f.manager.loadPlugin(providerId);
  f.integration.dispose();
  release();
  assert.equal(await pending, f.manager.loadResult);
  assert.equal(f.Handler.prototype.getSuggestions, original);
  assert.equal(f.Handler.getEnabledWorkspacesPluginInstance(f.app), f.core);
});

test('later wrappers are preserved and captured adapter callbacks reject owned rows after disposal', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  f.integration.start();
  const suggestion = f.handler.getSuggestions(input())[1]!;
  const captured = f.Handler.prototype.onChooseSuggestion;
  const foreign = function (this: NativeWorkspaceHandler, item: Suggestion): boolean {
    return captured.call(this, item);
  };
  f.Handler.prototype.onChooseSuggestion = foreign;
  const capturedLoad = f.manager.loadPlugin;
  const foreignLoad = function (this: PluginManager, id: string, ...args: unknown[]) {
    return capturedLoad.call(this, id, ...args);
  };
  f.manager.loadPlugin = foreignLoad;
  f.integration.dispose();
  assert.equal(f.Handler.prototype.onChooseSuggestion, foreign);
  assert.equal(f.manager.loadPlugin, foreignLoad);
  f.handler.onChooseSuggestion(suggestion);
  await settle();
  assert.deepEqual(f.controller.activations, []);
  assert.deepEqual(f.nativeCalls, []);
  assert.match(f.notices[0]!, /changed|disabled|reloaded/i);
});

test('unsupported versions and incomplete handler capabilities produce a notice without partial hooks', async (t) => {
  const unsupported = fixture({ version: '7.0.0' });
  t.after(() => unsupported.integration.dispose());
  const original = unsupported.Handler.getEnabledWorkspacesPluginInstance;
  unsupported.integration.start();
  assert.equal(unsupported.Handler.getEnabledWorkspacesPluginInstance, original);
  assert.equal(unsupported.notices.length, 1);
  assert.match(unsupported.notices[0]!, /6\.3/);
  await unsupported.manager.loadPlugin(providerId);
  assert.equal(unsupported.notices.length, 1, 'Repeated discovery must not flood notices.');

  const incomplete = fixture();
  t.after(() => incomplete.integration.dispose());
  Object.defineProperty(incomplete.Handler.prototype, 'renderContent', {
    value: undefined,
    configurable: true,
  });
  const before = Object.getOwnPropertyDescriptors(incomplete.Handler.prototype);
  const resolver = incomplete.Handler.getEnabledWorkspacesPluginInstance;
  incomplete.integration.start();
  assert.equal(incomplete.Handler.getEnabledWorkspacesPluginInstance, resolver);
  assert.deepEqual(Object.getOwnPropertyDescriptors(incomplete.Handler.prototype), before);
  assert.equal(incomplete.notices.length, 1);
  assert.match(incomplete.notices[0]!, /renderContent|handler|unavailable/i);
});

test('a non-replaceable handler method rolls back hooks installed earlier in the same attempt', (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  Object.defineProperty(f.Handler.prototype, 'renderSuggestion', {
    value: f.Handler.prototype.renderSuggestion,
    writable: false,
    configurable: false,
  });
  const beforePrototype = Object.getOwnPropertyDescriptors(f.Handler.prototype);
  const beforeClass = Object.getOwnPropertyDescriptors(f.Handler);
  f.integration.start();
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.Handler.prototype), beforePrototype);
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.Handler), beforeClass);
  assert.equal(f.Handler.getEnabledWorkspacesPluginInstance(f.app), f.core);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!, /unavailable|replace|redefine|configurable/i);
  assert.deepEqual(f.nativeCalls, []);
});

test('failed provider unload restores integration and propagates the original manager error', async (t) => {
  const f = fixture();
  t.after(() => f.integration.dispose());
  f.integration.start();
  const failure = new Error('Provider unload failed.');
  f.manager.unloadError = failure;
  await assert.rejects(f.manager.unloadPlugin(providerId), (error) => error === failure);
  assert.deepEqual(ids(f.handler.getSuggestions(input())), ['writing-id', 'research-id']);
  f.handler.onChooseSuggestion(f.handler.getSuggestions(input())[1]!);
  await settle();
  assert.deepEqual(f.controller.activations, ['research-id']);
  assert.deepEqual(f.nativeCalls, []);
});
