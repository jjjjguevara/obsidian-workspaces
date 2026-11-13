import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  // Obsidian evaluates CommonJS inside an Electron renderer. Native import()
  // uses its browser loader; lazily require Node modules only on desktop.
  supported: { 'dynamic-import': false },
  external: ['obsidian', 'electron'],
  sourcemap: false,
  legalComments: 'eof',
});
for (const file of ['manifest.json', 'styles.css']) await copyFile(file, `dist/${file}`);
