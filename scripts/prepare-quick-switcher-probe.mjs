#!/usr/bin/env node
/** Install/rearm the Q++ probe only in a completed, disposable native test fixture. */
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const supplied = args.shift();
const options = {};
while (args.length) {
  const name = args.shift();
  if (!['--phase', '--quick-switcher-plugin', '--result'].includes(name) || !args.length)
    throw new Error(`Unknown or incomplete option: ${name}`);
  options[name] = args.shift();
}
if (!supplied || !isAbsolute(supplied) || !['baseline', 'fixed'].includes(options['--phase']))
  throw new Error(
    'Usage: prepare-quick-switcher-probe.mjs ABS_VAULT --phase baseline|fixed --quick-switcher-plugin ABS_ASSETS [--result ABS_JSON]',
  );
if (!options['--quick-switcher-plugin'] || !isAbsolute(options['--quick-switcher-plugin']))
  throw new Error('Supply the absolute directory containing the official Quick Switcher++ assets.');
const vault = await realpath(supplied);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configDirectory = join(vault, '.obsidian');
const baseline = JSON.parse(
  await readFile(join(configDirectory, 'plugins/workspaces-runtime-probe/data.json'), 'utf8'),
);
if (
  baseline.fixture !== 'obsidian-workspaces-native-v1' ||
  baseline.vaultPath !== vault ||
  !baseline.completedAt
)
  throw new Error('This must be a completed disposable native fixture.');
const report = JSON.parse(await readFile(baseline.resultFile, 'utf8'));
if (report.status !== 'passed')
  throw new Error('The original native fixture validation must have passed.');
const git = (...args) => execFileSync('git', ['-C', vault, ...args], { encoding: 'utf8' }).trim();
if (git('remote')) throw new Error('Disposable fixture must have no Git remotes.');
if (git('status', '--porcelain'))
  throw new Error('Restore the disposable fixture to a clean worktree first.');
if (git('branch', '--show-current') !== 'alpha')
  throw new Error('The fixture must start on alpha.');
const phase = options['--phase'];
const resultFile = resolve(
  options['--result'] ?? join(dirname(baseline.resultFile), `quick-switcher-${phase}.json`),
);
const outside = relative(vault, resultFile);
if (!(outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)))
  throw new Error('The report must be outside the fixture vault.');
const pluginId = 'workspaces-quick-switcher-probe';
const plugin = join(configDirectory, 'plugins', pluginId);
try {
  const previousConfig = JSON.parse(await readFile(join(plugin, 'data.json'), 'utf8'));
  const previous = JSON.parse(await readFile(previousConfig.resultFile, 'utf8'));
  if (previous.status === 'running')
    throw new Error('The previous probe is running; wait before rearming it.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
try {
  const previous = JSON.parse(await readFile(resultFile, 'utf8'));
  if (previous.status === 'running') throw new Error('This report belongs to a running probe.');
  await copyFile(resultFile, `${resultFile}.${previous.runId ?? 'previous'}.json`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const assets = await realpath(options['--quick-switcher-plugin']);
const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
if (manifest.id !== 'darlal-switcher-plus' || manifest.version !== '6.3.0')
  throw new Error('This fixture targets official Quick Switcher++ 6.3.0.');
await mkdir(join(configDirectory, 'plugins', manifest.id), { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css'])
  await copyFile(join(assets, file), join(configDirectory, 'plugins', manifest.id, file));
const runId = randomUUID();
await mkdir(plugin, { recursive: true });
await copyFile(join(repo, 'tests/obsidian/quick-switcher-probe.cjs'), join(plugin, 'main.js'));
await writeFile(
  join(plugin, 'manifest.json'),
  JSON.stringify(
    {
      id: pluginId,
      name: 'Workspaces Quick Switcher Native Probe',
      version: '0.1.0',
      minAppVersion: '1.15.0',
      description: 'Disposable native Q++ compatibility validation.',
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
      fixture: 'obsidian-workspaces-quick-switcher-v1',
      vaultPath: vault,
      resultFile,
      runId,
      phase,
      notes: baseline.notes,
      expectedGitVersion: baseline.expectedGitVersion,
      expectedSwitcherVersion: manifest.version,
    },
    null,
    2,
  ),
);
const enabledFile = join(configDirectory, 'community-plugins.json');
const enabled = JSON.parse(await readFile(enabledFile, 'utf8'));
await writeFile(
  enabledFile,
  JSON.stringify([...new Set([...enabled, manifest.id, pluginId])], null, 2),
);
await mkdir(dirname(resultFile), { recursive: true });
await writeFile(
  resultFile,
  JSON.stringify(
    { status: 'prepared', phase, vault, runId, preparedAt: new Date().toISOString() },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      vault,
      pluginId,
      phase,
      resultFile,
      next: 'Enable Quick Switcher++ and this probe in the disposable native app. If already enabled, disable/re-enable the probe to load its new phase. The installed Workspaces bundle is unchanged.',
    },
    null,
    2,
  ),
);
