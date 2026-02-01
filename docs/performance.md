# Performance Guide

Optimize ChartGPU for large datasets and real-time streaming scenarios.

## When to Use Sampling

### Dataset Size Thresholds

**Enable sampling when:**
- Dataset exceeds 5,000 points per series (default `samplingThreshold`)
- Frame rate drops below 60 FPS
- User experience degrades during zoom/pan interactions

**Sampling defaults:**
- Per-series default: `sampling: 'lttb'` (Largest Triangle Three Buckets)
- Default threshold: `samplingThreshold: 5000` when omitted
- See [`src/config/OptionResolver.ts`](../src/config/OptionResolver.ts) for resolution logic

**When sampling is not needed:**
- Datasets under 2,000-3,000 points typically render at 60 FPS without sampling
- Static visualizations where interaction performance is not critical
- Bar charts with categorical x-axis (fewer bars naturally limit complexity)

### Sampling Activation Rules

Sampling triggers when:
1. `series[i].data.length > samplingThreshold` AND
2. `sampling !== 'none'`

Sampling is automatically re-applied during zoom with increased detail for visible range.

## Sampling Algorithms Compared

ChartGPU provides four sampling strategies. See implementations in [`src/data/sampleSeries.ts`](../src/data/sampleSeries.ts) and [`src/data/lttbSample.ts`](../src/data/lttbSample.ts).

### Algorithm Comparison Table

| Algorithm | Best For | Visual Quality | Performance | Preserves |
|-----------|----------|----------------|-------------|-----------|
| **`lttb`** (default) | General time-series, curves | Excellent | Good | Shape, peaks, outliers |
| **`average`** | Noisy data, trends | Good | Excellent | Trends, reduces noise |
| **`max`** | Positive spikes, peaks | Fair | Excellent | Maximum values per bucket |
| **`min`** | Negative spikes, valleys | Fair | Excellent | Minimum values per bucket |
| **`none`** | Small datasets (<5K) | Perfect | Varies with size | All points |

### Algorithm Details

**LTTB (Largest Triangle Three Buckets):**
- Preserves visual shape by selecting points that maximize triangle area
- Keeps first and last points (critical for domain extent)
- Best general-purpose algorithm for time-series data
- Computational cost: O(n) where n = input size

**Average/Min/Max (Bucketed):**
- Divides data into uniform buckets, selects aggregate per bucket
- Keeps first and last points
- Faster than LTTB but may lose outliers (average) or shape detail (min/max)
- Computational cost: O(n)

### Configuration Example

Set per-series sampling via `SeriesConfig` in [`src/config/types.ts`](../src/config/types.ts) by providing a `series` array entry with `sampling`, `samplingThreshold`, and `data` properties. See working examples in [`examples/sampling/`](../examples/sampling/) and [`examples/million-points/`](../examples/million-points/).

## Zoom-Aware Sampling for Large Datasets

ChartGPU automatically increases sampling detail when zoomed in, preserving outliers without re-uploading raw data.

### How It Works

**Zoom triggers resampling:**
1. User zooms via mouse wheel, drag pan, or slider UI
2. ChartGPU computes visible x-range from zoom window (`start`/`end` in percent space)
3. Resampling applies to **visible range only** with increased target points
4. Debounced ~100ms to avoid churn during continuous zoom gestures

**Target scaling formula:**
- Base target = `samplingThreshold` at full span (0-100%)
- Zoomed target ≈ `samplingThreshold / spanFraction`
- Capped by `MAX_TARGET_MULTIPLIER = 32` and `MAX_TARGET_POINTS_ABS = 200,000`
- Minimum target = 2 points

