#!/usr/bin/env node
/** Local evidence gate. This command never closes an issue or contacts GitHub. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import endpoint from '../tests/obsidian/completion-endpoint.cjs';
import recorder from '../tests/obsidian/sample-recorder.cjs';
import measurementEnvironment from '../tests/obsidian/measurement-environment.cjs';
import { verifySwitchJournal } from './verify-switch-journal.mjs';

export const CONTRACT = Object.freeze({
  schema: 'obsidian-workspaces-performance-closure-v1',
  benchmarkSchema: 'obsidian-workspaces-switch-benchmark-v2',
  recorderSchema: recorder.SCHEMA,
  recorderMode: recorder.MODE,
  minimumSessionsPerProfile: 3,
  minimumBranchSamplesPerSession: 100,
  minimumControlSamplesPerSession: 20,
  medianMs: 100,
  p95Ms: 200,
  p99Ms: 300,
  normalSwitchCeilingMs: 500,
});
const sha256 = (value) => /^[a-f0-9]{64}$/.test(value ?? '');
const portableJournal = (reference) =>
  reference &&
  typeof reference.path === 'string' &&
  reference.path.length > 0 &&
  !isAbsolute(reference.path) &&
  !reference.path.includes('\\') &&
  !/^[a-zA-Z]:/.test(reference.path) &&
  sha256(reference.sha256);
const commit = (value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '');
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const REQUIRED_SAFETY_CHECKS = [
  'installed native plugins and disposable fixture readiness',
  'test-only core names/layouts seeded for exact upstream reproduction',
  'fixed source status contains only workspace name',
  'real Q++ Enter selects beta branch and pinned main/sidebar notes',
  'real Q++ Enter selects alpha branch and pinned main/sidebar notes',
  'Q++ save-and-switch shortcut uses atomic controller operation',
  'Q++ lists and switches product workspaces with core Workspaces disabled',
  'duplicate display names select independent stable workspace IDs',
  'dirty native editor rejects Q++ checkout without target layout or journal drift',
  'clean Q++ switching still works after a rejected checkout',
];
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};

export function statistics(values) {
  requireThat(
    values.length > 0 && values.every((value) => finite(value) && value >= 0),
    'Missing or invalid timing values.',
  );
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1],
    p99: sorted[Math.ceil(n * 0.99) - 1],
    min: sorted[0],
    max: sorted[n - 1],
  };
}

function assertBudget(stats, label) {
  for (const [field, limit] of [
    ['median', CONTRACT.medianMs],
    ['p95', CONTRACT.p95Ms],
    ['p99', CONTRACT.p99Ms],
  ])
    requireThat(
      stats[field] <= limit,
      `${label}: ${field} ${stats[field].toFixed(3)} ms exceeds ${limit} ms.`,
    );
}

function assertReload(value, expectedHash, apiVersion) {
  requireThat(
    value?.status === 'passed' &&
      value.mechanism === 'obsidian-1.15.1-native-disable-enable' &&
      value.apiVersion === apiVersion &&
      value.apiVersion === '1.15.1',
    'Missing inspected native product reload provenance.',
  );
  requireThat(
    value.beforeSHA256 === expectedHash && value.afterSHA256 === expectedHash,
    'Reloaded product bytes differ from the declared build.',
  );
  requireThat(
    value.newInstance === true &&
      value.newController === true &&
      value.newConstructor === true &&
      value.providerInstancesPreserved === true &&
      value.excludedFromTiming === true,
    'Product was not freshly evaluated before timing.',
  );
  requireThat(
    Array.isArray(value.enabledBefore) &&
      value.enabledBefore.includes('obsidian-workspaces') &&
      equal(value.enabledBefore, value.enabledAfter),
    'Product reload changed plugin enablement.',
  );
  requireThat(
    value.before?.activeId === 'runtime-alpha' &&
      value.before.journal === null &&
      integer(value.before.revision) &&
      equal(value.before, value.after),
    'Product reload changed the committed source context.',
  );
}

function getEvidence(reference, evidence, used, label) {
  requireThat(
    reference && typeof reference.path === 'string' && sha256(reference.sha256),
    `${label}: missing evidence path/hash.`,
  );
  requireThat(!used.has(reference.path), `${label}: evidence file reused.`);
  used.add(reference.path);
  const item = evidence.get(reference.path);
  requireThat(
    item && item.sha256 === reference.sha256,
    `${label}: evidence bytes do not match the manifest SHA-256.`,
  );
  return item.report;
}

function getJournalEvidence(reference, report, evidence, used, label) {
  requireThat(
    portableJournal(reference),
    `${label}: missing portable journal path/hash reference.`,
  );
  requireThat(!used.has(reference.path), `${label}: journal evidence file reused.`);
  used.add(reference.path);
  const item = evidence.get(reference.path);
  requireThat(
    item && item.sha256 === reference.sha256 && Buffer.isBuffer(item.journalBytes),
    `${label}: journal file is missing or its bytes do not match the manifest SHA-256.`,
  );
  return {
    path: reference.path,
    fileSHA256: item.sha256,
    ...verifySwitchJournal(report, item.journalBytes),
  };
}

function pairedLayoutEvidence(report) {
  const leaves = (layout) =>
    endpoint
      .fileLeaves(layout)
      .map((leaf) => JSON.stringify([leaf.region, leaf.path, leaf.type, leaf.pinned]))
      .sort();
  // Saved/generated IDs and native tab metadata may differ across restores.
  // Keep duplicate file tuples: a second editor is additional timed work.
  return report.samples.map((sample) => [
    sample.scenario,
    sample.temperature,
    sample.expectedBranch,
    leaves(sample.sourceLayout),
    leaves(sample.endpointExpected.layout),
  ]);
}

function verifyReport(report, manifest, role, profile) {
  requireThat(
    report?.benchmarkSchema === CONTRACT.benchmarkSchema &&
      report.endpointSchema === endpoint.SCHEMA,
    'Missing completion-aware benchmark schema.',
  );
  requireThat(
    report.status === 'passed' && !report.error && !report.cleanupError,
    'Benchmark did not finish successfully.',
  );
  requireThat(
    report.recorder?.schema === CONTRACT.recorderSchema &&
      report.recorder.mode === CONTRACT.recorderMode &&
      report.recorder.complete === true &&
      report.recorder.runId === report.runId &&
      report.recorder.finalAssembly === 'streamed-after-timing' &&
      report.recorder.retainedDetailedSamplesBetweenSwitches === 0,
    'Missing complete append-only recorder evidence; older observer protocols are diagnostic only.',
  );
  requireThat(
    report.manualStart === true &&
      report.deepTraceEnabled === false &&
      report.cpuProfileRequested === false &&
      report.diagnosticOnly === false,
    'Only visible manual-start normal runs qualify.',
  );
  requireThat(
    typeof report.runId === 'string' && report.runId.length > 0,
    'Missing native run identity.',
  );
  const env = report.environment;
  requireThat(env?.platform === 'darwin', 'Mac closure requires native Darwin evidence.');
  requireThat(
    typeof env.architecture === 'string' &&
      typeof env.nativeSession?.id === 'string' &&
      integer(env.nativeSession.processId, 1),
    'Missing native session identity.',
  );
  requireThat(
    env.productSourceCommit === manifest[role].commit,
    'Declared installed product source commit differs from the closure target.',
  );
  requireThat(env.sourceWorktreeStatus === '', 'Benchmark source checkout was dirty.');
  requireThat(
    env.plugins?.['obsidian-workspaces']?.bundleSHA256 === manifest[role].bundleSHA256,
    'Installed product bundle is not the declared exact build.',
  );
  assertReload(env.productReload, manifest[role].bundleSHA256, env.obsidian);
  requireThat(
    env.plugins?.['workspaces-switch-benchmark']?.bundleSHA256 === manifest.probeSHA256,
    'Installed benchmark bundle differs from the declared probe.',
  );
  requireThat(
    env.obsidian === manifest.versions.obsidian &&
      env.plugins['obsidian-git']?.version === manifest.versions.git &&
      env.plugins['darlal-switcher-plus']?.version === manifest.versions.quickSwitcher,
    'Host/provider/chooser versions differ from the declared environment.',
  );
  for (const id of ['obsidian-git', 'darlal-switcher-plus'])
    requireThat(sha256(env.plugins[id]?.bundleSHA256), `Missing ${id} bundle hash.`);
  const fixture = report.fixture;
  const scope = manifest.scope[profile];
  requireThat(
    fixture?.workload?.profile === profile,
    'Fixture workload profile differs from the manifest.',
  );
  requireThat(
    integer(fixture.trackedFiles, scope.minimumTrackedFiles) &&
      integer(fixture.changedPaths, scope.minimumChangedPaths) &&
      integer(fixture.markdownLeaves, scope.minimumMarkdownLeaves),
    'Measured fixture is smaller than the declared workload scope.',
  );
  requireThat(
    commit(fixture.alphaCommit) && commit(fixture.betaCommit),
    'Missing fixture commit identities.',
  );
  for (const branch of ['alpha', 'beta']) {
    const notes = fixture.expectedNotes?.[branch];
    requireThat(
      notes &&
        typeof notes[`${branch}-exclusive.md`] === 'string' &&
        typeof notes[`sidebar-${branch}.md`] === 'string' &&
        typeof notes['shared.md'] === 'string',
      'Missing branch-exclusive/sidebar/shared content expectations.',
    );
  }
  requireThat(
    fixture.expectedNotes.alpha['shared.md'] !== fixture.expectedNotes.beta['shared.md'],
    'Shared-path content does not distinguish branches.',
  );
  requireThat(Array.isArray(report.samples) && report.samples.length > 0, 'No native samples.');
  const validMemory = (value) =>
    ['performanceMs', 'rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'].every(
      (key) => finite(value?.[key]) && value[key] >= 0,
    ) && value.heapUsed <= value.heapTotal;
  requireThat(
    validMemory(report.recorder.initialMemory) && validMemory(report.recorder.finalMemory),
    'Missing renderer memory observations outside timing.',
  );
  const groups = {};
  for (const sample of report.samples) {
    requireThat(
      sample.status === 'passed' && !sample.error && !sample.completionCaptureError,
      'A transition failed or lacks completion evidence.',
    );
    requireThat(
      sample.sourceLayout &&
        typeof sample.sourceLayout === 'object' &&
        !Array.isArray(sample.sourceLayout),
      'Missing observed source layout workload.',
    );
    requireThat(
      validMemory(sample.memory?.beforeTiming) &&
        validMemory(sample.memory?.afterVerificationBeforePersistence) &&
        validMemory(sample.recorderObservation?.memoryAfterAppend) &&
        sample.recorderObservation.excludedFromSwitchTiming === true,
      'Missing outside-timer sample memory/recorder observations.',
    );
    requireThat(
      sample.documentVisibility === 'visible' &&
        sample.documentHasFocus === true &&
        sample.settingsContainerConnected === false &&
        sample.nativeSettingsPresent === false,
      'A sample ran with hidden/unfocused workspace or Settings open.',
    );
    measurementEnvironment.assertMeasurementEnvironment(sample);
    requireThat(
      sample.controllerCalls?.length === 1 &&
        sample.controllerCalls[0].name === 'controller.activate' &&
        sample.controllerCalls[0].status === 'fulfilled',
      'Sample did not complete exactly one actual controller activation.',
    );
    const call = sample.controllerCalls[0];
    requireThat(
      call.workspaceId === sample.toId,
      'Actual controller request targets a different workspace.',
    );
    requireThat(
      finite(sample.selectionMs) &&
        finite(call.endMs) &&
        call.endMs >= sample.selectionMs &&
        finite(sample.nextFrameMs) &&
        sample.nextFrameMs >= call.endMs,
      'Invalid selection/completion/frame timestamps.',
    );
    const duration = call.endMs - sample.selectionMs;
    requireThat(
      Math.abs(sample.timingsMs?.selectionToControllerComplete - duration) < 0.000001,
      'Reported duration does not match raw endpoints.',
    );
    requireThat(
      Math.abs(sample.timingsMs?.selectionToNextFrame - (sample.nextFrameMs - sample.selectionMs)) <
        0.000001,
      'Reported next-frame duration does not match raw endpoints.',
    );
    requireThat(
      sample.completionEndpoint?.controllerCompleteMs === call.endMs &&
        sample.endpointValidation?.status === 'passed',
      'Missing validation of this exact completion boundary.',
    );
    requireThat(
      sample.completionEndpoint.captureFinishedMs <= sample.nextFrameMs &&
        Math.abs(
          sample.completionEndpoint.captureDurationMs -
            (sample.completionEndpoint.captureFinishedMs -
              sample.completionEndpoint.captureStartedMs),
        ) < 0.000001,
      'Completion snapshot was captured after the next frame or has inconsistent duration.',
    );
    requireThat(
      sample.endpointExpected?.id === sample.toId &&
        sample.endpointExpected?.branch === sample.expectedBranch,
      'Endpoint expectation targets a different transition.',
    );
    requireThat(
      equal(sample.endpointExpected.notes, fixture.expectedNotes[sample.expectedBranch]),
      'Endpoint content expectations differ from the independent fixture.',
    );
    // Only a switch with no checkout may leave hidden views deferred (ADR 0004,
    // amendment of 2026-11-16). A branch sample always gets every requirement.
    requireThat(
      sample.scenario !== 'branch' || sample.endpointExpected.branchChanged !== false,
      'A branch switch was validated without the deferred-view requirement.',
    );
    endpoint.assertCompletionEndpoint(sample.completionEndpoint, sample.endpointExpected);
    requireThat(
      endpoint
        .fileLeaves(sample.completionEndpoint.layout)
        .filter((leaf) => leaf.type === 'markdown').length >= scope.minimumMarkdownLeaves,
      'Completion layout is smaller than the declared editor workload.',
    );
    requireThat(
      sample.verification?.branch === sample.expectedBranch &&
        sample.verification.activeId === sample.toId &&
        sample.verification.journal === null,
      'Independent post-endpoint branch/state verification is missing or disagrees.',
    );
    requireThat(
      Array.isArray(sample.modals) &&
        typeof sample.transitionModalOpened === 'boolean' &&
        typeof sample.transitionModalAtFrameOpportunity === 'boolean',
      'Missing progress observations.',
    );
    const modal = sample.modals.some((entry) => entry.kind === 'transition-progress');
    requireThat(
      sample.transitionModalOpened === modal,
      'Progress summary disagrees with raw modal observations.',
    );
    if (role === 'candidate') {
      requireThat(
        !modal && !sample.transitionModalAtFrameOpportunity,
        'Candidate displayed transition progress.',
      );
      requireThat(
        duration < CONTRACT.normalSwitchCeilingMs &&
          sample.timingsMs.selectionToNextFrame < CONTRACT.normalSwitchCeilingMs,
        'Candidate did not finish and reach a frame opportunity within 500 ms.',
      );
    }
    const group = `${sample.scenario}/${sample.temperature}`;
    (groups[group] ??= []).push({ sample, duration });
  }
  const branch = groups['branch/measured'] ?? [];
  const same = groups['same-branch/measured'] ?? [];
  const unbound = groups['unbound/measured'] ?? [];
  requireThat(
    branch.length >= CONTRACT.minimumBranchSamplesPerSession &&
      branch.length % 2 === 0 &&
      fixture.measuredSwitches === branch.length,
    'Insufficient or unbalanced measured branch samples.',
  );
  requireThat(
    same.length >= CONTRACT.minimumControlSamplesPerSession &&
      same.length % 2 === 0 &&
      unbound.length === same.length &&
      fixture.baselineSamples === same.length,
    'Insufficient same-branch/unbound controls.',
  );
  requireThat(
    groups['branch/cold']?.length === 1 &&
      integer(fixture.warmups, 3) &&
      fixture.warmups % 2 === 1 &&
      groups['branch/warmup']?.length === fixture.warmups,
    'Missing first switch or branch warmups.',
  );
  requireThat(
    report.samples.length === branch.length + 2 * same.length + fixture.warmups + 7,
    'Unexpected, missing, or omitted transition samples.',
  );
  requireThat(
    report.recorder.startedSamples === report.samples.length &&
      report.recorder.completedSamples === report.samples.length &&
      report.recorder.failedSamples === 0 &&
      report.recorder.rawSampleSerializations === report.samples.length &&
      sha256(report.recorder.journalSHA256) &&
      report.samples.every(
        (sample, index) => sample.index === index && sample.recorderObservation.index === index,
      ),
    'Recorder evidence has missing, duplicate or out-of-order attempts.',
  );
  const samplesHash = createHash('sha256');
  for (const sample of report.samples) samplesHash.update(`${JSON.stringify(sample)}\n`);
  requireThat(
    samplesHash.digest('hex') === report.recorder.samplesSHA256,
    'Raw samples differ from the completed recorder digest.',
  );
  branch.forEach(({ sample }, index) => {
    const target = index % 2 === 0 ? 'beta' : 'alpha';
    const source = target === 'beta' ? 'alpha' : 'beta';
    requireThat(
      sample.toId === `runtime-${target}` &&
        sample.fromId === `runtime-${source}` &&
        sample.direction === `${source}->${target}` &&
        sample.expectedBranch === target,
      'Measured branch directions do not alternate equally.',
    );
  });
  requireThat(
    report.restoredAlpha === true &&
      report.final?.branch === 'alpha' &&
      report.final.activeId === 'runtime-alpha' &&
      report.final.journal === null &&
      report.finalGitStatus === '',
    'Fixture did not finish on clean Alpha with no journal.',
  );
  const summary = {};
  for (const [name, values] of [
    ['branch', branch],
    ['sameBranch', same],
    ['unbound', unbound],
  ]) {
    summary[name] = statistics(values.map((value) => value.duration));
    summary[`${name}NextFrame`] = statistics(
      values.map(({ sample }) => sample.timingsMs.selectionToNextFrame),
    );
    if (role === 'candidate') assertBudget(summary[name], name);
  }
  summary.firstSwitch = groups['branch/cold'][0].duration;
  summary.modalCount = report.samples.filter((sample) => sample.transitionModalOpened).length;
  summary.endpointCount = report.samples.length;
  return { summary, report, groups };
}

/** Pure evaluator, exported so rejection paths are covered without a native app. */
export function evaluateClosure(manifest, evidence) {
  const failures = [];
  const sessions = [];
  const used = new Set();
  const usedRunIds = new Set();
  const nativeSessions = new Map();
  const nativeProcesses = new Set();
  const pooledValues = {};
  const result = {
    schema: CONTRACT.schema,
    status: 'blocked',
    closureAllowed: false,
    contract: CONTRACT,
    workloadScope: manifest?.scope ?? null,
    sessions,
    pooled: {},
    failures,
  };
  try {
    requireThat(
      manifest?.schema === CONTRACT.schema && manifest.platform === 'darwin',
      'Missing Mac closure manifest schema.',
    );
    for (const role of ['baseline', 'candidate'])
      requireThat(
        commit(manifest[role]?.commit) && sha256(manifest[role]?.bundleSHA256),
        `Missing exact ${role} commit/bundle identity.`,
      );
    requireThat(
      manifest.baseline.bundleSHA256 !== manifest.candidate.bundleSHA256,
      'Baseline and candidate bundles are identical.',
    );
    requireThat(sha256(manifest.probeSHA256), 'Missing benchmark bundle identity.');
    requireThat(sha256(manifest.safetyProbeSHA256), 'Missing native safety probe bundle identity.');
    requireThat(
      typeof manifest.versions?.obsidian === 'string' &&
        manifest.versions.git === '2.43.0' &&
        manifest.versions.quickSwitcher === '6.3.0',
      'Declare the inspected Obsidian/Git/Q++ versions.',
    );
    for (const profile of ['small', 'representative']) {
      const scope = manifest.scope?.[profile];
      requireThat(
        typeof scope?.description === 'string' &&
          scope.description.trim().length >= 20 &&
          integer(scope.minimumTrackedFiles, 4) &&
          integer(scope.minimumChangedPaths, 5) &&
          integer(scope.minimumMarkdownLeaves, 4),
        `Missing explicit ${profile} workload scope.`,
      );
    }
    requireThat(
      typeof manifest.scope.representative.basis === 'string' &&
        manifest.scope.representative.basis.trim().length >= 30 &&
        manifest.scope.representative.suitabilityConfirmed === true,
      'Representative workload requires its relation to the user workload and limitations.',
    );
    requireThat(
      Array.isArray(manifest.sessions) && manifest.sessions.length >= 6,
      'Need at least three paired sessions for each workload profile.',
    );
    for (const entry of manifest.sessions) {
      const label = `Session ${entry.label ?? sessions.length + 1}`;
      try {
        requireThat(
          ['small', 'representative'].includes(entry.profile),
          'Unknown workload profile.',
        );
        const pair = {};
        for (const role of ['baseline', 'candidate']) {
          const report = getEvidence(entry[role], evidence, used, `${label} ${role}`);
          requireThat(!usedRunIds.has(report.runId), 'Native report run ID reused.');
          usedRunIds.add(report.runId);
          pair[role] = verifyReport(report, manifest, role, entry.profile);
        }
        const a = pair.baseline.report;
        const b = pair.candidate.report;
        requireThat(
          a.environment.nativeSession.id === b.environment.nativeSession.id &&
            a.environment.nativeSession.processId === b.environment.nativeSession.processId,
          'Pair was not observed in the same native session.',
        );
        requireThat(
          !nativeSessions.has(b.environment.nativeSession.id),
          'A native session was reused for another pair; restart the fixture window.',
        );
        nativeSessions.set(b.environment.nativeSession.id, entry.profile);
        requireThat(
          !nativeProcesses.has(b.environment.nativeSession.processId),
          'Renderer process was reused across independent pairs; quit and relaunch Obsidian.',
        );
        nativeProcesses.add(b.environment.nativeSession.processId);
        for (const key of [
          'platform',
          'architecture',
          'release',
          'cpus',
          'totalMemoryBytes',
          'runtime',
          'viewport',
          'autoSave',
        ])
          requireThat(equal(a.environment[key], b.environment[key]), `Pair differs in ${key}.`);
        for (const id of ['obsidian-git', 'darlal-switcher-plus'])
          requireThat(
            equal(a.environment.plugins[id], b.environment.plugins[id]),
            `Pair differs in ${id} assets.`,
          );
        for (const key of [
          'alphaCommit',
          'betaCommit',
          'workload',
          'trackedFiles',
          'changedPaths',
          'markdownLeaves',
          'measuredSwitches',
          'warmups',
          'baselineSamples',
          'expectedNotes',
        ])
          requireThat(equal(a.fixture[key], b.fixture[key]), `Pair differs in fixture ${key}.`);
        requireThat(
          equal(pairedLayoutEvidence(a), pairedLayoutEvidence(b)),
          'Pair differs in source/target file leaves, regions, types, pins or editor multiplicities.',
        );
        for (const role of ['baseline', 'candidate'])
          pair[role].journal = getJournalEvidence(
            entry[role].journal,
            pair[role].report,
            evidence,
            used,
            `${label} ${role}`,
          );
        sessions.push({
          label: entry.label,
          profile: entry.profile,
          nativeSession: b.environment.nativeSession.id,
          nativeProcessId: b.environment.nativeSession.processId,
          baseline: pair.baseline.summary,
          candidate: pair.candidate.summary,
          journals: { baseline: pair.baseline.journal, candidate: pair.candidate.journal },
        });
        const pool = (pooledValues[entry.profile] ??= { baseline: {}, candidate: {} });
        for (const role of ['baseline', 'candidate'])
          for (const scenario of ['branch', 'same-branch', 'unbound'])
            (pool[role][scenario] ??= []).push(
              ...pair[role].groups[`${scenario}/measured`].map((entry) => entry.duration),
            );
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    }
    for (const profile of ['small', 'representative'])
      requireThat(
        sessions.filter((session) => session.profile === profile).length >=
          CONTRACT.minimumSessionsPerProfile,
        `${profile}: fewer than three valid paired native sessions.`,
      );
    for (const profile of ['small', 'representative']) {
      result.pooled[profile] = {};
      for (const role of ['baseline', 'candidate']) {
        result.pooled[profile][role] = {};
        for (const scenario of ['branch', 'same-branch', 'unbound']) {
          const stats = statistics(pooledValues[profile][role][scenario]);
          result.pooled[profile][role][scenario] = stats;
          if (role === 'candidate') assertBudget(stats, `${profile} pooled ${scenario}`);
        }
      }
    }
    requireThat(Array.isArray(manifest.safetyReports), 'Missing fresh native safety reports.');
    for (const profile of ['small', 'representative']) {
      const refs = manifest.safetyReports.filter((entry) => entry.profile === profile);
      requireThat(refs.length === 1, `${profile}: provide one final native safety report.`);
      const report = getEvidence(refs[0], evidence, used, `${profile} safety`);
      requireThat(
        typeof report.runId === 'string' &&
          report.runId.length > 0 &&
          !usedRunIds.has(report.runId),
        `${profile}: missing or repeated safety run identity.`,
      );
      usedRunIds.add(report.runId);
      const setup = report?.checks?.find(
        (check) => check.name === 'installed native plugins and disposable fixture readiness',
      )?.details;
      requireThat(
        report.status === 'passed' &&
          report.phase === 'fixed' &&
          !report.error &&
          !report.cleanupError &&
          equal(
            report.checks.map((check) => check.name).sort(),
            [...REQUIRED_SAFETY_CHECKS].sort(),
          ) &&
          report.checks.every((check) => check.status === 'passed'),
        `${profile}: native safety scenarios did not all pass.`,
      );
      requireThat(
        setup?.platform === 'darwin' &&
          setup.workload?.profile === profile &&
          setup.bundleSHA256?.['obsidian-workspaces'] === manifest.candidate.bundleSHA256,
        `${profile}: safety report platform/profile/bundle mismatch.`,
      );
      requireThat(
        setup.bundleSHA256?.['workspaces-quick-switcher-probe'] === manifest.safetyProbeSHA256,
        `${profile}: native safety probe hash differs.`,
      );
      requireThat(
        nativeSessions.get(setup.nativeSession?.id) === profile &&
          sessions.some(
            (session) =>
              session.nativeSession === setup.nativeSession?.id &&
              session.nativeProcessId === setup.nativeSession?.processId,
          ),
        `${profile}: safety report belongs to an unobserved native session.`,
      );
      const paired = manifest.sessions.find(
        (entry) =>
          entry.profile === profile &&
          evidence.get(entry.candidate.path)?.report.environment.nativeSession.id ===
            setup.nativeSession.id,
      );
      const candidate = paired && evidence.get(paired.candidate.path).report;
      requireThat(
        candidate &&
          candidate.vault === report.vault &&
          equal(candidate.fixture.workload, setup.workload) &&
          candidate.environment.architecture === setup.architecture,
        `${profile}: safety evidence is not from the measured workload.`,
      );
      for (const id of ['obsidian-git', 'darlal-switcher-plus'])
        requireThat(
          setup.bundleSHA256[id] === candidate.environment.plugins[id].bundleSHA256,
          `${profile}: safety provider assets differ from timing.`,
        );
      assertReload(setup.productReload, manifest.candidate.bundleSHA256, setup.versions?.obsidian);
      requireThat(
        setup.versions?.obsidian === manifest.versions.obsidian &&
          setup.versions.git === manifest.versions.git &&
          setup.versions.quickSwitcher === manifest.versions.quickSwitcher,
        `${profile}: safety report versions differ.`,
      );
      requireThat(
        report.checks.some(
          (check) =>
            check.name ===
            'dirty native editor rejects Q++ checkout without target layout or journal drift',
        ),
        `${profile}: missing dirty-editor safety scenario.`,
      );
      requireThat(
        report.final?.branch === 'alpha' &&
          report.final.activeId === 'runtime-alpha' &&
          report.final.journal === null &&
          report.finalGitStatus === '',
        `${profile}: safety fixture did not finish clean.`,
      );
    }
    if (!failures.length) {
      result.status = 'passed';
      result.closureAllowed = true;
    }
  } catch (error) {
    failures.push(error.message);
  }
  result.nextAction = result.closureAllowed
    ? 'Attach this result, manifest, raw evidence and independent review to the issue; publish the measured final performance and scope before a separate explicit closure.'
    : 'Keep the performance issue open. Supply missing evidence or optimize and rerun against the final installed bundle.';
  return result;
}

export async function loadEvidence(manifest, manifestDirectory) {
  const evidence = new Map();
  const refs = [
    ...(manifest.sessions ?? []).flatMap((session) => [session.baseline, session.candidate]),
    ...(manifest.safetyReports ?? []),
  ];
  const files = refs.flatMap((ref) => [
    { ref, kind: 'report' },
    ...(ref?.journal ? [{ ref: ref.journal, kind: 'journal' }] : []),
  ]);
  for (const { ref, kind } of files) {
    if (kind === 'journal')
      requireThat(portableJournal(ref), 'Missing portable journal path/hash reference.');
    if (!ref?.path || evidence.has(ref.path)) continue;
    const bytes = await readFile(resolve(manifestDirectory, ref.path));
    const content = ref.path.endsWith('.gz') ? gunzipSync(bytes) : bytes;
    evidence.set(ref.path, {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(kind === 'journal'
        ? { journalBytes: content }
        : { report: JSON.parse(content.toString('utf8')) }),
    });
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  let outputPath;
  try {
    const [filename, option, destination, ...extra] = process.argv.slice(2);
    if (
      !filename ||
      extra.length ||
      (option !== undefined && (option !== '--output' || !destination))
    )
      throw new Error('Usage: check-switch-performance.mjs MANIFEST.json [--output CLOSURE.json]');
    if (destination && resolve(destination) === resolve(filename))
      throw new Error('The closure output must not overwrite its input manifest.');
    outputPath = destination;
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    const refs = [
      ...(manifest.sessions ?? []).flatMap((session) => [session.baseline, session.candidate]),
      ...(manifest.safetyReports ?? []),
    ];
    if (
      destination &&
      refs
        .flatMap((ref) => [ref, ...(ref?.journal ? [ref.journal] : [])])
        .some(
          (ref) =>
            ref?.path && resolve(dirname(resolve(filename)), ref.path) === resolve(destination),
        )
    ) {
      outputPath = undefined;
      throw new Error('The closure output must not overwrite a raw evidence report.');
    }
    const evidence = await loadEvidence(manifest, dirname(resolve(filename)));
    output = { ...evaluateClosure(manifest, evidence), generatedAt: new Date().toISOString() };
  } catch (error) {
    output = {
      schema: CONTRACT.schema,
      status: 'blocked',
      closureAllowed: false,
      failures: [error.message],
      nextAction: 'Keep the issue open; evidence could not be evaluated.',
    };
  }
  if (outputPath) {
    try {
      await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      output.status = 'blocked';
      output.closureAllowed = false;
      output.failures.push(`Could not write closure output: ${error.message}`);
      output.nextAction =
        'Keep the issue open; preserve existing files and choose a new closure output path.';
    }
  }
  console.log(JSON.stringify(output, null, 2));
  if (!output.closureAllowed) process.exitCode = 1;
}
