# Internal modules (Contributor notes)

Chart data uploads and per-series GPU vertex buffer caching are handled by the internal `createDataStore(device)` helper. See [`createDataStore.ts`](../../src/data/createDataStore.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`). **Buffers grow geometrically** to reduce reallocations when data grows incrementally.

## GPU buffer streaming (internal / contributor notes)

For frequently-updated dynamic geometry (e.g. interaction overlays), ChartGPU includes an internal streaming buffer helper that uses **double-buffering** (alternates two `GPUBuffer`s) to avoid writing into a buffer the GPU may still be reading, and uses `device.queue.writeBuffer(...)` with **partial range updates when possible**.

See [`createStreamBuffer.ts`](../../src/data/createStreamBuffer.ts) for the helper API (`createStreamBuffer(device, maxSizeBytes)` returning `{ write, getBuffer, getVertexCount, dispose }`) and current usage in [`createCrosshairRenderer.ts`](../../src/renderers/createCrosshairRenderer.ts).

## CPU downsampling (internal / contributor notes)

ChartGPU includes a small CPU-side Largest Triangle Three Buckets (LTTB) downsampler intended for internal tooling/acceptance checks and offline preprocessing. See [`lttbSample.ts`](../../src/data/lttbSample.ts). This helper is currently **internal-only** (not exported from the public entrypoint `src/index.ts`).

- **Function**: `lttbSample(data, targetPoints)`
- **Overloads (high-level)**:
  - `lttbSample(data: ReadonlyArray<DataPoint>, targetPoints: number): ReadonlyArray<DataPoint>`
  - `lttbSample(data: Float32Array, targetPoints: number): Float32Array` where the input is interleaved `[x, y]` pairs (`[x0, y0, x1, y1, ...]`)

## Interaction utilities (internal / contributor notes)

Interaction helpers live in [`src/interaction/`](../../src/interaction/). These modules are currently internal (not exported from the public entrypoint `src/index.ts`).

### Event manager (internal)

See [`createEventManager.ts`](../../src/interaction/createEventManager.ts).

- **Factory**: `createEventManager(canvas: HTMLCanvasElement, initialGridArea: GridArea): EventManager`
- **Purpose**: normalizes pointer input into chart-friendly coordinates and emits `'mousemove' | 'click' | 'mouseleave'` events.
- **Canvas access**: `EventManager.canvas` exposes the canvas element the manager was created for (used by internal interaction handlers; see [`createInsideZoom.ts`](../../src/interaction/createInsideZoom.ts)).
- **Coordinate contract (critical)**:
  - `payload.x` / `payload.y` are **canvas-local CSS pixels** (relative to the canvas top-left in CSS px via `getBoundingClientRect()`).
  - `payload.gridX` / `payload.gridY` are **plot-area-local CSS pixels** (canvas-local CSS px minus `GridArea` CSS-pixel margins).
  - `payload.plotWidthCss` / `payload.plotHeightCss` are the plot (grid) dimensions in **CSS pixels** (derived from `getBoundingClientRect()` minus `gridArea` margins).
  - `payload.isInGrid` is computed in **CSS pixels** against the current plot rect.
- **Layout updates**: `EventManager.updateGridArea(gridArea)` must be called when grid/layout changes (ChartGPU's internal render coordinator updates it each render).
- **Current usage**: used internally by the render coordinator to drive the crosshair overlay and to request renders in render-on-demand systems. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

### Hover state manager (internal)

See [`createHoverState.ts`](../../src/interaction/createHoverState.ts).

- **Factory**: `createHoverState(): HoverState`
- **Purpose**: tracks the currently hovered `{ seriesIndex, dataIndex }` pair and notifies listeners when it changes.
- **Debounce**: updates are coalesced with an internal debounce of ~16ms to avoid spamming downstream work during rapid pointer movement.
- **Change-only notifications**: listeners fire only when the hovered target actually changes (including `null`).
- **Listener management**: `onChange(callback)` returns an unsubscribe function; emissions iterate a snapshot of listeners so subscription changes during emit don't affect the current flush.
- **Lifecycle**: `HoverState` includes an optional `destroy?: () => void`; `createHoverState()` currently returns a `destroy()` implementation that cancels any pending debounce timer and clears all listeners/state.

### Zoom state manager (internal)

See [`createZoomState.ts`](../../src/interaction/createZoomState.ts).

- **Factory**: `createZoomState(initialStart: number, initialEnd: number): ZoomState`
- **Purpose**: tracks a zoom window in percent space as `{ start, end }` in \([0, 100]\) and notifies listeners when it changes.
- **Clamping**: `start` / `end` are clamped to \([0, 100]\) and ordered (`start <= end`).
- **Span constraints**: `minSpan` / `maxSpan` are enforced (currently internal defaults); when a span clamp is required during zooming, the zoom anchor is preserved as much as possible.
- **Pan**: `pan(delta)` shifts the window by percent points while preserving span (clamped to bounds).
- **Listener management**: `onChange(callback)` returns an unsubscribe function; emissions iterate a snapshot of listeners so subscription changes during emit don't affect the current emission.

### Inside zoom handler (internal / Story 5.3)

See [`createInsideZoom.ts`](../../src/interaction/createInsideZoom.ts) and the enablement/wiring in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

- **Purpose**: implements "inside" x-zoom and x-pan behavior (wheel zoom centered on cursor-x; drag pan) for cartesian charts.
- **Enablement**: enabled when resolved options include `dataZoom` with an entry where `type === 'inside'` (option normalization/preservation happens in [`OptionResolver.ts`](../../src/config/OptionResolver.ts)).
- **Scope**: plot grid only and x-axis only (it updates the percent zoom window and the coordinator applies that window to the x-domain for both rendering scales and interaction scales).

### Nearest point detection (internal)

See [`findNearestPoint.ts`](../../src/interaction/findNearestPoint.ts).

- **Function**: `findNearestPoint(series: ReadonlyArray<ResolvedSeriesConfig>, x: number, y: number, xScale: LinearScale, yScale: LinearScale, maxDistance?: number): NearestPointMatch | null`
- **Returns**: `null` or `{ seriesIndex, dataIndex, point, distance }`
- **Pie note (Story 4.14)**: pie series are **ignored** by this helper. Pie slices use a separate hit-test helper; see [`findPieSlice.ts`](../../src/interaction/findPieSlice.ts).
- **Sorted-x requirement**: each series must be sorted by increasing `x` in domain space for the binary search path to be correct.
- **Scatter hit-testing (Story 4.10)**:
  - Scatter series use distance-based hit-testing but **expand the effective hit radius** based on symbol size so larger markers are easier to hover.
  - Size uses the same precedence as the scatter renderer (per-point `size` → `series.symbolSize` → default), and is interpreted as a **radius in CSS pixels** when your `xScale`/`yScale` range-space is in CSS pixels.
- **Bar hit-testing (Story 4.6)**:
  - Bar series use **bounding-box (rect) hit detection** in `xScale`/`yScale` range-space (not point distance).
  - A bar is only considered a match when the cursor is **inside** its rect bounds (`isPointInBar(...)` in [`findNearestPoint.ts`](../../src/interaction/findNearestPoint.ts)).
  - **Stacked bars**: when multiple segments exist at the same x-category, the match is the **topmost segment under the cursor** (with deterministic tie-breaking on shared edges).
- **Coordinate system contract (critical)**:
  - `x` / `y` must be in the same units as `xScale` / `yScale` **range-space**.
  - If you pass **grid-local CSS pixels** (e.g. `gridX` / `gridY` from [`createEventManager.ts`](../../src/interaction/createEventManager.ts)), then `xScale.range(...)` / `yScale.range(...)` must also be in **CSS pixels**.
  - If you pass **clip-space coordinates**, then the scales must also output clip space (and `maxDistance` is interpreted in clip-space units).
- **Performance**: per-series lower-bound binary search on x with outward expansion based on x-distance pruning; uses squared distances internally and computes `sqrt` only for the final match.

### Points-at-x lookup (internal)

See [`findPointsAtX.ts`](../../src/interaction/findPointsAtX.ts).

- **Function**: `findPointsAtX(series: ReadonlyArray<ResolvedSeriesConfig>, xValue: number, xScale: LinearScale, tolerance?: number): ReadonlyArray<PointsAtXMatch>`
- **Return type**: `ReadonlyArray<PointsAtXMatch>` where `PointsAtXMatch = { seriesIndex, dataIndex, point }`
- **Pie note (Story 4.14)**: pie series are **ignored** by this helper (pie is non-cartesian and not queryable by x). For pie hover hit-testing, see [`findPieSlice.ts`](../../src/interaction/findPieSlice.ts).
- **Bar lookup (Story 4.6)**:
  - Bar series treat each bar as an x-interval in range-space and can return a match when `xValue` falls inside the bar interval (see [`findPointsAtX.ts`](../../src/interaction/findPointsAtX.ts)).
  - When `tolerance` is finite, the effective interval is expanded by `tolerance` (range-space units) on both sides.
- **Coordinate system contract (critical)**:
  - `xValue` and `tolerance` MUST be in the same units as `xScale` **range-space**.
  - Note: ChartGPU's internal render scales are currently in clip space (NDC, typically \[-1, 1\]); in that case, convert pointer x into clip space before calling this helper.
- **Tolerance behavior**: when `tolerance` is finite, matches with \(|xScale.scale(point.x) - xValue|\) beyond tolerance are omitted; when `tolerance` is omitted or non-finite, returns the nearest point per series when possible.
- **Sorted-x requirement**: each series must be sorted by increasing `x` in domain space for the binary search path to be correct.
- **NaN-x fallback**: if a series contains any `NaN` x values, this helper falls back to an O(n) scan for correctness (NaN breaks total ordering for binary search).

### Pie slice hit-testing (internal)

See [`findPieSlice.ts`](../../src/interaction/findPieSlice.ts).

- **Function**: `findPieSlice(x: number, y: number, pieConfig: PieHitTestConfig, center: PieCenterCssPx, radius: PieRadiusCssPx): PieSliceMatch | null`
- **Purpose**: finds the pie slice under a pointer position and returns `{ seriesIndex, dataIndex, slice }` when hit.
- **Coordinate contract (critical)**: `x`/`y` are plot/grid-local CSS pixels (as produced by `payload.gridX`/`payload.gridY` from [`createEventManager.ts`](../../src/interaction/createEventManager.ts)), `center` is plot-local CSS pixels, and `radius` is in CSS pixels.
- **Non-cartesian note**: pie slices are detected using polar angle + radius checks; they do not use `xScale`/`yScale` and do not affect cartesian bounds.

## Text overlay (internal / contributor notes)

An internal DOM helper for rendering text labels above the canvas using an absolutely-positioned HTML overlay. See [`createTextOverlay.ts`](../../src/components/createTextOverlay.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createTextOverlay(container: HTMLElement): TextOverlay`
- **`TextOverlay` methods (essential)**:
  - `clear(): void`
  - `addLabel(text: string, x: number, y: number, options?: TextOverlayLabelOptions): HTMLSpanElement`
  - `dispose(): void`
- **Coordinates**: `x` / `y` are in CSS pixels relative to the container's top-left corner.
- **Pointer events**: the overlay uses `pointer-events: none` so it won't intercept mouse/touch input.
- **Current usage**: used by the render coordinator to render numeric cartesian axis tick value labels above the canvas (pie-only charts skip these labels). See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

## Legend (internal / contributor notes)

An internal DOM helper for rendering a legend above the canvas using an absolutely-positioned HTML overlay. See [`createLegend.ts`](../../src/components/createLegend.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createLegend(container: HTMLElement, position?: 'top' | 'bottom' | 'left' | 'right')`
- **`Legend` methods (essential)**:
  - `update(series: ReadonlyArray<SeriesConfig>, theme: ThemeConfig): void`
  - `dispose(): void`
- **Legend rows (Story 4.15)**:
  - Non-pie: one row per series (`series[i].name`, `series[i].color` / palette fallback)
  - Pie: one row per slice (`series[i].data[j].name`, `series[i].data[j].color` / palette fallback)
- **Current usage**: created and updated by the render coordinator (default position `'right'`), using the resolved series list (`resolvedOptions.series`). See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

## Tooltip overlay (internal / contributor notes)

An internal DOM helper for rendering an HTML tooltip above the canvas. See [`createTooltip.ts`](../../src/components/createTooltip.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createTooltip(container: HTMLElement): Tooltip`
- **`Tooltip` methods (essential)**:
  - `show(x: number, y: number, content: string): void`
  - `hide(): void`
  - `dispose(): void`
- **Coordinates**: `x` / `y` are in CSS pixels relative to the container's top-left corner (container-local CSS px).
- **Positioning behavior**: positions the tooltip near the cursor with flip/clamp logic so it stays within the container bounds.
- **Content**: `content` is treated as HTML and assigned via `innerHTML`. Only pass trusted/sanitized strings.
- **Pointer events**: the tooltip uses `pointer-events: none` so it won't intercept mouse/touch input.

For default `innerHTML`-safe tooltip content formatting helpers (item + axis trigger modes), see [`formatTooltip.ts`](../../src/components/formatTooltip.ts).

## Data zoom slider (internal / contributor notes)

A standalone internal DOM helper for rendering a slider-style x-zoom UI. See [`createDataZoomSlider.ts`](../../src/components/createDataZoomSlider.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`); ChartGPU uses it internally when `ChartGPUOptions.dataZoom` includes `{ type: 'slider' }` (see [`ChartGPU.ts`](../../src/ChartGPU.ts)).

- **Factory**: `createDataZoomSlider(container: HTMLElement, zoomState: ZoomState, options?: DataZoomSliderOptions): DataZoomSlider`
- **`DataZoomSlider` methods (essential)**:
  - `update(theme: ThemeConfig): void`
  - `dispose(): void`
- **Inputs (zoom window semantics)**: `zoomState` is a percent-space window `{ start, end }` in \([0, 100]\) (ordered and clamped by the zoom state manager). See [`createZoomState.ts`](../../src/interaction/createZoomState.ts).

## Render coordinator (internal / contributor notes)

A small orchestration layer for "resolved options → render pass submission".

See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) for the complete implementation (including `GPUContextLike` and `RenderCoordinator` types).

- **Factory**: `createRenderCoordinator(gpuContext: GPUContextLike, options: ResolvedChartGPUOptions, callbacks?: RenderCoordinatorCallbacks): RenderCoordinator`

- **Callbacks (optional)**: `RenderCoordinatorCallbacks` currently supports `onRequestRender?: () => void` for render-on-demand integration (e.g. schedule a render on pointer-driven interaction state changes). See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

**`RenderCoordinator` methods (essential):**

- **`setOptions(resolvedOptions: ResolvedChartGPUOptions): void`**: updates the current resolved chart options; adjusts per-series renderer/buffer allocations when series count changes.
- **`render(): void`**: performs a full frame by computing layout (`GridArea`), deriving clip-space scales (`xScale`, `yScale`), preparing renderers, uploading series data via the internal data store, and recording/submitting a render pass.
- **`dispose(): void`**: destroys renderer resources and the internal data store; safe to call multiple times.

**Responsibilities (essential):**

- **Layout**: computes `GridArea` from resolved grid margins and canvas size.
- **Scales**: derives `xScale`/`yScale` in clip space; respects explicit axis `min`/`max` overrides and otherwise falls back to global series bounds.
- **Orchestration order**: clear → grid → area fills → bars → scatter → line strokes → hover highlight → axes → crosshair.
- **Interaction overlays (internal)**: the render coordinator creates an internal [event manager](#event-manager-internal), an internal [crosshair renderer](#crosshair-renderer-internal--contributor-notes), and an internal [highlight renderer](#highlight-renderer-internal--contributor-notes). Pointer `mousemove`/`mouseleave` updates interaction state and toggles overlay visibility; when provided, `callbacks.onRequestRender?.()` is used so pointer movement schedules renders in render-on-demand systems (e.g. `ChartGPU`).
- **Pointer coordinate contract (high-level)**: the crosshair `prepare(...)` path expects **canvas-local CSS pixels** (`EventManager` payload `x`/`y`). See [`createEventManager.ts`](../../src/interaction/createEventManager.ts) and [`createCrosshairRenderer.ts`](../../src/renderers/createCrosshairRenderer.ts).
- **Target format**: uses `gpuContext.preferredFormat` (fallback `'bgra8unorm'`) for renderer pipelines; must match the render pass color attachment format.
- **Theme application (essential)**: see [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
  - Background clear uses `resolvedOptions.theme.backgroundColor`.
  - Grid lines use `resolvedOptions.theme.gridLineColor`.
  - Axes use `resolvedOptions.theme.axisLineColor` (baseline) and `resolvedOptions.theme.axisTickColor` (ticks).
  - Axis tick value labels are rendered as DOM text (via the internal [text overlay](#text-overlay-internal--contributor-notes)) and styled using `resolvedOptions.theme.textColor`, `resolvedOptions.theme.fontSize`, and `resolvedOptions.theme.fontFamily` (see [`ThemeConfig`](../../src/themes/types.ts)).

## Renderer utilities (Contributor notes)

Shared WebGPU renderer helpers live in [`rendererUtils.ts`](../../src/renderers/rendererUtils.ts). These are small, library-friendly utilities intended to reduce repeated boilerplate when building renderers.

- **`createShaderModule(device, code, label?)`**: creates a `GPUShaderModule` from WGSL source.
- **`createRenderPipeline(device, config)`**: creates a `GPURenderPipeline` from either existing shader modules or WGSL code.
  - **Defaults**: `layout: 'auto'`, `vertex.entryPoint: 'vsMain'`, `fragment.entryPoint: 'fsMain'`, `primitive.topology: 'triangle-list'`, `multisample.count: 1`
  - **Fragment targets convenience**: provide `fragment.formats` (one or many formats) instead of full `fragment.targets` to generate `GPUColorTargetState[]` (optionally with shared `blend` / `writeMask`).
- **`createUniformBuffer(device, size, options?)`**: creates a `GPUBuffer` with usage `UNIFORM | COPY_DST`, aligning size (defaults to 16-byte alignment).
- **`writeUniformBuffer(device, buffer, data)`**: writes `BufferSource` data at offset 0 via `device.queue.writeBuffer(...)`.
- **Uniform packing (perf)**: several renderers reuse small scratch typed arrays for uniform packing to avoid per-frame allocations; see [`createLineRenderer.ts`](../../src/renderers/createLineRenderer.ts), [`createAreaRenderer.ts`](../../src/renderers/createAreaRenderer.ts), [`createScatterRenderer.ts`](../../src/renderers/createScatterRenderer.ts), and [`createPieRenderer.ts`](../../src/renderers/createPieRenderer.ts).

### Line renderer (internal / contributor notes)

A minimal line-strip renderer factory lives in [`createLineRenderer.ts`](../../src/renderers/createLineRenderer.ts). It's intended as a reference implementation for renderer structure (pipeline setup, uniforms, and draw calls) and is not part of the public API exports.

- **`createLineRenderer(device: GPUDevice): LineRenderer`**
- **`createLineRenderer(device: GPUDevice, options?: LineRendererOptions): LineRenderer`**
- **`LineRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **Alpha blending**: the pipeline enables standard alpha blending so per-series `lineStyle.opacity` composites as expected over an opaque cleared background.
- **`LineRenderer.prepare(seriesConfig: ResolvedLineSeriesConfig, dataBuffer: GPUBuffer, xScale: LinearScale, yScale: LinearScale): void`**: updates per-series uniforms and binds the current vertex buffer
- **`LineRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`LineRenderer.dispose(): void`**

Shader sources: [`line.wgsl`](../../src/shaders/line.wgsl) and [`area.wgsl`](../../src/shaders/area.wgsl) (triangle-strip filled area under a line).

Bar renderer implementation: [`createBarRenderer.ts`](../../src/renderers/createBarRenderer.ts). Shader source: [`bar.wgsl`](../../src/shaders/bar.wgsl) (instanced rectangle expansion; per-instance `vec4<f32>(x, y, width, height)`; intended draw call uses 6 vertices per instance for 2 triangles).

Pie slice shader source: [`pie.wgsl`](../../src/shaders/pie.wgsl) (instanced quad + SDF mask for pie/donut slices; wired via [`createPieRenderer.ts`](../../src/renderers/createPieRenderer.ts) and orchestrated by [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts)).

### Scatter renderer (internal / contributor notes)

An instanced scatter circle renderer factory lives in [`createScatterRenderer.ts`](../../src/renderers/createScatterRenderer.ts). It uses [`scatter.wgsl`](../../src/shaders/scatter.wgsl) to expand a point instance into a quad in the vertex stage and render an anti-aliased circle in the fragment stage.

- **`createScatterRenderer(device: GPUDevice, options?: ScatterRendererOptions): ScatterRenderer`**
- **`ScatterRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **`ScatterRenderer.prepare(seriesConfig, data, xScale, yScale, gridArea?)`**:
  - **Scale contract**: `xScale` / `yScale` are expected to output **clip space** (as produced by the render coordinator).
  - **Viewport uniform (`viewportPx`)**: when `gridArea` is provided, the renderer writes `viewportPx = vec2<f32>(gridArea.canvasWidth, gridArea.canvasHeight)` (device pixels). The shader uses this to convert `radiusPx` into a clip-space offset.
  - **Size semantics (important)**:
    - Per-point `size` (tuple third value or object `size`) takes precedence when present and finite.
    - Otherwise, `series.symbolSize` is used (number or function) as a fallback.
    - Sizes are interpreted as a **radius in CSS pixels** and are multiplied by `window.devicePixelRatio` before being written as `radiusPx` (device pixels) for the shader.
  - **Clipping**: when `gridArea` is provided, the renderer applies a plot-area scissor rect (device pixels) for the draw and resets scissor afterward.
- **Current symbol**: the WGSL implementation renders circles; `ScatterSeriesConfig.symbol` is currently not used by the renderer.

- **Area strip vertex convention (essential)**: `area.wgsl` expects CPU-expanded vertices as `p0,p0,p1,p1,...` (triangle-strip), using `@builtin(vertex_index)` parity to choose between the original y and a uniform `baseline`.
- **Area uniforms (essential)**: vertex uniform includes `transform` and `baseline`; fragment uniform includes solid `color: vec4<f32>`.

### Area renderer (internal / contributor notes)

A minimal filled-area renderer factory lives in [`createAreaRenderer.ts`](../../src/renderers/createAreaRenderer.ts). It renders a triangle-strip fill under a series using [`area.wgsl`](../../src/shaders/area.wgsl) and is exercised by the filled line-series configuration (`areaStyle`) in [`examples/basic-line/main.ts`](../../examples/basic-line/main.ts).

- **`createAreaRenderer(device: GPUDevice): AreaRenderer`**
- **`createAreaRenderer(device: GPUDevice, options?: AreaRendererOptions): AreaRenderer`**
- **`AreaRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **Alpha blending**: the pipeline enables standard alpha blending so `areaStyle.opacity` composites as expected over an opaque cleared background.
- **`AreaRenderer.prepare(seriesConfig: ResolvedAreaSeriesConfig, data: ResolvedAreaSeriesConfig['data'], xScale: LinearScale, yScale: LinearScale, baseline?: number): void`**: uploads an expanded triangle-strip vertex buffer (`p0,p0,p1,p1,...`) and updates uniforms (transform + baseline + RGBA color)
- **`AreaRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`AreaRenderer.dispose(): void`**

### Grid renderer (internal / contributor notes)

A minimal grid-line renderer factory lives in [`createGridRenderer.ts`](../../src/renderers/createGridRenderer.ts). It renders horizontal/vertical grid lines directly in clip space and is exercised by the interactive example in [`examples/grid-test/main.ts`](../../examples/grid-test/main.ts). Shader source: [`grid.wgsl`](../../src/shaders/grid.wgsl).

The factory supports `createGridRenderer(device, options?)` where `options.targetFormat?: GPUTextureFormat` must match the canvas context format used for the render pass color attachment (usually `GPUContextState.preferredFormat`) to avoid a WebGPU validation error caused by a pipeline/attachment format mismatch.

Grid line color is supplied from the resolved theme (`theme.gridLineColor`) by the render coordinator and passed via `prepare(gridArea, { color })`. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and [`createGridRenderer.ts`](../../src/renderers/createGridRenderer.ts).

### Axis renderer (internal / contributor notes)

A minimal axis (baseline + ticks) renderer factory lives in [`createAxisRenderer.ts`](../../src/renderers/createAxisRenderer.ts). It is currently internal (not part of the public API exports) and is exercised by [`examples/grid-test/main.ts`](../../examples/grid-test/main.ts).

- **`createAxisRenderer(device: GPUDevice, options?: AxisRendererOptions): AxisRenderer`**
- **`AxisRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **`AxisRenderer.prepare(axisConfig: AxisConfig, scale: LinearScale, orientation: 'x' | 'y', gridArea: GridArea, axisLineColor?: string, axisTickColor?: string, tickCount?: number): void`**
  - **`orientation`**: `'x'` renders the baseline along the bottom edge of the plot area (ticks extend outward/down); `'y'` renders along the left edge (ticks extend outward/left).
  - **Ticks**: placed at regular intervals across the axis domain.
  - **Tick labels**: tick value labels are rendered for each tick mark (label count matches tick count). Default tick count is `5`; when `xAxis.type === 'time'`, the render coordinator may compute an **adaptive** x tick count to avoid label overlap and passes it to the axis renderer so GPU ticks and DOM labels stay in sync. See [`createAxisRenderer.ts`](../../src/renderers/createAxisRenderer.ts) and [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
  - **Tick length**: `AxisConfig.tickLength` is in CSS pixels (default: 6).
  - **Baseline vs ticks**: the baseline and tick segments can be styled with separate colors (`axisLineColor` vs `axisTickColor`).

### Crosshair renderer (internal / contributor notes)

A crosshair overlay renderer factory lives in [`createCrosshairRenderer.ts`](../../src/renderers/createCrosshairRenderer.ts). It is currently internal (not exported from the public entrypoint `src/index.ts`).

- **`createCrosshairRenderer(device: GPUDevice, options?: CrosshairRendererOptions): CrosshairRenderer`**
- **`CrosshairRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **`CrosshairRenderer.prepare(x: number, y: number, gridArea: GridArea, options: CrosshairRenderOptions): void`**
  - **Coordinate contract (critical)**:
    - `x` / `y` are **canvas-local CSS pixels** (e.g. pointer coordinates produced by [`createEventManager.ts`](../../src/interaction/createEventManager.ts)).
    - `gridArea` margins (`left/right/top/bottom`) are **CSS pixels**, while `gridArea.canvasWidth` / `gridArea.canvasHeight` are **device pixels**.
  - **Clipping**: the renderer computes a scissor rect for the plot area (in device pixels) and clips the crosshair to it; `render(...)` resets scissor to the full canvas after drawing.
  - **Line width (best-effort)**: `options.lineWidth` is in CSS pixels; thickness is approximated by drawing multiple parallel 1px lines in device-pixel offsets (clamped to a small deterministic maximum).
  - **Dash fallback**: segments are CPU-generated into a `line-list` vertex buffer to approximate a dashed line; if segmentation would exceed a hard vertex cap, it falls back to a single solid segment per enabled axis.
- **`CrosshairRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`CrosshairRenderer.setVisible(visible: boolean): void`**: toggles visibility without destroying GPU resources.
- **`CrosshairRenderer.dispose(): void`**: destroys internal buffers (best-effort).

- **`CrosshairRenderOptions`**: `{ showX: boolean, showY: boolean, color: string, lineWidth: number }`

Shader source: [`crosshair.wgsl`](../../src/shaders/crosshair.wgsl) (`line-list` pipeline; fragment outputs a uniform RGBA color with alpha blending enabled).

### Highlight renderer (internal / contributor notes)

A point highlight overlay renderer factory lives in [`createHighlightRenderer.ts`](../../src/renderers/createHighlightRenderer.ts). It is currently internal (not exported from the public entrypoint `src/index.ts`).

- **Factory**: `createHighlightRenderer(device: GPUDevice, options?: HighlightRendererOptions): HighlightRenderer`
- **`HighlightRenderer.prepare(point: HighlightPoint, color: string, size: number): void`**: prepares a ring highlight for a single point.
  - **Coordinate contract (high-level)**: `HighlightPoint.centerDeviceX/centerDeviceY` are **device pixels** (same coordinate space as fragment `@builtin(position)`), `HighlightPoint.scissor` is a **device-pixel scissor rect** for the plot area, and `size` is specified in **CSS pixels** (scaled by DPR internally).
- **`HighlightRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`HighlightRenderer.setVisible(visible: boolean): void`**
- **`HighlightRenderer.dispose(): void`**

Shader source: [`highlight.wgsl`](../../src/shaders/highlight.wgsl) (fullscreen triangle; fragment draws a soft-edged ring around the prepared center position with alpha blending enabled).

Hover highlight behavior is orchestrated by the render coordinator in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts): when the pointer is inside the plot grid, it finds the nearest data point (via [`findNearestPoint.ts`](../../src/interaction/findNearestPoint.ts)) and prepares the highlight ring at that point, clipped to the plot rect; otherwise the highlight is hidden.

**WGSL imports:** renderers may import WGSL as a raw string via Vite's `?raw` query (e.g. `*.wgsl?raw`). TypeScript support for this pattern is provided by [`wgsl-raw.d.ts`](../../src/wgsl-raw.d.ts).

Notes:

- **Scatter point symbol shader**: [`scatter.wgsl`](../../src/shaders/scatter.wgsl) expands instanced points into quads in the vertex stage and draws anti-aliased circles in the fragment stage using an SDF + `smoothstep`. It expects per-instance `center` + `radiusPx`, plus uniforms for `transform`, `viewportPx`, and `color` (see the shader source).
- **Example shader compilation smoke-check**: the hello-world example imports `line.wgsl`, `area.wgsl`, `scatter.wgsl`, and `pie.wgsl` via `?raw` and (when supported) uses `GPUShaderModule.getCompilationInfo()` to fail fast on shader compilation errors. See [`examples/hello-world/main.ts`](../../examples/hello-world/main.ts).
- **Render target format**: a renderer pipeline's target format must match the render pass color attachment format (otherwise WebGPU raises a pipeline/attachment format mismatch validation error). `createAxisRenderer`, `createGridRenderer`, and `createLineRenderer` each accept `options.targetFormat` (typically `GPUContextState.preferredFormat`) and default to `'bgra8unorm'` for backward compatibility.
- **Scale output space**: `prepare(...)` treats scales as affine and uses `scale(...)` samples to build a clip-space transform. Scales that output pixels (or non-linear scales) will require a different transform strategy.
- **Line width and alpha**: line primitives are effectively 1px-class across implementations; wide lines require triangle-based extrusion. `createLineRenderer` enables standard alpha blending so `lineStyle.opacity` composites as expected.

**Caveats (important):**

- **4-byte write rule**: `queue.writeBuffer(...)` requires byte offsets and write sizes to be multiples of 4. `writeUniformBuffer(...)` enforces this (throws if misaligned).
- **Uniform sizing/alignment**: WGSL uniform layout is typically 16-byte aligned; `createUniformBuffer(...)` defaults to 16-byte size alignment (you can override via `options.alignment`).
- **Dynamic offsets**: if you bind uniform buffers with *dynamic offsets*, you must additionally align *offsets* to `device.limits.minUniformBufferOffsetAlignment` (commonly 256). These helpers do not enforce dynamic-offset alignment.

## Related Resources

- [WebGPU Specification](https://www.w3.org/TR/webgpu/)
- [WebGPU Samples](https://webgpu.github.io/webgpu-samples/)
- [MDN WebGPU Documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
