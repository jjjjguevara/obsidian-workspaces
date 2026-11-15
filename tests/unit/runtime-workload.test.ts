import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error Test-only Node helper intentionally ships without declarations.
import * as runtimeWorkload from '../../scripts/runtime-workload.mjs';
const { generateWorkload, parseWorkload, workloadContent } = runtimeWorkload;

test('fixture scaling keeps legacy defaults and requires an explicit representative profile', () => {
  assert.equal(parseWorkload({}).profile, 'small');
  assert.equal(parseWorkload({}).generatedBytes, 0);
  assert.throws(() => parseWorkload({ '--unchanged-notes': '20' }), /representative/);
  assert.throws(() => parseWorkload({ '--profile': 'representative' }), /additional/);
});

test('fixture scaling rejects missing, malformed and excessive workload sizes before writing', () => {
  for (const value of [undefined, '-1', '1.5', '1e3', 'x', '100001'])
    assert.throws(() => parseWorkload({ '--unchanged-notes': value }));
  assert.throws(() => parseWorkload({ '--profile': undefined }));
  assert.throws(() => parseWorkload({ '--profile': 'other' }));
  assert.throws(() => parseWorkload({ '--note-kib': '0' }));
  assert.throws(
    () =>
      parseWorkload({
        '--profile': 'representative',
        '--branch-notes': '50000',
        '--note-kib': '1024',
      }),
    /512 MiB/,
  );
});

test('generated notes have deterministic exact byte lengths and distinct branch content', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'workspaces-profile-'));
  try {
    const workload = parseWorkload({
      '--profile': 'representative',
      '--unchanged-notes': '33',
      '--branch-notes': '2',
      '--note-kib': '2',
    });
    await generateWorkload(vault, workload, 'common');
    await generateWorkload(vault, workload, 'alpha');
    await generateWorkload(vault, workload, 'beta');
    assert.equal((await readdir(join(vault, 'benchmark-notes/common'))).length, 33);
    const alpha = await readFile(join(vault, 'benchmark-notes/alpha/note-000000.md'));
    const beta = await readFile(join(vault, 'benchmark-notes/beta/note-000000.md'));
    assert.equal(alpha.length, 2048);
    assert.equal(beta.length, 2048);
    assert.equal(alpha.toString(), workloadContent('alpha', 0, 2));
    assert.notDeepEqual(alpha, beta);
    assert.equal(workload.generatedBytes, 37 * 2048);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('generation refuses to overwrite an existing note', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'workspaces-profile-'));
  try {
    const directory = join(vault, 'benchmark-notes/alpha');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'note-000000.md'), 'keep');
    const workload = parseWorkload({ '--profile': 'representative', '--branch-notes': '1' });
    await assert.rejects(generateWorkload(vault, workload, 'alpha'), { code: 'EEXIST' });
    assert.equal(await readFile(join(directory, 'note-000000.md'), 'utf8'), 'keep');
    await assert.rejects(generateWorkload(vault, workload, '..'), /Unknown fixture group/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});
