import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { App } from 'obsidian';
import type { ObsidianWorkspaceHost } from '../../src/obsidian/layout.ts';
import type { Layout } from '../../src/workspaces/model.ts';

class FileView {
  file = { path: 'alpha-exclusive.md' };
}
class TextFileView extends FileView {}
class FileSystemAdapter {}
class TFile {
  stat = { size: 5, mtime: 1 };
  constructor(readonly path: string) {}
}

class Modal {
  static instances: Modal[] = [];
  readonly containerEl: { ownerDocument: EventTarget };
  readonly modalEl = { addClass: () => {} };
  readonly contentEl = { createEl: () => {} };
  opened = false;
  opens = 0;
  closes = 0;
  constructor(app: { testDocument: EventTarget }) {
    this.containerEl = { ownerDocument: app.testDocument };
    Modal.instances.push(this);
  }
  setTitle() {}
  onOpen() {}
  open() {
    this.opened = true;
    this.opens += 1;
    this.onOpen();
  }
  close() {
    this.opened = false;
    this.closes += 1;
  }
}

interface ViewState {
  type: string;
  state?: { file?: string };
  pinned?: boolean;
}
interface Leaf {
  view: object;
  isDeferred?: boolean;
  getViewState(): ViewState;
  setViewState(state: ViewState): Promise<void>;
  loadIfDeferred(): Promise<void>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const Host = (async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../src/obsidian/layout.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    external: ['obsidian'],
    write: false,
  });
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(bundle.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    require(name: string) {
      assert.equal(name, 'obsidian');
      return { FileView, TextFileView, Modal, TFile, FileSystemAdapter, apiVersion: '1.15.1' };
    },
  });
  return module.exports.ObsidianWorkspaceHost as typeof ObsidianWorkspaceHost;
})();

async function host(
  leaves: Leaf[],
  document = new EventTarget(),
  showProgress?: (message: string) => () => void,
): Promise<ObsidianWorkspaceHost> {
  const Constructor = await Host;
  return new Constructor(
    {
      workspace: {
        containerEl: { ownerDocument: document },
        iterateAllLeaves: (visit: (leaf: Leaf) => void) => leaves.forEach(visit),
        on: () => ({}),
        offref: () => {},
      },
    } as unknown as App,
    async () => true,
    undefined,
    showProgress,
  );
}

/** Obsidian's own panes that follow the active note; a checkout unloads them. */
const FOLLOWER_PANES = ['backlink', 'outgoing-link', 'outline', 'localgraph', 'file-properties'];

function leaf(type: string, view: object, close: (state: ViewState) => Promise<void>): Leaf {
  return {
    view,
    getViewState: () => ({ type, state: { file: 'alpha-exclusive.md' } }),
    setViewState: close,
    loadIfDeferred: async () => {},
  };
}

/** Obsidian keeps a placeholder view, not a FileView, until a deferred leaf loads. */
function deferredLeaf(
  type: string,
  loaded: object,
  log: string[],
  gate?: Promise<void>,
): Leaf & { isDeferred: boolean } {
  const value = {
    view: {} as object,
    isDeferred: true,
    getViewState: () => ({ type, state: { file: 'alpha-exclusive.md' } }),
    setViewState: async (state: ViewState) => {
      log.push(`close:${type}:${state.type}`);
    },
    async loadIfDeferred() {
      if (!value.isDeferred) return;
      log.push(`load:${type}:start`);
      await gate;
      value.view = loaded;
      value.isDeferred = false;
      log.push(`load:${type}:end`);
    },
  };
  return value;
}

