import { FileSystemAdapter, Notice, Platform, Plugin, setIcon } from 'obsidian';
import { ObsidianGitBackend } from './git/obsidian-git';
import { ObsidianWorkspaceHost } from './obsidian/layout';
import { installedPlugin } from './obsidian/plugins';
import { desktopStore, PluginStateStore } from './storage/store';
import { WorkspaceController } from './workspaces/controller';
import { contextOf } from './workspaces/model';
import { WorkspaceSwitcher } from './ui/switcher';
import { openWorkspaceMenu } from './ui/menu';
import { WorkspaceManagerModal, WorkspacesSettingTab } from './ui/settings';
import {
  bindActiveWorkspace,
  confirmDiscard,
  createWorkspace,
  ExportWorkspacesModal,
  HistoryPicker,
  ImportWorkspacesModal,
  RecoveryModal,
  runUIAction,
} from './ui/dialogs';

export default class WorkspacesPlugin extends Plugin {
  controller?: WorkspaceController;
  private status?: HTMLElement;
  private ready = false;
  private unloaded = false;

  async onload(): Promise<void> {
    const device = Platform.isMobile ? 'mobile' : 'desktop';
    const store =
      device === 'desktop' && this.app.vault.adapter instanceof FileSystemAdapter
        ? await desktopStore(this.app.vault.adapter.getBasePath())
        : new PluginStateStore(
            () => this.loadData(),
            (value) => this.saveData(value),
          );
    let state;
    try {
      state = await store.load();
    } catch (error) {
      new Notice(
        `Workspaces could not read its catalog: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
      throw error;
    }
    const controller = new WorkspaceController(
      state,
      store,
      new ObsidianWorkspaceHost(this.app, (name) => confirmDiscard(this.app, name)),
      new ObsidianGitBackend({
        resolvePlugin: () => installedPlugin(this.app, 'obsidian-git'),
        isDesktop: () => !Platform.isMobile,
        checkoutGuard:
          this.app.vault.adapter instanceof FileSystemAdapter
            ? {
                vaultPath: this.app.vault.adapter.getBasePath(),
                configDir: this.app.vault.configDir,
                pluginId: this.manifest.id,
              }
            : undefined,
      }),
      device,
    );
    this.controller = controller;
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.ready = true;
      this.registerInterface(controller);
      if (controller.state.journal)
        new Notice(
          'Workspaces found an interrupted switch. Use “Recover interrupted switch” to restore the previous context.',
          0,
        );
    });
  }

  /** No mutating UI surface exists until Obsidian has finished startup restoration. */
  private registerInterface(controller: WorkspaceController): void {
    this.addSettingTab(new WorkspacesSettingTab(this.app, this, controller));
    const actions = {
      manage: () => new WorkspaceManagerModal(this.app, controller).open(),
      create: () => {
        if (this.ready) void createWorkspace(this.app, controller);
      },
      switcher: () => {
        if (this.ready) new WorkspaceSwitcher(this.app, controller).open();
      },
      recover: () => new RecoveryModal(this.app, controller).open(),
    };
    this.addRibbonIcon('panels-top-left', 'Workspaces', (event) =>
      openWorkspaceMenu(controller, event, actions),
    );
    this.status = this.addStatusBarItem();
    this.status.addClass('workspaces-status');
    this.registerDomEvent(this.status, 'click', (event) =>
      openWorkspaceMenu(controller, event, actions),
    );
    this.registerDomEvent(this.status, 'contextmenu', (event) => {
      event.preventDefault();
      actions.manage();
    });
    this.register(controller.subscribe(() => this.renderStatus()));
    this.renderStatus();
    const command = (id: string, name: string, callback: () => void): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          if (!this.ready || controller.busy) return false;
          if (!checking) callback();
          return true;
        },
      });
    };
    command('switch', 'Switch workspace', actions.switcher);
    command('create', 'Create workspace from current layout', actions.create);
    command('save', 'Save current workspace', () => {
      void runUIAction(() => controller.saveActive(), 'Saved workspace layout.');
    });
    command('manage', 'Manage workspaces', actions.manage);
    command('bind-branch', 'Bind current workspace to current Git branch', () => {
      void bindActiveWorkspace(this.app, controller);
    });
    command('history', 'Restore workspace history', () => {
      const id = controller.state.activeId;
      if (id) new HistoryPicker(this.app, controller, id).open();
      else new Notice('Create or activate a workspace first.');
    });
    command('import', 'Import workspaces', () =>
      new ImportWorkspacesModal(this.app, controller).open(),
    );
    command('export', 'Export workspaces', () =>
      new ExportWorkspacesModal(this.app, controller).open(),
    );
    command('recover', 'Recover interrupted switch', actions.recover);
  }

  private renderStatus(): void {
    if (!this.status || !this.controller) return;
    const controller = this.controller;
    const state = controller.state;
    const workspace = state.activeId ? state.workspaces[state.activeId] : null;
    const binding = workspace ? contextOf(workspace, controller.device).binding : null;
    const label =
      controller.busy ?? (state.journal ? 'Recovery required' : (workspace?.name ?? 'Workspaces'));
    this.status.empty();
    const icon = this.status.createSpan({ cls: 'workspaces-context-icon' });
    setIcon(icon, state.journal ? 'triangle-alert' : 'panels-top-left');
    this.status.createSpan({ text: binding ? `${label} · ${binding.branch}` : label });
    this.status.setAttribute('aria-label', 'Open Workspaces menu');
    this.status.setAttribute(
      'title',
      binding ? `${label} — saved branch: ${binding.branch}` : label,
    );
  }

  onunload(): void {
    this.unloaded = true;
    this.ready = false;
    this.controller?.dispose();
  }
}
