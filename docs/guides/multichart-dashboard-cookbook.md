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

Share a single `GPUDevice` across all charts to reduce GPU memory overhead and avoid repeated initialization. You must destroy the shared device after disposing all charts.

```typescript
import { ChartGPU } from 'chartgpu';

// Create shared device
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) throw new Error('No WebGPU adapter available');
const device = await adapter.requestDevice();

// Pass shared context as third parameter
const chart1 = await ChartGPU.create(container1, options1, { adapter, device });
const chart2 = await ChartGPU.create(container2, options2, { adapter, device });
```

## Pipeline Cache

Share a pipeline cache to avoid redundant GPU shader compilation when multiple charts use the same series types. Cache hit rate typically exceeds 90% after the first chart initialization.

```typescript
import { ChartGPU, createPipelineCache } from 'chartgpu';

const pipelineCache = createPipelineCache(device);
const sharedContext = { adapter, device, pipelineCache };

const chart1 = await ChartGPU.create(container1, options1, sharedContext);
const chart2 = await ChartGPU.create(container2, options2, sharedContext);
```

## Chart Sync

Synchronize crosshair, tooltip, and zoom/pan interactions using `connectCharts()`. The function returns a `disconnect` function for cleanup.

```typescript
import { connectCharts } from 'chartgpu';

// connectCharts returns a disconnect function
const disconnect = connectCharts([chart1, chart2, chart3], {
  syncCrosshair: true,  // default
  syncZoom: true        // requires dataZoom on all charts
});

// Later: disconnect sync
disconnect();
```

Zoom sync ignores `'auto-scroll'` zoom changes by design to prevent streaming charts from shifting other charts' views.

## Streaming Data

Each chart streams data independently using `appendData()`. Always batch multiple points into a single call for optimal performance.

```typescript
// Batch append (single render)
const batch = dataPoints.map(p => [p.timestamp, p.value]);
chart.appendData(0, batch);

// Or use typed arrays for zero-copy transfer
const interleaved = new Float32Array(count * 2);
for (let i = 0; i < count; i++) {
  interleaved[i * 2] = timestamp;
  interleaved[i * 2 + 1] = value;
}
chart.appendData(0, interleaved);
```

## Resize Handling

Use `ResizeObserver` to detect container size changes and call `chart.resize()` in `requestAnimationFrame` to debounce resize events.

```typescript
const charts = [chart1, chart2, chart3];
const containers = [container1, container2, container3];

const observers = containers.map((container, i) => {
  let rafId: number | null = null;
  
  const observer = new ResizeObserver(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      charts[i].resize();
      rafId = null;
    });
  });
  
  observer.observe(container);
  return observer;
});
```

## Cleanup & Disposal

Proper cleanup prevents memory leaks and resource exhaustion. Follow this critical order:

```typescript
function cleanupDashboard(
  disconnect: () => void,
  observers: ResizeObserver[],
  charts: ChartGPUInstance[],
  device: GPUDevice
) {
  // 1. Disconnect sync groups (remove event listeners)
  disconnect();
  
  // 2. Disconnect ResizeObservers
  observers.forEach(obs => obs.disconnect());
  
  // 3. Dispose each chart (unconfigure canvases, release GPU resources)
  charts.forEach(chart => chart.dispose());
  
  // 4. Destroy shared device (after all charts disposed)
  device.destroy();
}
```

## Streaming Dashboard Example

A production example demonstrating a 5-chart APM dashboard with shared device, chart sync, real-time streaming at 5 Hz, and programmatic annotations triggered by statistical anomaly detection. The data generator produces a causal incident narrative: memory leak → GC pressure → CPU spikes → latency increase → connection pool saturation → throughput drop → error cascade over ~180 seconds.

**Location:** `examples/streaming-dashboard/`

**Files:**
- **`main.ts`** — Orchestrator: shared device/cache, chart creation, sync, streaming loop, cleanup
- **`annotations.ts`** — 6 annotation triggers mapping detectors to chart annotations
- **`dataGenerator.ts`** — Correlated metrics generation simulating a memory leak incident
- **`detectors.ts`** — Statistical detectors: z-score, hysteresis, rate-of-change, rolling stats

See the [full source code](../../examples/streaming-dashboard/) for the complete implementation pattern.

## See Also

- [Chart API](../api/chart.md) — `ChartGPU.create()`, shared device, device loss events
- [GPU Context](../api/gpu-context.md) — `GPUContextOptions`, shared device support
- [Interaction](../api/interaction.md) — Chart sync, events, `connectCharts()`
- [Options](../api/options.md) — `ChartGPUOptions`, series config, data zoom
- [Annotations API](../api/annotations.md) — Programmatic annotations, authoring tools
- [Streaming Dashboard Example](../../examples/streaming-dashboard/) — Full source code
