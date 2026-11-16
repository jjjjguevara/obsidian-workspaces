#!/usr/bin/env node
// Descriptive summary of the Mac closure reports. It does not decide acceptance;
// scripts/check-switch-performance.mjs is the gate.
// Usage: summarize.mjs EVIDENCE_DIR  (reads reports/*.json.gz, writes summary.json, prints Markdown)
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const directory = process.argv[2];
const ORDER = {
  small: {
    1: ['baseline', 'candidate'],
    2: ['candidate', 'baseline'],
    3: ['baseline', 'candidate'],
  },
  representative: {
    1: ['baseline', 'candidate'],
    2: ['candidate', 'baseline'],
    3: ['baseline', 'candidate'],
  },
};
const round = (value) => Math.round(value * 1000) / 1000;
const distribution = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const count = sorted.length;
  if (!count) return null;
  const rank = (p) => sorted[Math.ceil(count * p) - 1];
  return {
    n: count,
    median: round((sorted[(count - 1) >> 1] + sorted[count >> 1]) / 2),
    p95: round(rank(0.95)),
    p99: round(rank(0.99)),
    min: round(sorted[0]),
    max: round(sorted[count - 1]),
  };
};
const describe = (samples) => ({
  selectionToCompleteMs: distribution(
    samples.map((s) => s.timingsMs?.selectionToControllerComplete),
  ),
  selectionToNextFrameMs: distribution(samples.map((s) => s.timingsMs?.selectionToNextFrame)),
  modalOpenings: samples.filter((s) => s.transitionModalOpened).length,
  endpointPasses: samples.filter((s) => s.endpointValidation?.status === 'passed').length,
  rawGitCalls: Object.fromEntries(
    [...new Set(samples.map((s) => s.rawGitCommandCount))]
      .sort((a, b) => a - b)
      .map((n) => [n, samples.filter((s) => s.rawGitCommandCount === n).length]),
  ),
});
const result = {
  purpose: 'Descriptive summary of actual Darwin reports; the closure gate decides acceptance.',
  reports: [],
  pooled: {},
};
const pools = {};
for (const profile of ['small', 'representative'])
  for (const session of [1, 2, 3])
    for (const role of ORDER[profile][session]) {
      const file = `reports/${profile}-s${session}-${role}.json.gz`;
      const compressed = await readFile(join(directory, file));
      const raw = gunzipSync(compressed);
      const report = JSON.parse(raw.toString('utf8'));
      const measured = report.samples.filter((s) => s.temperature === 'measured');
      const groups = {};
      for (const scenario of ['branch', 'same-branch', 'unbound']) {
        const samples = measured.filter((s) => s.scenario === scenario);
        groups[scenario] = describe(samples);
        (pools[`${profile}/${role}/${scenario}`] ??= []).push(...samples);
      }
      const first = report.samples.find((s) => s.temperature === 'cold');
      const memory = measured
        .filter((s) => s.scenario === 'branch')
        .map((s) => s.memory?.beforeTiming?.rss ?? s.memory?.before?.rss)
        .filter(Number.isFinite);
      result.reports.push({
        file,
        profile,
        session,
        role,
        order: ORDER[profile][session].indexOf(role) + 1,
        status: report.status,
        rawSHA256: createHash('sha256').update(raw).digest('hex'),
        gzipSHA256: createHash('sha256').update(compressed).digest('hex'),
        productBundleSHA256: report.environment.plugins['obsidian-workspaces'].bundleSHA256,
        probeSHA256: report.environment.plugins['workspaces-switch-benchmark'].bundleSHA256,
        nativeSession: report.environment.nativeSession ?? null,
        samples: report.samples.length,
        allSampleModalOpenings: report.samples.filter((s) => s.transitionModalOpened).length,
        allSampleEndpointPasses: report.samples.filter(
          (s) => s.endpointValidation?.status === 'passed',
        ).length,
        maxCompletionMsAllSamples: round(
          Math.max(...report.samples.map((s) => s.timingsMs?.selectionToControllerComplete ?? 0)),
        ),
        maxNextFrameMsAllSamples: round(
          Math.max(...report.samples.map((s) => s.timingsMs?.selectionToNextFrame ?? 0)),
        ),
        firstSwitch: first
          ? {
              completeMs: round(first.timingsMs.selectionToControllerComplete),
              nextFrameMs: round(first.timingsMs.selectionToNextFrame),
              modal: !!first.transitionModalOpened,
            }
          : null,
        branchRssMiB: memory.length
          ? { first: Math.round(memory[0] / 2 ** 20), last: Math.round(memory.at(-1) / 2 ** 20) }
          : null,
        recorder: {
          complete: report.recorder.complete,
          journalSHA256: report.recorder.journalSHA256,
          samplesSHA256: report.recorder.samplesSHA256,
        },
        groups,
      });
    }
for (const [key, samples] of Object.entries(pools)) result.pooled[key] = describe(samples);
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);

const cell = (d) =>
  d ? `${d.median.toFixed(1)} / ${d.p95.toFixed(1)} / ${d.p99.toFixed(1)}` : '—';
console.log(
  '| Session | Order | Build | Branch median / p95 / p99 | Min–max | Same-branch | Unbound | Modals (all) | First switch |',
);
console.log('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of result.reports) {
  const b = r.groups.branch.selectionToCompleteMs;
  console.log(
    `| ${r.profile} S${r.session} | ${r.order === 1 ? 'First' : 'Second'} | ${r.role} | ${cell(b)} | ${b.min.toFixed(1)}–${b.max.toFixed(1)} | ${cell(r.groups['same-branch'].selectionToCompleteMs)} | ${cell(r.groups.unbound.selectionToCompleteMs)} | ${r.allSampleModalOpenings}/${r.samples} | ${r.firstSwitch?.completeMs.toFixed(1)} |`,
  );
}
console.log('\n| Pooled | Build | Branch (n) median / p95 / p99 | Same-branch | Unbound |');
console.log('| --- | --- | ---: | ---: | ---: |');
for (const profile of ['small', 'representative'])
  for (const role of ['baseline', 'candidate']) {
    const g = (s) => result.pooled[`${profile}/${role}/${s}`].selectionToCompleteMs;
    console.log(
      `| ${profile} | ${role} | (${g('branch').n}) ${cell(g('branch'))} | ${cell(g('same-branch'))} | ${cell(g('unbound'))} |`,
    );
  }
