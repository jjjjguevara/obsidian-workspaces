// Adapted from s1m4ne/obsidian-workspace-plus @ b8bd11c9ee427b17770f386944e67ba0dd98e414.
// Copyright (c) 2025-2026 s1m4ne; MIT. See THIRD_PARTY_NOTICES.md.
// Clone only native JSON state. Preserve undefined rather than parsing it.

export function cloneJson(value: undefined): undefined;
export function cloneJson<T>(value: T): T;
export function cloneJson<T>(value: T): T | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as T;
}
