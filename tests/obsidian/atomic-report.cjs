/* Native test evidence only; exclusive temporary creation never follows aliases. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function writeAtomicReport(output, value, { io = fs, nonce = randomUUID } = {}) {
  if (!path.isAbsolute(output)) throw new Error('Native report output must be absolute.');
  const suffix = nonce();
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(suffix))
    throw new Error('Invalid native report temporary suffix.');
  const temporary = `${output}.${suffix}.tmp`;
  let handle;
  let owned;
  try {
    await io.mkdir(path.dirname(output), { recursive: true });
    // If this name already exists as a file, symlink or hardlink, fail before
    // opening it for writes. Never clean up a path whose creation failed.
    handle = await io.open(temporary, 'wx');
    owned = await handle.stat();
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.close();
    handle = null;
    await io.rename(temporary, output);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (owned) {
      // A concurrent replacement is not our temporary. Leave it untouched.
      await io
        .lstat(temporary)
        .then(async (entry) => {
          if (entry.isFile() && entry.dev === owned.dev && entry.ino === owned.ino)
            await io.unlink(temporary);
        })
        .catch(() => {});
    }
    throw error;
  }
}

module.exports = { writeAtomicReport };
