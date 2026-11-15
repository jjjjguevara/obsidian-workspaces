const { randomUUID } = require('node:crypto');

// The symbol survives fixture-plugin reloads in this renderer, but not closing
// the vault window/application. It is evidence of distinct native sessions,
// not a user-supplied session label or an authentication mechanism.
module.exports = function nativeSession() {
  const key = Symbol.for('obsidian-workspaces.native-benchmark-session-v1');
  globalThis[key] ??= Object.freeze({
    id: randomUUID(),
    processId: process.pid,
    observedAt: new Date().toISOString(),
  });
  return { ...globalThis[key] };
};
