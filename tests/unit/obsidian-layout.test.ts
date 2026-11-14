import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { App } from 'obsidian';
import type { ObsidianWorkspaceHost } from '../../src/obsidian/layout.ts';

class FileView {
  file = { path: 'alpha-exclusive.md' };
}
class TextFileView extends FileView {}

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
      return { FileView, TextFileView, Modal, TFile: class {} };
    },
  });
  return module.exports.ObsidianWorkspaceHost as typeof ObsidianWorkspaceHost;
})();

async function host(leaves: Leaf[], document = new EventTarget()): Promise<ObsidianWorkspaceHost> {
  const Constructor = await Host;
  return new Constructor(
    {
      testDocument: document,
      workspace: { iterateAllLeaves: (visit: (leaf: Leaf) => void) => leaves.forEach(visit) },
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

test('native file-following sidebar views pass preflight and their unloads are awaited', async () => {
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
  assert.deepEqual(closed, ['backlink']);
  release.resolve();
  await pending;
  assert.deepEqual(closed, ['backlink', 'outgoing-link', 'outline']);
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
  for (const document of [main, floating]) {
    for (const type of ['keydown', 'beforeinput', 'pointerdown', 'drop', 'paste']) {
      assert.equal(document.dispatchEvent(new Event(type, { cancelable: true })), false);
    }
  }
  assert.equal(modal.opens, 0);
  t.mock.timers.tick(499);
  assert.equal(modal.opens, 0);
  release();
  for (const document of [main, floating]) {
    assert.equal(document.dispatchEvent(new Event('keydown', { cancelable: true })), true);
  }
  t.mock.timers.tick(1000);
  assert.equal(modal.opens, 0, 'A completed transition must cancel the pending progress modal');
  assert.equal(modal.closes, 0, 'An unopened modal must not disturb the active native modal stack');
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
