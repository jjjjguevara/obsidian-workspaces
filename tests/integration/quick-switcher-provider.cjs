/* Independent review harness: actual Quick Switcher++ 6.3.0 with host sequencing stubs.
 * node SCRIPT REPO_ROOT OFFICIAL_ASSETS core|product
 * This is not a native application run. It gates actual provider initialization.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const [repo, assets, expected] = process.argv.slice(2);
assert(repo && assets && ['core', 'product'].includes(expected));
const { build } = createRequire(path.join(repo, 'package.json'))('esbuild');
const providerId = 'darlal-switcher-plus';
const officialSource = fs.readFileSync(path.join(assets, 'main.js'), 'utf8');
const officialManifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json'), 'utf8'));
assert.equal(officialManifest.id, providerId);
assert.equal(officialManifest.version, '6.3.0');

const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

async function scenario(bundle, stage) {
  const scriptGate = gate();
  const settingsGate = gate();
  const notices = [];
  const coreCalls = [];
  const productCalls = [];
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; this._loaded = false; }
    // Matches Obsidian 1.15.1 Plugin.load() readiness semantics.
    async load() { this._loaded = true; await this.onload(); }
    async loadData() { await settingsGate.promise; return { version: '2.0.0', enabledRibbonCommands: [] }; }
    async saveData() {}
    addSettingTab() {}
    addCommand() {}
    registerEvent() {}
    register() {}
  }
  class PluginSettingTab { containerEl = { addClass() {} }; }
  const obsidian = {
    Plugin, PluginSettingTab,
    Platform: { isDesktopApp: true, isMacOS: false, isMobile: false, isMobileApp: false },
    Notice: class { constructor(message) { notices.push(message); } },
    prepareFuzzySearch: query => text => text.includes(query) ? { score: 1, matches: [] } : null,
    sortSearchResults() {},
  };
  function moduleFrom(source) {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require(name) {
      assert.equal(name, 'obsidian'); return obsidian;
    }, console, structuredClone, setTimeout, clearTimeout });
    return module.exports;
  }
  const OfficialQuickSwitcher = moduleFrom(officialSource);
  const { QuickSwitcherIntegration } = moduleFrom(bundle);
  const core = { workspaces: { 'Core-only workspace': {} }, activeWorkspace: 'Core-only workspace',
    loadWorkspace(id) { coreCalls.push(id); } };
  const app = { workspace: { offref() {} }, internalPlugins: { getEnabledPluginById() { return core; } } };
  const events = new Map();
  // Observed host contracts: instance registration before awaited load(), and
  // a manager "changed" event after successful enablePlugin completion.
  const manager = app.plugins = {
    plugins: {},
    getPlugin(id) { return this.plugins[id] ?? null; },
    on(name, callback) {
      const ref = { name, callback };
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(ref);
      return ref;
    },
    offref(ref) { events.get(ref.name)?.delete(ref); },
    trigger(name) { for (const ref of events.get(name) ?? []) ref.callback(); },
    async loadPlugin(id) {
      if (stage === 'before-instance') await scriptGate.promise;
      const provider = new OfficialQuickSwitcher(app, { id, version: '6.3.0' });
      this.plugins[id] = provider;
      await provider.load();
      return provider;
    },
    async unloadPlugin(id) { delete this.plugins[id]; },
    async enablePlugin(id) {
      await this.loadPlugin(id);
      this.trigger('changed');
    },
  };
  const record = { id: 'product-id', name: 'Product workspace', group: '', icon: '', color: '', description: '',
    contexts: { desktop: { device: 'desktop', layout: {}, binding: null, savedAt: 0 } }, history: [] };
  const controller = { device: 'desktop', state: { activeId: null, order: ['product-id'], workspaces: { 'product-id': record } },
    async activate(id) { productCalls.push(id); } };
  const pending = manager.enablePlugin(providerId);
  assert.equal(manager.getPlugin(providerId)?.commandDefinitions, undefined);
  const integration = new QuickSwitcherIntegration(app, controller, message => notices.push(message));
  integration.start();
  scriptGate.release();
  settingsGate.release();
  await pending;
  const provider = manager.getPlugin(providerId);
  const definition = provider.commandDefinitions.find(d => d.commandId === 'switcher-plus:open-workspaces');
  const handler = new definition.handlerClass(app, provider.options);
  const suggestions = handler.getSuggestions({ parsedInputQuery: { query: '', hasSearchTerm: false } });
  assert.equal(suggestions.length, 1);
  handler.onChooseSuggestion(suggestions[0]);
  // Adapter dispatch intentionally waits until the chooser has closed.
  await new Promise(resolve => setImmediate(resolve));
  const ids = Array.from(suggestions, suggestion => suggestion.item.id);
  if (expected === 'core') {
    assert.deepEqual(ids, ['Core-only workspace']);
    assert.deepEqual(coreCalls, ['Core-only workspace']);
    assert.deepEqual(productCalls, []);
  } else {
    assert.deepEqual(ids, ['product-id']);
    assert.deepEqual(productCalls, ['product-id']);
    assert.deepEqual(coreCalls, []);
  }
  integration.dispose();
  return { stage, suggestionIds: ids, productCalls, coreCalls, notices,
    changedListenersAfterDispose: events.get('changed')?.size ?? 0 };
}

(async () => {
  const source = path.join(repo, 'src/obsidian/quick-switcher.ts');
  const output = await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['obsidian'], write: false });
  const scenarios = [];
  for (const stage of ['before-instance', 'during-provider-onload'])
    scenarios.push(await scenario(output.outputFiles[0].text, stage));
  console.log(JSON.stringify({ expectation: expected, officialVersion: officialManifest.version,
    officialBundleSHA256: crypto.createHash('sha256').update(officialSource).digest('hex'),
    adapterSourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    scenarios }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
