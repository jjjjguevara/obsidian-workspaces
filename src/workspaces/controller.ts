import type { GitBackend, GitRepository, GitStatus } from '../git/backend';
import { CommittedWriteError, type StateStore } from '../storage/store';
import { importRecords } from '../storage/migrations';
import { layoutsEqualStructural, mergeMainLayoutIntoCurrent } from '../obsidian/layout-data';
import { addWorkspace, duplicateWorkspace } from './catalog';
import {
  contextOf,
  remember,
  snapshot,
  type Device,
  type GitBinding,
  type Journal,
  type Layout,
  type Snapshot,
  type WorkspaceRecord,
  type WorkspaceState,
} from './model';

export interface WorkspaceHost {
  capture(): Layout;
  flush(): Promise<void>;
  quiesce(): Promise<void>;
  assertCanQuiesce?(): Promise<void>;
  waitForFiles(
    target: Layout,
    previous: Layout,
    options?: { afterCheckout?: boolean },
  ): Promise<void>;
  restore(layout: Layout): Promise<void>;
  /** Blocks user interaction during the transition; returns its release callback. */
  block(message: string): () => void;
  confirmDiscard(name: string): Promise<boolean>;
}

export type WorkspaceMetadata = Pick<
  WorkspaceRecord,
  'name' | 'group' | 'icon' | 'color' | 'description'
>;

/** Catalog changes that bring in edits made in the core Workspaces list. */
export interface NativeCatalogChanges {
  /** Core layouts that replace a record's layout for this device. The binding stays. */
  adopt: Array<{ id: string; layout: Layout; savedAt: number }>;
  /** Core entries that become new unbound records. */
  add: WorkspaceRecord[];
  /** Records whose core entry was deleted. */
  remove: string[];
}

const hasBinding = (record: WorkspaceRecord | undefined): boolean =>
  !!record && Object.values(record.contexts).some((context) => !!context?.binding);

/** A removed record leaves the baseline. A retired name stops a stale core entry from returning. */
function forgetProjected(state: WorkspaceState, id: string, retire: boolean): void {
  const baseline = state.nativeCatalog;
  if (!baseline || !Object.hasOwn(baseline.projected, id)) return;
  if (retire) (baseline.retired ??= {})[baseline.projected[id]!] = Date.now();
  delete baseline.projected[id];
}

/** All mutation and restoration routes share this queue. No timer can steal ownership. */
export class WorkspaceController {
  private current: WorkspaceState;
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private operation: string | null = null;
  private stopped = false;

  constructor(
    initial: WorkspaceState,
    private readonly store: StateStore,
    private readonly host: WorkspaceHost,
    private readonly git: GitBackend,
    readonly device: Device,
  ) {
    this.current = structuredClone(initial);
  }

  get state(): WorkspaceState {
    return structuredClone(this.current);
  }
  get busy(): string | null {
    return this.operation;
  }
  get storageLocation(): string | null {
    return this.store.location;
  }
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  private emit(): void {
    for (const callback of this.listeners) {
      try {
        callback();
      } catch (error) {
        console.error('Workspaces UI listener failed', error);
      }
    }
  }
  /** Pending operations are rejected on unload; an in-flight transaction retains ownership. */
  dispose(): void {
    this.stopped = true;
    this.listeners.clear();
  }

