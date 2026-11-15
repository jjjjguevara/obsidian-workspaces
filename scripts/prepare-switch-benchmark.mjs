#!/usr/bin/env node
/** Install/rearm a timing probe only in a completed disposable native fixture. */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  resolveEvidenceOutput,
  publishPreparedReport,
  archiveEvidenceOutput,
} from './benchmark-output.mjs';
import {
  SCHEMA as RECORDER_SCHEMA,
  MODE as RECORDER_MODE,
} from '../tests/obsidian/sample-recorder.cjs';

const args = process.argv.slice(2);
const supplied = args.shift();
const options = {};
const usage =
  'Usage: prepare-switch-benchmark.mjs ABS_VAULT --phase baseline|optimized [--product-commit FULL_SHA] [--result ABS_JSON] [--samples EVEN_AT_LEAST_20 | --diagnostic-samples EVEN_AT_LEAST_2] [--warmups ODD_AT_LEAST_1] [--baseline-samples EVEN_OR_ZERO] [--manual-start] [--deep-trace [--cpu-profile]]';
while (args.length) {
  const name = args.shift();
  if (Object.hasOwn(options, name)) throw new Error(`Repeated option: ${name}`);
  if (['--deep-trace', '--cpu-profile', '--manual-start'].includes(name)) {
    options[name] = true;
    continue;
  }
  if (
    ![
      '--phase',
      '--result',
      '--samples',
      '--diagnostic-samples',
      '--warmups',
      '--baseline-samples',
      '--product-commit',
    ].includes(name) ||
    !args.length ||
    args[0].startsWith('--')
  )
    throw new Error(`Unknown or incomplete option: ${name}`);
  options[name] = args.shift();
}
if (!supplied || !isAbsolute(supplied) || !/^[a-z][a-z0-9-]{0,63}$/.test(options['--phase'] ?? ''))
  throw new Error(usage);
const deepTrace = options['--deep-trace'] === true;
const cpuProfile = options['--cpu-profile'] === true;
const manualStart = options['--manual-start'] === true;
const diagnosticOnly = options['--diagnostic-samples'] !== undefined;
if (cpuProfile && !deepTrace) throw new Error('--cpu-profile requires --deep-trace.');
if (diagnosticOnly && (!deepTrace || options['--samples'] !== undefined))
  throw new Error(
    '--diagnostic-samples requires --deep-trace and cannot be combined with --samples.',
  );
if (options['--result'] && !isAbsolute(options['--result']))
  throw new Error('--result requires an absolute path.');
if (
  options['--product-commit'] &&
  !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options['--product-commit'])
)
  throw new Error('--product-commit requires the full source commit for the installed product.');
const integer = (option, fallback, minimum, parity) => {
  const value = Number(options[option] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > 1000 || value % 2 !== parity)
    throw new Error(`${option} must be ${parity ? 'odd' : 'even'}, between ${minimum} and 1000.`);
  return value;
};
const samples = diagnosticOnly
  ? integer('--diagnostic-samples', 2, 2, 0)
  : integer('--samples', 20, 20, 0);
const warmups = integer('--warmups', 3, 1, 1);
const baselineSamples = integer('--baseline-samples', 6, 0, 0);
const vault = await realpath(supplied);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configDirectory = join(vault, '.obsidian');
const marker = JSON.parse(
  await readFile(join(configDirectory, 'plugins/workspaces-runtime-probe/data.json'), 'utf8'),
);
if (
  marker.fixture !== 'obsidian-workspaces-native-v1' ||
  marker.vaultPath !== vault ||
  !marker.completedAt
)
  throw new Error('Refusing a live/non-disposable vault: use a completed native runtime fixture.');
const originalReport = JSON.parse(await readFile(marker.resultFile, 'utf8'));
if (originalReport.status !== 'passed')
  throw new Error('The original native fixture must have passed.');
const git = (...command) =>
  execFileSync('git', ['-C', vault, ...command], { encoding: 'utf8' }).trim();
if (git('remote')) throw new Error('The disposable fixture must have no Git remotes.');
if (git('status', '--porcelain'))
  throw new Error('Restore the disposable fixture to a clean worktree.');
if (git('branch', '--show-current') !== 'alpha')
  throw new Error('The fixture must start on alpha.');
for (const branch of ['alpha', 'beta']) git('show-ref', '--verify', `refs/heads/${branch}`);

