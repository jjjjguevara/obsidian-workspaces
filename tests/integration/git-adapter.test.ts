import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { GitBackendError, type GitRepository } from '../../src/git/backend.ts';
import { ObsidianGitBackend } from '../../src/git/obsidian-git.ts';

const execute = promisify(execFile);

/** Minimal provider queue with the audited callback semantics, not a Git engine. */
class ProviderQueue {
  private tail: Promise<void> = Promise.resolve();

  addTask<T>(task: () => Promise<T>, callback?: (result: T | undefined) => void): void {
    const result = this.tail.then(task);
    this.tail = result.then(
      (value) => {
        callback?.(value);
      },
      () => {
        callback?.(undefined);
      },
    );
  }
}

async function fixture(t: TestContext, prefix = 'obsidian-workspaces-git-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const root = await realpath(directory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'absent-global-config'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Workspace adapter test',
    GIT_AUTHOR_EMAIL: 'workspaces@example.invalid',
    GIT_COMMITTER_NAME: 'Workspace adapter test',
    GIT_COMMITTER_EMAIL: 'workspaces@example.invalid',
  };
  const git = async (args: string[]): Promise<string> => {
    const result = await execute('git', args, { cwd: root, env: environment, encoding: 'utf8' });
    return result.stdout;
  };
  await git(['init', '-b', 'alpha']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.hooksPath', join(root, '.git', 'disabled-hooks')]);
  await writeFile(join(root, 'a.md'), 'Only on alpha\n');
  await writeFile(join(root, 'common.md'), 'Common initial content\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Alpha notes']);
  await git(['checkout', '-b', 'beta']);
  await rm(join(root, 'a.md'));
  await writeFile(join(root, 'b.md'), 'Only on beta\n');
  await writeFile(join(root, 'common.md'), 'Common beta content\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'Beta notes']);
  await git(['checkout', 'alpha']);

  const checkouts: string[] = [];
  const manager = {
    absoluteRepoPath: root,
    git: { raw: git },
    checkout: async (branch: string): Promise<void> => {
      checkouts.push(branch);
      await git(['checkout', branch]);
    },
  };
  const plugin = {
    manifest: { id: 'obsidian-git', version: '2.43.0' },
    gitReady: true,
    gitManager: manager,
    settings: { submoduleRecurseCheckout: false },
    promiseQueue: new ProviderQueue(),
  };
  const adapter = new ObsidianGitBackend({ resolvePlugin: () => plugin, isDesktop: () => true });
  return { root, git, adapter, plugin, manager, checkouts };
}

function hasCode(code: GitBackendError['code']) {
  return (error: unknown): boolean => error instanceof GitBackendError && error.code === code;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function guardedAdapter(f: Awaited<ReturnType<typeof fixture>>) {
  return new ObsidianGitBackend({
    resolvePlugin: () => f.plugin,
    isDesktop: () => true,
    checkoutGuard: {
      vaultPath: f.root,
      configDir: '.obsidian',
      pluginId: 'obsidian-workspaces',
    },
  });
}

test('round trips branch-exclusive files through the installed provider', async (t) => {
  const f = await fixture(t);
  await f.adapter.withRepository(async (repository) => {
    assert.deepEqual(await repository.inspect(), {
      root: f.root,
      branch: 'alpha',
      dirty: false,
      conflicted: false,
    });
    assert.equal((await repository.checkout('beta')).branch, 'beta');
    assert.equal(await readFile(join(f.root, 'b.md'), 'utf8'), 'Only on beta\n');
    await assert.rejects(access(join(f.root, 'a.md')));
    assert.equal((await repository.checkout('alpha')).branch, 'alpha');
    assert.equal(await readFile(join(f.root, 'a.md'), 'utf8'), 'Only on alpha\n');
    await assert.rejects(access(join(f.root, 'b.md')));
  });
  assert.deepEqual(f.checkouts, ['beta', 'alpha']);
});

test('successful checkout verifies identity without a redundant post-checkout status scan', async (t) => {
  const f = await fixture(t);
  const nativeCheckout = f.manager.checkout;
  let checkedOut = false;
  const postCheckoutReads: string[][] = [];
  f.manager.checkout = async (branch) => {
    await nativeCheckout(branch);
    checkedOut = true;
    await writeFile(join(f.root, 'common.md'), 'Provider hook updated this file\n');
  };
  f.manager.git.raw = async (args) => {
    if (checkedOut) postCheckoutReads.push([...args]);
    return f.git(args);
  };
  const result = await f.adapter.withRepository((repository) => repository.checkout('beta'));
  assert.deepEqual(result, { root: f.root, branch: 'beta' });
  assert.deepEqual(postCheckoutReads, [
    ['rev-parse', '--show-toplevel', '--symbolic-full-name', 'HEAD'],
  ]);
  assert.equal((await f.adapter.withRepository((repository) => repository.inspect())).dirty, true);
});

test('identity reads report attached and detached roots without claiming cleanliness', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'common.md'), 'Dirty local note\n');
  const calls: string[][] = [];
  f.manager.git.raw = async (args) => {
    calls.push([...args]);
    return f.git(args);
  };
  await f.adapter.withRepository(async (repository) => {
    assert.ok(repository.inspectIdentity);
    assert.deepEqual(await repository.inspectIdentity(), { root: f.root, branch: 'alpha' });
    assert.equal(calls.length, 1);
    assert.equal(
      calls.some((args) => args.includes('status')),
      false,
    );
    assert.equal((await repository.inspect()).dirty, true);
    await f.git(['checkout', '--detach', 'HEAD']);
    calls.length = 0;
    assert.deepEqual(await repository.inspectIdentity(), { root: f.root, branch: null });
    assert.equal(calls.length, 1);
    assert.equal(
      calls.some((args) => args.includes('status')),
      false,
    );
  });
});

test('identity reads fall back to full status for unborn HEAD and unrecognized ref output', async (t) => {
  for (const scenario of ['unborn', 'unrecognized-ref', 'missing-ref', 'truncated-output']) {
    await t.test(scenario, async (subtest) => {
      const f = await fixture(subtest);
      if (scenario === 'unborn') {
        await f.git(['checkout', '--orphan', 'unborn']);
        await f.git(['rm', '-r', '-f', '--', '.']);
      }
      const calls: string[][] = [];
      f.manager.git.raw = async (args) => {
        calls.push([...args]);
        if (args.includes('--symbolic-full-name')) {
          if (scenario === 'unrecognized-ref') return `${f.root}\nrefs/tags/unexpected\n`;
          if (scenario === 'missing-ref') return `${f.root}\n\n`;
          if (scenario === 'truncated-output') return `${f.root}\nrefs/heads/alpha`;
        }
        return f.git(args);
      };
      await f.adapter.withRepository(async (repository) => {
        assert.ok(repository.inspectIdentity);
        assert.deepEqual(await repository.inspectIdentity(), {
          root: f.root,
          branch: scenario === 'unborn' ? 'unborn' : 'alpha',
        });
      });
      assert.equal(calls.length, 3);
      assert.equal(calls.filter((args) => args.includes('status')).length, 1);
    });
  }
});

test('identity and marker paths preserve embedded and trailing POSIX line terminators', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows filenames cannot contain these characters.');
    return;
  }
  for (const scenario of ['embedded-newline', 'trailing-newline', 'trailing-carriage-return']) {
    await t.test(scenario, async (subtest) => {
      const f = await fixture(subtest, 'obsidian-workspaces-identity-\n');
      let root = f.root;
      if (scenario !== 'embedded-newline') {
        root += scenario === 'trailing-newline' ? '\n' : '\r';
        await rename(f.root, root);
        await symlink(root, f.root, 'dir');
        subtest.after(() => rm(root, { recursive: true, force: true }));
        f.manager.absoluteRepoPath = root;
      }
      const calls: string[][] = [];
      f.manager.git.raw = async (args) => {
        calls.push([...args]);
        return f.git(args);
      };
      await f.adapter.withRepository(async (repository) => {
        assert.ok(repository.inspectIdentity);
        assert.deepEqual(await repository.inspectIdentity(), { root, branch: 'alpha' });
        assert.equal(calls.length, 1);
        assert.equal((await repository.inspect()).root, root);
        assert.equal((await repository.checkout('beta')).root, root);
      });
      assert.deepEqual(f.checkouts, ['beta']);
    });
  }
});

