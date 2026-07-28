# Getting Started with ChartGPU

Create your first GPU-accelerated chart in minutes.

## Prerequisites

- **Chrome 113+**, **Edge 113+**, or **Safari 18+** (WebGPU enabled by default)
- Check support: `'gpu' in navigator`

## Installation

```bash
npm install chartgpu
```

## Your First Chart

```bash
npm create vite@latest my-chart -- --template vanilla-ts
cd my-chart && npm install && npm install chartgpu
```

**`index.html`** — container with explicit size:

```html
<div id="chart" style="width: 800px; height: 400px;"></div>
<script type="module" src="/src/main.ts"></script>
```

**`src/main.ts`**:

```ts
import { ChartGPU } from 'chartgpu';

const container = document.getElementById('chart')!;
const chart = await ChartGPU.create(container, {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2], [3, 5], [4, 4]] }],
});

window.addEventListener('resize', () => chart.resize());
window.addEventListener('beforeunload', () => chart.dispose());
```

Run `npm run dev` and open the URL shown.

## Gotchas

- **Container size**: Set explicit `width`/`height` (CSS px) on the chart container.
- **Async create**: `ChartGPU.create()` returns a Promise — use `await`.
- **DOM ready**: Ensure container exists before calling `create()`.

## Next Steps

- **[API Reference](https://chartgpu.io/docs/api/)** — Options, series, axes, tooltip, zoom, themes
- **[Examples](../examples/)** — `basic-line`, `interactive`, `live-streaming`, `scatter-density-1m`, `candlestick`, `candlestick-streaming`, etc.
- **[Options](https://chartgpu.io/docs/api/options/)** — Series, axes, zoom, tooltip; candlestick **price axis** / `priceLabel` (right rail, last-price badge, dual-Y gutters)
- **[Performance](https://chartgpu.io/docs/performance/)** — Sampling, streaming, zoom-aware resampling
- **[Theming](https://chartgpu.io/docs/api/themes/)** — Built-in themes, custom themes
- **[Annotations](https://chartgpu.io/docs/api/annotations/)** — Reference lines, point markers, interactive authoring

## Support

1. Check browser support (Chrome 113+, Edge 113+, Safari 18+)
2. Check console for errors
3. See [examples](../examples/) for working code
4. See [API docs](https://chartgpu.io/docs/api/) and [troubleshooting](https://chartgpu.io/docs/api/troubleshooting/)
