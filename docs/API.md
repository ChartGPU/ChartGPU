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

For a working configuration (including a filled line series via `areaStyle`), see [`examples/basic-line/main.ts`](../examples/basic-line/main.ts).

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

### Render coordinator (internal / contributor notes)

A small orchestration layer for “resolved options → render pass submission”.

See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) for the complete implementation (including `GPUContextLike` and `RenderCoordinator` types).

- **Factory**: `createRenderCoordinator(gpuContext: GPUContextLike, options: ResolvedChartGPUOptions): RenderCoordinator`

**`RenderCoordinator` methods (essential):**

- **`setOptions(resolvedOptions: ResolvedChartGPUOptions): void`**: updates the current resolved chart options; adjusts per-series renderer/buffer allocations when series count changes.
- **`render(): void`**: performs a full frame by computing layout (`GridArea`), deriving clip-space scales (`xScale`, `yScale`), preparing renderers, uploading series data via the internal data store, and recording/submitting a render pass.
- **`dispose(): void`**: destroys renderer resources and the internal data store; safe to call multiple times.

**Responsibilities (essential):**

- **Layout**: computes `GridArea` from resolved grid margins and canvas size.
- **Scales**: derives `xScale`/`yScale` in clip space; respects explicit axis `min`/`max` overrides and otherwise falls back to global series bounds.
- **Orchestration order**: clear → grid → area fills → line strokes → axes.
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
