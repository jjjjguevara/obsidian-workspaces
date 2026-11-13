#!/usr/bin/env node
/**
 * Prepare a disposable vault for tests/obsidian/runtime-probe.cjs.
 * Usage: node scripts/prepare-runtime-vault.mjs /absolute/vault/path [--reset]
 *        [--git-plugin /absolute/obsidian-git/plugin/dir] [--results /absolute/results.json]
 * Obsidian Git 2.43.x assets must already be available locally. No network or app launch occurs.
 * Close the fixture vault before --reset; this script removes only an identified test fixture.
 */
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const positional = args.shift();
if (!positional || !isAbsolute(positional))
  throw new Error('Supply an absolute path for a disposable vault.');
const vault = resolve(positional);
let reset = false;
let gitPlugin = join(vault, '.obsidian', 'plugins', 'obsidian-git');
let resultFile = join(dirname(vault), 'native-validation.json');
while (args.length) {
  const flag = args.shift();
  if (flag === '--reset') reset = true;
  else if (flag === '--git-plugin' || flag === '--results') {
    const value = args.shift();
    if (!value || !isAbsolute(value)) throw new Error(`${flag} requires an absolute path.`);
    if (flag === '--git-plugin') gitPlugin = resolve(value);
    else resultFile = resolve(value);
  } else throw new Error(`Unknown argument: ${flag}`);
}
const within = (parent, candidate) => {
  const part = relative(parent, candidate);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
if (vault === dirname(vault) || vault === homedir() || within(vault, repo))
  throw new Error('The fixture path must not contain the project or home directory.');
if (within(vault, resultFile)) throw new Error('Results must be outside the fixture vault.');
for (const file of ['main.js', 'manifest.json', 'styles.css'])
  await access(join(repo, 'dist', file));
await access(join(gitPlugin, 'main.js'));
const gitManifest = JSON.parse(await readFile(join(gitPlugin, 'manifest.json'), 'utf8'));
if (gitManifest.id !== 'obsidian-git' || !/^2\.43\.\d+$/.test(gitManifest.version))
  throw new Error('Use the inspected Obsidian Git 2.43.x plugin assets.');

await mkdir(vault, { recursive: true });
const canonical = await realpath(vault);
const probeDirectory = join(vault, '.obsidian', 'plugins', 'workspaces-runtime-probe');
const marker = join(probeDirectory, 'data.json');
let existing;
try {
  existing = JSON.parse(await readFile(marker, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const entries = await readdir(vault);
const isFixture =
  existing?.fixture === 'obsidian-workspaces-native-v1' && existing.vaultPath === canonical;
if (existing && !isFixture)
  throw new Error('The probe marker does not identify this test fixture.');
if (isFixture) {
  if (!reset)
    throw new Error(
      'Fixture already exists. Close its Obsidian vault, then use --reset to prepare it again.',
    );
} else if (entries.some((name) => name !== '.obsidian')) {
  throw new Error(
    'Refusing to replace a directory that is not this test fixture. A new vault may contain only .obsidian.',
  );
}

const base =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
const key = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
const stateDirectory = join(base, 'obsidian-workspaces', key);
if (within(vault, stateDirectory))
  throw new Error('The desktop control store must be outside this fixture repository.');
if (isFixture) {
  for (const entry of entries)
    if (entry !== '.obsidian') await rm(join(vault, entry), { recursive: true, force: true });
  await rm(stateDirectory, { recursive: true, force: true });
} else {
  try {
    await access(join(stateDirectory, 'state.json'));
    throw new Error('This vault path already has Workspaces state. Use a new disposable path.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const git = (...command) =>
  execFileSync('git', command, {
    cwd: vault,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Workspaces native fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Workspaces native fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
git('init', '-b', 'alpha');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.autocrlf', 'false');
git('config', 'submodule.recurse', 'false');
await writeFile(join(vault, '.gitignore'), '/.obsidian/\n');
const notes = {
  alpha: {
    'alpha-exclusive.md': '# Alpha exclusive\n',
    'sidebar-alpha.md': '# Alpha sidebar\n',
    'shared.md': 'ALPHA\n',
  },
  beta: {
    'beta-exclusive.md': '# Beta exclusive\n',
    'sidebar-beta.md': '# Beta sidebar\n',
    'shared.md': 'BRAVO\n',
  },
};
for (const [file, content] of Object.entries(notes.alpha))
  await writeFile(join(vault, file), content);
git('add', '.gitignore', ...Object.keys(notes.alpha));
git('commit', '-m', 'Native fixture alpha');
git('checkout', '-b', 'beta');
git('rm', 'alpha-exclusive.md', 'sidebar-alpha.md');
for (const [file, content] of Object.entries(notes.beta))
  await writeFile(join(vault, file), content);
git('add', ...Object.keys(notes.beta));
git('commit', '-m', 'Native fixture beta');
git('checkout', 'alpha');

const plugins = join(vault, '.obsidian', 'plugins');
await mkdir(join(plugins, 'obsidian-workspaces'), { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css'])
  await copyFile(join(repo, 'dist', file), join(plugins, 'obsidian-workspaces', file));
const installedGit = join(plugins, 'obsidian-git');
if (resolve(gitPlugin) !== resolve(installedGit)) {
  await mkdir(installedGit, { recursive: true });
  for (const file of ['main.js', 'manifest.json'])
    await copyFile(join(gitPlugin, file), join(installedGit, file));
  try {
    await copyFile(join(gitPlugin, 'styles.css'), join(installedGit, 'styles.css'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await writeFile(
  join(installedGit, 'data.json'),
  JSON.stringify(
    {
      autoSaveInterval: 0,
      autoPullInterval: 0,
      autoPushInterval: 0,
      autoPullOnBoot: false,
      autoBackupAfterFileChange: false,
      disablePush: true,
      pullBeforePush: false,
      submoduleRecurseCheckout: false,
      basePath: '',
      gitDir: '',
    },
    null,
    2,
  ),
);
await mkdir(probeDirectory, { recursive: true });
await copyFile(
  join(repo, 'tests', 'obsidian', 'runtime-probe.cjs'),
  join(probeDirectory, 'main.js'),
);
await writeFile(
  join(probeDirectory, 'manifest.json'),
  JSON.stringify(
    {
      id: 'workspaces-runtime-probe',
      name: 'Workspaces Runtime Probe',
      version: '0.1.0',
      minAppVersion: '1.13.0',
      description: 'Disposable native validation fixture; never install in a personal vault.',
      author: 'jjjjguevara',
      isDesktopOnly: true,
    },
    null,
    2,
  ),
);
await writeFile(
  marker,
  JSON.stringify(
    {
      fixture: 'obsidian-workspaces-native-v1',
      vaultPath: canonical,
      resultFile,
      runId: randomUUID(),
      notes,
      expectedGitVersion: gitManifest.version,
    },
    null,
    2,
  ),
);
await writeFile(
  join(vault, '.obsidian', 'community-plugins.json'),
  JSON.stringify(['obsidian-git', 'obsidian-workspaces', 'workspaces-runtime-probe'], null, 2),
);
// Prevent a stale fixture layout from reopening notes before alpha is indexed.
for (const file of ['workspace.json', 'workspace-mobile.json'])
  await rm(join(vault, '.obsidian', file), { force: true });
await mkdir(dirname(resultFile), { recursive: true });
await writeFile(
  resultFile,
  JSON.stringify(
    {
      status: 'prepared',
      vault: canonical,
      preparedAt: new Date().toISOString(),
      gitVersion: gitManifest.version,
      stateDirectory,
      note: 'Open this vault in Obsidian and trust its three fixture plugins to run validation.',
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      vault: canonical,
      resultFile,
      stateDirectory,
      gitVersion: gitManifest.version,
      branch: git('branch', '--show-current').trim(),
      clean: git('status', '--porcelain').trim() === '',
    },
    null,
    2,
  ),
);
