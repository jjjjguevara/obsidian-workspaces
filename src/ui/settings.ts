import {
  App,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
  type SettingGroupItem,
} from 'obsidian';
import { WorkspaceController } from '../workspaces/controller';
import { orderedWorkspaces } from '../workspaces/catalog';
import { contextOf, type WorkspaceRecord } from '../workspaces/model';
import {
  ExportWorkspacesModal,
  ImportWorkspacesModal,
  RecoveryModal,
  WorkspaceDetailsModal,
  applyWorkspaceIcon,
  bindActiveWorkspace,
  createWorkspace,
  importCoreWorkspaces,
  runUIAction,
  workspaceDetail,
} from './dialogs';
import { openWorkspaceActions } from './menu';
import { WorkspaceSwitcher } from './switcher';

function locked(controller: WorkspaceController): boolean {
  return !!controller.busy || !!controller.state.journal;
}

function addWorkspaceControls(
  setting: Setting,
  app: App,
  controller: WorkspaceController,
  workspace: WorkspaceRecord,
): void {
  const state = controller.state;
  const binding = contextOf(workspace, controller.device).binding;
  const icon = setting.nameEl.createSpan({
    cls: 'workspaces-context-icon',
    attr: { 'aria-hidden': 'true' },
  });
  setting.nameEl.prepend(icon);
  setting.nameEl.addClass('workspaces-context-row');
  applyWorkspaceIcon(icon, workspace);
  setting
    .addButton((button) =>
      button
        .setButtonText(state.activeId === workspace.id ? 'Current' : 'Open')
        .setDisabled(
          locked(controller) ||
            state.activeId === workspace.id ||
            (controller.device === 'mobile' && !!binding),
        )
        .onClick(() => runUIAction(() => controller.activate(workspace.id))),
    )
    .addButton((button) =>
      button
        .setIcon('pencil')
        .setTooltip('Edit workspace details')
        .setDisabled(locked(controller))
        .onClick(() => new WorkspaceDetailsModal(app, controller, workspace.id).open()),
    )
    .addButton((button) =>
      button
        .setIcon('more-horizontal')
        .setTooltip('Workspace actions')
        .setDisabled(!!controller.busy)
        .onClick((event) => openWorkspaceActions(app, controller, workspace.id, event)),
    );
}

/** Native searchable settings use Obsidian 1.13's definition API. Mutable
 * values are always read/written through the controller, never plugin.settings. */
export class WorkspacesSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly controller: WorkspaceController,
    /** True while the core Workspaces list is a projection of this catalog. */
    private readonly coreLinked: () => boolean = () => false,
  ) {
    super(app, plugin);
    plugin.register(controller.subscribe(() => this.update()));
  }

  override getControlValue(key: string): unknown {
    return key === 'autoSave' ? this.controller.state.autoSave : undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key !== 'autoSave' || typeof value !== 'boolean') return;
    await runUIAction(() => this.controller.setAutoSave(value));
    this.update();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const state = this.controller.state;
    const active = state.activeId ? state.workspaces[state.activeId] : undefined;
    const binding = active ? contextOf(active, this.controller.device).binding : null;
    const items: SettingGroupItem[] = orderedWorkspaces(state).map((workspace) => ({
      name: workspace.name,
      desc: workspaceDetail(workspace, this.controller.device),
      aliases: [workspace.group, workspace.description].filter(Boolean),
      render: (setting) => addWorkspaceControls(setting, this.app, this.controller, workspace),
    }));
    return [
      {
        type: 'group',
        heading: 'Workspace behavior',
        items: [
          {
            name: 'Save on switch',
            desc: 'Save the outgoing layout before opening another workspace. This does not create a Git commit.',
            control: { type: 'toggle', key: 'autoSave', disabled: () => locked(this.controller) },
          },
          {
            name: 'Search workspaces',
            desc: 'Choose a workspace using the native fuzzy switcher.',
            disabled: () => locked(this.controller),
            action: () => new WorkspaceSwitcher(this.app, this.controller).open(),
          },
          {
            name: 'Save current workspace',
            desc: active
              ? `Save the current layout of “${active.name}”.`
              : 'Create or open a workspace first.',
            disabled: () => locked(this.controller) || !this.controller.state.activeId,
            action: () => {
              void runUIAction(() => this.controller.saveActive(), 'Saved workspace layout.');
            },
          },
        ],
      },
      {
        type: 'list',
        heading: 'Workspaces',
        items,
        emptyState: 'No saved workspaces yet.',
        addItem: locked(this.controller)
          ? undefined
          : {
              name: 'Create workspace',
              action: () => {
                void createWorkspace(this.app, this.controller);
              },
            },
      },
      {
        type: 'group',
        heading: 'Git context',
        items:
          this.controller.device === 'desktop'
            ? [
                {
                  name: active?.name ?? 'No active workspace',
                  desc: binding
                    ? `Saved branch: ${binding.branch}\nRepository: ${binding.root}`
                    : 'The active workspace has no branch binding.',
                },
                {
                  name: binding ? 'Rebind to the current branch' : 'Bind the current branch',
                  desc: 'Save the current layout with the local branch that is checked out. Requires Obsidian Git 2.43.x.',
                  disabled: () => locked(this.controller) || !this.controller.state.activeId,
                  action: () => {
                    void bindActiveWorkspace(this.app, this.controller);
                  },
                },
              ]
            : [
                {
                  name: 'Unbound workspaces on mobile',
                  desc: 'Branch switching is available on desktop. Use a workspace without a Git binding on this device.',
                },
              ],
      },
      {
        type: 'group',
        heading: 'Import and export',
        items: [
          {
            name: 'Import workspace JSON',
            desc: 'Add a Workspaces export, core Workspaces file, or Workspace++ session data.',
            disabled: () => locked(this.controller),
            action: () => new ImportWorkspacesModal(this.app, this.controller).open(),
          },
          {
            name: 'Import this vault’s core workspaces',
            desc: this.coreLinked()
              ? 'Core Workspaces is enabled, so its list already matches this catalog. Use this action when core Workspaces is disabled.'
              : 'Read the existing core Workspaces data without changing it or activating a branch.',
            disabled: () => locked(this.controller) || this.coreLinked(),
            action: () => {
              void importCoreWorkspaces(this.app, this.controller);
            },
          },
          {
            name: 'Export workspace snapshot',
            desc: 'Copy or download saved contexts, metadata, and history.',
            action: () => new ExportWorkspacesModal(this.app, this.controller).open(),
          },
        ],
      },
      {
        type: 'group',
        heading: 'Recovery',
        visible: () => !!this.controller.state.journal,
        items: [
          {
            name: 'Recover interrupted switch',
            desc:
              state.journal?.error ??
              'Restore the previous context after an interrupted switch. Startup does not change branches automatically.',
            disabled: () => !!this.controller.busy,
            action: () => new RecoveryModal(this.app, this.controller).open(),
          },
        ],
      },
      {
        type: 'group',
        heading: 'Storage',
        items: [
          {
            name: 'Workspace data',
            desc:
              this.controller.storageLocation ??
              'Stored in this plugin’s data file on mobile. External sync tools may copy that file.',
          },
          {
            name: 'Transfer between devices',
            desc: 'Use explicit export/import. This version does not merge workspace edits across devices.',
          },
        ],
      },
    ];
  }
}