test('a vault opened through a directory alias keeps canonical identity through checkout', async (t) => {
  const f = await fixture(t);
  const aliases = await mkdtemp(join(tmpdir(), 'obsidian-workspaces-alias-'));
  t.after(() => rm(aliases, { recursive: true, force: true }));
  const alias = join(aliases, 'vault');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.manager.absoluteRepoPath = alias;
  f.manager.git.raw = (args) => f.git(['-C', alias, ...args]);
  f.manager.checkout = async (branch) => {
    f.checkouts.push(branch);
    await f.git(['-C', alias, 'checkout', branch]);
  };
  const adapter = new ObsidianGitBackend({
    resolvePlugin: () => f.plugin,
    isDesktop: () => true,
    checkoutGuard: { vaultPath: alias, configDir: '.obsidian', pluginId: 'obsidian-workspaces' },
  });
  await adapter.withRepository(async (repository) => {
    assert.deepEqual(await repository.inspect(), {
      root: f.root,
      branch: 'alpha',
      dirty: false,
      conflicted: false,
    });
    const target = await repository.checkout('beta');
    assert.equal(target.root, f.root);
    assert.equal(target.branch, 'beta');
    assert.equal(await readFile(join(alias, 'b.md'), 'utf8'), 'Only on beta\n');
    const source = await repository.checkout('alpha');
    assert.equal(source.root, f.root);
    assert.equal(source.branch, 'alpha');
    assert.equal(await readFile(join(alias, 'a.md'), 'utf8'), 'Only on alpha\n');
  });
  assert.deepEqual(f.checkouts, ['beta', 'alpha']);
});

test('repository identity is pinned before the callback so an alias cannot retarget it', async (t) => {
  const original = await fixture(t);
  const replacement = await fixture(t);
  const aliases = await mkdtemp(join(tmpdir(), 'obsidian-workspaces-retarget-'));
  t.after(() => rm(aliases, { recursive: true, force: true }));
  const alias = join(aliases, 'vault');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(original.root, alias, kind);
  original.manager.absoluteRepoPath = alias;
  original.manager.git.raw = (args) => original.git(['-C', alias, ...args]);
  await original.adapter.withRepository(async (repository) => {
    // Change the alias before the first inspect: identity must already be fixed.
    await rm(alias);
    await symlink(replacement.root, alias, kind);
    await assert.rejects(repository.inspect(), hasCode('repository-changed'));
    assert.ok(repository.inspectIdentity);
    await assert.rejects(repository.inspectIdentity(), hasCode('repository-changed'));
    await assert.rejects(repository.checkout('beta'), hasCode('repository-changed'));
  });
  assert.deepEqual(original.checkouts, []);
  assert.equal((await replacement.git(['branch', '--show-current'])).trim(), 'alpha');
});

test('an unresolved provider root rejects before the transaction callback can run', async (t) => {
  const f = await fixture(t);
  f.manager.absoluteRepoPath = join(f.root, 'missing-root');
  let executed = false;
  await assert.rejects(
    f.adapter.withRepository(async () => {
      executed = true;
    }),
    hasCode('repository-changed'),
  );
  assert.equal(executed, false);
  assert.deepEqual(f.checkouts, []);
});

test('checkout awaits the provider branch label and refreshes its views after Git changes branch', async (t) => {
  const f = await fixture(t);
  const displayStarted = deferred();
  const allowDisplay = deferred();
  const events: string[] = [];
  let displayedBranch = 'alpha';
  let completed = false;
  let checkoutReturned = false;
  const workspace = {
    trigger(event: string): void {
      assert.equal(this, workspace);
      events.push(event);
    },
  };
  const branchBar = {
    async display(): Promise<void> {
      assert.equal(this, branchBar);
      const actualBranch = (await f.git(['branch', '--show-current'])).trim();
      events.push(`display-start:${actualBranch}`);
      displayStarted.resolve();
      await allowDisplay.promise;
      displayedBranch = actualBranch;
      events.push(`display-finish:${actualBranch}`);
    },
  };
  Object.assign(f.plugin, { app: { workspace }, branchBar });
  const checkout = f.adapter.withRepository(async (repository) => {
    const result = await repository.checkout('beta');
    checkoutReturned = true;
    return result;
  });
  void checkout.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await displayStarted.promise;
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'beta');
  assert.equal(completed, false);
  assert.equal(checkoutReturned, false, 'Direct checkout still awaits its presentation');
  assert.equal(displayedBranch, 'alpha');
  assert.deepEqual(events, ['obsidian-git:refresh', 'display-start:beta']);
  allowDisplay.resolve();
  const result = await checkout;
  assert.equal(result.branch, 'beta');
  assert.equal(checkoutReturned, true);
  assert.equal(displayedBranch, 'beta');
  assert.deepEqual(events, ['obsidian-git:refresh', 'display-start:beta', 'display-finish:beta']);
});

test('overlapping presentation permits caller work but drains before success or failure releases the queue', async (t) => {
  for (const scenario of ['success', 'callback-failure', 'checkout-failure']) {
    await t.test(scenario, async (subtest) => {
      const f = await fixture(subtest);
      const displayStarted = deferred();
      const allowDisplay = deferred();
      const backgroundFinished = deferred();
      const failure = new Error('Original operation failure');
      let callbackContinued = false;
      let finished = false;
      let displayFinished = false;
      let backgroundStarted = false;
      let backgroundQueued = false;
      subtest.mock.method(console, 'warn', () => {});
      Object.assign(f.plugin, {
        branchBar: {
          async display(): Promise<void> {
            assert.equal((await f.git(['branch', '--show-current'])).trim(), 'beta');
            displayStarted.resolve();
            await allowDisplay.promise;
            displayFinished = true;
            if (scenario !== 'success') throw new Error('Optional presentation failed');
          },
        },
      });
      if (scenario === 'checkout-failure') {
        const nativeCheckout = f.manager.checkout;
        f.manager.checkout = async (branch) => {
          await nativeCheckout(branch);
          throw failure;
        };
      }
      const pending = f.adapter.withRepository(async (repository) => {
        assert.ok(repository.overlapPresentation);
        repository.overlapPresentation();
        let identity;
        try {
          identity = await repository.checkout('beta');
        } catch (error) {
          callbackContinued = true;
          throw error;
        }
        callbackContinued = true;
        if (scenario === 'callback-failure') throw failure;
        return identity;
      });
      const outcome = pending.then(
        (value) => {
          finished = true;
          return { value, error: undefined as unknown };
        },
        (error: unknown) => {
          finished = true;
          return { value: undefined, error };
        },
      );
      try {
        await Promise.race([
          displayStarted.promise,
          outcome.then((result) => {
            throw result.error ?? new Error('The scope ended before presentation started.');
          }),
        ]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(callbackContinued, true, 'Caller work must overlap a held presentation');
        assert.equal(finished, false, 'withRepository must retain pending refresh ownership');
        f.plugin.promiseQueue.addTask(
          async () => {
            backgroundStarted = true;
            assert.equal(displayFinished, true);
            await f.git(['checkout', 'alpha']);
          },
          () => backgroundFinished.resolve(),
        );
        backgroundQueued = true;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(backgroundStarted, false, 'The next queued mutation must remain blocked');
      } finally {
        allowDisplay.resolve();
        await outcome;
        if (backgroundQueued) await backgroundFinished.promise;
      }
      const result = await outcome;
      assert.equal(displayFinished, true);
      assert.equal(backgroundStarted, true);
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
      if (scenario === 'success') {
        assert.deepEqual(result.value, { root: f.root, branch: 'beta' });
        assert.equal(result.error, undefined);
      } else if (scenario === 'callback-failure') {
        assert.equal(
          result.error,
          failure,
          'Optional refresh failure must not replace caller failure',
        );
      } else {
        assert.ok(result.error instanceof GitBackendError);
        assert.equal(result.error.code, 'checkout-failed');
        assert.equal(result.error.cause, failure);
        assert.equal(result.error.status?.branch, 'beta');
      }
    });
  }
});

test('a second checkout in one scope cannot overtake pending presentation', async (t) => {
  const f = await fixture(t);
  const displayStarted = deferred();
  const allowDisplay = deferred();
  const labels: string[] = [];
  let secondCheckoutCalled = false;
  Object.assign(f.plugin, {
    branchBar: {
      async display(): Promise<void> {
        const branch = (await f.git(['branch', '--show-current'])).trim();
        if (branch === 'beta') {
          displayStarted.resolve();
          await allowDisplay.promise;
        }
        labels.push(branch);
      },
    },
  });
  const pending = f.adapter.withRepository(async (repository) => {
    assert.ok(repository.overlapPresentation);
    repository.overlapPresentation();
    assert.equal((await repository.checkout('beta')).branch, 'beta');
    secondCheckoutCalled = true;
    return repository.checkout('alpha');
  });
  const outcome = pending.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  try {
    await Promise.race([
      displayStarted.promise,
      outcome.then((result) => {
        throw result.error ?? new Error('The scope ended before presentation started.');
      }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondCheckoutCalled, true);
    assert.deepEqual(f.checkouts, ['beta']);
    assert.deepEqual(labels, []);
  } finally {
    allowDisplay.resolve();
    await outcome;
  }
  const result = await outcome;
  assert.equal(result.error, undefined);
  assert.equal(result.value?.branch, 'alpha');
  assert.deepEqual(f.checkouts, ['beta', 'alpha']);
  assert.deepEqual(labels, ['beta', 'alpha']);
});

test('checkout remains available when optional provider presentation hooks are absent or unavailable', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.adapter.withRepository((repository) => repository.checkout('beta'))).branch,
    'beta',
  );
  Object.assign(f.plugin, {
    app: { workspace: { trigger: 'unavailable' } },
    branchBar: { display: null },
  });
  assert.equal(
    (await f.adapter.withRepository((repository) => repository.checkout('alpha'))).branch,
    'alpha',
  );
  assert.deepEqual(f.checkouts, ['beta', 'alpha']);
});

