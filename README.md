# ChartGPU

High-performance charts powered by WebGPU.

![npm](https://img.shields.io/npm/v/chartgpu)
![license](https://img.shields.io/npm/l/chartgpu)
![install size](https://packagephobia.com/badge?p=chartgpu)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://chartgpu.github.io/ChartGPU/)

**[📊 View Live Examples](https://chartgpu.github.io/ChartGPU/)**

ChartGPU is a TypeScript charting library built on WebGPU for smooth, interactive rendering—especially when you have lots of data.

## Highlights

- 🚀 WebGPU-accelerated rendering for high FPS with large datasets
- 📈 Multiple series types: line, area, bar, scatter, pie
- 🧭 Built-in interaction: hover highlight, tooltip, crosshair
- 🔁 Streaming updates via `appendData(...)` (cartesian series)
- 🔍 X-axis zoom (inside gestures + optional slider UI)
- 🎛️ Theme presets (`'dark' | 'light'`) and custom theme support

## Demo

![ChartGPU demo](https://raw.githubusercontent.com/hunterg325/ChartGPU/main/docs/assets/chart-gpu-demo.gif)

## Quick start

```ts
import { ChartGPU } from 'chartgpu';
const container = document.getElementById('chart')!;
await ChartGPU.create(container, {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
});
```

## Installation

`npm install chartgpu`

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
- Firefox: not supported (WebGPU support in development)

## Documentation

- Full documentation: [Getting Started](https://github.com/hunterg325/ChartGPU/blob/main/docs/GETTING_STARTED.md)
- API reference: [`docs/API.md`](https://github.com/hunterg325/ChartGPU/blob/main/docs/API.md)

## Examples

- Browse examples: [`examples/`](https://github.com/hunterg325/ChartGPU/tree/main/examples)
- Run locally:
  - `npm install`
  - `npm run dev` (opens `http://localhost:5176/examples/`)

## Contributing

See [`CONTRIBUTING.md`](https://github.com/hunterg325/ChartGPU/blob/main/CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](https://github.com/hunterg325/ChartGPU/blob/main/LICENSE).
