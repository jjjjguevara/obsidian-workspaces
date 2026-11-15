import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { closure } = require('../obsidian/benchmark-test-fixtures.cjs');
const gate = fileURLToPath(new URL('../../scripts/check-switch-performance.mjs', import.meta.url));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function writeFixture(t: any, compressed = false) {
  const directory = await mkdtemp(join(tmpdir(), 'workspaces-journal-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { manifest, evidence } = closure();
  for (const session of manifest.sessions) {
    for (const role of ['baseline', 'candidate']) {
      const ref = session[role];
      const report = evidence.get(ref.path).report;
      const raw = evidence.get(ref.journal.path).journalBytes;
      // Native absolute paths intentionally do not exist on this test host.
      // The portable manifest reference, including a relocated archive, wins.
      ref.journal.path = `journals/${ref.journal.path}${compressed ? '.gz' : ''}`;
      if (compressed) ref.path += '.gz';
      const journal = compressed ? gzipSync(raw) : raw;
      ref.journal.sha256 = hash(journal);
      await mkdir(dirname(join(directory, ref.journal.path)), { recursive: true });
      await writeFile(join(directory, ref.journal.path), journal);
      const json = Buffer.from(JSON.stringify(report));
      const bytes = compressed ? gzipSync(json) : json;
      ref.sha256 = hash(bytes);
      await writeFile(join(directory, ref.path), bytes);
    }
  }
  for (const ref of manifest.safetyReports) {
    const bytes = JSON.stringify(evidence.get(ref.path).report);
    ref.sha256 = hash(bytes);
    await writeFile(join(directory, ref.path), bytes);
  }
  const filename = join(directory, 'manifest.json');
  await writeFile(filename, JSON.stringify(manifest));
  return { directory, manifest, filename };
}

async function invoke(fixture: any, expected: 'passed' | 'blocked', reason?: RegExp) {
  await writeFile(fixture.filename, JSON.stringify(fixture.manifest));
  const output = join(fixture.directory, 'closure-result.json');
  const execution = spawnSync(process.execPath, [gate, fixture.filename, '--output', output], {
    encoding: 'utf8',
    maxBuffer: 2_000_000,
  });
  assert.equal(execution.status, expected === 'passed' ? 0 : 1, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.status, expected, JSON.stringify(result.failures));
  assert.equal(result.closureAllowed, expected === 'passed');
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
  if (reason) assert.match(result.failures.join('\n'), reason);
  return result;
}

async function alterJournal(fixture: any, transform: (text: string) => string) {
  const ref = fixture.manifest.sessions[0].candidate;
  const reportFile = join(fixture.directory, ref.path);
  const journalFile = join(fixture.directory, ref.journal.path);
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  const changed = Buffer.from(transform(await readFile(journalFile, 'utf8')));
  // Recompute all supplied byte hashes so semantic corruption cannot be
  // rejected only because the test forgot to update an integrity checksum.
  ref.journal.sha256 = hash(changed);
  report.recorder.journalSHA256 = hash(changed);
  report.recorder.journalBytes = changed.length;
  await writeFile(journalFile, changed);
  const json = JSON.stringify(report);
  ref.sha256 = hash(json);
  await writeFile(reportFile, json);
}

for (const compressed of [false, true]) {
  test(`CLI verifies complete portable ${compressed ? 'gzip' : 'plain'} journals and reports`, async (t) => {
    const fixture = await writeFixture(t, compressed);
    const result = await invoke(fixture, 'passed');
    assert.equal(result.sessions.length, 6);
    for (const session of result.sessions)
      for (const role of ['baseline', 'candidate']) {
        assert.equal(session.journals[role].completed, 150);
        assert.equal(session.journals[role].status, 'passed');
      }
  });
}

test('CLI blocks an absent journal file instead of accepting its declared hash', async (t) => {
  const fixture = await writeFixture(t);
  await unlink(join(fixture.directory, fixture.manifest.sessions[0].candidate.journal.path));
  await invoke(fixture, 'blocked', /ENOENT/);
});

test('CLI blocks an omitted portable journal reference', async (t) => {
  const fixture = await writeFixture(t);
  delete fixture.manifest.sessions[0].candidate.journal;
  await invoke(fixture, 'blocked', /portable journal path\/hash/);
});

test('CLI blocks a journal file hash mismatch', async (t) => {
  const fixture = await writeFixture(t);
  fixture.manifest.sessions[0].candidate.journal.sha256 = '0'.repeat(64);
  await invoke(fixture, 'blocked', /journal file is missing or its bytes do not match/);
});

test('CLI verifies the raw journal hash independently of its supplied file hash', async (t) => {
  const fixture = await writeFixture(t);
  const ref = fixture.manifest.sessions[0].candidate;
  const file = join(fixture.directory, ref.path);
  const report = JSON.parse(await readFile(file, 'utf8'));
  report.recorder.journalSHA256 = '0'.repeat(64);
  const bytes = JSON.stringify(report);
  ref.sha256 = hash(bytes);
  await writeFile(file, bytes);
  await invoke(fixture, 'blocked', /raw SHA-256 differs/);
});

for (const [name, transform, reason] of [
  ['truncated final line', (text: string) => text.slice(0, -8), /truncated final line/],
  [
    'omitted final attempt',
    (text: string) => {
      const rows = text.trimEnd().split('\n');
      rows.splice(rows.length - 4, 3);
      return `${rows.join('\n')}\n`;
    },
    /seal counts differ/,
  ],
  [
    'different header artifact identity',
    (text: string) => {
      const rows = text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      rows[0].identity.probeSHA256 = '0'.repeat(64);
      return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    },
    /header artifact identities differ/,
  ],
  [
    'different raw sample',
    (text: string) => {
      const rows = text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      rows.find((row) => row.kind === 'sample').sample.direction = 'beta->alpha';
      return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    },
    /raw sample or observation differs/,
  ],
  [
    'reordered sample observation',
    (text: string) => {
      const rows = text.trimEnd().split('\n');
      const index = rows.findIndex((line) => JSON.parse(line).kind === 'sample');
      [rows[index], rows[index + 1]] = [rows[index + 1], rows[index]];
      return `${rows.join('\n')}\n`;
    },
    /out-of-order raw sample/,
  ],
  [
    'wrong sealed final metadata',
    (text: string) => {
      const rows = text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      rows.at(-1).metadata.status = 'failed';
      return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    },
    /seal metadata\/status differs/,
  ],
  [
    'trailing unrecognized record',
    (text: string) => `${text}{"kind":"ignored-failure"}\n`,
    /trailing or empty records/,
  ],
] as const) {
  test(`CLI blocks ${name} even with recomputed artifact hashes`, async (t) => {
    const fixture = await writeFixture(t);
    await alterJournal(fixture, transform);
    await invoke(fixture, 'blocked', reason);
  });
}

test('CLI refuses one journal reused by a different run', async (t) => {
  const fixture = await writeFixture(t);
  fixture.manifest.sessions[0].candidate.journal = fixture.manifest.sessions[0].baseline.journal;
  await invoke(fixture, 'blocked', /journal evidence file reused/);
});

test('CLI cannot publish its closure output over a referenced journal', async (t) => {
  const fixture = await writeFixture(t);
  const file = join(fixture.directory, fixture.manifest.sessions[0].candidate.journal.path);
  const before = await readFile(file);
  const execution = spawnSync(process.execPath, [gate, fixture.filename, '--output', file], {
    encoding: 'utf8',
  });
  assert.equal(execution.status, 1);
  assert.equal(JSON.parse(execution.stdout).closureAllowed, false);
  assert.deepEqual(await readFile(file), before);
});
