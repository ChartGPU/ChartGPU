# GPU Context

## Functional API (Preferred)

The functional API provides a type-safe, immutable approach to managing WebGPU contexts.

See [GPUContext.ts](../../src/core/GPUContext.ts) for the complete implementation.

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

See [GPUContext.ts](../../src/core/GPUContext.ts) for implementation.

### `destroyGPUContext(context: GPUContextState): GPUContextState`

Destroys the WebGPU device and cleans up resources. Returns a new state object with reset values.

## Class-Based API (Backward Compatibility)

The `GPUContext` class provides a class-based interface that internally uses the functional implementation.

See [GPUContext.ts](../../src/core/GPUContext.ts) for the complete implementation.

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
