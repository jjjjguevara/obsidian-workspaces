import { apiVersion, FileSystemAdapter, type DataAdapter } from 'obsidian';

/**
 * Optional acceleration for the inspected desktop 1.15.1 adapter. Its private
 * update(path) queues a fresh native reconciliation, including the usual vault
 * events, without the watcher's 100 ms deletion delay. It does not write files.
 * Other versions and adapters retain the ordinary event/probe readiness path.
 */
export async function reconcileVaultFiles(
  adapter: DataAdapter,
  paths: Iterable<string>,
): Promise<void> {
  if (apiVersion !== '1.15.1' || !(adapter instanceof FileSystemAdapter)) return;
  let update: unknown;
  try {
    update = (adapter as unknown as { update?: unknown }).update;
  } catch {
    return;
  }
  if (typeof update !== 'function') return;
  const reconcile = update;
  const localPaths = [...new Set(paths)].filter(
    (path) =>
      path !== '' &&
      !path.startsWith('/') &&
      !path.startsWith('file:') &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      !/(^|\/)\.{1,2}(\/|$)/.test(path),
  );
  // update already owns the adapter queue; nesting it inside queue() deadlocks.
  // Capture synchronous throws too, and drain every call before the controller
  // can restore a layout, report failure, or release transition ownership.
  await Promise.allSettled(
    localPaths.map(async (path) => {
      await reconcile.call(adapter, path);
    }),
  );
  // Reconciliation is only a hint. It can swallow native stat errors, and its
  // metadata comparison cannot prove cached bytes are current. The caller must
  // still perform every ordinary readiness probe, including after a rejection.
}
