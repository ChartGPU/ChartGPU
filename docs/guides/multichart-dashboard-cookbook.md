# Multi-Chart Dashboard Cookbook

Practical recipes for building multi-chart dashboards with ChartGPU.

## Quick Start

Creating multiple charts is straightforward — just call `ChartGPU.create()` for each container:

```typescript
import { ChartGPU } from 'chartgpu';

// Create two independent charts
const chart1 = await ChartGPU.create(container1, {
  series: [{ type: 'line', data: dataset1 }]
});

const chart2 = await ChartGPU.create(container2, {
  series: [{ type: 'bar', data: dataset2 }]
});

// Later: cleanup
chart1.dispose();
chart2.dispose();
```

Each chart creates its own `GPUDevice` independently (~50-100ms initialization per chart). For dashboards with 3+ charts, use a **shared device** instead.

## Shared GPUDevice

For multi-chart dashboards, share a single `GPUDevice` across all charts to reduce GPU memory overhead and avoid repeated initialization.

### Basic Pattern

```typescript
import { ChartGPU } from 'chartgpu';

// 1. Create a shared GPUAdapter and GPUDevice once
const adapter = await navigator.gpu.requestAdapter({ 
  powerPreference: 'high-performance' 
});
if (!adapter) throw new Error('No WebGPU adapter available');

const device = await adapter.requestDevice();

// 2. Pass shared device to all charts via third parameter
const chart1 = await ChartGPU.create(container1, chartOptions1, { adapter, device });
const chart2 = await ChartGPU.create(container2, chartOptions2, { adapter, device });
const chart3 = await ChartGPU.create(container3, chartOptions3, { adapter, device });

// 3. Cleanup: dispose all charts first, then destroy the shared device
chart1.dispose();
chart2.dispose();
chart3.dispose();

device.destroy();
```

**Important:** The third parameter to `ChartGPU.create()` is `{ adapter: GPUAdapter, device: GPUDevice }`. Both fields are required when using shared device mode.

### Ownership and Lifecycle

**Charts with injected devices do NOT destroy the device on dispose:**

- **Your responsibility:** Destroy the shared device after all charts are disposed
- **Canvas unconfiguration:** Always happens on `dispose()`, regardless of device ownership (releases textures)
- **Cleanup order:** Dispose all charts first → then `device.destroy()`

```typescript
// Cleanup pattern
async function cleanupDashboard(charts: ChartGPUInstance[], device: GPUDevice) {
  // 1. Dispose all charts (unconfigures canvases, releases resources)
  for (const chart of charts) {
    chart.dispose();
  }
  
  // 2. Now safe to destroy the shared device
  device.destroy();
}
```

### Benefits

**Shared device advantages:**

- **Faster initialization:** Avoids N independent GPU device setups (~50-100ms each)
- **Reduced memory pressure:** Shared buffer pools and pipeline caches
- **Single capability negotiation:** One adapter request for all charts
- **WebGPU spec compliant:** One `GPUDevice` can configure multiple `GPUCanvasContext`s

**When to use:**

- Dashboards with 3+ charts (overhead vs. benefit tradeoff)
- Real-time monitoring dashboards with many synchronized charts
- Applications already managing a WebGPU device for other purposes

## Chart Sync

Connect multiple charts to synchronize crosshair, tooltip, and zoom/pan interactions using `connectCharts()`.

### Crosshair + Tooltip Sync (default)

```typescript
import { ChartGPU, connectCharts } from 'chartgpu';

const chart1 = await ChartGPU.create(container1, options1);
const chart2 = await ChartGPU.create(container2, options2);
const chart3 = await ChartGPU.create(container3, options3);

// Sync crosshair and tooltip across all charts
const disconnect = connectCharts([chart1, chart2, chart3], {
  syncCrosshair: true  // default, can be omitted
});

// Later: disconnect sync
disconnect();
```

When the user hovers over any chart, all connected charts show the crosshair at the same x-coordinate (in domain units).

### Zoom + Pan Sync

```typescript
// Sync both zoom and pan gestures
const disconnect = connectCharts([chart1, chart2, chart3], {
  syncCrosshair: true,  // default
  syncZoom: true        // opt-in
});
```

**Important requirements for zoom sync:**

