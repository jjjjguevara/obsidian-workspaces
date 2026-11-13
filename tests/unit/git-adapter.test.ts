import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { GitBackendError } from '../../src/git/backend.ts';
import { ObsidianGitBackend } from '../../src/git/obsidian-git.ts';

function provider() {
  return {
    manifest: { id: 'obsidian-git', version: '2.43.0' },
    gitReady: true,
    gitManager: {
      absoluteRepoPath: process.cwd(),
      git: { raw: async (_args: string[]): Promise<string> => '' },
      checkout: async (_branch: string): Promise<void> => {},
    },
    settings: { submoduleRecurseCheckout: false },
    promiseQueue: {
      addTask<T>(task: () => Promise<T>, callback?: (result: T | undefined) => void): void {
        void task().then(
          (result) => callback?.(result),
          () => callback?.(undefined),
        );
      },
    },
  };
}

function errorCode(code: GitBackendError['code']) {
  return (error: unknown): boolean => error instanceof GitBackendError && error.code === code;
}

test('the bundled adapter can be evaluated on mobile without resolving Node modules', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../src/git/obsidian-git.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    write: false,
  });
  const module = { exports: {} as Record<string, unknown> };
  const required: string[] = [];
  runInNewContext(result.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require(name: string): never {
      required.push(name);
      throw new Error(`Unavailable mobile module: ${name}`);
    },
  });
  const Backend = module.exports.ObsidianGitBackend as typeof ObsidianGitBackend;
  assert.equal(typeof Backend, 'function');
  const mobile = new Backend({ resolvePlugin: () => undefined, isDesktop: () => false });
  await assert.rejects(
    mobile.withRepository(async () => {}),
    (error: unknown) => {
      assert.equal((error as GitBackendError).code, 'unsupported-platform');
      return true;
    },
  );
  assert.deepEqual(required, []);
});

test('fails before executing a transaction when plugin, desktop, version or native capabilities are unavailable', async () => {
  let calls = 0;
  const operation = async () => {
    calls += 1;
  };
  const missing = new ObsidianGitBackend({ resolvePlugin: () => undefined, isDesktop: () => true });
  await assert.rejects(missing.withRepository(operation), errorCode('plugin-unavailable'));
  const plugin = provider();
  const mobile = new ObsidianGitBackend({ resolvePlugin: () => plugin, isDesktop: () => false });
  await assert.rejects(mobile.withRepository(operation), errorCode('unsupported-platform'));
  const adapter = new ObsidianGitBackend({ resolvePlugin: () => plugin, isDesktop: () => true });
  plugin.manifest.version = '3.0.0';
  await assert.rejects(adapter.withRepository(operation), errorCode('unsupported-version'));
  plugin.manifest.version = '2.43.0';
  plugin.gitReady = false;
  await assert.rejects(adapter.withRepository(operation), errorCode('plugin-unavailable'));
  plugin.gitReady = true;
  const noNativeBackend = new ObsidianGitBackend({
    resolvePlugin: () => ({ ...plugin, gitManager: { checkout: plugin.gitManager.checkout } }),
    isDesktop: () => true,
  });
  await assert.rejects(noNativeBackend.withRepository(operation), errorCode('unsupported-backend'));
  assert.equal(calls, 0);
});

test("never mistakes the provider queue's undefined error callback for a successful void operation", async () => {
  const plugin = provider();
  plugin.promiseQueue.addTask = <T>(
    _task: () => Promise<T>,
    callback?: (result: T | undefined) => void,
  ) => {
    callback?.(undefined);
  };
  const adapter = new ObsidianGitBackend({ resolvePlugin: () => plugin, isDesktop: () => true });
  let executed = false;
  await assert.rejects(
    adapter.withRepository(async () => {
      executed = true;
    }),
    errorCode('queue-failed'),
  );
  assert.equal(executed, false);
});

test('fails a pending operation if the Git plugin unloads and drops its queued callback', async () => {
  const plugin = provider();
  plugin.promiseQueue.addTask = () => {};
  const adapter = new ObsidianGitBackend({ resolvePlugin: () => plugin, isDesktop: () => true });
  let executed = false;
  const pending = adapter.withRepository(async () => {
    executed = true;
  });
  plugin.gitReady = false;
  await assert.rejects(pending, errorCode('plugin-unavailable'));
  assert.equal(executed, false);
});

test('does not release a running transaction merely because provider availability changes', async () => {
  const plugin = provider();
  const adapter = new ObsidianGitBackend({ resolvePlugin: () => plugin, isDesktop: () => true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const running = adapter.withRepository(async () => {
    plugin.gitReady = false;
    await gate;
    return 'completed callback';
  });
  const checked = assert.rejects(running, errorCode('plugin-unavailable')).then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await checked;
});
