<p align="center" style="margin-bottom:0; margin-top:20px;">
  <img src="docs/assets/chartgpu.png" alt="ChartGPU" width="400">
</p>

<p align="center" style="margin-top:-18px;">
  MIT-licensed WebGPU charting library for dense real-time, multi-series and multi-panel dashboards.
</p>

<div align="center">

[<img src="docs/assets/powered-by-webgpu.svg" alt="Powered by WebGPU" height="28" />](#browser-support-webgpu-required)
[![CI Status](https://img.shields.io/github/actions/workflow/status/chartgpu/chartgpu/tests.yml?branch=main&style=for-the-badge&label=Tests)](https://github.com/chartgpu/chartgpu/actions/workflows/tests.yml)
[![npm version](https://img.shields.io/npm/v/chartgpu?style=for-the-badge&color=blue)](https://www.npmjs.com/package/chartgpu)
[![NPM Downloads](https://img.shields.io/npm/dm/chartgpu?style=for-the-badge&color=%2368cc49)](https://www.npmjs.com/package/chartgpu)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://github.com/chartgpu/chartgpu/blob/main/LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen?style=for-the-badge)](https://chartgpu.io)
[![Documentation](https://img.shields.io/badge/Documentation-Getting%20Started-blue?style=for-the-badge)](https://chartgpu.io/docs/getting-started/)

[<img src="https://hackerbadge.now.sh/api?id=46706528" alt="Featured on Hacker News" height="30" />](https://news.ycombinator.com/item?id=46706528)

[<img src="https://awesome.re/mentioned-badge.svg" alt="Featured in Awesome WebGPU" style="height: 30px;" />](https://github.com/mikbry/awesome-webgpu)

</div>

ChartGPU is a TypeScript WebGPU charting library for browser engineers who need streaming multi-series, multi-chart ops/trading/APM walls, and dense scientific views. MIT for commercial embed. Zero npm runtime dependencies. No WebGL fallback: WebGPU is required.

Use it when Chart.js, ECharts, or uPlot hit streaming or multi-panel walls. Commercial GPU seats often ship WebGL fallback and broader catalog; ChartGPU is the open WebGPU-only embed. Not a formal claim to win every suite row vs SciChart/LightningChart, and not a general "every chart type" catalog.

```bash
npm install @chartgpu/chartgpu
```

```ts
import { ChartGPU } from '@chartgpu/chartgpu';

const el = document.getElementById('chart')!;
const chart = await ChartGPU.create(el, {
  series: [{ type: 'line', data: { x: new Float64Array([0, 1, 2]), y: new Float64Array([1, 3, 2]) } }],
});

// Density path: shared x + per-series y columns, fixed-capacity ring
const x = new Float64Array([3, 4, 5]);
const y = new Float64Array([2.5, 2.1, 2.8]);
chart.appendData(0, { x, y }, { maxPoints: 50_000 });

// Object / [x,y] tuples are fine for tiny demos; prefer columns at scale
```

Unscoped `chartgpu` is also on npm (same version line). GitHub Packages: `@chartgpu:registry=https://npm.pkg.github.com`. React: [`chartgpu-react`](https://github.com/ChartGPU/chartgpu-react) (`npm i chartgpu-react @chartgpu/chartgpu`).

### Shared-device multi-panel (recommended for ≥3 charts)

```ts
import { ChartGPU, createPipelineCache, connectCharts } from '@chartgpu/chartgpu';

if (!navigator.gpu) {
  // Fail closed: never leave a blank canvas without UI
  throw new Error('WebGPU not available');
}

const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) throw new Error('No GPU adapter');
const device = await adapter.requestDevice();
const pipelineCache = createPipelineCache(device);
const ctx = { adapter, device, pipelineCache };

const a = await ChartGPU.create(document.getElementById('a')!, { series: [{ type: 'line', data: { x: new Float64Array([0]), y: new Float64Array([0]) } }] }, ctx);
const b = await ChartGPU.create(document.getElementById('b')!, { series: [{ type: 'line', data: { x: new Float64Array([0]), y: new Float64Array([0]) } }] }, ctx);
const c = await ChartGPU.create(document.getElementById('c')!, { series: [{ type: 'line', data: { x: new Float64Array([0]), y: new Float64Array([0]) } }] }, ctx);

connectCharts([a, b, c], { syncZoom: true });
// You own the device: charts do not destroy it on dispose
// Optional: setRenderMode('external') + renderFrame() for one app rAF loop
```

Full recipes: [multi-chart cookbook](docs/guides/multichart-dashboard-cookbook.md) · [streaming dashboards](https://chartgpu.io/docs/streaming-dashboards/)

---

## Why ChartGPU

| | |
|---|---|
| **Dense real-time jobs** | Multi-series streaming, multi-panel dashboards, finance candles/OHLC, heatmaps |
| **Shared-device multi-panel** | Opt-in shared `GPUDevice` + pipeline cache (recommended for ≥3 charts); optional external rAF via `setRenderMode('external')` + `renderFrame()`; chart sync |
| **Ring FIFO streaming** | `appendData(..., { maxPoints })`; `updateHeatmap` / `updateSurface3D`; not full-rewrite `setOption` every tick |
| **Sampling and gaps** | LTTB / min / max (CPU or GPU for eligible lines); `performance.lod` auto/strict; null gaps; optional `connectNulls` |
| **Multi-axis and themes** | Independent Y axes; multi-chart zoom sync; dark / light / custom themes |
| **MIT commercial embed** | Free density under MIT. Zero npm runtime dependencies. No core feature gates on FIFO, zoom, multi-chart, or finance series |
| **WebGPU-only** | Chrome/Edge 113+, Safari 18+. Explicit browser matrix; no dual-backend WebGL path |

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Performance: [chartgpu.io/docs/performance](https://chartgpu.io/docs/performance/). Theming: [chartgpu.io/docs/theming](https://chartgpu.io/docs/theming/).

---

## Demo

Live product surface: [chartgpu.io](https://chartgpu.io) · [docs](https://chartgpu.io/docs/) · [playground](https://chartgpu.io/docs/playground/)

![ChartGPU demo](https://raw.githubusercontent.com/chartgpu/chartgpu/main/docs/assets/chart-gpu-demo.gif)

### Multi-panel streaming (product hero)

Shared-device multi-chart wall: latency, throughput, errors, resources, live annotations. Architecture sample above; hosted wall and recipes linked next.

[Streaming dashboards](https://chartgpu.io/docs/streaming-dashboards/) · [Multi-chart cookbook (repo)](docs/guides/multichart-dashboard-cookbook.md)

![Streaming multi-chart dashboard](docs/assets/streaming-dashboard-example.png)

### Dense 2D and finance

| Dense scatter (density mode) | Candlestick / OHLC | Annotations |
|:---:|:---:|:---:|
| ![Scatter density](docs/assets/scatter-plot-density-chart-1million-points-example.png) | ![Candlestick](docs/assets/candle-stick-example.png) | ![Annotations](docs/assets/annotations.png) |

Large-N and multi-panel numbers depend on browser, hardware, sampling, and production vs dev dist. Prefer the [hosted demos](https://chartgpu.io) and [performance guide](https://chartgpu.io/docs/performance/) over bare FPS claims. Formal suite tables are versioned separately; do not treat marketing screenshots as competitive scores.

Right-click annotation authoring: [annotations guide](https://chartgpu.io/docs/annotations/) · [`examples/annotation-authoring/`](examples/annotation-authoring/).

---

## Series

Focused on dense real-time work. Full options stay in the API docs.

| Kind | Types / modes | Docs |
|------|----------------|------|
| **Cartesian** | `line`, `area`, `bar`, `scatter`, `pie` | [line](https://chartgpu.io/docs/series/line/) · [scatter](https://chartgpu.io/docs/series/scatter/) |
| **Finance** | `candlestick`, `ohlc` | [candlestick](https://chartgpu.io/docs/series/candlestick/) |
| **Scientific** | `heatmap`, `band`, `errorBar`, `impulse` | [heatmap](https://chartgpu.io/docs/series/heatmap/) |
| **Composition** | `step` on line/area · `stack` mountain/area · scatter `mode: 'density'` | [charting](https://chartgpu.io/docs/charting/) |
| **3D** | `pointCloud3d`, `surface3d` (`coordinateSystem: 'cartesian3d'`) | [API (repo)](docs/api/3d.md) |

Full option reference (repo): [`docs/api/options.md`](docs/api/options.md)

---

## Browser support (WebGPU required)

No WebGL fallback. Unsupported browsers must be gated in your app (capability detect, never a blank canvas).

| Browser | Notes |
|---------|--------|
| Chrome / Edge | 113+ |
| Safari | 18+ |
| Firefox | Windows 114+, macOS 145+, Linux still incomplete on [gpuweb status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) |

Enterprise matrix: WebGPU-only is intentional. If you need universal Canvas/SVG or dual WebGL+WebGPU, evaluate commercial stacks that ship fallbacks.

---

## Documentation

### chartgpu.io

| | |
|---|---|
| [Docs hub](https://chartgpu.io/docs/) | Guides, series, playground |
| [Getting started](https://chartgpu.io/docs/getting-started/) | Install and first chart |
| [Playground](https://chartgpu.io/docs/playground/) | Interactive sandbox |
| [Charting](https://chartgpu.io/docs/charting/) | Series, axes, interaction |
| [Streaming dashboards](https://chartgpu.io/docs/streaming-dashboards/) | Shared device, multi-chart |
| [Annotations](https://chartgpu.io/docs/annotations/) | Lines, markers, labels |
| [Theming](https://chartgpu.io/docs/theming/) | Dark / light / custom |
| [Performance](https://chartgpu.io/docs/performance/) | Density, sampling, GPU sharing |
| [Examples](https://chartgpu.io/#examples) | Live gallery |

### This repository

| | |
|---|---|
| [API hub](docs/api/README.md) | Instance methods, options map, scales |
| [Options](docs/api/options.md) | Full series / axis / streaming types |
| [3D](docs/api/3d.md) | Camera, point cloud, surface, contours |
| [Multi-chart cookbook](docs/guides/multichart-dashboard-cookbook.md) | Shared device recipes |
| [Architecture](docs/ARCHITECTURE.md) | Render path and modules |
| [Internals](docs/api/INTERNALS.md) | Data store, renderers, coordinator |
| [`examples/`](examples/) | Local Vite samples |

```bash
npm install
npm run dev
# http://localhost:5173/examples/
```

---

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## License

[MIT](LICENSE). Free for commercial embedding. Zero npm runtime dependencies. Density, FIFO, multi-chart, and finance series stay in the open core.
