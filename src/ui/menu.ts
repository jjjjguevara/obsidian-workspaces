import { App, Menu } from 'obsidian';
import { WorkspaceController } from '../workspaces/controller';
import { orderedWorkspaces } from '../workspaces/catalog';
import { contextOf } from '../workspaces/model';
import {
  HistoryPicker,
  WorkspaceDetailsModal,
  bindActiveWorkspace,
  deleteWorkspace,
  runUIAction,
  unbindWorkspace,
} from './dialogs';

export interface WorkspaceMenuActions {
  manage: () => void;
  create: () => void;
  switcher: () => void;
  recover?: () => void;
}

/** Adapted from jsmorabito/obsidian-workspaces-plus@dfdb79c0/src/workspaceMenu.ts
 * (GPL-3.0). Modified 2026-11-13: stable IDs and awaited controller operations
 * replace the core Workspaces catalog and direct loadWorkspace calls. */
export function openWorkspaceMenu(
  controller: WorkspaceController,
  event: MouseEvent,
  actions: WorkspaceMenuActions,
): void {
  const menu = new Menu();
  const state = controller.state;
  const unavailable = !!controller.busy || !!state.journal;
  for (const workspace of orderedWorkspaces(state)) {
    const binding = contextOf(workspace, controller.device).binding;
    menu.addItem((item) =>
      item
        .setTitle(workspace.group ? `${workspace.group} / ${workspace.name}` : workspace.name)
        .setIcon(workspace.icon || 'panels-top-left')
        .setChecked(workspace.id === state.activeId)
        .setDisabled(unavailable || (controller.device === 'mobile' && !!binding))
        .onClick(() => {
          void runUIAction(() => controller.activate(workspace.id));
        }),
    );
  }
  if (state.order.length) menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle('Search workspaces…')
      .setIcon('search')
      .setDisabled(unavailable)
      .onClick(actions.switcher),
  );
  menu.addItem((item) =>
    item
      .setTitle('Create workspace…')
      .setIcon('plus')
      .setDisabled(unavailable)
      .onClick(actions.create),
  );
  menu.addItem((item) =>
    item
      .setTitle('Save current workspace')
      .setIcon('save')
      .setDisabled(unavailable || !state.activeId)
      .onClick(() => {
        void runUIAction(() => controller.saveActive(), 'Saved workspace layout.');
      }),
  );
  menu.addItem((item) =>
    item.setTitle('Manage workspaces…').setIcon('settings-2').onClick(actions.manage),
  );
  if (state.journal && actions.recover) {
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('Recover interrupted switch…')
        .setIcon('rotate-ccw')
        .setDisabled(!!controller.busy)
        .onClick(actions.recover!),
    );
  }
  menu.showAtMouseEvent(event);
}

export function openWorkspaceActions(
  app: App,
  controller: WorkspaceController,
  id: string,
  event: MouseEvent,
): void {
  const state = controller.state;
  const workspace = state.workspaces[id];
  if (!workspace) return;
  const menu = new Menu();
  const unavailable = !!controller.busy || !!state.journal;
  const binding = contextOf(workspace, controller.device).binding;
  const hasBinding = Object.values(workspace.contexts).some((context) => !!context?.binding);
  menu.addItem((item) => item.setTitle(workspace.name).setIsLabel(true));
  menu.addItem((item) =>
    item
      .setTitle('Open workspace')
      .setIcon('panels-top-left')
      .setDisabled(
        unavailable || state.activeId === id || (controller.device === 'mobile' && !!binding),
      )
      .onClick(() => {
        void runUIAction(() => controller.activate(id));
      }),
  );
  menu.addItem((item) =>
    item
      .setTitle('Edit details…')
      .setIcon('pencil')
      .setDisabled(unavailable)
      .onClick(() => new WorkspaceDetailsModal(app, controller, id).open()),
  );
  menu.addItem((item) =>
    item
      .setTitle('Duplicate workspace')
      .setIcon('copy')
      .setDisabled(unavailable)
      .onClick(() => {
        void runUIAction(() => controller.duplicate(id), 'Duplicated workspace.');
      }),
  );
  menu.addItem((item) =>
    item
      .setTitle('Restore saved history…')
      .setIcon('history')
      .setDisabled(unavailable || !workspace.history.length)
      .onClick(() => new HistoryPicker(app, controller, id).open()),
  );
  if (state.activeId === id && controller.device === 'desktop') {
    menu.addItem((item) =>
      item
        .setTitle(binding ? 'Rebind to the current branch…' : 'Bind the current branch…')
        .setIcon('git-branch')
        .setDisabled(unavailable)
        .onClick(() => {
          void bindActiveWorkspace(app, controller);
        }),
    );
  }
  if (hasBinding) {
    menu.addItem((item) =>
      item
        .setTitle('Remove branch binding…')
        .setIcon('unlink')
        .setDisabled(unavailable)
        .onClick(() => {
          void unbindWorkspace(app, controller, id);
        }),
    );
  }
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle('Delete workspace…')
      .setIcon('trash-2')
      .setWarning(true)
      .setDisabled(unavailable)
      .onClick(() => {
        void deleteWorkspace(app, controller, id);
      }),
  );
  menu.showAtMouseEvent(event);
}
