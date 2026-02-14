# GPU Context

## Functional API (Preferred)

The functional API provides a type-safe, immutable approach to managing WebGPU contexts.

See [GPUContext.ts](../../src/core/GPUContext.ts) for the complete implementation.

## Using `GPUContext` alongside `ChartGPU`

`ChartGPU.create(...)` internally creates and owns a WebGPU context for its canvas. **That internal `GPUDevice` / `GPUCanvasContext` is not currently exposed as a public API**, and ChartGPU does not provide a public “custom render pass” injection hook into its internal render pass.

If you need to render custom WebGPU content alongside a ChartGPU chart:

- **Overlay a second canvas** in the same container (absolute positioning) and create your own `GPUContext` for that canvas using `createGPUContextAsync(...)`. Keep its size in sync with the ChartGPU canvas and re-render your overlay when the chart changes (e.g. `'zoomRangeChange'`, resize).
- **Fork ChartGPU** and add a renderer under `src/renderers/`, wiring it into `src/core/createRenderCoordinator.ts` (see [`INTERNALS.md`](./INTERNALS.md#renderer-utilities-contributor-notes)).

For a practical “which approach should I take?” overview, see [Annotations API → Custom visuals](./annotations.md#custom-visuals-beyond-built-in-annotations).

## Types

### `SupportedCanvas`

Union type for supported canvas elements: `HTMLCanvasElement`

See [GPUContext.ts](../../src/core/GPUContext.ts) for type definition.

### `GPUContextOptions`

Configuration options for GPU context initialization:

- `devicePixelRatio?: number` - Device pixel ratio (DPR) used for high-DPI sizing. When not provided, ChartGPU will use `window.devicePixelRatio` when available, otherwise defaults to `1.0`. **Invalid values** (non-finite or \(\le 0\), e.g. `0`, `NaN`, `Infinity`) are **sanitized to `1.0`**.
- `alphaMode?: 'opaque' | 'premultiplied'` - Canvas alpha transparency mode. Default: `'opaque'` (faster, no transparency).
- `powerPreference?: 'low-power' | 'high-performance'` - GPU power preference for adapter selection. Default: `'high-performance'`.
- `adapter?: GPUAdapter` - Optional pre-existing GPUAdapter for **shared device mode**. Only used when **both** `adapter` and `device` are provided.
- `device?: GPUDevice` - Optional pre-existing GPUDevice for **shared device mode**. Only used when **both** `adapter` and `device` are provided. When injected, the caller owns the device lifecycle (it is not destroyed on cleanup).

See [GPUContext.ts](../../src/core/GPUContext.ts) for implementation details.

### Shared Device Support

ChartGPU supports using a **shared GPUDevice** across multiple contexts for efficient GPU resource management:

**Benefits:**
- Share a single GPUDevice across multiple chart instances
- Reduce GPU memory overhead
- Coordinate resource management centrally
- Support multi-canvas rendering scenarios
- Optional: share a pipeline cache to dedupe shader modules + render pipelines across charts — see [Pipeline cache](./chart.md#pipeline-cache-cgpu-pipeline-cache)

**Lifecycle and ownership:**
- When a **shared device** is injected (via `GPUContextOptions.adapter` + `GPUContextOptions.device`, or `ChartGPU.create()` third parameter), the context does **NOT** take ownership
- On `destroyGPUContext()` or `chart.dispose()`:
  - **Always** unconfigures the canvas context (releases textures, required for proper WebGPU cleanup)
  - **Conditionally** destroys the device: only when owned (not injected)
- When the context creates its own device (default behavior), it **does** destroy the device on cleanup

**Device loss handling:**
- Charts with injected devices listen for `device.lost` and emit a `'deviceLost'` event (see [Chart Events](./chart.md#device-loss-event))
- Applications should handle device loss by recreating the shared device and all dependent contexts
- Device loss is rare but can occur due to GPU driver crashes, system sleep, or resource exhaustion

See [Chart API](./chart.md#shared-gpudevice) for usage examples with `ChartGPU.create()`.

## Functions

### `GPUContextState`

Represents the state of a GPU context with readonly properties:

- `adapter: GPUAdapter | null` - WebGPU adapter instance
- `device: GPUDevice | null` - WebGPU device instance
- `initialized: boolean` - Whether context is initialized
- `canvas: SupportedCanvas | null` - Canvas element (HTMLCanvasElement)
- `canvasContext: GPUCanvasContext | null` - WebGPU canvas context
- `preferredFormat: GPUTextureFormat | null` - Preferred canvas texture format
- `devicePixelRatio: number` - DPR used for canvas sizing
- `alphaMode: 'opaque' | 'premultiplied'` - Canvas alpha mode
- `powerPreference: 'low-power' | 'high-performance'` - GPU power preference

### `createGPUContext(canvas?: SupportedCanvas, options?: GPUContextOptions): GPUContextState`

Creates a new GPUContext state with initial values.

**Parameters:**
- `canvas` - Optional HTMLCanvasElement
- `options` - Optional configuration for DPR, alpha mode, and power preference

### `createGPUContextAsync(canvas?: SupportedCanvas, options?: GPUContextOptions): Promise<GPUContextState>`

Creates and initializes a GPU context in one step. Recommended for most use cases.

**Parameters:**
- `canvas` - Optional HTMLCanvasElement
- `options` - Optional configuration for DPR, alpha mode, and power preference

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

See [GPUContext.ts](../../src/core/GPUContext.ts) for implementation.

### `destroyGPUContext(context: GPUContextState): GPUContextState`

Destroys the WebGPU device and cleans up resources. Returns a new state object with reset values.

## Class-Based API (Backward Compatibility)

The `GPUContext` class provides a class-based interface that internally uses the functional implementation.

See [GPUContext.ts](../../src/core/GPUContext.ts) for the complete implementation.

### `constructor(canvas?: SupportedCanvas, options?: GPUContextOptions)`

Creates a new GPUContext instance. Call `initialize()` or use the static `create()` method to complete initialization.

**Parameters:**
- `canvas` - Optional HTMLCanvasElement
- `options` - Optional configuration for DPR, alpha mode, and power preference

### `GPUContext.create(canvas?: SupportedCanvas, options?: GPUContextOptions): Promise<GPUContext>`

Factory method that creates and initializes a GPUContext instance.

**Parameters:**
- `canvas` - Optional HTMLCanvasElement
- `options` - Optional configuration for DPR, alpha mode, and power preference

**Throws:** `Error` if initialization fails

### Properties

- `adapter: GPUAdapter | null` - WebGPU adapter instance, or `null` if not initialized
- `device: GPUDevice | null` - WebGPU device instance, or `null` if not initialized
- `initialized: boolean` - `true` if successfully initialized
- `canvas: SupportedCanvas | null` - Canvas element (HTMLCanvasElement), or `null` if not provided
- `canvasContext: GPUCanvasContext | null` - WebGPU canvas context, or `null` if not configured
- `preferredFormat: GPUTextureFormat | null` - Preferred canvas format, or `null` if not configured
- `devicePixelRatio: number` - DPR used for canvas sizing
- `alphaMode: 'opaque' | 'premultiplied'` - Canvas alpha mode
- `powerPreference: 'low-power' | 'high-performance'` - GPU power preference

### Methods

- `initialize(): Promise<void>` - Initializes the WebGPU context
- `getCanvasTexture(): GPUTexture` - Gets the current canvas texture
- `clearScreen(r: number, g: number, b: number, a: number): void` - Clears the canvas to a solid color
- `destroy(): void` - Destroys the device and cleans up resources

## Browser Compatibility

WebGPU support required:
- **Chrome/Edge 113+**
- **Safari 18+**
- **Firefox:** Not yet supported

Check `navigator.gpu` availability before initialization. See [checkWebGPU.ts](../../src/utils/checkWebGPU.ts) for detection utility.

## Error Handling

Initialization functions throw descriptive errors if WebGPU is unavailable, adapter/device requests fail, or the context is already initialized. Invalid `devicePixelRatio` values are **sanitized to `1.0`** (not thrown). If canvas dimensions are temporarily 0, the configured size is clamped to at least 1×1 device pixels.

## Best Practices

Always call `destroyGPUContext()` (functional) or `destroy()` (class) when done with a GPU context. Use try-finally blocks to ensure cleanup.

**Canvas Configuration:**
- Main thread: Context auto-detects `window.devicePixelRatio` and configures canvas automatically
- Canvas is configured with preferred format (`getPreferredCanvasFormat()` with `'bgra8unorm'` fallback)

**Power Preference:**
- Use `'high-performance'` (default) for rendering-intensive visualizations
- Use `'low-power'` for battery-conscious applications or background rendering

**Alpha Mode:**
- Use `'opaque'` (default) for better performance when transparency is not needed
- Use `'premultiplied'` only when compositing transparent canvas with other page elements
