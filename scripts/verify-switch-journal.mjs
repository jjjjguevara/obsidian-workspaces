/** Offline validation of the recorder bytes against the finalized native report. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SCHEMA, MODE } from '../tests/obsidian/sample-recorder.cjs';

const assert = (condition, message) => {
  if (!condition) throw new Error(`Sample journal: ${message}`);
};
const identityKeys = [
  'index',
  'scenario',
  'temperature',
  'fromId',
  'toId',
  'direction',
  'startedAt',
];
const recordFields = {
  header: ['kind', 'schema', 'mode', 'runId', 'phase', 'startedAt', 'identity'],
  metadata: ['kind', 'metadata'],
  'sample-start': ['kind', ...identityKeys],
  sample: ['kind', 'sample'],
  'sample-recorded': ['kind', 'observation'],
  'run-complete': ['kind', 'counts', 'metadata'],
};

export function verifySwitchJournal(report, bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0, 'raw journal bytes are missing.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert(
    hash === report.recorder.journalSHA256,
    'raw SHA-256 differs from the finalized recorder.',
  );
  assert(
    bytes.length === report.recorder.journalBytes,
    'raw byte count differs from the finalized recorder.',
  );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(text.endsWith('\n'), 'truncated final line.');
  const { samples, recorder, ...finalMetadata } = report;
  assert(Array.isArray(samples), 'finalized samples are missing.');
  let state = 'header';
  let started = 0;
  let completed = 0;
  let failed = 0;
  let rawSampleBytes = 0;
  let rawSample;
  const sampleHash = createHash('sha256');
  for (let cursor = 0; cursor < text.length;) {
    const end = text.indexOf('\n', cursor);
    const line = text.slice(cursor, end);
    cursor = end + 1;
    assert(line && state !== 'sealed', 'trailing or empty records after the complete seal.');
    const row = JSON.parse(line);
    assert(line === JSON.stringify(row), 'record is not the original compact recorder JSON.');
    const fields = recordFields[row?.kind];
    assert(
      fields && isDeepStrictEqual(Object.keys(row).sort(), [...fields].sort()),
      'unrecognized record kind or fields.',
    );
    if (state === 'header') {
      assert(
        row.kind === 'header' && row.schema === SCHEMA && row.mode === MODE,
        'missing or incompatible header.',
      );
      assert(
        row.runId === report.runId && row.phase === report.phase,
        'header identifies a different run.',
      );
      assert(
        typeof row.startedAt === 'string' && Number.isFinite(Date.parse(row.startedAt)),
        'header start time is missing.',
      );
      assert(
        isDeepStrictEqual(row.identity, {
          benchmarkSchema: report.benchmarkSchema,
          productSourceCommit: report.environment.productSourceCommit,
          productBundleSHA256: report.environment.plugins['obsidian-workspaces'].bundleSHA256,
          probeSHA256: report.environment.plugins['workspaces-switch-benchmark'].bundleSHA256,
        }),
        'header artifact identities differ from the finalized report.',
      );
      state = 'metadata';
    } else if (state === 'metadata') {
      assert(
        row.kind === 'metadata' && row.metadata?.status === 'running',
        'missing pre-timing metadata checkpoint.',
      );
      for (const key of [
        'benchmarkSchema',
        'endpointSchema',
        'phase',
        'runId',
        'environment',
        'fixture',
        'methodology',
      ])
        assert(Object.hasOwn(row.metadata, key), `metadata checkpoint omits ${key}.`);
      for (const key of ['samples', 'recorder', 'finishedAt', 'final', 'summary'])
        assert(
          !Object.hasOwn(row.metadata, key),
          'metadata checkpoint contains final or sample data.',
        );
      for (const [key, value] of Object.entries(row.metadata))
        if (key !== 'status')
          assert(isDeepStrictEqual(value, report[key]), `metadata checkpoint differs in ${key}.`);
      state = 'start-or-seal';
    } else if (state === 'start-or-seal' && row.kind === 'sample-start') {
      const expected = samples[completed];
      assert(expected && row.index === started, 'missing, additional or out-of-order attempt.');
      const { kind, ...identity } = row;
      assert(
        isDeepStrictEqual(
          identity,
          Object.fromEntries(identityKeys.map((key) => [key, expected[key]])),
        ),
        'start identity differs from its finalized sample.',
      );
      started++;
      state = 'sample';
    } else if (state === 'sample') {
      assert(
        row.kind === 'sample' && row.sample?.index === completed,
        'missing or out-of-order raw sample.',
      );
      assert(['passed', 'failed'].includes(row.sample.status), 'raw attempt is unfinished.');
      assert(
        !Object.hasOwn(row.sample, 'recorderObservation'),
        'raw sample already contains a later recorder observation.',
      );
      rawSample = row.sample;
      state = 'observation';
    } else if (state === 'observation') {
      assert(
        row.kind === 'sample-recorded' && row.observation?.index === completed,
        'missing or out-of-order sample observation.',
      );
      const rawBytes = Buffer.byteLength(JSON.stringify(rawSample));
      assert(
        row.observation.sampleBytes === rawBytes,
        'sample byte count differs from raw evidence.',
      );
      rawSampleBytes += rawBytes;
      const finalized = { ...rawSample, recorderObservation: row.observation };
      assert(
        isDeepStrictEqual(finalized, samples[completed]),
        'raw sample or observation differs from the finalized sample.',
      );
      sampleHash.update(`${JSON.stringify(finalized)}\n`);
      if (rawSample.status === 'failed') failed++;
      completed++;
      rawSample = undefined;
      state = 'start-or-seal';
    } else if (state === 'start-or-seal' && row.kind === 'run-complete') {
      assert(
        isDeepStrictEqual(row.counts, {
          startedSamples: started,
          completedSamples: completed,
          failedSamples: failed,
        }),
        'seal counts differ from observed attempts.',
      );
      assert(
        isDeepStrictEqual(row.metadata, finalMetadata),
        'seal metadata/status differs from the finalized report.',
      );
      assert(
        started === completed && completed === samples.length,
        'seal omits or adds attempted samples.',
      );
      assert(
        recorder.startedSamples === started &&
          recorder.completedSamples === completed &&
          recorder.failedSamples === failed &&
          recorder.rawSampleSerializations === completed &&
          recorder.rawSampleBytes === rawSampleBytes,
        'finalized recorder counts differ from journal evidence.',
      );
      state = 'sealed';
    } else throw new Error(`Sample journal: unexpected ${row.kind} while expecting ${state}.`);
  }
  assert(state === 'sealed', 'incomplete record sequence or missing final seal.');
  assert(
    sampleHash.digest('hex') === recorder.samplesSHA256,
    'final sample digest differs from raw journal evidence.',
  );
  return {
    status: 'passed',
    runId: report.runId,
    rawSHA256: hash,
    rawBytes: bytes.length,
    started,
    completed,
    failed,
  };
}
