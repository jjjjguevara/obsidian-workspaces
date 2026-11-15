import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';

const require = createRequire(import.meta.url);
const { closure, attachJournal } = require('../obsidian/benchmark-test-fixtures.cjs');
let evaluateClosure: (...args: any[]) => any;
let statistics: (values: number[]) => any;
before(async () => {
  ({ evaluateClosure, statistics } = await import(
    new URL('../../scripts/check-switch-performance.mjs', import.meta.url).href
  ));
});

test('complete paired synthetic Mac evidence satisfies the local evaluator', () => {
  const { manifest, evidence } = closure();
  const result = evaluateClosure(manifest, evidence);
  assert.equal(result.closureAllowed, true, JSON.stringify(result.failures));
  assert.equal(result.sessions.length, 6);
  assert.equal(result.pooled.representative.candidate.branch.n, 300);
});

function resealSamples(report: any) {
  const digest = createHash('sha256');
  for (const sample of report.samples) digest.update(`${JSON.stringify(sample)}\n`);
  report.recorder.samplesSHA256 = digest.digest('hex');
}

for (const [name, mutate] of [
  [
    'target sidebar ownership',
    (sample: any) => {
      for (const layout of [sample.endpointExpected.layout, sample.completionEndpoint.layout])
        layout.right.children.push(layout.left.children.pop());
    },
  ],
  [
    'target duplicate editor multiplicity',
    (sample: any) => {
      const file = `${sample.expectedBranch}-exclusive.md`;
      for (const layout of [sample.endpointExpected.layout, sample.completionEndpoint.layout])
        layout.right.children[0].state.state.file = file;
      const editor = sample.completionEndpoint.views.find((view: any) => view.id === 'right');
      editor.state.state.file = file;
      editor.content = sample.endpointExpected.notes[file];
    },
  ],
  [
    'source-only sidebar ownership',
    (sample: any) => {
      sample.sourceLayout.right.children.push(sample.sourceLayout.left.children.pop());
    },
  ],
] as const) {
  test(`paired evidence rejects different ${name} despite valid completion endpoints`, () => {
    const { manifest, evidence } = closure();
    const report = evidence.get(manifest.sessions[0].candidate.path).report;
    // A control sample must have the same workload too, not just measured
    // branch samples. Preserve endpoint correctness and the recorder digest.
    const sample = report.samples.find((value: any) => value.scenario === 'same-branch');
    mutate(sample);
    const { assertCompletionEndpoint } = require('../obsidian/completion-endpoint.cjs');
    assert.doesNotThrow(() =>
      assertCompletionEndpoint(sample.completionEndpoint, sample.endpointExpected),
    );
    resealSamples(report);
    const result = evaluateClosure(manifest, evidence);
    assert.equal(result.closureAllowed, false);
    assert.match(result.failures.join('\n'), /Pair differs in source\/target file leaves/);
  });
}

test('paired workload comparison ignores generated IDs and tab metadata', () => {
  const { manifest, evidence } = closure();
  const report = evidence.get(manifest.sessions[0].candidate.path).report;
  for (const sample of report.samples) {
    for (const layout of [sample.sourceLayout, sample.endpointExpected.layout]) {
      for (const region of ['main', 'left', 'right']) {
        layout[region].id = `generated-${sample.index}-${region}`;
        layout[region].currentTab = 0;
        for (const leaf of layout[region].children)
          leaf.id = `generated-${sample.index}-${leaf.id}`;
      }
      layout.active = `generated-${sample.index}-main`;
    }
  }
  resealSamples(report);
  attachJournal(manifest.sessions[0].candidate, evidence);
  const result = evaluateClosure(manifest, evidence);
  assert.equal(result.closureAllowed, true, JSON.stringify(result.failures));
});

test('percentiles use nearest rank without rounding away an exceeded budget', () => {
  const stats = statistics([...Array(98).fill(10), 300.00001, 400]);
  assert.equal(stats.p99, 300.00001);
  assert.throws(() => statistics([1, NaN]), /invalid timing/);
});

