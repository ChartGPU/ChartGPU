# GitHub Pages redirect

Static site published to `https://chartgpu.github.io/ChartGPU/`.

All traffic (root and deep paths via `404.html`) client-redirects to
[https://chartgpu.io/](https://chartgpu.io/). GitHub Pages does not support
server-side HTTP redirects; this uses meta refresh + `location.replace`.

Deployed by [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml).

Local demos: `npm run dev` in the repo root (see `examples/`).
The former full Pages build (`npm run build:pages` / `dev-site/`) remains for
local preview only and is no longer what GitHub Pages serves.
