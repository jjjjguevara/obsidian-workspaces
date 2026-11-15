/* Synthetic data for gate unit tests only. Never native evidence. */
const { SCHEMA, fileLeaves } = require('./completion-endpoint.cjs');
const { SCHEMA: RECORDER_SCHEMA, MODE: RECORDER_MODE } = require('./sample-recorder.cjs');
const { createHash } = require('node:crypto');
const { SETTINGS_SCHEMA, FOCUS_SCHEMA } = require('./measurement-environment.cjs');
const syntheticMemory = () => ({
  performanceMs: 1,
  rss: 2,
  heapTotal: 2,
  heapUsed: 1,
  external: 0,
  arrayBuffers: 0,
});
const hashes = {
  baseline: 'a'.repeat(64),
  candidate: 'b'.repeat(64),
  probe: 'c'.repeat(64),
  evidence: 'd'.repeat(64),
  git: 'e'.repeat(64),
  chooser: 'f'.repeat(64),
  safetyProbe: '9'.repeat(64),
};
function reload(hash) {
  return {
    status: 'passed',
    mechanism: 'obsidian-1.15.1-native-disable-enable',
    apiVersion: '1.15.1',
    beforeSHA256: hash,
    afterSHA256: hash,
    newInstance: true,
    newController: true,
    newConstructor: true,
    providerInstancesPreserved: true,
    excludedFromTiming: true,
    enabledBefore: ['obsidian-workspaces'],
    enabledAfter: ['obsidian-workspaces'],
    before: { activeId: 'runtime-alpha', revision: 1, journal: null },
    after: { activeId: 'runtime-alpha', revision: 1, journal: null },
  };
}
const notes = {
  alpha: {
    'alpha-exclusive.md': '# Alpha\n',
    'sidebar-alpha.md': '# Alpha sidebar\n',
    'shared.md': 'ALPHA\n',
  },
  beta: {
    'beta-exclusive.md': '# Beta\n',
    'sidebar-beta.md': '# Beta sidebar\n',
    'shared.md': 'BRAVO\n',
  },
};
function layout(branch) {
  const leaf = (id, name, pinned) => ({
    id,
    type: 'leaf',
    state: { type: 'markdown', state: { file: name }, pinned },
  });
  return {
    main: {
      type: 'split',
      children: [leaf('main', `${branch}-exclusive.md`, true), leaf('shared', 'shared.md', false)],
    },
    left: { type: 'split', children: [leaf('left', `sidebar-${branch}.md`, true)] },
    right: { type: 'split', children: [leaf('right', `sidebar-${branch}.md`, true)] },
    active: 'main',
  };
}
function sample(
  branch = 'beta',
  scenario = 'branch',
  temperature = 'measured',
  duration = 80,
  id = `runtime-${branch}`,
) {
  const other = branch === 'alpha' ? 'beta' : 'alpha';
  const expectedLayout = layout(branch);
  const views = fileLeaves(expectedLayout).map((leaf) => ({
    id: leaf.id,
    state: { type: leaf.type, state: { file: leaf.path }, pinned: leaf.pinned },
    deferred: false,
    content: notes[branch][leaf.path],
  }));
  const end = 10 + duration;
  return {
    scenario,
    temperature,
    fromId: `runtime-${other}`,
    toId: id,
    direction: `${other}->${branch}`,
    expectedBranch: branch,
    sourceLayout: layout(scenario === 'branch' ? other : branch),
    status: 'passed',
    documentVisibility: 'visible',
    documentHasFocus: true,
    settingsContainerConnected: false,
    nativeSettingsPresent: false,
    selectionMs: 10,
    nextFrameMs: end + 10,
    controllerCalls: [
      {
        name: 'controller.activate',
        workspaceId: id,
        status: 'fulfilled',
        startMs: 10,
        endMs: end,
        durationMs: duration,
      },
    ],
    timingsMs: { selectionToControllerComplete: duration, selectionToNextFrame: duration + 10 },
    completionEndpoint: {
      schema: SCHEMA,
      boundary: 'first-controller-settlement-observer',
      controllerCompleteMs: end,
      captureStartedMs: end,
      captureFinishedMs: end + 0.5,
      captureDurationMs: 0.5,
      activeId: id,
      revision: 1,
      journal: null,
      busy: null,
      layout: expectedLayout,
      activeFile: `${branch}-exclusive.md`,
      activeView: views[0],
      views,
      status: { workspaces: [id], git: branch },
      indexed: {
        ...Object.fromEntries(Object.keys(notes[other]).map((name) => [name, false])),
        ...Object.fromEntries(Object.keys(notes[branch]).map((name) => [name, true])),
      },
      input: {
        released: true,
        blocks: [{ startMs: 10, endMs: end - 1, status: 'fulfilled', listenerCount: 0 }],
      },
    },
    endpointExpected: {
      id,
      name: id,
      branch,
      layout: JSON.parse(JSON.stringify(expectedLayout)),
      activeFile: `${branch}-exclusive.md`,
      notes: notes[branch],
      absentPaths: [`${other}-exclusive.md`, `sidebar-${other}.md`],
    },
    endpointValidation: { status: 'passed' },
    verification: { branch, activeId: id, journal: null },
    modals: [],
    transitionModalOpened: false,
    transitionModalAtFrameOpportunity: false,
  };
}
function report(role, profile, index) {
  const duration = role === 'baseline' ? 600 : 80;
  const samples = [sample('beta', 'branch', 'cold', duration)];
  for (let n = 0; n < 3; n++)
    samples.push(sample(n % 2 ? 'beta' : 'alpha', 'branch', 'warmup', duration));
  for (let n = 0; n < 100; n++)
    samples.push(sample(n % 2 ? 'alpha' : 'beta', 'branch', 'measured', duration));
  for (let n = 0; n < 2; n++)
    samples.push(sample('alpha', 'same-branch', 'warmup', duration, `same-${n}`));
  for (let n = 0; n < 20; n++)
    samples.push(sample('alpha', 'same-branch', 'measured', duration, `same-${n % 2}`));
  samples.push(sample('alpha', 'unbound-entry', 'warmup', duration, 'unbound-a'));
  for (let n = 0; n < 2; n++)
    samples.push(sample('alpha', 'unbound', 'warmup', duration, `unbound-${n}`));
  for (let n = 0; n < 20; n++)
    samples.push(sample('alpha', 'unbound', 'measured', duration, `unbound-${n % 2}`));
  samples.push(sample('alpha', 'cleanup', 'excluded', duration));
  for (const [index, sample] of samples.entries()) {
    sample.index = index;
    sample.startedAt = '2026-01-01T00:00:01.000Z';
    sample.memory = {
      beforeTiming: syntheticMemory(),
      afterVerificationBeforePersistence: syntheticMemory(),
    };
    sample.nativeSettingsObservation = {
      schema: SETTINGS_SCHEMA,
      apiVersion: '1.15.1',
      supported: true,
      isOpen: false,
      inPopoutWindow: false,
      popoutReferencePresent: false,
      popoutWindowPresent: false,
      livePopoutWindow: false,
      modalConnected: false,
      modalInMainDocument: true,
    };
    sample.nativeWindowFocus = { schema: FOCUS_SCHEMA, supported: true, focused: true };
    sample.recorderObservation = {
      index,
      memoryAfterAppend: syntheticMemory(),
      excludedFromSwitchTiming: true,
    };
  }
  const sampleHash = createHash('sha256');
  for (const sample of samples) sampleHash.update(`${JSON.stringify(sample)}\n`);
  return {
    benchmarkSchema: 'obsidian-workspaces-switch-benchmark-v2',
    endpointSchema: SCHEMA,
    status: 'passed',
    runId: `${profile}-${index}-${role}`,
    phase: `${profile}-${index}-${role}`,
    startedAt: '2026-01-01T00:00:00.000Z',
    methodology: { fixture: 'synthetic unit data, never native evidence' },
    vault: `/synthetic/${profile}`,
    manualStart: true,
    deepTraceEnabled: false,
    cpuProfileRequested: false,
    diagnosticOnly: false,
    environment: {
      platform: 'darwin',
      architecture: 'arm64',
      release: 'synthetic',
      cpus: ['synthetic'],
      totalMemoryBytes: 1,
      runtime: { node: 'synthetic' },
      viewport: { width: 1000, height: 800 },
      autoSave: true,
      nativeSession: {
        id: `${profile}-${index}`,
        processId: index + (profile === 'small' ? 1 : 11),
      },
      productReload: reload(hashes[role]),
      sourceWorktreeStatus: '',
      productSourceCommit: (role === 'baseline' ? '1' : '2').repeat(40),
      obsidian: '1.15.1',
      plugins: {
        'obsidian-workspaces': { bundleSHA256: hashes[role] },
        'workspaces-switch-benchmark': { bundleSHA256: hashes.probe },
        'obsidian-git': { version: '2.43.0', bundleSHA256: hashes.git },
        'darlal-switcher-plus': { version: '6.3.0', bundleSHA256: hashes.chooser },
      },
    },
    fixture: {
      workload: { profile },
      trackedFiles: 1000,
      changedPaths: 20,
      markdownLeaves: 4,
      alphaCommit: '3'.repeat(40),
      betaCommit: '4'.repeat(40),
      expectedNotes: notes,
      measuredSwitches: 100,
      warmups: 3,
      baselineSamples: 20,
    },
    samples,
    recorder: {
      schema: RECORDER_SCHEMA,
      mode: RECORDER_MODE,
      runId: `${profile}-${index}-${role}`,
      complete: true,
      startedSamples: samples.length,
      completedSamples: samples.length,
      failedSamples: 0,
      rawSampleSerializations: samples.length,
      journalSHA256: hashes.evidence,
      samplesSHA256: sampleHash.digest('hex'),
      retainedDetailedSamplesBetweenSwitches: 0,
      finalAssembly: 'streamed-after-timing',
      initialMemory: syntheticMemory(),
      finalMemory: syntheticMemory(),
    },
    restoredAlpha: true,
    final: { branch: 'alpha', activeId: 'runtime-alpha', journal: null },
    finalGitStatus: '',
  };
}

