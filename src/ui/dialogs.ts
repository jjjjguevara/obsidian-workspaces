import {
  App,
  ButtonComponent,
  FuzzySuggestModal,
  Modal,
  Notice,
  Setting,
  normalizePath,
  setIcon,
  type ColorComponent,
  type FuzzyMatch,
} from 'obsidian';
import { WorkspaceController, type WorkspaceMetadata } from '../workspaces/controller';
import { contextOf, type Device, type Snapshot, type WorkspaceRecord } from '../workspaces/model';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runUIAction(
  action: () => Promise<unknown>,
  success?: string,
): Promise<boolean> {
  try {
    await action();
    if (success) new Notice(success);
    return true;
  } catch (error) {
    new Notice(errorMessage(error), 8000);
    return false;
  }
}

export function workspaceDetail(workspace: WorkspaceRecord, device: Device): string {
  const context = contextOf(workspace, device);
  const parts = [
    workspace.group,
    context.binding ? `Branch: ${context.binding.branch}` : 'No branch binding',
  ];
  if (context.device !== device)
    parts.push(`Uses ${context.device} notes with this device's sidebars`);
  if (workspace.description) parts.push(workspace.description);
  return parts.filter(Boolean).join(' · ');
}

/** Native icon treatment adapted from jsmorabito/obsidian-workspaces-plus@dfdb79c0,
 * src/settings.ts (GPL-3.0). Modified 2026-11-13 to use stable-ID workspace records. */
export function applyWorkspaceIcon(element: HTMLElement, workspace: WorkspaceRecord): void {
  setIcon(element, workspace.icon || 'panels-top-left');
  if (workspace.color) element.style.color = workspace.color;
  else element.style.removeProperty('color');
}

interface Confirmation {
  title: string;
  message: string;
  action: string;
  cancel?: string;
  destructive?: boolean;
}

class ConfirmationModal extends Modal {
  private answered = false;
  constructor(
    app: App,
    private readonly options: Confirmation,
    private readonly answer: (value: boolean) => void,
  ) {
    super(app);
  }
  private finish(value: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.answer(value);
    this.close();
  }
  override onOpen(): void {
    this.setTitle(this.options.title);
    this.contentEl.createEl('p', { text: this.options.message });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(this.options.cancel ?? 'Cancel').onClick(() => this.finish(false)),
      )
      .addButton((button) => {
        button.setButtonText(this.options.action);
        if (this.options.destructive) button.setWarning();
        else button.setCta();
        button.onClick(() => this.finish(true));
      });
  }
  override onClose(): void {
    if (!this.answered) {
      this.answered = true;
      this.answer(false);
    }
    this.contentEl.empty();
  }
}

function confirm(app: App, options: Confirmation): Promise<boolean> {
  return new Promise((resolve) => new ConfirmationModal(app, options, resolve).open());
}

