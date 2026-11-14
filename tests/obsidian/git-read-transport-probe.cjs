/* Test-only transport feasibility probe for a completed disposable native fixture. */
const { Plugin, Notice, apiVersion } = require('obsidian');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const now = () => performance.now();
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
const errorInfo = (error) => ({
  message: String(error?.message ?? error).slice(0, 1000),
  code: error?.code,
});
const queries = {
  version: ['--version'],
  root: ['rev-parse', '--show-toplevel'],
  identity: ['rev-parse', '--show-toplevel', '--symbolic-full-name', 'HEAD'],
  status: [
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
    '--ignored=traditional',
  ],
  markers: [
    'rev-parse',
    '--show-toplevel',
    '--show-prefix',
    '--git-path',
    'MERGE_HEAD',
    '--git-path',
    'CHERRY_PICK_HEAD',
    '--git-path',
    'REVERT_HEAD',
    '--git-path',
    'rebase-merge',
    '--git-path',
    'rebase-apply',
    '--git-path',
    'sequencer',
    '--git-path',
    'BISECT_LOG',
    '--git-path',
    'index.lock',
  ],
  exactRef: ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/alpha'],
};
const measuredQueries = ['root', 'identity', 'status', 'markers', 'exactRef'];
const within = (parent, child) => {
  const part = path.relative(parent, child);
  return (
    part === '' || (part !== '..' && !part.startsWith(`..${path.sep}`) && !path.isAbsolute(part))
  );
};
const statistics = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const n = sorted.length;
  return {
    n,
    min: sorted[0],
    max: sorted[n - 1],
    median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1],
  };
};

// Stringified into a fresh Node worker; no renderer objects or source imports.
function workerMain() {
  const { parentPort, workerData } = require('node:worker_threads');
  const { execFile } = require('node:child_process');
  const { performance } = require('node:perf_hooks');
  let child = null;
  let stopping = false;
  const stopped = () => {
    parentPort.postMessage({ type: 'stopped' });
    parentPort.close();
  };
  parentPort.on('message', (request) => {
    if (request.type === 'stop') {
      stopping = true;
      if (child) child.kill('SIGKILL');
      else stopped();
      return;
    }
    const args = workerData.queries[request.query];
    if (request.type !== 'read' || !args || stopping || child) {
      parentPort.postMessage({
        type: 'result',
        id: request.id,
        error: { message: 'Invalid or concurrent worker request.' },
      });
      return;
    }
    const start = performance.now();
    let invocationMs;
    let pid;
    try {
      child = execFile(
        'git',
        ['-c', 'core.quotepath=off', ...args],
        {
          cwd: workerData.cwd,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const executionMs = performance.now() - start;
          child = null;
          parentPort.postMessage({
            type: 'result',
            id: request.id,
            pid,
            stdout,
            stderrBytes: Buffer.byteLength(stderr),
            invocationMs,
            executionMs,
            error: error
              ? {
                  message: String(error.message).slice(0, 1000),
                  code: error.code,
                  killed: error.killed,
                  signal: error.signal,
                }
              : null,
          });
          if (stopping) stopped();
        },
      );
      invocationMs = performance.now() - start;
      pid = child.pid;
      parentPort.postMessage({ type: 'child', id: request.id, pid });
    } catch (error) {
      child = null;
      parentPort.postMessage({
        type: 'result',
        id: request.id,
        error: { message: String(error.message).slice(0, 1000), code: error.code },
      });
      if (stopping) stopped();
    }
  });
  parentPort.postMessage({
    type: 'ready',
    versions: process.versions,
    heapUsedBytes: process.memoryUsage().heapUsed,
  });
}

