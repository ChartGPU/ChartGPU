# API Reference

## Chart API (Phase 1)

See [ChartGPU.ts](../src/ChartGPU.ts) for the chart instance implementation.

### `ChartGPU.create(container: HTMLElement, options: ChartGPUOptions): Promise<ChartGPUInstance>`

Creates a chart instance bound to a container element.

### `ChartGPUInstance`

Returned by `ChartGPU.create(...)`.

See [ChartGPU.ts](../src/ChartGPU.ts) for the full interface and lifecycle behavior.

**Properties (essential):**

- `options: Readonly<ChartGPUOptions>`: the last user-provided options object (unresolved).
- `disposed: boolean`

**Methods (essential):**

- `setOption(options: ChartGPUOptions): void`: replaces the current user options, resolves them against defaults via [`resolveOptions`](../src/config/OptionResolver.ts), updates internal render state, and schedules a single on-demand render on the next `requestAnimationFrame` tick (coalesces multiple calls).
- `resize(): void`: recomputes the canvas backing size / WebGPU canvas configuration from the container size; if anything changes, schedules a render.
- `dispose(): void`: cancels any pending frame, disposes internal render resources, destroys the WebGPU context, and removes the canvas.

Data upload and scale/bounds derivation occur during [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) `RenderCoordinator.render()` (not during `setOption(...)` itself).

**Legend (automatic):**

ChartGPU currently mounts a small legend panel as an internal HTML overlay (series swatch + series name) alongside the canvas. The legend is created and managed by the render pipeline in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) (default position: `'right'`), updates when `setOption(...)` is called, and is disposed with the chart. Series labels come from `series[i].name` (trimmed), falling back to `Series N`; swatch colors come from `series[i].color` when provided, otherwise the resolved theme palette (see internal [`createLegend`](../src/components/createLegend.ts)).

### `ChartGPUOptions`

Chart configuration options.

See [`types.ts`](../src/config/types.ts) for the full type definition.

**Theme (essential):**

- **`ChartGPUOptions.theme`**: accepts `'dark' | 'light'` or a [`ThemeConfig`](../src/themes/types.ts) object. See [`ChartGPUOptions`](../src/config/types.ts) and [`ThemeName` / `getTheme`](../src/themes/index.ts).

**Data points (essential):**

- **`DataPoint`**: a series data point is either a tuple (`readonly [x, y]`) or an object (`Readonly<{ x, y }>`). See [`types.ts`](../src/config/types.ts).

**Series configuration (essential):**

- **`SeriesType`**: `'line' | 'area'`. See [`types.ts`](../src/config/types.ts).
- **`SeriesConfig`**: `LineSeriesConfig | AreaSeriesConfig` (discriminated by `series.type`). See [`types.ts`](../src/config/types.ts).
- **`LineSeriesConfig`**: extends the shared series fields with `type: 'line'`, optional `lineStyle?: LineStyleConfig`, and optional `areaStyle?: AreaStyleConfig`.
  - When a line series includes `areaStyle`, ChartGPU renders a filled area behind the line (area fills then line strokes). See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
- **`AreaSeriesConfig`**: extends the shared series fields with `type: 'area'`, optional `baseline?: number`, and optional `areaStyle?: AreaStyleConfig`.
  - **`baseline`** is a data-space “filled area floor”. If omitted, ChartGPU defaults it to the y-axis minimum.
  - **`areaStyle.opacity`** controls the fill opacity.

**Axis configuration (essential):**

- **`AxisConfig`**: configuration for `xAxis` / `yAxis`. See [`types.ts`](../src/config/types.ts).
- **`AxisConfig.name?: string`**: renders an axis title when provided (and non-empty after `trim()`): x-axis titles are centered below x-axis tick labels, and y-axis titles are rotated \(-90°\) and placed left of y-axis tick labels; titles can be clipped if `grid.bottom` / `grid.left` margins are too small.
- **Axis title styling**: titles are rendered via the internal DOM text overlay and use the resolved theme’s `textColor` and `fontFamily` with slightly larger, bold text (label elements also set `dir='auto'`).

**Tooltip configuration (type definitions):**