test('provider presentation failures cannot turn successful checkout into failure or obscure a partial checkout failure', async (t) => {
  const f = await fixture(t);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  const observedBranches: string[] = [];
  Object.assign(f.plugin, {
    app: {
      workspace: {
        trigger() {
          throw new Error('View refresh failed');
        },
      },
    },
    branchBar: {
      async display(): Promise<void> {
        observedBranches.push((await f.git(['branch', '--show-current'])).trim());
        throw new Error('Branch label failed');
      },
    },
  });
  const result = await f.adapter.withRepository((repository) => repository.checkout('beta'));
  assert.equal(result.branch, 'beta');
  assert.deepEqual(observedBranches, ['beta']);
  assert.equal(warnings.length, 2);

  f.manager.checkout = async (branch) => {
    await f.git(['checkout', branch]);
    throw new Error('Provider failed after changing HEAD');
  };
  await assert.rejects(
    f.adapter.withRepository((repository) => repository.checkout('alpha')),
    (error: unknown) => {
      assert.ok(error instanceof GitBackendError);
      assert.equal(error.code, 'checkout-failed');
      assert.equal(error.status?.branch, 'alpha');
      assert.match(error.message, /Provider failed after changing HEAD/);
      return true;
    },
  );
  assert.deepEqual(observedBranches, ['beta', 'alpha']);
  assert.equal(warnings.length, 4);
});

test('keeps the queue occupied through caller restoration, including successful void results', async (t) => {
  const f = await fixture(t);
  const layoutStarted = deferred();
  const allowLayoutFinish = deferred();
  const log: string[] = [];
  const transition = f.adapter.withRepository(async (repository) => {
    await repository.checkout('beta');
    log.push('layout-start');
    layoutStarted.resolve();
    await allowLayoutFinish.promise;
    log.push('layout-finish');
  });
  await layoutStarted.promise;
  const backgroundDone = deferred();
  f.plugin.promiseQueue.addTask(
    async () => {
      log.push('background-git');
    },
    () => backgroundDone.resolve(),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['layout-start']);
  allowLayoutFinish.resolve();
  assert.equal(await transition, undefined);
  await backgroundDone.promise;
  assert.deepEqual(log, ['layout-start', 'layout-finish', 'background-git']);
});

test('failed parallel reads drain their siblings before releasing the provider queue', async (t) => {
  for (const batch of [
    'preflight',
    'marker-fallback',
    'runtime-comparison',
    'inspection',
  ] as const) {
    await t.test(batch, async (subtest) => {
      const f = await fixture(subtest);
      const guarded = new ObsidianGitBackend({
        resolvePlugin: () => f.plugin,
        isDesktop: () => true,
        checkoutGuard: {
          vaultPath: f.root,
          configDir: '.obsidian',
          pluginId: 'obsidian-workspaces',
        },
      });
      const heldReadStarted = deferred();
      const releaseHeldRead = deferred();
      const transactionFinished = deferred();
      const backgroundFinished = deferred();
      let finished = false;
      let backgroundStarted = false;
      let backgroundQueued = false;
      const rejects = (args: string[]): boolean =>
        batch === 'preflight'
          ? args[0] === 'for-each-ref'
          : batch === 'marker-fallback'
            ? args[0] === 'rev-parse' && args.length === 2 && args[1] === '--show-prefix'
            : batch === 'runtime-comparison'
              ? args[0] === 'diff'
              : args[0] === 'rev-parse' && args[1] === '--show-toplevel';
      const holds = (args: string[]): boolean =>
        batch === 'preflight'
          ? args[0] === 'config'
          : batch === 'marker-fallback'
            ? args[0] === 'rev-parse' && args.length === 3 && args[2] === 'index.lock'
            : batch === 'runtime-comparison'
              ? args[0] === 'ls-files'
              : args.includes('status');
      f.manager.git.raw = async (args) => {
        if (batch === 'marker-fallback' && args.includes('--git-path') && args.length > 3)
          return 'ambiguous paths\n';
        if (rejects(args)) throw new Error('Injected parallel read failure');
        const result = await f.git(args);
        if (holds(args)) {
          heldReadStarted.resolve();
          await releaseHeldRead.promise;
        }
        return result;
      };
      const pending = guarded.withRepository(async (repository) => {
        if (batch === 'inspection') await repository.inspect();
        else await repository.assertCanSwitch('beta');
      });
      const outcome = pending.then(
        () => {
          finished = true;
          transactionFinished.resolve();
          return { error: undefined as unknown };
        },
        (error: unknown) => {
          finished = true;
          transactionFinished.resolve();
          return { error };
        },
      );
      try {
        await Promise.race([
          heldReadStarted.promise,
          transactionFinished.promise.then(() => {
            throw new Error('The read batch settled before its sibling read could start.');
          }),
        ]);
        f.plugin.promiseQueue.addTask(
          async () => {
            backgroundStarted = true;
          },
          () => backgroundFinished.resolve(),
        );
        backgroundQueued = true;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(finished, false, 'A failed read must await its in-flight siblings');
        assert.equal(backgroundStarted, false, 'The provider queue must retain its owner');
      } finally {
        releaseHeldRead.resolve();
        await outcome;
        if (backgroundQueued) await backgroundFinished.promise;
      }
      const { error } = await outcome;
      assert.ok(error instanceof GitBackendError);
      assert.match(`${error.message} ${String(error.cause)}`, /Injected parallel read failure/);
      assert.equal(backgroundStarted, true);
      assert.deepEqual(f.checkouts, []);
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
    });
  }
});

test('blocks untracked, unstaged and staged changes across the whole repository', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'vault'));
  for (const scenario of ['untracked', 'unstaged', 'staged'] as const) {
    await t.test(scenario, async () => {
      if (scenario === 'untracked')
        await writeFile(join(f.root, 'outside-vault.md'), 'Do not move me\n');
      else await writeFile(join(f.root, 'common.md'), 'Local edits\n');
      if (scenario === 'staged') await f.git(['add', 'common.md']);
      await f.adapter.withRepository(async (repository) => {
        assert.equal((await repository.inspect()).dirty, true);
        await assert.rejects(repository.checkout('beta'), hasCode('dirty-worktree'));
      });
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
      await f.git(['reset', '--hard', 'HEAD']);
      await rm(join(f.root, 'outside-vault.md'), { force: true });
    });
  }
  assert.deepEqual(f.checkouts, []);
});

test('parses staged renames without interpreting their second pathname as status', async (t) => {
  const f = await fixture(t);
  await f.git(['mv', 'a.md', 'renamed.md']);
  await f.adapter.withRepository(async (repository) => {
    assert.deepEqual(await repository.inspect(), {
      root: f.root,
      branch: 'alpha',
      dirty: true,
      conflicted: false,
    });
  });
});

test('identifies real merge conflicts and refuses checkout', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'common.md'), 'Alpha changed the same line\n');
  await f.git(['commit', '-am', 'Conflicting alpha edit']);
  await assert.rejects(f.git(['merge', 'beta']));
  await f.adapter.withRepository(async (repository) => {
    assert.equal((await repository.inspect()).conflicted, true);
    await assert.rejects(repository.assertCanSwitch('beta'), hasCode('conflicted-worktree'));
  });
  assert.deepEqual(f.checkouts, []);
});

