import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const reloadProduct = require('../obsidian/reload-product.cjs');

function fixture() {
  const hash = 'a'.repeat(64);
  const state = () => ({ activeId: 'runtime-alpha', revision: 7, journal: null });
  class Before {
    controller = { busy: null as string | null, state: state() };
    ready = true;
  }
  class After {
    controller = { busy: null, state: state() };
    ready = true;
  }
  const old = new Before();
  const registry: Record<string, any> = {
    'obsidian-workspaces': old,
    'obsidian-git': {},
    'darlal-switcher-plus': {},
  };
  const calls: string[] = [];
  const manager = {
    enabledPlugins: new Set(Object.keys(registry)),
    getPlugin: (id: string) => registry[id],
    disablePlugin: async (id: string) => {
      calls.push('disable');
      delete registry[id];
    },
    enablePlugin: async (id: string) => {
      calls.push('enable');
      registry[id] = new After();
      return true;
    },
  };
  return {
    old,
    registry,
    calls,
    manager,
    port: {
      app: { plugins: manager },
      apiVersion: '1.15.1',
      expectedHash: hash,
      readBundleHash: async () => hash,
      waitFor: async (_label: string, read: () => unknown) => read(),
    },
  };
}

test('fixture reload replaces loaded code through native lifecycle without replacing providers', async () => {
  const f = fixture();
  const git = f.registry['obsidian-git'];
  const result = await reloadProduct(f.port);
  assert.notEqual(result.plugin, f.old);
  assert.equal(f.registry['obsidian-git'], git);
  assert.deepEqual(f.calls, ['disable', 'enable']);
  assert.equal(result.evidence.newConstructor, true);
  assert.deepEqual(result.evidence.enabledBefore, result.evidence.enabledAfter);
});

test('busy controller is never unloaded for benchmark provenance', async () => {
  const f = fixture();
  f.old.controller.busy = 'Switching workspace';
  await assert.rejects(reloadProduct(f.port), /idle Alpha/);
  assert.deepEqual(f.calls, []);
});

test('wrong prepared bytes reject before mutating plugin lifecycle', async () => {
  const f = fixture();
  f.port.expectedHash = 'b'.repeat(64);
  await assert.rejects(reloadProduct(f.port), /differ from preparation/);
  assert.deepEqual(f.calls, []);
});

test('a loader retaining an old instance cannot certify a new running build', async () => {
  const f = fixture();
  f.manager.enablePlugin = async (id: string) => {
    f.registry[id] = f.old;
    return true;
  };
  await assert.rejects(reloadProduct(f.port), /reused the previous/);
});

test('bytes changing while native load runs cannot certify provenance', async () => {
  const f = fixture();
  let reads = 0;
  f.port.readBundleHash = async () => (++reads === 1 ? 'a' : 'b').repeat(64);
  await assert.rejects(reloadProduct(f.port), /bytes changed/);
});