- **`ChartGPUOptions.tooltip?: TooltipConfig`**: optional tooltip configuration. See [`types.ts`](../src/config/types.ts).
- **`TooltipConfig.trigger?: 'item' | 'axis'`**: tooltip trigger mode.
- **`TooltipConfig.formatter?: (params: TooltipParams | TooltipParams[]) => string`**: custom formatter function. Receives a single `TooltipParams` when `trigger` is `'item'`, or an array of `TooltipParams` when `trigger` is `'axis'`. See [`types.ts`](../src/config/types.ts) for `TooltipParams` fields (`seriesName`, `seriesIndex`, `dataIndex`, `value`, `color`).

Default tooltip formatter helpers are available in [`formatTooltip.ts`](../src/components/formatTooltip.ts): `formatTooltipItem(params: TooltipParams): string` (item mode) and `formatTooltipAxis(params: TooltipParams[]): string` (axis mode). Both return HTML strings intended for the internal tooltip overlay’s `innerHTML` usage; the axis formatter includes an x header line.

Note: Tooltip configuration types are currently defined, but ChartGPU does not yet wire them into the render coordinator. There is an internal DOM tooltip overlay helper available for contributors; see [Tooltip overlay (internal)](#tooltip-overlay-internal--contributor-notes) and [`createTooltip.ts`](../src/components/createTooltip.ts).

For a working configuration (including axis titles via `AxisConfig.name` and a filled line series via `areaStyle`), see [`examples/basic-line/main.ts`](../examples/basic-line/main.ts).

### `defaultOptions`

Default chart options used as a baseline for resolution.

See [`defaults.ts`](../src/config/defaults.ts) for the defaults (including grid, palette, and axis defaults).

**Behavior notes (essential):**

- **Default grid**: `left: 60`, `right: 20`, `top: 40`, `bottom: 40`
- **Palette / series colors**: `ChartGPUOptions.palette` acts as an override for the resolved theme palette (`resolvedOptions.theme.colorPalette`). When `series[i].color` is missing, the default series color comes from `resolvedOptions.theme.colorPalette[i % ...]`. For backward compatibility, the resolved `palette` is the resolved theme palette. See [`resolveOptions`](../src/config/OptionResolver.ts) and [`ThemeConfig`](../src/themes/types.ts).
- **Axis ticks**: `AxisConfig.tickLength` controls tick length in CSS pixels (default: 6)

### `resolveOptions(userOptions?: ChartGPUOptions)` / `OptionResolver.resolve(userOptions?: ChartGPUOptions)`

Resolves user options against defaults by deep-merging user-provided values with defaults and returning a resolved options object.

See [`OptionResolver.ts`](../src/config/OptionResolver.ts) for the resolver API and resolved option types.

**Behavior notes (essential):**

- **Theme input**: `ChartGPUOptions.theme` accepts `'dark' | 'light'` or a [`ThemeConfig`](../src/themes/types.ts); the resolved `theme` is always a concrete `ThemeConfig`. See [`ChartGPUOptions`](../src/config/types.ts) and [`resolveOptions`](../src/config/OptionResolver.ts).
- **Default theme**: when `theme` is omitted, the resolved theme defaults to `'dark'` via [`getTheme`](../src/themes/index.ts) (preset: [`darkTheme`](../src/themes/darkTheme.ts)).
- **Theme name resolution**: `resolveOptions({ theme: 'light' })` resolves `theme` to the light preset config (see [`lightTheme`](../src/themes/lightTheme.ts)).
- **Palette override**: when `ChartGPUOptions.palette` is provided (non-empty), it overrides the resolved theme palette (`resolvedOptions.theme.colorPalette`). The resolved `palette` mirrors the resolved theme palette for backward compatibility. See [`resolveOptions`](../src/config/OptionResolver.ts).

### `ThemeConfig`

Theme configuration type for describing chart theme colors, palette, and typography. Used by `ChartGPUOptions.theme` (and produced by [`resolveOptions`](../src/config/OptionResolver.ts)).

See [`types.ts`](../src/themes/types.ts).

### Theme presets

ChartGPU provides built-in theme presets and a small helper for selecting them. These are exported from the public entrypoint; see [`src/index.ts`](../src/index.ts).

- **`darkTheme: ThemeConfig`**: built-in dark preset. See [`darkTheme.ts`](../src/themes/darkTheme.ts).
- **`lightTheme: ThemeConfig`**: built-in light preset. See [`lightTheme.ts`](../src/themes/lightTheme.ts).
- **`ThemeName = 'dark' | 'light'`**: preset name union. See [`themes/index.ts`](../src/themes/index.ts).
- **`getTheme(name: ThemeName): ThemeConfig`**: returns a preset by name. See [`themes/index.ts`](../src/themes/index.ts).

## Scales (Pure utilities)

ChartGPU exports a small set of pure utilities for mapping numeric domains to numeric ranges. See [`scales.ts`](../src/utils/scales.ts).

### `createLinearScale(): LinearScale`

Creates a linear scale with an initial identity mapping (domain `[0, 1]` -> range `[0, 1]`).

**Behavior notes (essential):**

- **Chainable setters**: `domain(min, max)` and `range(min, max)` return the same scale instance for chaining.
- **`scale(value)`**: maps domain -> range with no clamping (values outside the domain extrapolate). If the domain span is zero (`min === max`), returns the midpoint of the range.
- **`invert(pixel)`**: maps range -> domain with no clamping (pixels outside the range extrapolate). If the domain span is zero (`min === max`), returns `min` for any input.

### `LinearScale`

Type definition for the scale returned by `createLinearScale()`. See [`scales.ts`](../src/utils/scales.ts).

## Functional API (Preferred)

The functional API provides a type-safe, immutable approach to managing WebGPU contexts.

See [GPUContext.ts](../src/core/GPUContext.ts) for the complete implementation.

### `GPUContextState`

Represents the state of a GPU context with readonly properties.

### `createGPUContext(canvas?: HTMLCanvasElement): GPUContextState`

Creates a new GPUContext state with initial values.

### `createGPUContextAsync(canvas?: HTMLCanvasElement): Promise<GPUContextState>`

Creates and initializes a GPU context in one step. Recommended for most use cases.

**Throws:** `Error` if initialization fails

### `initializeGPUContext(context: GPUContextState): Promise<GPUContextState>`

Initializes the WebGPU context by requesting an adapter and device. Returns a new state object.

**Throws:** `Error` if WebGPU unavailable, adapter/device request fails, or already initialized

### `getCanvasTexture(context: GPUContextState): GPUTexture`

Gets the current texture from the canvas context.

**Throws:** `Error` if canvas not configured or context not initialized

### `clearScreen(context: GPUContextState, r: number, g: number, b: number, a: number): void`

Clears the canvas to a solid color.

**Parameters:** `r`, `g`, `b`, `a` - Color components in range [0.0, 1.0]

**Throws:** `Error` if color components are out of range, canvas not configured, or context not initialized

See [GPUContext.ts](../src/core/GPUContext.ts) for implementation.

### `destroyGPUContext(context: GPUContextState): GPUContextState`

Destroys the WebGPU device and cleans up resources. Returns a new state object with reset values.

## Class-Based API (Backward Compatibility)

The `GPUContext` class provides a class-based interface that internally uses the functional implementation.

See [GPUContext.ts](../src/core/GPUContext.ts) for the complete implementation.

### `GPUContext.create(canvas?: HTMLCanvasElement): Promise<GPUContext>`

Factory method that creates and initializes a GPUContext instance.

**Throws:** `Error` if initialization fails

### Properties

- `adapter` - WebGPU adapter instance, or `null` if not initialized
- `device` - WebGPU device instance, or `null` if not initialized
- `initialized` - `true` if successfully initialized
- `canvas` - Canvas element, or `null` if not provided
- `canvasContext` - WebGPU canvas context, or `null` if not configured
- `preferredFormat` - Preferred canvas format, or `null` if not configured

### Methods

- `initialize(): Promise<void>` - Initializes the WebGPU context
- `getCanvasTexture(): GPUTexture` - Gets the current canvas texture
- `clearScreen(r: number, g: number, b: number, a: number): void` - Clears the canvas to a solid color
- `destroy(): void` - Destroys the device and cleans up resources

## Error Handling

All initialization functions throw descriptive errors if WebGPU is unavailable, adapter/device requests fail, or the context is already initialized. Wrap initialization in try-catch blocks.

## Best Practices

Always call `destroyGPUContext()` (functional) or `destroy()` (class) when done with a GPU context. Use try-finally blocks to ensure cleanup.

When providing a canvas element, the context automatically handles device pixel ratio and configures the canvas with the preferred format.

## RenderScheduler

Manages a 60fps render loop using requestAnimationFrame with delta time tracking.

See [RenderScheduler.ts](../src/core/RenderScheduler.ts) for the complete implementation.

### `RenderCallback`

Callback function type that receives delta time in milliseconds since the last frame.

### `RenderScheduler`

Class that manages the render loop lifecycle.

### `start(callback: RenderCallback): void`

Begins the requestAnimationFrame loop. Callback receives delta time in milliseconds.

**Throws:** `Error` if callback not provided or scheduler already running

### `stop(): void`

Stops the render loop and cancels pending frames.

### `requestRender(): void`

Marks frame as dirty for future optimization. Currently unused but prepared for frame-skipping.

### `running: boolean`

Getter that returns `true` if the scheduler is currently running.

## Type Definitions

All WebGPU types are provided by `@webgpu/types`. See [GPUContext.ts](../src/core/GPUContext.ts) and [RenderScheduler.ts](../src/core/RenderScheduler.ts) for type usage.

## Internal modules (Contributor notes)

Chart data uploads and per-series GPU vertex buffer caching are handled by the internal `createDataStore(device)` helper. See [`createDataStore.ts`](../src/data/createDataStore.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

### Interaction utilities (internal / contributor notes)

Interaction helpers live in [`src/interaction/`](../src/interaction/). These modules are currently internal (not exported from the public entrypoint `src/index.ts`).

#### Event manager (internal)

See [`createEventManager.ts`](../src/interaction/createEventManager.ts).

- **Factory**: `createEventManager(canvas: HTMLCanvasElement, initialGridArea: GridArea): EventManager`
- **Purpose**: normalizes pointer input into chart-friendly coordinates and emits `'mousemove' | 'click' | 'mouseleave'` events.
- **Coordinate contract (critical)**:
  - `payload.x` / `payload.y` are **canvas-local CSS pixels** (relative to the canvas top-left in CSS px via `getBoundingClientRect()`).
  - `payload.gridX` / `payload.gridY` are **plot-area-local CSS pixels** (canvas-local CSS px minus `GridArea` CSS-pixel margins).
  - `payload.isInGrid` is computed in **CSS pixels** against the current plot rect.
- **Layout updates**: `EventManager.updateGridArea(gridArea)` must be called when grid/layout changes (ChartGPU’s internal render coordinator updates it each render).
- **Current usage**: used internally by the render coordinator to drive the crosshair overlay and to request renders in render-on-demand systems. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

#### Hover state manager (internal)

See [`createHoverState.ts`](../src/interaction/createHoverState.ts).

- **Factory**: `createHoverState(): HoverState`
- **Purpose**: tracks the currently hovered `{ seriesIndex, dataIndex }` pair and notifies listeners when it changes.
- **Debounce**: updates are coalesced with an internal debounce of ~16ms to avoid spamming downstream work during rapid pointer movement.
- **Change-only notifications**: listeners fire only when the hovered target actually changes (including `null`).
- **Listener management**: `onChange(callback)` returns an unsubscribe function; emissions iterate a snapshot of listeners so subscription changes during emit don’t affect the current flush.
- **Lifecycle**: `HoverState` includes an optional `destroy?: () => void`; `createHoverState()` currently returns a `destroy()` implementation that cancels any pending debounce timer and clears all listeners/state.

#### Nearest point detection (internal)

See [`findNearestPoint.ts`](../src/interaction/findNearestPoint.ts).

- **Function**: `findNearestPoint(series: ReadonlyArray<ResolvedSeriesConfig>, x: number, y: number, xScale: LinearScale, yScale: LinearScale, maxDistance?: number): NearestPointMatch | null`
- **Returns**: `null` or `{ seriesIndex, dataIndex, point, distance }`
- **Sorted-x requirement**: each series must be sorted by increasing `x` in domain space for the binary search path to be correct.
- **Coordinate system contract (critical)**:
  - `x` / `y` must be in the same units as `xScale` / `yScale` **range-space**.
  - If you pass **grid-local CSS pixels** (e.g. `gridX` / `gridY` from [`createEventManager.ts`](../src/interaction/createEventManager.ts)), then `xScale.range(...)` / `yScale.range(...)` must also be in **CSS pixels**.
  - If you pass **clip-space coordinates**, then the scales must also output clip space (and `maxDistance` is interpreted in clip-space units).
- **Performance**: per-series lower-bound binary search on x with outward expansion based on x-distance pruning; uses squared distances internally and computes `sqrt` only for the final match.

#### Points-at-x lookup (internal)

See [`findPointsAtX.ts`](../src/interaction/findPointsAtX.ts).

- **Function**: `findPointsAtX(series: ReadonlyArray<ResolvedSeriesConfig>, xValue: number, xScale: LinearScale, tolerance?: number): ReadonlyArray<PointsAtXMatch>`
- **Return type**: `ReadonlyArray<PointsAtXMatch>` where `PointsAtXMatch = { seriesIndex, dataIndex, point }`
- **Coordinate system contract (critical)**:
  - `xValue` and `tolerance` MUST be in the same units as `xScale` **range-space**.
  - Note: ChartGPU’s internal render scales are currently in clip space (NDC, typically \[-1, 1\]); in that case, convert pointer x into clip space before calling this helper.
- **Tolerance behavior**: when `tolerance` is finite, matches with \(|xScale.scale(point.x) - xValue|\) beyond tolerance are omitted; when `tolerance` is omitted or non-finite, returns the nearest point per series when possible.
- **Sorted-x requirement**: each series must be sorted by increasing `x` in domain space for the binary search path to be correct.
- **NaN-x fallback**: if a series contains any `NaN` x values, this helper falls back to an O(n) scan for correctness (NaN breaks total ordering for binary search).

### Text overlay (internal / contributor notes)

An internal DOM helper for rendering text labels above the canvas using an absolutely-positioned HTML overlay. See [`createTextOverlay.ts`](../src/components/createTextOverlay.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createTextOverlay(container: HTMLElement): TextOverlay`
- **`TextOverlay` methods (essential)**:
  - `clear(): void`
  - `addLabel(text: string, x: number, y: number, options?: TextOverlayLabelOptions): HTMLSpanElement`
  - `dispose(): void`
- **Coordinates**: `x` / `y` are in CSS pixels relative to the container’s top-left corner.
- **Pointer events**: the overlay uses `pointer-events: none` so it won’t intercept mouse/touch input.
- **Current usage**: used by the render coordinator to render numeric axis tick value labels above the canvas. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

### Legend (internal / contributor notes)

An internal DOM helper for rendering a series legend (color swatch + series name) above the canvas using an absolutely-positioned HTML overlay. See [`createLegend.ts`](../src/components/createLegend.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createLegend(container: HTMLElement, position?: 'top' | 'bottom' | 'left' | 'right')`
- **`Legend` methods (essential)**:
  - `update(series: ReadonlyArray<SeriesConfig>, theme: ThemeConfig): void`
  - `dispose(): void`
- **Current usage**: created and updated by the render coordinator (default position `'right'`). See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

### Tooltip overlay (internal / contributor notes)

An internal DOM helper for rendering an HTML tooltip above the canvas. See [`createTooltip.ts`](../src/components/createTooltip.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createTooltip(container: HTMLElement): Tooltip`
- **`Tooltip` methods (essential)**:
  - `show(x: number, y: number, content: string): void`
  - `hide(): void`
  - `dispose(): void`
- **Coordinates**: `x` / `y` are in CSS pixels relative to the container’s top-left corner (container-local CSS px).
- **Positioning behavior**: positions the tooltip near the cursor with flip/clamp logic so it stays within the container bounds.
- **Content**: `content` is treated as HTML and assigned via `innerHTML`. Only pass trusted/sanitized strings.
- **Pointer events**: the tooltip uses `pointer-events: none` so it won’t intercept mouse/touch input.

For default `innerHTML`-safe tooltip content formatting helpers (item + axis trigger modes), see [`formatTooltip.ts`](../src/components/formatTooltip.ts).

### Render coordinator (internal / contributor notes)

A small orchestration layer for “resolved options → render pass submission”.

See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) for the complete implementation (including `GPUContextLike` and `RenderCoordinator` types).

- **Factory**: `createRenderCoordinator(gpuContext: GPUContextLike, options: ResolvedChartGPUOptions, callbacks?: RenderCoordinatorCallbacks): RenderCoordinator`

- **Callbacks (optional)**: `RenderCoordinatorCallbacks` currently supports `onRequestRender?: () => void` for render-on-demand integration (e.g. schedule a render on pointer-driven interaction state changes). See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

**`RenderCoordinator` methods (essential):**

- **`setOptions(resolvedOptions: ResolvedChartGPUOptions): void`**: updates the current resolved chart options; adjusts per-series renderer/buffer allocations when series count changes.
- **`render(): void`**: performs a full frame by computing layout (`GridArea`), deriving clip-space scales (`xScale`, `yScale`), preparing renderers, uploading series data via the internal data store, and recording/submitting a render pass.
- **`dispose(): void`**: destroys renderer resources and the internal data store; safe to call multiple times.

**Responsibilities (essential):**

- **Layout**: computes `GridArea` from resolved grid margins and canvas size.
- **Scales**: derives `xScale`/`yScale` in clip space; respects explicit axis `min`/`max` overrides and otherwise falls back to global series bounds.
- **Orchestration order**: clear → grid → area fills → line strokes → axes → crosshair.
- **Interaction + crosshair (internal)**: the render coordinator creates an internal [event manager](#event-manager-internal) and an internal [crosshair renderer](#crosshair-renderer-internal--contributor-notes). Pointer `mousemove`/`mouseleave` updates crosshair visibility/position; when provided, `callbacks.onRequestRender?.()` is used so pointer movement schedules renders in render-on-demand systems (e.g. `ChartGPU`).
- **Pointer coordinate contract (high-level)**: the crosshair `prepare(...)` path expects **canvas-local CSS pixels** (`EventManager` payload `x`/`y`). See [`createEventManager.ts`](../src/interaction/createEventManager.ts) and [`createCrosshairRenderer.ts`](../src/renderers/createCrosshairRenderer.ts).
- **Target format**: uses `gpuContext.preferredFormat` (fallback `'bgra8unorm'`) for renderer pipelines; must match the render pass color attachment format.
- **Theme application (essential)**: see [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
  - Background clear uses `resolvedOptions.theme.backgroundColor`.
  - Grid lines use `resolvedOptions.theme.gridLineColor`.
  - Axes use `resolvedOptions.theme.axisLineColor` (baseline) and `resolvedOptions.theme.axisTickColor` (ticks).
  - Axis tick value labels are rendered as DOM text (via the internal [text overlay](#text-overlay-internal--contributor-notes)) and styled using `resolvedOptions.theme.textColor`, `resolvedOptions.theme.fontSize`, and `resolvedOptions.theme.fontFamily` (see [`ThemeConfig`](../src/themes/types.ts)).

### Renderer utilities (Contributor notes)

Shared WebGPU renderer helpers live in [`rendererUtils.ts`](../src/renderers/rendererUtils.ts). These are small, library-friendly utilities intended to reduce repeated boilerplate when building renderers.

- **`createShaderModule(device, code, label?)`**: creates a `GPUShaderModule` from WGSL source.
- **`createRenderPipeline(device, config)`**: creates a `GPURenderPipeline` from either existing shader modules or WGSL code.
  - **Defaults**: `layout: 'auto'`, `vertex.entryPoint: 'vsMain'`, `fragment.entryPoint: 'fsMain'`, `primitive.topology: 'triangle-list'`, `multisample.count: 1`
  - **Fragment targets convenience**: provide `fragment.formats` (one or many formats) instead of full `fragment.targets` to generate `GPUColorTargetState[]` (optionally with shared `blend` / `writeMask`).
- **`createUniformBuffer(device, size, options?)`**: creates a `GPUBuffer` with usage `UNIFORM | COPY_DST`, aligning size (defaults to 16-byte alignment).
- **`writeUniformBuffer(device, buffer, data)`**: writes `BufferSource` data at offset 0 via `device.queue.writeBuffer(...)`.

#### Line renderer (internal / contributor notes)

A minimal line-strip renderer factory lives in [`createLineRenderer.ts`](../src/renderers/createLineRenderer.ts). It’s intended as a reference implementation for renderer structure (pipeline setup, uniforms, and draw calls) and is not part of the public API exports.

- **`createLineRenderer(device: GPUDevice): LineRenderer`**
- **`createLineRenderer(device: GPUDevice, options?: LineRendererOptions): LineRenderer`**
- **`LineRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **Alpha blending**: the pipeline enables standard alpha blending so per-series `lineStyle.opacity` composites as expected over an opaque cleared background.
- **`LineRenderer.prepare(seriesConfig: ResolvedLineSeriesConfig, dataBuffer: GPUBuffer, xScale: LinearScale, yScale: LinearScale): void`**: updates per-series uniforms and binds the current vertex buffer
- **`LineRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`LineRenderer.dispose(): void`**

Shader sources: [`line.wgsl`](../src/shaders/line.wgsl) and [`area.wgsl`](../src/shaders/area.wgsl) (triangle-strip filled area under a line).

- **Area strip vertex convention (essential)**: `area.wgsl` expects CPU-expanded vertices as `p0,p0,p1,p1,...` (triangle-strip), using `@builtin(vertex_index)` parity to choose between the original y and a uniform `baseline`.
- **Area uniforms (essential)**: vertex uniform includes `transform` and `baseline`; fragment uniform includes solid `color: vec4<f32>`.

#### Area renderer (internal / contributor notes)

A minimal filled-area renderer factory lives in [`createAreaRenderer.ts`](../src/renderers/createAreaRenderer.ts). It renders a triangle-strip fill under a series using [`area.wgsl`](../src/shaders/area.wgsl) and is exercised by the filled line-series configuration (`areaStyle`) in [`examples/basic-line/main.ts`](../examples/basic-line/main.ts).

- **`createAreaRenderer(device: GPUDevice): AreaRenderer`**
- **`createAreaRenderer(device: GPUDevice, options?: AreaRendererOptions): AreaRenderer`**
- **`AreaRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **Alpha blending**: the pipeline enables standard alpha blending so `areaStyle.opacity` composites as expected over an opaque cleared background.
- **`AreaRenderer.prepare(seriesConfig: ResolvedAreaSeriesConfig, data: ResolvedAreaSeriesConfig['data'], xScale: LinearScale, yScale: LinearScale, baseline?: number): void`**: uploads an expanded triangle-strip vertex buffer (`p0,p0,p1,p1,...`) and updates uniforms (transform + baseline + RGBA color)
- **`AreaRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`AreaRenderer.dispose(): void`**

#### Grid renderer (internal / contributor notes)

A minimal grid-line renderer factory lives in [`createGridRenderer.ts`](../src/renderers/createGridRenderer.ts). It renders horizontal/vertical grid lines directly in clip space and is exercised by the interactive example in [`examples/grid-test/main.ts`](../examples/grid-test/main.ts). Shader source: [`grid.wgsl`](../src/shaders/grid.wgsl).

The factory supports `createGridRenderer(device, options?)` where `options.targetFormat?: GPUTextureFormat` must match the canvas context format used for the render pass color attachment (usually `GPUContextState.preferredFormat`) to avoid a WebGPU validation error caused by a pipeline/attachment format mismatch.

Grid line color is supplied from the resolved theme (`theme.gridLineColor`) by the render coordinator and passed via `prepare(gridArea, { color })`. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) and [`createGridRenderer.ts`](../src/renderers/createGridRenderer.ts).

#### Axis renderer (internal / contributor notes)

A minimal axis (baseline + ticks) renderer factory lives in [`createAxisRenderer.ts`](../src/renderers/createAxisRenderer.ts). It is currently internal (not part of the public API exports) and is exercised by [`examples/grid-test/main.ts`](../examples/grid-test/main.ts).

- **`createAxisRenderer(device: GPUDevice, options?: AxisRendererOptions): AxisRenderer`**
- **`AxisRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **`AxisRenderer.prepare(axisConfig: AxisConfig, scale: LinearScale, orientation: 'x' | 'y', gridArea: GridArea, axisLineColor?: string, axisTickColor?: string): void`**
  - **`orientation`**: `'x'` renders the baseline along the bottom edge of the plot area (ticks extend outward/down); `'y'` renders along the left edge (ticks extend outward/left).
  - **Ticks**: placed at regular intervals across the axis domain.
  - **Tick labels**: numeric tick value labels are rendered for each tick mark (label count matches tick count). The current tick count is fixed at 5; see [`createAxisRenderer.ts`](../src/renderers/createAxisRenderer.ts) and [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
  - **Tick length**: `AxisConfig.tickLength` is in CSS pixels (default: 6).
  - **Baseline vs ticks**: the baseline and tick segments can be styled with separate colors (`axisLineColor` vs `axisTickColor`).

#### Crosshair renderer (internal / contributor notes)

A crosshair overlay renderer factory lives in [`createCrosshairRenderer.ts`](../src/renderers/createCrosshairRenderer.ts). It is currently internal (not exported from the public entrypoint `src/index.ts`).

- **`createCrosshairRenderer(device: GPUDevice, options?: CrosshairRendererOptions): CrosshairRenderer`**
- **`CrosshairRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **`CrosshairRenderer.prepare(x: number, y: number, gridArea: GridArea, options: CrosshairRenderOptions): void`**
  - **Coordinate contract (critical)**:
    - `x` / `y` are **canvas-local CSS pixels** (e.g. pointer coordinates produced by [`createEventManager.ts`](../src/interaction/createEventManager.ts)).
    - `gridArea` margins (`left/right/top/bottom`) are **CSS pixels**, while `gridArea.canvasWidth` / `gridArea.canvasHeight` are **device pixels**.
  - **Clipping**: the renderer computes a scissor rect for the plot area (in device pixels) and clips the crosshair to it; `render(...)` resets scissor to the full canvas after drawing.
  - **Line width (best-effort)**: `options.lineWidth` is in CSS pixels; thickness is approximated by drawing multiple parallel 1px lines in device-pixel offsets (clamped to a small deterministic maximum).
  - **Dash fallback**: segments are CPU-generated into a `line-list` vertex buffer to approximate a dashed line; if segmentation would exceed a hard vertex cap, it falls back to a single solid segment per enabled axis.
- **`CrosshairRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`CrosshairRenderer.setVisible(visible: boolean): void`**: toggles visibility without destroying GPU resources.
- **`CrosshairRenderer.dispose(): void`**: destroys internal buffers (best-effort).

- **`CrosshairRenderOptions`**: `{ showX: boolean, showY: boolean, color: string, lineWidth: number }`

Shader source: [`crosshair.wgsl`](../src/shaders/crosshair.wgsl) (`line-list` pipeline; fragment outputs a uniform RGBA color with alpha blending enabled).

**WGSL imports:** renderers may import WGSL as a raw string via Vite’s `?raw` query (e.g. `*.wgsl?raw`). TypeScript support for this pattern is provided by [`wgsl-raw.d.ts`](../src/wgsl-raw.d.ts).

Notes:

- **Example shader compilation smoke-check**: the hello-world example imports `line.wgsl` and `area.wgsl` via `?raw` and (when supported) uses `GPUShaderModule.getCompilationInfo()` to fail fast on shader compilation errors. See [`examples/hello-world/main.ts`](../examples/hello-world/main.ts).
- **Render target format**: a renderer pipeline’s target format must match the render pass color attachment format (otherwise WebGPU raises a pipeline/attachment format mismatch validation error). `createAxisRenderer`, `createGridRenderer`, and `createLineRenderer` each accept `options.targetFormat` (typically `GPUContextState.preferredFormat`) and default to `'bgra8unorm'` for backward compatibility.
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
