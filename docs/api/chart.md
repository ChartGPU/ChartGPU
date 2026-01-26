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

- `setOption(options: ChartGPUOptions): void`: replaces the current user options, resolves them against defaults via [`resolveOptions`](../../src/config/OptionResolver.ts), updates internal render state, and schedules a single on-demand render on the next `requestAnimationFrame` tick (coalesces multiple calls).
- `appendData(seriesIndex: number, newPoints: DataPoint[] | OHLCDataPoint[]): void`: appends new points to a **cartesian** series at runtime (streaming), updates internal runtime bounds, and schedules a render (coalesces). For candlestick series, pass `OHLCDataPoint[]`. For other cartesian series (line/area/bar/scatter), pass `DataPoint[]`. Internally, streaming appends are flushed via a unified scheduler (rAF-first with a small timeout fallback) and only do resampling work when zoom is active or a zoom change debounce matures. When `ChartGPUOptions.autoScroll === true`, this may also adjust the x-axis percent zoom window (see **Auto-scroll (streaming)** below). Pie series are not supported by streaming append. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts). For an end-to-end example, see [`examples/live-streaming/`](../../examples/live-streaming/) and [`examples/candlestick-streaming/`](../../examples/candlestick-streaming/).
- `resize(): void`: recomputes the canvas backing size / WebGPU canvas configuration from the container size; if anything changes, schedules a render.
- `dispose(): void`: cancels any pending frame, disposes internal render resources, destroys the WebGPU context, and removes the canvas.
- `on(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void`: registers an event listener. See [Event handling](interaction.md#event-handling) below.
- `off(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void`: unregisters an event listener. See [Event handling](interaction.md#event-handling) below.
- `getInteractionX(): number | null`: returns the current "interaction x" in domain units (or `null` when inactive). See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `setInteractionX(x: number | null, source?: unknown): void`: drives the chart's crosshair/tooltip interaction from a domain x value; pass `null` to clear. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and the internal implementation in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- `setCrosshairX(x: number | null, source?: unknown): void`: alias for `setInteractionX(...)` with chart-sync semantics (external crosshair/tooltip control); `x` is in domain units and `null` clears. See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `onInteractionXChange(callback: (x: number | null, source?: unknown) => void): () => void`: subscribes to interaction x updates and returns an unsubscribe function. See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `getZoomRange(): { start: number; end: number } | null`: returns the current percent-space zoom window in \([0, 100]\), or `null` when data zoom is disabled. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and percent-space semantics in [`createZoomState.ts`](../../src/interaction/createZoomState.ts).
- `setZoomRange(start: number, end: number): void`: sets the percent-space zoom window (ordered/clamped to \([0, 100]\)); no-op when data zoom is disabled. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and percent-space semantics in [`createZoomState.ts`](../../src/interaction/createZoomState.ts).

Data upload and scale/bounds derivation occur during [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) `RenderCoordinator.render()` (not during `setOption(...)` itself).

## Legend (automatic)

ChartGPU currently mounts a small legend panel as an internal HTML overlay alongside the canvas. The legend is created and managed by the render pipeline in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) (default position: `'right'`), updates when `setOption(...)` is called, and is disposed with the chart.

- **Non-pie series**: one legend row per series (swatch + label). Labels come from `series[i].name` (trimmed), falling back to `Series N`. Swatch colors come from `series[i].color` when provided, otherwise the resolved theme palette.
- **Pie series**: one legend row per slice (swatch + label). Labels come from `series[i].data[j].name` (trimmed), falling back to `Slice N`. Swatch colors come from `series[i].data[j].color` when provided, otherwise a palette fallback.

See the internal legend implementation in [`createLegend.ts`](../../src/components/createLegend.ts).

## Chart sync (interaction)

ChartGPU supports a small "connect API" for syncing interaction between multiple charts (crosshair x-position + tooltip x-value). This is driven by the chart instance's interaction-x APIs (`getInteractionX()` + `setCrosshairX(...)`) and the `'crosshairMove'` event.

`connectCharts` is exported from the public entrypoint [`src/index.ts`](../../src/index.ts) and implemented in [`createChartSync.ts`](../../src/interaction/createChartSync.ts).

For a concrete usage example with two stacked charts, see [`examples/interactive/main.ts`](../../examples/interactive/main.ts).

### `connectCharts(charts: ChartGPUInstance[]): () => void`

Connects charts so interaction-x updates in one chart drive `setCrosshairX(...)` on the other charts. Returns a `disconnect()` function that removes listeners and clears any synced interaction state.
