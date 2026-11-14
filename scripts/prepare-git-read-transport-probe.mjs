#!/usr/bin/env node
/** Manual, read-only native transport experiment; disposable fixtures only. */
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const supplied = args.shift();
let resultArgument;
if (args.length === 2 && args[0] === '--result') resultArgument = args[1];
else if (args.length)
  throw new Error('Usage: prepare-git-read-transport-probe.mjs ABS_VAULT [--result ABS_JSON]');
if (!supplied || !isAbsolute(supplied) || (resultArgument && !isAbsolute(resultArgument)))
  throw new Error('Vault and report paths must be absolute.');
const vault = await realpath(supplied);
const marker = JSON.parse(
  await readFile(join(vault, '.obsidian/plugins/workspaces-runtime-probe/data.json'), 'utf8'),
);
if (
  marker.fixture !== 'obsidian-workspaces-native-v1' ||
  marker.vaultPath !== vault ||
  !marker.completedAt ||
  JSON.parse(await readFile(marker.resultFile, 'utf8')).status !== 'passed'
)
  throw new Error(
    'Refusing a live/non-disposable vault: require a completed, passed native runtime fixture.',
  );
const git = (...command) =>
  execFileSync('git', ['-C', vault, ...command], { encoding: 'utf8' }).trim();
if (git('remote') || git('status', '--porcelain') || git('branch', '--show-current') !== 'alpha')
  throw new Error('Fixture must have no remotes, a clean worktree, and alpha checked out.');
const manifest = JSON.parse(
  await readFile(join(vault, '.obsidian/plugins/obsidian-git/manifest.json'), 'utf8'),
);
if (manifest.id !== 'obsidian-git' || manifest.version !== '2.43.0')
  throw new Error('Require installed Obsidian Git 2.43.0.');
const resultFile = resolve(
  resultArgument ?? join(dirname(marker.resultFile), 'git-read-transport.json'),
);
const within = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
if (within(vault, resultFile)) throw new Error('Report must be outside the vault.');
await mkdir(dirname(resultFile), { recursive: true });
if (within(vault, await realpath(dirname(resultFile))))
  throw new Error('Report directory resolves inside the vault.');
const pluginId = 'workspaces-git-read-transport-probe';
const plugin = join(vault, '.obsidian/plugins', pluginId);
try {
  const previous = JSON.parse(await readFile(join(plugin, 'data.json'), 'utf8'));
  if (JSON.parse(await readFile(previous.resultFile, 'utf8')).status === 'running')
    throw new Error('Previous transport diagnostic is running.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
try {
  if (JSON.parse(await readFile(resultFile, 'utf8')).status === 'running')
    throw new Error('Selected report is running.');
  await copyFile(
    resultFile,
    `${resultFile}.${new Date().toISOString().replaceAll(':', '-')}.${randomUUID()}.json`,
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(repo, 'tests/obsidian/git-read-transport-probe.cjs'));
const probeSHA256 = createHash('sha256').update(source).digest('hex');
const runId = randomUUID();
await mkdir(plugin, { recursive: true });
await writeFile(join(plugin, 'main.js'), source);
await writeFile(
  join(plugin, 'manifest.json'),
  JSON.stringify(
    {
      id: pluginId,
      name: 'Workspaces Git Read Transport Probe',
      version: '0.1.0',
      minAppVersion: '1.15.0',
      description: 'Test-only manual read transport comparison for a disposable fixture.',
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
      fixture: 'obsidian-workspaces-git-read-transport-v1',
      vaultPath: vault,
      resultFile,
      runId,
      probeSHA256,
    },
    null,
    2,
  ),
);
const enabledFile = join(vault, '.obsidian/community-plugins.json');
const enabled = JSON.parse(await readFile(enabledFile, 'utf8'));
await writeFile(enabledFile, JSON.stringify([...new Set([...enabled, pluginId])], null, 2));
await writeFile(
  resultFile,
  JSON.stringify(
    { status: 'prepared', runId, vault, probeSHA256, preparedAt: new Date().toISOString() },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      vault,
      pluginId,
      resultFile,
      probeSHA256,
      pairs: 20,
      warmupPairs: 5,
      next: 'Enable the probe, close Settings, then run “Run Git read transport probe” from the command palette. It never autoruns. Disable before rearming.',
    },
    null,
    2,
  ),
);
