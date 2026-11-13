export type Device = 'desktop' | 'mobile';
export type Layout = Record<string, unknown>;
export interface GitBinding {
  root: string;
  branch: string;
}
export interface Snapshot {
  layout: Layout;
  binding: GitBinding | null;
  device: Device;
  savedAt: number;
}
export interface WorkspaceRecord {
  id: string;
  name: string;
  group: string;
  icon: string;
  color: string;
  description: string;
  contexts: Partial<Record<Device, Snapshot>>;
  history: Snapshot[];
}
export interface Journal {
  sourceId: string | null;
  targetId: string;
  source: Snapshot;
  /** Catalog snapshot before applying the target; distinct from unsaved live layout. */
  sourceSaved?: Snapshot | null;
  target: Snapshot;
  originalBranch: GitBinding | null;
  phase: 'prepared' | 'checkout' | 'restoring' | 'recovery';
  error?: string;
}
export interface WorkspaceState {
  version: 1;
  revision: number;
  activeId: string | null;
  order: string[];
  workspaces: Record<string, WorkspaceRecord>;
  autoSave: boolean;
  journal: Journal | null;
}
export function emptyState(): WorkspaceState {
  return {
    version: 1,
    revision: 0,
    activeId: null,
    order: [],
    workspaces: {},
    autoSave: true,
    journal: null,
  };
}
export function snapshot(
  layout: Layout,
  device: Device,
  binding: GitBinding | null = null,
): Snapshot {
  return structuredClone({ layout, binding, device, savedAt: Date.now() });
}
export function contextOf(workspace: WorkspaceRecord, device: Device): Snapshot {
  const context =
    workspace.contexts[device] ?? workspace.contexts[device === 'desktop' ? 'mobile' : 'desktop'];
  if (!context) throw new Error(`Workspace ${workspace.name} has no saved layout.`);
  return structuredClone(context);
}
export function remember(workspace: WorkspaceRecord, context: Snapshot): void {
  const old = workspace.contexts[context.device];
  if (
    old &&
    JSON.stringify(old.layout) + JSON.stringify(old.binding) !==
      JSON.stringify(context.layout) + JSON.stringify(context.binding)
  ) {
    workspace.history.unshift(structuredClone(old));
    workspace.history = workspace.history.slice(0, 30);
  }
  workspace.contexts[context.device] = structuredClone(context);
}
