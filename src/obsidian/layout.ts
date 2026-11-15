import {
  apiVersion,
  App,
  FileView,
  Modal,
  Platform,
  TextFileView,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import type { WorkspaceHost } from '../workspaces/controller';
import type { Layout } from '../workspaces/model';
import { cloneJson } from './clone-json';
import { assertRestoredFiles, fileLeaves, waitForVaultFiles } from './layout-files';
import { reconcileVaultFiles } from './vault-reconcile';
import { restoreInPlace } from './incremental-layout';

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

// Short switches keep native focus and avoid a modal flash. Input ownership
// starts immediately; this delay affects only the visible progress indicator.
const PROGRESS_DELAY_MS = 500;

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
  private quiesced = false;
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
    this.quiesced = false;
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
    this.quiesced = false;
    await this.assertCanQuiesce();
    const textCloses = new Map<string, Promise<void>>();
    const closed = await Promise.allSettled(
      this.leaves()
        .filter(
          (leaf) =>
            leaf.view instanceof FileView || typeof leaf.getViewState().state?.file === 'string',
        )
        .map(async (leaf) => {
          const close = async (): Promise<void> => {
            // setViewState awaits unloading. detach() is void and is not a flush barrier.
            await leaf.setViewState({ type: 'empty', state: {}, pinned: false });
          };
          // Native clearLayout closes independent views together. Preserve the
          // existing save order for editable views that share the same file,
          // and stop that chain if an earlier editor could not save.
          const path = leaf.view instanceof TextFileView ? leaf.view.file?.path : undefined;
          const previous = path ? textCloses.get(path) : undefined;
          const pending = previous ? previous.then(close) : close();
          if (path) textCloses.set(path, pending);
          await pending;
        }),
    );
    // No checkout or failure path may release ownership while an unload can
    // still save. A rejected close must drain every other started group first.
    for (const result of closed) {
      if (result.status === 'rejected') throw result.reason;
    }
    this.quiesced = true;
  }
  async waitForFiles(
    target: Layout,
    previous: Layout,
    options: { afterCheckout?: boolean } = {},
  ): Promise<void> {
    const vault = this.app.vault;
    const watched = new Set(
      [...fileLeaves(target), ...fileLeaves(previous)].map((leaf) => leaf.path),
    );
    if (options.afterCheckout) await reconcileVaultFiles(vault.adapter, watched);
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
      subscribe: (changed) => {
        const notify = (file: { path: string }, oldPath?: string): void => {
          if (
            [...watched].some(
              (path) =>
                path === file.path ||
                path.startsWith(`${file.path}/`) ||
                (oldPath !== undefined && (path === oldPath || path.startsWith(`${oldPath}/`))),
            )
          )
            changed();
        };
        const refs = [
          vault.on('create', notify),
          vault.on('delete', notify),
          vault.on('rename', notify),
          vault.on('modify', notify),
        ];
        return () => refs.forEach((ref) => vault.offref(ref));
      },
    });
  }
  async restore(layout: Layout): Promise<void> {
    const quiesced = this.quiesced;
    this.quiesced = false;
    const restored =
      quiesced &&
      apiVersion === '1.15.1' &&
      Platform?.isDesktopApp === true &&
      (await restoreInPlace(this.app.workspace, layout));
    if (!restored) await this.app.workspace.changeLayout(cloneJson(layout));
    // Native layout restoration already hydrates visible leaves concurrently.
    // Finish the remaining leaves together, retaining ownership until every
    // started hydration settles even when another leaf has already failed.
    const hydrated = await Promise.allSettled(
      this.leaves().map(async (leaf) => leaf.loadIfDeferred()),
    );
    for (const result of hydrated) {
      if (result.status === 'rejected') throw result.reason;
    }
    assertRestoredFiles(layout, this.capture());
  }
  block(message: string): () => void {
    const modal = new TransitionModal(this.app, message);
    let opened = false;
    let released = false;
    const timer = setTimeout(() => {
      opened = true;
      modal.open();
    }, PROGRESS_DELAY_MS);
    const documents = new Set<Document>();
    const block = (event: Event): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Preventing pointerdown alone does not suppress later activation events.
    // Native tabs, new-tab buttons, and menus also act on these events directly.
    const events = [
      'keydown',
      'beforeinput',
      'pointerdown',
      'click',
      'dblclick',
      'auxclick',
      'contextmenu',
      'drop',
      'paste',
    ];
    const capture = { capture: true };
    const protect = (document: Document): void => {
      if (released || documents.has(document)) return;
      documents.add(document);
      for (const event of events) document.addEventListener(event, block, capture);
    };
    // Restoring a saved layout can create new popouts while this guard owns input.
    const openedWindow = this.app.workspace.on('window-open', (_workspaceWindow, window) => {
      protect(window.document);
    });
    for (const leaf of this.leaves()) protect(leaf.view.containerEl.ownerDocument);
    protect(modal.containerEl.ownerDocument);
    return () => {
      if (released) return;
      released = true;
      this.quiesced = false;
      clearTimeout(timer);
      this.app.workspace.offref(openedWindow);
      for (const document of documents)
        for (const event of events) document.removeEventListener(event, block, capture);
      if (opened) modal.release();
    };
  }
  confirmDiscard(name: string): Promise<boolean> {
    return this.askDiscard(name);
  }
}
