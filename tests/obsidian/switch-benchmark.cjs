/* Test-only native benchmark; bundled by prepare-switch-benchmark.mjs. */
const { Modal, Notice, TextFileView, TFile, WorkspaceLeaf, apiVersion } = require('obsidian');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const QuickSwitcherProbe = require('./quick-switcher-probe.cjs');
const nativeSession = require('./native-session.cjs');
const reloadProduct = require('./reload-product.cjs');
const { SampleRecorder, memoryObservation } = require('./sample-recorder.cjs');
const {
  captureMeasurementEnvironment,
  assertMeasurementEnvironment,
} = require('./measurement-environment.cjs');
const {
  SCHEMA: ENDPOINT_SCHEMA,
  captureCompletionEndpoint,
  assertCompletionEndpoint,
  fileLeaves,
} = require('./completion-endpoint.cjs');

const clone = (value) => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const errorInfo = (error) => ({ message: error?.message ?? String(error), stack: error?.stack });
const now = () => performance.now();
const round = (value) => Number(value.toFixed(3));
const MAX_TRACE_SPANS = 20_000;
const MAX_TRACE_EVENTS = 10_000;

function statistics(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    p99: round(sorted[Math.ceil(sorted.length * 0.99) - 1]),
    max: round(sorted[sorted.length - 1]),
  };
}

function intervalUnion(intervals) {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [start, nextEnd] of sorted) {
    total += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return total;
}

function referencedPaths(layout) {
  const result = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'leaf' && typeof value.state?.state?.file === 'string')
      result.add(value.state.state.file);
    else for (const child of Object.values(value)) visit(child);
  };
  visit(layout);
  return result;
}

function dataBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value && typeof value.byteLength === 'number') return value.byteLength;
  return null;
}

function safeGitArguments(values) {
  if (!Array.isArray(values)) return undefined;
  const args = values.map(String);
  const allowed = new Set([
    'status',
    'rev-parse',
    'branch',
    'show-ref',
    'check-ref-format',
    'for-each-ref',
    'ls-tree',
    'ls-files',
    'diff',
    'config',
    'checkout',
    '--version',
  ]);
  if (!args.some((value) => allowed.has(value))) return undefined;
  if (
    args.some((value) =>
      /credential|password|token|secret|authorization|extraheader|(?:https?|ssh):\/\//i.test(value),
    )
  )
    return undefined;
  return args;
}

function definingOwner(value, key) {
  for (let owner = value; owner; owner = Object.getPrototypeOf(owner))
    if (Object.hasOwn(owner, key)) return owner;
  return null;
}

