import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');
const examplesDir = resolve(repoRoot, 'examples');

const exampleDirs = readdirSync(examplesDir).filter((file) => {
  const path = resolve(examplesDir, file);
  return statSync(path).isDirectory() && readdirSync(path).includes('index.html');
});

const input: Record<string, string> = {
  site: resolve(__dirname, 'index.html'),
};

exampleDirs.forEach((dir) => {
  input[dir] = resolve(examplesDir, dir, 'index.html');
});

export default defineConfig({
  root: repoRoot,
  publicDir: false,
  server: {
    port: 5177,
    open: '/dev-site/index.html',
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input },
  },
});
