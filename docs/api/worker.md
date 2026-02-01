# Worker API

## Overview

The ChartGPU worker module provides a complete API for implementing GPU-accelerated chart rendering in Web Workers using OffscreenCanvas. This enables high-performance rendering without blocking the main thread, keeping your application responsive during intensive charting operations.

**Module:** `chartgpu/worker`

**Source:** [`src/worker/index.ts`](../../src/worker/index.ts), [`src/worker/createChartInWorker.ts`](../../src/worker/createChartInWorker.ts), [`src/worker/ChartGPUWorkerController.ts`](../../src/worker/ChartGPUWorkerController.ts)

**Related:** [Worker Communication Protocol](worker-protocol.md)

### Benefits

- **Main Thread Responsiveness:** GPU rendering runs in separate thread
- **Parallel Processing:** Chart computations don't compete with UI interactions
- **Zero-Copy Data Transfer:** ArrayBuffer and OffscreenCanvas transfer without cloning
- **Separation of Concerns:** GPU operations isolated from DOM manipulation

### Architecture

Worker mode splits responsibilities between threads:
- The **main thread** owns DOM (tooltip/legend/axis labels/dataZoom slider) and forwards input + sizing to the worker.
- The **worker thread** owns WebGPU rendering + hit testing using the transferred `OffscreenCanvas`.