- **All charts must have `dataZoom` configured** (otherwise `setZoomRange()` is a no-op)
- Each chart should configure data zoom (e.g., `dataZoom: [{ type: 'inside' }, { type: 'slider' }]`)

Example with zoom sync:

```typescript
const chartA = await ChartGPU.create(containerA, {
  series: [{ type: 'line', data: dataA }],
  dataZoom: [
    { type: 'inside' },
    { type: 'slider' }
  ]
});

const chartB = await ChartGPU.create(containerB, {
  series: [{ type: 'line', data: dataB }],
  dataZoom: [
    { type: 'inside' },
    { type: 'slider' }
  ]
});

const disconnect = connectCharts([chartA, chartB], {
  syncZoom: true
});
```

### Auto-Scroll and Sync

**Important:** Zoom sync **ignores `'auto-scroll'` zoom changes**. This is by design to prevent streaming charts from shifting other charts' views.

```typescript
// Streaming chart with auto-scroll
const streamingChart = await ChartGPU.create(container1, {
  series: [{ type: 'line', data: [] }],
  autoScroll: true,  // Enables auto-scroll on streaming data
  dataZoom: [{ type: 'inside' }, { type: 'slider' }]
});

// Static chart synced with streaming chart
const staticChart = await ChartGPU.create(container2, {
  series: [{ type: 'line', data: staticData }],
  dataZoom: [{ type: 'inside' }, { type: 'slider' }]
});

connectCharts([streamingChart, staticChart], { syncZoom: true });

// Auto-scroll adjustments in streamingChart do NOT propagate to staticChart
streamingChart.appendData(0, newPoints);  // Auto-scroll happens independently
```

### Disconnecting Sync

```typescript
const disconnect = connectCharts([chart1, chart2, chart3], {
  syncCrosshair: true,
  syncZoom: true
});

// Later: remove sync listeners
disconnect();

// On disconnect, ChartGPU clears synced crosshair/tooltip state
// but does NOT reset zoom (preserves user's zoom level)
```

## Shared Device + Sync

The production pattern: combine shared device and chart sync for optimal dashboard performance.

```typescript
import { ChartGPU, connectCharts } from 'chartgpu';

// 1. Create shared device
const adapter = await navigator.gpu.requestAdapter({ 
  powerPreference: 'high-performance' 
});
if (!adapter) throw new Error('No WebGPU adapter available');
const device = await adapter.requestDevice();

// 2. Create charts with shared device
const chart1 = await ChartGPU.create(container1, {
  series: [{ type: 'line', data: dataset1 }],
  dataZoom: [{ type: 'inside' }, { type: 'slider' }]
}, { adapter, device });

const chart2 = await ChartGPU.create(container2, {
  series: [{ type: 'line', data: dataset2 }],
  dataZoom: [{ type: 'inside' }, { type: 'slider' }]
}, { adapter, device });

const chart3 = await ChartGPU.create(container3, {
  series: [{ type: 'bar', data: dataset3 }],
  dataZoom: [{ type: 'inside' }, { type: 'slider' }]
}, { adapter, device });

// 3. Connect charts for interaction sync
const disconnect = connectCharts([chart1, chart2, chart3], {
  syncCrosshair: true,
  syncZoom: true
});

// 4. Full cleanup
function cleanup() {
  disconnect();           // Remove sync listeners
  chart1.dispose();
  chart2.dispose();
  chart3.dispose();
  device.destroy();       // Destroy shared device last
}
```

## Shared Device + Pipeline Cache

When you have many charts of the **same series types** (common in dashboards), you can additionally share a **pipeline cache** to dedupe WebGPU shader modules and render pipelines across charts.

```ts
import { ChartGPU, createPipelineCache } from 'chartgpu';

// 1. Create shared device once
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) throw new Error('No WebGPU adapter available');
const device = await adapter.requestDevice();

// 2. Create pipeline cache bound to that device
const pipelineCache = createPipelineCache(device);

// 3. Create charts with shared device + cache
const chart1 = await ChartGPU.create(container1, chartOptions1, { adapter, device, pipelineCache });
const chart2 = await ChartGPU.create(container2, chartOptions2, { adapter, device, pipelineCache });
const chart3 = await ChartGPU.create(container3, chartOptions3, { adapter, device, pipelineCache });

// Optional: inspect hit/miss stats
console.log(pipelineCache.getStats());
```