test('flush saves loaded text views and leaves a deferred leaf deferred', async () => {
  const log: string[] = [];
  const saving = deferred();
  const text = (name: string, wait?: Promise<void>) =>
    Object.assign(new TextFileView(), {
      async save() {
        log.push(`save:${name}:start`);
        await wait;
        log.push(`save:${name}:end`);
      },
    });
  const hidden = deferredLeaf('markdown', new TextFileView(), log);
  const workspace = await host([
    leaf('markdown', text('first', saving.promise), async () => {}),
    hidden,
    leaf('pdf', new FileView(), async () => {}),
    leaf('markdown', text('second'), async () => {}),
  ]);
  let finished = false;
  const pending = workspace.flush().then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['save:first:start'], 'Each save is awaited before the next one starts');
  assert.equal(finished, false);
  saving.resolve();
  await pending;
  assert.deepEqual(log, [
    'save:first:start',
    'save:first:end',
    'save:second:start',
    'save:second:end',
  ]);
  assert.equal(hidden.isDeferred, true, 'A deferred leaf has no buffer and must not be loaded');
});

test('the checkout preflight loads deferred leaves in order before its checks', async () => {
  const log: string[] = [];
  const first = deferred();
  const leaves = [
    deferredLeaf('markdown', new TextFileView(), log, first.promise),
    deferredLeaf('outline', new FileView(), log),
  ];
  const workspace = await host(leaves);
  let finished = false;
  const pending = workspace.assertCanQuiesce().then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['load:markdown:start'], 'Deferred leaves load one after another');
  assert.equal(finished, false);
  first.resolve();
  // Unloaded, the Markdown leaf is a file-backed non-FileView and would be rejected.
  await pending;
  assert.deepEqual(log, [
    'load:markdown:start',
    'load:markdown:end',
    'load:outline:start',
    'load:outline:end',
  ]);
  await workspace.quiesce();
  assert.deepEqual(log.slice(4).sort(), ['close:markdown:empty', 'close:outline:empty']);
});

test('a deferred unsupported editor is loaded, then blocks the checkout before any unload', async () => {
  const log: string[] = [];
  const leaves = [
    deferredLeaf('markdown', new TextFileView(), log),
    deferredLeaf('custom-editor', new FileView(), log),
  ];
  for (const check of ['assertCanQuiesce', 'quiesce'] as const) {
    const workspace = await host(leaves);
    await assert.rejects(
      workspace[check](),
      /Close the “custom-editor” editor before switching branches/,
    );
  }
  assert.equal(
    leaves.every((value) => !value.isDeferred),
    true,
  );
  assert.equal(
    log.some((entry) => entry.startsWith('close:')),
    false,
    'A rejected preflight must not unload a leaf',
  );
});

test('native file-following sidebar views unload independently and every unload is awaited', async () => {
  const started = deferred();
  const release = deferred();
  const closed: string[] = [];
  const leaves = FOLLOWER_PANES.map((type, index) =>
    leaf(type, new FileView(), async (state) => {
      assert.equal(state.type, 'empty');
      assert.equal(state.pinned, false);
      closed.push(type);
      if (index === 0) {
        started.resolve();
        await release.promise;
      }
    }),
  );
  const workspace = await host(leaves);
  await workspace.assertCanQuiesce();
  assert.deepEqual(closed, []);
  let completed = false;
  const pending = workspace.quiesce().then(() => {
    completed = true;
  });
  await started.promise;
  assert.equal(completed, false);
  assert.deepEqual(closed, FOLLOWER_PANES);
  release.resolve();
  await pending;
  assert.deepEqual(closed, FOLLOWER_PANES);
});

test('a rejected native unload waits for every other started unload before reporting failure', async () => {
  const delayed = deferred();
  const failure = new Error('Native unload failed');
  const started: string[] = [];
  const workspace = await host([
    leaf('markdown', new TextFileView(), () => {
      started.push('failed');
      throw failure;
    }),
    leaf(
      'markdown',
      Object.assign(new TextFileView(), { file: { path: 'another-note.md' } }),
      async () => {
        started.push('delayed');
        await delayed.promise;
      },
    ),
    leaf('outline', new FileView(), async () => {
      started.push('outline');
    }),
  ]);
  let completed = false;
  const pending = workspace.quiesce().finally(() => {
    completed = true;
  });
  const rejected = assert.rejects(pending, (error) => error === failure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['failed', 'delayed', 'outline']);
  assert.equal(completed, false, 'A failed close must retain ownership of pending unloads');
  delayed.resolve();
  await rejected;
  assert.equal(completed, true);
});

