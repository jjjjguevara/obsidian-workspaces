/** Evidence output paths must not follow a report symlink or overwrite a hardlink target. */
import { copyFile, lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const within = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

export async function resolveEvidenceOutput(vaultPath, supplied) {
  const vault = await realpath(vaultPath);
  const requested = resolve(supplied);
  if (within(vault, requested)) throw new Error('The report must be outside the vault.');
  // Resolve the nearest existing ancestor before mkdir, so a directory alias
  // into the fixture cannot even create a new subdirectory there.
  const missing = [];
  let parent = dirname(requested);
  let canonical;
  while (true) {
    try {
      canonical = await realpath(parent);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
  const directory = join(canonical, ...missing);
  if (within(vault, directory)) throw new Error('The report directory resolves inside the vault.');
  await mkdir(directory, { recursive: true });
  const actualDirectory = await realpath(directory);
  if (within(vault, actualDirectory))
    throw new Error('The report directory resolves inside the vault.');
  const output = join(actualDirectory, basename(requested));
  try {
    const entry = await lstat(output);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error('The report must be a regular file, not a symlink or special entry.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return output;
}

export async function publishPreparedReport(output, report) {
  const temporary = `${output}.${randomUUID()}.prepared.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  // Replacement updates this directory entry, never bytes shared with an
  // existing hardlink. The preparer has already archived any previous report.
  await rename(temporary, output);
}

export async function archiveEvidenceOutput(output, suffix = randomUUID()) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(suffix)) throw new Error('Invalid evidence archive suffix.');
  const archive = `${output}.${suffix}.json`;
  // A repeated archive name or alias is an error, never permission to replace
  // earlier evidence. Callers use a fresh suffix, not a prior report's runId.
  await copyFile(output, archive, constants.COPYFILE_EXCL);
  return archive;
}
