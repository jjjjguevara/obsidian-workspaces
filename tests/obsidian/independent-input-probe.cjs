/* Independent native input regression probe. Test-only disposable vault. */
const { Plugin, Notice, apiVersion } = require('obsidian');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

module.exports = class IndependentInputReview extends Plugin {
  async onload() {
    this.cleanup = [];
    this.addCommand({
      id: 'arm-native-input-guard',
      name: 'Arm independent native input guard',
      callback: () => void this.arm(),
    });
  }
  onunload() {
    for (const cleanup of this.cleanup.splice(0)) cleanup();
  }
  leaves() {
    const leaves = [];
    this.app.workspace.iterateAllLeaves((leaf) => { leaves.push({ id: leaf.id, ...leaf.getViewState() }); });
    return leaves;
  }
  async arm() {
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    const config = await this.loadData();
    const controller = this.app.plugins.getPlugin('obsidian-workspaces')?.controller;
    if (!controller || controller.busy || controller.state.journal)
      throw new Error('Controller must be idle and outside recovery.');
    const vault = await fs.realpath(this.app.vault.adapter.getBasePath());
    if (vault !== config.vaultPath) throw new Error('Wrong disposable fixture.');
    const data = {
      status: 'armed',
      phase: config.phase,
      startedAt: new Date().toISOString(),
      obsidian: apiVersion,
      productBundleSHA256: createHash('sha256').update(await fs.readFile(path.join(vault, '.obsidian/plugins/obsidian-workspaces/main.js'))).digest('hex'),
      before: this.leaves(),
      events: [],
      method: 'Actual host.block; trusted Sky pointer movement arms it before the next pointerdown. No native input handlers or production methods replaced.',
    };
    const doc = this.app.workspace.containerEl.ownerDocument;
    let started;
    let release;
    let timer;
    let finished = false;
    const write = () => fs.writeFile(config.resultFile, JSON.stringify(data, null, 2));
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const cleanup of this.cleanup.splice(0)) cleanup();
      data.releasedMs = performance.now() - started;
      release?.();
      data.after = this.leaves();
      data.status = 'observed';
      data.newNativeLeafIds = data.after.filter((leaf) => !data.before.some((prior) => prior.id === leaf.id)).map((leaf) => leaf.id);
      data.progressModalPresent = !!doc.querySelector('.workspaces-progress');
      data.finishedAt = new Date().toISOString();
      await write();
      new Notice(`Independent input observation: ${data.newNativeLeafIds.length} new native tab(s).`, 3000);
    };
    const observe = (event) => {
      if (started === undefined || finished) return;
      const entry = { type: event.type, trusted: event.isTrusted, atMs: performance.now() - started, targetClass: event.target?.className, defaultPrevented: event.defaultPrevented, progressModalPresent: !!doc.querySelector('.workspaces-progress') };
      data.events.push(entry);
      setTimeout(() => { entry.defaultPrevented = event.defaultPrevented; }, 0);
      if (event.type === 'click') setTimeout(() => void finish(), 25);
    };
    // Register observation before host.block so stopped events can still be observed.
    for (const type of ['pointerdown', 'pointerup', 'click', 'auxclick', 'contextmenu']) {
      doc.addEventListener(type, observe, true);
      this.cleanup.push(() => doc.removeEventListener(type, observe, true));
    }
    const armOnHover = (event) => {
      if (started !== undefined || !event.isTrusted || !event.target?.closest?.('.workspace-tab-header-new-tab')) return;
      doc.removeEventListener('pointerover', armOnHover, true);
      started = performance.now();
      data.status = 'protected';
      data.hoverTrusted = event.isTrusted;
      data.before = this.leaves();
      const unblock = controller.host.block('Independent input protection observation');
      let released = false;
      release = () => { if (!released) { released = true; unblock(); } };
      timer = setTimeout(() => void finish(), 450);
    };
    doc.addEventListener('pointerover', armOnHover, true);
    this.cleanup.push(() => doc.removeEventListener('pointerover', armOnHover, true));
    this.cleanup.push(() => { clearTimeout(timer); release?.(); });
    await write();
    new Notice('Input probe armed. Move to the main new-tab plus and click.', 5000);
  }
};