class WorkspaceNameModal extends Modal {
  private answered = false;
  private name = '';
  constructor(
    app: App,
    private readonly answer: (value: string | null) => void,
  ) {
    super(app);
  }
  private submit(): void {
    const name = this.name.trim();
    if (!name) {
      new Notice('Enter a workspace name.');
      return;
    }
    if (this.answered) return;
    this.answered = true;
    this.answer(name);
    this.close();
  }
  override onOpen(): void {
    this.setTitle('Create workspace');
    this.contentEl.createEl('p', {
      text: 'Save the current notes, pins, and layout as a new workspace.',
    });
    let input: HTMLInputElement | undefined;
    new Setting(this.contentEl).setName('Name').addText((text) => {
      input = text.inputEl;
      text.setPlaceholder('Workspace name').onChange((value) => {
        this.name = value;
      });
      text.inputEl.setAttribute('aria-label', 'Workspace name');
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('Create')
          .setCta()
          .onClick(() => this.submit()),
      );
    this.scope.register([], 'Enter', (event) => {
      event.preventDefault();
      this.submit();
      return false;
    });
    input?.focus();
  }
  override onClose(): void {
    if (!this.answered) {
      this.answered = true;
      this.answer(null);
    }
    this.contentEl.empty();
  }
}

export function promptWorkspaceName(app: App): Promise<string | null> {
  return new Promise((resolve) => new WorkspaceNameModal(app, resolve).open());
}

export async function createWorkspace(app: App, controller: WorkspaceController): Promise<void> {
  const name = await promptWorkspaceName(app);
  if (name !== null)
    await runUIAction(() => controller.create(name), `Created workspace “${name}”.`);
}

export function confirmDiscard(app: App, name: string): Promise<boolean> {
  return confirm(app, {
    title: 'Unsaved layout changes',
    message: `“${name}” has layout changes that have not been saved to the workspace. Switch without updating its saved layout? Your note contents are handled separately.`,
    action: 'Switch without saving layout',
    cancel: 'Keep current workspace',
  });
}

export async function deleteWorkspace(
  app: App,
  controller: WorkspaceController,
  id: string,
): Promise<void> {
  const state = controller.state;
  const workspace = state.workspaces[id];
  if (!workspace) {
    new Notice('That workspace no longer exists.');
    return;
  }
  let message = `Delete “${workspace.name}” and its saved history? This cannot be undone here. Your note files will remain.`;
  if (state.activeId === id) {
    const nextId = state.order.find((candidate) => candidate !== id);
    const next = nextId ? state.workspaces[nextId] : undefined;
    if (next) {
      const binding = contextOf(next, controller.device).binding;
      message += ` The plugin will first open “${next.name}”${binding ? ` on branch “${binding.branch}”` : ''}.`;
    } else message += ' The current notes will stay open without an active saved workspace.';
  }
  if (
    !(await confirm(app, {
      title: 'Delete workspace',
      message,
      action: 'Delete workspace',
      destructive: true,
    }))
  )
    return;
  if (controller.state.revision !== state.revision) {
    new Notice('Workspaces changed while the confirmation was open. Review the deletion again.');
    return;
  }
  const ok = await runUIAction(() => controller.remove(id, state.revision));
  // Removing the active workspace may open a manual-save discard prompt. A
  // cancellation returns normally, so confirm the committed result first.
  if (ok && !Object.hasOwn(controller.state.workspaces, id))
    new Notice(`Deleted workspace “${workspace.name}”.`);
}

export async function bindActiveWorkspace(
  app: App,
  controller: WorkspaceController,
): Promise<void> {
  const state = controller.state;
  const active = state.activeId ? state.workspaces[state.activeId] : undefined;
  if (!active) {
    new Notice('Create or activate a workspace first.');
    return;
  }
  if (
    !(await confirm(app, {
      title: 'Bind the current branch',
      message: `Save the current layout of “${active.name}” with the local branch that is checked out now? Any previous saved context remains in history. No Git commit will be created.`,
      action: 'Save branch binding',
    }))
  )
    return;
  if (controller.state.activeId !== active.id) {
    new Notice('The active workspace changed. Review its branch binding again.');
    return;
  }
  await runUIAction(
    () => controller.bindActive(active.id, state.revision),
    'Saved the current branch with the workspace.',
  );
}

export async function unbindWorkspace(
  app: App,
  controller: WorkspaceController,
  id: string,
): Promise<void> {
  const state = controller.state;
  const workspace = state.workspaces[id];
  if (!workspace) {
    new Notice('That workspace no longer exists.');
    return;
  }
  if (
    !(await confirm(app, {
      title: 'Remove branch binding',
      message: `Remove the branch association from “${workspace.name}”? Its saved layouts remain. If it is active, the current layout is saved without a binding. Historical snapshots retain their original context.`,
      action: 'Remove binding',
    }))
  )
    return;
  await runUIAction(
    () => controller.unbind(id, state.revision),
    'Removed the workspace branch binding.',
  );
}

export class WorkspaceDetailsModal extends Modal {
  constructor(
    app: App,
    private readonly controller: WorkspaceController,
    private readonly id: string,
  ) {
    super(app);
  }
  override onOpen(): void {
    const state = this.controller.state;
    const record = state.workspaces[this.id];
    if (!record) {
      new Notice('That workspace no longer exists.');
      this.close();
      return;
    }
    this.setTitle('Workspace details');
    const original: WorkspaceMetadata = {
      name: record.name,
      group: record.group,
      icon: record.icon,
      color: record.color,
      description: record.description,
    };
    const draft = { ...original };
    new Setting(this.contentEl).setName('Name').addText((text) =>
      text.setValue(draft.name).onChange((value) => {
        draft.name = value;
      }),
    );
    new Setting(this.contentEl)
      .setName('Group')
      .setDesc('Use the same group name to organize related workspaces.')
      .addText((text) =>
        text
          .setValue(draft.group)
          .setPlaceholder('Optional')
          .onChange((value) => {
            draft.group = value;
          }),
      );
    new Setting(this.contentEl).setName('Description').addTextArea((text) => {
      text.setValue(draft.description).onChange((value) => {
        draft.description = value;
      });
      text.inputEl.rows = 3;
    });
    const iconSetting = new Setting(this.contentEl)
      .setName('Icon')
      .setDesc('An Obsidian Lucide icon name.');
    const preview = iconSetting.controlEl.createSpan({ cls: 'workspaces-context-icon' });
    applyWorkspaceIcon(preview, record);
    iconSetting.addText((text) =>
      text
        .setValue(draft.icon)
        .setPlaceholder('panels-top-left')
        .onChange((value) => {
          draft.icon = value;
          applyWorkspaceIcon(preview, { ...record, ...draft });
        }),
    );
    let colorPicker: ColorComponent | undefined;
    new Setting(this.contentEl)
      .setName('Icon color')
      .setDesc('Clear the color to follow the theme.')
      .addColorPicker((color) => {
        colorPicker = color;
        color
          .setValue(/^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : '#888888')
          .onChange((value) => {
            draft.color = value;
            applyWorkspaceIcon(preview, { ...record, ...draft });
          });
      })
      .addButton((button) =>
        button.setButtonText('Clear color').onClick(() => {
          draft.color = '';
          colorPicker?.setValue('#888888');
          applyWorkspaceIcon(preview, { ...record, ...draft });
        }),
      );
    new Setting(this.contentEl)
      .setName('Saved context')
      .setDesc(workspaceDetail(record, this.controller.device));
    let saveButton: ButtonComponent;
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => {
        saveButton = button;
        button
          .setButtonText('Save details')
          .setCta()
          .onClick(async () => {
            saveButton.setDisabled(true);
            const ok = await runUIAction(async () => {
              const current = this.controller.state.workspaces[this.id];
              if (!current) throw new Error('That workspace no longer exists.');
              const changes: Partial<WorkspaceMetadata> = {};
              for (const key of ['name', 'group', 'icon', 'color', 'description'] as const) {
                if (draft[key] === original[key]) continue;
                if (current[key] !== original[key])
                  throw new Error(
                    'These workspace details changed elsewhere. Reopen this dialog before saving.',
                  );
                changes[key] = draft[key];
              }
              if (Object.keys(changes).length)
                await this.controller.update(this.id, changes, state.revision);
            });
            if (ok) this.close();
            else saveButton.setDisabled(false);
          });
      });
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

interface HistoryItem {
  index: number;
  context: Snapshot;
}

export class HistoryPicker extends FuzzySuggestModal<HistoryItem> {
  private readonly entries: HistoryItem[];
  constructor(
    app: App,
    private readonly controller: WorkspaceController,
    private readonly id: string,
  ) {
    super(app);
    const record = controller.state.workspaces[id];
    this.entries = record?.history.map((context, index) => ({ index, context })) ?? [];
    this.setPlaceholder(`Restore history${record ? ` for ${record.name}` : ''}…`);
    this.emptyStateText = 'No earlier saved contexts for this workspace.';
    this.setInstructions([
      { command: '↑↓', purpose: 'select snapshot' },
      { command: '↵', purpose: 'restore context' },
      { command: 'esc', purpose: 'cancel' },
    ]);
  }
  getItems(): HistoryItem[] {
    return this.entries;
  }
  getItemText(item: HistoryItem): string {
    return `${new Date(item.context.savedAt).toLocaleString()} · ${item.context.device} · ${item.context.binding?.branch ?? 'No branch binding'}`;
  }
  override renderSuggestion(item: FuzzyMatch<HistoryItem>, element: HTMLElement): void {
    super.renderSuggestion(item, element);
    if (item.item.context.binding)
      element.createDiv({
        cls: 'workspaces-context-detail',
        text: 'Restoring this snapshot also restores its saved branch context.',
      });
  }
  onChooseItem(item: HistoryItem): void {
    const current = this.controller.state.workspaces[this.id]?.history[item.index];
    if (JSON.stringify(current) !== JSON.stringify(item.context)) {
      new Notice('Workspace history changed. Reopen history to select the current snapshot.');
      return;
    }
    void runUIAction(() => this.controller.restoreHistory(this.id, item.index));
  }
}

export class ImportWorkspacesModal extends Modal {
  constructor(
    app: App,
    private readonly controller: WorkspaceController,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle('Import workspaces');
    this.contentEl.createEl('p', {
      text: 'Import a Workspaces export, core Workspaces JSON, or Workspace++ sessions. Import adds saved contexts without opening them or changing branches.',
    });
    let json = '';
    let readGeneration = 0;
    let area: HTMLTextAreaElement;
    new Setting(this.contentEl).setName('JSON').addTextArea((text) => {
      area = text.inputEl;
      area.rows = 12;
      area.spellcheck = false;
      area.setAttribute('aria-label', 'Workspace JSON to import');
      text.setPlaceholder('Paste workspace JSON here').onChange((value) => {
        readGeneration += 1;
        json = value;
      });
    });
    const picker = this.contentEl.createEl('input', {
      type: 'file',
      attr: { accept: '.json,application/json', 'aria-label': 'Choose workspace JSON file' },
    });
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      const generation = ++readGeneration;
      if (file)
        void runUIAction(async () => {
          const contents = await file.text();
          if (generation === readGeneration) {
            json = contents;
            area.value = json;
          }
        });
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('Import')
          .setCta()
          .onClick(async () => {
            if (!json.trim()) {
              new Notice('Choose a JSON file or paste its contents.');
              return;
            }
            button.setDisabled(true);
            const ok = await runUIAction(async () => {
              const count = await this.controller.importJson(json);
              new Notice(`Imported ${count} workspace${count === 1 ? '' : 's'}.`);
            });
            if (ok) this.close();
            else button.setDisabled(false);
          }),
      );
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export async function importCoreWorkspaces(
  app: App,
  controller: WorkspaceController,
): Promise<void> {
  await runUIAction(async () => {
    const path = normalizePath(`${app.vault.configDir}/workspaces.json`);
    if (!(await app.vault.adapter.exists(path)))
      throw new Error('No core Workspaces data file was found in this vault.');
    const count = await controller.importJson(await app.vault.adapter.read(path));
    new Notice(`Imported ${count} core workspace${count === 1 ? '' : 's'}.`);
  });
}

export class ExportWorkspacesModal extends Modal {
  constructor(
    app: App,
    private readonly controller: WorkspaceController,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle('Export workspaces');
    const json = this.controller.exportJson();
    this.contentEl.createEl('p', {
      text: 'This snapshot contains saved layouts, history, and repository paths. Branch bindings may need to be removed and rebound when importing on another machine.',
    });
    new Setting(this.contentEl).setName('JSON snapshot').addTextArea((text) => {
      text.setValue(json);
      text.inputEl.readOnly = true;
      text.inputEl.rows = 12;
      text.inputEl.spellcheck = false;
      text.inputEl.setAttribute('aria-label', 'Workspace export JSON');
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('Copy').onClick(() =>
          runUIAction(async () => {
            const clipboard = this.contentEl.ownerDocument.defaultView?.navigator.clipboard;
            if (!clipboard)
              throw new Error('Clipboard access is unavailable. Select and copy the JSON text.');
            await clipboard.writeText(json);
          }, 'Copied workspace snapshot.'),
        ),
      )
      .addButton((button) =>
        button
          .setButtonText('Download JSON')
          .setCta()
          .onClick(() => {
            void runUIAction(async () => {
              const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
              const link = this.contentEl.createEl('a', {
                attr: {
                  href: url,
                  download: `workspaces-${new Date().toISOString().slice(0, 10)}.json`,
                },
              });
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            });
          }),
      );
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export class RecoveryModal extends Modal {
  constructor(
    app: App,
    private readonly controller: WorkspaceController,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle('Recover interrupted switch');
    const state = this.controller.state;
    const journal = state.journal;
    if (!journal) {
      this.contentEl.createEl('p', { text: 'There is no interrupted switch to recover.' });
      return;
    }
    const sourceName = journal.sourceId
      ? (state.workspaces[journal.sourceId]?.name ?? 'previous workspace')
      : 'previous layout';
    const targetName = state.workspaces[journal.targetId]?.name ?? 'target workspace';
    this.contentEl.createEl('p', {
      text: `The switch from “${sourceName}” to “${targetName}” stopped during ${journal.phase}.`,
    });
    if (journal.error) this.contentEl.createEl('p', { text: journal.error });
    this.contentEl.createEl('p', {
      text: journal.originalBranch
        ? `Recovery restores the previous layout and returns Git to “${journal.originalBranch.branch}” if needed. A branch change still requires a clean working tree.`
        : 'Recovery restores the previous layout without changing Git branches.',
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('Restore previous context')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            const ok = await runUIAction(
              () => this.controller.recover(),
              'Restored the previous workspace context.',
            );
            if (ok) this.close();
            else button.setDisabled(false);
          }),
      );
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}