/** Re-seal deliberately changed synthetic data, never native evidence. */
function attachJournal(reference, evidence) {
  const value = evidence.get(reference.path).report;
  const { samples, recorder, ...metadata } = value;
  const rows = [
    {
      kind: 'header',
      schema: RECORDER_SCHEMA,
      mode: RECORDER_MODE,
      runId: value.runId,
      phase: value.phase,
      startedAt: value.startedAt,
      identity: {
        benchmarkSchema: value.benchmarkSchema,
        productSourceCommit: value.environment.productSourceCommit,
        productBundleSHA256: value.environment.plugins['obsidian-workspaces'].bundleSHA256,
        probeSHA256: value.environment.plugins['workspaces-switch-benchmark'].bundleSHA256,
      },
    },
  ];
  const checkpoint = { ...metadata, status: 'running' };
  for (const key of [
    'final',
    'finalGitStatus',
    'restoredAlpha',
    'finishedAt',
    'summary',
    'error',
    'cleanupError',
  ])
    delete checkpoint[key];
  rows.push({ kind: 'metadata', metadata: checkpoint });
  let rawSampleBytes = 0;
  const sampleHash = createHash('sha256');
  for (const sample of samples) {
    const { recorderObservation, ...raw } = sample;
    const identity = Object.fromEntries(
      ['index', 'scenario', 'temperature', 'fromId', 'toId', 'direction', 'startedAt'].map(
        (key) => [key, sample[key]],
      ),
    );
    const sampleBytes = Buffer.byteLength(JSON.stringify(raw));
    Object.assign(recorderObservation, { sampleBytes, serializationMs: 0, appendMs: 0 });
    rawSampleBytes += sampleBytes;
    rows.push(
      { kind: 'sample-start', ...identity },
      { kind: 'sample', sample: raw },
      { kind: 'sample-recorded', observation: recorderObservation },
    );
    sampleHash.update(`${JSON.stringify(sample)}\n`);
  }
  rows.push({
    kind: 'run-complete',
    counts: {
      startedSamples: samples.length,
      completedSamples: samples.length,
      failedSamples: samples.filter((sample) => sample.status === 'failed').length,
    },
    metadata,
  });
  const journalBytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const journalHash = createHash('sha256').update(journalBytes).digest('hex');
  const path = reference.journal?.path ?? `${reference.path}.${value.runId}.samples.ndjson`;
  reference.journal = { path, sha256: journalHash };
  Object.assign(recorder, {
    journalFile: `/original-native-path/${value.runId}.samples.ndjson`,
    journalBytes: journalBytes.length,
    journalSHA256: journalHash,
    rawSampleBytes,
    samplesSHA256: sampleHash.digest('hex'),
  });
  evidence.set(path, { sha256: journalHash, journalBytes });
}
function closure() {
  const manifest = {
    schema: 'obsidian-workspaces-performance-closure-v1',
    platform: 'darwin',
    baseline: { commit: '1'.repeat(40), bundleSHA256: hashes.baseline },
    candidate: { commit: '2'.repeat(40), bundleSHA256: hashes.candidate },
    probeSHA256: hashes.probe,
    safetyProbeSHA256: hashes.safetyProbe,
    versions: { obsidian: '1.15.1', git: '2.43.0', quickSwitcher: '6.3.0' },
    scope: Object.fromEntries(
      ['small', 'representative'].map((profile) => [
        profile,
        {
          description: `Synthetic ${profile} workload for automated negative tests only`,
          basis: 'Synthetic counts are not evidence for any actual user vault.',
          suitabilityConfirmed: true,
          minimumTrackedFiles: 4,
          minimumChangedPaths: 5,
          minimumMarkdownLeaves: 4,
        },
      ]),
    ),
    sessions: [],
    safetyReports: [],
  };
  const evidence = new Map();
  for (const profile of ['small', 'representative']) {
    for (let index = 0; index < 3; index++) {
      const pair = { label: `${profile}-${index}`, profile };
      for (const role of ['baseline', 'candidate']) {
        const path = `${profile}-${index}-${role}.json`;
        pair[role] = { path, sha256: hashes.evidence };
        evidence.set(path, { sha256: hashes.evidence, report: report(role, profile, index) });
        attachJournal(pair[role], evidence);
      }
      manifest.sessions.push(pair);
    }
    const path = `${profile}-safety.json`;
    manifest.safetyReports.push({ profile, path, sha256: hashes.evidence });
    evidence.set(path, {
      sha256: hashes.evidence,
      report: {
        status: 'passed',
        phase: 'fixed',
        runId: `${profile}-safety`,
        vault: `/synthetic/${profile}`,
        checks: [
          {
            name: 'installed native plugins and disposable fixture readiness',
            status: 'passed',
            details: {
              platform: 'darwin',
              architecture: 'arm64',
              nativeSession: { id: `${profile}-2`, processId: profile === 'small' ? 3 : 13 },
              productReload: reload(hashes.candidate),
              workload: { profile },
              bundleSHA256: {
                'obsidian-workspaces': hashes.candidate,
                'obsidian-git': hashes.git,
                'darlal-switcher-plus': hashes.chooser,
                'workspaces-quick-switcher-probe': hashes.safetyProbe,
              },
              versions: manifest.versions,
            },
          },
          {
            name: 'dirty native editor rejects Q++ checkout without target layout or journal drift',
            status: 'passed',
          },
          ...[
            'test-only core names/layouts seeded for exact upstream reproduction',
            'fixed source status contains only workspace name',
            'real Q++ Enter selects beta branch and pinned main/sidebar notes',
            'real Q++ Enter selects alpha branch and pinned main/sidebar notes',
            'Q++ save-and-switch shortcut uses atomic controller operation',
            'Q++ lists and switches product workspaces with core Workspaces disabled',
            'duplicate display names select independent stable workspace IDs',
            'clean Q++ switching still works after a rejected checkout',
          ].map((name) => ({ name, status: 'passed' })),
        ],
        final: { branch: 'alpha', activeId: 'runtime-alpha', journal: null },
        finalGitStatus: '',
      },
    });
  }
  return { manifest, evidence };
}
module.exports = { hashes, notes, layout, sample, report, closure, attachJournal };