test('refuses an unfinished merge even without unmerged paths', async (t) => {
  const f = await fixture(t);
  await f.git(['merge', '--no-ff', '--no-commit', 'beta']);
  await f.adapter.withRepository(async (repository) => {
    assert.equal((await repository.inspect()).conflicted, false);
    await assert.rejects(repository.assertCanSwitch('beta'), hasCode('operation-in-progress'));
  });
});

test('refuses a paused rebase even with a clean working tree', async (t) => {
  const f = await fixture(t);
  await f.git(['checkout', 'beta']);
  await assert.rejects(f.git(['rebase', '--exec', 'false', 'alpha']));
  await f.adapter.withRepository(async (repository) => {
    assert.equal((await repository.inspect()).dirty, false);
    await assert.rejects(repository.assertCanSwitch('alpha'), hasCode('operation-in-progress'));
  });
});

test('checks every operation marker in ordinary repositories and linked worktrees', async (t) => {
  const markers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'BISECT_LOG',
    'index.lock',
  ];
  for (const topology of ['repository', 'linked-worktree', 'nested-provider-cwd'] as const) {
    await t.test(topology, async (subtest) => {
      const f = await fixture(subtest);
      let root = f.root;
      if (topology === 'linked-worktree') {
        const directory = await mkdtemp(join(tmpdir(), 'obsidian-workspaces-linked-'));
        subtest.after(() => rm(directory, { recursive: true, force: true }));
        root = join(directory, 'vault');
        await f.git(['worktree', 'add', '-b', 'linked-alpha', root, 'alpha']);
        f.manager.absoluteRepoPath = root;
      }
      const cwd = topology === 'nested-provider-cwd' ? join(root, 'nested', 'directory') : root;
      if (cwd !== root) await mkdir(cwd, { recursive: true });
      const calls: string[][] = [];
      f.manager.git.raw = async (args) => {
        calls.push([...args]);
        return f.git(['-C', cwd, ...args]);
      };
      await f.adapter.withRepository((repository) => repository.assertCanSwitch('beta'));
      const markerCalls = calls.filter(
        (args) => args[0] === 'rev-parse' && args.includes('--git-path'),
      );
      assert.equal(markerCalls.length, 1, 'A clean preflight resolves all marker paths once');
      assert.ok(markerCalls[0]!.includes('--show-toplevel'));
      assert.ok(markerCalls[0]!.includes('--show-prefix'));
      for (const marker of markers) assert.ok(markerCalls[0]!.includes(marker));

      const commit = (await f.git(['-C', root, 'rev-parse', 'HEAD'])).trim();
      for (const marker of markers) {
        await subtest.test(marker, async () => {
          const gitPath = (await f.git(['-C', root, 'rev-parse', '--git-path', marker])).replace(
            /\r?\n$/,
            '',
          );
          const markerPath = resolve(root, gitPath);
          if (['rebase-merge', 'rebase-apply', 'sequencer'].includes(marker))
            await mkdir(markerPath);
          else await writeFile(markerPath, `${commit}\n`);
          try {
            await assert.rejects(
              f.adapter.withRepository((repository) => repository.assertCanSwitch('beta')),
              (error: unknown) => {
                assert.ok(error instanceof GitBackendError);
                assert.equal(error.code, 'operation-in-progress');
                assert.ok(error.message.includes(marker));
                return true;
              },
            );
          } finally {
            await rm(markerPath, { recursive: true, force: true });
          }
        });
      }
      assert.deepEqual(f.checkouts, []);
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
      assert.equal(
        (await f.git(['-C', root, 'branch', '--show-current'])).trim(),
        topology === 'linked-worktree' ? 'linked-alpha' : 'alpha',
      );
    });
  }
});

test('marker checks handle newline repository paths and fall back for newline Git directories', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows filenames cannot contain newline characters.');
    return;
  }
  for (const location of ['repository', 'external-git-directory', 'nested-provider-cwd'] as const) {
    await t.test(location, async (subtest) => {
      const f = await fixture(
        subtest,
        location === 'repository' ? 'obsidian-workspaces-repository-\n' : undefined,
      );
      if (location === 'external-git-directory') {
        const directory = await mkdtemp(join(tmpdir(), 'obsidian-workspaces-gitdir-'));
        subtest.after(() => rm(directory, { recursive: true, force: true }));
        const gitDirectory = join(directory, 'external\ngit');
        await rename(join(f.root, '.git'), gitDirectory);
        await writeFile(join(f.root, '.git'), `gitdir: ${gitDirectory}\n`);
        await f.git(['config', 'core.hooksPath', join(gitDirectory, 'disabled-hooks')]);
      }
      const cwd = location === 'nested-provider-cwd' ? join(f.root, 'nested\ndirectory') : f.root;
      if (cwd !== f.root) await mkdir(cwd);
      const calls: string[][] = [];
      f.manager.git.raw = async (args) => {
        calls.push([...args]);
        return f.git(['-C', cwd, ...args]);
      };
      await f.adapter.withRepository((repository) => repository.assertCanSwitch('beta'));
      if (location !== 'nested-provider-cwd' || cwd.includes('\n')) {
        const markerCalls = calls.filter(
          (args) => args[0] === 'rev-parse' && args.includes('--git-path'),
        );
        assert.ok(
          markerCalls.some((args) => args.filter((arg) => arg === '--git-path').length > 1),
        );
        assert.equal(
          markerCalls.filter((args) => args.filter((arg) => arg === '--git-path').length === 1)
            .length,
          8,
          'Ambiguous newline-delimited paths must be resolved individually',
        );
      }
      const markerPath = resolve(
        f.root,
        (await f.git(['rev-parse', '--git-path', 'index.lock'])).replace(/\r?\n$/, ''),
      );
      await writeFile(markerPath, '');
      await assert.rejects(
        f.adapter.withRepository((repository) => repository.checkout('beta')),
        (error: unknown) => {
          assert.ok(error instanceof GitBackendError);
          assert.equal(error.code, 'operation-in-progress');
          assert.match(error.message, /index\.lock/);
          return true;
        },
      );
      assert.deepEqual(f.checkouts, []);
      await rm(markerPath);
      assert.equal(
        (await f.adapter.withRepository((repository) => repository.checkout('beta'))).branch,
        'beta',
      );
      assert.deepEqual(f.checkouts, ['beta']);
    });
  }
});

test('checkout rechecks edits and operation markers created after successful preflight', async (t) => {
  for (const change of ['tracked-edit', 'untracked-file', 'operation-marker'] as const) {
    await t.test(change, async (subtest) => {
      const f = await fixture(subtest);
      await f.adapter.withRepository(async (repository) => {
        await repository.assertCanSwitch('beta');
        if (change === 'tracked-edit')
          await writeFile(join(f.root, 'common.md'), 'Saved while outgoing views unloaded\n');
        else if (change === 'untracked-file')
          await writeFile(join(f.root, 'new-note.md'), 'Created after preflight\n');
        else await writeFile(join(f.root, '.git', 'index.lock'), '');
        await assert.rejects(
          repository.checkout('beta'),
          hasCode(change === 'operation-marker' ? 'operation-in-progress' : 'dirty-worktree'),
        );
      });
      assert.deepEqual(f.checkouts, []);
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
      if (change === 'tracked-edit')
        assert.equal(
          await readFile(join(f.root, 'common.md'), 'utf8'),
          'Saved while outgoing views unloaded\n',
        );
    });
  }
});

