# RenderScheduler (Render-on-demand)

Manages a render loop with render-on-demand pattern for optimal CPU efficiency. Renders only when explicitly requested via `requestRender()`, dropping to 0% CPU usage when idle.

See [RenderScheduler.ts](../../src/core/RenderScheduler.ts) for the complete implementation.

**For most users:** ChartGPU handles render scheduling automatically via its internal `RenderCoordinator`. You typically don't need to interact with `RenderScheduler` directly unless building custom rendering systems.

## Functional API (Preferred)

### `createRenderScheduler(): RenderSchedulerState`

Creates a new scheduler state with initial values.

### `startRenderScheduler(state: RenderSchedulerState, callback: RenderCallback): RenderSchedulerState`

Starts the render loop with the provided callback. Returns new state with `running: true`.

**Throws:** `Error` if callback not provided, scheduler already running, or state is invalid

### `requestRender(state: RenderSchedulerState): void`

Requests a render on the next frame. This is the primary way to trigger rendering.

**Key behaviors:**
- **Coalescing**: Multiple `requestRender()` calls before the next frame coalesce into a single render
- **Idle efficiency**: When no renders are requested, the scheduler remains idle with 0% CPU usage
- **Frame scheduling**: Schedules a `requestAnimationFrame` only when idle
- **Callback-triggered renders**: If the render callback calls `requestRender()` during execution, another frame is automatically scheduled (useful for animations)

**Throws:** `Error` if state is invalid

### `stopRenderScheduler(state: RenderSchedulerState): RenderSchedulerState`

Stops the render loop and cancels pending frames. Returns new state with `running: false`.

**Throws:** `Error` if state is invalid

### `destroyRenderScheduler(state: RenderSchedulerState): RenderSchedulerState`

Destroys the scheduler and cleans up internal resources. Returns new state with reset values.

**Important:** Always call this when done with a scheduler to prevent memory leaks.

### `createRenderSchedulerAsync(callback: RenderCallback): RenderSchedulerState`

Convenience function that creates and starts a scheduler in one step.

**Throws:** `Error` if callback not provided

## Class-Based API (Backward Compatibility)

### `RenderScheduler`

Class wrapper that internally uses the functional implementation.

**Properties:**
- `running: boolean` - Returns `true` if scheduler is running

**Methods:**
- `start(callback: RenderCallback): void` - Starts the render loop
- `stop(): void` - Stops the render loop
- `requestRender(): void` - Requests a render (coalesces into single frame)
- `destroy(): void` - Cleans up resources

## `RenderCallback`

Callback function type that receives delta time in milliseconds since the last frame.

**Delta time behavior:** After idle periods, delta time is capped to 100ms to prevent animation jumps.

## Type Definitions

All WebGPU types are provided by `@webgpu/types`. See [GPUContext.ts](../../src/core/GPUContext.ts) and [RenderScheduler.ts](../../src/core/RenderScheduler.ts) for type usage.