for (const [name, mutate, message] of [
  [
    'Linux report',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.environment.platform = 'linux';
    },
    /Darwin/,
  ],
  [
    'legacy timing schema',
    (m: any, e: any) => {
      delete e.get(m.sessions[0].candidate.path).report.benchmarkSchema;
    },
    /completion-aware/,
  ],
  [
    'legacy whole-report recorder',
    (m: any, e: any) => {
      delete e.get(m.sessions[0].candidate.path).report.recorder;
    },
    /append-only recorder/,
  ],
  [
    'incomplete sample journal',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.recorder.complete = false;
    },
    /append-only recorder/,
  ],
  [
    'wrong completed sample digest',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.recorder.samplesSHA256 = '0'.repeat(64);
    },
    /recorder digest/,
  ],
  [
    'duplicate ordered sample identity',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.samples[12].index = 11;
    },
    /out-of-order attempts/,
  ],
  [
    'unrecorded sample attempt',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.recorder.startedSamples++;
    },
    /out-of-order attempts/,
  ],
  [
    'missing outside-timer memory observation',
    (m: any, e: any) => {
      delete e.get(m.sessions[0].candidate.path).report.samples[10].memory;
    },
    /memory/,
  ],
  [
    'Settings open in a separate native window',
    (m: any, e: any) => {
      e.get(
        m.sessions[0].candidate.path,
      ).report.samples[0].nativeSettingsObservation.livePopoutWindow = true;
    },
    /Settings must be fully closed/,
  ],
  [
    'missing supported native Settings observation',
    (m: any, e: any) => {
      delete e.get(m.sessions[0].candidate.path).report.samples[0].nativeSettingsObservation;
    },
    /Settings observation is unsupported/,
  ],
  [
    'native window unfocused during first switch',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.samples[0].nativeWindowFocus.focused = false;
    },
    /unfocused or unsupported/,
  ],
  [
    'wrong installed bundle',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.environment.plugins[
        'obsidian-workspaces'
      ].bundleSHA256 = '0'.repeat(64);
    },
    /exact build/,
  ],
  [
    'wrong evidence hash',
    (m: any) => {
      m.sessions[0].candidate.sha256 = '0'.repeat(64);
    },
    /evidence bytes/,
  ],
  [
    'diagnostic run',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.deepTraceEnabled = true;
    },
    /normal runs/,
  ],
  [
    'omitted failed sample',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.samples[50].status = 'failed';
    },
    /transition failed/,
  ],
  [
    'missing controls',
    (m: any, e: any) => {
      const r = e.get(m.sessions[0].candidate.path).report;
      r.samples = r.samples.filter((s: any) => s.scenario !== 'unbound');
    },
    /controls/,
  ],
  [
    'late editor hydration',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.samples[10].completionEndpoint.views[3].deferred =
        true;
    },
    /still deferred/,
  ],
  [
    'unobserved input release',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.samples[10].completionEndpoint.input.blocks = [];
    },
    /guard/,
  ],
  [
    'modal during warmup',
    (m: any, e: any) => {
      const s = e.get(m.sessions[0].candidate.path).report.samples[1];
      s.modals.push({ kind: 'transition-progress' });
      s.transitionModalOpened = true;
    },
    /displayed transition progress/,
  ],
  [
    'reused app session',
    (m: any, e: any) => {
      for (const role of ['baseline', 'candidate'])
        e.get(m.sessions[1][role].path).report.environment.nativeSession.id = 'small-0';
    },
    /reused/,
  ],
  [
    'new app session UUID in a reused renderer process',
    (m: any, e: any) => {
      for (const role of ['baseline', 'candidate'])
        e.get(m.sessions[1][role].path).report.environment.nativeSession.processId = 1;
    },
    /Renderer process was reused/,
  ],
  [
    'pair roles in different renderer processes',
    (m: any, e: any) => {
      e.get(m.sessions[0].candidate.path).report.environment.nativeSession.processId = 99;
    },
    /same native session/,
  ],
  [
    'missing representative scope',
    (m: any) => {
      delete m.scope.representative;
    },
    /representative workload scope/,
  ],
  [
    'undersized representative editor workload',
    (m: any) => {
      m.scope.representative.minimumMarkdownLeaves = 12;
    },
    /smaller/,
  ],
  [
    'wrong platform safety evidence',
    (m: any, e: any) => {
      e.get(m.safetyReports[0].path).report.checks[0].details.platform = 'linux';
    },
    /safety report platform/,
  ],
  [
    'no safety evidence',
    (m: any) => {
      m.safetyReports = [];
    },
    /safety report/,
  ],
] as const) {
  test(`closure blocks ${name}`, () => {
    const { manifest, evidence } = closure();
    mutate(manifest, evidence);
    const result = evaluateClosure(manifest, evidence);
    assert.equal(result.closureAllowed, false);
    assert.match(result.failures.join('\n'), message);
  });
}

