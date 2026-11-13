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
    require(name: string) {
      assert.equal(name, 'obsidian');
      return { FileView, TextFileView, Modal: class {}, TFile: class {} };
    },
  });
  return module.exports.ObsidianWorkspaceHost as typeof ObsidianWorkspaceHost;
})();

async function host(leaves: Leaf[]): Promise<ObsidianWorkspaceHost> {
  const Constructor = await Host;
  return new Constructor(
    {
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
