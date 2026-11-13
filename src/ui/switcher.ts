import { App, FuzzySuggestModal, type FuzzyMatch, setIcon } from 'obsidian';
import { WorkspaceController } from '../workspaces/controller';
import { orderedWorkspaces } from '../workspaces/catalog';
import { type WorkspaceRecord } from '../workspaces/model';
import { WorkspaceDetailsModal, applyWorkspaceIcon, runUIAction, workspaceDetail } from './dialogs';
import { openWorkspaceActions } from './menu';

/** Native suggestion-row presentation follows Workspaces Plus@dfdb79c0
 * (GPL-3.0). Modified 2026-11-13 to use stable records and the transition
 * controller, without relocating suggestion DOM or patching core Workspaces. */
export class WorkspaceSwitcher extends FuzzySuggestModal<WorkspaceRecord> {
  private unsubscribe?: () => void;
  constructor(
    app: App,
    private readonly controller: WorkspaceController,
  ) {
    super(app);
    this.setPlaceholder('Find a workspace…');
    this.emptyStateText = 'No matching workspaces. Create one from the Workspaces menu.';
    this.setInstructions([
      { command: '↑↓', purpose: 'navigate' },
      { command: '↵', purpose: 'open workspace' },
      { command: 'mod ↵', purpose: 'edit details' },
      { command: 'esc', purpose: 'close' },
    ]);
  }
  getItems(): WorkspaceRecord[] {
    return orderedWorkspaces(this.controller.state);
  }
  getItemText(workspace: WorkspaceRecord): string {
    return workspace.name;
  }
  override renderSuggestion(result: FuzzyMatch<WorkspaceRecord>, element: HTMLElement): void {
    const workspace = result.item;
    const row = element.createDiv({ cls: 'workspaces-context-row' });
    const icon = row.createSpan({
      cls: 'workspaces-context-icon',
      attr: { 'aria-hidden': 'true' },
    });
    applyWorkspaceIcon(icon, workspace);
    const content = row.createDiv({ cls: 'suggestion-content' });
    const title = content.createDiv({ cls: 'suggestion-title' });
    super.renderSuggestion(result, title);
    content.createDiv({
      cls: 'workspaces-context-detail',
      text: workspaceDetail(workspace, this.controller.device),
    });
    if (this.controller.state.activeId === workspace.id) {
      const active = row.createSpan({ attr: { 'aria-label': 'Current workspace' } });
      setIcon(active, 'check');
    }
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openWorkspaceActions(this.app, this.controller, workspace.id, event);
    });
  }
  onChooseItem(workspace: WorkspaceRecord, event: MouseEvent | KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey)
      new WorkspaceDetailsModal(this.app, this.controller, workspace.id).open();
    else void runUIAction(() => this.controller.activate(workspace.id));
  }
  override async onOpen(): Promise<void> {
    await super.onOpen();
    this.unsubscribe = this.controller.subscribe(() => {
      // Public input events let the native suggestion implementation recompute
      // matches; no dependency on its private selection or render internals.
      const EventType = this.inputEl.ownerDocument.defaultView?.Event ?? Event;
      this.inputEl.dispatchEvent(new EventType('input', { bubbles: true }));
    });
  }
  override onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    super.onClose();
  }
}
