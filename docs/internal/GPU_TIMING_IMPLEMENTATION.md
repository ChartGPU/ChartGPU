# GPU Timing Implementation

## Overview

GPU timing is part of ChartGPU's comprehensive performance metrics system. It helps distinguish CPU-bound vs GPU-bound frame time in real-time applications and benchmarks.

**Related systems:**
- **Performance Metrics API:** `getPerformanceMetrics()`, `getPerformanceCapabilities()`, `onPerformanceUpdate()` on `ChartGPUInstance`
- **Exact FPS measurement:** Circular buffer-based FPS calculation (120 frames = 2 seconds at 60fps)
- **Frame time statistics:** Min, max, average, p50, p95, p99 percentiles
- **Memory tracking:** GPU buffer allocation monitoring
- **Frame drop detection:** Tracks consecutive drops and timestamps

See [`src/config/types.ts`](../../src/config/types.ts) for `PerformanceMetrics` and `PerformanceCapabilities` type definitions.

See:
- [`examples/million-points/main.ts`](../examples/million-points/main.ts) (stats collection)
- [`examples/million-points/index.html`](../examples/million-points/index.html) (readout UI)

## Decision: Option A (`queue.onSubmittedWorkDone()`)

**Selected Approach**: `queue.onSubmittedWorkDone()` for GPU timing

**Rationale**:
- ✅ **Minimal invasiveness**: Only adds a promise callback after `queue.submit()`
- ✅ **Cross-browser reliable**: Works everywhere WebGPU is available (no feature flags required)
- ✅ **Non-blocking**: Does not stall the GPU pipeline
- ✅ **Useful metric**: Measures end-to-end GPU completion time (submit → GPU done)

**Alternative Considered**: Timestamp queries (`timestamp-query` feature)
- ❌ Requires feature flag (not universally available)
- ❌ More complex implementation (requires query buffer management and async readback)
- ❌ More invasive (requires modifying render pass)
- ✅ Would provide true GPU pass timing (more precise)

## Implementation Details

GPU time is sampled via `GPUDevice.queue.onSubmittedWorkDone()` after each `RenderCoordinator.render()` call in the benchmark loop.

### What It Measures

**GPU Time** (`gpuMs`):
- **Start**: When `queue.submit()` completes (CPU-side)
- **End**: When all GPU work submitted before the call has finished executing
- **Includes**: 
  - GPU command execution time
  - GPU queue latency
  - GPU-CPU synchronization overhead

**CPU Submit Time** (`renderMs`):
- **Start**: Before `RenderCoordinator.render()` call
- **End**: After `RenderCoordinator.render()` returns (includes `queue.submit()`)
- **Includes**: 
  - CPU-side render coordinator work
  - GPU command encoding
  - `queue.submit()` call (synchronous, blocks until queued)

### Performance Impact

**Minimal overhead**:
- Promise creation: small per-sample overhead
- Promise resolution: async callback (doesn't block render loop)
- DOM updates: Throttled to 250ms intervals (already implemented)

**Sampling strategy** (benchmark):
- Rolling average computed over a short window
- Readouts updated at a throttled interval to prevent UI jitter

### Interpreting the Stats

**FPS**: Frame rate (target: 60 FPS = 16.67ms per frame)

**CPU submit (ms)**: Time spent in `coordinator.render()` including:
- Data sampling/recomputation
- Buffer updates
- Renderer preparations
- GPU command encoding
- `queue.submit()` call

**GPU time (ms)**: Time from submit completion to GPU work completion:
- If GPU time > CPU submit time: GPU is the bottleneck
- If GPU time < CPU submit time: CPU is the bottleneck
- If GPU time ≈ frame time: GPU is fully utilized

### Cross-Browser Compatibility

**Supported browsers**:
- Chrome/Edge 113+ ✅
- Safari 18+ ✅
- Firefox (WebGPU not yet supported) ❌

**No feature flags required**: `queue.onSubmittedWorkDone()` is part of the core WebGPU API.

## Integration with Performance Metrics System

GPU timing is integrated into the broader performance metrics system:

**In main thread mode:**
- GPU timing tracked via `queue.onSubmittedWorkDone()` in render loop
- Metrics calculated by `RenderScheduler` with circular buffer timestamps
- Exposed via `chartInstance.getPerformanceMetrics()`
- Updates streamed via `chartInstance.onPerformanceUpdate(callback)`

**Enabling GPU timing:**
- Enabled automatically when supported (checks `timestamp-query` feature)

## Future Enhancements

### Option B: Timestamp Queries (if needed)

If more precise GPU timing is required, timestamp queries can be added:

**Required changes**:
1. Request `timestamp-query` feature during device creation
2. Create timestamp query set in render pass
3. Write timestamps at pass start/end
4. Read back query results asynchronously (next frame)
5. Calculate GPU pass duration from timestamp deltas

**Trade-offs**:
- More precise (pure GPU execution time)
- More complex (query buffer management)
- Requires feature flag (may not be available everywhere)
- More invasive (modifies render pass)

**When to use**:
- Need per-pass timing breakdown
- Need precise GPU execution time (excluding queue latency)
- Feature availability is acceptable

## References

- [WebGPU Specification: `GPUQueue`](https://www.w3.org/TR/webgpu/#gpuqueue)
- [WebGPU Specification: `onSubmittedWorkDone`](https://www.w3.org/TR/webgpu/#dom-gpuqueue-onsubmittedworkdone)
- [WebGPU Specification: timestamp queries](https://www.w3.org/TR/webgpu/#timestamp-query)
