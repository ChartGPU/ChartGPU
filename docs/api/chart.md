# Chart API

See [ChartGPU.ts](../../src/ChartGPU.ts) for the chart instance implementation.

## `ChartGPU.create(container: HTMLElement, options: ChartGPUOptions): Promise<ChartGPUInstance>`

Creates a chart instance bound to a container element.

## `ChartGPUInstance`

Returned by `ChartGPU.create(...)`.

See [ChartGPU.ts](../../src/ChartGPU.ts) for the full interface and lifecycle behavior.

**Properties (essential):**

- `options: Readonly<ChartGPUOptions>`: the last user-provided options object (unresolved).
- `disposed: boolean`

**Methods (essential):**

- `appendData(seriesIndex: number, newPoints: DataPoint[] | XYArraysData | InterleavedXYData | OHLCDataPoint[]): void`: appends new points to a **cartesian** series at runtime (streaming), updates internal runtime bounds, and schedules a render (coalesces).
  
  **Accepted data formats:**
  - **`DataPoint[]`**: traditional array of objects/tuples `[x, y, size?]` or `{ x, y, size? }`
  - **`XYArraysData`**: separate arrays `{ x: ArrayLike<number>, y: ArrayLike<number>, size?: ArrayLike<number> }` (see [`types.ts`](../../src/config/types.ts))
  - **`InterleavedXYData`**: pre-interleaved typed array (`ArrayBufferView`) in `[x0, y0, x1, y1, ...]` order (see [`types.ts`](../../src/config/types.ts))
  - **`OHLCDataPoint[]`**: for candlestick series only
  
  **Point-count rules:** 
  - **`XYArraysData`**: uses `min(x.length, y.length)` — extra elements in either array are ignored
  - **`InterleavedXYData`**: uses `floor(byteLength / (bytesPerElement * 2))` — odd trailing element is ignored
  - **`DataView` interleaved is unsupported** and throws an error at runtime
  
  **Scatter size behavior:**
  - **`XYArraysData.size`** participates in hit-testing, tooltips, and scatter point sizing
  - **Interleaved typed arrays** do not carry per-point size; use `XYArraysData` if size is needed
  
  Internally, streaming appends are flushed via a unified scheduler (rAF-first with a small timeout fallback) and only do resampling work when zoom is active or a zoom change debounce matures. When `ChartGPUOptions.autoScroll === true`, this may also adjust the x-axis percent zoom window (see **Auto-scroll (streaming)** below). Pie series are not supported by streaming append. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
  
  **Streaming append examples:**
  
  ```typescript
  // Append with Float32Array interleaved (GPU-friendly, zero-copy)
  const interleaved = new Float32Array([101, 45.2, 102, 46.1, 103, 44.8]);
  chart.appendData(0, interleaved);
  
  // Append with separate arrays (supports mixed precision, includes size)
  const xyArrays = {
    x: new Float64Array([104, 105, 106]),
    y: new Float32Array([45.5, 46.0, 45.8]),
    size: new Float32Array([8, 10, 12])  // optional scatter size
  };
  chart.appendData(0, xyArrays);
  ```
  
  For end-to-end examples, see [`examples/live-streaming/`](../../examples/live-streaming/) and [`examples/candlestick-streaming/`](../../examples/candlestick-streaming/).