**Notes:**
- The cache is **opt-in**. If you omit `pipelineCache`, behavior is unchanged.
- The cache is scoped to a single `GPUDevice` and validates device mismatches.
- It dedupes **shader modules + render pipelines**. Compute pipelines (e.g. scatter-density binning/reduction) are not yet cached.

## Device Loss Handling & Recovery

WebGPU devices can be lost due to GPU driver crashes, system sleep, or resource exhaustion. Charts with injected (shared) devices emit a `'deviceLost'` event for manual recovery.

### Device Lost Event

```typescript
chart.on('deviceLost', (info) => {
  console.error('Device lost:', info.reason, info.message);
  // info.reason: 'unknown' | 'destroyed'
  // info.message: Human-readable description from browser
});
```

**Important:**

- **Only charts with injected devices emit `'deviceLost'`** (charts with self-owned devices handle loss internally)
- **Device loss is NOT recoverable** — must create a new device
- **Recovery flow:** Dispose all charts → destroy old device → request new adapter/device → recreate charts

### Full Recovery Pattern

```typescript
import { ChartGPU, connectCharts, type ChartGPUInstance } from 'chartgpu';

let charts: ChartGPUInstance[] = [];
let shared: { adapter: GPUAdapter; device: GPUDevice };
let disconnect: (() => void) | null = null;

async function createSharedContext(): Promise<{ adapter: GPUAdapter; device: GPUDevice }> {
  const adapter = await navigator.gpu.requestAdapter({ 
    powerPreference: 'high-performance' 
  });
  if (!adapter) throw new Error('No WebGPU adapter available');
  const device = await adapter.requestDevice();
  return { adapter, device };
}

async function initDashboard() {
  // 1. Create shared device
  shared = await createSharedContext();
  
  // 2. Create charts
  charts = [
    await ChartGPU.create(container1, chartOptions1, shared),
    await ChartGPU.create(container2, chartOptions2, shared),
    await ChartGPU.create(container3, chartOptions3, shared)
  ];
  
  // 3. Connect charts
  disconnect = connectCharts(charts, {
    syncCrosshair: true,
    syncZoom: true
  });
  
  // 4. Attach device loss handlers
  charts.forEach(chart => {
    chart.on('deviceLost', handleDeviceLoss);
  });
}

async function handleDeviceLoss(info: { reason: string; message: string }) {
  console.error('Device lost - recovering...', info);
  
  // 1. Disconnect sync
  if (disconnect) {
    disconnect();
    disconnect = null;
  }
  
  // 2. Dispose all charts
  await Promise.all(charts.map(c => c.dispose()));
  charts = [];
  
  // 3. Destroy the lost device (safe even if already destroyed)
  shared.device.destroy();
  
  // 4. Recreate everything
  await initDashboard();
  
  console.log('Dashboard recovered successfully');
}

// Initialize
await initDashboard();
```

## Streaming Data in Dashboards

Each chart can stream data independently using `appendData()`. Shared device doesn't affect streaming behavior.

### Independent Streaming

```typescript
// Create streaming charts with shared device
const chart1 = await ChartGPU.create(container1, {
  series: [{ type: 'line', data: [] }],
  autoScroll: true,
  dataZoom: [{ type: 'inside' }]
}, { adapter, device });

const chart2 = await ChartGPU.create(container2, {
  series: [{ type: 'line', data: [] }],
  autoScroll: true,
  dataZoom: [{ type: 'inside' }]
}, { adapter, device });

// Stream different data to each chart
setInterval(() => {
  const timestamp = Date.now();
  
  // Chart 1: CPU metrics
  chart1.appendData(0, [[timestamp, Math.random() * 100]]);
  
  // Chart 2: Memory metrics
  chart2.appendData(0, [[timestamp, Math.random() * 8000]]);
}, 1000);
```

### Streaming with Typed Arrays

Use `Float32Array` interleaved format for zero-copy GPU upload:

```typescript
// Generate 10 new points
const count = 10;
const interleaved = new Float32Array(count * 2);
const baseTime = Date.now();

for (let i = 0; i < count; i++) {
  interleaved[i * 2] = baseTime + i * 100;       // x (timestamp)
  interleaved[i * 2 + 1] = Math.random() * 100;  // y (value)
}

chart.appendData(0, interleaved);
```

