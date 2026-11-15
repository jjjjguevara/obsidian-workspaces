/** Deterministic, generated notes for disposable native performance fixtures. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FIXTURE_BYTES = 512 * 1024 * 1024;
const count = (arguments_, flag, fallback, maximum, minimum = 0) => {
  if (!Object.hasOwn(arguments_, flag)) return fallback;
  const raw = arguments_[flag];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw))
    throw new Error(`${flag} requires an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${flag} must be between ${minimum} and ${maximum}.`);
  return value;
};

export function parseWorkload(arguments_) {
  const profile = arguments_['--profile'] ?? 'small';
  if (!['small', 'representative'].includes(profile))
    throw new Error('--profile must be small or representative.');
  if (Object.hasOwn(arguments_, '--profile') && arguments_['--profile'] === undefined)
    throw new Error('--profile requires a value.');
  const unchangedNotes = count(arguments_, '--unchanged-notes', 0, 100_000);
  const branchNotes = count(arguments_, '--branch-notes', 0, 50_000);
  const noteKiB = count(arguments_, '--note-kib', 1, 1024, 1);
  const generatedBytes = (unchangedNotes + 2 * branchNotes) * noteKiB * 1024;
  if (generatedBytes > MAX_FIXTURE_BYTES)
    throw new Error('Generated fixture content must not exceed 512 MiB across both branches.');
  if (profile === 'small' && (unchangedNotes || branchNotes))
    throw new Error('Generated scaling notes require --profile representative.');
  if (profile === 'representative' && !unchangedNotes && !branchNotes)
    throw new Error('A representative profile requires additional generated notes.');
  return { schemaVersion: 1, profile, unchangedNotes, branchNotes, noteKiB, generatedBytes };
}

export function workloadContent(group, index, noteKiB) {
  const header = `# Generated benchmark ${group} ${index}\n\n`;
  const filler = 'Generated fixture text. No personal vault content.\n';
  const length = noteKiB * 1024;
  return (header + filler.repeat(Math.ceil(length / filler.length))).slice(0, length - 1) + '\n';
}

export async function generateWorkload(vault, workload, group) {
  if (!['common', 'alpha', 'beta'].includes(group)) throw new Error('Unknown fixture group.');
  const amount = group === 'common' ? workload.unchangedNotes : workload.branchNotes;
  if (!amount) return;
  const directory = join(vault, 'benchmark-notes', group);
  await mkdir(directory, { recursive: true });
  // Bound filesystem concurrency so a large fixture does not exhaust file handles.
  for (let first = 0; first < amount; first += 32) {
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(32, amount - first) }, async (_, offset) => {
        const index = first + offset;
        await writeFile(
          join(directory, `note-${String(index).padStart(6, '0')}.md`),
          workloadContent(group, index, workload.noteKiB),
          { flag: 'wx' },
        );
      }),
    );
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
