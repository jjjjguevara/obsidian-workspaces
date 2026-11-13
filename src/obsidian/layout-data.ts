// Adapted from s1m4ne/obsidian-workspace-plus @ b8bd11c9ee427b17770f386944e67ba0dd98e414.
// Copyright (c) 2025-2026 s1m4ne; MIT. See THIRD_PARTY_NOTICES.md.
import { cloneJson } from './clone-json.ts';

/**
 * Which regions of the workspace the plugin treats as its own.
 *
 * `full` restores and compares `main` plus both sidebars. `main-only` restores
 * `main` over whatever sidebars are on screen, and must therefore compare
 * `main` alone: comparing a region that is never restored produces a dirty
 * flag that nothing can clear.
 *
 * That is why the scope is a required argument rather than an optional one. It
 * used to be `restoreScope?: string`, so a caller that forgot it, or misspelt
 * the value, silently got `full` - and only one of the three call paths passed
 * it at all.
 */
export type RestoreScope = 'full' | 'main-only';

export interface LayoutComparisonOptions {
  readonly restoreScope: RestoreScope;
}

export function serializeLayout(layout: unknown): string {
  try {
    return JSON.stringify(layout || null);
  } catch {
    return '';
  }
}

export function layoutsEqual(a: unknown, b: unknown): boolean {
  return serializeLayout(a) === serializeLayout(b);
}

// The layout is JSON on disk; cloning it is the general operation under a
// name that says what it is used for here.
export const cloneLayout = cloneJson;

export function nodeContainsId(node: unknown, id: string): boolean {
  if (!id || !node) return false;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (nodeContainsId(node[i], id)) return true;
    }
    return false;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.id === id) return true;
    const keys = Object.keys(obj);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k]!;
      if (nodeContainsId(obj[key], id)) return true;
    }
  }
  return false;
}

export function mergeMainLayoutIntoCurrent(targetLayout: unknown, currentLayout: unknown): unknown {
  const target = cloneLayout(targetLayout) as Record<string, unknown> | undefined;
  if (!target || typeof target !== 'object' || !target.main) return target;

  const current: Record<string, unknown> =
    currentLayout && typeof currentLayout === 'object'
      ? (cloneLayout(currentLayout) as Record<string, unknown>)
      : {};

  current.main = target.main;
  if (typeof target.active === 'string' && nodeContainsId(target.main, target.active)) {
    current.active = target.active;
  }
  return current;
}

function looksLikeWorkspaceItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.type === 'string' &&
    (Array.isArray(item.children) ||
      item.state !== undefined ||
      item.currentTab !== undefined ||
      item.direction !== undefined ||
      item.collapsed !== undefined)
  );
}

function normalizeLayoutForComparison(layout: unknown, options: LayoutComparisonOptions): unknown {
  let root = layout;
  if (options.restoreScope === 'main-only' && root && typeof root === 'object') {
    const obj = root as Record<string, unknown>;
    if (obj.main) {
      root = obj.main;
    }
  }

  // Pixel geometry and per-view ephemera. `left` belongs to this set too, and
  // is handled below instead of here: Obsidian uses the same key for a
  // coordinate and for the left sidebar's subtree, and 4df7f55 stripped both
  // for four months by putting the name in this list.
  const volatileKeys: Record<string, boolean> = {
    eState: true,
    lastOpenFiles: true,
    scroll: true,
    top: true,
  };

  function normalizeNode(value: unknown, depth: number): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeNode(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      const normalized: Record<string, unknown> = {};
      const obj = value as Record<string, unknown>;
      const isWorkspaceItem = looksLikeWorkspaceItem(obj);
      const keys = Object.keys(obj).sort();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        if (volatileKeys[key]) continue;
        // A numeric `left` is a coordinate; an object `left` is the sidebar.
        if (key === 'left' && (obj[key] === null || typeof obj[key] !== 'object')) continue;
        if (key === 'id' && isWorkspaceItem) continue;

        // `active` and `currentTab` are the same question at two
        // scopes - which thing is in front - so they get the same
        // answer. `active` at the root is the focused leaf's id;
        // `currentTab` is the selected tab of one tab group, which is
        // why it never sits at depth 0 and was never reached by the
        // line above it.
        //
        // Authorized exception to the behaviour lock in issue #111.
        // With auto-save on, the default, nothing changes: the layout
        // is captured on every switch regardless. With auto-save off,
        // selecting a different tab no longer lights the unsaved
        // indicator - which is already true of moving focus between
        // panes, so the two are consistent now instead of opposite.
        // It also stops the snapshot timer spending the history budget
        // on tab clicks: three entries for one session in half an hour
        // differed in nothing else.
        if (key === 'active' && depth === 0 && typeof obj[key] === 'string') continue;
        if (key === 'currentTab') continue;
        normalized[key] = normalizeNode(obj[key], depth + 1);
      }
      return normalized;
    }
    return value;
  }

  return normalizeNode(root || null, 0);
}

export function layoutsEqualStructural(
  a: unknown,
  b: unknown,
  options: LayoutComparisonOptions,
): boolean {
  try {
    return (
      JSON.stringify(normalizeLayoutForComparison(a, options)) ===
      JSON.stringify(normalizeLayoutForComparison(b, options))
    );
  } catch {
    return layoutsEqual(a, b);
  }
}
