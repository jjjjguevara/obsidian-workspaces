import type { App } from 'obsidian';
import { importRecords } from '../storage/migrations';
import { orderedWorkspaces } from '../workspaces/catalog';
import type { NativeCatalogChanges, WorkspaceController } from '../workspaces/controller';
import type {
  Device,
  Layout,
  Snapshot,
  WorkspaceRecord,
  WorkspaceState,
} from '../workspaces/model';

/** Compatibility boundary for Obsidian's core Workspaces plugin (inspected 1.15.1).
 * The product catalog is the authority. While both plugins are enabled, the core
 * list is a projection of the catalog and the core operations go to the controller.
 * This module never restores a layout itself. See ADR 0006.
 */
export const CORE_WORKSPACES_ID = 'workspaces';
const ROUTED = ['saveWorkspace', 'setActiveWorkspace', 'loadWorkspace', 'deleteWorkspace'] as const;

type ObjectValue = Record<string, unknown>;
type Method = (this: unknown, ...args: unknown[]) => unknown;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const method = (value: unknown): value is Method => typeof value === 'function';
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
/** Display names are data. A plain assignment of `__proto__` would not create an entry. */
function setOwn(target: ObjectValue, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

// ---------------------------------------------------------------------------
// Pure decisions: projection and reconciliation planning.
// ---------------------------------------------------------------------------

/** Core writes `window.moment().format()`: local ISO-8601 time with an offset, in seconds. */
export function formatMtime(savedAt: number): string {
  const date = new Date(savedAt);
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  const offset = -date.getTimezoneOffset();
  const distance = Math.abs(offset);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(distance / 60))}:${pad(distance % 60)}`
  );
}
/** Milliseconds for a core `mtime`, or NaN when it is absent or unreadable. */
export function parseMtime(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}
/** The persisted form of the core list. It is also the comparison key for a projection. */
export function serializeCore(workspaces: unknown, active: unknown): string {
  return JSON.stringify({ workspaces, active: typeof active === 'string' ? active : '' });
}

const withoutMtime = (layout: unknown): unknown => {
  if (!object(layout)) return layout;
  const { mtime: _mtime, ...rest } = layout;
  return rest;
};
const sameLayout = (a: unknown, b: unknown): boolean =>
  JSON.stringify(withoutMtime(a)) === JSON.stringify(withoutMtime(b));
/** The context that the core list shows for a record: this device's slot, else the other one. */
function shownContext(record: WorkspaceRecord, device: Device): Snapshot | undefined {
  return record.contexts[device] ?? record.contexts[device === 'desktop' ? 'mobile' : 'desktop'];
}

export interface NativeProjection {
  /** Projected name to native layout plus `mtime`, in catalog order. */
  workspaces: Record<string, Layout>;
  /** Projected name of the committed workspace, or an empty string. */
  active: string;
  /** Record ID to projected name. */
  names: Record<string, string>;
}

/**
 * Build the core list from the catalog. Equal display names get a suffix in catalog
 * order. `foreign` holds core entries that the catalog cannot represent; they pass
 * through unchanged after the catalog entries unless a record uses their name.
 */
export function buildProjection(
  state: WorkspaceState,
  device: Device,
  foreign: Record<string, unknown> = {},
): NativeProjection {
  const records = orderedWorkspaces(state);
  const real = new Set(records.map((record) => record.name));
  const taken = new Set<string>();
  const projection: NativeProjection = { workspaces: {}, active: '', names: {} };
  for (const record of records) {
    const context = shownContext(record, device);
    if (!context) continue;
    let name = record.name;
    for (let suffix = 2; taken.has(name); suffix += 1) {
      const candidate = `${record.name} (${suffix})`;
      // A suffixed name must not take the real name of another record.
      if (!real.has(candidate)) name = candidate;
    }
    taken.add(name);
    projection.names[record.id] = name;
    setOwn(projection.workspaces, name, {
      ...structuredClone(context.layout),
      mtime: formatMtime(context.savedAt),
    });
  }
  // A recovery journal keeps the source identity until explicit recovery completes.
  const activeId = state.journal ? state.journal.sourceId : state.activeId;
  if (activeId !== null) projection.active = projection.names[activeId] ?? '';
  for (const [name, entry] of Object.entries(foreign))
    if (!taken.has(name)) setOwn(projection.workspaces, name, structuredClone(entry));
  return projection;
}

export interface NativeCatalogPlan extends NativeCatalogChanges {
  /** Core entries that are not workspace layouts (for example `mode:` records). Kept as found. */
  foreign: string[];
}

/** Convert one core entry with the explicit-import rules. Null means it is not importable. */
function convertEntry(name: string, entry: unknown, now: number): WorkspaceRecord | null {
  if (!object(entry) || !object(entry.main)) return null;
  let record: WorkspaceRecord | undefined;
  try {
    const source: ObjectValue = {};
    setOwn(source, name, entry);
    [record] = importRecords({ workspaces: source });
  } catch {
    return null;
  }
  if (!record) return null;
  const time = parseMtime(entry.mtime);
  for (const context of Object.values(record.contexts)) {
    context.layout = withoutMtime(context.layout) as Layout;
    context.savedAt = Number.isFinite(time) ? time : now;
  }
  return record;
}

/**
 * Decide what the catalog takes from the core list when the bridge starts. `core` is
 * the list as core loaded it. The baseline in `state.nativeCatalog` says which entries
 * this catalog projected before, so an absent entry means a deletion made in core.
 */
export function planReconciliation(
  state: WorkspaceState,
  device: Device,
  core: Record<string, unknown>,
  now: number = Date.now(),
): NativeCatalogPlan {
  const plan: NativeCatalogPlan = { adopt: [], add: [], remove: [], foreign: [] };
  const baseline = state.nativeCatalog?.projected ?? {};
  const retired = state.nativeCatalog?.retired ?? {};
  const records = orderedWorkspaces(state);
  const projectedAs = new Map<string, string>();
  for (const record of records) {
    const name = Object.hasOwn(baseline, record.id) ? baseline[record.id] : undefined;
    if (name !== undefined && !projectedAs.has(name)) projectedAs.set(name, record.id);
  }
  const unprojected = records.filter((record) => !Object.hasOwn(baseline, record.id));
  const names = Object.keys(core);
  for (const name of names) {
    const entry = core[name];
    let id = projectedAs.get(name);
    if (id === undefined) {
      // A name alone identifies a record only when exactly one unprojected record has it.
      const candidates = unprojected.filter((record) => record.name === name);
      if (candidates.length === 1) id = candidates[0]!.id;
    }
    const converted = convertEntry(name, entry, now);
    const layout = converted ? Object.values(converted.contexts)[0]!.layout : null;
    const time = parseMtime(object(entry) ? entry.mtime : undefined);
    if (id !== undefined) {
      const current = shownContext(state.workspaces[id]!, device);
      if (!layout || !current) continue;
      if (sameLayout(entry, current.layout) || sameLayout(layout, current.layout)) continue;
      // The catalog wins unless core saved this entry after the catalog saved its record.
      if (time > current.savedAt) plan.adopt.push({ id, layout, savedAt: time });
      continue;
    }
    if (!converted) {
      plan.foreign.push(name);
      continue;
    }
    // A record removed here before its projection was written must not come back,
    // unless core saved that name again after the removal.
    if (Object.hasOwn(retired, name) && !(time > retired[name]!)) continue;
    plan.add.push(converted);
  }
  // An empty core list is a lost or reset file, not a request to delete every record.
  // A branch-bound record is never removed here: the core file cannot hold its binding,
  // and a file that Git or a sync tool replaced must not delete it. It is projected again.
  if (names.length)
    for (const [name, id] of projectedAs) {
      if (Object.hasOwn(core, name)) continue;
      const bound = Object.values(state.workspaces[id]!.contexts).some(
        (context) => !!context?.binding,
      );
      if (!bound) plan.remove.push(id);
    }
  return plan;
}

// ---------------------------------------------------------------------------
// Adapter: method routing, projection writes and lifecycle.
// ---------------------------------------------------------------------------

interface CoreInstance extends ObjectValue {
  workspaces: ObjectValue;
  activeWorkspace: unknown;
  saveData: Method;
}
function supported(value: unknown): value is CoreInstance {
  return (
    object(value) &&
    object(value.workspaces) &&
    method(value.saveData) &&
    ROUTED.every((key) => method(value[key]))
  );
}

/** Preserve descriptors and never overwrite a later plugin's wrapper on teardown. */
function replace(target: object, key: string, factory: (original: Method) => Method): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const original = Reflect.get(target, key);
  if (!method(original)) throw new Error(`Core Workspaces is missing ${key}.`);
  const wrapped = factory(original);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
    value: wrapped,
  });
  return () => {
    if (Reflect.get(target, key) !== wrapped) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  };
}

interface Link {
  instance: CoreInstance;
  /** The unwrapped persistence method. Routed methods never write the core file themselves. */
  saveData: Method;
  cleanup: Array<() => void>;
  /** False until the edits made in core were taken into the catalog. Nothing is projected before. */
  reconciled: boolean;
  /** Serialized list known to be on disk, or null when a write is not confirmed. */
  persisted: string | null;
  /** Projected name to record ID, as the core list currently shows it. */
  ids: Map<string, string>;
  foreign: Set<string>;
  /** Names with a routed save in flight; core sets them active before the save settles. */
  pending: Map<string, number>;
  failed: boolean;
}

export interface NativeCatalogOptions {
  /** The live native layout, for the entry that core expects to see at once after a save. */
  capture: () => Layout;
  notify: (message: string) => void;
  /** Delay before a projection that follows a controller notification. */
  delayMs?: number;
}

/** A passive projection waits for the frames that follow a switch. A core request does not wait. */
const PROJECTION_DELAY_MS = 50;

const RECOVERY_REQUIRED =
  'An interrupted workspace switch needs recovery. Run “Recover interrupted switch” first.';

export class NativeCatalogBridge {
  private started = false;
  private link: Link | null = null;
  private cleanup: Array<() => void> = [];
  private eventDriven = false;
  private warned = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private routed = 0;
  private requests: Promise<void> = Promise.resolve();
  private waiters = new Set<() => void>();

  constructor(
    private readonly app: App,
    private readonly controller: WorkspaceController,
    private readonly options: NativeCatalogOptions,
  ) {}

  /** True while the core list is a projection of this catalog. */
  get active(): boolean {
    return this.link !== null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const manager = (this.app as unknown as { internalPlugins?: unknown }).internalPlugins;
    if (object(manager) && method(manager.on) && method(manager.offref)) {
      try {
        // Core triggers `change` after an enable finished loading its data, and after a disable.
        const reference = manager.on.call(manager, 'change', () => {
          if (this.started) this.evaluate();
        });
        this.cleanup.push(() => (manager.offref as Method).call(manager, reference));
        this.eventDriven = true;
      } catch (error) {
        console.warn('Workspaces could not observe core plugin changes.', error);
      }
    }
    // The controller emits inside its transaction. Only schedule here.
    this.cleanup.push(this.controller.subscribe(() => this.schedule()));
    this.evaluate();
  }

  /** Call when this plugin's interface opens. Without a host event this finds a core toggle. */
  refresh(): void {
    if (!this.started) return;
    if (!this.eventDriven) this.evaluate();
    this.schedule();
  }

  /** The core file stays as last projected. Unsaved in-memory entries are withdrawn. */
  dispose(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.detach();
    for (const restore of this.cleanup.splice(0).reverse()) {
      try {
        restore();
      } catch (error) {
        console.warn('Workspaces could not release a core Workspaces subscription.', error);
      }
    }
  }

  /** Resolves when no core request, scheduled pass or running pass remains. */
  async whenSettled(): Promise<void> {
    while (this.timer !== null || this.running || this.routed) {
      if (this.running) await this.running;
      else await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private evaluate(): void {
    const manager = (this.app as unknown as { internalPlugins?: unknown }).internalPlugins;
    const plugins = object(manager) ? manager.plugins : undefined;
    const wrapper = object(plugins) ? plugins[CORE_WORKSPACES_ID] : undefined;
    if (!object(wrapper) || wrapper.enabled !== true) {
      this.detach();
      return;
    }
    const instance = wrapper.instance;
    if (this.link?.instance === instance) return;
    this.detach();
    if (!supported(instance)) {
      this.warn('this Obsidian version has a different core Workspaces interface.');
      return;
    }
    const link: Link = {
      instance,
      saveData: instance.saveData,
      cleanup: [],
      reconciled: false,
      persisted: null,
      ids: new Map(),
      foreign: new Set(),
      pending: new Map(),
      failed: false,
    };
    const bridge = this;
    const owned = (): boolean => bridge.link === link;
    try {
      // Core saves after every mutation, so its loaded list equals the file.
      link.persisted = serializeCore(instance.workspaces, instance.activeWorkspace);
      link.cleanup.push(
        replace(
          instance,
          'loadWorkspace',
          (original) =>
            function (...args) {
              if (!owned()) return original.apply(this, args);
              const name = args[0];
              return bridge.route(link, () => bridge.controller.activate(bridge.idOf(link, name)));
            },
        ),
      );
      link.cleanup.push(
        replace(
          instance,
          'deleteWorkspace',
          (original) =>
            function (...args) {
              if (!owned()) return original.apply(this, args);
              const name = args[0];
              return bridge.route(link, async () => {
                // An entry that is not a catalog record only leaves the core list.
                if (typeof name === 'string' && !link.ids.has(name) && link.foreign.delete(name))
                  return;
                await bridge.controller.remove(bridge.idOf(link, name));
              });
            },
        ),
      );
      link.cleanup.push(
        replace(
          instance,
          'saveWorkspace',
          (original) =>
            function (...args) {
              if (!owned()) return original.apply(this, args);
              bridge.save(link, args[0]);
            },
        ),
      );
      link.cleanup.push(
        replace(
          instance,
          'setActiveWorkspace',
          (original) =>
            function (...args) {
              if (!owned()) return original.apply(this, args);
              // The active name follows the controller. Core calls this directly after
              // a save, so show that name until the save settles.
              const name = args[0];
              if (typeof name === 'string' && link.pending.has(name))
                instance.activeWorkspace = name;
              else bridge.schedule();
            },
        ),
      );
    } catch (error) {
      this.restore(link);
      this.warn(errorMessage(error));
      return;
    }
    this.link = link;
    this.schedule();
  }

  private warn(reason: string): void {
    if (this.warned) return;
    this.warned = true;
    this.options.notify(
      `Core Workspaces integration is unavailable: ${reason} The core list is not kept in step with Workspaces.`,
    );
  }

  private restore(link: Link): void {
    for (const restore of link.cleanup.splice(0).reverse()) {
      try {
        restore();
      } catch (error) {
        console.warn('Workspaces could not restore a core Workspaces method.', error);
      }
    }
  }

  private detach(): void {
    const link = this.link;
    if (!link) return;
    this.link = null;
    this.restore(link);
    this.revert(link);
    for (const resolve of [...this.waiters]) resolve();
  }

  /** Put the in-memory core list back to its persisted form. Does not write. */
  private revert(link: Link): void {
    if (link.persisted === null) return;
    const { instance } = link;
    try {
      if (serializeCore(instance.workspaces, instance.activeWorkspace) === link.persisted) return;
      const saved = JSON.parse(link.persisted) as { workspaces: ObjectValue; active: string };
      instance.workspaces = saved.workspaces;
      instance.activeWorkspace = saved.active;
    } catch (error) {
      console.warn('Workspaces could not reset the core Workspaces list.', error);
    }
  }

  private idOf(link: Link, name: unknown): string {
    const id = typeof name === 'string' ? link.ids.get(name) : undefined;
    if (id === undefined)
      throw new Error(
        `“${String(name)}” is not a workspace in the Workspaces catalog. The core list was refreshed.`,
      );
    return id;
  }

  /** Core calls this synchronously and renders its list directly afterwards. */
  private save(link: Link, name: unknown): void {
    if (typeof name !== 'string') {
      this.options.notify('Enter a workspace name.');
      return;
    }
    try {
      setOwn(link.instance.workspaces, name, {
        ...this.options.capture(),
        mtime: formatMtime(Date.now()),
      });
    } catch (error) {
      console.warn('Workspaces could not show the pending core Workspaces entry.', error);
    }
    link.pending.set(name, (link.pending.get(name) ?? 0) + 1);
    void this.route(link, () => {
      const id = link.ids.get(name) ?? link.ids.get(name.trim());
      if (id === undefined) return this.controller.create(name);
      if (id === this.controller.state.activeId) return this.controller.saveActive();
      return this.controller.saveCurrentTo(id);
    }).finally(() => {
      const count = (link.pending.get(name) ?? 1) - 1;
      if (count > 0) link.pending.set(name, count);
      else link.pending.delete(name);
    });
  }

  /**
   * Run one core request through the controller. The promise never rejects: core does
   * not handle a rejection. It settles after the catalog commit and the next projection.
   * Requests run in order, so each one maps its name against the list that the
   * previous request left. Two quick saves of a new name create one record.
   */
  private route(link: Link, operation: () => Promise<unknown>): Promise<void> {
    this.routed += 1;
    const request = this.requests
      .then(() => this.execute(link, operation))
      .catch((error: unknown) => {
        console.error('Workspaces could not complete a core Workspaces request.', error);
      })
      .finally(() => {
        this.routed -= 1;
      });
    this.requests = request;
    return request;
  }

  private async execute(link: Link, operation: () => Promise<unknown>): Promise<void> {
    try {
      if (!link.reconciled) await this.synchronize();
      if (this.link !== link) return;
      if (!link.reconciled)
        throw new Error(
          this.controller.state.journal
            ? RECOVERY_REQUIRED
            : 'The core Workspaces list is not matched with Workspaces yet. Try again.',
        );
      await operation();
    } catch (error) {
      this.options.notify(errorMessage(error));
    } finally {
      if (this.link === link) {
        await this.synchronize();
        // Before reconciliation nothing is projected, so withdraw a pending entry here.
        if (this.link === link && !link.reconciled) this.revert(link);
      }
    }
  }

  private schedule(): void {
    if (!this.started || this.timer !== null) return;
    // A timer task, not a microtask: a microtask would run before the caller of the
    // controller promise observes its settlement. One timer collects a burst.
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.started) return;
      if (!this.eventDriven) this.evaluate();
      void this.flush();
    }, this.options.delayMs ?? PROJECTION_DELAY_MS);
  }

  private idle(): Promise<void> {
    if (this.controller.busy === null || !this.link) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        if (this.controller.busy !== null && this.link) return;
        unsubscribe();
        this.waiters.delete(done);
        resolve();
      };
      const unsubscribe = this.controller.subscribe(done);
      // Detaching resolves the waiter; a disposed controller no longer notifies.
      this.waiters.add(done);
    });
  }

  /** Wait for the controller to be idle, then reconcile and project. */
  private async synchronize(): Promise<void> {
    await this.idle();
    await this.flush();
  }

  private flush(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.pass();
        } while (this.rerun);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    const link = this.link;
    // A busy controller notifies again when it is idle. Never project inside an operation.
    if (!link || this.controller.busy !== null) return;
    try {
      let state = this.controller.state;
      if (!link.reconciled) {
        if (state.journal || link.persisted === null) return;
        // Use the list as core loaded it, not an entry that a routed save added since.
        const core = (JSON.parse(link.persisted) as { workspaces: ObjectValue }).workspaces;
        const device = this.controller.device;
        const plan = await this.controller.reconcileNativeCatalog((current) =>
          planReconciliation(current, device, core),
        );
        if (this.link !== link) return;
        link.reconciled = true;
        link.foreign = new Set(plan.foreign);
        const parts = [
          [plan.add.length, 'imported'],
          [plan.adopt.length, 'updated'],
          [plan.remove.length, 'removed'],
        ]
          .filter(([count]) => count)
          .map(([count, verb]) => `${count} ${verb}`);
        if (parts.length)
          this.options.notify(`Workspaces matched the core Workspaces list: ${parts.join(', ')}.`);
        if (this.controller.busy !== null) return;
        state = this.controller.state;
      }
      await this.project(link, state);
    } catch (error) {
      console.error('Workspaces could not synchronize the core Workspaces list.', error);
      if (!link.failed) {
        link.failed = true;
        this.options.notify(
          `Workspaces could not update the core Workspaces list: ${errorMessage(error)}`,
        );
      }
    }
  }

  private async project(link: Link, state: WorkspaceState): Promise<void> {
    const { instance } = link;
    const foreign: ObjectValue = {};
    for (const name of [...link.foreign]) {
      if (Object.hasOwn(instance.workspaces, name))
        setOwn(foreign, name, instance.workspaces[name]);
      else link.foreign.delete(name);
    }
    const projection = buildProjection(state, this.controller.device, foreign);
    link.ids = new Map(Object.entries(projection.names).map(([id, name]) => [name, id]));
    for (const name of link.ids.keys()) link.foreign.delete(name);
    const next = serializeCore(projection.workspaces, projection.active);
    if (next !== serializeCore(instance.workspaces, instance.activeWorkspace)) {
      instance.workspaces = projection.workspaces;
      instance.activeWorkspace = projection.active;
    }
    if (next !== link.persisted) {
      link.persisted = null;
      await link.saveData.call(instance);
      // A routed save may have added an entry during the write. Write again then.
      if (serializeCore(instance.workspaces, instance.activeWorkspace) === next)
        link.persisted = next;
    }
    link.failed = false;
    // The baseline lags: it only names what the core file is known to hold.
    if (this.link !== link || link.persisted !== next) return;
    const baseline = state.nativeCatalog;
    const confirmed = baseline?.projected ?? {};
    const names = Object.entries(projection.names);
    if (
      names.length === Object.keys(confirmed).length &&
      names.every(([id, name]) => Object.hasOwn(confirmed, id) && confirmed[id] === name) &&
      !Object.keys(baseline?.retired ?? {}).length
    )
      return;
    try {
      await this.controller.confirmNativeProjection(projection.names);
    } catch (error) {
      // For example a recovery journal. The next projection pass tries again.
      console.warn('Workspaces could not record the projected core Workspaces list.', error);
    }
  }
}
