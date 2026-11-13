import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import type { WorkspaceController } from '../../src/workspaces/controller.ts';
import type { Device, WorkspaceState } from '../../src/workspaces/model.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const execute = promisify(execFile);
let bundle: string;

before(async () => {
  // Exercise the shipping configuration, including its dynamic-import transform.
  // A separate test-only esbuild configuration would miss renderer loader failures.
  await execute(process.execPath, ['esbuild.config.mjs'], { cwd: repository });
  bundle = await readFile(join(repository, 'dist', 'main.js'), 'utf8');
});

function catalog(device: Device): WorkspaceState {
  return {
    version: 1,
    revision: 0,
    activeId: 'unbound',
    order: ['unbound'],
    autoSave: true,
    journal: null,
    workspaces: {
      unbound: {
        id: 'unbound',
        name: `Saved ${device} context`,
        group: '',
        description: '',
        icon: '',
        color: '',
        contexts: {
          [device]: {
            device,
            binding: null,
            savedAt: 1,
            layout: { main: { id: 'main', type: 'split', children: [] } },
          },
        },
        history: [],
      },
    },
  };
}

interface LoadedPlugin {
  controller?: WorkspaceController;
  onload(): Promise<void>;
  onunload(): void;
}

function loadBundle(options: {
  device: Device;
  initial: WorkspaceState;
  vaultPath?: string;
  appDataPath?: string;
  homePath?: string;
}) {
  const nodeRequests: string[] = [];
  const browserImports: string[] = [];
  const readyCallbacks: Array<() => void> = [];
  const notices: string[] = [];
  const pluginDataWrites: unknown[] = [];
  let pluginDataReads = 0;

  class FileSystemAdapter {
    constructor(private readonly basePath: string) {}
    getBasePath(): string {
      return this.basePath;
    }
  }
  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: options.device === 'desktop' ? new FileSystemAdapter(options.vaultPath!) : {},
    },
    workspace: {
      onLayoutReady(callback: () => void): void {
        readyCallbacks.push(callback);
      },
      iterateAllLeaves(): void {},
      getLayout(): unknown {
        return structuredClone(
          options.initial.workspaces.unbound!.contexts[options.device]!.layout,
        );
      },
    },
  };
  class Plugin {
    constructor(
      readonly app: unknown,
      readonly manifest: { id: string },
    ) {}
    async loadData(): Promise<WorkspaceState> {
      pluginDataReads += 1;
      return structuredClone(options.initial);
    }
    async saveData(value: unknown): Promise<void> {
      pluginDataWrites.push(structuredClone(value));
    }
  }
  class Modal {}
  const obsidian = {
    Plugin,
    FileSystemAdapter,
    Modal,
    FuzzySuggestModal: Modal,
    PluginSettingTab: class {},
    FileView: class {},
    TextFileView: class {},
    TFile: class {},
    Platform: { isMobile: options.device === 'mobile' },
    Notice: class {
      constructor(message: string) {
        notices.push(message);
      }
    },
  };
  const module = {
    exports: {} as { default?: new (app: unknown, manifest: { id: string }) => LoadedPlugin },
  };
  const context = {
    module,
    exports: module.exports,
    require(specifier: string): unknown {
      if (specifier === 'obsidian') return obsidian;
      nodeRequests.push(specifier);
      assert.equal(options.device, 'desktop', `Mobile attempted to require ${specifier}`);
      assert.ok(isBuiltin(specifier), `Unexpected external dependency ${specifier}`);
      const loaded = nodeRequire(specifier);
      // Isolate the macOS application-data fallback as well as Linux/Windows
      // environment paths; no native module may select the real user home.
      if (specifier === 'node:os' || specifier === 'os') {
        return { ...loaded, homedir: () => options.homePath };
      }
      return loaded;
    },
    console,
    structuredClone,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...(options.device === 'desktop'
      ? {
          process: {
            pid: process.pid,
            platform: process.platform,
            env: {
              ...process.env,
              XDG_DATA_HOME: options.appDataPath,
              APPDATA: options.appDataPath,
              HOME: options.homePath,
            },
          },
        }
      : {}),
  };
  const script = new Script(bundle, {
    filename: 'obsidian-workspaces/dist/main.js',
    importModuleDynamically(specifier) {
      browserImports.push(specifier);
      throw new Error(`Browser dynamic import must not load ${specifier}`);
    },
  });
  script.runInNewContext(context, { timeout: 5_000 });
  assert.equal(
    nodeRequests.length,
    0,
    'Evaluating the plugin must not eagerly resolve Node modules',
  );
  assert.ok(module.exports.default, 'The shipping CommonJS bundle must export the plugin class');
  const plugin = new module.exports.default(app, { id: 'obsidian-workspaces' });
  return {
    plugin,
    nodeRequests,
    browserImports,
    readyCallbacks,
    notices,
    pluginDataWrites,
    get pluginDataReads() {
      return pluginDataReads;
    },
  };
}

