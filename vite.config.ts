import { defineConfig } from 'vite';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const pkgJsonPath = resolve(__dirname, 'package.json');
const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const externalDeps = Array.from(
  new Set([
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.peerDependencies ?? {})
  ])
);

function isExternal(id: string): boolean {
  if (id.startsWith('node:')) return true;
  for (const dep of externalDeps) {
    if (id === dep || id.startsWith(`${dep}/`)) return true;
  }
  return false;
}

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: true,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ChartGPU',
      fileName: () => 'index.js',
      formats: ['es']
    },
    rollupOptions: {
      external: isExternal,
      output: {
        entryFileNames: 'index.js'
      }
    }
  },
  server: {
    open: '/examples'
  }
});
