import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
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

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function changes() {
  const listeners = new Set<() => void>();
  let subscriptions = 0;
  let releases = 0;
  return {
    subscribe(onChange: () => void) {
      subscriptions += 1;
      listeners.add(onChange);
      return () => {
        assert.equal(listeners.delete(onChange), true, 'unsubscribe exactly once');
        releases += 1;
      };
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    get active() {
      return listeners.size;
    },
    get subscriptions() {
      return subscriptions;
    },
    get releases() {
      return releases;
    },
  };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  return {
    tick: (milliseconds: number) => t.mock.timers.tick(milliseconds),
    scheduled: t.mock.method(globalThis, 'setTimeout'),
    cleared: t.mock.method(globalThis, 'clearTimeout'),
  };
}

test('readiness subscribes before probes and latches an event before the first sleep', async (t) => {
  const timers = clock(t);
  const events = changes();
  let cached = 'ALPHA\n';
  let reads = 0;
  let ready = false;
  const pending = waitForVaultFiles(
    layout('shared.md'),
    layout('shared.md'),
    port({
      subscribe: events.subscribe,
      hasFile: () => {
        assert.equal(events.active, 1, 'subscribe before the initial probe');
        return true;
      },
      cachedRead: async () => {
        reads += 1;
        return cached;
      },
      diskRead: async () => {
        if (cached === 'ALPHA\n') {
          cached = 'BRAVO\n';
          events.emit();
        }
        return 'BRAVO\n';
      },
    }),
  ).then(() => {
    ready = true;
  });
  await settle();
  assert.equal(ready, true, 'the event must prompt a fresh pass without ticking the poll timer');
  await pending;
  assert.equal(reads, 2);
  assert.equal(timers.scheduled.mock.callCount(), 0);
  assert.equal(events.subscriptions, 1);
  assert.equal(events.releases, 1);
  assert.equal(events.active, 0);
});

test('an event invalidates an otherwise successful pass when an earlier file changed', async (t) => {
  const timers = clock(t);
  const events = changes();
  let earlierPresent = true;
  let changed = false;
  let ready = false;
  const target = { main: { type: 'split', children: [leaf('earlier.md'), leaf('later.md')] } };
  const pending = waitForVaultFiles(
    target,
    target,
    port({
      subscribe: events.subscribe,
      hasFile: (path) => path !== 'earlier.md' || earlierPresent,
      diskRead: async (path) => {
        if (path === 'later.md' && !changed) {
          changed = true;
          earlierPresent = false;
          events.emit();
        }
        return 'Current content\n';
      },
    }),
  ).then(() => {
    ready = true;
  });
  await settle();
  assert.equal(ready, false, 'the first pass inspected earlier.md before the notification');
  earlierPresent = true;
  events.emit();
  await pending;
  assert.equal(ready, true);
  assert.equal(events.active, 0);
  assert.equal(events.releases, 1);
  assert.equal(timers.scheduled.mock.callCount(), timers.cleared.mock.callCount());
});

test('event wakeups revalidate index, disk, metadata, cached bytes and removed source notes', async (t) => {
  const timers = clock(t);
  const events = changes();
  let indexed = false;
  let exists = false;
  let metadataMatches = false;
  let cacheMatches = false;
  let removedSourceIndexed = true;
  let targetProbes = 0;
  let ready = false;
  const pending = waitForVaultFiles(
    layout('target.md'),
    layout('removed.md'),
    port({
      subscribe: events.subscribe,
      hasFile: (path) => {
        if (path === 'removed.md') return removedSourceIndexed;
        targetProbes += 1;
        return indexed;
      },
      exists: async (path) => path !== 'removed.md' && exists,
      matchesStat: async () => metadataMatches,
      cachedRead: async () => (cacheMatches ? 'BRAVO\n' : 'ALPHA\n'),
      diskRead: async () => 'BRAVO\n',
    }),
  ).then(() => {
    ready = true;
  });
  await settle();
  for (const update of [
    () => {}, // A stale/unrelated notification is never evidence of readiness.
    () => {
      indexed = true;
    },
    () => {
      exists = true;
    },
    () => {
      metadataMatches = true;
    },
    () => {
      cacheMatches = true;
    },
  ]) {
    const previousProbes = targetProbes;
    update();
    events.emit();
    await settle();
    assert.equal(ready, false);
    assert.ok(targetProbes > previousProbes, 'each wakeup starts from the target index check');
  }
  removedSourceIndexed = false;
  events.emit();
  await pending;
  assert.equal(ready, true);
  assert.equal(events.active, 0);
  assert.equal(events.releases, 1);
  assert.equal(timers.scheduled.mock.callCount(), timers.cleared.mock.callCount());
});

test('eventless readiness retains the polling fallback and releases its subscription', async (t) => {
  const timers = clock(t);
  const events = changes();
  let indexed = false;
  let ready = false;
  const pending = waitForVaultFiles(
    layout('target.md'),
    layout('target.md'),
    port({ subscribe: events.subscribe, hasFile: () => indexed }),
  ).then(() => {
    ready = true;
  });
  await settle();
  indexed = true;
  timers.tick(99);
  await settle();
  assert.equal(ready, false);
  timers.tick(1);
  await pending;
  assert.equal(ready, true);
  assert.equal(events.releases, 1);
  assert.equal(events.active, 0);
  assert.equal(timers.scheduled.mock.callCount(), timers.cleared.mock.callCount());
});

test('eventless timeout bounds the last poll and cleans up the timer and subscription', async (t) => {
  const timers = clock(t);
  const events = changes();
  const pending = waitForVaultFiles(
    layout('missing.md'),
    layout('missing.md'),
    port({ subscribe: events.subscribe, hasFile: () => false }),
    { timeoutMs: 25, pollMs: 100 },
  );
  const rejected = assert.rejects(pending, /missing\.md.*not available/);
  await settle();
  assert.equal(timers.scheduled.mock.calls[0]!.arguments[1], 25);
  timers.tick(25);
  await rejected;
  assert.equal(events.releases, 1);
  assert.equal(events.active, 0);
  assert.equal(timers.scheduled.mock.callCount(), timers.cleared.mock.callCount());
});

test('probe errors after an event wakeup release the timer and subscription', async (t) => {
  const timers = clock(t);
  const events = changes();
  let indexed = false;
  const pending = waitForVaultFiles(
    layout('target.md'),
    layout('target.md'),
    port({
      subscribe: events.subscribe,
      hasFile: () => indexed,
      exists: async () => {
        throw new Error('broken adapter');
      },
    }),
  );
  const rejected = assert.rejects(pending, /broken adapter/);
  await settle();
  indexed = true;
  events.emit();
  await rejected;
  assert.equal(events.releases, 1);
  assert.equal(events.active, 0);
  assert.equal(timers.scheduled.mock.callCount(), timers.cleared.mock.callCount());
});

test('already-ready files release their subscription without creating a timer', async (t) => {
  const timers = clock(t);
  const events = changes();
  await waitForVaultFiles(
    layout('current.md'),
    layout('current.md'),
    port({ subscribe: events.subscribe }),
  );
  assert.equal(events.subscriptions, 1);
  assert.equal(events.releases, 1);
  assert.equal(events.active, 0);
  assert.equal(timers.scheduled.mock.callCount(), 0);
  assert.equal(timers.cleared.mock.callCount(), 0);
});

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

test('a file-following pane saved on another branch does not block readiness', async () => {
  const target = {
    main: { type: 'split', children: [leaf('note.md')] },
    right: {
      type: 'tabs',
      children: [
        {
          id: 'outline-pane',
          type: 'leaf',
          state: { type: 'outline', state: { file: 'gone.md' } },
        },
      ],
    },
  };
  const previous = {
    main: { type: 'split', children: [leaf('note.md')] },
  };
  await waitForVaultFiles(target, previous, port({ exists: async (path) => path !== 'gone.md' }), {
    timeoutMs: 100,
    pollMs: 1,
  });
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

test('file-following panes are not compared as saved notes', () => {
  const follower = (type: string, file?: string) => ({
    id: `${type}-pane`,
    type: 'leaf',
    state: { type, state: file ? { file } : { linksCollapsed: false } },
  });
  const followers = ['backlink', 'outgoing-link', 'outline', 'localgraph', 'file-properties'];
  const expected = {
    main: { type: 'split', children: [leaf('note.md')] },
    left: { type: 'tabs', children: [follower('localgraph', 'old.md')] },
    right: {
      type: 'tabs',
      children: followers.slice(0, 3).map((type) => follower(type, 'old.md')),
    },
  };
  // After restore a follower can hold the new active file, or no file at all.
  const actual = {
    main: { type: 'split', children: [leaf('note.md')] },
    left: { type: 'tabs', children: [follower('localgraph')] },
    right: {
      type: 'tabs',
      children: [
        follower('backlink', 'note.md'),
        follower('outgoing-link'),
        follower('outline', 'note.md'),
        follower('file-properties', 'note.md'),
      ],
    },
  };
  assert.doesNotThrow(() => assertRestoredFiles(expected, actual));
  assert.doesNotThrow(() => assertRestoredFiles(actual, expected));
  // A real note in a sidebar is still an owned leaf.
  const missingNote = structuredClone(expected);
  (missingNote.right.children as unknown[]).push({
    id: 'side-note',
    type: 'leaf',
    state: { type: 'markdown', state: { file: 'side.md' } },
  });
  assert.throws(
    () => assertRestoredFiles(missingNote, actual),
    /did not restore the note “side.md” in right/,
  );
  assert.throws(
    () => assertRestoredFiles(actual, missingNote),
    /retained a file leaf outside the requested workspace/,
  );
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
