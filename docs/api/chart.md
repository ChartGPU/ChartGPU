# Chart API

See [ChartGPU.ts](../../src/ChartGPU.ts) for the chart instance implementation.

## `ChartGPU.create(container: HTMLElement, options: ChartGPUOptions, context?: ChartGPUCreateContext): Promise<ChartGPUInstance>`

Creates a chart instance bound to a container element.

**Parameters:**
- `container`: HTMLElement to mount the chart canvas
- `options`: Chart configuration (series, axes, theme, etc.)
- `context` (optional): Shared WebGPU context `{ adapter, device, pipelineCache? }` (share one GPUDevice across multiple charts; optionally share a pipeline cache for shader/pipeline dedupe)
- `options.renderMode` (optional): `'auto' | 'external'` — controls render loop ownership (default: `'auto'`). See **External Render Mode** below.

**Returns:** Promise that resolves to a `ChartGPUInstance`

## Shared GPUDevice

ChartGPU supports using a **shared GPUDevice** across multiple chart instances for efficient GPU resource management.

### Use Cases

- **Multi-chart dashboards**: Share one device across 10+ chart instances to reduce GPU memory overhead
- **WebGPU integration**: Use ChartGPU alongside other WebGPU applications with a centralized device
- **Resource coordination**: Manage device limits (buffers, textures, pipelines) centrally
- **Testing and debugging**: Inject mock devices for unit tests or GPU profiling

### Usage

Pass a shared adapter+device via the third parameter (`context`):

```typescript
import { ChartGPU } from 'chartgpu';

// Create a shared GPUAdapter + GPUDevice once
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) throw new Error('No WebGPU adapter available');
const device = await adapter.requestDevice();

// Create multiple charts with the shared device
const chart1 = await ChartGPU.create(container1, chartOptions1, { adapter, device });
const chart2 = await ChartGPU.create(container2, chartOptions2, { adapter, device });
const chart3 = await ChartGPU.create(container3, chartOptions3, { adapter, device });
```

### Lifecycle and Ownership

**Charts with injected devices do NOT destroy the device on dispose:**

- **Default behavior** (no injected device): `chart.dispose()` unconfigures the canvas and destroys the internal GPUDevice
- **Injected shared device** (via `context.adapter` + `context.device`): `chart.dispose()` unconfigures the canvas but **does NOT call `device.destroy()`**

**Note:** Canvas unconfiguration (via `canvasContext.unconfigure()`) always happens on dispose, regardless of device ownership. This releases textures obtained from `getCurrentTexture()` and is required for proper WebGPU resource cleanup.

**Note:** ChartGPU currently supports injecting a fully-initialized `{ adapter, device }` pair (shared device mode). Passing only an adapter or only a device is not supported.

**Your responsibility:**
- Destroy the shared device after all charts are disposed
- Handle device loss and recreation (see Device Loss Handling below)

```typescript
// Cleanup example
await chart1.dispose();
await chart2.dispose();
await chart3.dispose();

// Now safe to destroy the shared device
device.destroy();
```

### Device Loss Handling

WebGPU devices can be lost due to GPU driver crashes, system sleep, or resource exhaustion. Charts with injected devices emit a **`'deviceLost'`** event when the underlying device is lost.

#### Device Loss Event

```typescript
chart.on('deviceLost', (info) => {
  console.error('Device lost:', info.reason, info.message);
  
  // Application must handle recovery:
  // 1. Dispose all charts using the lost device
  // 2. Create a new shared device
  // 3. Recreate all charts with the new device
});
```