For a full end-to-end diagram, see the architecture flowchart in [llm-context.md](llm-context.md#architecture-diagram) and the deeper [Worker Architecture](../internal/WORKER_ARCHITECTURE.md).

## Public API (Recommended)

The recommended way to create worker-based charts is via the high-level factory function or static method. These handle all worker setup, canvas transfer, and message coordination automatically.

**Source:** [`src/worker/createChartInWorker.ts`](../../src/worker/createChartInWorker.ts), [`src/worker/ChartGPUWorkerProxy.ts`](../../src/worker/ChartGPUWorkerProxy.ts)

### `createChartInWorker(container: HTMLElement, options: ChartGPUOptions, workerOrUrl?: Worker | string | URL): Promise<ChartGPUInstance>`

Factory function for creating worker-based chart instances with automatic setup.

**Parameters:**
- `container`: HTML element to attach canvas to (canvas will be created and appended automatically)
- `options`: Chart configuration (same as [`ChartGPU.create()`](chart.md#chartgpucreate))
- `workerOrUrl` (optional): Worker source - see [Worker Source Options](#worker-source-options)

**Returns:** Promise resolving to [`ChartGPUInstance`](chart.md#chartgpuinstance) proxy (same interface as main-thread charts)

**Throws:** `ChartGPUWorkerError` if:
- Container is invalid (not an HTMLElement)
- Worker creation or initialization fails
- Canvas creation or transfer fails
- Worker doesn't respond within 30s timeout

**Source:** [`src/worker/createChartInWorker.ts`](../../src/worker/createChartInWorker.ts)

### `ChartGPU.createInWorker(container: HTMLElement, options: ChartGPUOptions, workerOrUrl?: Worker | string | URL): Promise<ChartGPUInstance>`

Static method on `ChartGPU` namespace - **recommended entry point** for worker-based charts.

**Parameters:** Same as [`createChartInWorker()`](#createchartinworkercontainer-htmlelement-options-chartgpuoptions-workerorurl-worker--string--url-promisechartgpuinstance)

**Returns:** Same as [`createChartInWorker()`](#createchartinworkercontainer-htmlelement-options-chartgpuoptions-workerorurl-worker--string--url-promisechartgpuinstance)

**Note:** This is an alias for `createChartInWorker()` - identical behavior, more discoverable API.

**Source:** [`src/index.ts`](../../src/index.ts) exports `createChartInWorker` as `ChartGPU.createInWorker`

### Worker Source Options

The optional `workerOrUrl` parameter accepts three forms:

| Type | Behavior | Use Case |
|------|----------|----------|
| `undefined` | Use built-in worker (bundled) | Default - simplest option |
| `string \| URL` | Create worker from URL/path | Custom worker location or CDN |
| `Worker` | Use existing worker instance | Shared worker, pre-warmed worker |

**Built-in worker** (recommended):
- Worker bundled with library
- Automatically resolved by bundler
- No configuration needed

**Custom worker URL:**
- Provide path to custom worker script
- Must implement [ChartGPUWorkerController protocol](#chartgpuworkercontroller)
- Useful for CDN hosting or custom builds

**Existing worker instance:**
- Reuse worker across multiple charts
- Factory does NOT terminate worker on dispose (caller's responsibility)
- Useful for worker pooling

**Source:** [`createChartInWorker()` implementation](../../src/worker/createChartInWorker.ts)

## Zero-Copy Data Transfer

ChartGPU supports efficient zero-copy data transfer to worker threads using typed arrays with comprehensive buffer validation.

### Buffer Requirements

All typed array buffers must meet WebGPU alignment requirements:

**Alignment Requirements:**
- **4-byte alignment**: Buffer size must be divisible by 4 (WebGPU requirement)
- **Stride alignment**: `XY_STRIDE = 8 bytes`, `OHLC_STRIDE = 20 bytes` (both 4-byte aligned)
- **Size validation**: Buffer size must equal `pointCount × stride`

**Throws `ChartGPUWorkerError` with `INVALID_ARGUMENT` if:**
- Buffer size is not 4-byte aligned
- Array length is not a multiple of floats per point (2 for xy, 5 for ohlc)

**Source:** Buffer validation implemented in [ChartGPUWorkerProxy.ts](../../src/worker/ChartGPUWorkerProxy.ts)

### Transfer Semantics

ChartGPU optimizes buffer transfer based on typed array structure:

**Zero-Copy Transfer (optimal):**
- When: `typedArray.byteOffset === 0 && typedArray.byteLength === buffer.byteLength`
- Behavior: Entire buffer transferred without copying
- Performance: Fastest - no memory allocation or copy overhead

**Copy-Then-Transfer (subarray views):**
- When: Typed array is a view into a larger buffer (`byteOffset > 0` or partial view)
- Behavior: Buffer sliced before transfer to maintain data integrity
- Performance: Requires copy, but unavoidable for subarray safety
- Dev warning: Suggests using full buffer views for better performance

**Source:** Transfer optimization logic in [ChartGPUWorkerProxy.ts](../../src/worker/ChartGPUWorkerProxy.ts) lines 1101-1117

### Validation Behavior

ChartGPU validates buffers in development mode (`__DEV__`) to catch common errors:

**Detached Buffer Detection:**
- Checks: `buffer.byteLength === 0` before transfer
- Error: Console error with context message
- Recovery: Early return prevents worker communication failure

**Alignment Validation:**
- Checks: `byteLength % 4 === 0` (WebGPU requirement)
- Error: Throws `ChartGPUWorkerError` with fix suggestion
- Recovery: Fix buffer size to be 4-byte aligned

**Stride Validation:**
- Checks: `actualBytes === pointCount × stride`
- Warning: Console warning with expected vs actual sizes
- Recovery: Continues with warning (may cause rendering issues)

**Source:** Validation logic in [ChartGPUWorkerProxy.ts](../../src/worker/ChartGPUWorkerProxy.ts) lines 1067-1095

### Dev Mode Warnings

In development builds, ChartGPU emits helpful warnings:

**Large Tuple Array Warning:**
- Triggers: `array.length > 10,000` points using `DataPoint[]` form
- Suggests: Converting to `Float32Array` using `packDataPoints()` (except when your x-values are large **epoch-ms timestamps** and you require millisecond-level resolution—see note under `packDataPoints`)
- Benefit: ~50% memory reduction, eliminates serialization overhead

**Stride Mismatch Warning:**
- Triggers: Buffer size doesn't match expected `pointCount × stride`
- Message: Shows expected vs actual byte sizes
- Recovery: Continue with warning (may cause data corruption)

**Detached Buffer Warning:**
- Triggers: Attempting to transfer already-detached buffer
- Message: Explains buffer may have been transferred elsewhere
- Recovery: Early return prevents worker error

**Subarray Copy Warning:**
- Triggers: Typed array uses subarray view (`byteOffset > 0`)
- Message: Explains copy is required, suggests using full buffer
- Performance: Minor impact, but avoidable with proper buffer management

**Source:** Dev mode warnings in [ChartGPUWorkerProxy.ts](../../src/worker/ChartGPUWorkerProxy.ts)

### Typed Array API

For typed-array usage patterns (including zero-copy transfers and buffer detachment), see [`ChartGPUWorkerProxy.ts`](../../src/worker/ChartGPUWorkerProxy.ts) and the working examples in [`examples/worker-streaming/main.ts`](../../examples/worker-streaming/main.ts) and [`examples/worker-rendering/main.ts`](../../examples/worker-rendering/main.ts).

### Helper Functions

#### `packDataPoints(points: ReadonlyArray<DataPoint>): Float32Array`

Converts DataPoint array into interleaved Float32Array for zero-copy GPU/Worker transfer.

**Format:** `[x0, y0, x1, y1, ...]` (2 floats per point = 8 bytes stride)

**Timestamp precision note:** If your x-values are **epoch-millisecond** timestamps (\(~10^{12}\)) and you need millisecond-level resolution, pre-converting x-values to Float32 can quantize away fine-grained differences before ChartGPU’s internal GPU-precision rebasing can help. In that case, prefer sending `DataPoint[]` (numbers) or higher-precision sources so rebasing can be applied before Float32 conversion.

**Parameters:**
- `points`: Array of data points (tuple `[x, y]` or object `{ x, y }` form)

**Returns:** Float32Array with transferable `.buffer` property

**Buffer Limits:**
- Maximum points: 268,435,456 (2GB buffer limit)
- Empty arrays return empty Float32Array (valid)

**Throws:**
- `TypeError`: If points is null/undefined, not an array, or contains invalid point types
- `RangeError`: If array exceeds maximum size or contains invalid numeric values

**Use cases:**
- Direct GPU buffer uploads via `queue.writeBuffer()`
- Zero-copy transfer to workers via `postMessage([packed.buffer])`

**Source:** [packDataPoints.ts](../../src/data/packDataPoints.ts)

#### `packOHLCDataPoints(points: ReadonlyArray<OHLCDataPoint>): Float32Array`

Converts OHLCDataPoint array into interleaved Float32Array for candlestick chart rendering.

**Format:** `[t0, o0, h0, l0, c0, t1, o1, h1, l1, c1, ...]` (5 floats per point = 20 bytes stride)

**Order:** Timestamp, Open, High, Low, Close (follows ECharts convention)

**Parameters:**
- `points`: Array of OHLC data (tuple `[timestamp, open, close, low, high]` or object form)

**Returns:** Float32Array with transferable `.buffer` property

**Buffer Limits:**
- Maximum points: 107,374,182 (2GB buffer limit)
- Empty arrays return empty Float32Array (valid)

**Throws:**
- `TypeError`: If points is null/undefined, not an array, or tuple doesn't have exactly 5 elements
- `RangeError`: If array exceeds maximum size or contains invalid numeric values

**Security:** Input validation prevents buffer overflow attacks and resource exhaustion

**Source:** [packDataPoints.ts](../../src/data/packDataPoints.ts)

**Examples:**
- Regular data points: [worker-streaming](../../examples/worker-streaming/main.ts)
- Worker convenience API: [worker-convenience](../../examples/worker-convenience/main.ts)

### Performance Characteristics

| Data Format | Memory | Transfer | Best For |
|-------------|--------|----------|----------|
| `DataPoint[]` | Copied | ~8-12% overhead | Small datasets (<10K points), convenience |
| `Float32Array` | Transferred | Zero-copy | Large datasets (>10K points), streaming |
| `Float64Array` | Converted to Float32 | Minimal overhead | High-precision sources |

### Transfer vs Copy Behavior

- **ArrayBuffer**: Transferable ✓ - ownership moves to worker
- **Float32Array**: Transfer `.buffer` ✓ - array becomes detached
- **Array<[number, number]>**: Must be converted (copied) - use `packDataPoints`
- **{ x: Float32Array, y: Float32Array }**: Transfer both buffers ✓ - not yet supported

**Important:** After transferring a typed array, it becomes detached and unusable in the main thread. Use `.slice()` to keep a copy if needed.

**Implementation Details:** [ChartGPUWorkerProxy.ts](../../src/worker/ChartGPUWorkerProxy.ts)

## Interaction Support in Worker Mode

### Overview

Worker-based charts support full interaction capabilities including tooltips, hover highlighting, click events, and crosshairs. The implementation uses a coordinate calculation system that bridges the main thread (DOM access) and worker thread (GPU rendering and hit-testing).

### Tooltip Behavior

**Main-thread charts:**
- Tooltip hit-testing performed on main thread
- Canvas coordinates calculated using `getBoundingClientRect()`
- Grid coordinates calculated by subtracting grid offsets
- Hit-testing uses `interactionScales` to map grid→domain coordinates

**Worker-thread charts:**
- Tooltip hit-testing performed in worker thread
- **Main thread computes grid coordinates** using `computePointerEventData()`
- Grid coordinates sent to worker via `ForwardPointerEventMessage`
- Worker uses pre-computed grid coordinates with `interactionScales` for hit-testing
- Worker emits `TooltipUpdateMessage` with complete tooltip content and position
- Main thread renders tooltip to DOM (RAF-batched)

**Key difference:** Grid coordinate calculation happens on main thread for worker charts (OffscreenCanvas lacks `getBoundingClientRect()`), but hit-testing still happens in worker thread.

### Coordinate Calculation Differences

**Challenge:** OffscreenCanvas does not have DOM-specific properties:
- No `getBoundingClientRect()` method (returns canvas position)
- No `offsetLeft` or `offsetTop` properties
- No access to canvas container element

**Solution:** Split coordinate calculation across threads:

**Main thread** ([`ChartGPUWorkerProxy.computePointerEventData()`](../../src/worker/ChartGPUWorkerProxy.ts)):
1. Get canvas position using `canvas.getBoundingClientRect()`
2. Calculate canvas-local coordinates: `offsetX = clientX - rect.left`
3. Calculate grid-local coordinates: `gridX = offsetX - grid.left`
4. Determine if pointer is in grid region: `isInGrid = gridX >= 0 && gridX <= gridWidth`
5. Create `PointerEventData` with all coordinate systems
6. Forward to worker via `ForwardPointerEventMessage`

**Worker thread** ([`ChartGPUWorkerController`](../../src/worker/ChartGPUWorkerController.ts)):
1. Receive `PointerEventData` with pre-computed grid coordinates
2. Pass to `coordinator.handlePointerEvent(eventData)`
3. Coordinator uses `eventData.gridX` and `eventData.gridY` directly
4. `computeInteractionScalesGridCssPx()` creates scales for grid→domain mapping
5. Hit-testing functions use `interactionScales.x.invert(gridX)` to get domain coordinates
6. Emit `TooltipUpdateMessage` with complete tooltip content and position

### OffscreenCanvas Coordinate Handling

Worker-mode layout depends on the main thread providing an up-to-date device pixel ratio (DPR) to the worker. If you implement the worker protocol directly, ensure you send `devicePixelRatio` with initialization and keep it current as the page DPR changes (otherwise CSS-pixel layout such as axis labels/titles and overlays can drift). See protocol types in [`protocol.ts`](../../src/worker/protocol.ts) and DPR monitoring in [`ChartGPUWorkerProxy.ts`](../../src/worker/ChartGPUWorkerProxy.ts).

**Problem:** OffscreenCanvas dimensions are in device pixels, but tooltip coordinates must be in CSS pixels (matching DOM coordinate system).

**Solution implemented in `getPlotSizeCssPx()`:**
OffscreenCanvas uses device-pixel dimensions; ChartGPU converts to CSS pixels by dividing by the current DPR so layout matches DOM coordinate systems.

**Key insight:** Dividing device pixels by DPR converts to CSS pixels, which match the DOM coordinate system used by pointer events.

**Updated `computeInteractionScalesGridCssPx()`:**
- No longer checks `isHTMLCanvasElement(canvas)` (blocked worker mode)
- Uses `getPlotSizeCssPx()` to get CSS dimensions for both canvas types
- Creates linear scales mapping domain→grid coordinates
- Returns valid scales for OffscreenCanvas (previously returned `null`, breaking tooltips)

**Source:** [`src/core/createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts)

### Common Interaction Issues

**Symptom:** Tooltips don't appear in worker mode.

**Diagnosis:**
1. Check if `interactionScales` is `null` in worker (coordinate calculation failure)
2. Verify `PointerEventData` includes valid `gridX`, `gridY` fields
3. Confirm `isInGrid` is `true` for events over plot area
4. Check `isInitialized` flag (events may be dropped before worker is ready)

**Fix:**
- Ensure `ForwardPointerEventMessage` uses `computePointerEventData()`
- Wait for `ReadyMessage` before forwarding events (`isInitialized = true`)
- Verify grid area is correctly configured (non-negative dimensions)

**Symptom:** Tooltip coordinates are incorrect (positioned far from cursor).

**Diagnosis:**
- Grid coordinate calculation may be using wrong offsets
- Device pixel ratio may not be accounted for
- Canvas dimensions may be stale (resize not yet processed)

**Fix:**
- Verify `computePointerEventData()` uses `canvas.getBoundingClientRect()`
- Ensure grid area matches cached options
- Check that resize messages are RAF-batched and processed correctly

### Event Forwarding Best Practices

**1. Wait for initialization:**
Drop or defer events until the worker has sent `ready` (the proxy tracks an initialized/ready state).

**2. RAF-throttle pointermove events:**
Throttle high-rate pointermove forwarding to avoid flooding the worker message queue.

**3. Compute grid coordinates on main thread:**
Compute `PointerEventData` on the main thread (including grid-local coordinates) and forward it via `forwardPointerEvent`.

**4. RAF-batch tooltip rendering:**
Batch DOM tooltip updates on animation frames to avoid layout thrash during rapid hover updates.

**Source:** [`ChartGPUWorkerProxy.ts`](../../src/worker/ChartGPUWorkerProxy.ts)

### Debugging Interaction Issues

**Enable debug logging:**
- Log `PointerEventData` in main thread before forwarding
- Log received `PointerEventData` in worker thread
- Log `interactionScales` in worker (should not be `null`)
- Log hit-testing results (matches, nearest points)
- Log emitted `TooltipUpdateMessage` content and position

**Check coordinate systems:**
- Verify client → canvas transformation uses `getBoundingClientRect()`
- Verify canvas → grid transformation subtracts correct grid offsets
- Verify grid → domain transformation uses `interactionScales.x.invert()`

**Inspect message flow:**
- Use browser DevTools to inspect postMessage traffic
- Verify `ForwardPointerEventMessage` includes grid coordinates
- Verify `TooltipUpdateMessage` is emitted with content
- Check for message correlation errors (timeout, missing messageId)

### Related Documentation

- [Worker Architecture - Tooltip and Interaction Support](../internal/WORKER_ARCHITECTURE.md#tooltip-and-interaction-support) - Complete technical details
- [Worker Protocol - forwardPointerEvent](worker-protocol.md#forwardpointerevent) - PointerEventData specification
- [Worker Protocol - tooltipUpdate](worker-protocol.md#tooltipupdate) - TooltipUpdateMessage specification
- [Worker Thread Integration Guide](../internal/WORKER_THREAD_INTEGRATION.md) - Implementation checklist

### When to Use Worker-Based Charts

Choose worker-based rendering when:

**✅ Use Workers When:**
- Large datasets (>10K points) with frequent updates
- Real-time streaming data with high update rates
- Complex multi-series charts (>10 series)
- Application needs to remain responsive during chart updates
- Main thread is busy with other UI operations
- Mobile/low-power devices (offload work from main thread)

**❌ Use Main Thread When:**
- Small datasets (<1K points)
- Static or infrequently updated charts
- Simple single-series charts
- Worker overhead outweighs benefits
- Debugging or development (easier stack traces)
- Browser doesn't support OffscreenCanvas (Safari < 16.4, Firefox < 105)

**Performance Tradeoff:**
- Worker setup overhead: ~50-100ms (one-time)
- Message passing overhead: ~0.1-1ms per update
- Main thread blocking eliminated: priceless for large datasets

**Source:** See [Performance Documentation](../performance.md) for benchmarks

### `ChartGPUWorkerProxy`

Main-thread proxy class implementing `ChartGPUInstance` interface. Returned by `createChartInWorker()`.

**Interface:** Identical to [`ChartGPUInstance`](chart.md#chartgpuinstance) - use same methods and events

**Implementation Details:**
- **State Cache:** Maintains local copies of options, disposed, interactionX, zoomRange for synchronous getters
- **Message Correlation:** Unique message IDs track request/response pairs with 30s timeout
- **Event System:** Re-emits worker events (`click`, `mouseover`, `mouseout`, `crosshairMove`) to registered listeners
- **DOM Overlays:** Manages tooltip, legend, axis labels, and data zoom slider in main thread
- **Layout (dataZoom slider):** when `dataZoom` includes a slider (`{ type: 'slider' }`), ChartGPU reserves additional bottom plot space so x-axis tick labels remain visible and the x-axis title is centered within the remaining space above the slider track (instead of being obscured by the overlay). This is especially important in worker mode where the main thread renders overlays while the worker renders the chart. See [`OptionResolver.ts`](../../src/config/OptionResolver.ts) and the x-axis/overlay layout logic in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) (see also [Data Zoom Configuration](options.md#data-zoom-configuration)).
- **Auto Resize:** Monitors container size and device pixel ratio changes, auto-resizes canvas
- **Event Forwarding:** Captures pointer and wheel events, forwards to worker for interaction handling
- **Performance Metrics:** Receives performance metrics from worker thread and caches them locally; forwards performance update events to subscribers

### Performance Monitoring in Worker Mode

The performance metrics API works identically in worker mode:

**`getPerformanceMetrics(): Readonly<PerformanceMetrics> | null`**

Returns cached performance metrics that were most recently forwarded from the worker thread. The proxy maintains a local cache of the latest metrics, so this method is synchronous and does not require postMessage communication.

**`getPerformanceCapabilities(): Readonly<PerformanceCapabilities> | null`**

Returns performance capabilities that were sent by the worker during initialization (in the `ready` message). The proxy caches capabilities locally for synchronous access.

**`onPerformanceUpdate(callback: (metrics: Readonly<PerformanceMetrics>) => void): () => void`**

Subscribes to performance updates from the worker thread. The worker sends `performanceUpdate` messages on every render frame (up to 60fps), and the proxy re-emits these as events to registered callbacks.

**Performance Message Flow:**
Worker mode performance updates are streamed from the worker to the proxy:
- On init, the worker sends `ready` with `PerformanceCapabilities` (cached by the proxy).
- During rendering, the worker sends `performanceUpdate` messages (cached and re-emitted by the proxy).

**Implementation notes:**
- Performance metrics are tracked in the worker thread by RenderScheduler
- Metrics are sent from worker to main thread via `performanceUpdate` protocol message
- Proxy caches the latest metrics for synchronous `getPerformanceMetrics()` access
- No additional message overhead for subscriptions (updates stream automatically)

For protocol message details, see [Worker Protocol - Performance Updates](worker-protocol.md#performanceupdate).

For a complete usage example, see [`examples/worker-rendering/main.ts`](../../examples/worker-rendering/main.ts).

**Lifecycle:**
1. Constructor creates proxy with cached state
2. `init()` creates canvas, transfers to worker, waits for ready message
3. Methods send messages to worker, update local cache
4. `dispose()` cleans up overlays, terminates worker (if created by factory), removes canvas

**Source:** [`src/worker/ChartGPUWorkerProxy.ts`](../../src/worker/ChartGPUWorkerProxy.ts)

**Note:** Users don't typically construct this directly - use `createChartInWorker()` instead.

### Types

#### `WorkerConfig`

Configuration for `ChartGPUWorkerProxy` constructor (used internally by factory).

**Fields:**
- `worker: Worker`: Web Worker instance for rendering
- `chartId?: string`: Unique chart identifier (auto-generated if omitted)
- `messageTimeout?: number`: Timeout for async operations in ms (default: 30000)
- `gpuOptions?: { powerPreference?: 'low-power' | 'high-performance'; requiredFeatures?: ReadonlyArray<string> }`: WebGPU adapter options (optional)

**Source:** [`src/worker/types.ts`](../../src/worker/types.ts)

#### `ChartGPUWorkerError`

Error class for worker operations. Extends native `Error` with categorized error codes.

**Properties:**
- `code: string`: Error category code (see table below)
- `operation: string`: Operation that failed
- `chartId?: string`: Chart ID if available

**Error Codes:**
| Code | Description | Recovery |
|------|-------------|----------|
| `INVALID_ARGUMENT` | Invalid function argument | Fix call site |
| `WEBGPU_INIT_FAILED` | WebGPU/worker initialization failed | Check browser support |
| `DISPOSED` | Operation on disposed chart | Don't call after dispose |
| `TIMEOUT` | Operation timeout (30s default) | Check worker responsiveness |
| `COMMUNICATION_ERROR` | postMessage failed | Check message structure |
| `UNKNOWN` | Unclassified error | Log and report |

**Source:** [`src/worker/types.ts`](../../src/worker/types.ts)

## Low-Level API (Advanced)

The following sections document the low-level worker controller and protocol for advanced use cases. Most users should use the [Public API](#public-api-recommended) instead.

### When to Use Low-Level API

Use the low-level worker controller when:
- Implementing custom worker communication patterns
- Integrating with existing worker infrastructure
- Building abstractions on top of ChartGPU
- Fine-grained control over message flow

For standard use cases, prefer the [high-level factory function](#createchartinworker).

## Quick Start (Low-Level)

### Worker Setup

**Worker entry point** (`worker.ts`):
Create a [`ChartGPUWorkerController`](../../src/worker/ChartGPUWorkerController.ts), forward its outbound messages to the main thread, and pass inbound messages to `handleMessage(...)`. For a concrete implementation, see [`worker-entry.ts`](../../src/worker/worker-entry.ts) and the [Worker Thread Integration](../internal/WORKER_THREAD_INTEGRATION.md) guide.

### Main Thread Setup

**Main thread** (`main.ts`):
Create a `Worker`, transfer an `OffscreenCanvas`, and send an [`InitMessage`](../../src/worker/protocol.ts) including the current `devicePixelRatio`. Then handle outbound messages to render DOM overlays (tooltip/legend/axis labels/slider) and re-emit chart events. For a working reference, see [`examples/worker-rendering/main.ts`](../../examples/worker-rendering/main.ts) and [`examples/worker-convenience/main.ts`](../../examples/worker-convenience/main.ts).

**Source:** See complete implementation guide in [Worker Thread Integration](../internal/WORKER_THREAD_INTEGRATION.md)

## ChartGPUWorkerController

Main controller class for managing chart instances in a Web Worker. Handles message routing, GPU context initialization, and resource lifecycle.

**Source:** [`src/worker/ChartGPUWorkerController.ts`](../../src/worker/ChartGPUWorkerController.ts)

### `new ChartGPUWorkerController()`

Creates a new worker controller instance. Typically instantiated once per worker.

**Returns:** `ChartGPUWorkerController` instance

**Note:** Controller can manage multiple chart instances (identified by `chartId`).

### Instance Methods

#### `onMessage(handler: (msg: WorkerOutboundMessage) => void): void`

Registers a callback to receive outbound messages for sending to the main thread.

**Parameters:**
- `handler`: Function called when controller emits messages to main thread

**When to call:** Immediately after constructing the controller, before processing any messages

**Source:** See [`WorkerOutboundMessage`](worker-protocol.md#outbound-messages-worker--main) for all message types

#### `async handleMessage(msg: WorkerInboundMessage): Promise<void>`

Main entry point for processing inbound messages from the main thread.

**Parameters:**
- `msg`: Inbound message from main thread

**Returns:** Promise that resolves when message processing completes

**Error Handling:** Catches all errors and emits `error` message to main thread. Safe to call without try/catch.

**Message Types:** See [`WorkerInboundMessage`](worker-protocol.md#inbound-messages-main--worker) for all supported messages

**Source:** [`ChartGPUWorkerController.handleMessage()`](../../src/worker/ChartGPUWorkerController.ts)

#### `dispose(): void`

Disposes all chart instances and cleans up controller resources.

**When to call:** Before terminating the worker (in response to worker shutdown signal)

**Effects:**
- Disposes all active chart instances
- Destroys GPU contexts
- Cleans up render loops
- Removes message handler

**Note:** After calling `dispose()`, do not send additional messages to the worker.

**Source:** [`ChartGPUWorkerController.dispose()`](../../src/worker/ChartGPUWorkerController.ts)

### Lifecycle

At a high level:
- **Initialization**: main thread sends `init` and waits for `ready`.
- **Operation**: main thread sends updates (`setOption`, `appendData`, `resize`, `forwardPointerEvent`, etc.) and receives outbound messages (`rendered`, `tooltipUpdate`, `axisLabelsUpdate`, events, and more).
- **Cleanup**: main thread sends `dispose` (and/or calls controller `dispose()` when shutting down the worker) and waits for `disposed`.

See the message types in [`protocol.ts`](../../src/worker/protocol.ts) and the controller implementation in [`ChartGPUWorkerController.ts`](../../src/worker/ChartGPUWorkerController.ts).

## Protocol Types

All message types are exported from `chartgpu/worker` for type safety in both main and worker threads.

### Inbound Messages (Main → Worker)

Messages sent from main thread to worker thread:

| Type | Description | Documentation |
|------|-------------|---------------|
| `InitMessage` | Initialize chart with OffscreenCanvas | [init](worker-protocol.md#init) |
| `SetOptionMessage` | Update chart configuration | [setOption](worker-protocol.md#setoption) |
| `AppendDataMessage` | Append data to single series | [appendData](worker-protocol.md#appenddata) |
| `AppendDataBatchMessage` | Batch append to multiple series | [appendDataBatch](worker-protocol.md#appenddatabatch) |
| `ResizeMessage` | Update canvas dimensions | [resize](worker-protocol.md#resize) |
| `ForwardPointerEventMessage` | Forward pointer interaction | [forwardPointerEvent](worker-protocol.md#forwardpointerevent) |
| `SetZoomRangeMessage` | Set zoom window programmatically | [setZoomRange](worker-protocol.md#setzoomrange) |
| `SetInteractionXMessage` | Set crosshair position | [setInteractionX](worker-protocol.md#setinteractionx) |
| `SetAnimationMessage` | Configure animation | [setAnimation](worker-protocol.md#setanimation) |
| `DisposeMessage` | Clean up chart resources | [dispose](worker-protocol.md#dispose) |

**Union Type:** `WorkerInboundMessage` (discriminated union of all inbound message types)

**Source:** [`src/worker/protocol.ts`](../../src/worker/protocol.ts)

### Outbound Messages (Worker → Main)

Messages emitted by worker thread:

| Type | Description | Documentation |
|------|-------------|---------------|
| `ReadyMessage` | Initialization complete | [ready](worker-protocol.md#ready) |
| `RenderedMessage` | Frame render complete | [rendered](worker-protocol.md#rendered) |
| `TooltipUpdateMessage` | Tooltip data changed | [tooltipUpdate](worker-protocol.md#tooltipupdate) |
| `LegendUpdateMessage` | Legend items changed | [legendUpdate](worker-protocol.md#legendupdate) |
| `AxisLabelsUpdateMessage` | Axis labels changed | [axisLabelsUpdate](worker-protocol.md#axislabelsupdate) |
| `HoverChangeMessage` | Hover state changed | [hoverChange](worker-protocol.md#hoverchange) |
| `ClickMessage` | Click detected on data point | [click](worker-protocol.md#click) |
| `CrosshairMoveMessage` | Crosshair position changed | [crosshairMove](worker-protocol.md#crosshairmove) |
| `ZoomChangeMessage` | Zoom range changed | [zoomChange](worker-protocol.md#zoomchange) |
| `DeviceLostMessage` | GPU device lost | [deviceLost](worker-protocol.md#devicelost) |
| `DisposedMessage` | Disposal complete | [disposed](worker-protocol.md#disposed) |
| `ErrorMessage` | Operation failed | [error](worker-protocol.md#error) |

**Union Type:** `WorkerOutboundMessage` (discriminated union of all outbound message types)

**Source:** [`src/worker/protocol.ts`](../../src/worker/protocol.ts)

### Event Payload

**Type:** `WorkerEventPayload`

Worker event data for hover and click events. Cannot include native `PointerEvent` (not cloneable for postMessage).

**Fields:**
- `seriesIndex: number`: Index of the series
- `dataIndex: number`: Index of the data point within the series
- `value: readonly [number, number] | readonly [number, number, number, number, number]`: Data point value (DataPoint or OHLCDataPoint)
- `x: number`: CSS pixel x coordinate
- `y: number`: CSS pixel y coordinate

**Source:** [`src/worker/protocol.ts`](../../src/worker/protocol.ts)

## Utility Functions

### `getTransferables(msg: WorkerInboundMessage): readonly Transferable[]`

Extracts transferable objects from an inbound message for efficient postMessage.

**Parameters:**
- `msg`: Inbound message to extract transferables from

**Returns:** Array of objects that should be transferred (zero-copy) rather than cloned

**Transferable Types:**
- `OffscreenCanvas`: Graphics rendering context (from `init`)
- `ArrayBuffer`: Binary data buffers (from `appendData`, `appendDataBatch`)

**Usage:** Call with message before posting: `worker.postMessage(msg, getTransferables(msg))`

**Performance:** Transferring objects is zero-copy and much faster than cloning for large buffers.

**Important:** Transferred objects become unusable in the sender thread. Clone data if sender needs to retain it.

**Source:** [`src/worker/protocol.ts`](../../src/worker/protocol.ts)

## Re-exported Types

The worker module re-exports commonly used types from the main library for convenience:

| Type | Description | Source |
|------|-------------|--------|
| `ChartGPUOptions` | Chart configuration options | [`src/config/types.ts`](../../src/config/types.ts) |
| `AnimationConfig` | Animation configuration | [`src/config/types.ts`](../../src/config/types.ts) |
| `PointerEventData` | Pre-computed pointer event data | [`src/config/types.ts`](../../src/config/types.ts) |
| `TooltipData` | Tooltip content and position | [`src/config/types.ts`](../../src/config/types.ts) |
| `LegendItem` | Legend entry data | [`src/config/types.ts`](../../src/config/types.ts) |
| `AxisLabel` | Axis tick label data | [`src/config/types.ts`](../../src/config/types.ts) |

**Usage:** Import directly from `chartgpu/worker` instead of main library.

## Error Handling

The worker controller provides comprehensive error handling with categorized error codes.

### Error Codes

| Code | Description | Recovery Strategy |
|------|-------------|------------------|
| `WEBGPU_INIT_FAILED` | WebGPU initialization failed | Check browser support, show fallback UI |
| `DEVICE_LOST` | GPU device lost during operation | Terminate and recreate worker |
| `RENDER_ERROR` | Error during render pass | Log error, check GPU state, consider restart |
| `DATA_ERROR` | Invalid data format or buffer | Validate data format, check stride values |
| `UNKNOWN` | Unclassified error | Log error, consider worker restart |

**Source:** See [`ErrorMessage`](worker-protocol.md#error) for error message format

### Device Loss

GPU devices can be lost due to driver crashes, timeouts, or system events:

1. Worker emits `deviceLost` message with reason
2. Worker becomes non-functional (cannot render)
3. Main thread should terminate worker and recreate if needed
4. **Do not** send `dispose` message after `deviceLost` (automatic cleanup)

**Source:** [Worker Protocol - Device Loss](worker-protocol.md#device-loss-handling)

## Performance Considerations

The worker controller includes several performance optimizations:

### Shared State Closures

Chart state is captured in coordinator callbacks to eliminate Map lookups in hot paths (60fps render loop).

### Cached Render Loop

Render callback caches coordinator references to avoid lookups on every frame.

### Optimized Deserialization

Data deserialization uses pre-allocated arrays and unrolled loops for streaming performance.

### Zero-Copy Transfers

ArrayBuffers are transferred (not cloned) via postMessage, eliminating serialization overhead for large datasets.

### Batch Operations

`appendDataBatch` validates all items upfront and defers render until all appends complete.

**Source:** See [`ChartGPUWorkerController` implementation](../../src/worker/ChartGPUWorkerController.ts) for detailed comments

## Multi-Chart Support

A single worker controller can manage multiple chart instances:

**Pattern:**
- Each chart has unique `chartId` string
- All messages include `chartId` for routing
- Worker maintains separate GPU context per chart
- Independent render loops per chart

**Usage:**
Use a distinct `chartId` per chart instance; all messages include `chartId` and the controller routes them accordingly. See the inbound/outbound message definitions in [`protocol.ts`](../../src/worker/protocol.ts) and routing in [`ChartGPUWorkerController.ts`](../../src/worker/ChartGPUWorkerController.ts).

**Note:** Multiple charts share worker thread CPU time. For optimal performance, limit to 2-4 charts per worker.

## Related Documentation

- [Worker Communication Protocol](worker-protocol.md) - Detailed message format specifications
- [Worker Thread Integration Guide](../internal/WORKER_THREAD_INTEGRATION.md) - Complete implementation guide
- [RenderCoordinator](INTERNALS.md#worker-thread-support--dom-overlay-separation) - Internal coordinator implementation
- [PointerEventData](interaction.md#pointereventdata) - Pointer event format
- [Event Handling](interaction.md#event-handling) - Chart interaction events
- [Chart Options](options.md) - Configuration reference

## Summary

The ChartGPU worker API provides a complete, type-safe interface for implementing worker-based chart rendering:

- **`ChartGPUWorkerController`**: Main controller class for managing chart instances
- **Protocol Types**: Type-safe message definitions for main ↔ worker communication
- **Utilities**: Helper functions like `getTransferables()` for efficient data transfer
- **Performance**: Zero-copy transfers, cached lookups, optimized deserialization
- **Multi-Chart**: Single worker can manage multiple chart instances
- **Error Handling**: Comprehensive error categorization with recovery strategies

For protocol message specifications, see [Worker Communication Protocol](worker-protocol.md).

For implementation examples and best practices, see the [Worker Thread Integration Guide](../internal/WORKER_THREAD_INTEGRATION.md).
