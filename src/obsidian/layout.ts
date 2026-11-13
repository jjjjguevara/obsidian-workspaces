import { App, FileView, Modal, TextFileView, TFile, type WorkspaceLeaf } from 'obsidian';
import type { WorkspaceHost } from '../workspaces/controller';
import type { Layout } from '../workspaces/model';
import { cloneJson } from './clone-json';
import { assertRestoredFiles, waitForVaultFiles } from './layout-files';

// These core FileViews have no editable document buffer to flush. In particular,
// backlinks, outgoing links, and outline follow the active file but are read-only.
// Keep this explicit: an arbitrary FileView may own unsaved editor state.
const READ_ONLY_CORE_FILE_VIEWS = new Set([
  'pdf',
  'image',
  'audio',
  'video',
  'backlink',
  'outgoing-link',
  'outline',
]);

class TransitionModal extends Modal {
  private released = false;
  constructor(
    app: App,
    private readonly message: string,
  ) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass('workspaces-progress');
    this.setTitle('Switching workspace');
    this.contentEl.createEl('p', { text: this.message });
  }
  close(): void {
    if (this.released) super.close();
  }
  release(): void {
    this.released = true;
    super.close();
  }
}

export class ObsidianWorkspaceHost implements WorkspaceHost {
  constructor(
    private readonly app: App,
    private readonly askDiscard: (name: string) => Promise<boolean>,
  ) {}
  private leaves(): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      leaves.push(leaf);
    });
    return leaves;
  }
  capture(): Layout {
    return cloneJson(this.app.workspace.getLayout()) as Layout;
  }
  async flush(): Promise<void> {
    for (const leaf of this.leaves()) {
      await leaf.loadIfDeferred();
      // requestSave() is a debounce, not a durability barrier. Use the awaited API.
      if (leaf.view instanceof TextFileView) await leaf.view.save();
    }
  }
  async assertCanQuiesce(): Promise<void> {
    const leaves = this.leaves();
    // Unknown editable view types have no universal public flush contract.
    // Reject before closing any leaves, so their buffers cannot later save across branches.
    for (const leaf of leaves) {
      const state = leaf.getViewState();
      if (
        leaf.view instanceof FileView &&
        leaf.view.file &&
        !(leaf.view instanceof TextFileView) &&
        !READ_ONLY_CORE_FILE_VIEWS.has(state.type)
      ) {
        throw new Error(
          `Close the “${state.type}” editor before switching branches. Supported views include text-backed notes, native media, backlinks, outgoing links, and outline.`,
        );
      }
      if (typeof state.state?.file === 'string' && !(leaf.view instanceof FileView)) {
        throw new Error(
          `Close the “${state.type}” view before switching branches; its save lifecycle is not supported.`,
        );
      }
    }
  }
  async quiesce(): Promise<void> {
    await this.assertCanQuiesce();
    for (const leaf of this.leaves()) {
      if (leaf.view instanceof FileView || typeof leaf.getViewState().state?.file === 'string') {
        // setViewState awaits unloading. detach() is void and is not a flush barrier.
        await leaf.setViewState({ type: 'empty', state: {}, pinned: false });
      }
    }
  }
  waitForFiles(target: Layout, previous: Layout): Promise<void> {
    const vault = this.app.vault;
    return waitForVaultFiles(target, previous, {
      hasFile: (path) => vault.getAbstractFileByPath(path) instanceof TFile,
      exists: (path) => vault.adapter.exists(path),
      cachedRead: async (path) => {
        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('File is not indexed.');
        return vault.cachedRead(file);
      },
      diskRead: (path) => vault.adapter.read(path),
      matchesStat: async (path) => {
        const file = vault.getAbstractFileByPath(path);
        const stat = await vault.adapter.stat(path);
        return (
          file instanceof TFile &&
          stat?.type === 'file' &&
          file.stat.size === stat.size &&
          file.stat.mtime === stat.mtime
        );
      },
    });
  }
  async restore(layout: Layout): Promise<void> {
    await this.app.workspace.changeLayout(cloneJson(layout));
    for (const leaf of this.leaves()) await leaf.loadIfDeferred();
    assertRestoredFiles(layout, this.capture());
  }
  block(message: string): () => void {
    const modal = new TransitionModal(this.app, message);
    modal.open();
    const documents = new Set(this.leaves().map((leaf) => leaf.view.containerEl.ownerDocument));
    documents.add(modal.containerEl.ownerDocument);
    const block = (event: Event): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['keydown', 'beforeinput', 'pointerdown', 'drop', 'paste'];
    for (const document of documents)
      for (const event of events) document.addEventListener(event, block, true);
    return () => {
      for (const document of documents)
        for (const event of events) document.removeEventListener(event, block, true);
      modal.release();
    };
  }
  confirmDiscard(name: string): Promise<boolean> {
    return this.askDiscard(name);
  }
}