- `resize(): void`: recomputes the canvas backing size / WebGPU canvas configuration from the container size; if anything changes, schedules a render.
- `dispose(): void`: cancels any pending frame, disposes internal render resources, destroys the WebGPU context, and removes the canvas.
- `on(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void`: registers an event listener. See [Event handling](interaction.md#event-handling) below.
- `off(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void`: unregisters an event listener. See [Event handling](interaction.md#event-handling) below.
- `getInteractionX(): number | null`: returns the current "interaction x" in domain units (or `null` when inactive). See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `setInteractionX(x: number | null, source?: unknown): void`: drives the chart's crosshair/tooltip interaction from a domain x value; pass `null` to clear. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and the internal implementation in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- `setCrosshairX(x: number | null, source?: unknown): void`: alias for `setInteractionX(...)` with chart-sync semantics (external crosshair/tooltip control); `x` is in domain units and `null` clears. See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `onInteractionXChange(callback: (x: number | null, source?: unknown) => void): () => void`: subscribes to interaction x updates and returns an unsubscribe function. See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `getZoomRange(): { start: number; end: number } | null`: returns the current percent-space zoom window in \([0, 100]\), or `null` when data zoom is disabled. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and percent-space semantics in [`createZoomState.ts`](../../src/interaction/createZoomState.ts).
- `setZoomRange(start: number, end: number, source?: unknown): void`: sets the percent-space zoom window (ordered/clamped to \([0, 100]\)); no-op when data zoom is disabled. `source` is an optional token forwarded to `'zoomRangeChange'` listeners (useful for sync loop prevention). Emits a `'zoomRangeChange'` event with `sourceKind: 'api'` when the range actually changes. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and percent-space semantics in [`createZoomState.ts`](../../src/interaction/createZoomState.ts).
- `getPerformanceMetrics(): Readonly<PerformanceMetrics> | null`: returns a snapshot of current performance metrics including FPS, frame time statistics, memory usage, and frame drops; returns `null` if metrics are not available. See [`PerformanceMetrics`](options.md#performancemetrics) for type details.
- `getPerformanceCapabilities(): Readonly<PerformanceCapabilities> | null`: returns which performance features are supported (e.g., GPU timing, high-resolution timers); returns `null` if capabilities information is not available. Useful for determining what metrics are available before subscribing to updates. See [`PerformanceCapabilities`](options.md#performancecapabilities) for type details.
- `onPerformanceUpdate(callback: (metrics: Readonly<PerformanceMetrics>) => void): () => void`: subscribes to real-time performance updates that fire on every render frame; returns an unsubscribe function to clean up the subscription.
- `hitTest(e: PointerEvent | MouseEvent): ChartGPUHitTestResult`: performs a synchronous hit-test for a pointer/mouse event and returns coordinates + an optional match. Accepts `MouseEvent` for right-click/context menu handlers (DOM `contextmenu`).
  - `canvasX` / `canvasY`: canvas-local coordinates in **CSS pixels**.
  - `gridX` / `gridY`: plot-area-local coordinates in **CSS pixels**, relative to the plot origin \((grid.left, grid.top)\).
  - `isInGrid`: `true` when the pointer is inside the plot area.
  - `match`: `null` when no chart element is hit; otherwise `{ kind, seriesIndex, dataIndex, value }`.
    - `kind: 'cartesian'`: `value` is `[x, y]` (domain units).
    - `kind: 'candlestick'`: `value` is `[timestamp, close]` (domain units).
    - `kind: 'pie'`: `value` is `[0, sliceValue]` (pie is non-cartesian; the x-slot is `0`).

Data upload and scale/bounds derivation occur during [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) `RenderCoordinator.render()` (not during `setOption(...)` itself).

## Performance Monitoring

ChartGPU provides a comprehensive performance metrics system for monitoring rendering performance in real-time.

### Performance Metrics API

Three methods enable performance monitoring:

**`getPerformanceMetrics(): Readonly<PerformanceMetrics> | null`**

Returns a snapshot of current performance metrics. Returns `null` if metrics are not yet available (e.g., before first frame render).

**Metrics include:**
- **Exact FPS**: Calculated from actual frame time deltas using circular buffer
- **Frame time statistics**: Min, max, average, and percentiles (p50, p95, p99)
- **Memory usage**: Current, peak, and total allocated GPU buffer memory
- **Frame drops**: Total dropped frames and current consecutive drop streak
- **GPU timing**: CPU vs GPU render time (when supported)

**`getPerformanceCapabilities(): Readonly<PerformanceCapabilities> | null`**

Returns which performance features are supported in the current environment. Returns `null` if capability information is not available.

**Capabilities include:**
- **GPU timing support**: Whether GPU timestamp queries are available
- **High-resolution timer**: Whether `performance.now()` provides high-resolution timing
- **Performance metrics support**: Whether the metrics API is functional

**`onPerformanceUpdate(callback: (metrics: Readonly<PerformanceMetrics>) => void): () => void`**

Subscribes to real-time performance updates that fire on every render frame (up to 60fps). Returns an unsubscribe function.

**Behavior:**
- Callback fires synchronously after each frame render completes
- Unsubscribe by calling the returned function

For type definitions, see [`PerformanceMetrics`](options.md#performancemetrics) and [`PerformanceCapabilities`](options.md#performancecapabilities).

## Legend (automatic)

ChartGPU currently mounts a small legend panel as an internal HTML overlay alongside the canvas. The legend is created and managed by the render pipeline in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) (default position: `'right'`), updates when `setOption(...)` is called, and is disposed with the chart.

- **Non-pie series**: one legend row per series (swatch + label). Labels come from `series[i].name` (trimmed), falling back to `Series N`. Swatch colors come from `series[i].color` when provided, otherwise the resolved theme palette.
- **Pie series**: one legend row per slice (swatch + label). Labels come from `series[i].data[j].name` (trimmed), falling back to `Slice N`. Swatch colors come from `series[i].data[j].color` when provided, otherwise a palette fallback.

See the internal legend implementation in [`createLegend.ts`](../../src/components/createLegend.ts).

## Chart sync (interaction)

ChartGPU supports a small "connect API" for syncing interactions between multiple charts:

- **Crosshair + tooltip sync** (default): syncs interaction-x (domain units) across charts via `'crosshairMove'`.
- **Zoom + pan sync** (optional): syncs the percent-space zoom window (`getZoomRange()` / `setZoomRange()`), which in turn synchronizes zoom & pan interactions.

`connectCharts` is exported from the public entrypoint [`src/index.ts`](../../src/index.ts) and implemented in [`createChartSync.ts`](../../src/interaction/createChartSync.ts).

For a concrete usage example with two stacked charts, see [`examples/interactive/main.ts`](../../examples/interactive/main.ts).

### `connectCharts(charts: ChartGPUInstance[], options?: ChartSyncOptions): () => void`

Connects charts so interaction updates in one chart drive the others. Returns a `disconnect()` function that removes listeners. On disconnect, ChartGPU clears any synced crosshair/tooltip state (but does **not** reset zoom).

**Options:**
- `syncCrosshair?: boolean` (default `true`): sync crosshair + tooltip x-position
- `syncZoom?: boolean` (default `false`): sync zoom/pan via zoom range changes

**Important:** 
- Zoom sync only has an effect when **all connected charts have data zoom enabled** (i.e. `options.dataZoom` is configured). If data zoom is disabled on a chart, `setZoomRange(...)` is a no-op for that chart.
- Zoom sync **ignores `'auto-scroll'` zoom changes** (from streaming with `autoScroll: true`). This prevents auto-scroll adjustments in one chart from unintentionally shifting the zoom window in other charts.

Example (sync both crosshair and zoom/pan):

```ts
import { ChartGPU, connectCharts } from 'chartgpu';

const chartA = await ChartGPU.create(containerA, {
  // ...
  dataZoom: [{ type: 'inside' }, { type: 'slider' }],
});
const chartB = await ChartGPU.create(containerB, {
  // ...
  dataZoom: [{ type: 'inside' }, { type: 'slider' }],
});

const disconnect = connectCharts([chartA, chartB], {
  syncCrosshair: true,
  syncZoom: true,
});
```
