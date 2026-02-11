<p align="center" style="margin-bottom:0; margin-top:20px;">
  <img src="docs/assets/chartgpu.png" alt="ChartGPU" width="400">
</p>

<p align="center" style="margin-top:-18px;">
  The fastest open-source charting library — 50M points at 60 FPS, powered by WebGPU.
</p>

<div align="center">


[<img src="docs/assets/powered-by-webgpu.svg" alt="Powered by WebGPU" height="28" />](https://forthebadge.com)
[![GitHub Stars](https://img.shields.io/github/stars/ChartGPU/chartgpu?style=for-the-badge&color=yellow)](https://github.com/chartgpu/chartgpu)
[![CI Status](https://img.shields.io/github/actions/workflow/status/chartgpu/chartgpu/tests.yml?branch=main&style=for-the-badge&label=Tests)](https://github.com/chartgpu/chartgpu/actions/workflows/tests.yml)
[![npm version](https://img.shields.io/npm/v/chartgpu?style=for-the-badge&color=blue)](https://www.npmjs.com/package/chartgpu)
[![NPM Downloads](https://img.shields.io/npm/dm/chartgpu?style=for-the-badge&color=%2368cc49)](https://www.npmjs.com/package/chartgpu)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://github.com/chartgpu/chartgpu/blob/main/LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen?style=for-the-badge)](https://chartgpu.github.io/chartgpu/)
[![Examples](https://img.shields.io/badge/Examples-Code%20Samples-blue?style=for-the-badge)](https://github.com/chartgpu/chartgpu/tree/main/examples)
[![Documentation](https://img.shields.io/badge/Documentation-Getting%20Started-blue?style=for-the-badge)](https://github.com/chartgpu/chartgpu/blob/main/docs/GETTING_STARTED.md)

[<img src="https://hackerbadge.now.sh/api?id=46706528" alt="Featured on Hacker News" height="30" />](https://news.ycombinator.com/item?id=46706528)

[<img src="https://awesome.re/mentioned-badge.svg" alt="Featured in Awesome WebGPU" style="height: 30px;" />](https://github.com/mikbry/awesome-webgpu)


</div>

ChartGPU is a TypeScript charting library built on WebGPU for smooth, interactive rendering—especially when you have lots of data.

## Demo

![ChartGPU demo](https://raw.githubusercontent.com/chartgpu/chartgpu/main/docs/assets/chart-gpu-demo.gif)

### 35M points (benchmark)

35,000,000 points rendered at ~72 FPS (benchmark mode).

![35 million point benchmark at 72 FPS](docs/assets/35-million-ultimate-benchmark-example.png)

## Quick Start

```ts
import { ChartGPU } from 'chartgpu';
const container = document.getElementById('chart')!;
await ChartGPU.create(container, {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
});
```

### Annotations

Add reference lines, point markers, and text overlays to highlight important data features:

```ts
await ChartGPU.create(container, {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
  annotations: [
    // Horizontal reference line
    {
      id: 'ref-y',
      type: 'lineY',
      y: 2.5,
      layer: 'belowSeries',
      style: { color: '#ffd166', lineWidth: 2, lineDash: [8, 6], opacity: 0.95 },
      label: { text: 'threshold' },
    },
    // Point marker at peak
    {
      id: 'peak',
      type: 'point',
      x: 1,
      y: 3,
      layer: 'aboveSeries',
      marker: { symbol: 'circle', size: 8, style: { color: '#ff4ab0' } },
      label: { template: 'peak={y}', decimals: 2 },
    },
  ],
});
```

See [Annotations Documentation](https://github.com/chartgpu/chartgpu/blob/main/docs/api/options.md#annotations) and the [annotations example](https://github.com/chartgpu/chartgpu/tree/main/examples/annotation-authoring).

## Highlights

- 🚀 WebGPU-accelerated rendering for high FPS with large datasets
- 📈 Multiple series types: line, area, bar, scatter, pie, candlestick
- 🌡️ Scatter density/heatmap mode (`mode: 'density'`) for large point clouds — see [`docs/api/options.md#scatterseriesconfig`](docs/api/options.md#scatterseriesconfig) and [`examples/scatter-density-1m/`](examples/scatter-density-1m/)
- 📍 Annotation overlays: reference lines (horizontal/vertical), point markers, and text labels — see [`docs/api/options.md#annotations`](docs/api/options.md#annotations) and [`examples/annotations/`](examples/annotations/)
- 🧭 Built-in interaction: hover highlight, tooltip, crosshair
- 🔁 Streaming updates via `appendData(...)` with typed-array support (`XYArraysData`, `InterleavedXYData`, `DataPoint[]`) — see [`examples/cartesian-data-formats/`](examples/cartesian-data-formats/)
- 🔍 X-axis zoom (inside gestures + optional slider UI)
- 🎛️ Theme presets (`'dark' | 'light'`) and custom theme support

## Performance

ChartGPU leverages WebGPU to render datasets orders of magnitude larger than traditional Canvas2D or SVG-based charting libraries. The table below shows ChartGPU line-chart FPS at various dataset sizes, measured with the [benchmark harness](examples/benchmark-comparison/) on an Apple M3 Pro / Chrome 131 / 2x DPR at 800x500 canvas.

| Data Points | ChartGPU (WebGPU) | Canvas2D Libraries | SVG Libraries |
|:-----------:|:------------------:|:------------------:|:-------------:|
| **100K** | ~60 FPS | ~30-60 FPS | ~5-15 FPS |
| **1M** | ~60 FPS | ~1-5 FPS | N/A |
| **10M** | ~60 FPS | N/A | N/A |
| **35M** | ~72 FPS | N/A | N/A |

> **Note**: Canvas2D and SVG columns show typical ranges for popular libraries (Chart.js, ECharts, D3) based on publicly available benchmarks. "N/A" means the library cannot render that dataset size interactively. Actual results vary by hardware, browser, and library version. Run the [benchmark harness](examples/benchmark-comparison/) to produce numbers for your own environment. See [`docs/benchmarks/comparison.md`](docs/benchmarks/comparison.md) for full methodology.

### Candlestick Charts

Financial OHLC (open-high-low-close) candlestick rendering with classic/hollow style toggle and color customization. The live streaming demo renders **5 million candlesticks at over 100 FPS** with real-time updates.

![Candlestick chart example](docs/assets/candle-stick-example.png)

### Scatter Density (1M points)

GPU-binned density/heatmap mode for scatter plots (`mode: 'density'`) to reveal structure in overplotted point clouds. See [`docs/api/options.md#scatterseriesconfig`](docs/api/options.md#scatterseriesconfig) and the demo in [`examples/scatter-density-1m/`](examples/scatter-density-1m/).

![Scatter density chart example (1M points)](docs/assets/scatter-plot-density-chart-1million-points-example.png)

### Interactive Annotation Authoring

Full-featured annotation authoring system with interactive editing capabilities. Create, edit, drag, and delete annotations with an intuitive UI. Supports all annotation types: reference lines (horizontal/vertical), point markers, text annotations (plot-space + data-space tracking), labels, and styling options.

![Annotations comprehensive demo](docs/assets/annotations.png)

**Key features:**
- **Right-click empty space** → Add vertical/horizontal line or text note with custom color, style & label
- **Click & drag annotations** → Reposition them (lines constrained to their axis)
- **Right-click on annotation** → Edit properties or delete
- **Full styling control** → Color picker, line style (solid/dashed), line width, and label customization
- **Undo/Redo support** → All annotations are reversible
- **Scroll to zoom, Drag to pan** → Standard chart interactions work seamlessly

![Annotation configuration dialog](docs/assets/annontations-add-indicator.png)

The annotation authoring system is demonstrated in the [`examples/annotation-authoring/`](examples/annotation-authoring/) example.

## Installation

```bash
npm install chartgpu
```

**GitHub Packages:**

```bash
npm install @chartgpu/chartgpu
```

For GitHub Packages, configure your `.npmrc`:

```
@chartgpu:registry=https://npm.pkg.github.com
```

## React Integration

React bindings are available via [`chartgpu-react`](https://github.com/ChartGPU/chartgpu-react):

```bash
npm install chartgpu-react
```

```tsx
import { ChartGPUChart } from 'chartgpu-react';

function MyChart() {
  return (
    <ChartGPUChart
      options={{
        series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
      }}
    />
  );
}
```

See the [chartgpu-react repository](https://github.com/ChartGPU/chartgpu-react) for full documentation and examples.

## Browser support (WebGPU required)

- Chrome 113+ or Edge 113+ (WebGPU enabled by default)
- Safari 18+ (WebGPU enabled by default)
- Firefox: Windows 114+, Mac 145+, Linux nightly

See the [gpuweb repository](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) for full Implementation Status

## Who's Using ChartGPU

ChartGPU is a young project and we'd love to hear how you're using it! If your team or project uses ChartGPU, [open a pull request](https://github.com/chartgpu/chartgpu/pulls) to add your name here.

<!-- Add your project/company below:
- [Your Project](https://link) — short description
-->

## Documentation

- Full documentation: [Getting Started](https://github.com/chartgpu/chartgpu/blob/main/docs/GETTING_STARTED.md)
- API reference: [`docs/api/README.md`](https://github.com/chartgpu/chartgpu/blob/main/docs/api/README.md)

## Examples

- Browse examples: [`examples/`](https://github.com/chartgpu/chartgpu/tree/main/examples)
- Run locally:
  - `npm install`
  - `npm run dev` (opens `http://localhost:5173/examples/`)

## Contributing

See [`CONTRIBUTING.md`](https://github.com/chartgpu/chartgpu/blob/main/CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](https://github.com/chartgpu/chartgpu/blob/main/LICENSE).

## Architecture

ChartGPU follows a functional-first architecture. `ChartGPU.create(...)` owns the canvas and WebGPU lifecycle, delegating render orchestration to a modular render coordinator with 11 specialized modules.

For the full architecture diagram, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). For deep internal notes, see [`docs/api/INTERNALS.md`](docs/api/INTERNALS.md).