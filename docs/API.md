# API Reference

## Chart API (Phase 1)

See [ChartGPU.ts](../src/ChartGPU.ts) for the chart instance implementation.

### `ChartGPU.create(container: HTMLElement, options: ChartGPUOptions): Promise<ChartGPUInstance>`

Creates a chart instance bound to a container element.

### `ChartGPUOptions`

Chart configuration options.

See [`types.ts`](../src/config/types.ts) for the full type definition.

### `defaultOptions`

Default chart options used as a baseline for resolution.

See [`defaults.ts`](../src/config/defaults.ts) for the defaults (including grid, palette, and axis defaults).

**Behavior notes (essential):**

- **Default grid**: `left: 60`, `right: 20`, `top: 40`, `bottom: 40`
- **Palette / series colors**: `palette` is used to fill missing `series[i].color` by index

### `resolveOptions(userOptions?: ChartGPUOptions)` / `OptionResolver.resolve(userOptions?: ChartGPUOptions)`

Resolves user options against defaults by deep-merging user-provided values with defaults and returning a resolved options object.

See [`OptionResolver.ts`](../src/config/OptionResolver.ts) for the resolver API and resolved option types.

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
- **`LineRenderer.prepare(seriesConfig: ResolvedSeriesConfig, dataBuffer: GPUBuffer, xScale: LinearScale, yScale: LinearScale): void`**: updates per-series uniforms and binds the current vertex buffer
- **`LineRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`LineRenderer.dispose(): void`**

Shader source: [`line.wgsl`](../src/shaders/line.wgsl).

**WGSL imports:** renderers may import WGSL as a raw string via Vite’s `?raw` query (e.g. `*.wgsl?raw`). TypeScript support for this pattern is provided by [`wgsl-raw.d.ts`](../src/wgsl-raw.d.ts).

Notes:

- **Render target format**: the pipeline target format must match the render pass color attachment format. `createLineRenderer` currently uses a default target format (`bgra8unorm`).
- **Scale output space**: `prepare(...)` treats scales as affine and uses `scale(...)` samples to build a clip-space transform. Scales that output pixels (or non-linear scales) will require a different transform strategy.
- **Line width and alpha**: WebGPU line primitives are effectively 1px-class across implementations; wide lines require triangle-based extrusion. Opacity only composites as expected when blending is enabled in the pipeline/target.

**Caveats (important):**

- **4-byte write rule**: `queue.writeBuffer(...)` requires byte offsets and write sizes to be multiples of 4. `writeUniformBuffer(...)` enforces this (throws if misaligned).
- **Uniform sizing/alignment**: WGSL uniform layout is typically 16-byte aligned; `createUniformBuffer(...)` defaults to 16-byte size alignment (you can override via `options.alignment`).
- **Dynamic offsets**: if you bind uniform buffers with *dynamic offsets*, you must additionally align *offsets* to `device.limits.minUniformBufferOffsetAlignment` (commonly 256). These helpers do not enforce dynamic-offset alignment.

## Related Resources

- [WebGPU Specification](https://www.w3.org/TR/webgpu/)
- [WebGPU Samples](https://webgpu.github.io/webgpu-samples/)
- [MDN WebGPU Documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