const phase = options['--phase'];
const resultFile = await resolveEvidenceOutput(
  vault,
  options['--result'] ?? join(dirname(marker.resultFile), `switch-benchmark-${phase}.json`),
);
const pluginId = 'workspaces-switch-benchmark';
const plugin = join(configDirectory, 'plugins', pluginId);
try {
  const previousConfig = JSON.parse(await readFile(join(plugin, 'data.json'), 'utf8'));
  const previous = JSON.parse(await readFile(previousConfig.resultFile, 'utf8'));
  if (previous.status === 'running')
    throw new Error('The previous benchmark is running; wait before rearming it.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const versions = {};
let expectedProductSHA256;
for (const [id, expected] of [
  ['obsidian-git', '2.43.0'],
  ['darlal-switcher-plus', '6.3.0'],
  ['obsidian-workspaces', null],
]) {
  const manifest = JSON.parse(
    await readFile(join(configDirectory, 'plugins', id, 'manifest.json'), 'utf8'),
  );
  if (manifest.id !== id || (expected && manifest.version !== expected))
    throw new Error(`Expected installed ${id}${expected ? ` ${expected}` : ''}.`);
  versions[id] = manifest.version;
  if (id === 'obsidian-workspaces')
    expectedProductSHA256 = createHash('sha256')
      .update(await readFile(join(configDirectory, 'plugins', id, 'main.js')))
      .digest('hex');
}
try {
  const previous = JSON.parse(await readFile(resultFile, 'utf8'));
  if (previous.status === 'running')
    throw new Error('The selected report belongs to a running benchmark.');
  // Always use a fresh suffix: repeated rearming must not replace an older archive.
  await archiveEvidenceOutput(resultFile);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const runId = randomUUID();
const journalFile = `${resultFile}.${runId}.samples.ndjson`;
await mkdir(plugin, { recursive: true });
// Bundle the existing independent native verifier; no production helper is used
// to decide whether branch, pins, indexed files, and editor contents are correct.
await build({
  entryPoints: [join(repo, 'tests/obsidian/switch-benchmark.cjs')],
  outfile: join(plugin, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  external: ['obsidian'],
  logLevel: 'warning',
});
const probeSHA256 = createHash('sha256')
  .update(await readFile(join(plugin, 'main.js')))
  .digest('hex');
await writeFile(
  join(plugin, 'manifest.json'),
  JSON.stringify(
    {
      id: pluginId,
      name: 'Workspaces Switch Latency Benchmark',
      version: '0.1.0',
      minAppVersion: '1.15.0',
      description: 'Test-only native timing probe for an identified disposable vault.',
      author: 'jjjjguevara',
      isDesktopOnly: true,
    },
    null,
    2,
  ),
);
await writeFile(
  join(plugin, 'data.json'),
  JSON.stringify(
    {
      fixture: 'obsidian-workspaces-switch-benchmark-v1',
      vaultPath: vault,
      resultFile,
      runId,
      recorderSchema: RECORDER_SCHEMA,
      recorderMode: RECORDER_MODE,
      phase,
      samples,
      warmups,
      baselineSamples,
      deepTrace,
      cpuProfile,
      manualStart,
      diagnosticOnly,
      notes: marker.notes,
      expectedGitVersion: versions['obsidian-git'],
      expectedSwitcherVersion: versions['darlal-switcher-plus'],
      probeSHA256,
      expectedProductSHA256,
      productSourceCommit: options['--product-commit'] ?? null,
      preparedFromCommit: gitFromSource('rev-parse', 'HEAD'),
      sourceWorktreeStatus: gitFromSource('status', '--porcelain'),
    },
    null,
    2,
  ),
);
const enabledFile = join(configDirectory, 'community-plugins.json');
const enabled = JSON.parse(await readFile(enabledFile, 'utf8'));
await writeFile(enabledFile, JSON.stringify([...new Set([...enabled, pluginId])], null, 2));
await publishPreparedReport(resultFile, {
  status: 'prepared',
  phase,
  vault,
  runId,
  recorderSchema: RECORDER_SCHEMA,
  recorderMode: RECORDER_MODE,
  journalFile,
  deepTrace,
  cpuProfile,
  manualStart,
  diagnosticOnly,
  preparedAt: new Date().toISOString(),
});
console.log(
  JSON.stringify(
    {
      vault,
      pluginId,
      phase,
      resultFile,
      journalFile,
      samples,
      warmups,
      baselineSamples,
      deepTrace,
      cpuProfile,
      manualStart,
      diagnosticOnly,
      probeSHA256,
      expectedProductSHA256,
      next: `The currently installed Workspaces bundle is pinned by SHA-256. Enable/reload Workspaces and Quick Switcher++, then enable this benchmark. ${manualStart ? 'Close Settings, then run the benchmark plugin command “Run switch benchmark” from the command palette.' : 'The benchmark starts automatically when the layout is ready.'} Rearming requires disabling the benchmark first. Install a different Workspaces bundle BEFORE preparing again. Workspaces assets were not changed. Deep tracing adds diagnostic observation; CPU profiling is optional, requires deep tracing, and depends on native runtime capability.`,
    },
    null,
    2,
  ),
);

function gitFromSource(...command) {
  return execFileSync('git', ['-C', repo, ...command], { encoding: 'utf8' }).trim();
}