test('editable views of one file retain close-write order while another file closes', async () => {
  const delayed = deferred();
  const started: string[] = [];
  const writes: string[] = [];
  const workspace = await host([
    leaf('markdown', new TextFileView(), async () => {
      started.push('first');
      await delayed.promise;
      writes.push('first');
    }),
    leaf('markdown', new TextFileView(), async () => {
      started.push('second');
      writes.push('second');
    }),
    leaf(
      'markdown',
      Object.assign(new TextFileView(), { file: { path: 'another-note.md' } }),
      async () => {
        started.push('other-file');
        writes.push('other-file');
      },
    ),
  ]);
  const pending = workspace.quiesce();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'other-file']);
  assert.deepEqual(writes, ['other-file']);
  delayed.resolve();
  await pending;
  assert.deepEqual(started, ['first', 'other-file', 'second']);
  assert.deepEqual(writes, ['other-file', 'first', 'second']);
});

test('a failed close stops later same-file saves while independent unloads still drain', async () => {
  const delayed = deferred();
  const failure = new Error('First editor could not save');
  const started: string[] = [];
  const workspace = await host([
    leaf('markdown', new TextFileView(), async () => {
      started.push('failed');
      throw failure;
    }),
    leaf('markdown', new TextFileView(), async () => {
      started.push('same-file');
    }),
    leaf(
      'markdown',
      Object.assign(new TextFileView(), { file: { path: 'another-note.md' } }),
      async () => {
        started.push('independent');
        await delayed.promise;
      },
    ),
  ]);
  let completed = false;
  const pending = workspace.quiesce().finally(() => {
    completed = true;
  });
  const rejected = assert.rejects(pending, (error) => error === failure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['failed', 'independent']);
  assert.equal(completed, false, 'An independent unload must finish before failure is reported');
  delayed.resolve();
  await rejected;
  assert.deepEqual(
    started,
    ['failed', 'independent'],
    'Do not save another editor over a failed save',
  );
  assert.equal(completed, true);
});

test('an unknown editable FileView blocks before any supported leaf is unloaded', async () => {
  const closed: string[] = [];
  const workspace = await host([
    leaf('outline', new FileView(), async () => {
      closed.push('outline');
    }),
    leaf('custom-editor', new FileView(), async () => {
      closed.push('custom-editor');
    }),
  ]);
  await assert.rejects(
    workspace.quiesce(),
    /Close the “custom-editor” editor before switching branches/,
  );
  assert.deepEqual(closed, []);
});

test('a core-looking type does not exempt an unknown file-backed non-FileView', async () => {
  let closed = false;
  const workspace = await host([
    leaf('outline', {}, async () => {
      closed = true;
    }),
  ]);
  await assert.rejects(workspace.quiesce(), /save lifecycle is not supported/);
  assert.equal(closed, false);
});

test('a transition blocks input in every window at once and shows its message in the status bar', async () => {
  const main = new EventTarget();
  const floating = new EventTarget();
  const shown: string[] = [];
  let hidden = 0;
  const workspace = await host(
    [leaf('markdown', { containerEl: { ownerDocument: floating } }, async () => {})],
    main,
    (message) => {
      shown.push(message);
      return () => {
        hidden += 1;
      };
    },
  );
  const release = workspace.block('Opening Beta…');
  // No delay and no modal: the message is up as soon as the transition owns input.
  assert.deepEqual(shown, ['Opening Beta…']);
  assert.equal(hidden, 0);
  const guardedEvents = [
    'keydown',
    'beforeinput',
    'pointerdown',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'drop',
    'paste',
  ];
  for (const document of [main, floating]) {
    for (const type of guardedEvents) {
      assert.equal(document.dispatchEvent(new Event(type, { cancelable: true })), false);
    }
  }
  release();
  release();
  assert.equal(hidden, 1, 'The message is cleared exactly once');
  for (const document of [main, floating]) {
    for (const type of guardedEvents) {
      assert.equal(document.dispatchEvent(new Event(type, { cancelable: true })), true);
    }
  }
  assert.equal(Modal.instances.length, 0, 'A transition never creates a modal');
});

