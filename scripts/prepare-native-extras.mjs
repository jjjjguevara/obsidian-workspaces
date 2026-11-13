#!/usr/bin/env node
/** Install the small core-sidebar probe into a completed disposable native fixture. */
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const supplied = process.argv[2];
if (!supplied || !isAbsolute(supplied))
  throw new Error('Supply the absolute path of the completed disposable native fixture.');
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
) {
  throw new Error('This must be a completed disposable native fixture.');
}
const report = JSON.parse(await readFile(baseline.resultFile, 'utf8'));
if (report.status !== 'passed')
  throw new Error('The baseline native probe must pass before running the sidebar probe.');
const plugin = join(configDirectory, 'plugins/runtime-native-extras');
const resultFile = join(dirname(baseline.resultFile), 'native-extras.json');
try {
  const previous = JSON.parse(await readFile(resultFile, 'utf8'));
  if (previous.status === 'running')
    throw new Error('The sidebar probe is still running; wait for its result before rearming it.');
  if (['passed', 'failed', 'inconclusive'].includes(previous.status))
    await copyFile(resultFile, `${resultFile}.previous.json`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const runId = randomUUID();
await mkdir(plugin, { recursive: true });
await copyFile(join(repo, 'tests/obsidian/runtime-extras.cjs'), join(plugin, 'main.js'));
await writeFile(
  join(plugin, 'manifest.json'),
  JSON.stringify(
    {
      id: 'runtime-native-extras',
      name: 'Workspaces Native Sidebar Probe',
      version: '0.1.0',
      minAppVersion: '1.13.0',
      description: 'Disposable core sidebar compatibility probe.',
      author: 'jjjjguevara',
      isDesktopOnly: true,
    },
    null,
    2,
  ),
);
// A fresh data file removes completedAt, making a finished probe rerunnable
// without changing the fixture repository or workspace catalog.
await writeFile(
  join(plugin, 'data.json'),
  JSON.stringify(
    { fixture: 'obsidian-workspaces-native-extras-v1', vaultPath: vault, resultFile, runId },
    null,
    2,
  ),
);
const enabledFile = join(configDirectory, 'community-plugins.json');
const enabled = JSON.parse(await readFile(enabledFile, 'utf8'));
await writeFile(
  enabledFile,
  JSON.stringify([...new Set([...enabled, 'runtime-native-extras'])], null, 2),
);
await writeFile(
  resultFile,
  JSON.stringify(
    { status: 'prepared', vault, runId, preparedAt: new Date().toISOString() },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      vault,
      pluginId: 'runtime-native-extras',
      resultFile,
      next: 'Load or enable the new plugin in the running fixture app, or reload that vault.',
    },
    null,
    2,
  ),
);