test('checkout rechecks target trees when the target ref moves after preflight', async (t) => {
  for (const change of ['integration-code', 'ignored-collision'] as const) {
    await t.test(change, async (subtest) => {
      const f = await fixture(subtest);
      await f.git(['checkout', '-b', 'replacement-beta', 'beta']);
      const replacementPath =
        change === 'integration-code'
          ? '.obsidian/plugins/obsidian-workspaces/main.js'
          : 'local-only.md';
      if (change === 'integration-code')
        await mkdir(join(f.root, '.obsidian', 'plugins', 'obsidian-workspaces'), {
          recursive: true,
        });
      await writeFile(join(f.root, replacementPath), 'Replacement target contents\n');
      await f.git(['add', replacementPath]);
      await f.git(['commit', '-m', 'Target that must fail revalidation']);
      const replacementCommit = (await f.git(['rev-parse', 'HEAD'])).trim();
      await f.git(['checkout', 'alpha']);
      if (change === 'ignored-collision') {
        await writeFile(join(f.root, '.git', 'info', 'exclude'), 'local-only.md\n');
        await writeFile(join(f.root, 'local-only.md'), 'Ignored local contents\n');
      }
      const guarded = new ObsidianGitBackend({
        resolvePlugin: () => f.plugin,
        isDesktop: () => true,
        checkoutGuard: {
          vaultPath: f.root,
          configDir: '.obsidian',
          pluginId: 'obsidian-workspaces',
        },
      });
      await guarded.withRepository(async (repository) => {
        await repository.assertCanSwitch('beta');
        await f.git(['update-ref', 'refs/heads/beta', replacementCommit]);
        await assert.rejects(
          repository.checkout('beta'),
          hasCode(change === 'integration-code' ? 'unsafe-runtime-files' : 'dirty-worktree'),
        );
      });
      assert.deepEqual(f.checkouts, []);
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
      if (change === 'ignored-collision')
        assert.equal(
          await readFile(join(f.root, 'local-only.md'), 'utf8'),
          'Ignored local contents\n',
        );
    });
  }
});

test('allows only exact existing local branches, rejecting options and reflog expressions', async (t) => {
  const f = await fixture(t);
  await f.adapter.withRepository(async (repository) => {
    for (const branch of [
      '--orphan=unwanted',
      '@{-1}',
      'HEAD',
      'beta^',
      'beta..alpha',
      'bad\nname',
    ]) {
      await assert.rejects(repository.checkout(branch), hasCode('invalid-branch'));
    }
    await assert.rejects(repository.checkout('missing'), hasCode('branch-not-found'));
  });
  assert.deepEqual(f.checkouts, []);
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
});

test('exact local refs with shell metacharacters stay literal and avoid redundant syntax reads', async (t) => {
  const f = await fixture(t);
  const branches = ['$(touch${IFS}unexpected-shell-marker)', 'quotes-\'"-;|&$'];
  for (const branch of branches) await f.git(['branch', branch, 'beta']);
  const calls: string[][] = [];
  f.manager.git.raw = async (args) => {
    calls.push([...args]);
    return f.git(args);
  };
  await f.adapter.withRepository(async (repository) => {
    for (const branch of branches) {
      assert.equal((await repository.checkout(branch)).branch, branch);
      assert.equal((await repository.checkout('alpha')).branch, 'alpha');
    }
  });
  assert.equal(
    calls.some((args) => args[0] === 'check-ref-format'),
    false,
  );
  await assert.rejects(access(join(f.root, 'unexpected-shell-marker')));
  assert.deepEqual(
    f.checkouts,
    branches.flatMap((branch) => [branch, 'alpha']),
  );
});

test('a clean guarded preflight uses six fresh reads with ignored files included in status', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.git', 'info', 'exclude'), 'local.tmp\n');
  await writeFile(join(f.root, 'local.tmp'), 'Local runtime state\n');
  const sourceOID = (await f.git(['rev-parse', 'HEAD'])).trim();
  const targetOID = (await f.git(['rev-parse', 'beta'])).trim();
  const calls: string[][] = [];
  f.manager.git.raw = async (args) => {
    calls.push([...args]);
    return f.git(args);
  };
  await guardedAdapter(f).withRepository(async (repository) => {
    await repository.assertCanSwitch('beta');
    const first = calls.splice(0);
    assert.equal(first.length, 6);
    assert.equal(first.filter((args) => args.includes('status')).length, 1);
    assert.ok(first.some((args) => args.includes('--ignored=traditional')));
    assert.equal(
      first.some((args) => args[0] === 'ls-tree' || args.includes('--others')),
      false,
    );
    assert.equal(
      first.some((args) => args[0] === 'check-ref-format'),
      false,
    );
    assert.ok(first.some((args) => args.includes(`--with-tree=${sourceOID}`)));
    const diff = first.find((args) => args[0] === 'diff')!;
    assert.deepEqual(diff.slice(-3), [sourceOID, targetOID, '--']);
    await repository.assertCanSwitch('beta');
    assert.deepEqual(calls, first, 'The next preflight must reread all mutable repository state');
  });
});

test('preparation returns its guarded source identity and checkout does not reuse its mutable observations', async (t) => {
  const f = await fixture(t);
  const calls: string[][] = [];
  f.manager.git.raw = async (args) => {
    calls.push([...args]);
    return f.git(args);
  };
  await guardedAdapter(f).withRepository(async (repository) => {
    assert.ok(repository.prepareSwitch);
    assert.deepEqual(await repository.prepareSwitch('beta'), { root: f.root, branch: 'alpha' });
    assert.equal(calls.length, 6, 'Returning preflight identity launches no additional query');
    assert.equal(
      calls.some((args) => args.includes('--symbolic-full-name')),
      false,
    );
    await writeFile(join(f.root, 'common.md'), 'Saved by a view after preparation\n');
    calls.length = 0;
    await assert.rejects(repository.checkout('beta'), hasCode('dirty-worktree'));
    assert.equal(
      calls.some((args) => args.includes('status')),
      true,
    );
    assert.deepEqual(f.checkouts, []);
    assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
  });
});

test('a later safeguard in one scope starts its tree comparison with the first reads and rereads all inputs', async (t) => {
  const f = await fixture(t);
  const sourceOID = (await f.git(['rev-parse', 'HEAD'])).trim();
  const targetOID = (await f.git(['rev-parse', 'beta'])).trim();
  const calls: string[][] = [];
  let holdStatus: ReturnType<typeof deferred> | null = null;
  let launchedBeforeStatus: string[] | null = null;
  f.manager.git.raw = async (args) => {
    calls.push([...args]);
    if (holdStatus && args.includes('status')) {
      // Every read of this wave has been launched when its first one yields.
      await new Promise<void>((resolve) => setImmediate(resolve));
      launchedBeforeStatus = calls.map((call) => call.find((part) => !part.startsWith('-'))!);
      holdStatus.resolve();
    }
    return f.git(args);
  };
  const adapter = guardedAdapter(f);
  await adapter.withRepository(async (repository) => {
    await repository.assertCanSwitch('beta');
    const first = calls.splice(0);
    assert.equal(first.length, 6);
    holdStatus = deferred();
    await repository.assertCanSwitch('beta');
    await holdStatus.promise;
    assert.deepEqual(calls, first, 'The later safeguard rereads exactly the same six inputs');
    assert.deepEqual(launchedBeforeStatus, [
      'for-each-ref',
      'status',
      'rev-parse',
      'config',
      'ls-files',
      'diff',
    ]);
    const diff = calls.find((args) => args[0] === 'diff')!;
    assert.deepEqual(diff.slice(-3), [sourceOID, targetOID, '--']);
  });
  // A new queue scope has no earlier observation. It must wait for fresh commits.
  calls.length = 0;
  holdStatus = deferred();
  launchedBeforeStatus = null;
  await adapter.withRepository((repository) => repository.assertCanSwitch('beta'));
  assert.deepEqual(launchedBeforeStatus, ['for-each-ref', 'status', 'rev-parse', 'config']);
  assert.equal(calls.length, 6);
  assert.deepEqual(f.checkouts, []);
});

test('an early tree comparison is discarded when the source or target commit moved', async (t) => {
  for (const moved of ['target', 'source'] as const) {
    await t.test(moved, async (subtest) => {
      const f = await fixture(subtest);
      const calls: string[][] = [];
      f.manager.git.raw = async (args) => {
        calls.push([...args]);
        return f.git(args);
      };
      await guardedAdapter(f).withRepository(async (repository) => {
        await repository.assertCanSwitch('beta');
        // A safe new commit: the old comparison no longer describes this switch.
        await f.git(['checkout', moved === 'target' ? 'beta' : 'alpha']);
        await writeFile(join(f.root, `later-${moved}.md`), 'Committed after the first safeguard\n');
        await f.git(['add', `later-${moved}.md`]);
        await f.git(['commit', '-m', 'Later safe commit']);
        await f.git(['checkout', 'alpha']);
        const sourceOID = (await f.git(['rev-parse', 'alpha'])).trim();
        const targetOID = (await f.git(['rev-parse', 'beta'])).trim();
        calls.length = 0;
        assert.equal((await repository.checkout('beta')).branch, 'beta');
        const beforeCheckout = calls.slice(
          0,
          calls.findIndex((args) => args.includes('--symbolic-full-name')),
        );
        const diffs = beforeCheckout.filter((args) => args[0] === 'diff');
        const trees = beforeCheckout.filter((args) => args[0] === 'ls-files');
        assert.equal(diffs.length, 2, 'The stale early comparison is followed by a fresh one');
        assert.equal(trees.length, 2);
        assert.deepEqual(diffs[1]!.slice(-3), [sourceOID, targetOID, '--']);
        assert.ok(trees[1]!.includes(`--with-tree=${sourceOID}`));
        assert.notDeepEqual(diffs[0]!.slice(-3), diffs[1]!.slice(-3));
      });
      assert.deepEqual(f.checkouts, ['beta']);
      assert.equal(
        await readFile(join(f.root, 'later-target.md'), 'utf8').catch(() => 'absent'),
        moved === 'target' ? 'Committed after the first safeguard\n' : 'absent',
      );
    });
  }
});

