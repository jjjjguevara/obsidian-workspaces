/* Test-only Obsidian plugin. Installed exclusively by scripts/prepare-runtime-vault.mjs. */
const {
  Plugin,
  Notice,
  TFile,
  FileView,
  TextFileView,
  MarkdownView,
  apiVersion,
} = require('obsidian');
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeAtomicReport } = require('./atomic-report.cjs');

const clone = (value) => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const errorInfo = (error) => ({
  message: error instanceof Error ? error.message : String(error),
  stack: error?.stack,
});

/** Deliberately independent of production layout helpers. */
function fileLeaves(layout) {
  const found = [];
  const walk = (node, region) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, region);
      return;
    }
    if (node.type === 'leaf' && typeof node.state?.state?.file === 'string') {
      found.push({
        id: node.id,
        region,
        path: node.state.state.file,
        type: node.state.type,
        pinned: node.pinned === true || node.state.pinned === true,
      });
    } else for (const child of Object.values(node)) walk(child, region);
  };
  for (const region of ['main', 'left', 'right', 'floating']) walk(layout[region], region);
  return found;
}

module.exports = class RuntimeProbe extends Plugin {
  async onload() {
    this.config = await this.loadData();
    if (this.config?.fixture !== 'obsidian-workspaces-native-v1' || this.config.completedAt) return;
    this.stopped = false;
    this.deferred = [];
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        if (!this.result) return;
        for (const leaf of this.leaves())
          if (leaf.isDeferred) {
            this.deferred.push({ phase: this.phase, state: clone(leaf.getViewState()) });
          }
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      if (!this.stopped) void this.run();
    });
  }

  onunload() {
    this.stopped = true;
  }
  leaves() {
    const leaves = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      leaves.push(leaf);
    });
    return leaves;
  }

  async waitFor(label, condition, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    while (true) {
      if (this.stopped) throw new Error(`Probe unloaded while waiting for ${label}.`);
      const value = await condition();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async writeResult() {
    if (!this.result) return;
    await writeAtomicReport(this.config.resultFile, this.result);
  }

  async step(name, action) {
    this.phase = name;
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

  /** Fixture preparation only; actual workspace switches use the product controller. */
  async inGitQueue(action) {
    return new Promise((resolve, reject) => {
      this.gitPlugin.promiseQueue.addTask(
        async () => {
          try {
            return { ok: true, value: await action(this.gitPlugin.gitManager) };
          } catch (error) {
            return { ok: false, error };
          }
        },
        (result) => {
          if (result?.ok) resolve(result.value);
          else
            reject(result?.error ?? new Error('The installed Git queue did not return a result.'));
        },
      );
    });
  }
  async gitRaw(args) {
    return this.inGitQueue((manager) => manager.git.raw(args));
  }
  async branch() {
    return (await this.gitRaw(['branch', '--show-current'])).trim();
  }

  async waitForBranchFiles(branch) {
    const expected = this.config.notes[branch];
    const other = branch === 'alpha' ? 'beta' : 'alpha';
    await this.waitFor(`${branch} filesystem and vault index`, async () => {
      for (const [file, content] of Object.entries(expected)) {
        const indexed = this.app.vault.getAbstractFileByPath(file);
        if (!(indexed instanceof TFile)) return false;
        if (
          (await this.app.vault.adapter.read(file)) !== content ||
          (await this.app.vault.cachedRead(indexed)) !== content
        )
          return false;
      }
      return (
        !this.app.vault.getAbstractFileByPath(`${other}-exclusive.md`) &&
        !(await this.app.vault.adapter.exists(`${other}-exclusive.md`))
      );
    });
  }

  async clearFileViews() {
    for (const leaf of this.leaves()) {
      await leaf.loadIfDeferred();
      if (leaf.view instanceof TextFileView) await leaf.view.save();
      if (leaf.view instanceof FileView || typeof leaf.getViewState().state?.file === 'string') {
        await leaf.setViewState({ type: 'empty', state: {}, pinned: false });
      }
    }
  }

  async makeLayout(branch) {
    await this.clearFileViews();
    const workspace = this.app.workspace;
    const file = (name) => {
      const result = this.app.vault.getAbstractFileByPath(name);
      assert(result instanceof TFile, `Fixture note is not indexed: ${name}`);
      return result;
    };
    const main = workspace.getLeaf(true);
    await main.openFile(file(`${branch}-exclusive.md`), {
      active: true,
      state: { mode: 'source' },
    });
    main.setPinned(true);
    const background = workspace.getLeaf(true);
    await background.openFile(file('shared.md'), { active: false, state: { mode: 'source' } });
    background.setPinned(false);
    const left = workspace.getLeftLeaf(false);
    const right = workspace.getRightLeaf(false);
    assert(left && right, 'Both native sidebars must provide leaves.');
    for (const leaf of [left, right]) {
      await leaf.openFile(file(`sidebar-${branch}.md`), {
        active: false,
        state: { mode: 'source' },
      });
      leaf.setPinned(true);
    }
    workspace.leftSplit.expand();
    workspace.rightSplit.expand();
    workspace.setActiveLeaf(main, { focus: true });
    for (const leaf of this.leaves()) if (leaf.view instanceof TextFileView) await leaf.view.save();
    const layout = clone(workspace.getLayout());
    this.assertPins(layout, branch);
    return layout;
  }

  assertPins(layout, branch) {
    const leaves = fileLeaves(layout);
    for (const [region, file] of [
      ['main', `${branch}-exclusive.md`],
      ['left', `sidebar-${branch}.md`],
      ['right', `sidebar-${branch}.md`],
    ]) {
      assert(
        leaves.some((leaf) => leaf.region === region && leaf.path === file && leaf.pinned),
        `Missing pinned ${region} note: ${file}`,
      );
    }
    assert(
      leaves.some((leaf) => leaf.region === 'main' && leaf.path === 'shared.md' && !leaf.pinned),
      'Missing unpinned shared background tab.',
    );
  }

  // `loadDeferred` is for a check after a switch that did not change the branch.
  // The product then leaves hidden views deferred, as Obsidian does, so the probe
  // loads them before it reads their content. After a branch change the option
  // stays off: the product itself must have loaded every view.
  async verifyWorkspace(branch, id, overrides = {}, { loadDeferred = false } = {}) {
    let probeLoaded = 0;
    if (loadDeferred)
      for (const leaf of this.leaves()) {
        if (!leaf.isDeferred) continue;
        await leaf.loadIfDeferred();
        probeLoaded += 1;
      }
    const actualBranch = await this.branch();
    assert(actualBranch === branch, `Expected Git branch ${branch}, observed ${actualBranch}.`);
    const state = this.controller.state;
    assert(
      state.activeId === id && state.journal === null,
      `Workspace ${id} was not committed cleanly.`,
    );
    const layout = clone(this.app.workspace.getLayout());
    this.assertPins(layout, branch);
    assert(
      this.app.workspace.getActiveFile()?.path === `${branch}-exclusive.md`,
      'The saved main note was not restored as active.',
    );
    const expected = { ...this.config.notes[branch], ...overrides };
    const views = [];
    for (const leaf of this.leaves()) {
      const viewState = leaf.getViewState();
      const file = viewState.state?.file;
      if (typeof file !== 'string' || !Object.hasOwn(expected, file)) continue;
      assert(!leaf.isDeferred, `The restored ${file} leaf remains deferred.`);
      assert(leaf.view instanceof TextFileView, `Expected a native text view for ${file}.`);
      const text = leaf.view.getViewData();
      assert(
        text === expected[file],
        `The visible editor retained stale or unexpected content for ${file}.`,
      );
      assert(
        (await fs.readFile(path.join(this.config.vaultPath, file), 'utf8')) === expected[file],
        `Unexpected disk content for ${file}.`,
      );
      views.push({ state: clone(viewState), content: text, deferred: leaf.isDeferred });
    }
    assert(
      views.some((view) => view.state.state.file === 'shared.md'),
      'Shared background content was not inspected.',
    );
    const other = branch === 'alpha' ? 'beta' : 'alpha';
    assert(
      !this.app.vault.getAbstractFileByPath(`${other}-exclusive.md`),
      'The removed source note remains indexed.',
    );
    const inactive = state.workspaces[`runtime-${other}`];
    this.assertPins(inactive.contexts.desktop.layout, other);
    return {
      branch: actualBranch,
      activeId: state.activeId,
      layout,
      views,
      inactiveSavedPins: fileLeaves(inactive.contexts.desktop.layout).filter((leaf) => leaf.pinned),
      deferredViewsLoadedByProbe: probeLoaded,
    };
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.result = {
      status: 'running',
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
        'Probe configuration does not identify this disposable vault.',
      );
      const relative = path.relative(actualVault, this.config.resultFile);
      assert(
        relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        'Probe results must be outside the vault.',
      );
      await this.writeResult();
      await this.step('installed plugins and fixture readiness', async () => {
        const workspaces = await this.waitFor(
          'Workspaces controller',
          () => this.app.plugins.getPlugin('obsidian-workspaces')?.controller,
        );
        this.controller = workspaces;
        this.gitPlugin = await this.waitFor('Obsidian Git initialization', () => {
          const plugin = this.app.plugins.getPlugin('obsidian-git');
          return plugin?.gitReady ? plugin : null;
        });
        assert(
          this.gitPlugin.manifest.version === this.config.expectedGitVersion,
          'The installed Git version differs from the fixture.',
        );
        assert(
          !this.controller.state.activeId &&
            this.controller.state.order.length === 0 &&
            !this.controller.state.journal,
          'Run the probe only with an empty fixture catalog.',
        );
        assert(!(await this.gitRaw(['remote'])).trim(), 'The fixture must have no Git remotes.');
        assert(
          !(await this.gitRaw(['status', '--porcelain'])).trim(),
          'The initial fixture worktree must be clean.',
        );
        assert((await this.branch()) === 'alpha', 'The prepared fixture must start on alpha.');
        await this.waitForBranchFiles('alpha');
        return {
          gitVersion: this.gitPlugin.manifest.version,
          controlStore: this.controller.storageLocation,
        };
      });

      let alpha;
      let beta;
      let root;
      await this.step('capture real native alpha and beta layouts', async () => {
        root = (await this.gitRaw(['rev-parse', '--show-toplevel'])).trim();
        alpha = await this.makeLayout('alpha');
        await this.clearFileViews();
        await this.inGitQueue(async (manager) => {
          assert(
            !(await manager.git.raw(['status', '--porcelain'])).trim(),
            'Seeding beta requires a clean fixture.',
          );
          await manager.checkout('beta');
        });
        await this.waitForBranchFiles('beta');
        beta = await this.makeLayout('beta');
        return {
          alpha,
          beta,
          sharedByteLengths: {
            alpha: Buffer.byteLength(this.config.notes.alpha['shared.md']),
            beta: Buffer.byteLength(this.config.notes.beta['shared.md']),
          },
        };
      });

      await this.step('import bound records without activating them', async () => {
        const record = (branch, layout) => ({
          id: `runtime-${branch}`,
          name: branch === 'alpha' ? 'Alpha' : 'Beta',
          group: 'Native validation',
          icon: 'panels-top-left',
          color: '',
          description: 'Disposable native fixture',
          contexts: {
            desktop: { layout, binding: { root, branch }, device: 'desktop', savedAt: Date.now() },
          },
          history: [],
        });
        const workspaces = {
          'runtime-alpha': record('alpha', alpha),
          'runtime-beta': record('beta', beta),
        };
        await this.controller.importJson(
          JSON.stringify({
            version: 1,
            revision: 0,
            activeId: null,
            order: Object.keys(workspaces),
            workspaces,
            autoSave: true,
            journal: null,
          }),
        );
        assert(
          this.controller.state.activeId === null && (await this.branch()) === 'beta',
          'Import unexpectedly activated a workspace or branch.',
        );
        return {
          count: this.controller.state.order.length,
          branch: await this.branch(),
          activeId: null,
        };
      });

      for (const branch of ['alpha', 'beta', 'alpha']) {
        await this.step(`activate ${branch} with branch-exclusive main/sidebar pins`, async () => {
          await this.controller.activate(`runtime-${branch}`);
          return this.verifyWorkspace(branch, `runtime-${branch}`);
        });
      }

      const original = this.config.notes.alpha['alpha-exclusive.md'];
      const edited = `${original}\nPending native editor change\n`;
      await this.step('flush a dirty native editor and block branch checkout', async () => {
        const main = this.leaves().find(
          (leaf) => leaf.getViewState().state?.file === 'alpha-exclusive.md',
        );
        assert(
          main?.view instanceof MarkdownView,
          'The active fixture note must be a Markdown editor.',
        );
        main.view.editor.setValue(edited);
        let failure;
        try {
          await this.controller.activate('runtime-beta');
        } catch (error) {
          failure = error;
        }
        assert(
          failure && /changes|dirty|commit|worktree/i.test(failure.message),
          'A dirty editor did not produce a dirty-worktree failure.',
        );
        assert(
          (await fs.readFile(path.join(this.config.vaultPath, 'alpha-exclusive.md'), 'utf8')) ===
            edited,
          'The controller did not flush the edited note.',
        );
        assert(
          this.controller.state.activeId === 'runtime-alpha' &&
            this.controller.state.journal === null,
          'Dirty checkout changed the active identity or left a journal.',
        );
        assert((await this.branch()) === 'alpha', 'Dirty checkout changed Git branches.');
        return { rejection: errorInfo(failure), branch: 'alpha', flushedContent: edited };
      });

      await this.step('same-branch layout activation retains dirty note edits', async () => {
        const duplicate = await this.controller.duplicate('runtime-alpha');
        await this.controller.activate(duplicate);
        const active = this.app.workspace.activeLeaf;
        assert(
          active && !active.isDeferred,
          'The active view is missing or deferred after a same-branch activation.',
        );
        const verified = await this.verifyWorkspace(
          'alpha',
          duplicate,
          { 'alpha-exclusive.md': edited },
          { loadDeferred: true },
        );
        assert(
          (await this.gitRaw(['status', '--porcelain'])).includes('alpha-exclusive.md'),
          'The fixture edit was unexpectedly committed or discarded.',
        );
        return verified;
      });

      await this.step('restore fixture content and switch cleanly again', async () => {
        const main = this.leaves().find(
          (leaf) => leaf.getViewState().state?.file === 'alpha-exclusive.md',
        );
        assert(
          main?.view instanceof MarkdownView,
          'The restored fixture note must be a Markdown editor.',
        );
        main.view.editor.setValue(original);
        await this.controller.saveActive();
        assert(
          !(await this.gitRaw(['status', '--porcelain'])).trim(),
          'Restoring original content did not leave a clean fixture.',
        );
        await this.controller.activate('runtime-beta');
        await this.verifyWorkspace('beta', 'runtime-beta');
        await this.controller.activate('runtime-alpha');
        return this.verifyWorkspace('alpha', 'runtime-alpha');
      });

      this.result.status = 'passed';
      this.result.deferredLeavesObserved = this.deferred;
      this.result.deferredCoverage = this.deferred.some(
        (entry) => entry.state.state?.file === 'shared.md',
      )
        ? 'A real deferred shared.md leaf was observed during native layout events and final content was verified.'
        : 'Background shared.md content was verified; this run did not observe a deferred shared.md leaf.';
      this.result.finalState = this.controller.state;
      new Notice(
        'Workspaces native validation passed. Results were saved outside the fixture vault.',
        0,
      );
    } catch (error) {
      this.result.status = 'failed';
      this.result.error = errorInfo(error);
      this.result.deferredLeavesObserved = this.deferred;
      if (this.controller) this.result.finalState = this.controller.state;
      this.result.finalLayout = clone(this.app.workspace.getLayout());
      console.error('Workspaces native validation failed', error);
      new Notice(`Workspaces native validation failed: ${error.message ?? error}`, 0);
    } finally {
      this.result.finishedAt = new Date().toISOString();
      try {
        await this.writeResult();
        await this.saveData({ ...this.config, completedAt: this.result.finishedAt });
      } catch (error) {
        console.error('Could not save native validation results', error);
        new Notice(`Could not save native validation results: ${error.message ?? error}`, 0);
      }
    }
  }
};