test('the complete shipping bundle loads and saves an unbound mobile context without Node or browser imports', async (t) => {
  const loaded = loadBundle({ device: 'mobile', initial: catalog('mobile') });
  t.after(() => loaded.plugin.onunload());
  await loaded.plugin.onload();
  assert.equal(loaded.plugin.controller?.device, 'mobile');
  assert.equal(loaded.plugin.controller?.state.activeId, 'unbound');
  assert.equal(loaded.pluginDataReads, 1);
  assert.equal(loaded.readyCallbacks.length, 1);
  assert.deepEqual(loaded.notices, []);
  assert.deepEqual(loaded.nodeRequests, []);
  assert.deepEqual(loaded.browserImports, []);

  // Do not fire onLayoutReady: UI registration remains outside this loader test.
  await loaded.plugin.controller!.saveActive();
  assert.equal(loaded.pluginDataWrites.length, 1);
  assert.equal((loaded.pluginDataWrites[0] as WorkspaceState).revision, 1);
  assert.deepEqual(loaded.nodeRequests, []);
  assert.deepEqual(loaded.browserImports, []);
});

test('desktop onload uses CommonJS Node loading and an isolated filesystem control store', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'obsidian-workspaces-bundle-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const vaultPath = join(root, 'vault');
  const homePath = join(root, 'home');
  const appDataPath =
    process.platform === 'darwin'
      ? join(homePath, 'Library', 'Application Support')
      : join(root, 'app-data');
  await mkdir(vaultPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  const key = createHash('sha256').update(vaultPath).digest('hex').slice(0, 24);
  const directory = join(appDataPath, 'obsidian-workspaces', key);
  const location = join(directory, 'state.json');
  await mkdir(directory, { recursive: true });
  await writeFile(location, JSON.stringify(catalog('desktop')));

  const loaded = loadBundle({
    device: 'desktop',
    initial: catalog('desktop'),
    vaultPath,
    homePath,
    appDataPath,
  });
  t.after(() => loaded.plugin.onunload());
  await loaded.plugin.onload();
  assert.equal(loaded.plugin.controller?.device, 'desktop');
  assert.equal(loaded.plugin.controller?.state.activeId, 'unbound');
  assert.equal(loaded.plugin.controller?.storageLocation, location);
  assert.equal(loaded.pluginDataReads, 0);
  assert.equal(loaded.readyCallbacks.length, 1);
  assert.deepEqual(loaded.notices, []);
  for (const dependency of ['node:path', 'node:os', 'node:fs/promises', 'node:crypto']) {
    assert.ok(
      loaded.nodeRequests.includes(dependency),
      `Desktop must require ${dependency} through CommonJS`,
    );
  }
  assert.deepEqual(loaded.browserImports, []);

  await loaded.plugin.controller!.setAutoSave(false);
  const saved = JSON.parse(await readFile(location, 'utf8')) as WorkspaceState;
  assert.equal(saved.autoSave, false);
  assert.equal(saved.revision, 1);
  assert.equal(loaded.pluginDataWrites.length, 0);
  assert.deepEqual(loaded.browserImports, []);
});
