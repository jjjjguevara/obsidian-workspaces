import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { writeAtomicReport } = require('../obsidian/atomic-report.cjs');

async function fixture(t: any) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'workspaces-native-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'report.json');
  const sentinel = join(directory, 'sentinel.json');
  await fs.writeFile(sentinel, '{"preserve":"original"}\n');
  return { directory, output, sentinel };
}

async function loadProbe(name: string) {
  const filename = fileURLToPath(new URL(`../obsidian/${name}.cjs`, import.meta.url));
  const localRequire = createRequire(filename);
  const module: { exports: any } = { exports: {} };
  const verifier =
    name === 'switch-benchmark' ? await loadProbe('quick-switcher-probe') : undefined;
  new Script(await fs.readFile(filename, 'utf8'), { filename }).runInNewContext({
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id === 'obsidian') return { Plugin: class {} };
      if (id === './quick-switcher-probe.cjs' && verifier) return verifier;
      return localRequire(id);
    },
  });
  return module.exports;
}

for (const aliasType of ['symlink', 'hardlink']) {
  test(`deep diagnostic checkpoint writing preserves a preexisting ${aliasType} temporary`, async (t) => {
    const { output, sentinel } = await fixture(t);
    if (aliasType === 'symlink') await fs.symlink(sentinel, `${output}.tmp`);
    else await fs.link(sentinel, `${output}.tmp`);
    const Probe = await loadProbe('switch-benchmark');
    const probe = new Probe();
    probe.config = { runId: 'test', phase: 'deep' };
    probe.result = {};
    probe.traceCheckpointFile = output;
    probe.traceCheckpointIo = { ...fs };
    await probe.writeTraceCheckpoint('test', null, true);
    assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).kind, 'diagnostic-progress-only');
    assert.equal(await fs.readFile(sentinel, 'utf8'), '{"preserve":"original"}\n');
    assert.equal((await fs.lstat(`${output}.tmp`)).isSymbolicLink(), aliasType === 'symlink');
  });
}

for (const probeName of ['runtime-probe', 'quick-switcher-probe']) {
  for (const aliasType of ['symlink', 'hardlink']) {
    test(`${probeName} report writing preserves preexisting temporary and destination ${aliasType} targets`, async (t) => {
      const { directory, output, sentinel } = await fixture(t);
      const oldTemporary = `${output}.tmp`;
      for (const target of [oldTemporary, output]) {
        if (aliasType === 'symlink') await fs.symlink(sentinel, target);
        else await fs.link(sentinel, target);
      }
      const Probe = await loadProbe(probeName);
      const probe = new Probe();
      probe.config = { resultFile: output };
      probe.result = { status: 'running', checks: [{ status: 'passed' }] };
      await probe.writeResult();
      probe.result.status = 'passed';
      await probe.writeResult();
      assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), probe.result);
      assert.equal(await fs.readFile(sentinel, 'utf8'), '{"preserve":"original"}\n');
      assert.equal(await fs.readFile(oldTemporary, 'utf8'), '{"preserve":"original"}\n');
      assert.equal((await fs.lstat(oldTemporary)).isSymbolicLink(), aliasType === 'symlink');
      assert.deepEqual((await fs.readdir(directory)).sort(), [
        'report.json',
        'report.json.tmp',
        'sentinel.json',
      ]);
    });
  }
}

for (const aliasType of ['symlink', 'hardlink']) {
  test(`exclusive native temporary collision leaves an existing ${aliasType} and its target intact`, async (t) => {
    const { output, sentinel } = await fixture(t);
    const temporary = `${output}.collision.tmp`;
    if (aliasType === 'symlink') await fs.symlink(sentinel, temporary);
    else await fs.link(sentinel, temporary);
    await fs.writeFile(output, '{"status":"previous"}\n');
    await assert.rejects(
      writeAtomicReport(output, { status: 'passed' }, { nonce: () => 'collision' }),
      { code: 'EEXIST' },
    );
    assert.equal(await fs.readFile(output, 'utf8'), '{"status":"previous"}\n');
    assert.equal(await fs.readFile(sentinel, 'utf8'), '{"preserve":"original"}\n');
    assert.equal(await fs.readFile(temporary, 'utf8'), '{"preserve":"original"}\n');
    assert.equal((await fs.lstat(temporary)).isSymbolicLink(), aliasType === 'symlink');
  });
}