/** The manage command can open this native dialog without reaching into
 * Obsidian's private settings navigation API. */
export class WorkspaceManagerModal extends Modal {
  private unsubscribe?: () => void;
  constructor(
    app: App,
    private readonly controller: WorkspaceController,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle('Manage workspaces');
    this.render();
    this.unsubscribe = this.controller.subscribe(() => this.render());
  }
  private render(): void {
    this.contentEl.empty();
    const state = this.controller.state;
    if (this.controller.busy)
      this.contentEl.createEl('p', { text: `${this.controller.busy}…`, attr: { role: 'status' } });
    if (state.journal) {
      new Setting(this.contentEl)
        .setName('Interrupted switch')
        .setDesc(state.journal.error ?? 'Recovery is required before changing workspaces.')
        .addButton((button) =>
          button
            .setButtonText('Review recovery')
            .setCta()
            .setDisabled(!!this.controller.busy)
            .onClick(() => new RecoveryModal(this.app, this.controller).open()),
        );
    }
    new Setting(this.contentEl)
      .setName('Save on switch')
      .setDesc('Save the outgoing layout before switching. Note changes are not committed to Git.')
      .addToggle((toggle) =>
        toggle
          .setValue(state.autoSave)
          .setDisabled(locked(this.controller))
          .onChange((value) => {
            void runUIAction(() => this.controller.setAutoSave(value));
          }),
      );
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText('Create workspace')
          .setCta()
          .setDisabled(locked(this.controller))
          .onClick(() => createWorkspace(this.app, this.controller)),
      )
      .addButton((button) =>
        button
          .setButtonText('Search')
          .setDisabled(locked(this.controller))
          .onClick(() => new WorkspaceSwitcher(this.app, this.controller).open()),
      );
    const records = orderedWorkspaces(state);
    if (!records.length)
      this.contentEl.createEl('p', {
        text: 'Create a workspace to save the current notes, pins, and layout.',
      });
    for (const workspace of records) {
      const setting = new Setting(this.contentEl)
        .setName(workspace.name)
        .setDesc(workspaceDetail(workspace, this.controller.device));
      addWorkspaceControls(setting, this.app, this.controller, workspace);
    }
    new Setting(this.contentEl)
      .setName('Transfer workspaces')
      .addButton((button) =>
        button
          .setButtonText('Import JSON')
          .setDisabled(locked(this.controller))
          .onClick(() => new ImportWorkspacesModal(this.app, this.controller).open()),
      )
      .addButton((button) =>
        button
          .setButtonText('Export JSON')
          .onClick(() => new ExportWorkspacesModal(this.app, this.controller).open()),
      );
  }
  override onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
  }
}
