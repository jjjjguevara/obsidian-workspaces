import { type WorkspaceState, type WorkspaceRecord, type Snapshot } from './model';

export function addWorkspace(
  state: WorkspaceState,
  name: string,
  context: Snapshot,
  metadata: Partial<Pick<WorkspaceRecord, 'group' | 'icon' | 'color' | 'description'>> = {},
): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A workspace name is required.');
  const id = globalThis.crypto.randomUUID();
  state.workspaces[id] = {
    id,
    name: trimmed,
    group: '',
    icon: 'panels-top-left',
    color: '',
    description: '',
    ...metadata,
    contexts: { [context.device]: structuredClone(context) },
    history: [],
  };
  state.order.push(id);
  return id;
}
export function duplicateWorkspace(state: WorkspaceState, id: string): string {
  const original = state.workspaces[id];
  if (!original) throw new Error('Workspace no longer exists.');
  const copy = structuredClone(original);
  copy.id = globalThis.crypto.randomUUID();
  copy.name = `${copy.name} copy`;
  state.workspaces[copy.id] = copy;
  state.order.splice(state.order.indexOf(id) + 1, 0, copy.id);
  return copy.id;
}
export function orderedWorkspaces(state: WorkspaceState): WorkspaceRecord[] {
  return state.order
    .map((id) => state.workspaces[id])
    .filter((record): record is WorkspaceRecord => !!record);
}
