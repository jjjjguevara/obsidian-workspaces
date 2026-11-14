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
  getViewState(): ViewState;
  setViewState(state: ViewState): Promise<void>;
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

async function host(leaves: Leaf[], document = new EventTarget()): Promise<ObsidianWorkspaceHost> {
  const Constructor = await Host;
  return new Constructor(
    {
      testDocument: document,
      workspace: {
        iterateAllLeaves: (visit: (leaf: Leaf) => void) => leaves.forEach(visit),
        on: () => ({}),
        offref: () => {},
      },
    } as unknown as App,
    async () => true,
  );
}

function leaf(type: string, view: object, close: (state: ViewState) => Promise<void>): Leaf {
  return {
    view,
    getViewState: () => ({ type, state: { file: 'alpha-exclusive.md' } }),
    setViewState: close,
  };
}

test('native file-following sidebar views unload independently and every unload is awaited', async () => {
  const started = deferred();
  const release = deferred();
  const closed: string[] = [];
  const leaves = ['backlink', 'outgoing-link', 'outline'].map((type, index) =>
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
  assert.deepEqual(closed, ['backlink', 'outgoing-link', 'outline']);
  release.resolve();
  await pending;
  assert.deepEqual(closed, ['backlink', 'outgoing-link', 'outline']);
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

test('fast transitions block input in every window immediately without flashing progress', async (t) => {
  const main = new EventTarget();
  const floating = new EventTarget();
  const workspace = await host(
    [leaf('markdown', { containerEl: { ownerDocument: floating } }, async () => {})],
    main,
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const release = workspace.block('Opening Beta…');
  const modal = Modal.instances.at(-1)!;
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
  assert.equal(modal.opens, 0);
  t.mock.timers.tick(499);
  assert.equal(modal.opens, 0);
  release();
  for (const document of [main, floating]) {
    for (const type of guardedEvents) {
      assert.equal(document.dispatchEvent(new Event(type, { cancelable: true })), true);
    }
  }
  t.mock.timers.tick(1000);
  assert.equal(modal.opens, 0, 'A completed transition must cancel the pending progress modal');
  assert.equal(modal.closes, 0, 'An unopened modal must not disturb the active native modal stack');
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
      testDocument: main,
      workspace: {
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
  assert.equal(Modal.instances.at(-1)!.opens, 0);
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
  t.mock.timers.tick(1000);
  assert.equal(Modal.instances.at(-1)!.opens, 0, 'A fast release still cancels progress');
});

test('a slow transition shows progress without releasing input or allowing dismissal', async (t) => {
  const document = new EventTarget();
  const workspace = await host([], document);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const release = workspace.block('Opening Beta…');
  const modal = Modal.instances.at(-1)!;
  t.mock.timers.tick(500);
  assert.equal(modal.opened, true);
  assert.equal(document.dispatchEvent(new Event('beforeinput', { cancelable: true })), false);
  modal.close();
  assert.equal(modal.opened, true);
  assert.equal(modal.closes, 0);
  release();
  assert.equal(modal.opened, false);
  assert.equal(modal.closes, 1);
  assert.equal(document.dispatchEvent(new Event('beforeinput', { cancelable: true })), true);
  t.mock.timers.tick(1000);
  assert.equal(modal.opens, 1);
});

test('restoration hydrates every leaf after native layout creation and waits for completion', async () => {
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
  const pending = workspace.restore({});
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
  const pending = workspace.restore({}).finally(() => {
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
  assert.ok(calls.includes('disk'), 'Ordinary switches still perform full readiness');
});
