# Getting Started with ChartGPU

Welcome to ChartGPU! This guide will help you create your first GPU-accelerated chart in minutes.

## Prerequisites

Before you begin, ensure your browser supports WebGPU:

- **Chrome 113+** or **Edge 113+** (WebGPU enabled by default)
- **Safari 18+** (WebGPU enabled by default)
- **Firefox**: not yet supported (WebGPU support in development)

You can check WebGPU availability in JavaScript:

```js
if ('gpu' in navigator) {
  console.log('WebGPU is supported!');
} else {
  console.log('WebGPU is not available in this browser.');
}
```

**Note:** ChartGPU will throw an error if WebGPU is unavailable when you try to create a chart. We'll handle this gracefully in the examples below.

## Installation

### Option 1: npm (Recommended)

For modern JavaScript projects using a bundler:

```bash
npm install chartgpu
```

### Option 2: CDN (Quick prototyping)

For quick prototypes or demos, you can import ChartGPU directly from a CDN using ES modules:

- **unpkg**: `https://unpkg.com/chartgpu@0.1.0/dist/index.js`
- **jsDelivr**: `https://cdn.jsdelivr.net/npm/chartgpu@0.1.0/dist/index.js`

**Important:** Always pin to a specific version (e.g., `@0.1.0`) to avoid breaking changes. The CDN build works but is not a separately maintained distribution channel.

## Your First Chart in 5 Steps

Let's create a simple line chart. We'll show two complete paths: one using npm + Vite, and one using a single HTML file with CDN.

### Path 1: npm + Vite

#### Step 1: Create a new project

```bash
npm create vite@latest my-chartgpu-app -- --template vanilla-ts
cd my-chartgpu-app
npm install
npm install chartgpu
```

#### Step 2: Create your HTML (`index.html`)

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ChartGPU - First Chart</title>
    <style>
      body {
        margin: 0;
        padding: 20px;
        font-family: system-ui, -apple-system, sans-serif;
        background: #1a1a1a;
        color: #fff;
      }
      #chart {
        width: 800px;
        height: 400px;
        max-width: 100%;
        background: #2a2a2a;
        border-radius: 8px;
      }
      #error {
        display: none;
        padding: 16px;
        background: #ff4444;
        color: white;
        border-radius: 8px;
        margin-bottom: 16px;
      }
    </style>
  </head>
  <body>
    <div id="error"></div>
    <div id="chart"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

#### Step 3: Create your chart script (`src/main.ts`)

```ts
import { ChartGPU } from 'chartgpu';

const showError = (message: string) => {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
};

async function main() {
  // Check WebGPU support
  if (!('gpu' in navigator)) {
    showError('WebGPU is not supported in this browser. Please use Chrome 113+, Edge 113+, or Safari 18+.');
    return;
  }

  const container = document.getElementById('chart');
  if (!container) {
    throw new Error('Chart container not found');
  }

  try {
    // Create the chart (async!)
    const chart = await ChartGPU.create(container, {
      series: [
        {
          type: 'line',
          name: 'My Data',
          data: [
            [0, 1],
            [1, 3],
            [2, 2],
            [3, 5],
            [4, 4],
          ],
        },
      ],
    });

    // Handle window resize
    window.addEventListener('resize', () => {
      chart.resize();
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      chart.dispose();
    });
  } catch (err) {
    console.error(err);
    showError(err instanceof Error ? err.message : 'Failed to create chart');
  }
}

main();
```

#### Step 4: Run the development server

```bash
npm run dev
```

#### Step 5: Open your browser

Navigate to the URL shown in the terminal (usually `http://localhost:5173/`). You should see your chart!

---

### Path 2: Single HTML file with CDN

For quick prototyping, you can use a single HTML file:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ChartGPU - CDN Example</title>
    <style>
      body {
        margin: 0;
        padding: 20px;
        font-family: system-ui, -apple-system, sans-serif;
        background: #1a1a1a;
        color: #fff;
      }
      #chart {
        width: 800px;
        height: 400px;
        max-width: 100%;
        background: #2a2a2a;
        border-radius: 8px;
      }
      #error {
        display: none;
        padding: 16px;
        background: #ff4444;
        color: white;
        border-radius: 8px;
        margin-bottom: 16px;
      }
    </style>
  </head>
  <body>
    <div id="error"></div>
    <div id="chart"></div>

    <script type="module">
      import { ChartGPU } from 'https://unpkg.com/chartgpu@0.1.0/dist/index.js';

      const showError = (message) => {
        const el = document.getElementById('error');
        if (el) {
          el.textContent = message;
          el.style.display = 'block';
        }
      };

      async function main() {
        // Check WebGPU support
        if (!('gpu' in navigator)) {
          showError('WebGPU is not supported in this browser. Please use Chrome 113+, Edge 113+, or Safari 18+.');
          return;
        }

        const container = document.getElementById('chart');
        if (!container) {
          throw new Error('Chart container not found');
        }

        try {
          // Create the chart (async!)
          const chart = await ChartGPU.create(container, {
            series: [
              {
                type: 'line',
                name: 'My Data',
                data: [
                  [0, 1],
                  [1, 3],
                  [2, 2],
                  [3, 5],
                  [4, 4],
                ],
              },
            ],
          });

          // Handle window resize
          window.addEventListener('resize', () => {
            chart.resize();
          });

          // Cleanup on page unload
          window.addEventListener('beforeunload', () => {
            chart.dispose();
          });
        } catch (err) {
          console.error(err);
          showError(err instanceof Error ? err.message : 'Failed to create chart');
        }
      }

      main();
    </script>
  </body>