### Coordinated Streaming

Stream correlated data to multiple synced charts:

```typescript
function streamDashboard(metrics: { timestamp: number; cpu: number; memory: number; disk: number }) {
  // All charts receive the same timestamp for alignment
  cpuChart.appendData(0, [[metrics.timestamp, metrics.cpu]]);
  memoryChart.appendData(0, [[metrics.timestamp, metrics.memory]]);
  diskChart.appendData(0, [[metrics.timestamp, metrics.disk]]);
}

// Fetch and stream data
setInterval(async () => {
  const metrics = await fetchSystemMetrics();
  streamDashboard(metrics);
}, 1000);
```

**Tip:** Use `autoScroll: true` for real-time tailing behavior in monitoring dashboards.

## Resize Handling

Use `ResizeObserver` to detect container size changes and call `chart.resize()` in `requestAnimationFrame`.

### Pattern for Multiple Charts

```typescript
const charts = [chart1, chart2, chart3];
const containers = [container1, container2, container3];

// Create one ResizeObserver per container
const observers = containers.map((container, i) => {
  let rafId: number | null = null;
  
  const observer = new ResizeObserver(() => {
    // Debounce resize with rAF
    if (rafId !== null) cancelAnimationFrame(rafId);
    
    rafId = requestAnimationFrame(() => {
      charts[i].resize();
      rafId = null;
    });
  });
  
  observer.observe(container);
  return observer;
});

// Cleanup: disconnect all observers
function cleanup() {
  observers.forEach(obs => obs.disconnect());
  charts.forEach(chart => chart.dispose());
}
```

### Container Layout Tips

**CSS Grid (recommended for dashboards):**

```css
.dashboard {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 16px;
  height: 100vh;
}

.chart-container {
  min-width: 0;  /* Prevent overflow */
  min-height: 0;
}
```

**Flexbox:**

```css
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100vh;
}

.chart-container {
  flex: 1;
  min-height: 0;  /* Critical for flex sizing */
}
```

**Tip:** Always set `min-width: 0` and `min-height: 0` on chart containers inside grid/flex layouts to prevent overflow issues.

## Cleanup & Disposal

Proper cleanup prevents memory leaks and resource exhaustion. Follow this order:

### Full Cleanup Checklist

```typescript
import { ChartGPU, connectCharts, type ChartGPUInstance } from 'chartgpu';

class Dashboard {
  private charts: ChartGPUInstance[] = [];
  private device: GPUDevice | null = null;
  private disconnect: (() => void) | null = null;
  private observers: ResizeObserver[] = [];
  
  async init() {
    // Create shared device
    const adapter = await navigator.gpu.requestAdapter({ 
      powerPreference: 'high-performance' 
    });
    if (!adapter) throw new Error('No WebGPU adapter available');
    this.device = await adapter.requestDevice();
    
    // Create charts
    this.charts = [
      await ChartGPU.create(container1, options1, { 
        adapter, 
        device: this.device 
      }),
      await ChartGPU.create(container2, options2, { 
        adapter, 
        device: this.device 
      }),
      await ChartGPU.create(container3, options3, { 
        adapter, 
        device: this.device 
      })
    ];
    
    // Connect charts
    this.disconnect = connectCharts(this.charts, {
      syncCrosshair: true,
      syncZoom: true
    });
    
    // Set up resize observers
    const containers = [container1, container2, container3];
    this.charts.forEach((chart, i) => {
      const observer = new ResizeObserver(() => {
        requestAnimationFrame(() => chart.resize());
      });
      observer.observe(containers[i]);
      this.observers.push(observer);
    });
  }
  
  dispose() {
    // 1. Disconnect sync groups
    if (this.disconnect) {
      this.disconnect();
      this.disconnect = null;
    }
    
    // 2. Disconnect ResizeObservers
    this.observers.forEach(obs => obs.disconnect());
    this.observers = [];
    
    // 3. Dispose each chart
    this.charts.forEach(chart => chart.dispose());
    this.charts = [];
    
    // 4. Destroy shared device (after all charts disposed)
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
  }
}

// Usage
const dashboard = new Dashboard();
await dashboard.init();

// Later: cleanup
dashboard.dispose();
```

