/* Test-only plugin for the disposable fixture prepared by prepare-quick-switcher-probe.mjs. */
const { Plugin, Notice, TFile, TextFileView, MarkdownView, apiVersion } = require('obsidian');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const clone = (value) => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const errorInfo = (error) => ({ message: error?.message ?? String(error), stack: error?.stack });

function methodInventory(value) {
  const levels = [];
  for (let depth = 0; value && depth < 4; depth++, value = Object.getPrototypeOf(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    levels.push({
      depth,
      properties: Object.keys(descriptors).sort(),
      methods: Object.entries(descriptors)
        .filter(([, descriptor]) => typeof descriptor.value === 'function')
        .map(([name]) => name)
        .sort(),
    });
  }
  return levels;
}

/** Independent of the production layout parser. */
function fileLeaves(layout) {
  const result = [];
  function walk(node, region) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, region);
      return;
    }
    if (node.type === 'leaf' && typeof node.state?.state?.file === 'string')
      result.push({
        id: node.id,
        region,
        path: node.state.state.file,
        type: node.state.type,
        pinned: node.pinned === true || node.state.pinned === true,
      });
    else for (const child of Object.values(node)) walk(child, region);
  }
  for (const region of ['main', 'left', 'right', 'floating']) walk(layout[region], region);
  return result;
}

