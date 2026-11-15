import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert(['--checkout', '--evidence-dir', '--output'].includes(args[i]) && args[i + 1],
    'Usage: node independent-394-analysis.mjs --checkout REPOSITORY --evidence-dir EVIDENCE_ROOT [--output NEW_JSON]');
  assert(!options[args[i]], `Duplicate argument: ${args[i]}`);
  options[args[i]] = args[i + 1];
}
assert(options['--checkout'] && options['--evidence-dir'],
  'Usage: node independent-394-analysis.mjs --checkout REPOSITORY --evidence-dir EVIDENCE_ROOT [--output NEW_JSON]');
const checkout = path.resolve(options['--checkout']);
const { assertCompletionEndpoint, fileLeaves } = require(`${checkout}/tests/obsidian/completion-endpoint.cjs`);
const { assertMeasurementEnvironment } = require(`${checkout}/tests/obsidian/measurement-environment.cjs`);
const directory = path.resolve(options['--evidence-dir']);
const artifactIndex = new Map();
const indexArtifacts = folder => {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) indexArtifacts(filename);
    else if (entry.isFile()) {
      const name = entry.name.endsWith('.gz') ? entry.name.slice(0, -3) : entry.name;
      artifactIndex.set(name, [...(artifactIndex.get(name) ?? []), filename]);
    }
  }
};
indexArtifacts(directory);
const artifactBytes = name => {
  const basename = path.basename(name.replaceAll('\\', '/'));
  const matches = artifactIndex.get(basename) ?? [];
  assert.equal(matches.length, 1, `Missing or ambiguous artifact basename: ${basename}`);
  const bytes = fs.readFileSync(matches[0]);
  return matches[0].endsWith('.gz') ? gunzipSync(bytes) : bytes;
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stats = values => {
  assert(values.length && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return { n, min: sorted[0], median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2,
    p95: sorted[Math.ceil(n * .95) - 1], p99: sorted[Math.ceil(n * .99) - 1], max: sorted[n - 1] };
};
const histogram = values => values.reduce((result, value) => {
  result[value] = (result[value] ?? 0) + 1; return result;
}, {});
const union = ranges => {
  let total = 0, end = -Infinity;
  for (const [start, finish] of ranges.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish);
  }
  return total;
};
const sumSpans = (sample, name) => sample.spans.filter(s => s.name === name).reduce((n, s) => n + s.durationMs, 0);
const stageNames = ['repository.inspectIdentity', 'repository.prepareSwitch', 'repository.assertCanSwitch',
  'repository.checkout', 'provider.checkout', 'host.flush', 'host.quiesce', 'host.waitForFiles',
  'host.restore', 'repository.refreshPresentation', 'store.save'];
const reportNames = [
  'final-small-s1-baseline.json', 'final-small-s1-candidate.json',
  'final-small-s2-candidate.json', 'final-small-s2-baseline.json',
  'final-scale-s1-baseline.json', 'final-scale-s1-candidate.json',
];
const pairedLayouts = [];
const result = {
  reviewedAt: new Date().toISOString(),
  scope: 'Independent audit of six explicitly versioned Linux long comparisons. This is not the Mac closure evaluator or a budget pass.',
  method: 'Primary latency is selection to actual controller settlement. Median averages the middle observations; p95/p99 use nearest rank. Quartiles are chronological blocks of 25 measured branch transitions. Inclusive stage durations are not additive; gitRawUnionMs merges overlapping raw-Git intervals.',
  probeSHA256: '394466fd2c824d4f2f49a46f1b7848c91303f27ccf77cdf03a34233bddf80431',
  candidateProductCommit: 'd7399c2dd7b642e4e2c904bb55a02ad38039a67d',
  candidateProductSHA256: 'f4a862e7fd3c90786e4474a1e7c4a0041cc9d73d8595cda448cf64b10d530020',
  baselineProductCommit: '6b3ae45589132a7c37da14e94a20a4668b2f28b9',
  baselineProductSHA256: '9dee2cbb8b25f768f81d3b94ec1a7c57ddae55267ae29de459ad00a8d94d3400',
  reports: [],
};

for (const filename of reportNames) {
  const bytes = artifactBytes(filename);
  const report = JSON.parse(bytes);
  const env = report.environment;
  const workloadLeaves = layout => fileLeaves(layout)
    .map(leaf => JSON.stringify([leaf.region, leaf.path, leaf.type, leaf.pinned])).sort();
  pairedLayouts.push(report.samples.map(sample => [sample.scenario, sample.temperature,
    sample.expectedBranch, workloadLeaves(sample.sourceLayout), workloadLeaves(sample.endpointExpected.layout)]));
  assert.equal(report.status, 'passed');
  assert.equal(report.samples.length, 150);
  assert.equal(report.deepTraceEnabled, false);
  assert.equal(report.diagnosticOnly, false);
  assert.equal(env.sourceWorktreeStatus, '');
  assert.equal(env.sourceCommit, '026efdb60c6862f091dd2e382589e881a50875bf');
  assert.equal(env.platform, 'linux');
  assert.equal(env.plugins['workspaces-switch-benchmark'].bundleSHA256, result.probeSHA256);
  const expectedProduct = result[`${report.phase}ProductSHA256`];
  assert.equal(env.plugins['obsidian-workspaces'].bundleSHA256, expectedProduct);
  assert.equal(env.productSourceCommit, result[`${report.phase}ProductCommit`]);
  assert.equal(env.productReload.status, 'passed');
  for (const key of ['newInstance', 'newController', 'newConstructor', 'providerInstancesPreserved', 'excludedFromTiming'])
    assert.equal(env.productReload[key], true);
  assert.equal(env.productReload.beforeSHA256, expectedProduct);
  assert.equal(env.productReload.afterSHA256, expectedProduct);
  assert.deepEqual(env.productReload.before, env.productReload.after);
  assert.deepEqual(env.productReload.enabledBefore, env.productReload.enabledAfter);
  assert.equal(report.final.branch, 'alpha');
  assert.equal(report.final.activeId, 'runtime-alpha');
  assert.equal(report.final.journal, null);
  assert.equal(report.finalGitStatus, '');
  assert.equal(report.restoredAlpha, true);

  const sampleHash = createHash('sha256');
  for (const [index, sample] of report.samples.entries()) {
    assert.equal(sample.index, index);
    assert.equal(sample.status, 'passed');
    assertMeasurementEnvironment(sample);
    assertCompletionEndpoint(sample.completionEndpoint, sample.endpointExpected);
    assert.equal(sample.controllerCalls.length, 1);
    const call = sample.controllerCalls[0];
    assert.equal(call.workspaceId, sample.toId);
    assert.equal(call.status, 'fulfilled');
    assert.equal(sample.endpointExpected.id, sample.toId);
    assert.equal(sample.endpointExpected.branch, sample.expectedBranch);
    assert.equal(sample.completionEndpoint.controllerCompleteMs, call.endMs);
    assert(sample.completionEndpoint.captureFinishedMs <= sample.nextFrameMs);
    assert(Math.abs(sample.timingsMs.selectionToControllerComplete - (call.endMs - sample.selectionMs)) < 1e-6);
    assert(Math.abs(sample.timingsMs.selectionToNextFrame - (sample.nextFrameMs - sample.selectionMs)) < 1e-6);
    assert.equal(sample.verification.branch, sample.expectedBranch);
    assert.equal(sample.verification.activeId, sample.toId);
    assert.equal(sample.verification.journal, null);
    assert.equal(sample.rawGitCommandCount, sample.spans.filter(s => s.name === 'git.raw').length);
    assert.equal(sample.recorderObservation.index, index);
    assert.equal(sample.recorderObservation.excludedFromSwitchTiming, true);
    sampleHash.update(`${JSON.stringify(sample)}\n`);
  }
  assert.equal(report.recorder.complete, true);
  assert.equal(report.recorder.startedSamples, 150);
  assert.equal(report.recorder.completedSamples, 150);
  assert.equal(report.recorder.failedSamples, 0);
  assert.equal(report.recorder.rawSampleSerializations, 150);
  assert.equal(report.recorder.retainedDetailedSamplesBetweenSwitches, 0);
  assert.equal(sampleHash.digest('hex'), report.recorder.samplesSHA256);
  const journalBytes = artifactBytes(report.recorder.journalFile);
  assert.equal(sha(journalBytes), report.recorder.journalSHA256);
  assert.equal(journalBytes.length, report.recorder.journalBytes);
  const records = journalBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(records.length, 3 * report.samples.length + 3);
  assert.equal(records[0].kind, 'header');
  assert.equal(records[0].runId, report.runId);
  assert.equal(records[0].phase, report.phase);
  assert.deepEqual(records[0].identity, {
    benchmarkSchema: report.benchmarkSchema,
    productSourceCommit: env.productSourceCommit,
    productBundleSHA256: expectedProduct,
    probeSHA256: result.probeSHA256,
  });
  assert.equal(records[1].kind, 'metadata');
  assert.equal(records.at(-1).kind, 'run-complete');
  assert.deepEqual(records.at(-1).counts, { startedSamples: 150, completedSamples: 150, failedSamples: 0 });
  const { samples: omittedSamples, recorder: omittedRecorder, ...finalMetadata } = report;
  assert.deepEqual(records.at(-1).metadata, finalMetadata);
  const starts = records.filter(r => r.kind === 'sample-start');
  const samples = records.filter(r => r.kind === 'sample');
  const recorded = records.filter(r => r.kind === 'sample-recorded');
  assert.equal(starts.length, 150); assert.equal(samples.length, 150); assert.equal(recorded.length, 150);
  for (let index = 0; index < 150; ++index) {
    assert.equal(records[2 + index * 3].kind, 'sample-start');
    assert.equal(records[3 + index * 3].kind, 'sample');
    assert.equal(records[4 + index * 3].kind, 'sample-recorded');
    assert.equal(starts[index].index, index);
    for (const field of ['scenario', 'temperature', 'fromId', 'toId', 'direction', 'startedAt'])
      assert.equal(starts[index][field], report.samples[index][field]);
    assert.equal(samples[index].sample.index, index);
    assert.equal(recorded[index].observation.index, index);
    assert.deepEqual({ ...samples[index].sample, recorderObservation: recorded[index].observation }, report.samples[index]);
  }

  const groups = {};
  for (const scenario of ['branch', 'same-branch', 'unbound']) {
    const samples = report.samples.filter(s => s.scenario === scenario && s.temperature === 'measured');
    assert.equal(samples.length, scenario === 'branch' ? 100 : 20);
    const ms = samples.map(s => s.timingsMs.selectionToControllerComplete);
    groups[scenario] = {
      selectionToCompleteMs: stats(ms),
      selectionToNextFrameMs: stats(samples.map(s => s.timingsMs.selectionToNextFrame)),
      selectionToInputReleaseMs: stats(samples.map(s => s.timingsMs.selectionToInputRelease)),
      endpointCaptureMs: stats(samples.map(s => s.timingsMs.endpointCapture)),
      modalCount: samples.filter(s => s.transitionModalOpened).length,
      rawGitCommandHistogram: histogram(samples.map(s => s.rawGitCommandCount)),
      gitRawUnionMs: stats(samples.map(s => union(s.spans.filter(span => span.name === 'git.raw').map(span => [span.startMs, span.endMs])))),
      repositoryQueueWaitMs: stats(samples.map(s => s.spans.filter(span => span.name === 'git.queueTask' && span.owner === 'withRepository').reduce((n, span) => n + span.queueWaitMs, 0))),
      inclusiveStageMs: Object.fromEntries(stageNames.map(name => [name, stats(samples.map(s => sumSpans(s, name)))])),
    };
    if (scenario === 'branch') {
      groups[scenario].chronologicalQuartiles = [0, 25, 50, 75].map(start => ({
        firstMeasuredIndex: start, lastMeasuredIndex: start + 24,
        latencyMs: stats(ms.slice(start, start + 25)),
        rawGitUnionMs: stats(samples.slice(start, start + 25).map(s => union(s.spans.filter(span => span.name === 'git.raw').map(span => [span.startMs, span.endMs])))),
        nativeRestoreMs: stats(samples.slice(start, start + 25).map(s => sumSpans(s, 'host.restore'))),
      }));
      groups[scenario].firstBeforeTimingRssMiB = samples[0].memory.beforeTiming.rss / 1048576;
      groups[scenario].lastBeforeTimingRssMiB = samples.at(-1).memory.beforeTiming.rss / 1048576;
      groups[scenario].peakBeforeTimingRssMiB = Math.max(...samples.map(s => s.memory.beforeTiming.rss)) / 1048576;
    }
  }
  result.reports.push({ filename, sha256: sha(bytes), bytes: bytes.length, runId: report.runId,
    phase: report.phase, startedAt: report.startedAt, finishedAt: report.finishedAt,
    session: env.nativeSession, sourceCommit: env.sourceCommit, productSourceCommit: env.productSourceCommit,
    providers: env.plugins, fixture: report.fixture, verifiedSamples: 150,
    final: { branch: report.final.branch, activeId: report.final.activeId, journal: report.final.journal, gitStatus: report.finalGitStatus },
    groups, recorder: report.recorder });
}
for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) {
  assert.equal(result.reports[a].session.id, result.reports[b].session.id);
  assert.equal(result.reports[a].session.processId, result.reports[b].session.processId);
  assert.deepEqual(result.reports[a].fixture, result.reports[b].fixture);
  assert.deepEqual(pairedLayouts[a], pairedLayouts[b]);
}
assert.equal(new Set([0, 2, 4].map(i => result.reports[i].session.processId)).size, 3);
assert.equal(new Set([0, 2, 4].map(i => result.reports[i].session.id)).size, 3);
const text = `${JSON.stringify(result, null, 2)}\n`;
if (options['--output']) {
  const output = path.resolve(options['--output']);
  fs.writeFileSync(output, text, { flag: 'wx' });
  console.log(JSON.stringify({ output, reports: result.reports.map(r => ({
  report: r.filename, sha256: r.sha256, pid: r.session.processId,
  median: r.groups.branch.selectionToCompleteMs.median, p95: r.groups.branch.selectionToCompleteMs.p95,
  quartileMedians: r.groups.branch.chronologicalQuartiles.map(q => q.latencyMs.median),
  modals: r.groups.branch.modalCount, rawGit: r.groups.branch.rawGitCommandHistogram,
  rss: [r.groups.branch.firstBeforeTimingRssMiB, r.groups.branch.lastBeforeTimingRssMiB],
  rawGitUnionMedian: r.groups.branch.gitRawUnionMs.median,
  restoreMedian: r.groups.branch.inclusiveStageMs['host.restore'].median,
  verifiedSamples: r.verifiedSamples,
})) }, null, 2));
} else process.stdout.write(text);
