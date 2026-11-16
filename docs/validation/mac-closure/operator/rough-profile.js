// Rough, unfocused attribution probe for a disposable fixture vault only.
// Not acceptance evidence: no endpoint validation, no focus requirement.
(async () => {
  const N = __N__;
  const plugin = app.plugins.plugins['obsidian-workspaces'];
  const controller = plugin.controller;
  const git = app.plugins.plugins['obsidian-git'];
  const manager = git.gitManager;
  const state = controller.state;
  const byName = Object.fromEntries(state.order.map((id) => [state.workspaces[id].name, id]));
  const names = Object.keys(byName);
  const alpha = byName['Alpha'];
  const beta = byName['Beta'];
  if (!alpha || !beta) return JSON.stringify({ error: 'fixture workspaces missing', names });
  if (state.activeId !== alpha || state.journal)
    return JSON.stringify({ error: 'not idle alpha', active: state.activeId });
  const calls = [];
  let t0 = 0;
  const rawOwner = manager.git;
  const originalRaw = rawOwner.raw;
  const originalCheckout = manager.checkout;
  rawOwner.raw = function (args) {
    const entry = { c: args.find((a) => !a.startsWith('-')) ?? args[0], s: performance.now() - t0 };
    calls.push(entry);
    const result = originalRaw.apply(this, arguments);
    Promise.resolve(result).then(
      () => (entry.e = performance.now() - t0),
      () => (entry.e = performance.now() - t0),
    );
    return result;
  };
  manager.checkout = async function () {
    const entry = { c: 'CHECKOUT', s: performance.now() - t0 };
    calls.push(entry);
    try {
      return await originalCheckout.apply(this, arguments);
    } finally {
      entry.e = performance.now() - t0;
    }
  };
  const wrapped = [];
  const wrap = (owner, name, label) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    wrapped.push([owner, name, original]);
    owner[name] = async function () {
      const entry = { c: label, s: performance.now() - t0 };
      calls.push(entry);
      try {
        return await original.apply(this, arguments);
      } finally {
        entry.e = performance.now() - t0;
      }
    };
  };
  for (const name of ['flush', 'quiesce', 'waitForFiles', 'restore'])
    wrap(controller.host, name, name.toUpperCase());
  wrap(controller.store, 'save', 'SAVE');
  const round = (v) => Math.round(v * 10) / 10;
  const totals = [];
  const traces = [];
  try {
    for (let index = 0; index < N; index += 1) {
      const target = index % 2 === 0 ? beta : alpha;
      calls.length = 0;
      t0 = performance.now();
      await controller.activate(target);
      const total = performance.now() - t0;
      totals.push(round(total));
      if (index >= N - 2)
        traces.push(calls.map((c) => `${c.c}@${round(c.s)}-${round(c.e ?? -1)}`).join(' '));
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    rawOwner.raw = originalRaw;
    manager.checkout = originalCheckout;
    for (const [owner, name, original] of wrapped) owner[name] = original;
  }
  const sorted = [...totals].sort((a, b) => a - b);
  return JSON.stringify({
    n: N,
    totals,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    focus: document.hasFocus(),
    visibility: document.visibilityState,
    active: controller.state.workspaces[controller.state.activeId]?.name,
    journal: controller.state.journal,
    traces,
  });
})()