class ReadWorker {
  constructor(cwd) {
    this.pending = new Map();
    this.children = new Set();
    this.sequence = 0;
    this.exited = false;
    this.started = now();
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    const { Worker } = require('node:worker_threads');
    this.worker = new Worker(`(${workerMain.toString()})();`, {
      eval: true,
      execArgv: [],
      workerData: { cwd, queries },
    });
    this.creationInvocationMs = now() - this.started;
    this.worker.on('message', (message) => {
      if (message.type === 'ready') {
        this.resolveReady({
          ...message,
          startupMs: now() - this.started,
          creationInvocationMs: this.creationInvocationMs,
        });
      } else if (message.type === 'child' && Number.isInteger(message.pid)) {
        this.children.add(message.pid);
      } else if (message.type === 'result') {
        this.children.delete(message.pid);
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            Object.assign(new Error(message.error.message), { code: message.error.code }),
          );
        else pending.resolve(message);
      }
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      this.exited = true;
      this.exitCode = code;
      this.fail(new Error(`Read worker exited (${code}).`));
      this.resolveExit(code);
    });
  }
  fail(error) {
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    // Only PIDs reported by this worker's own currently outstanding execFile.
    for (const pid of this.children) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    this.children.clear();
  }
  async start() {
    const timer = setTimeout(() => this.fail(new Error('Read worker startup timed out.')), 15_000);
    try {
      return await this.ready;
    } finally {
      clearTimeout(timer);
    }
  }
  read(query) {
    if (this.exited || this.stopping)
      return Promise.reject(new Error('Read worker is unavailable.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('Read worker request timed out.'));
        void this.stop().catch(() => {});
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ type: 'read', id, query });
      } catch (error) {
        this.fail(error);
      }
    });
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      if (!this.exited) {
        try {
          this.worker.postMessage({ type: 'stop' });
        } catch {}
        let timer;
        await Promise.race([
          this.exit,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 1500);
          }),
        ]);
        clearTimeout(timer);
        if (!this.exited) {
          this.forcedTermination = true;
          this.fail(new Error('Read worker required forced termination.'));
          await this.worker.terminate();
        }
      }
      return {
        exited: this.exited,
        exitCode: this.exitCode,
        forced: !!this.forcedTermination,
        remainingTrackedChildren: this.children.size,
      };
    })();
    return this.stopPromise;
  }
}

