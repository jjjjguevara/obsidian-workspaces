import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  SampleRecorder,
  SCHEMA,
  MODE,
  memoryObservation,
} = require('../obsidian/sample-recorder.cjs');

async function fixture(t: any, runId = 'test-run') {
  const directory = await mkdtemp(join(tmpdir(), 'workspaces-recorder-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vaultPath = join(directory, 'vault');
  await mkdir(vaultPath);
  const options = {
    resultFile: join(directory, 'report.json'),
    vaultPath,
    runId,
    phase: 'test',
    identity: { product: 'synthetic' },
  };
  const recorder = await SampleRecorder.create(options);
  t.after(() => recorder.closeIncomplete().catch(() => {}));
  return { directory, options, recorder };
}

function attempt(index: number, status = 'passed') {
  return {
    index,
    scenario: index === 1 ? 'cleanup' : 'branch',
    temperature: index === 1 ? 'excluded' : 'measured',
    fromId: 'alpha',
    toId: 'beta',
    direction: 'alpha->beta',
    startedAt: 'synthetic',
    status,
    completionEndpoint: { buffer: 'captured once', journal: null },
    memory: {
      beforeTiming: memoryObservation(),
      afterVerificationBeforePersistence: memoryObservation(),
    },
  };
}

async function persist(recorder: any, sample: any) {
  await recorder.startSample(sample);
  await recorder.completeSample(sample);
}

test('streaming final assembly preserves original schema, every ordered attempt and immutable raw snapshots', async (t) => {
  const { recorder, options } = await fixture(t);
  await recorder.checkpoint({ status: 'running', fixture: { kind: 'synthetic' } });
  let serializations = 0;
  const first = attempt(0);
  Object.defineProperty(first.completionEndpoint, 'toJSON', {
    value() {
      serializations++;
      return { buffer: this.buffer, journal: this.journal };
    },
  });
  await persist(recorder, first);
  first.completionEndpoint.buffer = 'late mutation must not repair saved evidence';
  await persist(recorder, attempt(1));
  assert.equal(serializations, 1, 'later samples/progress must not revisit completed snapshots');
  assert.equal(Object.values(recorder).includes(first), false);
  const progress = JSON.parse(await readFile(options.resultFile, 'utf8'));
  assert.equal(progress.kind, 'benchmark-progress');
  assert.equal(progress.status, 'running');
  assert.equal(progress.samples, undefined);
  assert.equal(progress.complete, false);
  const proof = await recorder.finalize({
    benchmarkSchema: 'unchanged-schema',
    status: 'passed',
    runId: options.runId,
  });
  const report = JSON.parse(await readFile(options.resultFile, 'utf8'));
  assert.equal(report.benchmarkSchema, 'unchanged-schema');
  assert.equal(report.samples.length, 2);
  assert.deepEqual(
    report.samples.map((sample: any) => sample.index),
    [0, 1],
  );
  assert.equal(report.samples[0].completionEndpoint.buffer, 'captured once');
  assert.equal(report.samples[1].scenario, 'cleanup');
  assert.equal(proof.schema, SCHEMA);
  assert.equal(proof.mode, MODE);
  assert.equal(proof.rawSampleSerializations, 2);
  assert.equal(proof.retainedDetailedSamplesBetweenSwitches, 0);
  const samplesHash = createHash('sha256');
  for (const sample of report.samples) samplesHash.update(`${JSON.stringify(sample)}\n`);
  assert.equal(report.recorder.samplesSHA256, samplesHash.digest('hex'));
  const bytes = await readFile(recorder.journalFile);
  assert.equal(report.recorder.journalSHA256, createHash('sha256').update(bytes).digest('hex'));
  const rows = bytes
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows.filter((row: any) => row.kind === 'sample').length, 2);
  assert.equal(rows.filter((row: any) => row.kind === 'sample-start').length, 2);
  assert.equal(rows.at(-1).kind, 'run-complete');
  assert.equal(serializations, 1);
});

test('compact progress does not accumulate detailed earlier samples', async (t) => {
  const { recorder, options } = await fixture(t);
  let firstBytes = 0;
  const detail = '📝 café 漢字\n'.repeat(5000);
  for (let index = 0; index < 12; index++) {
    const sample = { ...attempt(index), details: detail };
    await persist(recorder, sample);
    const progress = await readFile(options.resultFile, 'utf8');
    if (index === 0) firstBytes = Buffer.byteLength(progress);
    assert.equal(progress.includes('café'), false);
    assert.ok(Buffer.byteLength(progress) < firstBytes + 300);
  }
  await recorder.finalize({ status: 'passed' });
  const report = JSON.parse(await readFile(options.resultFile, 'utf8'));
  assert.equal(report.samples.length, 12);
  assert.equal(report.samples[0].details, detail, 'UTF-8 survives stream chunk boundaries');
  assert.equal(report.recorder.rawSampleSerializations, 12);
});

test('failed attempts and successful cleanup remain evidence and cannot be finalized as passed', async (t) => {
  const { recorder, options } = await fixture(t);
  await persist(recorder, { ...attempt(0, 'failed'), error: { message: 'native failure' } });
  await persist(recorder, attempt(1));
  await assert.rejects(recorder.finalize({ status: 'passed' }), /failed attempts/);
  await recorder.finalize({ status: 'failed', error: { message: 'native failure' } });
  const report = JSON.parse(await readFile(options.resultFile, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.samples.map((sample: any) => sample.status),
    ['failed', 'passed'],
  );
  assert.equal(report.recorder.failedSamples, 1);
});

test('a crash after start preserves an incomplete journal and cannot publish a pass', async (t) => {
  const { recorder, options } = await fixture(t);
  await persist(recorder, attempt(0));
  await recorder.startSample(attempt(1));
  await assert.rejects(recorder.finalize({ status: 'passed' }), /Incomplete sample journal/);
  await recorder.closeIncomplete(new Error('simulated interruption'));
  const progress = JSON.parse(await readFile(options.resultFile, 'utf8'));
  assert.equal(progress.status, 'failed');
  assert.equal(progress.complete, false);
  assert.equal(progress.startedSamples, 2);
  assert.equal(progress.completedSamples, 1);
  assert.equal(progress.currentSample.index, 1);
  const rows = (await readFile(recorder.journalFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows.at(-1).kind, 'sample-start');
  assert.equal(
    rows.some((row: any) => row.kind === 'run-complete'),
    false,
  );
});

test('duplicate completion and noncontiguous starts are rejected without losing prior evidence', async (t) => {
  const { recorder } = await fixture(t);
  await persist(recorder, attempt(0));
  await assert.rejects(recorder.completeSample(attempt(0)), /matching|match/);
  await assert.rejects(recorder.startSample(attempt(2)), /contiguous/);
  await recorder.finalize({ status: 'passed' });
});

test('reusing a run identity cannot overwrite its exclusive journal or final report', async (t) => {
  const { recorder, options } = await fixture(t);
  await persist(recorder, attempt(0));
  await recorder.finalize({ status: 'passed' });
  const journal = await readFile(recorder.journalFile);
  const report = await readFile(options.resultFile);
  await assert.rejects(SampleRecorder.create(options), /EEXIST/);
  assert.deepEqual(await readFile(recorder.journalFile), journal);
  assert.deepEqual(await readFile(options.resultFile), report);
});

test('a tampered journal cannot replace progress with a complete report', async (t) => {
  const { recorder, options } = await fixture(t);
  await persist(recorder, attempt(0));
  const contents = await readFile(recorder.journalFile, 'utf8');
  // Same-length rewrite keeps the open descriptor position valid but changes
  // completed evidence. Final streaming must verify actual persisted bytes.
  await writeFile(recorder.journalFile, contents.replace('captured once', 'tampered now!'));
  await assert.rejects(recorder.finalize({ status: 'passed' }), /Journal bytes changed/);
  const progress = JSON.parse(await readFile(options.resultFile, 'utf8'));
  assert.equal(progress.complete, false);
  assert.equal(progress.status, 'running');
  await recorder.closeIncomplete(new Error('tampered journal'));
  assert.equal(JSON.parse(await readFile(options.resultFile, 'utf8')).status, 'failed');
});

for (const corruption of ['reordered-start', 'truncated-footer']) {
  test(`streamed final publication rejects ${corruption} and retains incomplete evidence`, async (t) => {
    const { recorder, options } = await fixture(t);
    await persist(recorder, attempt(0));
    const stream = recorder.streamFinalReport.bind(recorder);
    recorder.streamFinalReport = async (...args: any[]) => {
      const text = await readFile(recorder.journalFile, 'utf8');
      await writeFile(
        recorder.journalFile,
        corruption === 'reordered-start'
          ? text.replace('"index":0', '"index":1')
          : text.slice(0, -3),
      );
      await stream(...args);
    };
    await assert.rejects(
      recorder.finalize({ status: 'passed' }),
      corruption === 'reordered-start' ? /out-of-order sample start/ : /truncated final line/,
    );
    const progress = JSON.parse(await readFile(options.resultFile, 'utf8'));
    assert.equal(progress.complete, false);
    assert.equal(progress.samples, undefined);
  });
}

test('recorder rejects a report directory alias into the vault and a symlink output', async (t) => {
  const { directory, recorder, options } = await fixture(t);
  await recorder.closeIncomplete();
  const alias = join(directory, 'alias');
  await symlink(options.vaultPath, alias, 'dir');
  await assert.rejects(
    SampleRecorder.create({ ...options, runId: 'inside', resultFile: join(alias, 'bad.json') }),
    /outside the vault/,
  );
  const outputAlias = join(directory, 'output-alias.json');
  await symlink(options.resultFile, outputAlias);
  const before = await readFile(options.resultFile);
  await assert.rejects(
    SampleRecorder.create({ ...options, runId: 'alias', resultFile: outputAlias }),
    /regular file/,
  );
  assert.deepEqual(await readFile(options.resultFile), before);
});

test('memory observations describe this process without garbage collection or timers', () => {
  const memory = memoryObservation();
  for (const field of ['performanceMs', 'rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'])
    assert.ok(Number.isFinite(memory[field]) && memory[field] >= 0);
  assert.ok(memory.heapUsed <= memory.heapTotal);
});
