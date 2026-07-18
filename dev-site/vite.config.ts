import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync, statSync, existsSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');
const examplesDir = resolve(repoRoot, 'examples');
const pagesDist = resolve(repoRoot, 'pages-dist');

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
) as { version?: string };
const appVersion = packageJson.version ?? '0.0.0';

const exampleDirs = readdirSync(examplesDir).filter((file) => {
  const path = resolve(examplesDir, file);
  return statSync(path).isDirectory() && readdirSync(path).includes('index.html');
});

const input: Record<string, string> = {
  // Landing page (flattened to dist root after build)
  main: resolve(__dirname, 'index.html'),
  // Classic text list (stays at /examples/index.html; links rewritten post-build)
  examplesIndex: resolve(examplesDir, 'index.html'),
};

exampleDirs.forEach((dir) => {
  input[dir] = resolve(examplesDir, dir, 'index.html');
});

/**
 * Vite emits paths that mirror the source tree when `root` is the repo:
 *   dev-site/index.html      → dist/dev-site/index.html
 *   examples/foo/index.html  → dist/examples/foo/index.html
 *
 * GitHub Pages (and the previous examples build) expect:
 *   dist/index.html          (landing)
 *   dist/foo/index.html      (each demo)
 *   dist/examples/index.html (optional classic list)
 */
/** Inject package.json version into the landing HTML (dev + build). */
function injectAppVersionPlugin() {
  return {
    name: 'inject-app-version',
    transformIndexHtml(html: string) {
      return html.replaceAll('%APP_VERSION%', appVersion);
    },
  };
}

function flattenPagesPlugin() {
  return {
    name: 'flatten-pages',
    closeBundle() {
      if (!existsSync(pagesDist)) return;

      // 1) Landing → site root
      const builtLanding = resolve(pagesDist, 'dev-site', 'index.html');
      const rootLanding = resolve(pagesDist, 'index.html');
      if (existsSync(builtLanding)) {
        renameSync(builtLanding, rootLanding);
      }
      const devSiteDir = resolve(pagesDist, 'dev-site');
      if (existsSync(devSiteDir)) {
        for (const name of readdirSync(devSiteDir)) {
          const from = resolve(devSiteDir, name);
          if (statSync(from).isFile()) {
            renameSync(from, resolve(pagesDist, name));
          }
        }
        rmSync(devSiteDir, { recursive: true, force: true });
      }

      // 2) Demos → site root (preserve prior GH Pages URLs: /ChartGPU/<demo>/)
      const examplesOut = resolve(pagesDist, 'examples');
      if (!existsSync(examplesOut)) return;

      for (const name of readdirSync(examplesOut)) {
        const from = resolve(examplesOut, name);
        if (!statSync(from).isDirectory()) continue;
        const to = resolve(pagesDist, name);
        if (existsSync(to)) {
          rmSync(to, { recursive: true, force: true });
        }
        renameSync(from, to);
      }

      // 3) Classic list: rewrite ./demo/ → ../demo/ now that demos live one level up
      const listHtml = resolve(examplesOut, 'index.html');
      if (existsSync(listHtml)) {
        let html = readFileSync(listHtml, 'utf8');
        html = html.replace(/href="\.\/([a-z0-9-]+)\/index\.html"/g, 'href="../$1/index.html"');
        writeFileSync(listHtml, html);
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  // Project Pages: https://chartgpu.github.io/ChartGPU/
  // Dev keeps base `/` so /examples/... resolves from the Vite root (repo).
  base: command === 'build' ? '/ChartGPU/' : '/',
  root: repoRoot,
  publicDir: false,
  server: {
    port: 5177,
    open: '/dev-site/index.html',
    fs: { allow: [repoRoot] },
  },
  preview: {
    port: 4173,
    open: '/ChartGPU/',
  },
  define: {
    // Available to landing TS as import.meta.env is not used for this constant.
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [injectAppVersionPlugin(), flattenPagesPlugin()],
  build: {
    outDir: pagesDist,
    emptyOutDir: true,
    rollupOptions: { input },
  },
}));
