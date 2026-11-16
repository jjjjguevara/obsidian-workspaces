#!/usr/bin/env node
// Fill the closure manifest from the collected reports. Hashes are computed
// from the exact report and journal bytes; no report content is changed.
// Usage: make-manifest.mjs REPORTS_DIR CANDIDATE_COMMIT SUITABILITY(true|false)
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const [directory, candidateCommit, suitability] = process.argv.slice(2);
const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const names = await readdir(directory);
const reference = async (name) => {
  const report = JSON.parse(await readFile(join(directory, name), 'utf8'));
  const journal = basename(report.recorder.journalFile);
  if (!names.includes(journal)) throw new Error(`Missing journal for ${name}: ${journal}`);
  return {
    report,
    ref: {
      path: name,
      sha256: await sha(join(directory, name)),
      journal: { path: journal, sha256: await sha(join(directory, journal)) },
    },
  };
};
const sessions = [];
const identities = { baseline: new Set(), candidate: new Set(), probe: new Set() };
for (const profile of ['small', 'representative'])
  for (const index of [1, 2, 3]) {
    const session = { label: `${profile}-${index}`, profile };
    for (const role of ['baseline', 'candidate']) {
      const { report, ref } = await reference(`${profile}-s${index}-${role}.json`);
      session[role] = ref;
      identities[role].add(report.environment.plugins['obsidian-workspaces'].bundleSHA256);
      identities.probe.add(report.environment.plugins['workspaces-switch-benchmark'].bundleSHA256);
    }
    sessions.push(session);
  }
const safetyReports = [];
const safetyProbe = new Set();
for (const profile of ['small', 'representative']) {
  const name = `${profile}-quick-switcher-fixed.json`;
  const report = JSON.parse(await readFile(join(directory, name), 'utf8'));
  const setup = report.checks?.[0]?.details ?? {};
  const hash =
    setup.bundleSHA256?.['workspaces-quick-switcher-probe'] ??
    report.setup?.bundleSHA256?.['workspaces-quick-switcher-probe'];
  if (hash) safetyProbe.add(hash);
  safetyReports.push({ profile, path: name, sha256: await sha(join(directory, name)) });
}
const only = (set, label) => {
  if (set.size !== 1) throw new Error(`${label}: expected one identity, found ${[...set]}`);
  return [...set][0];
};
const manifest = {
  schema: 'obsidian-workspaces-performance-closure-v1',
  platform: 'darwin',
  baseline: {
    commit: '6b3ae45589132a7c37da14e94a20a4668b2f28b9',
    bundleSHA256: only(identities.baseline, 'baseline bundle'),
  },
  candidate: { commit: candidateCommit, bundleSHA256: only(identities.candidate, 'candidate') },
  probeSHA256: only(identities.probe, 'benchmark probe'),
  safetyProbeSHA256: only(safetyProbe, 'safety probe'),
  versions: { obsidian: '1.15.1', git: '2.43.0', quickSwitcher: '6.3.0' },
  scope: {
    small: {
      description:
        'Fixed Alpha/Beta fixture with four Markdown editors, three required pin regions, and shared-path content changes.',
      minimumTrackedFiles: 4,
      minimumChangedPaths: 5,
      minimumMarkdownLeaves: 4,
    },
    representative: {
      description:
        'Generated fixture with 194 tracked files per branch, 85 changed paths between Alpha and Beta, 26 KiB generated notes, and four Markdown editors (pinned main note, shared background note, both pinned sidebar notes).',
      basis:
        'Counts taken on 2026-11-15 from the tyo-bit vault without reading note contents: 108 to 136 tracked files per branch across six branches, 0 to 69 changed paths between branch pairs, 98 tracked Markdown notes with 13 KiB median and 25.6 KiB mean size, and one or two main-area views per saved workspace with no pinned sidebar notes. The fixture meets or exceeds each count. Limits: the tyo-bit layouts hold Canvas and Excalidraw views and the vault runs 14 community plugins, which the Markdown-only fixture with its test plugins does not reproduce; other vaults on this Mac were not assessed.',
      suitabilityConfirmed: suitability === 'true',
      minimumTrackedFiles: 194,
      minimumChangedPaths: 85,
      minimumMarkdownLeaves: 4,
    },
  },
  sessions,
  safetyReports,
};
await writeFile(join(directory, 'closure-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: 'wx',
});
console.log(JSON.stringify({ candidate: manifest.candidate, probe: manifest.probeSHA256 }));