test('a source commit that became unsafe after the first safeguard is not hidden by the early comparison', async (t) => {
  const f = await fixture(t);
  const integration = join(f.root, '.obsidian', 'plugins', 'obsidian-git');
  await guardedAdapter(f).withRepository(async (repository) => {
    await repository.assertCanSwitch('beta');
    // Only the comparison of the new source commit with the target shows this path.
    await mkdir(integration, { recursive: true });
    await writeFile(join(integration, 'main.js'), 'Integration code tracked only on the source\n');
    await f.git(['add', '.obsidian/plugins/obsidian-git/main.js']);
    await f.git(['commit', '-m', 'Source commit that changes integration code']);
    await assert.rejects(repository.checkout('beta'), hasCode('unsafe-runtime-files'));
  });
  assert.deepEqual(f.checkouts, []);
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
});

test('a failed or malformed early tree comparison is repeated instead of trusted or reported', async (t) => {
  for (const fault of ['rejects', 'malformed'] as const) {
    await t.test(fault, async (subtest) => {
      const f = await fixture(subtest);
      let armed = false;
      let faults = 0;
      let treeReads = 0;
      f.manager.git.raw = async (args) => {
        if (args[0] === 'ls-files') {
          treeReads += 1;
          if (armed) {
            armed = false;
            faults += 1;
            if (fault === 'rejects') throw new Error('Early index read failed');
            return 'unterminated-record';
          }
        }
        return f.git(args);
      };
      await guardedAdapter(f).withRepository(async (repository) => {
        await repository.assertCanSwitch('beta');
        treeReads = 0;
        armed = true;
        assert.equal((await repository.checkout('beta')).branch, 'beta');
      });
      assert.equal(faults, 1);
      assert.equal(treeReads, 2, 'The safeguard rereads the tree after the failed early attempt');
      assert.deepEqual(f.checkouts, ['beta']);
    });
  }
});

test('an early tree comparison cannot hide a target that became unsafe on the same commits', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.git', 'info', 'exclude'), 'b.md\n');
  await guardedAdapter(f).withRepository(async (repository) => {
    await repository.assertCanSwitch('beta');
    // Same source and target commits; only the ignored working file is new.
    await writeFile(join(f.root, 'b.md'), 'Ignored local contents\n');
    await assert.rejects(repository.checkout('beta'), hasCode('dirty-worktree'));
  });
  assert.deepEqual(f.checkouts, []);
  assert.equal(await readFile(join(f.root, 'b.md'), 'utf8'), 'Ignored local contents\n');
});

test('source commit paths remain protected if another client removes index entries after status', async (t) => {
  for (const scenario of ['source-layout', 'unchanged-layout', 'ignored-ancestor']) {
    await t.test(scenario, async (subtest) => {
      const f = await fixture(subtest);
      const path =
        scenario === 'ignored-ancestor' ? 'unchanged/child.md' : '.obsidian/workspace.json';
      const branches = scenario === 'source-layout' ? ['alpha'] : ['alpha', 'beta'];
      for (const branch of branches) {
        await f.git(['checkout', branch]);
        await mkdir(join(f.root, path.split('/')[0]!), { recursive: true });
        await writeFile(join(f.root, path), 'Identical tracked content\n');
        await f.git(['add', path]);
        await f.git(['commit', '-m', 'Tracked path protected after index mutation']);
      }
      await f.git(['checkout', 'alpha']);
      if (scenario === 'ignored-ancestor') {
        await f.git(['update-index', '--skip-worktree', path]);
        await rm(join(f.root, 'unchanged'), { recursive: true });
        await writeFile(join(f.root, 'unchanged'), 'Ignored ancestor must survive\n');
        await writeFile(join(f.root, '.git', 'info', 'exclude'), '/unchanged\n');
      }
      let changedIndex = false;
      f.manager.git.raw = async (args) => {
        const output = await f.git(args);
        if (args.includes('status') && args.includes('--ignored=traditional') && !changedIndex) {
          assert.equal(
            output.split('\0').some((entry) => /^[12u?] /.test(entry)),
            false,
          );
          changedIndex = true;
          await f.git(['update-index', '--force-remove', path]);
        }
        return output;
      };
      await assert.rejects(
        guardedAdapter(f).withRepository((repository) => repository.checkout('beta')),
        hasCode(scenario === 'ignored-ancestor' ? 'dirty-worktree' : 'unsafe-runtime-files'),
      );
      assert.equal(changedIndex, true);
      assert.deepEqual(f.checkouts, []);
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
    });
  }
});

test('malformed index and raw diff responses fail closed before checkout', async (t) => {
  const f = await fixture(t);
  const validDiff = await f.git([
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    'HEAD',
    'refs/heads/beta',
    '--',
  ]);
  const entries = validDiff.split('\0');
  const firstHeader = entries[0]!;
  const replaceHeader = (header: string): string => [header, ...entries.slice(1)].join('\0');
  const malformed = [
    { name: 'missing terminal NUL', diff: validDiff.slice(0, -1) },
    { name: 'missing path', diff: `${firstHeader}\0` },
    { name: 'unknown mode', diff: replaceHeader(firstHeader.replace(/^:[0-7]{6}/, ':100660')) },
    {
      name: 'abbreviated object',
      diff: replaceHeader(firstHeader.replace(/[0-9a-f]{40}/, '1234')),
    },
    {
      name: 'unexpected rename',
      diff: replaceHeader(firstHeader.replace(/ [A-Z][0-9]*$/, ' R100')),
    },
    {
      name: 'unexpected unmerged path',
      diff: replaceHeader(firstHeader.replace(/ [A-Z][0-9]*$/, ' U')),
    },
    {
      name: 'mode and zero object disagree',
      diff: replaceHeader(firstHeader.replace(/^:[0-7]{6}/, ':000000')),
    },
    { name: 'duplicate change', diff: `${validDiff}${entries[0]}\0${entries[1]}\0` },
    { name: 'outside relative path', diff: `${firstHeader}\0../a.md\0` },
    { name: 'truncated index', index: 'a.md' },
    { name: 'unexpanded sparse index', index: 'hidden/\0' },
  ];
  for (const scenario of malformed) {
    await t.test(scenario.name, async () => {
      f.manager.git.raw = async (args) => {
        if (args[0] === 'diff' && 'diff' in scenario) return scenario.diff!;
        if (args[0] === 'ls-files' && 'index' in scenario) return scenario.index!;
        return f.git(args);
      };
      await assert.rejects(
        guardedAdapter(f).withRepository((repository) => repository.checkout('beta')),
        hasCode('invalid-status'),
      );
      assert.deepEqual(f.checkouts, []);
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
    });
  }
});

test('reports detached HEAD without pretending it is a branch', async (t) => {
  const f = await fixture(t);
  await f.git(['checkout', '--detach', 'HEAD']);
  await f.adapter.withRepository(async (repository) => {
    assert.equal((await repository.inspect()).branch, null);
    await assert.rejects(repository.checkout('beta'), hasCode('detached-head'));
  });
});

