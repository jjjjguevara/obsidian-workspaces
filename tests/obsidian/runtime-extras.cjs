/* Disposable native probe for core file-following sidebar views. Not a product plugin. */
const { Plugin, Notice, FileView, TextFileView, TFile, apiVersion } = require('obsidian');
const fs = require('node:fs/promises');
const path = require('node:path');
const clone = (value) => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const errorInfo = (error) => ({ message: error?.message ?? String(error), stack: error?.stack });
const types = ['backlink', 'outgoing-link', 'outline'];

module.exports = class NativeExtras extends Plugin {
  async onload() {
    this.config = await this.loadData();
    if (this.config?.fixture !== 'obsidian-workspaces-native-extras-v1' || this.config.completedAt)
      return;
    this.app.workspace.onLayoutReady(() => {
      void this.run();
    });
  }
  leaves() {
    const result = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      result.push(leaf);
    });
    return result;
  }
  async waitFor(label, condition, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (true) {
      const value = await condition();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async write() {
    await fs.writeFile(`${this.config.resultFile}.tmp`, JSON.stringify(this.result, null, 2));
    await fs.rename(`${this.config.resultFile}.tmp`, this.config.resultFile);
  }
  async gitRaw(args) {
    return new Promise((resolve, reject) =>
      this.git.promiseQueue.addTask(
        async () => {
          try {
            return { ok: true, value: await this.git.gitManager.git.raw(args) };
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
  inspect(leaf) {
    const view = leaf.view;
    return {
      type: leaf.getViewState().type,
      constructor: view.constructor.name,
      fileView: view instanceof FileView,
      textFileView: view instanceof TextFileView,
      file: view.file?.path ?? null,
      state: clone(leaf.getViewState()),
      deferred: leaf.isDeferred,
    };
  }
  async resetAlpha() {
    if (this.controller.state.journal) await this.controller.recover();
    await this.controller.activate('runtime-alpha');
    await this.app.workspace.changeLayout(clone(this.alphaLayout));
    for (const leaf of this.leaves()) await leaf.loadIfDeferred();
    await this.controller.saveActive();
    assert((await this.branch()) === 'alpha', 'Fixture reset did not restore alpha.');
  }
  async check(type) {
    const result = { type, status: 'running', startedAt: new Date().toISOString() };
    this.result.checks.push(result);
    await this.write();
    try {
      await this.resetAlpha();
      const leaf = this.app.workspace.getRightLeaf(false);
      assert(leaf, 'The native right sidebar is unavailable.');
      await leaf.setViewState({ type, active: true });
      await leaf.loadIfDeferred();
      assert(
        leaf.getViewState().type === type,
        `The core ${type} view is not enabled or could not open.`,
      );
      this.app.workspace.rightSplit.expand();
      const main = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
      const file = this.app.vault.getAbstractFileByPath('alpha-exclusive.md');
      assert(main && file instanceof TFile, 'The fixture source note is unavailable.');
      await main.openFile(file, { active: true, state: { mode: 'source' } });
      this.app.workspace.setActiveLeaf(main, { focus: true });
      try {
        await this.waitFor(
          `${type} to follow the active file`,
          () => leaf.view.file?.path === file.path || leaf.getViewState().state?.file === file.path,
          3_000,
        );
        result.fileFollowingObserved = true;
      } catch (error) {
        result.fileFollowingObserved = false;
        result.followObservation = error.message;
      }
      result.beforeSave = this.inspect(leaf);
      await this.controller.saveActive();
      result.beforeSwitch = this.inspect(leaf);
      result.savedLayout = clone(
        this.controller.state.workspaces['runtime-alpha'].contexts.desktop.layout,
      );
      try {
        await this.controller.activate('runtime-beta');
        result.branch = await this.branch();
        assert(
          result.branch === 'beta' && this.controller.state.activeId === 'runtime-beta',
          'The native switch did not commit beta.',
        );
        assert(!this.controller.state.journal, 'A successful switch left a recovery journal.');
        result.status = result.fileFollowingObserved ? 'passed' : 'inconclusive';
      } catch (error) {
        result.error = errorInfo(error);
        result.branch = await this.branch();
        result.activeId = this.controller.state.activeId;
        result.journal = this.controller.state.journal;
        result.status =
          /Close the .*before switching branches|save lifecycle is not supported/.test(
            error.message,
          )
            ? 'blocked-by-unsupported-view-guard'
            : 'failed';
      }
    } catch (error) {
      result.status = 'failed';
      result.error = errorInfo(error);
    } finally {
      result.finishedAt = new Date().toISOString();
      await this.write();
    }
  }
  async run() {
    if (this.running) return;
    this.running = true;
    this.result = {
      status: 'running',
      runId: this.config.runId,
      obsidianApiVersion: apiVersion,
      startedAt: new Date().toISOString(),
      checks: [],
    };
    try {
      const vault = await fs.realpath(this.app.vault.adapter.getBasePath());
      assert(
        vault === this.config.vaultPath,
        'This plugin is restricted to its prepared disposable vault.',
      );
      const relative = path.relative(vault, this.config.resultFile);
      assert(
        relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        'Results must be outside the fixture repository.',
      );
      const marker = JSON.parse(
        await fs.readFile(
          path.join(vault, this.app.vault.configDir, 'plugins/workspaces-runtime-probe/data.json'),
          'utf8',
        ),
      );
      assert(
        marker.fixture === 'obsidian-workspaces-native-v1' &&
          marker.vaultPath === vault &&
          marker.completedAt,
        'Run the baseline native fixture first.',
      );
      this.controller = await this.waitFor(
        'Workspaces',
        () => this.app.plugins.getPlugin('obsidian-workspaces')?.controller,
      );
      this.git = await this.waitFor('Git', () => {
        const plugin = this.app.plugins.getPlugin('obsidian-git');
        return plugin?.gitReady ? plugin : null;
      });
      this.result.gitVersion = this.git.manifest.version;
      assert(
        !this.controller.busy && !this.controller.state.journal,
        'The fixture already has a running or interrupted transition.',
      );
      assert(
        !(await this.gitRaw(['status', '--porcelain'])).trim(),
        'The fixture worktree must be clean.',
      );
      assert(!(await this.gitRaw(['remote'])).trim(), 'The fixture must have no remotes.');
      this.alphaLayout = clone(
        this.controller.state.workspaces['runtime-alpha'].contexts.desktop.layout,
      );
      assert(
        this.controller.state.workspaces['runtime-beta'],
        'The baseline beta workspace is missing.',
      );
      await this.write();
      for (const type of types) await this.check(type);
      await this.resetAlpha();
      this.result.status = this.result.checks.every((check) => check.status === 'passed')
        ? 'passed'
        : this.result.checks.some(
              (check) =>
                check.status === 'failed' || check.status === 'blocked-by-unsupported-view-guard',
            )
          ? 'failed'
          : 'inconclusive';
      this.result.finalBranch = await this.branch();
      this.result.finalActiveId = this.controller.state.activeId;
      new Notice(
        `Native sidebar validation ${this.result.status}. Results saved outside the fixture vault.`,
        0,
      );
    } catch (error) {
      this.result.status = 'failed';
      this.result.error = errorInfo(error);
      new Notice(`Native sidebar validation failed: ${error.message}`, 0);
    } finally {
      this.result.finishedAt = new Date().toISOString();
      try {
        await this.write();
        await this.saveData({ ...this.config, completedAt: this.result.finishedAt });
      } catch (error) {
        console.error('Could not save native sidebar validation', error);
      }
    }
  }
};