test('closure independently recomputes durations and rejects a forged fast summary', () => {
  const { manifest, evidence } = closure();
  const report = evidence.get(manifest.sessions[0].candidate.path).report;
  report.samples[5].timingsMs.selectionToControllerComplete = 1;
  report.summary = { median: 1, p95: 1 };
  const result = evaluateClosure(manifest, evidence);
  assert.equal(result.closureAllowed, false);
  assert.match(result.failures.join('\n'), /raw endpoints/);
});

test('closure rejects truthful slow candidate despite passing endpoint correctness', () => {
  const { manifest, evidence } = closure();
  const report = evidence.get(manifest.sessions[0].candidate.path).report;
  for (const s of report.samples) {
    s.controllerCalls[0].endMs = 150;
    s.controllerCalls[0].durationMs = 140;
    s.completionEndpoint.controllerCompleteMs = 150;
    s.completionEndpoint.captureStartedMs = 150;
    s.completionEndpoint.captureFinishedMs = 150.5;
    s.nextFrameMs = 160;
    s.timingsMs.selectionToControllerComplete = 140;
    s.timingsMs.selectionToNextFrame = 150;
  }
  const digest = createHash('sha256');
  for (const sample of report.samples) digest.update(`${JSON.stringify(sample)}\n`);
  report.recorder.samplesSHA256 = digest.digest('hex');
  const result = evaluateClosure(manifest, evidence);
  assert.equal(result.closureAllowed, false);
  assert.match(result.failures.join('\n'), /median 140/);
});

for (const [name, mutate, reason] of [
  [
    'late snapshot after next frame',
    (s: any) => {
      s.completionEndpoint.captureStartedMs = s.nextFrameMs + 1000;
      s.completionEndpoint.captureFinishedMs = s.nextFrameMs + 1000.5;
    },
    /after the next frame/,
  ],
  [
    'nonexistent active layout leaf',
    (s: any) => {
      s.completionEndpoint.layout.active = 'missing';
    },
    /active leaf/,
  ],
  [
    'different actual controller target',
    (s: any) => {
      s.controllerCalls[0].workspaceId = 'another-workspace';
    },
    /controller request/,
  ],
] as const) {
  test(`closure rejects ${name}`, () => {
    const { manifest, evidence } = closure();
    mutate(evidence.get(manifest.sessions[0].candidate.path).report.samples[10]);
    const result = evaluateClosure(manifest, evidence);
    assert.equal(result.closureAllowed, false);
    assert.match(result.failures.join('\n'), reason);
  });
}

test('closure requires fresh loaded-product provenance rather than a disk hash alone', () => {
  const { manifest, evidence } = closure();
  delete evidence.get(manifest.sessions[0].candidate.path).report.environment.productReload;
  const result = evaluateClosure(manifest, evidence);
  assert.equal(result.closureAllowed, false);
  assert.match(result.failures.join('\n'), /reload provenance/);
});

test('closure rejects invented safety scenarios and wrong safety-probe bytes', () => {
  for (const modification of ['name', 'hash']) {
    const { manifest, evidence } = closure();
    const report = evidence.get(manifest.safetyReports[0].path).report;
    if (modification === 'name') report.checks[3].name = 'synthetic check 3';
    else report.checks[0].details.bundleSHA256['workspaces-quick-switcher-probe'] = '0'.repeat(64);
    assert.equal(evaluateClosure(manifest, evidence).closureAllowed, false);
  }
});

test('CLI cannot overwrite an input through a symlink output alias', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspaces-closure-'));
  try {
    const manifest = join(directory, 'manifest.json');
    const output = join(directory, 'alias.json');
    const original = '{"schema":"invalid-test-manifest"}\n';
    await writeFile(manifest, original);
    await symlink(manifest, output);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            fileURLToPath(new URL('../../scripts/check-switch-performance.mjs', import.meta.url)),
            manifest,
            '--output',
            output,
          ],
          { stdio: 'pipe' },
        ),
      (error: any) =>
        JSON.parse(error.stdout.toString()).failures.some((reason: string) =>
          reason.includes('EEXIST'),
        ),
    );
    assert.equal(await readFile(manifest, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
