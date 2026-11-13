import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertRestoredFiles,
  fileLeaves,
  waitForVaultFiles,
  type VaultReadinessPort,
} from '../../src/obsidian/layout-files.ts';
import type { Layout } from '../../src/workspaces/model.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function leaf(path: string, pinned = true, type = 'markdown', id = path) {
  return { id, type: 'leaf', state: { type, pinned, state: { file: path } } };
}

function layout(path: string, type = 'markdown'): Layout {
  return { main: { id: 'main', type: 'split', children: [leaf(path, true, type)] } };
}

function port(overrides: Partial<VaultReadinessPort> = {}): VaultReadinessPort {
  return {
    hasFile: () => true,
    exists: async () => true,
    cachedRead: async () => 'Current content\n',
    diskRead: async () => 'Current content\n',
    matchesStat: async () => true,
    ...overrides,
  };
}

test('same-size stale text cannot pass readiness until cached bytes match disk', async () => {
  let cached = 'ALPHA\n';
  const disk = 'BRAVO\n';
  assert.equal(cached.length, disk.length);
  const checked = deferred();
  let ready = false;
  const pending = waitForVaultFiles(
    layout('shared.md'),
    layout('shared.md'),
    port({
      cachedRead: async () => {
        checked.resolve();
        return cached;
      },
      diskRead: async () => disk,
    }),
    { timeoutMs: 1_000, pollMs: 1 },
  ).then(() => {
    ready = true;
  });
  await checked.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  cached = disk;
  await pending;
  assert.equal(ready, true);
});

test('a source-only deleted note must disappear from the Vault index before readiness', async () => {
  let staleIndexed = true;
  const checked = deferred();
  let ready = false;
  const pending = waitForVaultFiles(
    layout('target.md'),
    layout('source.md'),
    port({
      hasFile: (path) => path !== 'source.md' || staleIndexed,
      exists: async (path) => {
        if (path === 'source.md') {
          checked.resolve();
          return false;
        }
        return true;
      },
    }),
    { timeoutMs: 1_000, pollMs: 1 },
  ).then(() => {
    ready = true;
  });
  await checked.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  staleIndexed = false;
  await pending;
  assert.equal(ready, true);
});

test(
  'a missing target fails within the configured readiness budget',
  { timeout: 1_000 },
  async () => {
    let probes = 0;
    await assert.rejects(
      waitForVaultFiles(
        layout('missing.md'),
        { main: { type: 'split', children: [] } },
        port({
          hasFile: () => {
            probes += 1;
            return false;
          },
          exists: async () => false,
        }),
        { timeoutMs: 15, pollMs: 1 },
      ),
      /missing\.md.*not available/,
    );
    assert.ok(probes >= 2);
  },
);

test('binary readiness waits on matching file metadata without using text reads', async () => {
  let metadataMatches = false;
  const checked = deferred();
  let ready = false;
  const pending = waitForVaultFiles(
    layout('diagram.pdf', 'pdf'),
    { main: { type: 'split', children: [] } },
    port({
      matchesStat: async () => {
        checked.resolve();
        return metadataMatches;
      },
      cachedRead: async () => {
        throw new Error('Binary files must not be read as text');
      },
      diskRead: async () => {
        throw new Error('Binary files must not be read as text');
      },
    }),
    { timeoutMs: 1_000, pollMs: 1 },
  ).then(() => {
    ready = true;
  });
  await checked.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  metadataMatches = true;
  await pending;
  assert.equal(ready, true);
});

test('file leaves cover sidebars and floating windows and accept both native pin encodings', () => {
  const legacy = {
    id: 'legacy',
    type: 'leaf',
    pinned: true,
    state: { type: 'markdown', state: { file: 'left.md' } },
  };
  const expected: Layout = {
    main: { type: 'split', children: [leaf('main.md')] },
    left: { type: 'split', children: [legacy] },
    right: { type: 'tabs', children: [leaf('right.pdf', false, 'pdf')] },
    floating: [{ type: 'window', children: [leaf('floating.md')] }],
    unrelatedPlugin: { file: 'not-a-leaf.md' },
  };
  assert.deepEqual(
    fileLeaves(expected).map((value) => [value.region, value.path, value.pinned]),
    [
      ['main', 'main.md', true],
      ['left', 'left.md', true],
      ['right', 'right.pdf', false],
      ['floating', 'floating.md', true],
    ],
  );
  const actual = structuredClone(expected);
  (actual.main as { children: Array<{ id: string }> }).children[0]!.id = 'a-new-native-leaf-id';
  assert.doesNotThrow(() => assertRestoredFiles(expected, actual));
});

test('restoration verification catches a lost pin even when the expected note is open', () => {
  const expected = layout('pinned.md');
  const actual = { main: { type: 'split', children: [leaf('pinned.md', false)] } };
  assert.throws(() => assertRestoredFiles(expected, actual), /pinned note.*pinned\.md/);
});

test('extra stale file leaves are rejected in main, sidebars and floating windows', async (t) => {
  const expected = layout('current.md');
  for (const region of ['main', 'left', 'right', 'floating'] as const) {
    await t.test(region, () => {
      const actual = structuredClone(expected);
      if (region === 'main')
        (actual.main as { children: unknown[] }).children.push(leaf('stale.md'));
      else actual[region] = { type: 'split', children: [leaf('stale.md')] };
      assert.throws(() => assertRestoredFiles(expected, actual), /retained a file leaf outside/);
    });
  }
});

test('restoration preserves file region and duplicate-leaf multiplicity', () => {
  const expected = {
    main: {
      type: 'split',
      children: [
        leaf('same.md', true, 'markdown', 'one'),
        leaf('same.md', true, 'markdown', 'two'),
      ],
    },
  };
  assert.throws(() => assertRestoredFiles(expected, layout('same.md')), /did not restore/);
  const sidebar = {
    main: { type: 'split', children: [] },
    left: { type: 'tabs', children: [leaf('same.md')] },
  };
  const floating = {
    main: { type: 'split', children: [] },
    floating: { children: [leaf('same.md')] },
  };
  assert.throws(() => assertRestoredFiles(sidebar, floating), /same\.md.*left/);
});
