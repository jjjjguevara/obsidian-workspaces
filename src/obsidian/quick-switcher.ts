import { Notice, prepareFuzzySearch, type App, type SearchResult } from 'obsidian';
import { orderedWorkspaces } from '../workspaces/catalog';
import type { WorkspaceController } from '../workspaces/controller';
import { contextOf } from '../workspaces/model';

/** Original compatibility adapter for darlal/obsidian-switcher-plus@ca9d8745.
 * Quick Switcher++ 6.3.0's WorkspaceHandler also serves its save-and-switch keymap.
 * Only that provider is adapted; the native core Workspaces catalog is untouched.
 */
export const QUICK_SWITCHER_ID = 'darlal-switcher-plus';
const ownSuggestion = Symbol('obsidian-workspaces.quick-switcher');
type ObjectValue = Record<string, unknown>;
type Method = (this: unknown, ...args: unknown[]) => unknown;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object';
const method = (value: unknown): value is Method => typeof value === 'function';
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Suggestion {
  type: 'workspaceList';
  item: {
    type: 'workspaceInfo';
    id: string;
    name: string;
    label: string;
    detail: string;
    [ownSuggestion]: object;
  };
  match: SearchResult | null;
}

/** Preserve descriptors and never overwrite a later plugin's wrapper on teardown. */
function replace(target: object, key: string, factory: (original: Method) => Method): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const original = Reflect.get(target, key);
  if (!method(original)) throw new Error(`Quick Switcher++ is missing ${key}.`);
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

export class QuickSwitcherIntegration {
  private active = false;
  private provider: ObjectValue | null = null;
  private providerCleanup: Array<() => void> = [];
  private managerCleanup: Array<() => void> = [];
  private warned = new WeakSet<object>();

  constructor(
    private readonly app: App,
    private readonly controller: WorkspaceController,
    private readonly notify: (message: string) => void = (message) => {
      new Notice(message);
    },
  ) {}

  start(): void {
    if (this.active) return;
    const manager = (this.app as unknown as { plugins?: unknown }).plugins;
    if (
      !object(manager) ||
      !method(manager.getPlugin) ||
      !method(manager.loadPlugin) ||
      !method(manager.unloadPlugin)
    ) {
      this.notify(
        'Quick Switcher++ integration is unavailable: Obsidian plugin lifecycle access is missing.',
      );
      return;
    }
    this.active = true;
    const integration = this;
    try {
      this.managerCleanup.push(
        replace(
          manager,
          'loadPlugin',
          (original) =>
            async function (...args) {
              const result = await original.apply(this, args);
              if (integration.active && args[0] === QUICK_SWITCHER_ID)
                integration.reconcile(manager);
              return result;
            },
        ),
      );
      this.managerCleanup.push(
        replace(
          manager,
          'unloadPlugin',
          (original) =>
            async function (...args) {
              if (integration.active && args[0] === QUICK_SWITCHER_ID) integration.detach();
              try {
                return await original.apply(this, args);
              } catch (error) {
                if (integration.active && args[0] === QUICK_SWITCHER_ID)
                  integration.reconcile(manager);
                throw error;
              }
            },
        ),
      );
      this.reconcile(manager);
    } catch (error) {
      this.dispose();
      this.notify(`Quick Switcher++ integration could not start: ${errorMessage(error)}`);
    }
  }

  dispose(): void {
    this.active = false;
    this.detach();
    this.restoreAll(this.managerCleanup);
  }

  private restoreAll(cleanup: Array<() => void>): void {
    for (const restore of cleanup.splice(0).reverse()) {
      try {
        restore();
      } catch (error) {
        console.warn('Workspaces could not restore a Quick Switcher++ integration hook.', error);
      }
    }
  }

