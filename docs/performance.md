# Performance Guide

Optimize ChartGPU for large datasets and real-time streaming.

## Sampling

**When:** Dataset > 5K points per series (default `samplingThreshold`), or frame rate drops.

**Defaults:** `sampling: 'lttb'`, `samplingThreshold: 5000`

**Algorithms:**

| Algorithm | Best for | Preserves |
|-----------|----------|-----------|
| `lttb` (default) | General time-series | Shape, peaks, outliers |
| `average` | Noisy data | Trends |
| `max` / `min` | Spikes | Peaks / valleys |
| `none` | Small datasets (<5K) | All points |

**GPU decimation (line, `lttb`/`min`/`max`, null-gap-free):** compute shaders replace CPU sampling. When points-per-bucket exceed **512**, each bucket evaluates a uniform **512-candidate** set (endpoints included) instead of every raw point — exact below that density; approximate extrema/shape at extreme N (e.g. 10M pts / 2500 buckets). This bounds GPU bandwidth for FIFO streaming without changing `sampling` mode.

**Streaming density cadence (intentional visual lag):** under pure unbounded growth (N increases, same buffer / buckets / ring), recompute period scales with points-per-bucket: **period 2** at density ≥100, **4** at ≥200, **8** at ≥1000. Between recomputes the chart draws a **1–7-frame-old** LTTB sample — acceptable for extreme streaming N, not a sampling-mode change. Equal-N content rewrites always recompute immediately; modular FIFO rings never density-skip.

**Config:** Per-series `sampling`, `samplingThreshold` in [options](api/options.md#series-configuration). See [`examples/sampling/`](../examples/sampling/).

## Zoom-aware resampling

Zoom triggers resampling on visible range only. Target scales with zoom level (capped at 200K points). Debounce ~100ms.

**Y-axis bounds:** `yAxis.autoBounds: 'visible'` (default) rescales to visible data; `'global'` uses full dataset bounds.

## Streaming

**Recommended config:**
- `animation: false`
- `autoScroll: true`
- `dataZoom: [{ type: 'inside' }, { type: 'slider' }]`
- `sampling: 'lttb'`, `samplingThreshold: 2500`

**Memory:** Trim when `rawData.length > maxPoints` — `setOption({ series: [{ data: rawData.slice(-maxPoints) }] })`. See [`examples/live-streaming/`](../examples/live-streaming/).

## appendData vs setOption

| Method | Use case | GPU upload | Animation |
|--------|----------|------------|-----------|
| `appendData(index, newPoints)` | Streaming, incremental | Incremental when possible | No |
| `setOption({ series })` | Full replacement |

**appendData:** Cartesian only, append-only. **setOption:** Full data/config changes, supports animation.

### Axes-only multi-series `setOption`

When only axis ranges / grid change and each series config object is identity-stable, resolve reuses the prior series array (O(1) vs O(series count)). Treat series elements as immutable; use `appendData` or new series objects when data changes. See [options.md](api/options.md#series-configuration).

### Multi-series dense hairline (draw LOD)

Many short line series (e.g. 1000×1000) can exceed a **~500k total-segment** budget and switch to **1 device-px hairline** draw (post-resolve sampleCount 1) even when each series is under the 25k per-series threshold. This is draw-only; sampling and data residency are unchanged. Prefer fewer series or lower N for thick AA strokes. Details: [options.md — multi-series dense hairline](api/options.md#series-configuration).

### Adaptive draw LOD (`performance.lod`)

Chart-level option controlling dense draw fidelity:

| Value | Lines | Scatter | Equal-N LTTB |
|-------|-------|---------|--------------|
| `'auto'` (default) | ≥25k points or multi-series segment budget ≥500k → 1 device-px hairline | High points/pixel → compact marker radius toward ~1 device px | Index-sorted equal-N rewrites may freeze prior LTTB indices (O(k) y remap) |
| `'strict'` | Always honor `lineStyle.width` + AA quads | Always honor `symbolSize` | Full LTTB recompute on every y change (honest sampling) |

**Thresholds (auto only):**

- Dense hairline: `DENSE_HAIRLINE_POINT_THRESHOLD = 25_000` points per series, or multi-series total segments ≥ `500_000`
- Dense scatter: density LO `0.5` / HI `3.0` points per plot pixel (see `scatterDrawPolicy.ts`)

Use `performance: { lod: 'strict' }` for fidelity-sensitive benchmarks or when SciChart harness geometry (width 2 / full markers) must match. Default `'auto'` remains the product FPS path.

```ts
ChartGPU.create(el, {
  performance: { lod: 'strict' },
  series: [{ type: 'line', data, lineStyle: { width: 2 } }],
});
```

## Memory & disposal

- Call `chart.dispose()` when chart is no longer needed.
- Buffer growth: geometric (power-of-two). No shrinking until disposal.
- Time axis: ChartGPU rebases epoch-ms internally for Float32 precision.

## Performance baseline (regression tracking)

**Location:** [`examples/performance-baseline/`](../examples/performance-baseline/)

Fixed scenarios (static redraw, hover, zoom/pan, stream append) that emit JSON with FPS and CPU frame-time percentiles. Use this before/after performance work.

```bash
bun run benchmark:baseline:preview
# open http://localhost:4173/ChartGPU/examples/performance-baseline/?scenario=all&autorun=1&download=1
# save JSON → benchmarks/baselines/main.json
bun run benchmark:baseline:compare -- benchmarks/baselines/main.json ./candidate.json
```

Details: [`benchmarks/baseline/README.md`](../benchmarks/baseline/README.md), [`benchmarks/baselines/README.md`](../benchmarks/baselines/README.md).

**Important:** Measure against the **production** examples build (`preview:examples`), not the Vite dev server.

## Benchmark (1M points)

**Location:** [`examples/million-points/`](../examples/million-points/)

**Steps:** `npm run dev` → `http://localhost:5176/examples/million-points/` → Enable "Benchmark mode".

**Stats:** FPS, CPU submit time, GPU time, rendered point count. CPU > GPU time: CPU-bound; GPU > CPU: GPU-bound.

## Checklist

- [ ] Enable sampling for datasets >5K
- [ ] Use `appendData` for streaming
- [ ] Bound memory with periodic trim
- [ ] Disable animation for streaming
- [ ] Call `dispose()` when done
- [ ] Profile with DevTools

## See also

- [API Reference](api/README.md) — Sampling, zoom, lifecycle
- [Getting Started](GETTING_STARTED.md)
- [examples/sampling/](../examples/sampling/), [examples/live-streaming/](../examples/live-streaming/), [examples/million-points/](../examples/million-points/)