test('re-reads the real branch when a provider fails after changing it', async (t) => {
  const f = await fixture(t);
  const refreshes: string[] = [];
  let displayedBranch = 'alpha';
  Object.assign(f.plugin, {
    app: {
      workspace: {
        trigger(event: string) {
          refreshes.push(event);
        },
      },
    },
    branchBar: {
      async display(): Promise<void> {
        displayedBranch = (await f.git(['branch', '--show-current'])).trim();
      },
    },
  });
  f.manager.checkout = async (branch) => {
    await f.git(['checkout', branch]);
    await writeFile(join(f.root, 'common.md'), 'Provider changed this file before failing\n');
    throw new Error('Provider failed after checkout');
  };
  await assert.rejects(
    f.adapter.withRepository((repository) => repository.checkout('beta')),
    (error: unknown) => {
      assert.ok(error instanceof GitBackendError);
      assert.equal(error.code, 'checkout-failed');
      assert.equal(error.status?.branch, 'beta');
      assert.equal(error.status?.dirty, true);
      assert.equal(error.status?.conflicted, false);
      return true;
    },
  );
  assert.equal(await readFile(join(f.root, 'b.md'), 'utf8'), 'Only on beta\n');
  assert.deepEqual(refreshes, ['obsidian-git:refresh']);
  assert.equal(displayedBranch, 'beta');
});

test('detects a provider that resolves without activating the target branch', async (t) => {
  const f = await fixture(t);
  f.manager.checkout = async () => {};
  await assert.rejects(
    f.adapter.withRepository((repository) => repository.checkout('beta')),
    (error: unknown) => {
      assert.ok(error instanceof GitBackendError);
      assert.equal(error.code, 'branch-mismatch');
      assert.equal(error.status?.branch, 'alpha');
      return true;
    },
  );
});

test('rejects recursive submodule checkout from both plugin and Git configuration', async (t) => {
  const f = await fixture(t);
  f.plugin.settings.submoduleRecurseCheckout = true;
  await assert.rejects(
    f.adapter.withRepository((repository) => repository.checkout('beta')),
    hasCode('unsupported-submodules'),
  );
  f.plugin.settings.submoduleRecurseCheckout = false;
  await f.git(['config', 'submodule.recurse', 'true']);
  await assert.rejects(
    f.adapter.withRepository((repository) => repository.checkout('beta')),
    hasCode('unsupported-submodules'),
  );
  assert.deepEqual(f.checkouts, []);
});

test('protects ignored local files that Git checkout would otherwise overwrite', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.git', 'info', 'exclude'), 'b.md\n');
  await writeFile(join(f.root, 'b.md'), 'Local ignored content\n');
  await f.adapter.withRepository(async (repository) => {
    assert.equal((await repository.inspect()).dirty, false);
    await assert.rejects(repository.checkout('beta'), hasCode('dirty-worktree'));
  });
  assert.equal(await readFile(join(f.root, 'b.md'), 'utf8'), 'Local ignored content\n');
  assert.deepEqual(f.checkouts, []);
});

test('retains unchanged target paths when ignored files hide skip-worktree or assumed-unchanged entries', async (t) => {
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    await t.test(flag, async (subtest) => {
      const f = await fixture(subtest);
      for (const branch of ['alpha', 'beta']) {
        await f.git(['checkout', branch]);
        await mkdir(join(f.root, 'unchanged'), { recursive: true });
        await writeFile(join(f.root, 'unchanged', 'child.md'), 'Identical tracked child\n');
        await f.git(['add', 'unchanged/child.md']);
        await f.git(['commit', '-m', 'Unchanged tracked subtree']);
      }
      await f.git(['checkout', 'alpha']);
      await f.git(['update-index', flag, 'unchanged/child.md']);
      await rm(join(f.root, 'unchanged'), { recursive: true });
      await writeFile(join(f.root, 'unchanged'), 'Ignored ancestor must survive\n');
      await writeFile(join(f.root, '.git', 'info', 'exclude'), '/unchanged\n');
      const guarded = guardedAdapter(f);
      await guarded.withRepository(async (repository) => {
        assert.equal((await repository.inspect()).dirty, false);
        await assert.rejects(repository.checkout('beta'), hasCode('dirty-worktree'));
      });
      assert.equal(
        await readFile(join(f.root, 'unchanged'), 'utf8'),
        'Ignored ancestor must survive\n',
      );
      assert.deepEqual(f.checkouts, []);
    });
  }
});

test('ignored nested repository directories collide with destination tracked descendants', async (t) => {
  const f = await fixture(t);
  await f.git(['checkout', 'beta']);
  await mkdir(join(f.root, 'local-repo'));
  await writeFile(join(f.root, 'local-repo', 'tracked.md'), 'Target tracked contents\n');
  await f.git(['add', 'local-repo']);
  await f.git(['commit', '-m', 'Target tracked subtree']);
  await f.git(['checkout', 'alpha']);
  await mkdir(join(f.root, 'local-repo'));
  await f.git(['-C', 'local-repo', 'init', '-b', 'local']);
  await writeFile(join(f.root, 'local-repo', 'local.md'), 'Local repository contents\n');
  await writeFile(join(f.root, '.git', 'info', 'exclude'), '/local-repo/\n');
  const ignored = await f.git([
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--ignored=traditional',
  ]);
  assert.ok(ignored.includes('! local-repo/\0'));
  await assert.rejects(
    guardedAdapter(f).withRepository((repository) => repository.checkout('beta')),
    hasCode('dirty-worktree'),
  );
  assert.equal(
    await readFile(join(f.root, 'local-repo', 'local.md'), 'utf8'),
    'Local repository contents\n',
  );
  assert.deepEqual(f.checkouts, []);
});

test('full index reconstruction covers excluded sparse directories and tracked native layouts', async (t) => {
  for (const trackedLayout of [false, true]) {
    await t.test(
      trackedLayout ? 'excluded tracked layout' : 'safe sparse checkout',
      async (subtest) => {
        const f = await fixture(subtest);
        for (const directory of ['visible', 'hidden', '.obsidian']) {
          await mkdir(join(f.root, directory));
          await writeFile(join(f.root, directory, 'note.md'), 'Tracked note\n');
        }
        if (trackedLayout) await writeFile(join(f.root, '.obsidian', 'workspace.json'), '{}\n');
        await f.git(['add', '.']);
        await f.git(['commit', '-m', 'Sparse source paths']);
        await f.git(['sparse-checkout', 'init', '--cone', '--sparse-index']);
        await f.git(['sparse-checkout', 'set', 'visible']);
        assert.ok((await f.git(['ls-files', '--sparse', '-z'])).includes('hidden/\0'));
        await assert.rejects(access(join(f.root, '.obsidian', 'note.md')));
        await guardedAdapter(f).withRepository(async (repository) => {
          assert.equal((await repository.inspect()).dirty, false);
          if (trackedLayout)
            await assert.rejects(repository.checkout('beta'), hasCode('unsafe-runtime-files'));
          else assert.equal((await repository.checkout('beta')).branch, 'beta');
        });
        assert.deepEqual(f.checkouts, trackedLayout ? [] : ['beta']);
      },
    );
  }
});

test('a nested provider cwd cannot hide source runtime paths or target ignored collisions', async (t) => {
  for (const scenario of ['source-layout', 'target-collision']) {
    await t.test(scenario, async (subtest) => {
      const f = await fixture(subtest);
      const cwd = join(f.root, 'nested', 'directory');
      await mkdir(cwd, { recursive: true });
      if (scenario === 'source-layout') {
        await mkdir(join(f.root, '.obsidian'));
        await writeFile(join(f.root, '.obsidian', 'workspace.json'), '{}\n');
        await f.git(['add', '.obsidian']);
        await f.git(['commit', '-m', 'Tracked source layout outside provider cwd']);
      } else {
        await writeFile(join(f.root, '.git', 'info', 'exclude'), '/b.md\n');
        await writeFile(join(f.root, 'b.md'), 'Ignored outside provider cwd\n');
      }
      f.manager.git.raw = (args) => f.git(['-C', cwd, ...args]);
      await assert.rejects(
        guardedAdapter(f).withRepository((repository) => repository.checkout('beta')),
        hasCode(scenario === 'source-layout' ? 'unsafe-runtime-files' : 'dirty-worktree'),
      );
      assert.deepEqual(f.checkouts, []);
    });
  }
});

test('rejects repository replacement and use after the queue scope ends', async (t) => {
  const f = await fixture(t);
  let escaped: GitRepository | undefined;
  await f.adapter.withRepository(async (repository) => {
    escaped = repository;
    f.manager.absoluteRepoPath = join(f.root, 'other');
    await assert.rejects(repository.inspect(), hasCode('repository-changed'));
    f.manager.absoluteRepoPath = f.root;
  });
  assert.ok(escaped);
  await assert.rejects(escaped.inspect(), hasCode('repository-released'));
});