**Event payload:** `{ reason: GPUDeviceLostReason, message: string }`
- `reason`: `'unknown'` | `'destroyed'` — see [WebGPU spec](https://www.w3.org/TR/webgpu/#device-lost)
- `message`: Human-readable description from the browser

**Important:**
- Device loss is **not recoverable** — the device cannot be reused
- Charts with **non-injected devices** (default behavior) do not emit this event (ChartGPU handles cleanup internally)
- Applications using shared devices **must** implement recovery logic

#### Recovery Example

```typescript
const charts = [chart1, chart2, chart3];
let shared = await createSharedContext();

async function createSharedContext(): Promise<{ adapter: GPUAdapter; device: GPUDevice }> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter available');
  const device = await adapter.requestDevice();
  return { adapter, device };
}

async function handleDeviceLoss() {
  // 1. Dispose all charts
  await Promise.all(charts.map(c => c.dispose()));
  
  // 2. Destroy the lost device (if not already destroyed)
  shared.device.destroy();
  
  // 3. Create new device
  shared = await createSharedContext();
  
  // 4. Recreate charts with new device
  charts[0] = await ChartGPU.create(container1, chartOptions1, shared);
  charts[1] = await ChartGPU.create(container2, chartOptions2, shared);
  charts[2] = await ChartGPU.create(container3, chartOptions3, shared);
  
  // Re-attach event listeners
  charts.forEach(chart => chart.on('deviceLost', handleDeviceLoss));
}

// Attach device loss handlers
charts.forEach(chart => chart.on('deviceLost', handleDeviceLoss));
```

## Pipeline cache (CGPU-PIPELINE-CACHE)

When using a **shared `GPUDevice`** for dashboards, you can also opt into a **shared pipeline cache** to avoid redundant shader compilation and render pipeline creation across charts of the same type.

### What is cached

- **`GPUShaderModule`**: deduped by WGSL source string
- **`GPURenderPipeline`**: deduped by identity-defining pipeline state (shader modules + vertex layouts + targets + depth/stencil + multisample + etc.)

### Usage

```ts
import { ChartGPU, createPipelineCache } from 'chartgpu';

const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) throw new Error('No WebGPU adapter available');
const device = await adapter.requestDevice();

// Create a cache bound to this device.
const pipelineCache = createPipelineCache(device);

const chartA = await ChartGPU.create(containerA, optionsA, { adapter, device, pipelineCache });
const chartB = await ChartGPU.create(containerB, optionsB, { adapter, device, pipelineCache });

// Optional: inspect cache effectiveness
console.log(pipelineCache.getStats());
```

### Important constraints

- **Device binding**: the cache is scoped to a single `GPUDevice`. Passing a cache created for a different device throws.
- **Opt-in**: if you omit `pipelineCache`, ChartGPU behaves exactly as before.
- **Device loss**: the cache clears itself when `device.lost` resolves (stats reset). On recovery, create a new device and a new cache.
- **Scope**: the cache currently dedupes **shader modules + render pipelines**. Compute pipelines (e.g. scatter-density binning/reduction) are not yet cached.

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
  
  **Event notification:** After processing completes, `appendData()` emits a `'dataAppend'` event with metadata about the appended data (`seriesIndex`, `count`, and `xExtent`). See [Event handling](interaction.md#event-handling) for details.
  
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
- `getRenderMode(): RenderMode`: returns the current render mode (`'auto'` or `'external'`). See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `setRenderMode(mode: RenderMode): void`: changes the render mode at runtime. Switching from `'auto'` to `'external'` cancels any pending `requestAnimationFrame`; switching from `'external'` to `'auto'` schedules a render if the chart is dirty. See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `needsRender(): boolean`: checks if the chart has pending changes that require rendering. Returns `true` if dirty, `false` otherwise. See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `renderFrame(): boolean`: renders a single frame in external mode. Returns `true` if a frame was rendered, `false` if no render occurred (chart was clean, in auto mode, disposed, or reentrancy prevented). In `'auto'` mode, logs a warning and returns `false`. See [`ChartGPU.ts`](../../src/ChartGPU.ts).

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

## External Render Mode

ChartGPU supports **external render mode**, allowing applications to control the render loop instead of relying on ChartGPU's internal `requestAnimationFrame` scheduling.

### Use Cases

- **Custom render loops**: Integrate ChartGPU with game engines or animation frameworks
- **Multi-chart synchronization**: Render multiple charts in a single coordinated frame
- **Performance optimization**: Control when and how often charts render
- **Testing**: Deterministic frame-by-frame rendering for automated tests

### Configuration

Set `renderMode` in `ChartGPUOptions`:

```typescript
const chart = await ChartGPU.create(container, {
  renderMode: 'external', // 'auto' (default) | 'external'
  series: [/* ... */],
});
```

- `RenderMode` is also exported as a named type:
  - `type RenderMode = 'auto' | 'external'`
- `'auto'` (default): ChartGPU schedules renders automatically using `requestAnimationFrame`
- `'external'`: Application is responsible for calling `renderFrame()` on each frame

### Behavior Guarantees

**Dirty state accumulation:**
- Calls to `setOption(...)`, `appendData(...)`, `resize()`, and interaction updates mark the chart as dirty
- Dirty state accumulates until a render occurs (in either mode)
- Use `needsRender()` to check for pending changes

**Mode transitions:**
- **Auto → External**: Cancels any pending `requestAnimationFrame` callback
- **External → Auto**: Schedules a render immediately if the chart is dirty

**Calling `renderFrame()` in auto mode:**
- No-op that logs a warning and returns `false`
- Helps catch misconfiguration during development

**Animation timing:**
- Animations use elapsed time from `performance.now()`
- They work in external mode, provided `renderFrame()` is called regularly
- If you stop calling `renderFrame()` (e.g. off-screen panel), the next call fast-forwards animation progress based on wall-clock time

**Frame-drop detection:**
- Automatically disabled in external mode to avoid misleading metrics from irregular render cadence
- `getPerformanceMetrics()` continues to report frame timing and FPS based on actual render intervals

### Basic Usage Example

```typescript
import { ChartGPU } from 'chartgpu';

// Create chart in external mode
const chart = await ChartGPU.create(container, {
  renderMode: 'external',
  series: [{ type: 'line', data: [[0, 10], [1, 20], [2, 15]] }],
});

// Application-controlled render loop
function renderLoop() {
  if (chart.needsRender()) {
    chart.renderFrame();
  }
  requestAnimationFrame(renderLoop);
}

renderLoop();
```

For comprehensive examples including dynamic mode switching, see [`examples/external-render-mode/`](../../examples/external-render-mode/).

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
