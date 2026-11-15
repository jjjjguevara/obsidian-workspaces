/* Test-only provenance preparation, outside all timed intervals. */
const assert = (condition, message) => {
  if (!condition) throw new Error(`Product reload: ${message}`);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = async function reloadProduct({
  app,
  apiVersion,
  readBundleHash,
  expectedHash,
  waitFor,
}) {
  assert(
    apiVersion === '1.15.1',
    'native loader contract has only been inspected on Obsidian 1.15.1',
  );
  const id = 'obsidian-workspaces';
  const manager = app.plugins;
  assert(
    typeof manager?.disablePlugin === 'function' &&
      typeof manager?.enablePlugin === 'function' &&
      manager.enabledPlugins instanceof Set,
    'native plugin lifecycle capabilities are unavailable',
  );
  const previous = manager.getPlugin(id);
  const controller = previous?.controller;
  assert(
    controller &&
      controller.busy === null &&
      controller.state.journal === null &&
      controller.state.activeId === 'runtime-alpha',
    'start with idle Alpha and no recovery journal',
  );
  const beforeState = controller.state;
  const enabledBefore = [...manager.enabledPlugins].sort();
  assert(enabledBefore.includes(id), 'Workspaces must already be enabled');
  const git = manager.getPlugin('obsidian-git');
  const chooser = manager.getPlugin('darlal-switcher-plus');
  assert(git && chooser, 'Git and Quick Switcher++ must already be loaded');
  const beforeSHA256 = await readBundleHash();
  assert(
    /^[a-f0-9]{64}$/.test(beforeSHA256) && (!expectedHash || beforeSHA256 === expectedHash),
    'installed bytes differ from preparation',
  );
  assert(
    manager.getPlugin(id) === previous &&
      controller.busy === null &&
      controller.state.journal === null &&
      controller.state.revision === beforeState.revision,
    'controller changed while preparing reload',
  );
  // Native 1.15.1 disablePlugin awaits unload/delete; enablePlugin invokes the
  // native script loader, constructs a fresh class instance, and awaits load.
  // Neither method modifies enabledPlugins (the AndSave variants do).
  await manager.disablePlugin(id);
  assert(!manager.getPlugin(id), 'native unload retained the original instance');
  assert((await manager.enablePlugin(id)) === true, 'native enable failed');
  const fresh = await waitFor('fresh Workspaces instance', () => {
    const plugin = manager.getPlugin(id);
    return plugin?.controller && plugin.ready === true && plugin;
  });
  const afterSHA256 = await readBundleHash();
  const enabledAfter = [...manager.enabledPlugins].sort();
  assert(
    fresh !== previous &&
      fresh.controller !== controller &&
      fresh.constructor !== previous.constructor,
    'native loader reused the previous instance/controller/constructor',
  );
  assert(afterSHA256 === beforeSHA256, 'installed bytes changed during native reload');
  assert(equal(enabledBefore, enabledAfter), 'native reload changed the enabled plugin set');
  assert(
    manager.getPlugin('obsidian-git') === git &&
      manager.getPlugin('darlal-switcher-plus') === chooser,
    'Git or Quick Switcher++ was replaced during reload',
  );
  const afterState = fresh.controller.state;
  assert(
    fresh.controller.busy === null &&
      afterState.activeId === beforeState.activeId &&
      afterState.revision === beforeState.revision &&
      afterState.journal === null,
    'reload changed the committed fixture context',
  );
  return {
    plugin: fresh,
    evidence: {
      status: 'passed',
      mechanism: 'obsidian-1.15.1-native-disable-enable',
      apiVersion,
      beforeSHA256,
      afterSHA256,
      newInstance: true,
      newController: true,
      newConstructor: true,
      providerInstancesPreserved: true,
      enabledBefore,
      enabledAfter,
      before: {
        activeId: beforeState.activeId,
        revision: beforeState.revision,
        journal: beforeState.journal,
      },
      after: {
        activeId: afterState.activeId,
        revision: afterState.revision,
        journal: afterState.journal,
      },
      excludedFromTiming: true,
    },
  };
};
