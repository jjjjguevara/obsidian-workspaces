import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';

let resolveEvidenceOutput: (...args: any[]) => Promise<string>;
let publishPreparedReport: (...args: any[]) => Promise<void>;
let archiveEvidenceOutput: (...args: any[]) => Promise<string>;
before(async () => {
  ({ resolveEvidenceOutput, publishPreparedReport, archiveEvidenceOutput } = await import(
    new URL('../../scripts/benchmark-output.mjs', import.meta.url).href
  ));
});
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'workspaces-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = join(directory, 'vault');
  await mkdir(vault);
  return { directory, vault };
}

test('preparation rejects an outside report symlink before changing its fixture target', async (t) => {
  const { directory, vault } = await fixture(t);
  const target = join(vault, 'important.json');
  await writeFile(target, '{"keep":"original"}\n');
  const alias = join(directory, 'result.json');
  await symlink(target, alias);
  await assert.rejects(resolveEvidenceOutput(vault, alias), /regular file/);
  assert.equal(await readFile(target, 'utf8'), '{"keep":"original"}\n');
});

test('preparation resolves directory aliases before creating missing report directories', async (t) => {
  const { directory, vault } = await fixture(t);
  const alias = join(directory, 'outside-alias');
  await symlink(vault, alias, 'dir');
  await assert.rejects(
    resolveEvidenceOutput(vault, join(alias, 'new-folder/result.json')),
    /inside the vault/,
  );
  await assert.rejects(stat(join(vault, 'new-folder')), { code: 'ENOENT' });
});

test('atomic prepared publication replaces an external hardlink without changing linked vault data', async (t) => {
  const { directory, vault } = await fixture(t);
  const target = join(vault, 'important.json');
  await writeFile(target, '{"keep":"original"}\n');
  const alias = join(directory, 'report.json');
  await link(target, alias);
  const output = await resolveEvidenceOutput(vault, alias);
  await publishPreparedReport(output, { status: 'prepared' });
  assert.equal(await readFile(target, 'utf8'), '{"keep":"original"}\n');
  assert.deepEqual(JSON.parse(await readFile(alias, 'utf8')), { status: 'prepared' });
});

test('a nonregular selected report is refused without mutation', async (t) => {
  const { directory, vault } = await fixture(t);
  const output = join(directory, 'report.json');
  await mkdir(output);
  await assert.rejects(resolveEvidenceOutput(vault, output), /regular file/);
  assert.equal((await stat(output)).isDirectory(), true);
});

for (const aliasType of ['symlink', 'hardlink']) {
  test(`an existing archive ${aliasType} never overwrites its target`, async (t) => {
    const { directory, vault } = await fixture(t);
    const target = join(vault, 'important.json');
    await writeFile(target, '{"keep":"original"}\n');
    const report = join(directory, 'report.json');
    await writeFile(report, '{"status":"failed"}\n');
    const alias = `${report}.existing.json`;
    if (aliasType === 'symlink') await symlink(target, alias);
    else await link(target, alias);
    await assert.rejects(archiveEvidenceOutput(report, 'existing'), { code: 'EEXIST' });
    assert.equal(await readFile(target, 'utf8'), '{"keep":"original"}\n');
    assert.equal(await readFile(report, 'utf8'), '{"status":"failed"}\n');
  });
}

test('archives use fresh names and reject path-bearing supplied suffixes', async (t) => {
  const { directory } = await fixture(t);
  const report = join(directory, 'report.json');
  await writeFile(report, '{"status":"failed"}\n');
  const first = await archiveEvidenceOutput(report);
  const second = await archiveEvidenceOutput(report);
  assert.notEqual(first, second);
  assert.equal(await readFile(first, 'utf8'), await readFile(second, 'utf8'));
  await assert.rejects(
    archiveEvidenceOutput(report, '../overwrite'),
    /Invalid evidence archive suffix/,
  );
});
