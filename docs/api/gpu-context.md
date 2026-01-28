# GPU Context

## Functional API (Preferred)

The functional API provides a type-safe, immutable approach to managing WebGPU contexts.

See [GPUContext.ts](../../src/core/GPUContext.ts) for the complete implementation.

## Types

### `SupportedCanvas`

Union type for supported canvas elements: `HTMLCanvasElement | OffscreenCanvas`

Both `HTMLCanvasElement` (main thread) and `OffscreenCanvas` (Web Workers) are supported for rendering.

See [GPUContext.ts](../../src/core/GPUContext.ts) for type definition.

### `GPUContextOptions`

Configuration options for GPU context initialization:

- `devicePixelRatio?: number` - Device pixel ratio (DPR) used for high-DPI sizing. Auto-detects on main thread (`window.devicePixelRatio`), defaults to `1.0` in Web Workers. **Invalid values** (non-finite or \(\le 0\), e.g. `0`, `NaN`, `Infinity`) are **sanitized to `1.0`**.
- `alphaMode?: 'opaque' | 'premultiplied'` - Canvas alpha transparency mode. Default: `'opaque'` (faster, no transparency).
- `powerPreference?: 'low-power' | 'high-performance'` - GPU power preference for adapter selection. Default: `'high-performance'`.

See [GPUContext.ts](../../src/core/GPUContext.ts) for implementation details.

## Functions

### `GPUContextState`

Represents the state of a GPU context with readonly properties:

- `adapter: GPUAdapter | null` - WebGPU adapter instance
- `device: GPUDevice | null` - WebGPU device instance
- `initialized: boolean` - Whether context is initialized
- `canvas: SupportedCanvas | null` - Canvas element (HTMLCanvasElement or OffscreenCanvas)
- `canvasContext: GPUCanvasContext | null` - WebGPU canvas context
- `preferredFormat: GPUTextureFormat | null` - Preferred canvas texture format
- `devicePixelRatio: number` - DPR used for canvas sizing
- `alphaMode: 'opaque' | 'premultiplied'` - Canvas alpha mode
- `powerPreference: 'low-power' | 'high-performance'` - GPU power preference

### `createGPUContext(canvas?: SupportedCanvas, options?: GPUContextOptions): GPUContextState`

Creates a new GPUContext state with initial values.

**Parameters:**
- `canvas` - Optional HTMLCanvasElement or OffscreenCanvas
- `options` - Optional configuration for DPR, alpha mode, and power preference

### `createGPUContextAsync(canvas?: SupportedCanvas, options?: GPUContextOptions): Promise<GPUContextState>`

Creates and initializes a GPU context in one step. Recommended for most use cases.

**Parameters:**
- `canvas` - Optional HTMLCanvasElement or OffscreenCanvas
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
- `canvas` - Optional HTMLCanvasElement or OffscreenCanvas
- `options` - Optional configuration for DPR, alpha mode, and power preference

### `GPUContext.create(canvas?: SupportedCanvas, options?: GPUContextOptions): Promise<GPUContext>`

Factory method that creates and initializes a GPUContext instance.

**Parameters:**
- `canvas` - Optional HTMLCanvasElement or OffscreenCanvas
- `options` - Optional configuration for DPR, alpha mode, and power preference

**Throws:** `Error` if initialization fails

### Properties

- `adapter: GPUAdapter | null` - WebGPU adapter instance, or `null` if not initialized
- `device: GPUDevice | null` - WebGPU device instance, or `null` if not initialized
- `initialized: boolean` - `true` if successfully initialized
- `canvas: SupportedCanvas | null` - Canvas element (HTMLCanvasElement or OffscreenCanvas), or `null` if not provided
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

## OffscreenCanvas and Web Worker Support

GPUContext supports `OffscreenCanvas` for rendering in Web Workers, enabling GPU operations off the main thread.

### Worker Rendering Limitations

OffscreenCanvas is **rendering-only**. Interactive features that require DOM access are not available in workers:

- ❌ Tooltips (requires DOM elements)
- ❌ Interactive zoom controls (requires DOM events)
- ❌ Legends, data zoom sliders (require DOM)
- ✅ Pure GPU rendering operations
- ✅ Data processing and animations

### Device Pixel Ratio Handling

**Note:** `GPUContext` is resilient to invalid or missing DPR values and will fall back to `1.0`.

**Critical (OffscreenCanvas):** avoid double-scaling. Choose one of these approaches:

1. **Send CSS-sized dimensions + DPR**: set `offscreenCanvas.width/height` to **CSS pixel** dimensions and pass the **real** DPR via `devicePixelRatio` so `GPUContext` scales to device pixels.
2. **Send device-sized dimensions**: set `offscreenCanvas.width/height` to **device pixel** dimensions (already multiplied by DPR) and pass `devicePixelRatio: 1.0`.

**Note:** `transferControlToOffscreen()` is **irreversible** - canvas becomes permanently offscreen.

### Worker Usage Pattern

See [examples/worker-rendering/](../../examples/) for complete working example (if available).

Main thread flow:

1. Create HTMLCanvasElement
2. Size the canvas and decide DPR strategy (see above)
3. Call `transferControlToOffscreen()`
4. Post OffscreenCanvas to worker via `postMessage()`

Worker thread flow:

1. Receive OffscreenCanvas via message event
2. Create GPUContext with `devicePixelRatio` matching your sizing strategy (often the main thread DPR, or `1.0` if the OffscreenCanvas was already device-scaled)
3. Initialize and render

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
- Workers: Pass explicit `devicePixelRatio: 1.0` if main thread already scaled the canvas
- Canvas is configured with preferred format (`getPreferredCanvasFormat()` with `'bgra8unorm'` fallback)

**Power Preference:**
- Use `'high-performance'` (default) for rendering-intensive visualizations
- Use `'low-power'` for battery-conscious applications or background rendering

**Alpha Mode:**
- Use `'opaque'` (default) for better performance when transparency is not needed
- Use `'premultiplied'` only when compositing transparent canvas with other page elements
