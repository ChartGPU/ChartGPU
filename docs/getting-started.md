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

- **Themes**: Use built-in themes (`theme: 'dark' | 'light'`) or create custom themes
- **Streaming data**: Use `chart.appendData(seriesIndex, newPoints)` for real-time updates
- **Zoom & pan**: Enable interactive zoom with `dataZoom: [{ type: 'inside' }]`
- **Multiple series types**: Mix line, area, bar, scatter, and pie in one chart
- **Animation**: Customize transitions with `animation: { duration, easing, delay }`

---

## Support

If you run into issues:

1. **Check browser support**: Ensure you're using Chrome 113+, Edge 113+, or Safari 18+
2. **Check the console**: Look for error messages in your browser's developer console (F12)
3. **Review the examples**: The [`examples/`](../examples/) folder has working code for reference
4. **Read the docs**: See [`docs/api/README.md`](./api/README.md) for detailed API documentation

---

Happy charting! 🚀