test('propagates controller failures while allowing the next queued transaction', async (t) => {
  const f = await fixture(t);
  const failure = new Error('Layout restoration failed');
  await assert.rejects(
    f.adapter.withRepository(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  const branch = await f.adapter.withRepository(
    async (repository) => (await repository.inspect()).branch,
  );
  assert.equal(branch, 'alpha');
});

test('checkout guard refuses native layout runtime files tracked on the source or target branch', async (t) => {
  for (const scenario of [
    { branch: 'alpha', file: 'workspace.json' },
    { branch: 'beta', file: 'workspace-mobile.json' },
  ]) {
    await t.test(`${scenario.branch}: ${scenario.file}`, async (subtest) => {
      const f = await fixture(subtest);
      await f.git(['checkout', scenario.branch]);
      await mkdir(join(f.root, '.obsidian'), { recursive: true });
      await writeFile(join(f.root, '.obsidian', scenario.file), JSON.stringify({ main: {} }));
      await f.git(['add', '.obsidian']);
      await f.git(['commit', '-m', 'Tracked native runtime layout']);
      await f.git(['checkout', 'alpha']);
      const guarded = new ObsidianGitBackend({
        resolvePlugin: () => f.plugin,
        isDesktop: () => true,
        checkoutGuard: {
          vaultPath: f.root,
          configDir: '.obsidian',
          pluginId: 'obsidian-workspaces',
        },
      });
      await assert.rejects(
        guarded.withRepository((repository) => repository.checkout('beta')),
        hasCode('unsafe-runtime-files'),
      );
      assert.deepEqual(f.checkouts, []);
      assert.equal((await f.git(['branch', '--show-current'])).trim(), 'alpha');
    });
  }
});

test('checkout guard refuses changed integration manifests and plugin enablement', async (t) => {
  for (const path of [
    'plugins/obsidian-workspaces/manifest.json',
    'plugins/obsidian-git/manifest.json',
    'community-plugins.json',
  ]) {
    await t.test(path, async (subtest) => {
      const f = await fixture(subtest);
      const parts = path.split('/');
      const directory = join(f.root, '.obsidian', ...parts.slice(0, -1));
      for (const [branch, content] of [
        ['alpha', 'source'],
        ['beta', 'changed-target'],
      ] as const) {
        await f.git(['checkout', branch]);
        await mkdir(directory, { recursive: true });
        await writeFile(join(f.root, '.obsidian', ...parts), JSON.stringify({ content }));
        await f.git(['add', '.obsidian']);
        await f.git(['commit', '-m', `Runtime files on ${branch}`]);
      }
      await f.git(['checkout', 'alpha']);
      const guarded = new ObsidianGitBackend({
        resolvePlugin: () => f.plugin,
        isDesktop: () => true,
        checkoutGuard: {
          vaultPath: f.root,
          configDir: '.obsidian',
          pluginId: 'obsidian-workspaces',
        },
      });
      await assert.rejects(
        guarded.withRepository((repository) => repository.checkout('beta')),
        hasCode('unsafe-runtime-files'),
      );
      assert.deepEqual(f.checkouts, []);
    });
  }
});

test('raw diff type changes preserve safe note switches and protect integration paths', async (t) => {
  if (process.platform === 'win32') {
    t.skip('These cases require POSIX symlinks and newline filenames.');
    return;
  }
  for (const scenario of ['ordinary-note', 'integration-file', 'integration-ancestor-gitlink']) {
    await t.test(scenario, async (subtest) => {
      const f = await fixture(subtest);
      if (scenario === 'integration-file') {
        await mkdir(join(f.root, '.obsidian'));
        await writeFile(join(f.root, '.obsidian', 'community-plugins.json'), '[]\n');
        await f.git(['add', '.obsidian']);
        await f.git(['commit', '-m', 'Source integration file']);
      }
      const source = (await f.git(['rev-parse', 'HEAD'])).trim();
      await f.git(['checkout', 'beta']);
      if (scenario === 'ordinary-note') {
        await rm(join(f.root, 'common.md'));
        await symlink('b.md', join(f.root, 'common.md'));
        await writeFile(join(f.root, 'literal\n\tname.md'), 'Unusual path contents\n');
        await f.git(['add', '-A']);
      } else if (scenario === 'integration-file') {
        await mkdir(join(f.root, '.obsidian'));
        await symlink('../common.md', join(f.root, '.obsidian', 'community-plugins.json'));
        await f.git(['add', '.obsidian']);
      } else {
        await f.git(['update-index', '--add', '--cacheinfo', `160000,${source},.obsidian/plugins`]);
      }
      await f.git(['commit', '-m', 'Target type changes']);
      await f.git(['checkout', 'alpha']);
      await guardedAdapter(f).withRepository(async (repository) => {
        if (scenario === 'ordinary-note') {
          assert.equal((await repository.checkout('beta')).branch, 'beta');
          assert.equal(await readFile(join(f.root, 'common.md'), 'utf8'), 'Only on beta\n');
          assert.equal(
            await readFile(join(f.root, 'literal\n\tname.md'), 'utf8'),
            'Unusual path contents\n',
          );
        } else {
          await assert.rejects(repository.checkout('beta'), hasCode('unsafe-runtime-files'));
        }
      });
      assert.deepEqual(f.checkouts, scenario === 'ordinary-note' ? ['beta'] : []);
    });
  }
});

test('checkout guard allows identical tracked plugin code with a custom vault config and plugin ID', async (t) => {
  const f = await fixture(t);
  const runtime = [
    'plugins/custom-contexts/manifest.json',
    'plugins/obsidian-git/manifest.json',
    'community-plugins.json',
  ];
  for (const branch of ['alpha', 'beta']) {
    await f.git(['checkout', branch]);
    for (const path of runtime) {
      const parts = path.split('/');
      await mkdir(join(f.root, 'custom-config', ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(f.root, 'custom-config', ...parts), JSON.stringify({ identical: true }));
    }
    await f.git(['add', 'custom-config']);
    await f.git(['commit', '-m', 'Identical runtime files']);
  }
  await f.git(['checkout', 'alpha']);
  const guarded = new ObsidianGitBackend({
    resolvePlugin: () => f.plugin,
    isDesktop: () => true,
    checkoutGuard: { vaultPath: f.root, configDir: 'custom-config', pluginId: 'custom-contexts' },
  });
  assert.equal(
    (await guarded.withRepository((repository) => repository.checkout('beta'))).branch,
    'beta',
  );
  assert.deepEqual(f.checkouts, ['beta']);
});

test('checkout guard requires the vault to be inside the inspected repository', async (t) => {
  const f = await fixture(t);
  const guarded = new ObsidianGitBackend({
    resolvePlugin: () => f.plugin,
    isDesktop: () => true,
    checkoutGuard: { vaultPath: tmpdir(), configDir: '.obsidian', pluginId: 'obsidian-workspaces' },
  });
  await assert.rejects(
    guarded.withRepository((repository) => repository.checkout('beta')),
    hasCode('unsafe-runtime-files'),
  );
  assert.deepEqual(f.checkouts, []);
});

test('checkout guard resolves runtime paths relative to a vault nested in its repository', async (t) => {
  const f = await fixture(t);
  const vault = join(f.root, 'notes');
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  await writeFile(join(vault, '.obsidian', 'workspace.json'), '{}');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Nested vault native runtime state']);
  const guarded = new ObsidianGitBackend({
    resolvePlugin: () => f.plugin,
    isDesktop: () => true,
    checkoutGuard: { vaultPath: vault, configDir: '.obsidian', pluginId: 'obsidian-workspaces' },
  });
  await assert.rejects(
    guarded.withRepository((repository) => repository.checkout('beta')),
    hasCode('unsafe-runtime-files'),
  );
  assert.deepEqual(f.checkouts, []);
});

test('checkout guard refuses configuration symlinks that hide their real runtime paths', async (t) => {
  const f = await fixture(t);
  const outsideConfig = await mkdtemp(join(tmpdir(), 'obsidian-workspaces-config-'));
  t.after(() => rm(outsideConfig, { recursive: true, force: true }));
  await symlink(outsideConfig, join(f.root, '.obsidian'), 'dir');
  await writeFile(join(f.root, '.git', 'info', 'exclude'), '.obsidian\n');
  const guarded = new ObsidianGitBackend({
    resolvePlugin: () => f.plugin,
    isDesktop: () => true,
    checkoutGuard: { vaultPath: f.root, configDir: '.obsidian', pluginId: 'obsidian-workspaces' },
  });
  await assert.rejects(
    guarded.withRepository((repository) => repository.checkout('beta')),
    hasCode('unsafe-runtime-files'),
  );
  assert.deepEqual(f.checkouts, []);
});