test('activation handlers in existing and newly opened windows stay blocked until release', async (t) => {
  const Constructor = await Host;
  const main = new EventTarget();
  const floating = new EventTarget();
  const newFloating = new EventTarget();
  const windowRef = {};
  let onWindowOpen:
    ((workspaceWindow: object, window: { document: EventTarget }) => void) | undefined;
  let subscriptions = 0;
  let releases = 0;
  const workspace = new Constructor(
    {
      workspace: {
        containerEl: { ownerDocument: main },
        iterateAllLeaves: (visit: (leaf: object) => void) => {
          visit({ view: { containerEl: { ownerDocument: floating } } });
        },
        on: (event: string, callback: typeof onWindowOpen) => {
          assert.equal(event, 'window-open');
          subscriptions += 1;
          onWindowOpen = callback;
          return windowRef;
        },
        offref: (ref: object) => {
          assert.equal(ref, windowRef);
          releases += 1;
          onWindowOpen = undefined;
        },
      },
    } as unknown as App,
    async () => true,
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const eventTypes = ['click', 'dblclick', 'auxclick', 'contextmenu'];
  const documents = [main, floating, newFloating];
  const added = documents.map((document) => t.mock.method(document, 'addEventListener'));
  const release = workspace.block('Opening Beta…');
  assert.equal(subscriptions, 1);
  assert.ok(onWindowOpen);
  onWindowOpen({}, { document: newFloating });
  const activations: string[] = [];
  for (const [index, document] of documents.entries()) {
    for (const type of eventTypes) {
      assert.ok(
        added[index]!.mock.calls.some(
          ({ arguments: args }) =>
            args[0] === type &&
            typeof args[2] === 'object' &&
            args[2] !== null &&
            args[2].capture === true,
        ),
        `${type} must be intercepted during capture before native target handlers`,
      );
      document.addEventListener(type, () => activations.push(`${index}:${type}`));
      assert.equal(document.dispatchEvent(new Event(type, { cancelable: true })), false);
    }
  }
  assert.deepEqual(activations, []);
  release();
  release();
  assert.equal(releases, 1, 'Remove the new-window subscription exactly once');
  assert.equal(onWindowOpen, undefined);
  for (const document of documents) {
    for (const type of eventTypes) {
      assert.equal(document.dispatchEvent(new Event(type, { cancelable: true })), true);
    }
  }
  assert.equal(activations.length, documents.length * eventTypes.length);
  assert.equal(Modal.instances.length, 0);
});

test('a slow transition keeps its message and its input block until release', async (t) => {
  const document = new EventTarget();
  let visible = false;
  const workspace = await host([], document, () => {
    visible = true;
    return () => {
      visible = false;
    };
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const release = workspace.block('Opening Beta…');
  t.mock.timers.tick(60_000);
  assert.equal(visible, true, 'No timer hides the message while the transition runs');
  assert.equal(document.dispatchEvent(new Event('beforeinput', { cancelable: true })), false);
  release();
  assert.equal(visible, false);
  assert.equal(document.dispatchEvent(new Event('beforeinput', { cancelable: true })), true);
});

test('a failing progress presenter cannot weaken or leak the input block', async () => {
  const document = new EventTarget();
  const failsToShow = await host([], document, () => {
    throw new Error('status bar unavailable');
  });
  const first = failsToShow.block('Opening Beta…');
  assert.equal(document.dispatchEvent(new Event('keydown', { cancelable: true })), false);
  first();
  assert.equal(document.dispatchEvent(new Event('keydown', { cancelable: true })), true);
  const failsToHide = await host([], document, () => () => {
    throw new Error('status bar unavailable');
  });
  const second = failsToHide.block('Opening Beta…');
  assert.doesNotThrow(second);
  assert.equal(document.dispatchEvent(new Event('keydown', { cancelable: true })), true);
});

test('restoration after a checkout hydrates every leaf after native layout creation and waits for completion', async () => {
  const Constructor = await Host;
  const layoutReady = deferred();
  const leafReady = [deferred(), deferred()];
  const started: number[] = [];
  const finished: number[] = [];
  let captured = false;
  const nativeLeaves = leafReady.map((ready, index) => ({
    async loadIfDeferred() {
      started.push(index);
      await ready.promise;
      finished.push(index);
    },
  }));
  const workspace = new Constructor(
    {
      workspace: {
        changeLayout: () => layoutReady.promise,
        iterateAllLeaves: (visit: (leaf: object) => void) => nativeLeaves.forEach(visit),
        getLayout: () => {
          assert.equal(finished.length, 2, 'Verify the layout only after all leaves finish');
          captured = true;
          return {};
        },
      },
    } as unknown as App,
    async () => true,
  );
  const pending = workspace.restore({}, { hydrate: true });
  assert.deepEqual(started, []);
  layoutReady.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1], 'Independent hydration must start together');
  leafReady[0]!.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(captured, false);
  leafReady[1]!.resolve();
  await pending;
  assert.equal(captured, true);
});

test('a failed hydration retains transition ownership until every started leaf settles', async () => {
  const Constructor = await Host;
  const delayed = deferred();
  const failure = new Error('Deferred note failed to load');
  let delayedStarted = false;
  let finished = false;
  const nativeLeaves = [
    {
      loadIfDeferred() {
        throw failure;
      },
    },
    {
      async loadIfDeferred() {
        delayedStarted = true;
        await delayed.promise;
      },
    },
  ];
  const workspace = new Constructor(
    {
      workspace: {
        changeLayout: async () => {},
        iterateAllLeaves: (visit: (leaf: object) => void) => nativeLeaves.forEach(visit),
        getLayout: () => assert.fail('A failed hydration must not verify success'),
      },
    } as unknown as App,
    async () => true,
  );
  const pending = workspace.restore({}, { hydrate: true }).finally(() => {
    finished = true;
  });
  const rejected = assert.rejects(pending, (error) => error === failure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delayedStarted, true);
  assert.equal(finished, false);
  delayed.resolve();
  await rejected;
  assert.equal(finished, true);
});

/** A native workspace that applies the requested layout, or the layout that a test substitutes. */
async function restoring(options: {
  indexed: string[];
  applied?: (requested: Layout) => Layout;
  leaves?: object[];
}) {
  const Constructor = await Host;
  const calls: string[] = [];
  const notices: string[] = [];
  let live: Layout = {};
  const workspace = new Constructor(
    {
      vault: {
        getAbstractFileByPath: (path: string) => {
          calls.push(`index:${path}`);
          return options.indexed.includes(path) ? new TFile(path) : null;
        },
      },
      workspace: {
        changeLayout: async (requested: Layout) => {
          calls.push('changeLayout');
          live = options.applied ? options.applied(requested) : requested;
        },
        iterateAllLeaves: (visit: (leaf: object) => void) => (options.leaves ?? []).forEach(visit),
        getLayout: () => live,
      },
    } as unknown as App,
    async () => true,
    (message) => notices.push(message),
  );
  return { workspace, calls, notices };
}

const note = (path: string, pinned = false) => ({
  type: 'leaf',
  state: { type: 'markdown', pinned, state: { file: path } },
});
const tabs = (...children: object[]): Layout => ({ main: { type: 'tabs', children } });

test('restoration without a checkout loads no deferred view and still verifies the file leaves', async () => {
  const hidden = {
    loadIfDeferred: () => assert.fail('A layout-only switch must not load a deferred view'),
  };
  const complete = await restoring({ indexed: ['a.md', 'b.md'], leaves: [hidden] });
  for (const options of [undefined, {}, { hydrate: false }])
    await complete.workspace.restore(tabs(note('a.md', true), note('b.md')), options);
  assert.deepEqual(complete.notices, []);

  const lostPin = await restoring({
    indexed: ['a.md', 'b.md'],
    leaves: [hidden],
    applied: () => tabs(note('a.md'), note('b.md')),
  });
  await assert.rejects(
    lostPin.workspace.restore(tabs(note('a.md', true), note('b.md')), { hydrate: false }),
    /did not restore the pinned note “a\.md”/,
  );
});

test('a layout with a missing note restores, is verified without it, and names it in one notice', async (t) => {
  const requested = tabs(note('present.md', true), note('gone.md', true));
  for (const [name, applied] of [
    // Obsidian can keep the leaf with its saved file state (a deferred leaf).
    ['the leaf keeps its file state', (layout: Layout) => layout],
    [
      'the leaf becomes an empty tab',
      () => tabs(note('present.md', true), { type: 'leaf', state: { type: 'empty', state: {} } }),
    ],
  ] as const) {
    await t.test(name, async () => {
      for (const hydrate of [false, true]) {
        const f = await restoring({ indexed: ['present.md'], applied });
        await f.workspace.restore(requested, { hydrate });
        assert.deepEqual(f.notices, [
          'Workspaces opened this layout without 1 missing note: “gone.md”.',
        ]);
        assert.ok(
          f.calls.indexOf('index:gone.md') < f.calls.indexOf('changeLayout'),
          'Missing notes are read from the index before the layout changes',
        );
      }
    });
  }
  await t.test('a present note that was not restored still fails, with no notice', async () => {
    const f = await restoring({
      indexed: ['present.md'],
      applied: () => tabs(note('gone.md', true)),
    });
    await assert.rejects(f.workspace.restore(requested), /did not restore.*present\.md/);
    assert.deepEqual(f.notices, []);
  });
  await t.test('the notice lists at most three names', async () => {
    const paths = ['a.md', 'b.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const f = await restoring({ indexed: [] });
    await f.workspace.restore(tabs(...paths.map((path) => note(path))));
    assert.deepEqual(f.notices, [
      'Workspaces opened this layout without 5 missing notes: “a.md”, “b.md”, “c.md” and 2 more.',
    ]);
  });
});

test('post-checkout reconciliation drains failed hints before running full readiness probes', async () => {
  const Constructor = await Host;
  const delayed = deferred();
  const calls: string[] = [];
  const target = new TFile('target.md');
  const adapter = Object.assign(new FileSystemAdapter(), {
    update(path: string) {
      calls.push(`update:${path}`);
      if (path === 'target.md') throw new Error('Optional native update failed');
      return delayed.promise;
    },
    async exists(path: string) {
      calls.push(`exists:${path}`);
      return path === 'target.md';
    },
    async stat() {
      calls.push('stat');
      return { type: 'file', ...target.stat };
    },
    async read() {
      calls.push('disk');
      return 'ready';
    },
  });
  const workspace = new Constructor(
    {
      vault: {
        adapter,
        getAbstractFileByPath: (path: string) => (path === 'target.md' ? target : null),
        cachedRead: async () => {
          calls.push('cache');
          return 'ready';
        },
        on: () => ({}),
        offref: () => {},
      },
    } as unknown as App,
    async () => true,
  );
  const layout = (path: string): Layout => ({
    main: { type: 'leaf', state: { type: 'markdown', state: { file: path } } },
  });
  const pending = workspace.waitForFiles(layout('target.md'), layout('source.md'), {
    afterCheckout: true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['update:target.md', 'update:source.md']);
  delayed.resolve();
  await pending;
  for (const probe of ['exists:target.md', 'stat', 'cache', 'disk', 'exists:source.md']) {
    assert.ok(calls.includes(probe), `Reconciliation cannot replace the ${probe} probe`);
  }
  calls.length = 0;
  await workspace.waitForFiles(layout('target.md'), layout('source.md'));
  assert.equal(
    calls.some((call) => call.startsWith('update:')),
    false,
  );
  // The controller waits only after a checkout. A wait without the hint still probes fully.
  assert.ok(calls.includes('disk'), 'A wait without the checkout hint keeps full readiness');
});
