import type { App } from 'obsidian';

/** The only access to Obsidian's internal community-plugin registry. */
export function installedPlugin(app: App, id: string): unknown {
  const registry = (app as unknown as { plugins?: { getPlugin?: (id: string) => unknown } })
    .plugins;
  if (!registry || typeof registry.getPlugin !== 'function') return undefined;
  return registry.getPlugin(id);
}