  private closeWorkspaceModal(provider: ObjectValue): void {
    const modal = provider.activeModal;
    if (!object(modal)) return;
    const definitions = provider.commandDefinitions;
    const definition = Array.isArray(definitions)
      ? definitions.find(
          (value: unknown) => object(value) && value.commandId === 'switcher-plus:open-workspaces',
        )
      : undefined;
    const exMode = modal.exMode;
    const inputInfo = object(exMode) ? exMode.inputInfo : undefined;
    const chooser = modal.chooser;
    const values = object(chooser) ? chooser.values : undefined;
    const hasWorkspaceRows =
      Array.isArray(values) &&
      values.some((value: unknown) => object(value) && value.type === 'workspaceList');
    if (
      (hasWorkspaceRows ||
        (object(inputInfo) && object(definition) && inputInfo.mode === definition.mode)) &&
      method(modal.close)
    )
      modal.close();
  }

  private detach(): void {
    const previous = this.provider;
    this.provider = null;
    try {
      if (previous) this.closeWorkspaceModal(previous);
    } catch (error) {
      console.warn(
        'Workspaces could not close the previous Quick Switcher++ workspace list.',
        error,
      );
    } finally {
      this.restoreAll(this.providerCleanup);
    }
  }

  private reconcile(manager: ObjectValue): void {
    const candidate = (manager.getPlugin as Method).call(manager, QUICK_SWITCHER_ID);
    if (candidate === this.provider) return;
    this.detach();
    if (!object(candidate)) return;
    try {
      const manifest = candidate.manifest;
      if (
        !object(manifest) ||
        manifest.id !== QUICK_SWITCHER_ID ||
        typeof manifest.version !== 'string' ||
        !/^6\.3\.\d+$/.test(manifest.version)
      )
        throw new Error('Use Quick Switcher++ 6.3.x; this integration was tested with 6.3.0.');
      const definitions = candidate.commandDefinitions;
      const definition = Array.isArray(definitions)
        ? definitions.find(
            (value: unknown) =>
              object(value) && value.commandId === 'switcher-plus:open-workspaces',
          )
        : undefined;
      const handler = object(definition) ? definition.handlerClass : undefined;
      if (
        !method(handler) ||
        !object(handler.prototype) ||
        !object(definition) ||
        typeof definition.mode !== 'number'
      )
        throw new Error('The workspace handler is unavailable.');
      const prototype = handler.prototype;
      for (const key of [
        'getSuggestions',
        'renderSuggestion',
        'onChooseSuggestion',
        'onNoResultsCreateAction',
        'addClassesToSuggestionContainer',
        'renderContent',
      ])
        if (!method(prototype[key])) throw new Error(`The workspace handler is missing ${key}.`);
      if (!method(Reflect.get(handler, 'getEnabledWorkspacesPluginInstance')))
        throw new Error('The workspace provider resolver is unavailable.');

      // Invalidate any core-name suggestions before exposing the stable-ID catalog.
      this.closeWorkspaceModal(candidate);
      this.provider = candidate;
      const integration = this;
      const generation = {};
      const current = () => integration.active && integration.provider === candidate;
      const owns = (suggestion: unknown): suggestion is Suggestion =>
        object(suggestion) &&
        object(suggestion.item) &&
        Reflect.get(suggestion.item, ownSuggestion) === generation;
      const rejectStale = () =>
        integration.notify('The workspace list changed. Reopen Quick Switcher++ and choose again.');
      const run = (operation: () => Promise<unknown>): void => {
        if (!current()) {
          rejectStale();
          return;
        }
        void Promise.resolve()
          .then(() => {
            if (!current())
              throw new Error('Workspaces was disabled or Quick Switcher++ was reloaded.');
            return operation();
          })
          .catch((error: unknown) => integration.notify(errorMessage(error)));
      };
      this.providerCleanup.push(
        replace(
          handler,
          'getEnabledWorkspacesPluginInstance',
          (original) =>
            function (app, ...args) {
              if (app !== integration.app || !current()) return original.call(this, app, ...args);
              // Each resolver call has its own save intent; upstream calls save then load
              // synchronously and does not await promises from either operation.
              const sourceId = integration.controller.state.activeId;
              let saveRequested = false;
              let saveSource: unknown = sourceId;
              return {
                get activeWorkspace() {
                  return sourceId;
                },
                get workspaces() {
                  return integration.controller.state.workspaces;
                },
                saveWorkspace(id: unknown) {
                  saveRequested = true;
                  saveSource = id;
                },
                loadWorkspace(id: unknown) {
                  run(async () => {
                    if (typeof id !== 'string') throw new Error('Choose a saved workspace.');
                    if (saveRequested) {
                      if (saveSource !== sourceId)
                        throw new Error('The active workspace changed. Choose again.');
                      await integration.controller.saveAndActivate(id, sourceId);
                    } else await integration.controller.activate(id);
                  });
                },
              };
            },
        ),
      );
      this.providerCleanup.push(
        replace(
          prototype,
          'getSuggestions',
          (original) =>
            function (input, ...args) {
              if (!object(this) || this.app !== integration.app || !current())
                return original.call(this, input, ...args);
              if (!object(input)) return [];
              const parsed = input.parsedInputQuery;
              const query = object(parsed) && typeof parsed.query === 'string' ? parsed.query : '';
              const search = query.trim() ? prepareFuzzySearch(query) : null;
              const suggestions: Suggestion[] = [];
              for (const record of orderedWorkspaces(integration.controller.state)) {
                const label = record.group ? `${record.group} / ${record.name}` : record.name;
                const binding = contextOf(record, integration.controller.device).binding;
                const detail = [
                  binding ? `Branch: ${binding.branch}` : 'No branch binding',
                  record.description,
                ]
                  .filter(Boolean)
                  .join(' · ');
                const match = search?.(label) ?? null;
                if (search && !match && !search(detail)) continue;
                suggestions.push({
                  type: 'workspaceList',
                  item: {
                    type: 'workspaceInfo',
                    id: record.id,
                    name: record.name,
                    label,
                    detail,
                    [ownSuggestion]: generation,
                  },
                  match,
                });
              }
              if (search)
                suggestions.sort(
                  (a, b) => (b.match?.score ?? -Infinity) - (a.match?.score ?? -Infinity),
                );
              return suggestions;
            },
        ),
      );
      this.providerCleanup.push(
        replace(
          prototype,
          'renderSuggestion',
          (original) =>
            function (suggestion, parent, ...args) {
              if (!owns(suggestion)) return original.call(this, suggestion, parent, ...args);
              if (!object(this) || this.app !== integration.app || !current()) return true;
              const host = this as {
                addClassesToSuggestionContainer: (element: unknown, classes: string[]) => void;
                renderContent: (
                  element: unknown,
                  text: string,
                  match: SearchResult | null,
                ) => HTMLElement;
              };
              host.addClassesToSuggestionContainer(parent, ['qsp-suggestion-workspace']);
              const content = host.renderContent(parent, suggestion.item.label, suggestion.match);
              content.createDiv({
                cls: 'suggestion-note',
                text: suggestion.item.detail,
              });
              return true;
            },
        ),
      );
      this.providerCleanup.push(
        replace(
          prototype,
          'onChooseSuggestion',
          (original) =>
            function (suggestion, ...args) {
              if (owns(suggestion)) {
                if (!object(this) || this.app !== integration.app) {
                  rejectStale();
                  return true;
                }
                run(() => integration.controller.activate(suggestion.item.id));
                return true;
              }
              if (object(this) && this.app === integration.app && current()) {
                rejectStale();
                return true;
              }
              return original.call(this, suggestion, ...args);
            },
        ),
      );
      this.providerCleanup.push(
        replace(
          prototype,
          'onNoResultsCreateAction',
          (original) =>
            function (input, ...args) {
              if (!object(this) || this.app !== integration.app || !current())
                return original.call(this, input, ...args);
              const command =
                object(input) && method(input.parsedCommand)
                  ? input.parsedCommand(definition.mode)
                  : null;
              const name =
                object(command) && typeof command.parsedInput === 'string'
                  ? command.parsedInput
                  : '';
              run(() => integration.controller.create(name));
              return true;
            },
        ),
      );
    } catch (error) {
      this.detach();
      if (!this.warned.has(candidate)) {
        this.warned.add(candidate);
        this.notify(
          `Quick Switcher++ workspace integration is unavailable: ${errorMessage(error)}`,
        );
      }
    }
  }
}