**Critical order:**

1. Disconnect sync groups (remove event listeners)
2. Disconnect ResizeObservers (remove resize listeners)
3. Dispose each chart (unconfigure canvases, release GPU resources)
4. Destroy shared device (if using shared device mode)

## Performance Tips

Optimize multi-chart dashboards with these strategies:

### Use Shared Device for 3+ Charts

```typescript
// BAD: Each chart creates its own device
const charts = await Promise.all([
  ChartGPU.create(container1, options1),  // ~50-100ms initialization
  ChartGPU.create(container2, options2),  // ~50-100ms initialization
  ChartGPU.create(container3, options3),  // ~50-100ms initialization
  ChartGPU.create(container4, options4),  // ~50-100ms initialization
]);
// Total: ~200-400ms + memory overhead

// GOOD: Share one device across all charts
const adapter = await navigator.gpu.requestAdapter({ 
  powerPreference: 'high-performance' 
});
const device = await adapter.requestDevice();  // ~50-100ms once

const charts = await Promise.all([
  ChartGPU.create(container1, options1, { adapter, device }),
  ChartGPU.create(container2, options2, { adapter, device }),
  ChartGPU.create(container3, options3, { adapter, device }),
  ChartGPU.create(container4, options4, { adapter, device })
]);
// Total: ~50-100ms + reduced memory overhead
```

### Use High-Performance Power Preference

```typescript
const adapter = await navigator.gpu.requestAdapter({ 
  powerPreference: 'high-performance'  // Prioritize performance over battery
});
```

### Debounce Resize with rAF

```typescript
// GOOD: Debounce with requestAnimationFrame
let rafId: number | null = null;

resizeObserver = new ResizeObserver(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  
  rafId = requestAnimationFrame(() => {
    chart.resize();
    rafId = null;
  });
});
```

### Use connectCharts Instead of Manual Wiring

```typescript
// BAD: Manual event wiring (error-prone, harder to cleanup)
chart1.on('crosshairMove', ({ x }) => {
  if (x !== null) chart2.setCrosshairX(x);
});
chart2.on('crosshairMove', ({ x }) => {
  if (x !== null) chart1.setCrosshairX(x);
});

// GOOD: Use connectCharts (handles sync loops, cleanup)
const disconnect = connectCharts([chart1, chart2], {
  syncCrosshair: true
});
```

### Batch Streaming Data

```typescript
// BAD: Many small appends (triggers multiple renders)
dataPoints.forEach(point => {
  chart.appendData(0, [point]);
});

// GOOD: Batch append (single render)
chart.appendData(0, dataPoints);
```

### Optimize Streaming Batch Size

For real-time dashboards, balance update frequency with batch size:

```typescript
// Example: Collect metrics for 1 second, then batch append
const buffer: Array<[number, number]> = [];

function collectMetric(timestamp: number, value: number) {
  buffer.push([timestamp, value]);
  
  if (buffer.length >= 10) {  // Flush every 10 points
    chart.appendData(0, buffer);
    buffer.length = 0;
  }
}

setInterval(() => {
  collectMetric(Date.now(), Math.random() * 100);
}, 100);
```

**Tip:** For 60fps dashboards, aim for 16ms frame budget. Use `chart.getPerformanceMetrics()` to monitor frame times.

### Monitor Performance

```typescript
// Subscribe to performance updates
const unsubscribe = chart.onPerformanceUpdate((metrics) => {
  console.log('FPS:', metrics.fps);
  console.log('Frame time (avg):', metrics.frameTime.avg, 'ms');
  console.log('Frame drops:', metrics.frameDrops.total);
  
  if (metrics.fps < 30) {
    console.warn('Performance degradation detected');
  }
});

// Later: cleanup
unsubscribe();
```

## See Also

- [Chart API](../api/chart.md) — `ChartGPU.create()`, shared device, device loss events
- [GPU Context](../api/gpu-context.md) — `GPUContextOptions`, shared device support
- [Interaction](../api/interaction.md) — Chart sync, events, `connectCharts()`
- [Options](../api/options.md) — `ChartGPUOptions`, series config, data zoom