module.exports = class GitReadTransportProbe extends Plugin {
  async onload() {
    this.config = await this.loadData();
    if (
      this.config?.fixture !== 'obsidian-workspaces-git-read-transport-v1' ||
      this.config.completedAt
    )
      return;
    this.stopped = false;
    this.addCommand({
      id: 'run-git-read-transport-probe',
      name: 'Run Git read transport probe',
      callback: () => {
        if (!this.running && !this.stopped && !this.config.completedAt)
          void this.run().catch((error) =>
            console.error('Git transport diagnostic failed.', errorInfo(error)),
          );
      },
    });
  }
  onunload() {
    this.stopped = true;
    void this.worker?.stop().catch(() => {});
  }
  async writeResult() {
    if (!this.validatedResultPath) return;
    const temporary = `${this.config.resultFile}.${this.config.runId}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.result, null, 2));
    await fs.rename(temporary, this.config.resultFile);
  }
  async raw(args) {
    assert(!this.stopped, 'Transport probe was unloaded.');
    return Reflect.apply(this.git.raw, this.git, [[...args]]);
  }
  async measured(transport, query) {
    assert(!this.stopped, 'Transport probe was unloaded.');
    let nextPulse = now() + 5;
    const pulseLag = [];
    const timer = setInterval(() => {
      const at = now();
      pulseLag.push(Math.max(0, at - nextPulse));
      nextPulse = at + 5;
    }, 5);
    const start = now();
    try {
      const pending = transport === 'provider' ? this.raw(queries[query]) : this.worker.read(query);
      const invocationMs = now() - start;
      const value = await pending;
      const elapsedMs = now() - start;
      const outstandingPulseLagMs = Math.max(0, now() - nextPulse);
      return {
        stdout: transport === 'provider' ? value : value.stdout,
        timing: {
          elapsedMs,
          invocationMs,
          pulseCount: pulseLag.length,
          maximumRendererTimerLagMs: Math.max(outstandingPulseLagMs, 0, ...pulseLag),
          ...(transport === 'worker'
            ? {
                workerExecFileInvocationMs: value.invocationMs,
                workerExecutionMs: value.executionMs,
                stderrBytes: value.stderrBytes,
              }
            : {}),
        },
      };
    } finally {
      clearInterval(timer);
    }
  }
  async pair(query, index, temperature) {
    const order = index % 2 ? ['worker', 'provider'] : ['provider', 'worker'];
    const values = {};
    for (const transport of order) values[transport] = await this.measured(transport, query);
    const sample = {
      index,
      temperature,
      query,
      order,
      arguments: queries[query],
      provider: values.provider.timing,
      worker: values.worker.timing,
      providerBytes: Buffer.byteLength(values.provider.stdout),
      workerBytes: Buffer.byteLength(values.worker.stdout),
      outputsEqual: values.provider.stdout === values.worker.stdout,
    };
    this.result.samples.push(sample);
    assert(sample.outputsEqual, `Provider/worker bytes differ for ${query}.`);
  }
  async compare() {
    const controller = this.app.plugins.getPlugin('obsidian-workspaces')?.controller;
    assert(
      controller &&
        !controller.busy &&
        controller.state.activeId === 'runtime-alpha' &&
        controller.state.journal === null,
      'Start with runtime-alpha active, no recovery journal, and an idle controller.',
    );
    assert(!(await this.raw(['remote'])).trim(), 'Fixture has Git remotes.');
    assert(!(await this.raw(['status', '--porcelain'])).trim(), 'Fixture is dirty.');
    assert(
      (await this.raw(['branch', '--show-current'])).trim() === 'alpha',
      'Fixture is not on alpha.',
    );
    this.worker = new ReadWorker(this.vaultPath);
    this.result.workerStartup = await this.worker.start();
    const providerVersion = (await this.raw(queries.version)).trim();
    const workerVersion = (await this.worker.read('version')).stdout.trim();
    const providerRoot = (await this.raw(queries.root)).trim();
    const workerRoot = (await this.worker.read('root')).stdout.trim();
    this.result.equivalence = { providerVersion, workerVersion, providerRoot, workerRoot };
    assert(
      providerVersion === workerVersion &&
        providerRoot === workerRoot &&
        (await fs.realpath(providerRoot)) === this.vaultPath,
      'Provider and worker Git version/root equivalence failed.',
    );
    await this.writeResult();
    for (let index = 0; index < measuredQueries.length; index++)
      await this.pair(measuredQueries[index], index, 'warmup');
    for (let index = 0; index < 20; index++)
      await this.pair(measuredQueries[index % measuredQueries.length], index, 'measured');
    assert(
      !(await this.raw(['remote'])).trim() &&
        !(await this.raw(['status', '--porcelain'])).trim() &&
        (await this.raw(['branch', '--show-current'])).trim() === 'alpha',
      'Fixture changed during the read-only comparison.',
    );
    assert(
      !controller.busy &&
        controller.state.activeId === 'runtime-alpha' &&
        controller.state.journal === null,
      'Controller state changed during the comparison.',
    );
    this.result.finalCleanAlpha = true;
  }
  async run() {
    this.running = true;
    this.result = {
      status: 'running',
      runId: this.config.runId,
      startedAt: new Date().toISOString(),
      samples: [],
      methodology: {
        diagnosticOnly: true,
        command: 'manual only',
        pairs: 20,
        warmupPairs: 5,
        order:
          'alternating provider-first and worker-first; five fixed query kinds, four measured pairs each',
        queue:
          'one actual Obsidian Git promiseQueue task owns both transports until comparison and worker termination settle',
        timer: 'monotonic performance.now(); 5 ms renderer timer lag observation; no global hooks',
        comparison: 'byte equality outside each timed query; only version/root values are retained',
        worker:
          'persistent node:worker_threads worker, execFile git with fixed read-only argv; startup excluded',
        scope:
          'feasibility experiment only; matching version/root is not production executable/configuration authorization',
      },
    };
    try {
      this.vaultPath = await fs.realpath(this.app.vault.adapter.getBasePath());
      assert(this.vaultPath === this.config.vaultPath, 'Unexpected vault path.');
      assert(
        path.isAbsolute(this.config.resultFile) &&
          !within(this.vaultPath, this.config.resultFile) &&
          !within(this.vaultPath, await fs.realpath(path.dirname(this.config.resultFile))),
        'Report must be outside the vault.',
      );
      this.validatedResultPath = true;
      const marker = JSON.parse(
        await fs.readFile(
          path.join(this.vaultPath, '.obsidian/plugins/workspaces-runtime-probe/data.json'),
          'utf8',
        ),
      );
      assert(
        marker.fixture === 'obsidian-workspaces-native-v1' &&
          marker.vaultPath === this.vaultPath &&
          marker.completedAt,
        'Not a completed disposable runtime fixture.',
      );
      assert(
        JSON.parse(await fs.readFile(marker.resultFile, 'utf8')).status === 'passed',
        'Original fixture did not pass.',
      );
      const plugin = this.app.plugins.getPlugin('obsidian-git');
      assert(
        plugin?.gitReady === true &&
          plugin.manifest.version === '2.43.0' &&
          typeof plugin.promiseQueue?.addTask === 'function' &&
          typeof plugin.gitManager?.git?.raw === 'function',
        'Ready Obsidian Git 2.43.0 is required.',
      );
      this.git = plugin.gitManager.git;
      this.result.environment = {
        obsidian: apiVersion,
        gitPlugin: plugin.manifest.version,
        versions: process.versions,
        platform: process.platform,
        architecture: process.arch,
        rendererHeapUsedBytes: process.memoryUsage().heapUsed,
        probeSHA256: createHash('sha256')
          .update(
            await fs.readFile(
              path.join(this.vaultPath, '.obsidian/plugins', this.manifest.id, 'main.js'),
            ),
          )
          .digest('hex'),
      };
      await this.writeResult();
      const queued = now();
      await new Promise((resolve, reject) => {
        plugin.promiseQueue.addTask(
          async () => {
            this.result.queueWaitMs = now() - queued;
            let failure;
            try {
              await this.compare();
            } catch (error) {
              failure = error;
            }
            try {
              if (this.worker) {
                this.result.workerTermination = await this.worker.stop();
                assert(
                  this.result.workerTermination.exitCode === 0 &&
                    !this.result.workerTermination.forced,
                  'Read worker did not stop cleanly.',
                );
              }
            } catch (error) {
              this.result.terminationError = errorInfo(error);
              failure ??= error;
            }
            return failure ? { ok: false, error: failure } : { ok: true };
          },
          (result) =>
            result?.ok
              ? resolve()
              : reject(result?.error ?? new Error('Provider queue returned no result.')),
        );
      });
      const measured = this.result.samples.filter((sample) => sample.temperature === 'measured');
      this.result.summary = Object.fromEntries(
        ['all', ...measuredQueries].map((query) => {
          const samples =
            query === 'all' ? measured : measured.filter((sample) => sample.query === query);
          return [
            query,
            {
              providerMs: statistics(samples.map((sample) => sample.provider.elapsedMs)),
              workerMs: statistics(samples.map((sample) => sample.worker.elapsedMs)),
              pairedSavingMs: statistics(
                samples.map((sample) => sample.provider.elapsedMs - sample.worker.elapsedMs),
              ),
              providerTimerLagMs: statistics(
                samples.map((sample) => sample.provider.maximumRendererTimerLagMs),
              ),
              workerTimerLagMs: statistics(
                samples.map((sample) => sample.worker.maximumRendererTimerLagMs),
              ),
            },
          ];
        }),
      );
      this.result.status = 'passed';
    } catch (error) {
      this.result.status = 'failed';
      this.result.error = errorInfo(error);
    } finally {
      try {
        if (this.worker) this.result.workerTermination = await this.worker.stop();
      } catch (error) {
        this.result.status = 'failed';
        this.result.terminationError = errorInfo(error);
      }
      this.result.finishedAt = new Date().toISOString();
      try {
        await this.writeResult();
        this.config.completedAt = this.result.finishedAt;
        await this.saveData(this.config);
      } catch (error) {
        console.error('Git transport diagnostic report failed.', error);
      }
      this.running = false;
      if (!this.stopped) new Notice(`Git read transport diagnostic: ${this.result.status}.`);
    }
  }
};
