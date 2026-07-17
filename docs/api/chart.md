# Chart API

Source of truth: [`src/ChartGPU.ts`](../../src/ChartGPU.ts).

## `ChartGPU.create(container, options, context?)`

```ts
import { ChartGPU } from 'chartgpu';

const container = document.getElementById('chart')!;
const chart = await ChartGPU.create(container, {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
});
```

- **`container`**: mount target (ChartGPU owns a canvas inside it)
- **`options`**: configuration (see [options.md](options.md))
  - **Create-only options:** `antialias` and `devicePixelRatio` are applied when the chart / render coordinator is constructed (MSAA pipelines, texture manager, canvas backing store, text-overlay DPR). Changing them later with `setOption` has no effect on those resources — dispose and recreate the chart instead.
- **`context?`**: optional shared WebGPU `{ adapter, device, pipelineCache? }`

## Sharing GPU resources (optional)

### Shared `GPUDevice`

```ts
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
const device = await adapter.requestDevice();
const chart1 = await ChartGPU.create(container1, opts1, { adapter, device });
const chart2 = await ChartGPU.create(container2, opts2, { adapter, device });
```

- If you **inject** `{ adapter, device }`, charts do **not** call `device.destroy()` on `dispose()` (you own the device).
- If you **don’t inject**, ChartGPU creates and destroys its own device.
- Charts created with an injected device can emit **`'deviceLost'`**; on loss, recreate device + charts.

### Pipeline cache (`PipelineCache`)

Share a cache to dedupe shader/pipeline creation across charts on the same device.

```ts
import { createPipelineCache } from 'chartgpu';

const pipelineCache = createPipelineCache(device);
await ChartGPU.create(a, optsA, { adapter, device, pipelineCache });
await ChartGPU.create(b, optsB, { adapter, device, pipelineCache });
```

- Cache is scoped to a single `GPUDevice` (mixing devices throws).

## `ChartGPUInstance`

Returned by `ChartGPU.create(...)`.

See [ChartGPU.ts](../../src/ChartGPU.ts) for the full interface and lifecycle behavior.

**Properties (essential):**

- `options: Readonly<ChartGPUOptions>`: the last user-provided options object (unresolved).
- `disposed: boolean`

**Common methods:**

- `setOption(...)`: update options and schedule a render.
  - **Series identity:** Prefer immutable series configs. When the same series **element objects** are re-passed (axes-only y/x range ticks), ChartGPU may reuse the previous resolved series array without re-scanning each series. To change data, color, visibility, or style, pass **new series element objects** (or a new `series` array). See [options.md — series array identity reuse](options.md#series-configuration).
- `appendData(seriesIndex, newPoints, options?)`: streaming append for cartesian series.
  - Formats: `DataPoint[]`, `XYArraysData`, `InterleavedXYData`, `OHLCDataPoint[]`
  - Optional `{ maxPoints }` (**per call**, not sticky series state — omit later for unbounded growth):
    - If a single batch is ≥ `maxPoints`, keep only that batch’s tail (strict replace; prior points discarded).
    - Otherwise **fixed-capacity ring**: fill up to `maxPoints`, then overwrite oldest slots (GPU modular writes — O(append), no full retained-window rewrite). Peak retained length / GPU reservation = **`maxPoints`**.
    - Prefer over sliding-window full `setOption` for high-rate streaming (fixed-capacity ring; not sticky series construction state).
    - When both `maxPoints` is set and `tooltip.show === false`, ChartGPU’s hit-test columnar store is not updated on append (dual-store relief); coordinator/GPU still apply the ring.
  - **Device storage cap (unbounded append):** series buffers are storage-bound. When growth would exceed `min(maxBufferSize, maxStorageBufferBindingSize)` (often **128 MiB ≈ 16.7M** xy points on Chrome/Metal), ChartGPU **auto-windows** to that point budget (same ring policy as `maxPoints`) so the x-domain stays in sync with GPU-resident data. The hit-test store (when tooltips are on) applies the **same** effective window — GPU and interaction history retain one chronological window. Without this, the axis could keep expanding while the series stopped short of the right edge. Pass an explicit `{ maxPoints }` when you want a smaller sliding window (still hard-clamped by the device budget).
  - Types: [`src/config/types.ts`](../../src/config/types.ts)
- `resize()`, `dispose()`
- `on(...)`, `off(...)`: events (see [interaction.md](interaction.md))
- `hitTest(e)`: pointer hit-test (coordinates + optional match)
- `setInteractionX(...)` / `setCrosshairX(...)`
- `getZoomRange()` / `setZoomRange(...)`
- `getPerformanceMetrics()` / `getPerformanceCapabilities()` / `onPerformanceUpdate(...)`
- `getRenderMode()` / `setRenderMode(...)` / `needsRender()` / `renderFrame()`

Data upload and scale/bounds derivation occur during [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) `RenderCoordinator.render()` (not during `setOption(...)` itself).

## External Render Mode

Set `renderMode: 'external'` to run ChartGPU inside your own render loop.

```ts
const chart = await ChartGPU.create(container, { renderMode: 'external', series: [...] });
function loop() {
  if (chart.needsRender()) chart.renderFrame();
  requestAnimationFrame(loop);
}
loop();
```

### GPU submit timing

`renderFrame()` **encodes** the frame but **defers** `device.queue.submit` to a
`queueMicrotask`. Multi-chart dashboards that share one `GPUDevice` and call
`renderFrame()` on every surface in the same JS turn therefore collapse into a
single batched submit (shared-device multi-chart present).

If you need GPU work on the queue before `onSubmittedWorkDone()` (or any
immediate post-submit fence), drain the microtask first:

```ts
chart.renderFrame();
await Promise.resolve(); // flush batched submit
await device.queue.onSubmittedWorkDone();
```

`dispose()` flushes any pending batched submit for that chart’s device before
destroying textures/buffers.

Example: [`examples/external-render-mode/`](../../examples/external-render-mode/).

## Chart sync (`connectCharts`)

Sync crosshair/tooltip between charts (default) and optionally sync zoom.

- Zoom sync only has effect when all connected charts have data zoom enabled.

```ts
import { connectCharts } from 'chartgpu';
const disconnect = connectCharts([chartA, chartB], { syncZoom: true });
```