See implementation in [`src/core/createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) and example usage in [`examples/sampling/main.ts`](../examples/sampling/main.ts) and [`examples/million-points/main.ts`](../examples/million-points/main.ts).

### Zoom Configuration

Enable interactive zoom with data-driven resampling by providing `dataZoom` array with `{ type: 'inside' }` (wheel zoom + shift-drag pan) or `{ type: 'slider' }` (slider UI) entries, and configuring per-series `sampling` and `samplingThreshold` as described in [`docs/api/options.md`](./api/options.md#data-zoom-configuration).

**Trade-offs:**
- **Debounce delay (~100ms)**: Small UX lag during zoom vs. CPU/GPU efficiency
- **Memory cap (200K points)**: Prevents pathological memory usage on extreme zoom
- **Multiplier cap (32x)**: Balances detail preservation vs. performance

### Axis Bounds Behavior

**Critical (global vs visible):**
- **`yAxis.autoBounds: 'global'`** uses **raw (unsampled)** per-series bounds (computed once during option resolution / maintained during `appendData`). This ensures sampling cannot clip outliers.
- **`yAxis.autoBounds: 'visible'` (default)** uses the **current render-series (sliced/sampled for the visible x-window)** to compute y-bounds. This keeps the y-axis tightly fit to what’s actually being rendered, and avoids scanning the full dataset.

**Y-axis auto-bounds during x-zoom:**
- **Default (`yAxis.autoBounds: 'visible'`)**: Y-axis rescales to visible data within the current x-zoom window. Provides intuitive "auto-fit" behavior when zooming.
- **Opt-out (`yAxis.autoBounds: 'global'`)**: Y-axis uses full dataset bounds regardless of x-zoom. Useful for fixed-scale comparisons.
- **Performance**:
  - Visible y-bounds are computed from `renderSeries` (already sliced/sampled for the visible x-range), so the work is proportional to rendered points, not total dataset size.
  - Slicing + visible-bounds recompute is **coalesced to at most once per rendered frame** during continuous zoom/pan gestures (avoids repeated O(n) work within a single frame).
  - Visible-bounds scans are **skipped entirely** when `yAxis.autoBounds: 'global'` or when both `yAxis.min` and `yAxis.max` are explicitly set.

Override with explicit bounds if needed by providing `xAxis: { min, max }` or `yAxis: { min, max }` in chart options. Explicit bounds always take precedence over auto-bounds. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) for bounds derivation logic.

## Real-Time Streaming Best Practices

Optimize for continuous data ingestion with bounded memory and responsive UI.

### Candlestick Streaming Demo

The [`examples/candlestick-streaming/`](../examples/candlestick-streaming/) demo showcases ChartGPU's ability to handle massive candlestick datasets at high frame rates. Users can scale from 60 to **5 million candlesticks** with preset buttons, maintaining **over 100 FPS** while streaming real-time tick data. This demo combines sampling, zoom-aware resampling, and auto-scroll to deliver smooth performance at extreme scale.

### Recommended Configuration

Based on [`examples/live-streaming/main.ts`](../examples/live-streaming/), configure streaming scenarios with:
- `animation: false` to disable animations for streaming
- `autoScroll: true` to keep view pinned to newest data
- `dataZoom` array with inside and slider entries
- Per-series `sampling: 'lttb'` and lower `samplingThreshold: 2500`

**Configuration rationale:**
- **`animation: false`**: Avoids animation overhead on every append
- **`autoScroll: true`**: Keeps view "pinned to end" when zoom window is at 100%
- **Lower `samplingThreshold` (2500)**: Reduces resampling work per append
- **Slider with `start: 70`**: Provides zoom control while keeping recent data visible

### Streaming Parameters

**From live-streaming example:**
- `pointsPerTick: 12` (batch size per append)
- `tickMs: 60` (16-17 appends/second ≈ 60 FPS)
- `maxPoints: 25_000` (memory bound)
- `samplingThreshold: 2500` (triggers at 10% of max)

**Adjust based on requirements:**
- **Higher throughput**: Increase `pointsPerTick`, decrease `tickMs` (watch CPU usage)
- **Smoother animation**: Match `tickMs` to frame time (16-17ms for 60 FPS)
- **Longer retention**: Increase `maxPoints` (watch memory usage)

### Memory Bounding Strategy

Prevent unbounded growth with periodic trimming by calling `chart.appendData(seriesIndex, newPoints)` to add data, then when `rawData.length > maxPoints`, trim via `rawData = rawData.slice(rawData.length - maxPoints)` and call `chart.setOption({ series: [{ data: rawData }] })` to reset. See [`examples/live-streaming/main.ts`](../examples/live-streaming/main.ts) for complete implementation.

**Trade-off:** `setOption` causes full data re-upload. For 25K points at 2500 threshold, overhead is acceptable when trimming infrequently (e.g., every 5-10 seconds).

### Auto-Scroll Behavior

**When enabled (`autoScroll: true`):**
- **Pinned to end**: When zoom `end` is near 100%, new data shifts the view to keep `end` at 100%
- **Panned away**: When user scrolls back, view stays fixed (does not yank back to newest data)
- **Requirements**: x-axis data zoom must be enabled; `xAxis.min`/`xAxis.max` must not be set

See auto-scroll implementation in [`src/core/createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

## appendData vs setOption for Updates

Choose the right update method based on your data pattern.

### Method Comparison

| Method | Use Case | GPU Upload | Recomputation | Animation |
|--------|----------|------------|---------------|-----------|
| **`appendData(index, newPoints)`** | Streaming, incremental | Incremental when possible | Partial (bounds + resample) | No |
| **`setOption({ series })`** | Full replacement | Full re-upload | Full (resolve + bounds + resample) | Yes (if enabled) |

### When to Use appendData

**Ideal for:**
- Real-time streaming scenarios
- Incremental data ingestion
- Append-only patterns (no modification of existing points)

**Behavior:**
- Updates internal runtime bounds incrementally
- Triggers resampling only when zoom active or debounce matures
- Schedules coalesced render (via `requestAnimationFrame`)
- Respects `autoScroll` when enabled

**Constraints:**
- Cartesian series only (not supported for `type: 'pie'`)
- Appends to **end** of series (not insertions or modifications)

See [`ChartGPU.ts`](../src/ChartGPU.ts) and [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) for implementation.

### When to Use setOption

**Ideal for:**
- Replacing entire dataset
- Changing series configuration (type, color, sampling, etc.)
- Animated data transitions
- Non-append modifications (insertions, deletions, edits)

**Behavior:**
- Full option resolution via [`OptionResolver.ts`](../src/config/OptionResolver.ts)
- Full data upload to GPU buffers
- Triggers data transition animation when enabled
- Schedules single on-demand render (coalesces multiple calls)

**Animation support:**
- Cartesian series: y-values interpolate by index
- Pie series: slice values interpolate by angle
- Requires `animation` not `false` and post-initial-render update

See [`ChartGPU.ts`](../src/ChartGPU.ts) for lifecycle and [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) for animation logic.

### Incremental GPU Append Optimization

**Current behavior:**
- When `appendData` doesn't trigger buffer reallocation, only appended bytes are uploaded
- Buffer growth uses geometric (power-of-two) policy to reduce reallocation frequency
- 4-byte alignment enforced automatically (WebGPU requirement)

**Safe conditions for incremental upload:**
- No buffer reallocation needed
- 8-byte aligned offsets (2 floats × 4 bytes = 8 bytes per point)

See [`docs/internal/INCREMENTAL_APPEND_OPTIMIZATION.md`](./internal/INCREMENTAL_APPEND_OPTIMIZATION.md) for detailed analysis.

## Memory Management and Disposal

Prevent memory leaks and GPU resource exhaustion.

### Disposal Checklist

**When disposing a chart:** Call `chart.dispose()` to clean up resources.

**What gets cleaned up:**
- Cancels pending `requestAnimationFrame` render
- Destroys internal render resources (pipelines, buffers)
- Destroys WebGPU context via `device.destroy()`
- Removes canvas element from DOM
- Unregisters all event listeners

See [`ChartGPU.ts`](../src/ChartGPU.ts) for disposal implementation.

### Buffer Management

**Automatic GPU buffer lifecycle:**
- Per-series vertex buffers cached in [`createDataStore.ts`](../src/data/createDataStore.ts)
- Lazy allocation on first data upload
- Geometric growth (power-of-two) on reallocation
- No shrinking (capacity persists until disposal)
- Old buffers destroyed on growth via `buffer.destroy()`

**Minimum buffer size:** 4 bytes (WebGPU requirement)

### Time Axis Precision (Epoch-ms)

WebGPU vertex buffers use **Float32**. Very large absolute x-values (notably **epoch-millisecond timestamps** around \(10^{12}\)) can lose precision when stored directly, which can manifest as visual instability (e.g. shimmer/jitter) during zoom.

ChartGPU mitigates this internally by **rebasing** time-axis x-values per series before uploading to the GPU (store \(x' = x - xOffset\) and fold `xOffset` back into the CPU-side transform). This behavior is automatic and does not change your data units: you should continue to provide milliseconds for `xAxis.type: 'time'`.

If you manually pre-pack timestamps into a `Float32Array` before handing data to ChartGPU, be aware that converting epoch-ms to Float32 **before** rebasing can still quantize away sub-minute resolution. Prefer passing `DataPoint[]` (numbers) or higher-precision sources so ChartGPU can apply rebasing before Float32 conversion.

### Device Loss Handling

**GPU device can be lost due to:**
- Driver crash or timeout detection and recovery (TDR)
- System sleep/wake
- GPU removed (external GPU disconnect)

**Recommended handling:** Create chart instance via `ChartGPU.create(container, options)` and optionally access `chart.gpuContext?.device?.lost` promise for advanced device-loss handling. For examples using [`GPUContext`](../src/core/GPUContext.ts) directly, see device-loss handling in [`examples/million-points/main.ts`](../examples/million-points/main.ts).

### Memory Profiling

**Tools:**
- Browser DevTools: Memory profiler (check for detached canvas, uncancelled RAF)
- WebGPU DevTools: GPU buffer/texture tracking (Chrome/Edge)
- Performance Monitor: GPU memory usage trends

**Common leaks:**
- Missing `dispose()` on chart instances
- Uncancelled `requestAnimationFrame` loops
- Event listeners not cleaned up
- Large datasets accumulating in JavaScript arrays

## Benchmark: How to Measure 1 Million Point Performance

Run reproducible performance measurements for 1M point datasets.

### Running the Benchmark

**Location:** [`examples/million-points/`](../examples/million-points/)

**Steps:**
1. Start dev server: `npm run dev`
2. Navigate to `http://localhost:5176/examples/million-points/`
3. Wait for initial render (1-2 seconds for data generation)
4. **Enable "Benchmark mode"** checkbox (checked by default) for performance measurement
5. Observe stats panel (FPS, CPU submit time, GPU time, rendered point count)
6. Toggle sampling on/off to compare performance
7. Zoom in/out to test zoom-aware resampling

**Benchmark Mode Toggle:**

The Million Points example provides two rendering modes:

- **Benchmark mode (checked)**: Continuous rendering at 60fps for accurate performance measurement. The stats panel (FPS, GPU time, CPU submit time) provides meaningful metrics in this mode.
- **Render-on-demand (unchecked)**: Renders only when needed (interactions, data changes). CPU usage drops to near 0% when idle. Low FPS in this mode is expected and indicates idle efficiency, not poor performance.

**To test idle efficiency:**
1. Uncheck "Benchmark mode" 
2. Let chart sit idle without interaction
3. Check system Task Manager/Activity Monitor to observe near 0% CPU usage

**Reproducibility:**
- Uses deterministic PRNG (xorshift32) for synthetic data generation
- Same 1M points on every run (reproducible benchmarks)
- Rolling average statistics (60-frame window)
- DOM updates throttled to 250ms intervals

See [`examples/million-points/main.ts`](../examples/million-points/main.ts) for implementation.

### Understanding the Stats Panel

**FPS (Frames Per Second):**
- Target: 60 FPS (16.67ms per frame)
- Sustained 60 FPS indicates smooth interaction
- Below 30 FPS indicates noticeable lag

**CPU Submit Time (ms):**
- Time spent in `coordinator.render()` including:
  - Data sampling/recomputation
  - Buffer updates
  - Renderer preparations
  - GPU command encoding
  - `queue.submit()` call
- Lower is better

**GPU Time (ms):**
- End-to-end GPU completion time (submit → work done)
- Measured via `queue.onSubmittedWorkDone()`
- **If GPU time > CPU time:** GPU is the bottleneck
- **If GPU time < CPU time:** CPU is the bottleneck
- Includes queue latency + GPU execution + CPU sync overhead

See [`docs/internal/GPU_TIMING_IMPLEMENTATION.md`](./internal/GPU_TIMING_IMPLEMENTATION.md) for timing methodology.

**Rendered Point Count:**
- Estimated points after sampling
- At full zoom (0-100%): equals `samplingThreshold` when sampling enabled
- At 1% zoom: up to 32× threshold (capped at 200K points via `MAX_TARGET_POINTS_ABS` in [`src/core/createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts))
- With `sampling: 'none'`: equals visible raw points

### Benchmark Configuration

**From million-points example:**
- Dataset: 1,000,000 points (deterministic sine + noise)
- Explicit x-domain: `xAxis: { min: 0, max: 999999 }`
- Explicit y-domain: `yAxis: { min: yMin, max: yMax }`
- Sampling threshold: 8192 (default for benchmark)
- Zoom controls: inside (wheel/drag) + slider
- Animation: disabled (`animation: false`)
- Tooltip: disabled (`tooltip: { show: false }`)

**Why these settings:**
- Explicit domains (or `yAxis.autoBounds: 'global'`) reduce auto-bounds recomputation overhead during zoom/pan (though the default `'visible'` mode is already well-optimized via caching)
- Disabled animation/tooltip reduce measurement noise
- Deterministic data ensures reproducible results

### Interpreting Bottlenecks

**CPU-bound scenario (CPU time > GPU time):**
- Symptoms: High CPU submit time, GPU mostly idle
- Solutions:
  - Enable sampling (reduce point count)
  - Lower sampling threshold (less resampling work)
  - Reduce append batch size (streaming)
  - Profile with DevTools to find hot paths

**GPU-bound scenario (GPU time > CPU time):**
- Symptoms: High GPU time, frame rate limited by GPU
- Solutions:
  - Enable sampling (reduce vertex/fragment work)
  - Reduce canvas size or device pixel ratio
  - Lower line width (less fragment shader cost)
  - Upgrade GPU hardware (if feasible)

**Balanced scenario (CPU time ≈ GPU time ≈ frame time):**
- Optimal: Both CPU and GPU fully utilized
- Limited headroom for more complex scenes
- Consider sampling to add performance margin

### Performance Factors (Machine-Dependent)

Results vary significantly based on:
- **Device pixel ratio:** High-DPI displays (2x-3x) increase GPU workload
- **Canvas size:** Larger viewports increase fragment shader cost
- **GPU tier:** Integrated vs discrete GPU (orders of magnitude difference)
- **Browser:** Chrome/Edge typically faster than Safari (WebGPU maturity)

Run the benchmark on your target hardware to establish baseline performance for your deployment environment.

## Performance Optimization Checklist

- [ ] Enable sampling for datasets >5K points
- [ ] Choose appropriate sampling algorithm (`lttb` for general use)
- [ ] Configure zoom for large datasets (inside + slider)
- [ ] Disable animation for streaming scenarios
- [ ] Use `appendData` for incremental updates
- [ ] Bound memory with periodic trimming (streaming)
- [ ] Call `dispose()` when chart no longer needed
- [ ] Profile with browser DevTools and GPU tools
- [ ] Test on target hardware (integrated vs discrete GPU)
- [ ] Measure with 1M point benchmark as baseline

## Related Documentation

- [`docs/api/README.md`](./api/README.md) — Full API reference including sampling, zoom, and lifecycle APIs
- [`docs/GETTING_STARTED.md`](./GETTING_STARTED.md) — Quick start guide and basic usage
- [`docs/internal/INCREMENTAL_APPEND_OPTIMIZATION.md`](./internal/INCREMENTAL_APPEND_OPTIMIZATION.md) — Deep dive into GPU buffer append optimization (contributor documentation)
- [`docs/internal/GPU_TIMING_IMPLEMENTATION.md`](./internal/GPU_TIMING_IMPLEMENTATION.md) — GPU timing methodology and interpretation (contributor documentation)
- [`examples/sampling/`](../examples/sampling/) — Sampling strategies demonstration
- [`examples/live-streaming/`](../examples/live-streaming/) — Real-time streaming best practices
- [`examples/million-points/`](../examples/million-points/) — Performance benchmark with GPU timing