module.exports = class SwitchBenchmark extends QuickSwitcherProbe {
  async verify(branch, id, options) {
    const snapshot = await super.verify(branch, id, options);
    assert(
      snapshot.status.git === branch,
      `Obsidian Git's visible branch label did not settle to ${branch}.`,
    );
    for (const [name, content] of Object.entries(this.expectedNotes?.[branch] ?? {})) {
      assert(
        this.app.vault.getAbstractFileByPath(name) instanceof TFile,
        `${name} is not indexed.`,
      );
      assert(
        (await fs.readFile(path.join(this.config.vaultPath, name), 'utf8')) === content,
        `${name} disk content differs from the pinned fixture commit.`,
      );
      const editors = snapshot.views.filter(
        (view) => view.state.type === 'markdown' && view.state.state?.file === name,
      );
      assert(
        editors.length > 0 && editors.every((view) => !view.deferred && view.content === content),
        `${name} native editor differs from the pinned fixture commit.`,
      );
    }
    return snapshot;
  }
  async onload() {
    this.config = await this.loadData();
    if (
      this.config?.fixture !== 'obsidian-workspaces-switch-benchmark-v1' ||
      this.config.completedAt
    )
      return;
    this.stopped = false;
    this.restorers = [];
    this.temporaryIds = [];
    this.activeSample = null;
    this.modalEntries = new WeakMap();
    this.inputBlocks = new WeakMap();
    this.addCommand({
      id: 'run-switch-benchmark',
      name: 'Run switch benchmark',
      callback: () => {
        if (!this.stopped && !this.running) void this.run();
      },
    });
    this.app.workspace.onLayoutReady(() => {
      if (!this.stopped && !this.config.manualStart) void this.run();
    });
  }
  onunload() {
    this.stopped = true;
    this.stopRuntimeTrace(this.activeSample);
    for (const restore of (this.restorers ?? []).splice(0).reverse()) this.diagnostic(restore);
    this.activeSample = null;
  }

  // Restore exact descriptors and avoid replacing a later plugin's wrapper.
  replace(target, key, factory, { register = true } = {}) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const original = Reflect.get(target, key);
    assert(typeof original === 'function', `Cannot instrument ${key}.`);
    const wrapped = factory(original);
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value: wrapped,
    });
    const restore = () => {
      if (Reflect.get(target, key) !== wrapped) return;
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    };
    if (register) this.restorers.push(restore);
    return restore;
  }

  startSpan(sample, name, details = {}) {
    const span = { name, ...details, startMs: now() - sample.clockStart, status: 'running' };
    if (this.config?.deepTrace) {
      const context = this.syncTraceContext;
      sample.nextSpanSequence = (sample.nextSpanSequence ?? 0) + 1;
      span.id = `${sample.index}:${sample.nextSpanSequence}`;
      span.parentId = context?.sample === sample ? context.span.id : null;
      span.parentContext = context?.sample === sample ? 'synchronous-only' : 'unattributed';
      if (sample.spans.length >= MAX_TRACE_SPANS) {
        sample.deepTrace.droppedSpans = (sample.deepTrace.droppedSpans ?? 0) + 1;
        span.recorded = false;
        return span;
      }
      if (!span.parentId && sample.liveSpans) {
        span.unfinishedMethodIds = [...sample.liveSpans.values()]
          .filter((value) =>
            /^(host\.|store\.|repository\.|controller\.(commit|transition)|provider\.|git\.withRepository)/.test(
              value.name,
            ),
          )
          .slice(-8)
          .map((value) => value.id);
        span.unfinishedMethodIdsMeaning = 'temporal overlap only; not proven causal ancestry';
      }
      sample.liveSpans?.set(span.id, span);
    }
    sample.spans.push(span);
    if (this.config?.deepTrace && this.traceCheckpointFile) {
      const boundary = [
        'git.withRepository',
        'store.save',
        'host.quiesce',
        'host.waitForFiles',
        'host.restore',
      ].includes(name);
      const firstProcess = name === 'process.spawn' && !sample.deepTrace.firstProcessCheckpointed;
      if (firstProcess) sample.deepTrace.firstProcessCheckpointed = true;
      if (boundary || firstProcess) void this.writeTraceCheckpoint(`entered:${name}`, sample);
    }
    return span;
  }
  invokeSpan(sample, span, original, receiver, args) {
    if (!this.config?.deepTrace) return Reflect.apply(original, receiver, args);
    const context = { sample, span };
    const started = now();
    try {
      const previous = this.syncTraceContext;
      this.syncTraceContext = context;
      try {
        return Reflect.apply(original, receiver, args);
      } finally {
        this.syncTraceContext = previous;
      }
    } finally {
      span.synchronousCallMs = now() - started;
      span.returnedMs = now() - sample.clockStart;
    }
  }
  finishSpan(sample, span, error) {
    if (span.status !== 'running') return;
    span.endMs = now() - sample.clockStart;
    span.durationMs = span.endMs - span.startMs;
    span.status = error ? 'rejected' : 'fulfilled';
    sample.liveSpans?.delete(span.id);
    if (error) span.error = errorInfo(error);
  }
  observeResult(sample, span, returned, settled) {
    // Attach observers without replacing the original promise or return value.
    if (returned && typeof returned.then === 'function') {
      const observation = Promise.resolve(returned).then(
        (value) => {
          this.finishSpan(sample, span);
          if (settled) {
            if (this.config?.deepTrace) this.diagnostic(() => settled(undefined, value), sample);
            else settled(undefined, value);
          }
        },
        (error) => {
          this.finishSpan(sample, span, error);
          if (settled) {
            if (this.config?.deepTrace) this.diagnostic(() => settled(error), sample);
            else settled(error);
          }
        },
      );
      Object.defineProperty(span, 'observation', { value: observation });
    } else {
      this.finishSpan(sample, span);
      if (settled) {
        if (this.config?.deepTrace) this.diagnostic(() => settled(undefined, returned), sample);
        else settled(undefined, returned);
      }
    }
    return returned;
  }
  instrument(target, key, name, describe = () => ({}), observed, options) {
    const probe = this;
    return this.replace(
      target,
      key,
      (original) =>
        function (...args) {
          const sample = probe.activeSample;
          if (
            !sample ||
            (name.startsWith('fs.') &&
              (args[0] === probe.traceCheckpointFile ||
                args[0] === `${probe.traceCheckpointFile}.tmp`))
          )
            return Reflect.apply(original, this, args);
          const span = probe.startSpan(sample, name, describe(args, this));
          try {
            return probe.observeResult(
              sample,
              span,
              probe.invokeSpan(sample, span, original, this, args),
              observed
                ? (error, value) => {
                    if (!error) probe.diagnostic(() => observed(span, value, args, this), sample);
                  }
                : undefined,
            );
          } catch (error) {
            probe.finishSpan(sample, span, error);
            throw error;
          }
        },
      options,
    );
  }

  completionEndpoint(sample) {
    return captureCompletionEndpoint({
      now: () => now() - sample.clockStart,
      read: () => {
        const state = this.controller.state;
        const views = this.leaves().map((leaf) => ({
          id: leaf.id ?? null,
          state: clone(leaf.getViewState()),
          deferred: !!leaf.isDeferred,
          content: leaf.view instanceof TextFileView ? leaf.view.getViewData() : null,
        }));
        const blocks = sample.spans
          .filter((span) => span.name === 'host.blockInteraction')
          .map((span) => ({
            startMs: span.startMs,
            endMs: span.endMs ?? null,
            status: span.status,
            listenerCount: span.listenerCount ?? null,
            observedDocuments: span.observedDocuments ?? [],
          }));
        const watched = new Set([
          ...referencedPaths(sample.sourceLayout),
          ...referencedPaths(sample.endpointExpected.layout),
          ...Object.keys(this.expectedNotes.alpha),
          ...Object.keys(this.expectedNotes.beta),
        ]);
        return {
          controllerCompleteMs: sample.controllerCompleteMs,
          activeId: state.activeId,
          revision: state.revision,
          journal: state.journal,
          busy: this.controller.busy,
          layout: this.app.workspace.getLayout(),
          activeFile: this.app.workspace.getActiveFile()?.path ?? null,
          activeView: views.find((view) => view.id === this.app.workspace.activeLeaf?.id) ?? null,
          views,
          status: this.statusText(),
          indexed: Object.fromEntries(
            [...watched].map((name) => [
              name,
              this.app.vault.getAbstractFileByPath(name) instanceof TFile,
            ]),
          ),
          input: {
            released:
              blocks.length === 1 &&
              blocks.every((block) => block.status === 'fulfilled' && block.listenerCount === 0),
            blocks,
          },
        };
      },
    });
  }

  installInstrumentation() {
    const probe = this;
    for (const key of ['activate', 'saveAndActivate']) {
      this.replace(
        this.controller,
        key,
        (original) =>
          function (...args) {
            const sample = probe.activeSample;
            if (!sample) return Reflect.apply(original, this, args);
            const span = probe.startSpan(sample, `controller.${key}`, { workspaceId: args[0] });
            sample.controllerCalls.push(span);
            try {
              return probe.observeResult(
                sample,
                span,
                probe.invokeSpan(sample, span, original, this, args),
                (error) => {
                  sample.controllerCompleteMs = span.endMs;
                  if (error) sample.controllerError = errorInfo(error);
                  // This observer was attached before the original promise was
                  // returned to Q++. Capture without awaiting a frame, Git read,
                  // file read or verifier: later hydration cannot repair it.
                  try {
                    sample.completionEndpoint = probe.completionEndpoint(sample);
                  } catch (cause) {
                    sample.completionCaptureError = errorInfo(cause);
                  }
                },
              );
            } catch (error) {
              probe.finishSpan(sample, span, error);
              throw error;
            }
          },
      );
    }
    for (const key of [
      'flush',
      'assertCanQuiesce',
      'quiesce',
      'waitForFiles',
      'restore',
      'capture',
      'confirmDiscard',
    ]) {
      if (typeof this.controller.host[key] === 'function')
        this.instrument(this.controller.host, key, `host.${key}`);
    }
    for (const key of ['save', 'assertOutsideRepository', 'ensureOutsideRepo']) {
      if (typeof this.controller.store[key] === 'function')
        this.instrument(this.controller.store, key, `store.${key}`);
    }
    for (const key of ['validateStore', 'ensureOutsideRepo']) {
      if (typeof this.controller[key] === 'function')
        this.instrument(this.controller, key, `controller.${key}`);
    }
    this.replace(
      this.controller.host,
      'block',
      (original) =>
        function (...args) {
          const sample = probe.activeSample;
          if (!sample) return Reflect.apply(original, this, args);
          const span = probe.startSpan(sample, 'host.block');
          const previous = probe.installingBlock;
          probe.installingBlock = { sample, span };
          try {
            return probe.observeResult(
              sample,
              span,
              probe.invokeSpan(sample, span, original, this, args),
            );
          } catch (error) {
            probe.finishSpan(sample, span, error);
            throw error;
          } finally {
            probe.installingBlock = previous;
          }
        },
    );
    // Observe removal of the original input guard; never replace its release callback.
    const documents = new Set();
    let documentIndex = 0;
    const observeDocument = (document) => {
      if (documents.has(document)) return;
      documents.add(document);
      const documentId = documentIndex++;
      this.replace(
        document,
        'addEventListener',
        (original) =>
          function (...args) {
            const returned = Reflect.apply(original, this, args);
            const installing = probe.installingBlock;
            const existing = typeof args[1] === 'function' && probe.inputBlocks.get(args[1]);
            if (
              (installing || existing) &&
              [
                'keydown',
                'beforeinput',
                'pointerdown',
                'click',
                'dblclick',
                'auxclick',
                'contextmenu',
                'drop',
                'paste',
              ].includes(args[0]) &&
              typeof args[1] === 'function'
            ) {
              let block = probe.inputBlocks.get(args[1]);
              if (!block) {
                block = {
                  sample: installing.sample,
                  span: probe.startSpan(installing.sample, 'host.blockInteraction'),
                  listeners: new Set(),
                };
                probe.inputBlocks.set(args[1], block);
              }
              block.listeners.add(`${documentId}:${args[0]}`);
              block.span.listenerCount = block.listeners.size;
              block.span.observedDocuments = [
                ...new Set([...block.listeners].map((value) => value.split(':')[0])),
              ];
            }
            return returned;
          },
      );
      this.replace(
        document,
        'removeEventListener',
        (original) =>
          function (...args) {
            const returned = Reflect.apply(original, this, args);
            const block = typeof args[1] === 'function' && probe.inputBlocks.get(args[1]);
            if (block) {
              block.listeners.delete(`${documentId}:${args[0]}`);
              block.span.listenerCount = block.listeners.size;
              if (!block.listeners.size) probe.finishSpan(block.sample, block.span);
            }
            return returned;
          },
      );
    };
    for (const leaf of this.leaves()) observeDocument(leaf.view.containerEl.ownerDocument);
    observeDocument(this.app.workspace.containerEl.ownerDocument);
    const windowObservation = this.app.workspace.on('window-open', (_workspaceWindow, window) =>
      observeDocument(window.document),
    );
    this.restorers.push(() => this.app.workspace.offref(windowObservation));

    this.replace(
      this.controller.git,
      'withRepository',
      (original) =>
        function (operation, ...rest) {
          const sample = probe.activeSample;
          if (!sample) return Reflect.apply(original, this, [operation, ...rest]);
          const span = probe.startSpan(sample, 'git.withRepository');
          const call = { span };
          sample.repositoryCalls.push(call);
          const callback = function (repository, ...args) {
            span.callbackEntryMs = now() - sample.clockStart;
            span.waitForCallbackMs = span.callbackEntryMs - span.startMs;
            // Classify the queue task actually executing this callback. Matching the
            // next enqueue would misattribute an unrelated background task that ran
            // while the adapter awaited its native module imports.
            const queueSpan = sample.spans.findLast(
              (candidate) =>
                candidate.name === 'git.queueTask' &&
                candidate.status === 'running' &&
                candidate.taskStartMs !== undefined,
            );
            if (queueSpan) {
              queueSpan.owner = 'withRepository';
              if (probe.config.deepTrace) {
                queueSpan.repositorySpanId = span.id;
                queueSpan.parentId = span.id;
                queueSpan.parentContext = 'repository-callback-observed-in-queue-task';
              }
              span.queueWaitMs = queueSpan.queueWaitMs;
              span.queueTaskStartMs = queueSpan.taskStartMs;
            }
            for (const key of [
              'inspect',
              'inspectIdentity',
              'assertCanSwitch',
              'prepareSwitch',
              'checkout',
              'refreshPresentation',
            ]) {
              if (typeof repository[key] === 'function')
                sample.repositoryRestorers.push(
                  probe.instrument(
                    repository,
                    key,
                    `repository.${key}`,
                    (values) =>
                      ['checkout', 'assertCanSwitch', 'prepareSwitch'].includes(key)
                        ? { branch: values[0] }
                        : {},
                    undefined,
                    { register: false },
                  ),
                );
            }
            if (probe.config.deepTrace) {
              for (const key of ['raw', 'canonicalRoot', 'assertRuntimeFilesStable'])
                if (typeof repository[key] === 'function')
                  sample.repositoryRestorers.push(
                    probe.instrument(
                      repository,
                      key,
                      `repository.${key}`,
                      (values) => ({
                        argument: typeof values[0] === 'string' ? values[0] : undefined,
                      }),
                      undefined,
                      { register: false },
                    ),
                  );
            }
            return Reflect.apply(operation, this, [repository, ...args]);
          };
          try {
            return probe.observeResult(
              sample,
              span,
              probe.invokeSpan(sample, span, original, this, [callback, ...rest]),
            );
          } catch (error) {
            probe.finishSpan(sample, span, error);
            throw error;
          }
        },
    );
    this.replace(
      this.gitPlugin.promiseQueue,
      'addTask',
      (original) =>
        function (task, callback, ...rest) {
          const sample = probe.activeSample;
          if (!sample) return Reflect.apply(original, this, [task, callback, ...rest]);
          const span = probe.startSpan(sample, 'git.queueTask', {
            owner: 'provider-or-background',
          });
          const wrappedTask = function (...args) {
            span.taskStartMs = now() - sample.clockStart;
            span.queueWaitMs = span.taskStartMs - span.startMs;
            try {
              return probe.observeResult(
                sample,
                span,
                probe.invokeSpan(sample, span, task, this, args),
              );
            } catch (error) {
              probe.finishSpan(sample, span, error);
              throw error;
            }
          };
          try {
            return Reflect.apply(original, this, [wrappedTask, callback, ...rest]);
          } catch (error) {
            probe.finishSpan(sample, span, error);
            throw error;
          }
        },
    );
    this.instrument(this.gitPlugin.gitManager.git, 'raw', 'git.raw', (args) => ({
      command: safeGitArguments(args[0]),
    }));
    this.instrument(this.gitPlugin.gitManager, 'checkout', 'provider.checkout', (args) => ({
      branch: args[0],
    }));
    for (const key of ['display']) {
      if (typeof this.gitPlugin.branchBar?.[key] === 'function')
        this.instrument(this.gitPlugin.branchBar, key, `provider.branchBar.${key}`);
    }
    const workspace = this.app.workspace;
    this.replace(
      workspace,
      'trigger',
      (original) =>
        function (...args) {
          const sample = probe.activeSample;
          if (!sample || args[0] !== 'obsidian-git:refresh')
            return Reflect.apply(original, this, args);
          const span = probe.startSpan(sample, 'provider.refreshEvent');
          try {
            return probe.observeResult(
              sample,
              span,
              probe.invokeSpan(sample, span, original, this, args),
            );
          } catch (error) {
            probe.finishSpan(sample, span, error);
            throw error;
          }
        },
    );
    const definition = this.switcher.commandDefinitions.find(
      (item) => item.commandId === 'switcher-plus:open-workspaces',
    );
    assert(definition?.handlerClass?.prototype, 'The native Q++ workspace handler is unavailable.');
    for (const key of ['getSuggestions', 'onChooseSuggestion'])
      this.instrument(definition.handlerClass.prototype, key, `quickSwitcher.${key}`);

    this.replace(
      Modal.prototype,
      'open',
      (original) =>
        function (...args) {
          const sample = probe.activeSample;
          const openedMs = sample ? now() - sample.clockStart : null;
          const returned = Reflect.apply(original, this, args);
          if (sample) {
            const entry = {
              openedMs,
              kind: this.modalEl?.classList.contains('workspaces-progress')
                ? 'transition-progress'
                : 'other',
              title: this.titleEl?.textContent ?? '',
              className: this.modalEl?.className ?? '',
              connectedAtOpen: !!this.containerEl?.isConnected,
              visibleAtFrameOpportunity: false,
            };
            sample.modals.push(entry);
            probe.modalEntries.set(this, { sample, entry });
            requestAnimationFrame(() => {
              if (this.containerEl?.isConnected) {
                entry.visibleAtFrameOpportunity = true;
                entry.frameOpportunityMs = now() - sample.clockStart;
              }
            });
          }
          return returned;
        },
    );
    this.replace(
      Modal.prototype,
      'close',
      (original) =>
        function (...args) {
          const returned = Reflect.apply(original, this, args);
          const tracked = probe.modalEntries.get(this);
          if (tracked && tracked.entry.closedMs === undefined) {
            tracked.entry.closedMs = now() - tracked.sample.clockStart;
            tracked.entry.durationMs = tracked.entry.closedMs - tracked.entry.openedMs;
          }
          return returned;
        },
    );
  }

  diagnostic(action, sample = this.activeSample) {
    try {
      return action();
    } catch (error) {
      const destination = sample?.deepTrace ?? this.result?.deepTrace;
      if (destination) {
        destination.errors ??= [];
        if (destination.errors.length < 100) destination.errors.push(errorInfo(error));
      }
      return undefined;
    }
  }
  recordTraceEvent(sample, event) {
    if (sample.deepTrace.events.length < MAX_TRACE_EVENTS) sample.deepTrace.events.push(event);
    else sample.deepTrace.droppedEvents = (sample.deepTrace.droppedEvents ?? 0) + 1;
  }
  async writeTraceCheckpoint(stage, sample = this.activeSample, wait = false) {
    if (!this.traceCheckpointFile) return;
    if (this.traceCheckpointPending) {
      if (!wait) return;
      await this.traceCheckpointPending;
    }
    const current = this.controller?.current;
    const checkpoint = {
      kind: 'diagnostic-progress-only',
      runId: this.config.runId,
      phase: this.config.phase,
      stage,
      at: new Date().toISOString(),
      productBundleSHA256: this.result.environment?.plugins?.['obsidian-workspaces']?.bundleSHA256,
      sample: sample
        ? {
            index: sample.index,
            scenario: sample.scenario,
            temperature: sample.temperature,
            status: sample.status,
            elapsedMs: sample.clockStart === undefined ? null : now() - sample.clockStart,
            spans: sample.spans.length,
            events: sample.deepTrace.events.length,
            droppedSpans: sample.deepTrace.droppedSpans ?? 0,
            droppedEvents: sample.deepTrace.droppedEvents ?? 0,
          }
        : null,
      controller: current
        ? {
            activeId: current.activeId,
            phase: current.journal?.phase ?? null,
            revision: current.revision,
            operation: this.controller.operation,
          }
        : null,
      recentSpans:
        sample?.spans.slice(-16).map(({ id, name, startMs, endMs, status, file, pid }) => ({
          id,
          name,
          startMs,
          endMs,
          status,
          file,
          pid,
        })) ?? [],
      unfinished: sample?.liveSpans
        ? [...sample.liveSpans.values()]
            .slice(-20)
            .map(({ id, name, startMs }) => ({ id, name, startMs }))
        : [],
      recentEvents: sample?.deepTrace.events.slice(-6) ?? [],
    };
    const io = this.traceCheckpointIo;
    const pending = (async () => {
      try {
        await Reflect.apply(io.writeFile, fs, [
          `${this.traceCheckpointFile}.tmp`,
          JSON.stringify(checkpoint, null, 2),
        ]);
        await Reflect.apply(io.rename, fs, [
          `${this.traceCheckpointFile}.tmp`,
          this.traceCheckpointFile,
        ]);
      } catch (error) {
        this.diagnostic(() => {
          throw error;
        }, sample);
      }
    })();
    this.traceCheckpointPending = pending;
    try {
      await pending;
    } finally {
      if (this.traceCheckpointPending === pending) this.traceCheckpointPending = null;
    }
  }
  scopedReplace(target, key, factory, cleanups) {
    const restore = this.replace(target, key, factory, { register: false });
    const release = () => {
      restore();
      this.deepPendingRestorers.delete(release);
    };
    this.deepPendingRestorers.add(release);
    cleanups.push(release);
    return release;
  }
  pathLabel(value) {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
    if (value && typeof value.href === 'string') return value.href;
    return typeof value === 'number' ? `fd:${value}` : null;
  }
  fileScope(file) {
    if (!file) return 'unknown';
    const control = path.dirname(this.controller.storageLocation ?? '/missing-control-store');
    if (file === control || file.startsWith(`${control}${path.sep}`)) return 'control-store';
    if (file === this.config.vaultPath || file.startsWith(`${this.config.vaultPath}${path.sep}`))
      return 'vault';
    return 'other';
  }
  relevantPath(sample, file) {
    if (typeof file !== 'string') return false;
    let relative = file;
    if (file.startsWith(`${this.config.vaultPath}${path.sep}`))
      relative = path.relative(this.config.vaultPath, file);
    relative = relative.replaceAll('\\', '/').replace(/^\/+/, '');
    return [...sample.watchedPaths].some(
      (watched) => relative === watched || watched.startsWith(`${relative}/`),
    );
  }
  traceFileHandle(handle, file) {
    if (file === this.traceCheckpointFile || file === `${this.traceCheckpointFile}.tmp`) return;
    if (!handle || this.tracedHandles.has(handle)) return;
    this.tracedHandles.add(handle);
    const cleanups = [];
    const handleId = ++this.handleSequence;
    const probe = this;
    for (const method of ['writeFile', 'write', 'readFile', 'sync', 'datasync', 'close']) {
      if (typeof handle[method] !== 'function') continue;
      this.scopedReplace(
        handle,
        method,
        (original) =>
          function (...args) {
            const sample = probe.activeSample;
            if (!sample) return Reflect.apply(original, this, args);
            const span = probe.startSpan(sample, `fs.handle.${method}`, {
              handleId,
              file,
              scope: probe.fileScope(file),
              fd: this.fd,
              bytes: method.startsWith('write') ? dataBytes(args[0]) : undefined,
            });
            try {
              return probe.observeResult(
                sample,
                span,
                probe.invokeSpan(sample, span, original, this, args),
                () => {
                  if (method === 'close')
                    for (const release of cleanups.splice(0).reverse()) release();
                },
              );
            } catch (error) {
              probe.finishSpan(sample, span, error);
              throw error;
            }
          },
        cleanups,
      );
    }
  }
  installFileSystemTrace() {
    const probe = this;
    this.tracedHandles = new WeakSet();
    this.handleSequence = 0;
    this.result.deepTrace.capabilities.fsPromises = [];
    for (const method of [
      'mkdir',
      'open',
      'readFile',
      'writeFile',
      'copyFile',
      'rename',
      'unlink',
      'rm',
      'realpath',
      'access',
      'stat',
      'lstat',
      'readdir',
    ]) {
      if (typeof fs[method] !== 'function') continue;
      this.instrument(
        fs,
        method,
        `fs.${method}`,
        (args) => {
          const file = probe.pathLabel(args[0]);
          return {
            file,
            scope: probe.fileScope(file),
            destination: ['copyFile', 'rename'].includes(method)
              ? probe.pathLabel(args[1])
              : undefined,
            flags: method === 'open' ? args[1] : undefined,
            bytes: method === 'writeFile' ? dataBytes(args[1]) : undefined,
          };
        },
        (span, value) => {
          if (method === 'open') probe.traceFileHandle(value, span.file);
          if (method === 'readFile') span.bytes = dataBytes(value);
          if (method === 'stat' || method === 'lstat')
            span.stat = value
              ? { size: value.size, mtimeMs: value.mtimeMs, mode: value.mode }
              : null;
        },
      );
      this.result.deepTrace.capabilities.fsPromises.push(method);
    }
  }
  correlateProcess(sample, processSpan) {
    const isGit = /(^|[/\\])git(?:\.exe)?$/.test(processSpan.executable ?? '');
    processSpan.isGit = isGit;
    if (!isGit) return;
    const args = processSpan.arguments ?? [];
    const matches = (command) =>
      Array.isArray(command) &&
      command.length <= args.length &&
      command.every((value, index) => String(value) === args[args.length - command.length + index]);
    const candidates = sample.spans.filter(
      (span) =>
        span.name === 'git.raw' &&
        span.status === 'running' &&
        !span.processSpanId &&
        matches(span.command),
    );
    processSpan.rawCandidateIds = candidates.map((span) => span.id);
    let ancestor = sample.spans.find((span) => span.id === processSpan.parentId);
    const visited = new Set();
    while (
      ancestor &&
      ancestor.name !== 'git.raw' &&
      !visited.has(ancestor.id) &&
      visited.size < 64
    ) {
      visited.add(ancestor.id);
      ancestor = sample.spans.find((span) => span.id === ancestor.parentId);
    }
    if (ancestor && ancestor.name !== 'git.raw') {
      processSpan.ancestryTraversalStopped = visited.has(ancestor.id) ? 'cycle' : 'depth-limit';
      ancestor = null;
    }
    const matched =
      ancestor && candidates.includes(ancestor)
        ? ancestor
        : candidates.length === 1
          ? candidates[0]
          : null;
    if (matched) {
      processSpan.rawSpanId = matched.id;
      processSpan.rawCorrelation =
        matched === ancestor
          ? 'synchronous-ancestor-and-command'
          : 'unique-pending-command-inference';
      matched.processSpanId = processSpan.id;
    } else if (args.includes('checkout')) {
      const checkout = sample.spans.findLast(
        (span) => span.name === 'provider.checkout' && span.status === 'running',
      );
      if (checkout) {
        processSpan.checkoutSpanId = checkout.id;
        processSpan.rawCorrelation = 'active-provider-checkout-inference';
      }
    }
  }
  installProcessTrace() {
    const childProcess = require('node:child_process');
    const probe = this;
    this.replace(
      childProcess,
      'spawn',
      (original) =>
        function (...args) {
          const sample = probe.activeSample;
          if (!sample) return Reflect.apply(original, this, args);
          if (typeof args[0] !== 'string') return Reflect.apply(original, this, args);
          const executable = args[0];
          const isGit = /(^|[/\\])git(?:\.exe)?$/.test(executable);
          if (!isGit) return Reflect.apply(original, this, args);
          const options = Array.isArray(args[1]) ? args[2] : args[1];
          const span = probe.startSpan(sample, 'process.spawn', {
            executable,
            arguments: isGit ? safeGitArguments(args[1]) : undefined,
            argumentCount: Array.isArray(args[1]) ? args[1].length : 0,
            cwd: typeof options?.cwd === 'string' ? options.cwd : null,
            streams: {},
          });
          let child;
          try {
            child = probe.invokeSpan(sample, span, original, this, args);
          } catch (error) {
            probe.finishSpan(sample, span, error);
            throw error;
          }
          span.spawnReturnMs = now() - sample.clockStart;
          span.spawnSynchronousMs = span.synchronousCallMs;
          span.pid = child.pid ?? null;
          probe.diagnostic(() => {
            probe.correlateProcess(sample, span);
            const cleanups = [];
            probe.scopedReplace(
              child,
              'emit',
              (emit) =>
                function (event, ...values) {
                  probe.diagnostic(() => {
                    const atMs = now() - sample.clockStart;
                    if (event === 'spawn') span.spawnEventMs = atMs;
                    if (event === 'exit')
                      Object.assign(span, {
                        exitMs: atMs,
                        exitCode: values[0],
                        exitSignal: values[1],
                      });
                    if (event === 'error') span.processError = errorInfo(values[0]);
                    if (event === 'close') {
                      Object.assign(span, {
                        closeMs: atMs,
                        closeCode: values[0],
                        closeSignal: values[1],
                      });
                      probe.finishSpan(
                        sample,
                        span,
                        span.processError ? new Error(span.processError.message) : undefined,
                      );
                    }
                  }, sample);
                  try {
                    return Reflect.apply(emit, this, [event, ...values]);
                  } finally {
                    if (event === 'close')
                      for (const release of cleanups.splice(0).reverse())
                        probe.diagnostic(release, sample);
                  }
                },
              cleanups,
            );
            for (const key of ['stdout', 'stderr']) {
              const stream = child[key];
              if (!stream || typeof stream.emit !== 'function') continue;
              const stats = {
                bytes: 0,
                chunks: 0,
                flowingWhenObserved: stream.readableFlowing,
                byteAccounting: 'Buffer byte lengths; string chunks estimated as UTF-8',
              };
              span.streams[key] = stats;
              // Observe existing emissions. Adding a data listener would start flow;
              // adding an error listener would change unhandled-error semantics.
              probe.scopedReplace(
                stream,
                'emit',
                (emit) =>
                  function (event, ...values) {
                    probe.diagnostic(() => {
                      const atMs = now() - sample.clockStart;
                      if (event === 'data') {
                        stats.firstDataMs ??= atMs;
                        stats.lastDataMs = atMs;
                        stats.chunks += 1;
                        stats.bytes += dataBytes(values[0]) ?? 0;
                      }
                      if (event === 'end' || event === 'close') stats[`${event}Ms`] = atMs;
                    }, sample);
                    return Reflect.apply(emit, this, [event, ...values]);
                  },
                cleanups,
              );
            }
          }, sample);
          return child;
        },
    );
  }
  installNativeTrace() {
    const probe = this;
    const capabilities = this.result.deepTrace.capabilities;
    const instrumentOnce = (object, method, name, describe, observed) => {
      if (!object || typeof object[method] !== 'function') return false;
      let names = this.deepWrappedTargets.get(object);
      if (!names) this.deepWrappedTargets.set(object, (names = new Set()));
      if (!names.has(method)) {
        names.add(method);
        this.instrument(object, method, name, describe, observed);
      }
      return true;
    };
    const workspace = this.app.workspace;
    capabilities.workspace = {};
    for (const method of [
      'changeLayout',
      'clearLayout',
      'setLayout',
      'deserializeLayout',
      'getLayout',
    ])
      capabilities.workspace[method] = instrumentOnce(
        workspace,
        method,
        `workspace.${method}`,
        (args) => ({ nodeType: args[0]?.type, nodeId: args[0]?.id }),
        method === 'getLayout'
          ? (span, value) => {
              // Diagnostic-only evidence for an incremental restore that later
              // falls back; the final endpoint would hide the intermediate cause.
              span.layoutSnapshot = clone(value);
            }
          : undefined,
      );
    const leafDetails = (args, leaf) => ({
      leafId: leaf.id ?? null,
      file: leaf.view?.file?.path ?? null,
      deferred: !!leaf.isDeferred,
      targetType: args[0]?.type,
      targetFile: args[0]?.state?.file,
    });
    const leafPrototypes = new Set(
      [
        WorkspaceLeaf?.prototype,
        ...this.leaves().map((leaf) => Object.getPrototypeOf(leaf)),
      ].filter(Boolean),
    );
    capabilities.leaf = {};
    for (const method of ['setViewState', 'loadIfDeferred', 'open', 'openFile']) {
      capabilities.leaf[method] = false;
      for (const prototype of leafPrototypes) {
        const owner = definingOwner(prototype, method);
        if (owner && instrumentOnce(owner, method, `leaf.${method}`, leafDetails))
          capabilities.leaf[method] = true;
      }
    }
    const views = [
      TextFileView?.prototype,
      ...this.leaves()
        .filter((leaf) => leaf.view instanceof TextFileView)
        .map((leaf) => Object.getPrototypeOf(leaf.view)),
    ].filter(Boolean);
    capabilities.textSave = false;
    for (const value of views) {
      const owner = definingOwner(value, 'save');
      if (
        owner &&
        instrumentOnce(owner, 'save', 'view.save', (args, view) => ({
          file: view.file?.path ?? null,
        }))
      )
        capabilities.textSave = true;
    }
    const adapter = this.app.vault.adapter;
    capabilities.adapter = {};
    const readResult = (span, value) => {
      if (typeof value === 'string') {
        span.bytes = dataBytes(value);
        const sample = this.activeSample;
        const kind = span.name === 'vault.cachedRead' ? 'cached' : 'disk';
        if (sample?.textObservations && typeof span.file === 'string') {
          const previous = sample.textObservations.get(span.file) ?? {};
          const other = previous[kind === 'cached' ? 'disk' : 'cached'];
          if (other) {
            span.comparedReadSpanId = other.spanId;
            span.sameBytesAsLatestOtherRead = value === other.value;
          }
          previous[kind] = { value, spanId: span.id };
          sample.textObservations.set(span.file, previous);
        }
      } else if (typeof value === 'boolean') span.result = value;
      else if (value && typeof value === 'object')
        span.stat = { type: value.type, size: value.size, mtime: value.mtime };
      else if (value === null) span.result = null;
    };
    for (const method of ['exists', 'stat', 'read', 'readBinary'])
      capabilities.adapter[method] = instrumentOnce(
        adapter,
        method,
        `adapter.${method}`,
        (args) => ({ file: args[0] }),
        readResult,
      );
    instrumentOnce(
      this.app.vault,
      'cachedRead',
      'vault.cachedRead',
      (args) => ({ file: args[0]?.path }),
      readResult,
    );
    instrumentOnce(
      this.app.vault,
      'getAbstractFileByPath',
      'vault.getAbstractFileByPath',
      (args) => ({ file: args[0] }),
      (span, value) => {
        span.indexed = !!value;
        span.kind = value?.constructor?.name ?? null;
      },
    );
    for (const method of [
      'onFileChange',
      'reconcileFile',
      'reconcileInternalFile',
      'reconcileDeletion',
      'reconcileFileInternal',
      'removeFile',
      'update',
    ]) {
      capabilities.adapter[method] = typeof adapter[method] === 'function';
      if (!capabilities.adapter[method]) continue;
      this.replace(
        adapter,
        method,
        (original) =>
          function (...args) {
            const sample = probe.activeSample;
            if (!sample || !args.some((value) => probe.relevantPath(sample, value)))
              return Reflect.apply(original, this, args);
            const span = probe.startSpan(sample, `adapter.${method}`, {
              file: args[0],
              normalizedPath: typeof args[1] === 'string' ? args[1] : undefined,
              immediate: typeof args[2] === 'boolean' ? args[2] : undefined,
            });
            try {
              return probe.observeResult(
                sample,
                span,
                probe.invokeSpan(sample, span, original, this, args),
              );
            } catch (error) {
              probe.finishSpan(sample, span, error);
              throw error;
            }
          },
      );
    }
    capabilities.adapter.queue = typeof adapter.queue === 'function';
    if (capabilities.adapter.queue)
      this.replace(
        adapter,
        'queue',
        (original) =>
          function (operation, ...rest) {
            const sample = probe.activeSample;
            const context = probe.syncTraceContext;
            if (!sample || typeof operation !== 'function' || context?.sample !== sample)
              return Reflect.apply(original, this, [operation, ...rest]);
            const span = probe.startSpan(sample, 'adapter.queue');
            const wrapped = function (...args) {
              span.taskStartMs = now() - sample.clockStart;
              span.queueWaitMs = span.taskStartMs - span.startMs;
              const taskSpan = probe.startSpan(sample, 'adapter.queueTask', {
                queueSpanId: span.id,
              });
              taskSpan.parentId = span.id;
              taskSpan.parentContext = 'queued-callback';
              try {
                return probe.observeResult(
                  sample,
                  taskSpan,
                  probe.invokeSpan(sample, taskSpan, operation, this, args),
                );
              } catch (error) {
                probe.finishSpan(sample, taskSpan, error);
                throw error;
              }
            };
            try {
              return probe.observeResult(
                sample,
                span,
                probe.invokeSpan(sample, span, original, this, [wrapped, ...rest]),
              );
            } catch (error) {
              probe.finishSpan(sample, span, error);
              throw error;
            }
          },
      );
    for (const event of ['create', 'modify', 'delete', 'rename']) {
      const ref = this.app.vault.on(event, (file, oldPath) => {
        const sample = this.activeSample;
        if (
          !sample ||
          (!this.relevantPath(sample, file?.path) && !this.relevantPath(sample, oldPath))
        )
          return;
        const context = this.syncTraceContext;
        this.recordTraceEvent(sample, {
          type: `vault.${event}`,
          atMs: now() - sample.clockStart,
          file: file?.path,
          oldPath,
          parentId: context?.sample === sample ? context.span.id : null,
        });
      });
      this.restorers.push(() => this.app.vault.offref(ref));
    }
    for (const method of ['commit', 'emit', 'setTransitionPhase', 'transition', 'observeSource']) {
      if (typeof this.controller[method] === 'function')
        this.instrument(this.controller, method, `controller.${method}`, (args) =>
          method === 'commit'
            ? {
                incomingRevision: args[0]?.revision,
                journalPhase: args[0]?.journal?.phase ?? null,
                activeId: args[0]?.activeId,
                catalogSize: args[0]?.order?.length,
              }
            : {},
        );
    }
    const owner = definingOwner(this.controller, 'state');
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'state');
    capabilities.controllerStateGetter = !!descriptor?.get;
    if (descriptor?.get) {
      const getter = descriptor.get;
      const wrapped = function () {
        const sample = probe.activeSample;
        if (!sample || this !== probe.controller) return Reflect.apply(getter, this, []);
        const span = probe.startSpan(sample, 'controller.state.get');
        try {
          return probe.observeResult(
            sample,
            span,
            probe.invokeSpan(sample, span, getter, this, []),
          );
        } catch (error) {
          probe.finishSpan(sample, span, error);
          throw error;
        }
      };
      Object.defineProperty(owner, 'state', { ...descriptor, get: wrapped });
      this.restorers.push(() => {
        if (Object.getOwnPropertyDescriptor(owner, 'state')?.get === wrapped)
          Object.defineProperty(owner, 'state', descriptor);
      });
    }
    capabilities.globalStructuredClone = false;
    capabilities.globalTimers = false;
  }

  async installDeepTrace() {
    if (!this.config.deepTrace) return;
    this.result.deepTrace = {
      enabled: true,
      cpuProfileRequested: !!this.config.cpuProfile,
      capabilities: {},
      errors: [],
      semantics: {
        parents:
          'Synchronous ancestry only; AsyncLocalStorage is intentionally not installed in Electron. Observed queue ownership is explicit, and command/unfinished-method associations are marked as inference or temporal overlap.',
        time: 'All offsets are relative to each sample clockStart; synchronousCallMs covers original invocation until it returns, not awaited completion.',
        processes:
          'Observe Git spawn returns and existing child/stream emit calls; only safe local read/checkout argv is retained. No data/error listeners, reads, resume calls, stdout contents, credential configuration, or environment values are added. Other executables are not traced.',
        filesystem:
          'fs/promises hooks plus syncBuiltinESMExports; FileHandle hooks installed by observing the unchanged open promise. Paths/size/stat metadata are recorded, never write contents.',
        timers:
          'Global timer functions are untouched. Native deletion-delay evidence comes from relevant reconciliation/queue/event timestamps.',
        exclusive:
          'uncoveredByDirectChildrenMs subtracts the union of overlapping child wall intervals; it is not CPU time.',
        overhead:
          'Deep tracing, a bounded diagnostic progress write every 250 ms, and optional CPU profiling perturb timing. Compare to a normal run of the same installed product bundle; do not equate profiler timing with uninstrumented latency.',
      },
    };
    this.result.deepTrace.limits = {
      spansPerSample: MAX_TRACE_SPANS,
      eventsPerSample: MAX_TRACE_EVENTS,
      progressIntervalMs: 250,
    };
    this.deepTracingActive = true;
    this.deepPendingRestorers = new Set();
    this.deepWrappedTargets = new WeakMap();
    this.result.deepTrace.capabilities.asyncContext = false;
    this.traceCheckpointFile = `${this.config.resultFile}.${this.config.runId}.progress.json`;
    this.traceCheckpointIo = { writeFile: fs.writeFile, rename: fs.rename };
    this.result.deepTrace.progressFile = this.traceCheckpointFile;
    await this.writeTraceCheckpoint('installing-targeted-hooks');
    this.restorers.push(() => {
      this.deepTracingActive = false;
      this.stopRuntimeTrace(this.activeSample);
      for (const restore of [...this.deepPendingRestorers].reverse()) restore();
      this.cpuSession?.disconnect();
      this.cpuSession = null;
    });
    const synchronize = this.diagnostic(() => require('node:module').syncBuiltinESMExports);
    this.result.deepTrace.capabilities.builtinEsmSynchronization =
      typeof synchronize === 'function';
    // Restore method properties before synchronizing built-in ESM namespaces.
    if (synchronize) this.restorers.push(() => synchronize());
    this.diagnostic(() => this.installFileSystemTrace());
    await this.writeTraceCheckpoint('filesystem-hooks-installed');
    this.diagnostic(() => this.installProcessTrace());
    await this.writeTraceCheckpoint('process-hooks-installed');
    if (synchronize) this.diagnostic(() => synchronize());
    this.diagnostic(() => this.installNativeTrace());
    await this.writeTraceCheckpoint('native-hooks-installed');
    if (this.config.cpuProfile) await this.prepareCpuProfile();
  }
  inspectorPost(method, params = {}) {
    return new Promise((resolve, reject) => {
      let timer = setTimeout(
        () => reject(new Error(`Inspector ${method} did not answer within five seconds.`)),
        5000,
      );
      try {
        this.cpuSession.post(method, params, (error, result) => {
          clearTimeout(timer);
          timer = null;
          if (error) reject(error);
          else resolve(result);
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  async prepareCpuProfile() {
    try {
      const { Session } = require('node:inspector');
      assert(
        typeof Session === 'function',
        'node:inspector.Session is unavailable in this Electron renderer.',
      );
      this.cpuSession = new Session();
      this.cpuSession.connect();
      await this.inspectorPost('Profiler.enable');
      await this.inspectorPost('Profiler.setSamplingInterval', { interval: 1000 });
      this.result.deepTrace.capabilities.cpuProfile = {
        status: 'available',
        samplingIntervalMicroseconds: 1000,
      };
    } catch (error) {
      this.result.deepTrace.capabilities.cpuProfile = {
        status: 'unavailable',
        error: errorInfo(error),
      };
      this.diagnostic(() => this.cpuSession?.disconnect());
      this.cpuSession = null;
    }
  }
  async startCpuProfile(sample) {
    if (!this.cpuSession) return;
    sample.deepTrace.cpuProfile = { status: 'starting', beforeStartPerformanceMs: now() };
    try {
      await this.inspectorPost('Profiler.start');
      Object.assign(sample.deepTrace.cpuProfile, {
        status: 'recording',
        afterStartPerformanceMs: now(),
      });
    } catch (error) {
      Object.assign(sample.deepTrace.cpuProfile, {
        status: 'unavailable',
        error: errorInfo(error),
      });
      this.diagnostic(() => this.cpuSession.disconnect(), sample);
      this.cpuSession = null;
    }
  }
  async stopCpuProfile(sample) {
    const profile = sample?.deepTrace?.cpuProfile;
    if (!this.cpuSession || profile?.status !== 'recording') return;
    profile.stopRequestedPerformanceMs = now();
    try {
      const result = await this.inspectorPost('Profiler.stop');
      profile.stoppedPerformanceMs = now();
      const output = `${this.config.resultFile}.${this.config.runId}.sample-${sample.index}.cpuprofile`;
      await fs.writeFile(output, JSON.stringify(result.profile), { flag: 'wx' });
      Object.assign(profile, {
        status: 'saved',
        file: output,
        nodes: result.profile.nodes.length,
        samples: result.profile.samples?.length ?? 0,
        profileStartTime: result.profile.startTime,
        profileEndTime: result.profile.endTime,
      });
    } catch (error) {
      Object.assign(profile, { status: 'failed', error: errorInfo(error) });
      this.diagnostic(() => this.cpuSession.disconnect(), sample);
      this.cpuSession = null;
    }
  }
  startRuntimeTrace(sample) {
    if (!this.config.deepTrace) return;
    const state = { started: now(), expected: now() + 20, stopped: false, timer: null };
    Object.defineProperty(sample, 'runtimeProbe', { value: state });
    state.cpu = this.diagnostic(() => process.cpuUsage(), sample);
    state.lastCheckpoint = state.started;
    const pulse = () => {
      if (state.stopped) return;
      const observed = now();
      if (sample.deepTrace.eventLoopPulses.length < MAX_TRACE_EVENTS)
        sample.deepTrace.eventLoopPulses.push({
          atMs: observed - sample.clockStart,
          lagMs: Math.max(0, observed - state.expected),
        });
      else sample.deepTrace.droppedRuntimePulses = (sample.deepTrace.droppedRuntimePulses ?? 0) + 1;
      if (observed - state.lastCheckpoint >= 250) {
        state.lastCheckpoint = observed;
        void this.writeTraceCheckpoint('sample-running', sample);
      }
      state.expected = observed + 20;
      state.timer = setTimeout(pulse, 20);
    };
    state.timer = setTimeout(pulse, 20);
  }
  stopRuntimeTrace(sample) {
    const state = sample?.runtimeProbe;
    if (!state || state.stopped) return;
    state.stopped = true;
    clearTimeout(state.timer);
    const ended = now();
    const cpu = state.cpu && this.diagnostic(() => process.cpuUsage(state.cpu), sample);
    sample.deepTrace.runtime = {
      durationMs: ended - state.started,
      cpu: cpu
        ? {
            userMs: cpu.user / 1000,
            systemMs: cpu.system / 1000,
            processCpuMs: (cpu.user + cpu.system) / 1000,
          }
        : null,
      contextSwitches: null,
      eventLoopUtilization: null,
      optionalNodeLoopApis: 'disabled for conservative Electron tracing',
      lag: statistics(sample.deepTrace.eventLoopPulses.map((entry) => entry.lagMs)),
      maxObservedTimerLagMs: sample.deepTrace.eventLoopPulses.length
        ? Math.max(...sample.deepTrace.eventLoopPulses.map((entry) => entry.lagMs))
        : null,
      pulseIntervalMs: 20,
      pendingPulseOverdueMs: Math.max(0, ended - state.expected),
      scope:
        'CPU/resource figures cover this renderer process, not Git subprocess CPU; timer lag samples the renderer scheduling available to this plugin.',
    };
  }
  summarizeDeepTrace(sample) {
    const spans = sample.spans;
    const byId = new Map(spans.map((span) => [span.id, span]));
    const children = new Map();
    for (const span of spans) {
      const parent = byId.get(span.parentId);
      if (parent && Number.isFinite(span.endMs) && Number.isFinite(parent.endMs)) {
        if (!children.has(parent.id)) children.set(parent.id, []);
        children
          .get(parent.id)
          .push([Math.max(parent.startMs, span.startMs), Math.min(parent.endMs, span.endMs)]);
      }
    }
    for (const span of spans) {
      if (Number.isFinite(span.durationMs)) {
        span.directChildrenWallMs = intervalUnion(children.get(span.id) ?? []);
        span.uncoveredByDirectChildrenMs = Math.max(0, span.durationMs - span.directChildrenWallMs);
      }
      if (span.name === 'process.spawn') {
        const raw = byId.get(span.rawSpanId);
        span.breakdownMs = {
          requestToSpawn: raw ? span.startMs - raw.startMs : null,
          synchronousSpawn: span.spawnSynchronousMs,
          spawnReturnToSpawnEvent: Number.isFinite(span.spawnEventMs)
            ? span.spawnEventMs - span.spawnReturnMs
            : null,
          spawnReturnToExit: Number.isFinite(span.exitMs) ? span.exitMs - span.spawnReturnMs : null,
          exitToClose:
            Number.isFinite(span.exitMs) && Number.isFinite(span.closeMs)
              ? span.closeMs - span.exitMs
              : null,
          closeToRequestSettled:
            raw && Number.isFinite(raw.endMs) && Number.isFinite(span.closeMs)
              ? raw.endMs - span.closeMs
              : null,
        };
      }
    }
    sample.deepTrace.coverage = {
      spans: spans.length,
      gitRawRequests: spans.filter((span) => span.name === 'git.raw').length,
      gitProcesses: spans.filter((span) => span.name === 'process.spawn' && span.isGit).length,
      linkedGitProcesses: spans.filter(
        (span) => span.name === 'process.spawn' && (span.rawSpanId || span.checkoutSpanId),
      ).length,
      controlStoreFsOperations: spans.filter(
        (span) => span.name.startsWith('fs.') && span.scope === 'control-store',
      ).length,
      nativeAdapterReconciliations: spans.filter((span) =>
        span.name.startsWith('adapter.reconcile'),
      ).length,
      vaultEvents: sample.deepTrace.events.filter((event) => event.type.startsWith('vault.'))
        .length,
      remainingOpenSpans: spans
        .filter((span) => span.status === 'running')
        .map((span) => ({ id: span.id, name: span.name })),
    };
  }

  async fastWait(label, condition, timeout = 30_000) {
    const deadline = now() + timeout;
    while (true) {
      if (this.stopped) throw new Error(`Benchmark unloaded while waiting for ${label}.`);
      const value = condition();
      if (value) return value;
      if (now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  async awaitObservation(span) {
    assert(span.observation, 'Native controller did not return an observable promise.');
    let timer;
    try {
      await Promise.race([
        span.observation,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native controller did not settle within 60 seconds.')),
            60_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async nextFrame() {
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => resolve(now()))),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'No native animation frame within five seconds; keep the fixture visible.',
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async sample(targetId, expectedBranch, scenario, temperature) {
    assert(!this.activeSample, 'A timed sample already owns the benchmark.');
    assert(!this.switcher.activeModal?.isOpen, 'A native Quick Switcher modal is already open.');
    const source = this.controller.state;
    const sample = {
      index: this.recorder.startedSamples,
      scenario,
      temperature,
      fromId: source.activeId,
      toId: targetId,
      direction:
        scenario === 'branch'
          ? `${this.expectedBranch}->${expectedBranch}`
          : `${source.workspaces[source.activeId]?.name ?? source.activeId}->${source.workspaces[targetId]?.name ?? targetId}`,
      expectedBranch,
      sourceLayout: clone(this.app.workspace.getLayout()),
      endpointExpected: {
        id: targetId,
        name: source.workspaces[targetId].name,
        branch: expectedBranch,
        layout: clone(source.workspaces[targetId].contexts.desktop.layout),
        activeFile: `${expectedBranch}-exclusive.md`,
        notes: clone(this.expectedNotes[expectedBranch]),
        absentPaths: Object.keys(
          this.expectedNotes[expectedBranch === 'alpha' ? 'beta' : 'alpha'],
        ).filter((name) => !this.expectedTrackedPaths[expectedBranch].has(name)),
      },
      status: 'running',
      startedAt: new Date().toISOString(),
      spans: [],
      controllerCalls: [],
      repositoryCalls: [],
      modals: [],
    };
    Object.defineProperty(sample, 'repositoryRestorers', { value: [] });
    if (this.config.deepTrace) {
      sample.deepTrace = { events: [], eventLoopPulses: [], errors: [] };
      const watchedPaths = new Set([
        ...referencedPaths(source.workspaces[source.activeId]?.contexts.desktop?.layout),
        ...referencedPaths(source.workspaces[targetId]?.contexts.desktop?.layout),
      ]);
      Object.defineProperty(sample, 'watchedPaths', { value: watchedPaths });
      Object.defineProperty(sample, 'textObservations', { value: new Map() });
      Object.defineProperty(sample, 'liveSpans', { value: new Map() });
      sample.deepTrace.watchedPaths = [...watchedPaths];
      await this.startCpuProfile(sample);
    }
    // Journal the attempt before starting any measurement. A process crash
    // leaves this start without a completion and can never produce a pass.
    await this.recorder.startSample(sample);
    Object.assign(sample, captureMeasurementEnvironment(this.app, apiVersion));
    sample.memory = { beforeTiming: memoryObservation() };
    const clockStart = now();
    Object.defineProperty(sample, 'clockStart', { value: clockStart });
    if (sample.deepTrace) sample.deepTrace.clockStartPerformanceMs = clockStart;
    if (this.config.deepTrace) await this.writeTraceCheckpoint('sample-start', sample, true);
    this.activeSample = sample;
    try {
      assertMeasurementEnvironment(sample);
      this.startRuntimeTrace(sample);
      sample.commandStartMs = now() - sample.clockStart;
      assert(
        this.app.commands.executeCommandById(this.commandId) !== false,
        'Actual Q++ Workspaces command was unavailable.',
      );
      const modal = await this.fastWait('actual Q++ chooser suggestions', () => {
        const candidate = this.switcher.activeModal;
        return candidate?.isOpen &&
          candidate.chooser?.values?.some((value) => value.item?.id === targetId)
          ? candidate
          : null;
      });
      sample.chooserReadyMs = now() - sample.clockStart;
      const index = modal.chooser.values.findIndex((value) => value.item?.id === targetId);
      assert(index >= 0, `Q++ did not list ${targetId}.`);
      sample.suggestionCount = modal.chooser.values.length;
      sample.selectedSuggestion = clone(modal.chooser.values[index].item);
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' });
      modal.chooser.setSelectedItem(index, event);
      sample.selectionMs = now() - sample.clockStart;
      modal.chooser.useSelectedItem(event);
      const call = await this.fastWait('actual controller activation', () =>
        sample.controllerCalls.find((value) => value.workspaceId === targetId),
      );
      await this.awaitObservation(call);
      assert(
        call.status === 'fulfilled',
        `Native activation failed: ${JSON.stringify(call.error)}`,
      );
      assert(
        sample.controllerCalls.length === 1 && call.name === 'controller.activate',
        'Q++ selection did not use exactly one actual activate call.',
      );
      assert(!modal.isOpen, 'The native Q++ chooser remained open after activation.');
      sample.nextFrameMs = (await this.nextFrame()) - sample.clockStart;
      sample.timingsMs = {
        commandToChooser: sample.chooserReadyMs - sample.commandStartMs,
        commandToSelection: sample.selectionMs - sample.commandStartMs,
        selectionToControllerEntry: call.startMs - sample.selectionMs,
        controller: call.durationMs,
        selectionToControllerComplete: call.endMs - sample.selectionMs,
        commandToControllerComplete: call.endMs - sample.commandStartMs,
        controllerCompleteToNextFrame: sample.nextFrameMs - call.endMs,
        selectionToNextFrame: sample.nextFrameMs - sample.selectionMs,
        endpointCapture: sample.completionEndpoint?.captureDurationMs ?? null,
        selectionToInputRelease:
          sample.completionEndpoint?.input?.blocks[0]?.endMs - sample.selectionMs,
      };
      sample.transitionModalOpened = sample.modals.some(
        (entry) => entry.kind === 'transition-progress',
      );
      sample.transitionModalAtFrameOpportunity = sample.modals.some(
        (entry) => entry.kind === 'transition-progress' && entry.visibleAtFrameOpportunity,
      );
      sample.rawGitCommandCount = sample.spans.filter((span) => span.name === 'git.raw').length;
      // End ALL measurement attribution before independent branch/index/disk/editor checks.
      sample.measurementEndMs = sample.nextFrameMs;
      this.stopRuntimeTrace(sample);
      this.activeSample = null;
      await this.stopCpuProfile(sample);
      if (this.config.deepTrace) this.diagnostic(() => this.summarizeDeepTrace(sample), sample);
      if (this.config.deepTrace) await this.writeTraceCheckpoint('sample-measured', sample, true);
      const verificationStart = now();
      assert(
        !sample.completionCaptureError,
        `Completion capture failed: ${JSON.stringify(sample.completionCaptureError)}`,
      );
      sample.endpointValidation = assertCompletionEndpoint(
        sample.completionEndpoint,
        sample.endpointExpected,
      );
      sample.verification = await this.verify(expectedBranch, targetId);
      sample.verificationDurationMs = now() - verificationStart;
      sample.status = 'passed';
      this.expectedBranch = expectedBranch;
    } catch (error) {
      sample.status = 'failed';
      sample.error = errorInfo(error);
      throw error;
    } finally {
      this.stopRuntimeTrace(sample);
      this.activeSample = null;
      await this.stopCpuProfile(sample);
      if (this.config.deepTrace) this.diagnostic(() => this.summarizeDeepTrace(sample), sample);
      sample.finishedAt = new Date().toISOString();
      if (this.config.deepTrace) await this.writeTraceCheckpoint('sample-finished', sample, true);
      // Repository adapters are per transition. Release observer closures after
      // the unchanged controller/provider scope settles, outside its timer.
      for (const restore of sample.repositoryRestorers.splice(0).reverse())
        this.diagnostic(restore, sample);
      sample.memory.afterVerificationBeforePersistence = memoryObservation();
      this.retainStatistics(sample);
      await this.recorder.completeSample(sample);
    }
  }

  retainStatistics(sample) {
    if (sample.status !== 'passed') return;
    const spanTotals = {};
    for (const span of sample.spans)
      spanTotals[span.name] = (spanTotals[span.name] ?? 0) + (span.durationMs ?? 0);
    this.sampleStatistics.push({
      scenario: sample.scenario,
      temperature: sample.temperature,
      direction: sample.direction,
      timingsMs: { ...sample.timingsMs },
      rawGitCommandCount: sample.rawGitCommandCount,
      transitionModalOpened: sample.transitionModalOpened,
      transitionModalAtFrameOpportunity: sample.transitionModalAtFrameOpportunity,
      spanTotals,
      repositoryQueueWaitMs: sample.spans
        .filter((span) => span.name === 'git.queueTask' && span.owner === 'withRepository')
        .map((span) => span.queueWaitMs),
    });
  }

  async writeResult() {
    // During a run this is a fixed-size progress record, never a growing report.
    if (this.recorder)
      await this.recorder.writeProgress(
        this.result.status === 'failed'
          ? (this.result.error ?? this.result.cleanupError)
          : undefined,
      );
  }

  summary() {
    const groups = {};
    for (const sample of this.sampleStatistics) {
      const key = `${sample.scenario}/${sample.temperature}/${sample.direction}`;
      (groups[key] ??= []).push(sample);
    }
    return Object.fromEntries(
      Object.entries(groups).map(([key, samples]) => [
        key,
        {
          n: samples.length,
          timingMs: Object.fromEntries(
            Object.keys(samples[0].timingsMs).map((name) => [
              name,
              statistics(samples.map((sample) => sample.timingsMs[name])),
            ]),
          ),
          rawGitCommandCount: statistics(samples.map((sample) => sample.rawGitCommandCount)),
          transitionModalOpened: samples.filter((sample) => sample.transitionModalOpened).length,
          transitionModalAtFrameOpportunity: samples.filter(
            (sample) => sample.transitionModalAtFrameOpportunity,
          ).length,
          spansMs: Object.fromEntries(
            [...new Set(samples.flatMap((sample) => Object.keys(sample.spanTotals)))]
              .sort()
              .map((name) => [
                name,
                statistics(samples.map((sample) => sample.spanTotals[name] ?? 0)),
              ]),
          ),
          repositoryQueueWaitMs: statistics(
            samples.flatMap((sample) => sample.repositoryQueueWaitMs),
          ),
        },
      ]),
    );
  }
  async duplicateAlpha(name, unbound = false) {
    const id = await this.controller.duplicate('runtime-alpha');
    this.temporaryIds.push(id);
    await this.controller.update(id, { name, group: 'Temporary latency benchmark' });
    if (unbound) await this.controller.unbind(id);
    return id;
  }
  async layoutBaselines() {
    if (!this.config.baselineSamples) return;
    const same = await this.duplicateAlpha('Benchmark same branch');
    await this.sample(same, 'alpha', 'same-branch', 'warmup');
    await this.sample('runtime-alpha', 'alpha', 'same-branch', 'warmup');
    for (let index = 0; index < this.config.baselineSamples; index++)
      await this.sample(index % 2 ? 'runtime-alpha' : same, 'alpha', 'same-branch', 'measured');
    const first = await this.duplicateAlpha('Benchmark unbound A', true);
    const second = await this.duplicateAlpha('Benchmark unbound B', true);
    await this.sample(first, 'alpha', 'unbound-entry', 'warmup');
    await this.sample(second, 'alpha', 'unbound', 'warmup');
    await this.sample(first, 'alpha', 'unbound', 'warmup');
    for (let index = 0; index < this.config.baselineSamples; index++)
      await this.sample(index % 2 ? first : second, 'alpha', 'unbound', 'measured');
    await this.sample('runtime-alpha', 'alpha', 'cleanup', 'excluded');
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.sampleStatistics = [];
    this.result = {
      status: 'running',
      benchmarkSchema: 'obsidian-workspaces-switch-benchmark-v2',
      endpointSchema: ENDPOINT_SCHEMA,
      phase: this.config.phase,
      runId: this.config.runId,
      deepTraceEnabled: !!this.config.deepTrace,
      cpuProfileRequested: !!this.config.cpuProfile,
      manualStart: !!this.config.manualStart,
      diagnosticOnly: !!this.config.diagnosticOnly,
      startedAt: new Date().toISOString(),
      vault: this.config.vaultPath,
      methodology: {
        clock:
          'node:perf_hooks performance.now(), monotonic milliseconds; unrounded individual samples',
        primary:
          'actual Q++ chooser useSelectedItem Enter path to settlement of the unchanged controller.activate promise',
        command:
          'actual registered Q++ Workspaces command, automatic selection with no simulated human dwell',
        chooserObservation:
          'immediate check, then 1 ms polling only if suggestions are asynchronous; polling is excluded from selection latency',
        cold: 'first switch after probe arm; not OS-cache/process cold. Starting editors are hydrated before timing; no pre-timing controller transition',
        frame:
          'first requestAnimationFrame callback after controller completion, a rendering opportunity rather than proof of display scanout',
        spans:
          'inclusive and potentially nested/overlapping; do not add all spans to obtain wall time',
        rawGit:
          'native git.raw invocations and returned-promise duration; provider checkout and presentation are recorded separately',
        queue:
          'actual provider addTask enqueue to task invocation; withRepository callback wait additionally includes backend setup and repository initialization',
        verification:
          'immutable native snapshot synchronously in the first controller-settlement observer, independently validated after timing; later QuickSwitcherProbe checks actual Git, disk and live state without repairing views',
        endpoint:
          'state, full layout, active view, all editor buffers/deferred flags, native index, indicators and input-listener release captured before any await; snapshot overhead excluded from controller latency and recorded separately; next-frame interval includes that observation overhead',
        instrumentation:
          'observation only, Reflect.apply preserves receivers and unchanged original return values/promises; original input-release callbacks unchanged',
        recorder:
          'exclusive append-only per-run sample journal outside the vault; immutable raw sample serialized once after verification; only numeric summaries retained between switches; compact progress replacement and process.memoryUsage outside switch timers; original-schema final report streamed after all sampling',
        percentiles: 'median midpoint for even n; nearest-rank p95 and p99',
        baselines:
          'temporary independent duplicate Alpha layouts; same-branch remains bound, unbound pair has bindings explicitly removed through the controller; all temporary records removed',
      },
    };
    try {
      const actualVault = await fs.realpath(this.app.vault.adapter.getBasePath());
      assert(
        actualVault === this.config.vaultPath,
        'The benchmark marker does not identify this disposable vault.',
      );
      const outside = path.relative(actualVault, this.config.resultFile);
      assert(
        outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside),
        'Report must be outside the fixture.',
      );
      const marker = JSON.parse(
        await fs.readFile(
          path.join(actualVault, '.obsidian/plugins/workspaces-runtime-probe/data.json'),
          'utf8',
        ),
      );
      assert(
        marker.fixture === 'obsidian-workspaces-native-v1' &&
          marker.vaultPath === actualVault &&
          marker.completedAt,
        'Not a completed disposable fixture.',
      );
      const prior = JSON.parse(await fs.readFile(marker.resultFile, 'utf8'));
      assert(prior.status === 'passed', 'Original native fixture validation must have passed.');
      this.recorder = await SampleRecorder.create({
        resultFile: this.config.resultFile,
        vaultPath: actualVault,
        runId: this.config.runId,
        phase: this.config.phase,
        identity: {
          benchmarkSchema: this.result.benchmarkSchema,
          productSourceCommit: this.config.productSourceCommit,
          productBundleSHA256: this.config.expectedProductSHA256,
          probeSHA256: this.config.probeSHA256,
        },
      });
      await this.writeResult();
      this.controller = await this.waitFor(
        'Workspaces controller',
        () => this.app.plugins.getPlugin('obsidian-workspaces')?.controller,
      );
      this.gitPlugin = await this.waitFor('Obsidian Git readiness', () => {
        const plugin = this.app.plugins.getPlugin('obsidian-git');
        return plugin?.gitReady && plugin;
      });
      this.switcher = await this.waitFor('Q++ readiness', () => {
        const plugin = this.app.plugins.getPlugin('darlal-switcher-plus');
        return plugin?.commandDefinitions && plugin;
      });
      assert(
        this.gitPlugin.manifest.version === this.config.expectedGitVersion,
        'Unexpected Obsidian Git version.',
      );
      assert(
        this.switcher.manifest.version === this.config.expectedSwitcherVersion,
        'Unexpected Q++ version.',
      );
      this.commandId = Object.keys(this.app.commands.commands).find(
        (id) => id.includes('switcher') && id.endsWith(':open-workspaces'),
      );
      assert(this.commandId, 'Actual Q++ Workspaces command was not registered.');
      assert(
        this.controller.state.activeId === 'runtime-alpha' &&
          this.controller.state.journal === null,
        'Start with runtime-alpha active and no recovery journal.',
      );
      assert((await this.branch()) === 'alpha', 'Start on actual alpha.');
      assert(!(await this.gitRaw(['remote'])).trim(), 'Disposable fixture has a Git remote.');
      assert(
        !(await this.gitRaw(['status', '--porcelain'])).trim(),
        'Start with a clean fixture worktree.',
      );
      assert(!this.controller.busy, 'Another controller operation is already active.');
      const reloaded = await reloadProduct({
        app: this.app,
        apiVersion,
        expectedHash: this.config.expectedProductSHA256,
        readBundleHash: async () =>
          createHash('sha256')
            .update(
              await fs.readFile(
                path.join(actualVault, '.obsidian/plugins/obsidian-workspaces/main.js'),
              ),
            )
            .digest('hex'),
        waitFor: this.waitFor.bind(this),
      });
      this.controller = reloaded.plugin.controller;
      assert(
        (await this.branch()) === 'alpha' && !(await this.gitRaw(['status', '--porcelain'])).trim(),
        'Fixture changed during pre-timing product reload.',
      );
      this.expectedBranch = 'alpha';
      for (const branch of ['alpha', 'beta']) {
        const record = this.controller.state.workspaces[`runtime-${branch}`];
        assert(
          record?.contexts.desktop.binding?.branch === branch,
          `Missing bound ${branch} fixture.`,
        );
        this.assertPins(record.contexts.desktop.layout, branch);
      }
      // Independent expected editor bytes come from immutable fixture commits
      // before timing, including any additional representative Markdown panes.
      // This warms object reads; the first sample remains probe-cold, not OS-cold.
      this.fixtureCommits = {};
      this.expectedNotes = clone(this.config.notes);
      this.expectedTrackedPaths = {};
      for (const branch of ['alpha', 'beta']) {
        const commit = (await this.gitRaw(['rev-parse', `refs/heads/${branch}`])).trim();
        assert(
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit),
          'Fixture branch did not resolve to a full commit.',
        );
        this.fixtureCommits[branch] = commit;
        this.expectedTrackedPaths[branch] = new Set(
          (await this.gitRaw(['ls-tree', '-r', '--name-only', '-z', commit]))
            .split('\0')
            .filter(Boolean),
        );
        const names = new Set(
          fileLeaves(this.controller.state.workspaces[`runtime-${branch}`].contexts.desktop.layout)
            .filter((leaf) => leaf.type === 'markdown')
            .map((leaf) => leaf.path),
        );
        for (const name of names) {
          const content = await this.gitRaw(['show', `${commit}:${name}`]);
          if (Object.hasOwn(this.config.notes[branch], name))
            assert(
              content === this.config.notes[branch][name],
              'Primary fixture contents differ from their committed expectations.',
            );
          this.expectedNotes[branch][name] = content;
        }
      }
      for (const leaf of this.leaves()) await leaf.loadIfDeferred();
      this.result.initialObservation = await this.snapshot();
      await this.writeResult();
      this.result.initial = await this.verify('alpha', 'runtime-alpha');
      this.result.environment = {
        commandId: this.commandId,
        obsidian: apiVersion,
        plugins: {},
        platform: process.platform,
        architecture: process.arch,
        release: os.release(),
        cpus: os.cpus().map((cpu) => cpu.model),
        totalMemoryBytes: os.totalmem(),
        runtime: process.versions,
        nativeSession: nativeSession(),
        productReload: reloaded.evidence,
        controlStore: this.controller.storageLocation,
        sourceCommit: this.config.preparedFromCommit,
        sourceWorktreeStatus: this.config.sourceWorktreeStatus,
        productSourceCommit: this.config.productSourceCommit ?? null,
        autoSave: this.controller.state.autoSave,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      };
      for (const id of [
        'obsidian-workspaces',
        'obsidian-git',
        'darlal-switcher-plus',
        this.manifest.id,
      ]) {
        const directory = path.join(actualVault, '.obsidian/plugins', id);
        const manifest = JSON.parse(
          await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
        );
        this.result.environment.plugins[id] = {
          version: manifest.version,
          bundleSHA256: createHash('sha256')
            .update(await fs.readFile(path.join(directory, 'main.js')))
            .digest('hex'),
        };
      }
      assert(
        this.result.environment.plugins[this.manifest.id].bundleSHA256 === this.config.probeSHA256,
        'Installed benchmark differs from its prepared hash.',
      );
      assert(
        this.result.environment.plugins['obsidian-workspaces'].bundleSHA256 ===
          this.config.expectedProductSHA256,
        'Install the intended Workspaces build before preparing this benchmark; its bundle changed after prepare.',
      );
      this.result.fixture = {
        alphaCommit: this.fixtureCommits.alpha,
        betaCommit: this.fixtureCommits.beta,
        catalogSize: this.controller.state.order.length,
        measuredSwitches: this.config.samples,
        warmups: this.config.warmups,
        baselineSamples: this.config.baselineSamples,
        expectedNotes: clone(this.expectedNotes),
        workload: marker.workload ?? {
          profile: 'small',
          declaration: 'Original fixed Alpha/Beta fixture',
        },
        trackedFiles: (await this.gitRaw(['ls-files', '-z'])).split('\0').filter(Boolean).length,
        changedPaths: (
          await this.gitRaw(['diff', '--name-only', '--no-renames', '-z', 'alpha', 'beta', '--'])
        )
          .split('\0')
          .filter(Boolean).length,
        markdownLeaves: fileLeaves(
          this.controller.state.workspaces['runtime-alpha'].contexts.desktop.layout,
        ).filter((leaf) => leaf.type === 'markdown').length,
      };
      this.installInstrumentation();
      await this.installDeepTrace();
      await this.recorder.checkpoint(this.result);
      await this.sample('runtime-beta', 'beta', 'branch', 'cold');
      for (let index = 0; index < this.config.warmups; index++) {
        const branch = this.expectedBranch === 'alpha' ? 'beta' : 'alpha';
        await this.sample(`runtime-${branch}`, branch, 'branch', 'warmup');
      }
      assert(this.expectedBranch === 'alpha', 'Warmups must return to Alpha.');
      for (let index = 0; index < this.config.samples; index++) {
        const branch = index % 2 ? 'alpha' : 'beta';
        await this.sample(`runtime-${branch}`, branch, 'branch', 'measured');
      }
      await this.layoutBaselines();
      this.result.status = 'passed';
    } catch (error) {
      this.result.status = 'failed';
      this.result.error = errorInfo(error);
      console.error('Workspaces native switch benchmark failed', error);
    } finally {
      this.activeSample = null;
      try {
        this.switcher?.activeModal?.close();
        if (this.controller && !this.controller.busy && !this.controller.state.journal) {
          if (this.controller.state.activeId !== 'runtime-alpha')
            await this.sample('runtime-alpha', 'alpha', 'cleanup', 'excluded');
          for (const id of this.temporaryIds) {
            if (this.controller.state.workspaces[id]) await this.controller.remove(id);
          }
          this.result.final = await this.verify('alpha', 'runtime-alpha');
          this.result.finalGitStatus = await this.gitRaw(['status', '--porcelain']);
          assert(!this.result.finalGitStatus.trim(), 'The fixture did not finish clean.');
          this.result.restoredAlpha = true;
        } else if (this.controller)
          throw new Error(
            'Controller is busy or needs recovery; fixture was left intact for inspection.',
          );
      } catch (error) {
        this.result.cleanupError = errorInfo(error);
        this.result.status = 'failed';
      }
      for (const restore of this.restorers.splice(0).reverse()) this.diagnostic(restore);
      this.result.summary = this.summary();
      this.sampleStatistics = [];
      this.result.finishedAt = new Date().toISOString();
      try {
        assert(this.recorder, 'Recorder did not initialize; no final evidence can be published.');
        this.result.recorder = await this.recorder.finalize(this.result);
        // Complete evidence is already published. Failure to mark this test
        // plugin completed must not mislabel its verified native observations.
        await this.saveData({ ...this.config, completedAt: this.result.finishedAt }).catch(
          (error) =>
            console.error(
              'Benchmark evidence saved, but its completed marker could not be saved',
              error,
            ),
        );
      } catch (error) {
        this.result.status = 'failed';
        this.result.recorderError = errorInfo(error);
        if (this.recorder)
          await this.recorder
            .closeIncomplete(error)
            .catch((cause) =>
              console.error('Could not preserve incomplete benchmark progress', cause),
            );
        console.error('Could not save native switch benchmark results', error);
      }
      new Notice(
        `Workspaces ${this.config.phase} switch benchmark ${this.result.status}. Results saved outside the fixture.`,
        8000,
      );
    }
  }
};