test('failed native publication removes only the temporary it created and preserves the previous report', async (t) => {
  const { output } = await fixture(t);
  await fs.writeFile(output, '{"status":"previous"}\n');
  await assert.rejects(
    writeAtomicReport(
      output,
      { status: 'passed' },
      {
        nonce: () => 'owned',
        io: {
          ...fs,
          rename: async () => {
            throw new Error('injected publication failure');
          },
        },
      },
    ),
    /injected publication failure/,
  );
  assert.equal(await fs.readFile(output, 'utf8'), '{"status":"previous"}\n');
  await assert.rejects(fs.lstat(`${output}.owned.tmp`), { code: 'ENOENT' });
});

test('failed native publication does not delete an unrelated replacement of its temporary', async (t) => {
  const { output, sentinel } = await fixture(t);
  await fs.writeFile(output, '{"status":"previous"}\n');
  const temporary = `${output}.replaced.tmp`;
  await assert.rejects(
    writeAtomicReport(
      output,
      { status: 'passed' },
      {
        nonce: () => 'replaced',
        io: {
          ...fs,
          rename: async () => {
            await fs.unlink(temporary);
            await fs.symlink(sentinel, temporary);
            throw new Error('injected replacement');
          },
        },
      },
    ),
    /injected replacement/,
  );
  assert.equal((await fs.lstat(temporary)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(sentinel, 'utf8'), '{"preserve":"original"}\n');
  assert.equal(await fs.readFile(output, 'utf8'), '{"status":"previous"}\n');
});

test('native serialization failure cleans its own temporary without publishing partial JSON', async (t) => {
  const { output } = await fixture(t);
  await fs.writeFile(output, '{"status":"previous"}\n');
  const circular: any = {};
  circular.self = circular;
  await assert.rejects(
    writeAtomicReport(output, circular, { nonce: () => 'serialize' }),
    /circular/i,
  );
  assert.equal(await fs.readFile(output, 'utf8'), '{"status":"previous"}\n');
  await assert.rejects(fs.lstat(`${output}.serialize.tmp`), { code: 'ENOENT' });
});

test('every native probe that imports a sibling module is installed as a bundle', async () => {
  // Obsidian resolves a plugin's require() from the renderer, not from the
  // plugin directory. A copied probe with a relative import cannot load.
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const installers: Record<string, string> = {
    'runtime-probe.cjs': 'prepare-runtime-vault.mjs',
    'quick-switcher-probe.cjs': 'prepare-quick-switcher-probe.mjs',
    'switch-benchmark.cjs': 'prepare-switch-benchmark.mjs',
    'runtime-extras.cjs': 'prepare-native-extras.mjs',
    'git-read-transport-probe.cjs': 'prepare-git-read-transport-probe.mjs',
  };
  let bundled = 0;
  for (const [probe, installer] of Object.entries(installers)) {
    const source = await fs.readFile(join(root, 'tests', 'obsidian', probe), 'utf8');
    if (!/\brequire\(\s*['"]\.{1,2}\//.test(source)) continue;
    bundled += 1;
    const script = await fs.readFile(join(root, 'scripts', installer), 'utf8');
    const name = probe.replace(/\.cjs$/, '');
    assert.match(script, /\bbuild\(\{/, `${installer} must bundle ${probe}`);
    assert.doesNotMatch(
      script,
      new RegExp(`copyFile\\([^;]*${name}`),
      `${installer} must not copy ${probe} without its imports`,
    );
  }
  assert.ok(bundled >= 3, 'The probes that share the atomic report writer are covered');
});
