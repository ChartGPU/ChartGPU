import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Find all example directories with index.html
const exampleDirs = readdirSync(__dirname).filter((file) => {
  const path = resolve(__dirname, file);
  return statSync(path).isDirectory() && 
         readdirSync(path).includes('index.html');
});

// Build input object for rollup
const input: Record<string, string> = {
  main: resolve(__dirname, 'index.html'),
};

exampleDirs.forEach((dir) => {
  input[dir] = resolve(__dirname, dir, 'index.html');
});

export default defineConfig({
  base: '/chartgpu/',
  build: {
    outDir: resolve(__dirname, 'dist'),  // Absolute path
    rollupOptions: {
      input,
    },
  },
});