module.exports = class QuickSwitcherProbe extends Plugin {
  async onload() {
    this.config = await this.loadData();
    if (this.config?.fixture !== 'obsidian-workspaces-quick-switcher-v1' || this.config.completedAt)
      return;
    this.stopped = false;
    this.calls = [];
    this.coreLoads = [];
    this.restorers = [];
    this.layoutEvents = 0;
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.layoutEvents++;
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      if (!this.stopped) void this.run();
    });
  }
  onunload() {
    this.stopped = true;
    for (const restore of this.restorers ?? []) restore();
  }
  leaves() {
    const leaves = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      leaves.push(leaf);
    });
    return leaves;
  }
  async waitFor(label, condition, timeout = 30_000) {
    const end = Date.now() + timeout;
    while (true) {
      if (this.stopped) throw new Error(`Probe unloaded while waiting for ${label}.`);
      const result = await condition();
      if (result) return result;
      if (Date.now() >= end) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async writeResult() {
    const output = this.config.resultFile;
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(`${output}.tmp`, JSON.stringify(this.result, null, 2));
    await fs.rename(`${output}.tmp`, output);
  }
  async step(name, action) {
    const entry = { name, status: 'running', startedAt: new Date().toISOString() };
    this.result.checks.push(entry);
    await this.writeResult();
    try {
      entry.details = await action();
      entry.status = 'passed';
    } catch (error) {
      entry.status = 'failed';
      entry.error = errorInfo(error);
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString();
      await this.writeResult();
    }
  }
  async gitRaw(args) {
    return new Promise((resolve, reject) =>
      this.gitPlugin.promiseQueue.addTask(
        async () => {
          try {
            return { ok: true, value: await this.gitPlugin.gitManager.git.raw(args) };
          } catch (error) {
            return { ok: false, error };
          }
        },
        (result) =>
          result?.ok
            ? resolve(result.value)
            : reject(result?.error ?? new Error('Git queue returned no result.')),
      ),
    );
  }
  async branch() {
    return (await this.gitRaw(['branch', '--show-current'])).trim();
  }
  statusText() {
    const doc = this.app.workspace.containerEl.ownerDocument;
    return {
      workspaces: [...doc.querySelectorAll('.workspaces-status')].map((el) =>
        el.textContent.trim(),
      ),
      git: this.gitPlugin.branchBar?.statusBarEl?.textContent?.trim() ?? null,
      allItems: [...doc.querySelectorAll('.status-bar-item')].map((el) => el.textContent.trim()),
    };
  }
  observeMethods() {
    for (const method of ['activate', 'saveAndActivate']) {
      const original = this.controller[method];
      if (typeof original !== 'function') continue;
      const probe = this;
      const wrapper = function (...args) {
        const call = {
          method,
          args: clone(args),
          startedAt: new Date().toISOString(),
          status: 'running',
        };
        probe.calls.push(call);
        const returned = Reflect.apply(original, this, args);
        // Observe and return the real promise unchanged. No handler/controller is mocked.
        const observation = Promise.resolve(returned).then(
          () => {
            call.status = 'fulfilled';
            call.finishedAt = new Date().toISOString();
          },
          (error) => {
            call.status = 'rejected';
            call.error = errorInfo(error);
            call.finishedAt = new Date().toISOString();
          },
        );
        Object.defineProperty(call, 'observation', { value: observation });
        return returned;
      };
      this.controller[method] = wrapper;
      this.restorers.push(() => {
        if (this.controller[method] === wrapper) this.controller[method] = original;
      });
    }
  }
  async coreEnabled(enabled) {
    const manager = this.app.internalPlugins;
    if (!!manager.getEnabledPluginById('workspaces') === enabled) return;
    // Obsidian 1.15.1 exposes lifecycle methods on the installed core plugin,
    // not enablePlugin/disablePlugin on its internal-plugin manager.
    const installed = manager.getPluginById?.('workspaces') ?? manager.plugins?.workspaces;
    const method = enabled ? 'enable' : 'disable';
    assert(typeof installed?.[method] === 'function', `Native core Workspaces lacks ${method}.`);
    await installed[method](false);
    if (!enabled) await installed.instance?.saveData?.();
    await this.waitFor(
      `core Workspaces ${enabled ? 'enabled' : 'disabled'}`,
      () => !!manager.getEnabledPluginById('workspaces') === enabled,
    );
  }
  async seedCore() {
    this.originalCoreEnabled = !!this.app.internalPlugins.getEnabledPluginById('workspaces');
    await this.coreEnabled(true);
    const container = this.app.internalPlugins.getEnabledPluginById('workspaces');
    this.core = container.instance ?? container;
    assert(
      this.core && typeof this.core.loadWorkspace === 'function',
      'Native core Workspaces instance is unavailable.',
    );
    this.originalCore = {
      workspaces: clone(this.core.workspaces ?? {}),
      activeWorkspace: this.core.activeWorkspace,
    };
    this.core.workspaces = {
      Alpha: clone(this.controller.state.workspaces['runtime-alpha'].contexts.desktop.layout),
      Beta: clone(this.controller.state.workspaces['runtime-beta'].contexts.desktop.layout),
    };
    this.core.setActiveWorkspace('Alpha');
    await this.core.saveData?.();
    const original = this.core.loadWorkspace;
    const probe = this;
    const wrapper = function (...args) {
      const call = { args: clone(args), at: new Date().toISOString(), status: 'running' };
      probe.coreLoads.push(call);
      const returned = Reflect.apply(original, this, args);
      const observation = Promise.resolve(returned).then(
        () => {
          call.status = 'fulfilled';
        },
        (error) => {
          call.status = 'rejected';
          call.error = errorInfo(error);
        },
      );
      Object.defineProperty(call, 'observation', { value: observation });
      return returned;
    };
    this.core.loadWorkspace = wrapper;
    this.restorers.push(() => {
      if (this.core.loadWorkspace === wrapper) this.core.loadWorkspace = original;
    });
  }
  async restoreCore() {
    if (!this.originalCore) return;
    await this.coreEnabled(true);
    const container = this.app.internalPlugins.getEnabledPluginById('workspaces');
    const core = container.instance ?? container;
    core.workspaces = this.originalCore.workspaces;
    core.setActiveWorkspace(this.originalCore.activeWorkspace);
    await core.saveData?.();
    await this.coreEnabled(this.originalCoreEnabled);
  }
  async openChooser() {
    assert(!this.switcher.activeModal?.isOpen, 'A Quick Switcher modal was already open.');
    assert(
      this.app.commands.executeCommandById(this.commandId) !== false,
      'Quick Switcher++ command was unavailable.',
    );
    return this.waitFor('actual Quick Switcher++ workspace suggestions', () => {
      const modal = this.switcher.activeModal;
      return modal?.isOpen &&
        Array.isArray(modal.chooser?.values) &&
        modal.chooser.values.some((value) => value.item?.type === 'workspaceInfo')
        ? modal
        : null;
    });
  }
  async choose(id, { shortcut = false, baseline = false, expectedFailure = false } = {}) {
    const previousCalls = this.calls.length;
    const previousCore = this.coreLoads.length;
    const previousLayout = this.layoutEvents;
    const modal = await this.openChooser();
    const suggestions = modal.chooser.values.map((value) => ({
      type: value.type,
      item: clone(value.item ?? null),
    }));
    const index = modal.chooser.values.findIndex((value) => value.item?.id === id);
    assert(index >= 0, `Q++ did not list ${id}: ${JSON.stringify(suggestions)}`);
    const evt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' });
    modal.chooser.setSelectedItem(index, evt);
    if (shortcut) {
      assert(
        typeof modal.exMode?.exKeymap?.saveCurrentAndOpenSelectedWorkspace === 'function',
        'Q++ save-and-switch key handler is unavailable.',
      );
      modal.exMode.exKeymap.saveCurrentAndOpenSelectedWorkspace();
    } else modal.chooser.useSelectedItem(evt);
    await this.waitFor('native Quick Switcher++ modal close', () => !modal.isOpen);
    if (baseline) {
      await this.waitFor('core loader observed', () => this.coreLoads.length > previousCore);
      await this.coreLoads[previousCore].observation;
      assert(
        this.coreLoads[previousCore].status === 'fulfilled',
        'Native core workspace load failed.',
      );
      await this.waitFor(
        'core workspace selection committed',
        () => this.core.activeWorkspace === id,
      );
      await this.waitFor('core workspace layout event', () => this.layoutEvents > previousLayout);
    } else {
      const call = await this.waitFor('controller received actual Q++ selection', () =>
        this.calls.slice(previousCalls).find((value) => value.args[0] === id),
      );
      await call.observation;
      assert(
        call.status === (expectedFailure ? 'rejected' : 'fulfilled'),
        `Unexpected Q++ transition result: ${JSON.stringify(call)}`,
      );
      assert(
        this.coreLoads.length === previousCore,
        'Q++ bypassed the controller through the native core loader.',
      );
      assert(
        call.method === (shortcut ? 'saveAndActivate' : 'activate'),
        'Q++ selected the wrong controller operation.',
      );
    }
    return {
      commandId: this.commandId,
      selection: id,
      shortcut,
      suggestions,
      controllerCalls: clone(this.calls.slice(previousCalls)),
      coreLoaderCalls: clone(this.coreLoads.slice(previousCore)),
    };
  }
  async snapshot() {
    const state = this.controller.state;
    return {
      branch: await this.branch(),
      activeId: state.activeId,
      revision: state.revision,
      journal: state.journal,
      layout: clone(this.app.workspace.getLayout()),
      status: this.statusText(),
      activeFile: this.app.workspace.getActiveFile()?.path ?? null,
      views: this.leaves().map((leaf) => ({
        state: clone(leaf.getViewState()),
        deferred: !!leaf.isDeferred,
        content: leaf.view instanceof TextFileView ? leaf.view.getViewData() : null,
      })),
      savedPins: Object.fromEntries(
        ['runtime-alpha', 'runtime-beta'].map((id) => [
          id,
          fileLeaves(state.workspaces[id].contexts.desktop.layout).filter((leaf) => leaf.pinned),
        ]),
      ),
    };
  }
  assertPins(layout, branch) {
    const leaves = fileLeaves(layout);
    for (const [region, file] of [
      ['main', `${branch}-exclusive.md`],
      ['left', `sidebar-${branch}.md`],
      ['right', `sidebar-${branch}.md`],
    ])
      assert(
        leaves.some((leaf) => leaf.region === region && leaf.path === file && leaf.pinned),
        `Missing ${branch} pinned ${region} note ${file}.`,
      );
    assert(
      leaves.some((leaf) => leaf.region === 'main' && leaf.path === 'shared.md' && !leaf.pinned),
      'Missing unpinned shared background editor.',
    );
  }
  async verify(branch, id, { status = true } = {}) {
    const snapshot = await this.snapshot();
    assert(snapshot.branch === branch, `Expected branch ${branch}, got ${snapshot.branch}.`);
    assert(
      snapshot.activeId === id && snapshot.journal === null,
      'Workspace identity/journal did not commit correctly.',
    );
    this.assertPins(snapshot.layout, branch);
    assert(snapshot.activeFile === `${branch}-exclusive.md`, 'Wrong active pinned note.');
    const expected = this.config.notes[branch];
    for (const [name, content] of Object.entries(expected)) {
      assert(
        this.app.vault.getAbstractFileByPath(name) instanceof TFile,
        `${name} was not indexed.`,
      );
      assert(
        (await fs.readFile(path.join(this.config.vaultPath, name), 'utf8')) === content,
        `${name} disk contents are wrong.`,
      );
      const views = snapshot.views.filter((view) => view.state.state?.file === name);
      assert(
        views.length > 0 && views.every((view) => !view.deferred && view.content === content),
        `${name} editor retained missing/stale contents.`,
      );
    }
    const other = branch === 'alpha' ? 'beta' : 'alpha';
    assert(
      !this.app.vault.getAbstractFileByPath(`${other}-exclusive.md`),
      'Source-only note remains in target vault index.',
    );
    this.assertPins(
      this.controller.state.workspaces[`runtime-${other}`].contexts.desktop.layout,
      other,
    );
    if (status) {
      const name = this.controller.state.workspaces[id].name;
      assert(
        snapshot.status.workspaces.length === 1 && snapshot.status.workspaces[0] === name,
        `Workspace status must be exactly ${name}: ${JSON.stringify(snapshot.status)}`,
      );
    }
    return snapshot;
  }
  async restoreAlphaNative() {
    assert(
      (await this.branch()) === 'alpha',
      'Baseline recovery only supports the unchanged alpha branch.',
    );
    await this.app.workspace.changeLayout(clone(this.originalAlphaLayout));
    for (const leaf of this.leaves()) await leaf.loadIfDeferred();
    await this.waitFor(
      'restored alpha native pinned editor',
      () => this.app.workspace.getActiveFile()?.path === 'alpha-exclusive.md',
    );
  }
  async baseline() {
    const initialState = this.controller.state;
    await this.step('baseline reproduces duplicate status branch', async () => {
      const snapshot = await this.verify('alpha', 'runtime-alpha', { status: false });
      assert(
        snapshot.status.workspaces.some((text) => text.includes('Alpha') && text.includes('alpha')),
        'Baseline did not reproduce the duplicated branch in Workspaces status.',
      );
      return { expectedFailure: true, desiredStatus: 'Alpha', actual: snapshot };
    });
    await this.step(
      'baseline Q++ selects core Beta without branch/controller activation',
      async () => {
        const choice = await this.choose('Beta', { baseline: true });
        const actual = await this.snapshot();
        assert(
          choice.controllerCalls.length === 0,
          'Baseline unexpectedly reached the controller.',
        );
        assert(
          actual.branch === 'alpha' && actual.activeId === 'runtime-alpha',
          'Baseline did not demonstrate the expected branch/workspace mismatch.',
        );
        assert(
          JSON.stringify(this.controller.state) === JSON.stringify(initialState),
          'Baseline core selection mutated the product catalog.',
        );
        return {
          expectedFailure: true,
          requested: { workspaceId: 'runtime-beta', branch: 'beta' },
          choice,
          actual,
        };
      },
    );
    await this.step('restore original alpha native layout without catalog writes', async () => {
      await this.restoreAlphaNative();
      assert(
        JSON.stringify(this.controller.state) === JSON.stringify(initialState),
        'Baseline recovery mutated the product catalog.',
      );
      return this.verify('alpha', 'runtime-alpha', { status: false });
    });
  }
  async fixed() {
    await this.step('fixed source status contains only workspace name', () =>
      this.verify('alpha', 'runtime-alpha'),
    );
    for (const branch of ['beta', 'alpha'])
      await this.step(
        `real Q++ Enter selects ${branch} branch and pinned main/sidebar notes`,
        async () => ({
          choice: await this.choose(`runtime-${branch}`),
          actual: await this.verify(branch, `runtime-${branch}`),
        }),
      );
    await this.step('Q++ save-and-switch shortcut uses atomic controller operation', async () => {
      const choice = await this.choose('runtime-beta', { shortcut: true });
      const actual = await this.verify('beta', 'runtime-beta');
      const returned = await this.choose('runtime-alpha');
      return { choice, actual, returned, final: await this.verify('alpha', 'runtime-alpha') };
    });
    await this.step(
      'Q++ lists and switches product workspaces with core Workspaces disabled',
      async () => {
        await this.coreEnabled(false);
        try {
          const choice = await this.choose('runtime-beta');
          const actual = await this.verify('beta', 'runtime-beta');
          const returned = await this.choose('runtime-alpha');
          return {
            coreEnabled: false,
            choice,
            actual,
            returned,
            final: await this.verify('alpha', 'runtime-alpha'),
          };
        } finally {
          await this.coreEnabled(true);
        }
      },
    );
    await this.step('duplicate display names select independent stable workspace IDs', async () => {
      const id = await this.controller.duplicate('runtime-beta');
      this.temporaryDuplicate = id;
      await this.controller.update(id, { name: 'Alpha', group: 'Duplicate native fixture' });
      const choice = await this.choose(id);
      assert(
        choice.suggestions.some((s) => s.item.id === 'runtime-alpha') &&
          choice.suggestions.some((s) => s.item.id === id),
        'Duplicate labels did not preserve independent suggestion IDs.',
      );
      const actual = await this.verify('beta', id);
      const returned = await this.choose('runtime-alpha');
      const final = await this.verify('alpha', 'runtime-alpha');
      await this.controller.remove(id);
      this.temporaryDuplicate = null;
      return { duplicateId: id, choice, actual, returned, final };
    });
    await this.step(
      'dirty native editor rejects Q++ checkout without target layout or journal drift',
      async () => {
        const before = this.controller.state;
        const main = this.leaves().find(
          (leaf) => leaf.getViewState().state?.file === 'alpha-exclusive.md',
        );
        assert(
          main?.view instanceof MarkdownView,
          'Dirty test requires the real native Markdown editor.',
        );
        const original = this.config.notes.alpha['alpha-exclusive.md'];
        const edited = `${original}\nQ++ pending editor regression probe\n`;
        this.dirtyOriginal = original;
        main.view.editor.setValue(edited);
        const choice = await this.choose('runtime-beta', { expectedFailure: true });
        const actual = await this.snapshot();
        assert(
          /changes|dirty|commit|worktree/i.test(choice.controllerCalls[0].error?.message),
          'The actual controller rejection did not identify pending changes.',
        );
        assert(
          actual.branch === 'alpha' &&
            actual.activeId === 'runtime-alpha' &&
            actual.journal === null,
          'Dirty Q++ switch changed branch, active ID, or journal.',
        );
        this.assertPins(actual.layout, 'alpha');
        assert(
          JSON.stringify(this.controller.state.workspaces['runtime-beta']) ===
            JSON.stringify(before.workspaces['runtime-beta']),
          'Dirty rejection mutated the target workspace.',
        );
        assert(
          (await fs.readFile(path.join(this.config.vaultPath, 'alpha-exclusive.md'), 'utf8')) ===
            edited,
          'Native pending edits were not flushed before checkout validation.',
        );
        assert(
          !fileLeaves(actual.layout).some((leaf) => leaf.path === 'beta-exclusive.md'),
          'Dirty rejection applied the target layout.',
        );
        const editor = this.leaves().find(
          (leaf) => leaf.getViewState().state?.file === 'alpha-exclusive.md',
        );
        assert(editor?.view instanceof MarkdownView, 'Dirty rejection lost the source editor.');
        editor.view.editor.setValue(original);
        await this.controller.saveActive();
        this.dirtyOriginal = null;
        assert(
          !(await this.gitRaw(['status', '--porcelain'])).trim(),
          'Restoring original content did not clean the fixture.',
        );
        return { choice, actual, restored: await this.verify('alpha', 'runtime-alpha') };
      },
    );
    await this.step('clean Q++ switching still works after a rejected checkout', async () => {
      const toBeta = await this.choose('runtime-beta');
      const beta = await this.verify('beta', 'runtime-beta');
      const toAlpha = await this.choose('runtime-alpha');
      return { toBeta, beta, toAlpha, alpha: await this.verify('alpha', 'runtime-alpha') };
    });
  }
  async run() {
    if (this.running) return;
    this.running = true;
    this.result = {
      status: 'running',
      phase: this.config.phase,
      runId: this.config.runId,
      startedAt: new Date().toISOString(),
      obsidianApiVersion: apiVersion,
      vault: this.config.vaultPath,
      checks: [],
    };
    try {
      const actualVault = await fs.realpath(this.app.vault.adapter.getBasePath());
      assert(
        actualVault === this.config.vaultPath,
        'Probe marker does not identify this disposable vault.',
      );
      const outside = path.relative(actualVault, this.config.resultFile);
      assert(
        outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside),
        'Report must be outside the vault.',
      );
      const original = JSON.parse(
        await fs.readFile(
          path.join(actualVault, '.obsidian/plugins/workspaces-runtime-probe/data.json'),
          'utf8',
        ),
      );
      assert(
        original.fixture === 'obsidian-workspaces-native-v1' &&
          original.completedAt &&
          original.vaultPath === actualVault,
        'Not a completed disposable fixture.',
      );
      await this.writeResult();
      await this.step('installed native plugins and disposable fixture readiness', async () => {
        this.controller = await this.waitFor(
          'Workspaces controller',
          () => this.app.plugins.getPlugin('obsidian-workspaces')?.controller,
        );
        this.gitPlugin = await this.waitFor('Obsidian Git initialized', () => {
          const git = this.app.plugins.getPlugin('obsidian-git');
          return git?.gitReady && git;
        });
        this.switcher = await this.waitFor('Quick Switcher++ initialized', () =>
          this.app.plugins.getPlugin('darlal-switcher-plus'),
        );
        assert(
          this.gitPlugin.manifest.version === this.config.expectedGitVersion,
          'Unexpected Obsidian Git version.',
        );
        assert(
          this.switcher.manifest.version === this.config.expectedSwitcherVersion,
          'Unexpected Quick Switcher++ version.',
        );
        this.commandId = Object.keys(this.app.commands.commands).find(
          (id) => id.endsWith(':open-workspaces') && id.includes('switcher'),
        );
        assert(this.commandId, 'Actual Quick Switcher++ Workspaces command is not registered.');
        assert(
          this.controller.state.activeId === 'runtime-alpha' &&
            this.controller.state.journal === null,
          'Fixture must start with committed runtime-alpha.',
        );
        assert((await this.branch()) === 'alpha', 'Fixture must start on alpha.');
        assert(!(await this.gitRaw(['remote'])).trim(), 'Disposable fixture has a Git remote.');
        assert(!(await this.gitRaw(['status', '--porcelain'])).trim(), 'Fixture must start clean.');
        for (const branch of ['alpha', 'beta']) {
          const record = this.controller.state.workspaces[`runtime-${branch}`];
          assert(
            record?.contexts.desktop.binding.branch === branch,
            `Missing bound ${branch} fixture.`,
          );
          this.assertPins(record.contexts.desktop.layout, branch);
        }
        // The previously completed fixture may have reopened with deferred tabs.
        // Hydrate its starting editors only; target verification never repairs
        // a workspace restored by the production transition under test.
        for (const leaf of this.leaves()) await leaf.loadIfDeferred();
        this.originalAlphaLayout = clone(this.app.workspace.getLayout());
        this.observeMethods();
        const hashes = {};
        for (const id of ['obsidian-workspaces', 'obsidian-git', 'darlal-switcher-plus']) {
          const content = await fs.readFile(
            path.join(actualVault, '.obsidian/plugins', id, 'main.js'),
          );
          hashes[id] = createHash('sha256').update(content).digest('hex');
        }
        return {
          commandId: this.commandId,
          versions: {
            obsidian: apiVersion,
            git: this.gitPlugin.manifest.version,
            quickSwitcher: this.switcher.manifest.version,
          },
          bundleSHA256: hashes,
          controlStore: this.controller.storageLocation,
          nativePluginManager: Object.fromEntries(
            ['getPlugin', 'loadPlugin', 'unloadPlugin', 'on', 'offref'].map((name) => [
              name,
              typeof this.app.plugins[name],
            ]),
          ),
          nativeCoreManager: Object.fromEntries(
            ['getEnabledPluginById', 'enablePlugin', 'disablePlugin'].map((name) => [
              name,
              typeof this.app.internalPlugins[name],
            ]),
          ),
          nativeCoreMethodInventory: {
            manager: methodInventory(this.app.internalPlugins),
            installedWorkspaces: methodInventory(
              this.app.internalPlugins.getPluginById?.('workspaces') ??
                this.app.internalPlugins.plugins?.workspaces,
            ),
            workspaceInstance: methodInventory(
              this.app.internalPlugins.getEnabledPluginById('workspaces'),
            ),
          },
        };
      });
      await this.step(
        'test-only core names/layouts seeded for exact upstream reproduction',
        async () => {
          await this.seedCore();
          return {
            source: 'disposable fixture only; production catalog unchanged',
            originalEnabled: this.originalCoreEnabled,
            names: Object.keys(this.core.workspaces),
          };
        },
      );
      if (this.config.phase === 'baseline') await this.baseline();
      else await this.fixed();
      this.result.status = 'passed';
    } catch (error) {
      this.result.status = 'failed';
      this.result.error = errorInfo(error);
      console.error('Workspaces Quick Switcher native probe failed', error);
    } finally {
      try {
        this.switcher?.activeModal?.close();
        if (this.config.phase === 'baseline' && this.controller && this.originalAlphaLayout)
          await this.restoreAlphaNative();
        if (this.dirtyOriginal !== undefined && this.dirtyOriginal !== null) {
          const leaf = this.leaves().find(
            (leaf) => leaf.getViewState().state?.file === 'alpha-exclusive.md',
          );
          if (leaf?.view instanceof MarkdownView && (await this.branch()) === 'alpha') {
            leaf.view.editor.setValue(this.dirtyOriginal);
            await this.controller.saveActive();
          }
        }
        if (this.temporaryDuplicate && this.controller.state.activeId !== this.temporaryDuplicate)
          await this.controller.remove(this.temporaryDuplicate);
        await this.restoreCore();
        for (const restore of this.restorers) restore();
        if (this.controller) this.result.final = await this.snapshot();
        if (this.gitPlugin)
          this.result.finalGitStatus = await this.gitRaw(['status', '--porcelain']);
      } catch (error) {
        this.result.cleanupError = errorInfo(error);
        this.result.status = 'failed';
      }
      this.result.controllerCalls = clone(this.calls);
      this.result.coreLoaderCalls = clone(this.coreLoads);
      this.result.finishedAt = new Date().toISOString();
      try {
        await this.writeResult();
        await this.saveData({ ...this.config, completedAt: this.result.finishedAt });
      } catch (error) {
        console.error('Could not save Q++ validation results', error);
      }
      new Notice(
        `Workspaces Quick Switcher ${this.config.phase} validation ${this.result.status}. Results saved outside the fixture vault.`,
        8000,
      );
    }
  }
};
