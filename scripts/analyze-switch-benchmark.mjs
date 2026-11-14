#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const stats = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const n = sorted.length;
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    n,
    median: round((sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2),
    p95: round(sorted[Math.ceil(n * 0.95) - 1]),
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
  };
};
const contains = (outer, inner) =>
  outer !== inner && outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;
const union = (ranges) => {
  let end = -Infinity;
  let total = 0;
  for (const [start, finish] of ranges.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return total;
};

function stages(sample) {
  const spans = sample.spans;
  const guards = spans.filter((span) => span.name === 'repository.assertCanSwitch');
  const identities = spans.filter((span) => span.name === 'repository.inspectIdentity');
  const result = {};
  const ranges = [];
  const presentation = [];
  for (const span of spans) {
    let name;
    if (span.name === 'repository.inspect' || span.name === 'repository.inspectIdentity') {
      if (guards.some((guard) => contains(guard, span))) continue;
      if (identities.some((identity) => contains(identity, span))) continue;
      name = 'repository inspection outside guards';
    } else if (span.name === 'repository.assertCanSwitch') name = 'checkout safeguards';
    else if (span.name === 'provider.checkout') name = 'native Git checkout';
    else if (span.name === 'repository.refreshPresentation') name = 'Git presentation refresh';
    else if (span.name === 'store.save') name = 'durable state writes';
    else if (span.name === 'host.flush') name = 'editor flush';
    else if (span.name === 'host.quiesce') name = 'editor unload';
    else if (span.name === 'host.waitForFiles') name = 'vault readiness';
    else if (span.name === 'host.restore') name = 'native layout restore';
    if (name === 'Git presentation refresh') presentation.push([span.startMs, span.endMs]);
    else if (name) {
      result[name] = (result[name] ?? 0) + span.durationMs;
      ranges.push([span.startMs, span.endMs]);
    }
  }
  // Presentation can overlap host readiness/restoration. Attribute only its
  // additional wall interval here; retain every inclusive span in the raw report.
  // Raw Git, leaf, and filesystem spans are nested and excluded from this table.
  const blocking = union(ranges);
  const accounted = union([...ranges, ...presentation]);
  if (presentation.length) result['Git presentation outside other stages'] = accounted - blocking;
  result['other controller work and queue wait'] = sample.timingsMs.controller - accounted;
  return result;
}

if (!process.argv[2]) throw new Error('Usage: analyze-switch-benchmark.mjs REPORT.json[.gz] [...]');
for (const filename of process.argv.slice(2)) {
  const bytes = await readFile(filename);
  const report = JSON.parse(
    (filename.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'),
  );
  const groups = {};
  for (const scenario of ['branch', 'same-branch', 'unbound']) {
    const samples = report.samples.filter(
      (sample) =>
        sample.scenario === scenario &&
        sample.temperature === 'measured' &&
        sample.status === 'passed',
    );
    if (!samples.length) continue;
    const costs = samples.map(stages);
    groups[scenario] = {
      selectionToCompleteMs: stats(
        samples.map((sample) => sample.timingsMs.selectionToControllerComplete),
      ),
      selectionToNextFrameMs: stats(samples.map((sample) => sample.timingsMs.selectionToNextFrame)),
      modalOpened: samples.filter((sample) => sample.transitionModalOpened).length,
      rawGitCalls: stats(samples.map((sample) => sample.rawGitCommandCount)),
      stageMs: Object.fromEntries(
        [...new Set(costs.flatMap(Object.keys))].map((key) => [
          key,
          stats(costs.map((cost) => cost[key] ?? 0)),
        ]),
      ),
    };
  }
  console.log(
    JSON.stringify({ filename, status: report.status, phase: report.phase, groups }, null, 2),
  );
}