  private enqueue<T>(label: string, operation: () => Promise<T>, recovery = false): Promise<T> {
    const pending = this.tail.then(async () => {
      if (this.stopped) throw new Error('Workspaces has been unloaded.');
      if (!recovery && this.current.journal)
        throw new Error(
          'An interrupted workspace switch needs recovery. Run “Recover interrupted switch” first.',
        );
      this.operation = label;
      this.emit();
      try {
        return await operation();
      } finally {
        this.operation = null;
        this.emit();
      }
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  private async commit(next: WorkspaceState): Promise<void> {
    next.revision = this.current.revision + 1;
    try {
      await this.store.save(next);
    } catch (error) {
      if (error instanceof CommittedWriteError) {
        this.current = structuredClone(error.committed);
        this.emit();
      }
      throw error;
    }
    this.current = structuredClone(next);
    this.emit();
  }
  private setTransitionPhase(phase: 'checkout' | 'restoring'): void {
    // The durable prepared journal already contains the complete recovery
    // context. These phases are live diagnostics, not additional commits:
    // recovery always inspects actual Git state instead of trusting a phase.
    this.current.journal!.phase = phase;
    this.emit();
  }
  private record(id: string): WorkspaceRecord {
    if (!Object.hasOwn(this.current.workspaces, id)) throw new Error('Workspace no longer exists.');
    return this.current.workspaces[id];
  }
  private activeContext(): Snapshot | null {
    return this.current.activeId
      ? contextOf(this.record(this.current.activeId), this.device)
      : null;
  }
  private async validateStore(root: string): Promise<void> {
    if (this.device !== 'desktop')
      throw new Error('Git-bound workspaces are only available on desktop.');
    if (!this.store.location)
      throw new Error('Git binding requires a control store outside the vault.');
    await this.store.assertOutsideRepository?.(root);
  }
  private assertBinding(actual: Pick<GitStatus, 'root' | 'branch'>, expected: GitBinding): void {
    if (actual.root !== expected.root)
      throw new Error(
        'This workspace belongs to a different Git repository. Rebind it explicitly in the intended vault.',
      );
    if (actual.branch !== expected.branch)
      throw new Error(
        `The active workspace belongs to “${expected.branch}”, but Git is on “${actual.branch ?? 'detached HEAD'}”. Return to that branch or explicitly bind the current context again.`,
      );
  }
  private inspectIdentity(repository: GitRepository): Promise<Pick<GitStatus, 'root' | 'branch'>> {
    // Binding checks need a fresh repository/branch identity. Dirty/conflict
    // observations remain mandatory in the adapter's checkout safeguards.
    return repository.inspectIdentity?.() ?? repository.inspect();
  }
  private async observeSource<T>(
    operation: (
      repository: GitRepository | null,
      actual: Pick<GitStatus, 'root' | 'branch'> | null,
    ) => Promise<T>,
    needsGit = false,
  ): Promise<T> {
    const binding = this.activeContext()?.binding;
    if (!binding && !needsGit) return operation(null, null);
    if (this.device !== 'desktop')
      throw new Error('Git-bound workspaces are only available on desktop.');
    return this.git.withRepository(async (repository) => {
      if (this.stopped) throw new Error('Workspaces has been unloaded.');
      const actual = await this.inspectIdentity(repository);
      await this.validateStore(actual.root);
      if (binding) this.assertBinding(actual, binding);
      return operation(repository, actual);
    });
  }
  private capture(binding: GitBinding | null): Snapshot {
    return snapshot(this.host.capture(), this.device, binding);
  }
  private assertRevision(expected?: number): void {
    if (expected !== undefined && this.current.revision !== expected)
      throw new Error('Workspaces changed while this action was pending. Review the action again.');
  }

  create(name: string): Promise<string> {
    return this.enqueue('Creating workspace', () =>
      this.observeSource(async (repository) => {
        await this.host.flush();
        if (repository && this.activeContext()?.binding)
          this.assertBinding(await repository.inspect(), this.activeContext()!.binding!);
        const next = this.state;
        if (next.activeId && next.autoSave)
          remember(
            next.workspaces[next.activeId],
            this.capture(this.activeContext()?.binding ?? null),
          );
        const id = addWorkspace(next, name, this.capture(null));
        next.activeId = id;
        await this.commit(next);
        return id;
      }),
    );
  }
  saveActive(): Promise<void> {
    return this.enqueue('Saving workspace', () => this.saveCurrent());
  }
  private saveCurrent(): Promise<void> {
    return this.observeSource(async (repository) => {
      if (!this.current.activeId) throw new Error('Create or activate a workspace first.');
      await this.host.flush();
      if (repository && this.activeContext()?.binding)
        this.assertBinding(await repository.inspect(), this.activeContext()!.binding!);
      const next = this.state;
      remember(
        next.workspaces[next.activeId!],
        this.capture(this.activeContext()?.binding ?? null),
      );
      await this.commit(next);
    });
  }
  /**
   * Save the live layout as another record's layout for this device and make that
   * record active. No checkout or restoration occurs, so both sides must be unbound.
   */
  saveCurrentTo(id: string): Promise<void> {
    return this.enqueue('Saving workspace', async () => {
      const target = this.record(id);
      if (id === this.current.activeId) return this.saveCurrent();
      const active = this.current.activeId ? this.record(this.current.activeId) : undefined;
      if (hasBinding(target) || hasBinding(active))
        throw new Error(
          `The current layout cannot replace “${target.name}” while a branch binding is involved. Activate “${target.name}” first, then save it.`,
        );
      await this.host.flush();
      const next = this.state;
      const live = this.capture(null);
      // Identity moves without a transition, so save on switch keeps the outgoing layout.
      if (next.activeId && next.autoSave) remember(next.workspaces[next.activeId], live);
      remember(next.workspaces[id], live);
      next.activeId = id;
      await this.commit(next);
    });
  }
  /** A switcher's explicit save-and-switch must retain one mutation owner. */
  saveAndActivate(
    id: string,
    expectedSourceId: string | null = this.current.activeId,
  ): Promise<void> {
    return this.enqueue('Saving and switching workspace', async () => {
      if (this.current.activeId !== expectedSourceId)
        throw new Error('The active workspace changed. Choose the workspace again.');
      this.record(id);
      if (expectedSourceId !== null) await this.saveCurrent();
      await this.transition(id);
    });
  }
  bindActive(
    expectedId: string | null = this.current.activeId,
    expectedRevision?: number,
  ): Promise<void> {
    return this.enqueue('Binding current branch', async () => {
      this.assertRevision(expectedRevision);
      if (this.current.activeId !== expectedId)
        throw new Error('The active workspace changed. Review its branch binding again.');
      if (!this.current.activeId) throw new Error('Create or activate a workspace first.');
      if (this.device !== 'desktop') throw new Error('Git binding is only available on desktop.');
      await this.git.withRepository(async (repository) => {
        if (this.stopped) throw new Error('Workspaces has been unloaded.');
        await this.host.flush();
        const actual = await repository.inspect();
        await this.validateStore(actual.root);
        if (!actual.branch) throw new Error('Check out a local branch before binding a workspace.');
        const next = this.state;
        remember(
          next.workspaces[next.activeId!],
          this.capture({ root: actual.root, branch: actual.branch }),
        );
        await this.commit(next);
      });
    });
  }
  unbindActive(): Promise<void> {
    const id = this.current.activeId;
    if (!id) return Promise.reject(new Error('Create or activate a workspace first.'));
    return this.unbind(id);
  }
  unbind(id: string, expectedRevision?: number): Promise<void> {
    return this.enqueue('Removing branch binding', async () => {
      this.assertRevision(expectedRevision);
      this.record(id);
      const next = this.state;
      if (id === this.current.activeId) {
        await this.host.flush();
        remember(next.workspaces[id], this.capture(null));
      }
      for (const context of Object.values(next.workspaces[id].contexts))
        if (context.binding)
          remember(next.workspaces[id], { ...context, binding: null, savedAt: Date.now() });
      await this.commit(next);
    });
  }
  update(
    id: string,
    metadata: Partial<WorkspaceMetadata>,
    expectedRevision?: number,
  ): Promise<void> {
    return this.enqueue('Updating workspace', async () => {
      this.assertRevision(expectedRevision);
      this.record(id);
      if (metadata.name !== undefined && !metadata.name.trim())
        throw new Error('A workspace name is required.');
      const next = this.state;
      for (const key of ['name', 'group', 'icon', 'color', 'description'] as const)
        if (metadata[key] !== undefined) next.workspaces[id][key] = metadata[key]!.trim();
      await this.commit(next);
    });
  }
  duplicate(id: string): Promise<string> {
    return this.enqueue('Duplicating workspace', async () => {
      this.record(id);
      const next = this.state;
      const copy = duplicateWorkspace(next, id);
      await this.commit(next);
      return copy;
    });
  }
  setAutoSave(enabled: boolean): Promise<void> {
    return this.enqueue('Updating save behavior', async () => {
      const next = this.state;
      next.autoSave = enabled;
      await this.commit(next);
    });
  }
  remove(id: string, expectedRevision?: number): Promise<void> {
    return this.enqueue('Deleting workspace', async () => {
      this.assertRevision(expectedRevision);
      this.record(id);
      if (id === this.current.activeId) {
        const replacement = this.current.order.find((candidate) => candidate !== id);
        if (replacement) {
          await this.transition(replacement);
          if (this.current.activeId !== replacement) return;
        }
      }
      const next = this.state;
      forgetProjected(next, id, true);
      delete next.workspaces[id];
      next.order = next.order.filter((candidate) => candidate !== id);
      if (next.activeId === id) next.activeId = null;
      await this.commit(next);
    });
  }
  /**
   * Apply edits made in the core Workspaces list in one commit. The plan is computed
   * inside the queue from current state. There is no activation, layout change, or Git call.
   */
  reconcileNativeCatalog<T extends NativeCatalogChanges>(
    plan: (state: WorkspaceState) => T,
  ): Promise<T> {
    return this.enqueue('Matching core workspaces', async () => {
      const changes = plan(this.state);
      if (!changes.adopt.length && !changes.add.length && !changes.remove.length) return changes;
      const next = this.state;
      for (const id of changes.remove) {
        this.record(id);
        forgetProjected(next, id, false);
        delete next.workspaces[id];
        next.order = next.order.filter((candidate) => candidate !== id);
        // The live layout stays as it is. Nothing is restored for a deleted record.
        if (next.activeId === id) next.activeId = null;
      }
      for (const { id, layout, savedAt } of changes.adopt) {
        this.record(id);
        const record = next.workspaces[id];
        if (!record) continue;
        remember(record, {
          layout,
          device: this.device,
          binding: record.contexts[this.device]?.binding ?? null,
          savedAt,
        });
      }
      for (const original of changes.add) {
        const record = structuredClone(original);
        if (Object.hasOwn(next.workspaces, record.id)) record.id = globalThis.crypto.randomUUID();
        next.workspaces[record.id] = record;
        next.order.push(record.id);
      }
      await this.commit(next);
      return changes;
    });
  }
  /**
   * Record the projection that the core Workspaces list received. A record that was
   * removed after that write keeps a retired name until the next projection.
   */
  confirmNativeProjection(projected: Record<string, string>): Promise<void> {
    return this.enqueue('Updating core workspace list', async () => {
      const next = this.state;
      const previous = next.nativeCatalog;
      const baseline: NonNullable<WorkspaceState['nativeCatalog']> = { projected: {} };
      const retired: Record<string, number> = {};
      for (const [id, name] of Object.entries(projected)) {
        if (Object.hasOwn(next.workspaces, id)) baseline.projected[id] = name;
        else retired[name] = previous?.retired?.[name] ?? Date.now();
      }
      if (Object.keys(retired).length) baseline.retired = retired;
      const comparable = (value: Record<string, unknown> = {}): string =>
        JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      if (
        comparable(previous?.projected) === comparable(baseline.projected) &&
        comparable(previous?.retired) === comparable(baseline.retired)
      )
        return;
      next.nativeCatalog = baseline;
      await this.commit(next);
    });
  }
  importJson(json: string): Promise<number> {
    return this.enqueue('Importing workspaces', async () => {
      const records = importRecords(JSON.parse(json));
      const next = this.state;
      for (const original of records) {
        const record = structuredClone(original);
        if (Object.hasOwn(next.workspaces, record.id)) record.id = globalThis.crypto.randomUUID();
        next.workspaces[record.id] = record;
        next.order.push(record.id);
      }
      await this.commit(next);
      return records.length;
    });
  }
  exportJson(): string {
    // The core-list baseline describes this device's files. It is not transfer data.
    const { nativeCatalog: _deviceLocal, ...transferable } = this.current;
    return JSON.stringify(transferable, null, 2);
  }
  activate(id: string): Promise<void> {
    return this.enqueue('Switching workspace', () => this.transition(id));
  }
  restoreHistory(id: string, index: number): Promise<void> {
    // The user selected this snapshot now. A queued save may insert another
    // history entry before this operation owns the controller.
    const context = this.record(id).history[index];
    if (!context) return Promise.reject(new Error('That history entry no longer exists.'));
    const chosen = structuredClone(context);
    return this.enqueue('Restoring workspace history', () => this.transition(id, chosen));
  }

  private async transition(id: string, revision?: Snapshot): Promise<void> {
    const targetRecord = this.record(id);
    if (id === this.current.activeId && !revision) {
      await this.observeSource(async () => undefined);
      return;
    }
    const savedTarget = revision ?? contextOf(targetRecord, this.device);
    if (savedTarget.binding && this.device !== 'desktop')
      throw new Error('This workspace is bound to Git. Activate an unbound workspace on mobile.');
    let target = structuredClone(savedTarget);
    if (target.device !== this.device) {
      if (target.binding)
        throw new Error('A branch-bound layout must have a snapshot for this device.');
      target = snapshot(
        mergeMainLayoutIntoCurrent(target.layout, this.host.capture()) as Layout,
        this.device,
      );
    }
    await this.observeSource(async (repository, observed) => {
      const sourceId = this.current.activeId;
      const source = this.capture(this.activeContext()?.binding ?? null);
      if (
        sourceId &&
        !this.current.autoSave &&
        !layoutsEqualStructural(source.layout, this.activeContext()!.layout, {
          restoreScope: 'full',
        })
      ) {
        if (!(await this.host.confirmDiscard(this.record(sourceId).name))) return;
      }
      const release = this.host.block(`Opening ${targetRecord.name}…`);
      let prepared = false;
      let recoveryJournal: Journal | undefined;
      try {
        await this.host.flush();
        // Capture once more after flushing, before any outgoing leaf is unloaded.
        source.layout = structuredClone(this.host.capture());
        source.savedAt = Date.now();
        // A known cross-branch transition needs the complete preflight. Reuse
        // its fresh source observation at this boundary, not the identity read
        // before flushing. Other paths retain their inexpensive identity read:
        // same-branch layout changes must continue to permit pending edits.
        const canPrepare =
          repository?.prepareSwitch &&
          source.binding &&
          target.binding &&
          source.binding.root === target.binding.root &&
          source.binding.branch !== target.binding.branch;
        let preflighted = false;
        let actual = observed;
        if (canPrepare) {
          await this.host.assertCanQuiesce?.();
          actual = await repository!.prepareSwitch!(target.binding!.branch);
          preflighted = true;
        } else if (repository) actual = await this.inspectIdentity(repository);
        if (source.binding && actual) this.assertBinding(actual, source.binding);
        if (target.binding) {
          if (!actual || !repository) throw new Error('The Git backend is unavailable.');
          if (actual.root !== target.binding.root)
            throw new Error('The target workspace belongs to a different Git repository.');
          if (!actual.branch)
            throw new Error('Check out a local branch before switching a bound workspace.');
        }
        const checkout = !!target.binding && actual?.branch !== target.binding.branch;
        if (checkout && !preflighted) {
          await this.host.assertCanQuiesce?.();
          await repository!.assertCanSwitch(target.binding!.branch);
        }
        const next = this.state;
        if (sourceId && next.autoSave) remember(next.workspaces[sourceId], source);
        next.journal = {
          sourceId,
          targetId: id,
          source,
          sourceSaved: sourceId ? contextOf(next.workspaces[sourceId], this.device) : null,
          target,
          originalBranch: actual?.branch ? { root: actual.root, branch: actual.branch } : null,
          phase: 'prepared',
        };
        recoveryJournal = structuredClone(next.journal);
        prepared = true;
        await this.commit(next);
        if (checkout) {
          await this.host.quiesce();
          this.setTransitionPhase('checkout');
          // Unloading views can save again. checkout() owns the authoritative
          // fresh validation; duplicating it here adds a full Git preflight.
          repository!.overlapPresentation?.();
          const result = await repository!.checkout(target.binding!.branch);
          this.assertBinding(result, target.binding!);
        }
        this.setTransitionPhase('restoring');
        await this.host.waitForFiles(target.layout, source.layout, { afterCheckout: checkout });
        await this.host.restore(target.layout);
        if (target.binding && repository)
          this.assertBinding(await this.inspectIdentity(repository), target.binding);
        const done = this.state;
        // Keep the requested native snapshot, not a transient host view that may have lost a pin.
        remember(done.workspaces[id], { ...target, savedAt: Date.now() });
        done.activeId = id;
        done.journal = null;
        await this.commit(done);
      } catch (error) {
        if (prepared) await this.markRecovery(error, repository, recoveryJournal);
        throw error;
      } finally {
        release();
      }
    }, !!target.binding);
  }

  private async markRecovery(
    error: unknown,
    repository: GitRepository | null,
    fallback?: Journal,
  ): Promise<void> {
    const failed = this.state;
    if (!failed.journal && fallback) failed.journal = structuredClone(fallback);
    if (!failed.journal) return;
    failed.activeId = failed.journal.sourceId;
    failed.journal.phase = 'recovery';
    let branch = 'unknown';
    try {
      if (repository) branch = (await repository.inspect()).branch ?? 'detached HEAD';
    } catch {
      /* Keep the durable original journal when inspection fails. */
    }
    failed.journal.error = `${error instanceof Error ? error.message : String(error)} (Observed branch: ${branch})`;
    try {
      await this.commit(failed);
    } catch (storageError) {
      // A failed write must not enable more captures in this process. The last
      // durable journal still causes recovery after a restart.
      this.current.journal = failed.journal;
      this.current.activeId = failed.activeId;
      this.emit();
      console.error('Workspaces could not update the recovery journal', storageError);
    }
  }

  recover(): Promise<void> {
    return this.enqueue(
      'Recovering interrupted switch',
      async () => {
        const journal = this.current.journal;
        if (!journal) return;
        const run = async (repository: GitRepository | null): Promise<void> => {
          if (this.stopped) throw new Error('Workspaces has been unloaded.');
          const release = this.host.block('Restoring the previous workspace…');
          try {
            let checkedOut = false;
            await this.host.flush();
            if (journal.originalBranch) {
              if (!repository) throw new Error('Recovery requires the Git backend.');
              const actual = await repository.inspect();
              await this.validateStore(actual.root);
              if (actual.root !== journal.originalBranch.root)
                throw new Error('Recovery belongs to another repository.');
              if (actual.branch !== journal.originalBranch.branch) {
                await this.host.assertCanQuiesce?.();
                await repository.assertCanSwitch(journal.originalBranch.branch);
                await this.host.quiesce();
                await repository.assertCanSwitch(journal.originalBranch.branch);
                repository.overlapPresentation?.();
                this.assertBinding(
                  await repository.checkout(journal.originalBranch.branch),
                  journal.originalBranch,
                );
                checkedOut = true;
              }
            }
            await this.host.waitForFiles(journal.source.layout, journal.target.layout, {
              afterCheckout: checkedOut,
            });
            await this.host.restore(journal.source.layout);
            if (journal.originalBranch && repository)
              this.assertBinding(await repository.inspect(), journal.originalBranch);
            const next = this.state;
            if (journal.sourceId) {
              remember(next.workspaces[journal.sourceId], journal.sourceSaved ?? journal.source);
            }
            next.activeId = journal.sourceId;
            next.journal = null;
            await this.commit(next);
          } catch (error) {
            await this.markRecovery(error, repository, journal);
            throw error;
          } finally {
            release();
          }
        };
        if (journal.originalBranch) {
          if (this.device !== 'desktop') throw new Error('Recover this Git transition on desktop.');
          await this.git.withRepository(run);
        } else await run(null);
      },
      true,
    );
  }
}
