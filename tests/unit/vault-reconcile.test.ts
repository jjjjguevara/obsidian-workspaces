import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { DataAdapter } from 'obsidian';
import type { reconcileVaultFiles } from '../../src/obsidian/vault-reconcile.ts';

class FileSystemAdapter {}

const bundle = build({
  entryPoints: [fileURLToPath(new URL('../../src/obsidian/vault-reconcile.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian'],
  write: false,
});

async function helper(version = '1.15.1'): Promise<typeof reconcileVaultFiles> {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext((await bundle).outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require(name: string) {
      assert.equal(name, 'obsidian');
      return { apiVersion: version, FileSystemAdapter };
    },
  });
  return module.exports.reconcileVaultFiles as typeof reconcileVaultFiles;
}

const adapter = (value: unknown): DataAdapter => value as DataAdapter;

test('native reconciliation deduplicates vault paths and preserves the adapter receiver', async () => {
  const reconcile = await helper();
  const calls: string[] = [];
  const native = Object.assign(new FileSystemAdapter(), {
    async update(path: string) {
      assert.equal(this, native);
      calls.push(path);
    },
  });
  await reconcile(adapter(native), ['target.md', 'nested/source.md', 'target.md']);
  assert.deepEqual(calls, ['target.md', 'nested/source.md']);
});

test('other versions, adapters, and unavailable capabilities retain normal readiness', async () => {
  let calls = 0;
  const update = () => {
    calls += 1;
  };
  const native = Object.assign(new FileSystemAdapter(), { update });
  for (const version of ['1.14.4', '1.15.0', '1.15.2', '1.16.0', 'unknown']) {
    await (
      await helper(version)
    )(adapter(native), ['note.md']);
  }
  const reconcile = await helper();
  await reconcile(adapter({ update }), ['note.md']);
  await reconcile(adapter(new FileSystemAdapter()), ['note.md']);
  const inaccessible = new FileSystemAdapter();
  Object.defineProperty(inaccessible, 'update', {
    get() {
      throw new Error('Unavailable compatibility method');
    },
  });
  await reconcile(adapter(inaccessible), ['note.md']);
  assert.equal(calls, 0);
});

test('a synchronous failure still starts and drains all other native updates', async () => {
  const reconcile = await helper();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const native = Object.assign(new FileSystemAdapter(), {
    update(path: string) {
      calls.push(path);
      if (path === 'failed.md') throw new Error('Reconciliation failed');
      return delayed;
    },
  });
  let finished = false;
  const pending = reconcile(adapter(native), ['failed.md', 'delayed.md']).then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['failed.md', 'delayed.md']);
  assert.equal(finished, false, 'Failure must not release a pending native update');
  release();
  await pending;
  assert.equal(finished, true, 'A failed hint falls back after every update settles');
});

test('native update is not invoked for external or non-vault paths', async () => {
  const reconcile = await helper();
  const calls: string[] = [];
  const native = Object.assign(new FileSystemAdapter(), {
    async update(path: string) {
      calls.push(path);
    },
  });
  await reconcile(adapter(native), [
    'note.md',
    'file:/outside/note.md',
    '/outside/note.md',
    'C:/outside/note.md',
    '../note.md',
    'folder/../note.md',
    './note.md',
    'folder\\note.md',
    'invalid\0.md',
    '',
    '/',
  ]);
  assert.deepEqual(calls, ['note.md']);
});