</html>
```

Save this as `index.html` and open it with a local development server (see "Common Gotchas" below for why you need a dev server).

---

## Common Gotchas

### 1. Container must have explicit size

ChartGPU needs to know how big to make the canvas. If your container has no width/height, the chart may not render correctly.

**Solution:** Set explicit CSS dimensions on your chart container:

```css
#chart {
  width: 800px;
  height: 400px;
}
```

### 2. Chart creation is async

`ChartGPU.create()` returns a Promise, so you must `await` it or use `.then()`:

```ts
// ✅ Correct
const chart = await ChartGPU.create(container, options);

// ❌ Wrong
const chart = ChartGPU.create(container, options);
```

### 3. Run code after DOM is ready

Make sure your chart container exists in the DOM before calling `ChartGPU.create()`. If using `<script>` tags, place them at the end of `<body>` or use `DOMContentLoaded`:

```ts
document.addEventListener('DOMContentLoaded', () => {
  main();
});
```

### 4. Use a dev server (avoid `file://`)

When using the CDN approach, open your HTML file through a local development server, not by double-clicking the file. Modern ES modules don't work with `file://` URLs.

**Quick dev server options:**

```bash
# Python 3
python -m http.server 8000

# Node.js (npx)
npx serve

# VS Code Live Server extension
```

Then visit `http://localhost:8000` in your browser.

---

## Next Steps

Congratulations! You've created your first ChartGPU chart. Here's what to explore next:

### Learn more about the API

- **[API Reference](./api/README.md)** - Complete API documentation with all chart options
- **[API Reference (auto-generated)](./api-reference.md)** - Comprehensive type definitions and method signatures

### Explore examples

The [`examples/`](../examples/) folder contains working demos of all ChartGPU features:

- **[`basic-line/`](../examples/basic-line/)** - Multi-series line charts with filled areas, axis titles, and event handling
- **[`interactive/`](../examples/interactive/)** - Synchronized charts with custom tooltips and click events
- **[`candlestick-streaming/`](../examples/candlestick-streaming/)** - Live candlestick streaming with 5 million candles at 100+ FPS
- **[`live-streaming/`](../examples/live-streaming/)** - Real-time data streaming with `appendData()`
- **[`sampling/`](../examples/sampling/)** - Large datasets with automatic downsampling and zoom
- **[`scatter/`](../examples/scatter/)** - Scatter plots with thousands of points
- **[`scatter-density-1m/`](../examples/scatter-density-1m/)** - Scatter density/heatmap rendering for large point clouds (`mode: 'density'`). See [`ScatterSeriesConfig`](./api/options.md#scatterseriesconfig) and the example entrypoint [`examples/scatter-density-1m/main.ts`](../examples/scatter-density-1m/main.ts).
- **[`grouped-bar/`](../examples/grouped-bar/)** - Bar charts with clustering and stacking
- **[`pie/`](../examples/pie/)** - Pie and donut charts

To run the examples locally:

```bash
git clone https://github.com/hunterg325/ChartGPU.git
cd ChartGPU
npm install
npm run dev
```

Then open `http://localhost:5176/examples/` in your browser.

### Advanced topics

- **Worker-based rendering**: Use `ChartGPU.createInWorker()` for maximum performance with large datasets (keeps main thread responsive) - see [Worker API](./api/worker.md)
- **Performance monitoring**: Track FPS, frame time, memory usage, and frame drops in real-time - see [Performance Monitoring](#performance-monitoring) below
- **Themes**: Use built-in themes (`theme: 'dark' | 'light'`) or create custom themes
- **Streaming data**: Use `chart.appendData(seriesIndex, newPoints)` for real-time updates
- **Zoom & pan**: Enable interactive zoom with `dataZoom: [{ type: 'inside' }]`
- **Multiple series types**: Mix line, area, bar, scatter, and pie in one chart
- **Animation**: Customize transitions with `animation: { duration, easing, delay }`

## Performance Monitoring

ChartGPU provides a comprehensive performance metrics API for monitoring rendering performance in real-time. This is useful for debugging performance issues, profiling different configurations, and building performance dashboards.

### Basic Usage

Subscribe to performance updates to receive metrics on every render frame:

```ts
import { ChartGPU } from 'chartgpu';

const chart = await ChartGPU.create(container, {
  series: [{ type: 'line', data: myData }]
});

// Subscribe to performance updates (fires every frame, up to 60fps)
const unsubscribe = chart.onPerformanceUpdate((metrics) => {
  console.log('FPS:', metrics.fps);
  console.log('Frame time (avg):', metrics.frameTimeStats.avg, 'ms');
  console.log('Memory (used):', metrics.memory.used, 'bytes');
  console.log('Frame drops:', metrics.frameDrops.totalDrops);
});

// Later: unsubscribe when done
unsubscribe();
```

### Checking Capabilities

Before relying on specific metrics, check which features are supported:

```ts
const capabilities = chart.getPerformanceCapabilities();

if (capabilities?.gpuTimingSupported) {
  console.log('GPU timing is available');
  // Enable GPU timing to get CPU vs GPU time breakdown
}

if (capabilities?.highResTimerSupported) {
  console.log('High-resolution timer available');
}
```

### Getting a Single Snapshot

For one-time measurements, use `getPerformanceMetrics()`:

```ts
const metrics = chart.getPerformanceMetrics();

if (metrics) {
  console.log('Current FPS:', metrics.fps);
  console.log('Total frames rendered:', metrics.totalFrames);
  console.log('Time elapsed:', metrics.elapsedTime, 'ms');
}
```

### Performance Metrics

The `PerformanceMetrics` object includes:

- **`fps`**: Exact frames per second calculated from actual frame time deltas
- **`frameTimeStats`**: Min, max, average, and percentile (p50, p95, p99) frame times
- **`memory`**: Current, peak, and total allocated GPU buffer memory
- **`frameDrops`**: Total dropped frames and consecutive drop streak
- **`gpuTiming`**: CPU vs GPU render time (when supported)
- **`totalFrames`**: Total frames rendered since initialization
- **`elapsedTime`**: Total time elapsed since initialization

### Building a Performance Dashboard

Here's a complete example of building a real-time performance dashboard:

```ts
import { ChartGPU } from 'chartgpu';
import type { PerformanceMetrics } from 'chartgpu';

// Create dashboard elements
const fpsDisplay = document.getElementById('fps');
const frameTimeDisplay = document.getElementById('frameTime');
const memoryDisplay = document.getElementById('memory');
const dropsDisplay = document.getElementById('drops');

// Create chart
const chart = await ChartGPU.create(container, {
  series: [{ type: 'line', data: largeDataset }]
});

// Subscribe to updates
chart.onPerformanceUpdate((metrics: PerformanceMetrics) => {
  // Update FPS display
  if (fpsDisplay) {
    fpsDisplay.textContent = metrics.fps.toFixed(1);
    
    // Color-code based on FPS
    if (metrics.fps >= 55) {
      fpsDisplay.style.color = 'green';
    } else if (metrics.fps >= 30) {
      fpsDisplay.style.color = 'orange';
    } else {
      fpsDisplay.style.color = 'red';
    }
  }
  
  // Update frame time display
  if (frameTimeDisplay) {
    const { min, max, avg, p95, p99 } = metrics.frameTimeStats;
    frameTimeDisplay.textContent = 
      `${min.toFixed(1)} / ${avg.toFixed(1)} / ${max.toFixed(1)} / ${p95.toFixed(1)} / ${p99.toFixed(1)} ms`;
  }
  
  // Update memory display
  if (memoryDisplay) {
    const usedMB = (metrics.memory.used / (1024 * 1024)).toFixed(1);
    const peakMB = (metrics.memory.peak / (1024 * 1024)).toFixed(1);
    memoryDisplay.textContent = `${usedMB} MB / ${peakMB} MB (peak)`;
  }
  
  // Update frame drops display
  if (dropsDisplay) {
    dropsDisplay.textContent = 
      `${metrics.frameDrops.totalDrops} total, ${metrics.frameDrops.consecutiveDrops} consecutive`;
  }
});
```

### Worker Mode Support

Performance monitoring works identically in worker mode:

```ts
// Create worker-based chart
const chart = await ChartGPU.createInWorker(container, {
  series: [{ type: 'line', data: largeDataset }]
});

// Subscribe to performance updates (metrics forwarded from worker)
chart.onPerformanceUpdate((metrics) => {
  console.log('Worker FPS:', metrics.fps);
});
```

For a complete working example with a performance dashboard, see [`examples/worker-rendering/main.ts`](../examples/worker-rendering/main.ts).

### API Reference

For detailed type definitions and method signatures, see:
- [Performance Monitoring](./api/chart.md#performance-monitoring) - Chart instance methods
- [Performance Metrics Types](./api/options.md#performance-metrics-types) - Type definitions
- [Worker Performance](./api/worker.md#performance-monitoring-in-worker-mode) - Worker-specific details

---

## Support

If you run into issues:

1. **Check browser support**: Ensure you're using Chrome 113+, Edge 113+, or Safari 18+
2. **Check the console**: Look for error messages in your browser's developer console (F12)
3. **Review the examples**: The [`examples/`](../examples/) folder has working code for reference
4. **Read the docs**: See [`docs/api/README.md`](./api/README.md) for detailed API documentation

---

Happy charting! 🚀
