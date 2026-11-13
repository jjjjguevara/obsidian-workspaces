import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FileStateStore } from '../../src/storage/store.ts';
import { addWorkspace } from '../../src/workspaces/catalog.ts';
import { emptyState, snapshot, type WorkspaceState } from '../../src/workspaces/model.ts';

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'obsidian-workspaces-storage-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function catalog(revision: number, description = 'Initial context'): WorkspaceState {
  const state = emptyState();
  state.revision = revision;
  state.activeId = addWorkspace(
    state,
    'Writing',
    snapshot({ main: { id: 'main', type: 'split', children: [] } }, 'desktop'),
    { description },
  );
  return state;
}

test('atomic replacement exposes complete revisions and keeps the previous generation', async (t) => {
  const base = await directory(t);
  const location = join(base, 'state.json');
  const store = new FileStateStore(location);
  assert.deepEqual(await store.load(), emptyState());
  const first = catalog(1);
  await store.save(first);
  const second = structuredClone(first);
  second.revision = 2;
  second.workspaces[second.activeId!]!.description = 'Detailed context '.repeat(32_000);
  let finished = false;
  let observed = 0;
  const reader = (async () => {
    while (!finished) {
      const value = JSON.parse(await readFile(location, 'utf8')) as WorkspaceState;
      assert.ok(value.revision === 1 || value.revision === 2);
      assert.deepEqual(value, value.revision === 1 ? first : second);
      observed += 1;
    }
  })();
  try {
    await store.save(second);
  } finally {
    finished = true;
  }
  await reader;
  assert.ok(observed > 0);
  assert.deepEqual(JSON.parse(await readFile(location, 'utf8')), second);
  assert.deepEqual(JSON.parse(await readFile(`${location}.backup`, 'utf8')), first);
  assert.deepEqual((await readdir(base)).sort(), ['state.json', 'state.json.backup']);
});

test('corrupt and future-version files are refused and never silently overwritten', async (t) => {
  const base = await directory(t);
  const location = join(base, 'state.json');
  for (const contents of [
    '{broken json',
    JSON.stringify({ ...emptyState(), version: 99 }),
    JSON.stringify({ ...emptyState(), order: ['missing'] }),
  ]) {
    await writeFile(location, contents);
    const store = new FileStateStore(location);
    await assert.rejects(store.load());
    await assert.rejects(store.save(catalog(1)));
    assert.equal(await readFile(location, 'utf8'), contents);
    assert.deepEqual(await readdir(base), ['state.json']);
  }
});

test('stale writers cannot overwrite a newer revision even if they guess its successor', async (t) => {
  const base = await directory(t);
  const location = join(base, 'state.json');
  const firstWriter = new FileStateStore(location);
  const staleWriter = new FileStateStore(location);
  await firstWriter.load();
  await staleWriter.load();
  const first = catalog(1, 'First writer');
  await firstWriter.save(first);
  await assert.rejects(staleWriter.save(catalog(1, 'Stale writer')), /changed in another instance/);
  await assert.rejects(
    staleWriter.save(catalog(2, 'Guessed revision')),
    /changed in another instance/,
  );
  assert.deepEqual(JSON.parse(await readFile(location, 'utf8')), first);
  const reloaded = await staleWriter.load();
  reloaded.revision += 1;
  reloaded.workspaces[reloaded.activeId!]!.description = 'Reloaded writer';
  await staleWriter.save(reloaded);
  await assert.rejects(firstWriter.save({ ...first, revision: 3 }), /changed in another instance/);
  assert.deepEqual(JSON.parse(await readFile(location, 'utf8')), reloaded);
  const freshWriter = new FileStateStore(location);
  await assert.rejects(freshWriter.save({ ...reloaded, revision: 2 }), /revision is stale/);
});

test('an existing writer lock is preserved rather than stolen or removed', async (t) => {
  const base = await directory(t);
  const location = join(base, 'state.json');
  const lock = `${location}.lock`;
  const ownership = JSON.stringify({ pid: 12345, createdAt: 1 });
  await writeFile(lock, ownership);
  const store = new FileStateStore(location);
  await store.load();
  await assert.rejects(store.save(catalog(1)), /state is locked/);
  assert.equal(await readFile(lock, 'utf8'), ownership);
  await assert.rejects(access(location));
  await rm(lock);
  await store.save(catalog(1));
  await assert.rejects(access(lock));
});

test('outside-repository validation rejects lexical and resolved symlink containment', async (t) => {
  const base = await directory(t);
  const repository = join(base, 'vault');
  const outside = join(base, 'controls');
  await mkdir(repository);
  await mkdir(outside);
  await new FileStateStore(join(outside, 'state.json')).assertOutsideRepository(repository);
  await new FileStateStore(join(base, 'vault-other', 'state.json')).assertOutsideRepository(
    repository,
  );
  await assert.rejects(
    new FileStateStore(join(repository, 'state.json')).assertOutsideRepository(repository),
    /inside the Git repository/,
  );
  await assert.rejects(
    new FileStateStore(join(repository, 'sub', 'state.json')).assertOutsideRepository(repository),
    /inside the Git repository/,
  );

  const disguisedInside = join(base, 'looks-outside');
  await symlink(repository, disguisedInside, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    new FileStateStore(join(disguisedInside, 'state.json')).assertOutsideRepository(repository),
    /inside the Git repository/,
  );

  const checkoutControlledAlias = join(repository, 'external-controls');
  await symlink(
    outside,
    checkoutControlledAlias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    new FileStateStore(join(checkoutControlledAlias, 'state.json')).assertOutsideRepository(
      repository,
    ),
    /inside the Git repository/,
  );
});
