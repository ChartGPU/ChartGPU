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

**GPU decimation (line, `lttb`/`min`/`max`, null-gap-free):** compute shaders replace CPU sampling. When points-per-bucket exceed **512**, LTTB/min/max evaluate a uniform **128-candidate** set (endpoints included) and the averages pre-pass uses **64** samples for coarse triangle anchors — exact below 512 pts/bucket (covers 1M × 2500 ≈ 400); approximate extrema/shape at extreme N (5M–10M pts / 2500 buckets). This bounds GPU bandwidth so period=1 present fidelity stays interactive without multi-frame cadence.

**Tile hierarchy (Phase B multi‑M FIFO):** **physical** tiles of size **1024** (buffer index space, not logical chronology) store min/max/sum aggregates. On append/wrap, **maintain** rebuilds only touched tiles — modular seam wraps use up to **two** phys ranges (no min/max collapse across the ring). Cold full rebuilds chunk (2048 tiles/encode); maintain may continue while present SIG is clean until ready. When hierarchy is ready and policy enables it (**modular multi‑K even when pts/bucket ≤ 512**, or pts/bucket &gt; 512, or N ≥ 250k), **present** LTTB/min/max reads tile aggregates instead of cold full-ring scans — still **period=1** every `SIG` change (G0–G2). Warm hierarchy never skips present encode. Falls back to legacy present same frame if hierarchy is not ready. Memory: ~0.3–0.6 MiB tiles per 10M-point series.

**G4 hierarchy residual magnitude:** present scores tile min/max (and mid) candidates plus ≤8 uniform samples on partial edge tiles — not full-tile raw refine. Averages on partial tiles use fractionally scaled tile means. Same residual class as the 128-candidate dense cap; harness-validated on G7 1M/5M.

**Streaming gap-scan cache:** `hasNullGaps` for modular rings must not full-scan N every append. Finite-only appends (and staging thin-path batches with **x and y** finite) refresh an O(append) gap cache so GPU-decimation eligibility stays cheap at multi‑M FIFO rates. This was a primary multi‑M FPS unlock alongside hierarchy present.

**GPU `targetBuckets` vs `samplingThreshold` (intentional screen-space LOD):** GPU prepare sets
`targetBuckets = min(samplingThreshold, pixelCap, rawPointCount)` where
`pixelCap = max(128, 2 × plotWidthDevicePx)`. On narrow multi-chart slots this can yield fewer
LTTB/min/max samples than the configured `samplingThreshold` alone (e.g. ~400 vs 2500). This is
**screen-space LOD**, not a multi-frame amortization residual: the encode still runs every streaming
`SIG` (G0–G2). CPU sampling paths use the configured / zoom-scaled threshold **without** that pixel
cap. Prefer a wider plot or a lower threshold when comparing GPU vs CPU sample counts side-by-side.

**Golden encode-signature fidelity (foundation):** the present path never draws decimation samples computed for a different prepare input than this frame.

| Rule | Meaning |
|------|---------|
| **G0** | Never present output whose last successful encode `SIG` ≠ this frame’s prepare inputs. `SIG` = algorithm, rawBuffer, rawPointCount, visibleStart/End, targetBuckets, contentVersion, ringStart, ringCapacity. |
| **G1** | `lastEncodedSIG` updates **only after** a successful `encodeCompute` (never on prepare entry alone). Same-frame order: prepare → encode if needed → draw. |
| **G2** | **Period = 1** whenever prepare `SIG` differs from `lastEncodedSIG` — modular FIFO wrap/fill **and** linear growth. Multi-frame density amortization (period 2/4/32/64) and intentional present lag are **removed / forbidden**. |

**Period-flash (forbidden):** multi-frame freeze of geometry for a prior streaming `SIG` while ring/N/window/version moved, then a hard snap when encode finally runs. Max frames presenting a prior streaming `SIG` = **0**.

**Allowed residual motion:** honest LTTB reselection every streaming frame (polyline may move slightly frame-to-frame without freeze), 128-candidate (averages 64) approximation at extreme pts/bucket, **hierarchy tile-rep LTTB** (min/max tile extrema + partial-edge subsample; G4 extension of the dense-cap residual), dense-hairline / draw-LOD policy. These are not golden-rule failures.

**Phase B multi‑M cost model (still G0–G2):** every streaming `SIG` change re-encodes this frame. Speed comes from cheaper honest recompute — **tile hierarchy maintain O(append) + hierarchy-backed present**, dense candidate caps on the legacy path, O(1) cold multi‑M content stamp on `setSeries`, modular ring index without integer `%` in WGSL — **not** multi-frame present lag.

Equal-N content rewrites (same N + same ringStart, version bump) and bind-group/output rebuilds always recompute. Domain scales are **not** in `SIG` — they update every frame on the line/area draw path.

Multi‑M FIFO rows re-encode LTTB every append frame after this foundation; Avg FPS may drop vs pre-fidelity cadence-inflated baselines. Competitive speed claims use a **post-present-fidelity** harness archive (not pre-fidelity multi‑M FPS).

**Config:** Per-series `sampling`, `samplingThreshold` in [options](https://chartgpu.io/docs/api/options/#series-configuration). See [`examples/sampling/`](../examples/sampling/).

## Zoom-aware resampling

Zoom triggers resampling on the visible range only. Target scales with zoom level (capped at 200K points).

**Period=1 while zoom is live:** CPU-sampled series recompute zoom samples on every zoom change (coalesced to the next flush/frame). ChartGPU does **not** present a multi-frame slice of prior full-span samples as the zoomed window (that under-sampled window would miss local extrema until a delayed resample). GPU-decimation series keep full raw resident and scope buckets via `visibleStart`/`visibleEnd` every frame.

**Y-axis bounds:** `yAxis.autoBounds: 'visible'` (default) rescales to visible data; `'global'` uses full dataset bounds.

## Streaming

**Recommended config:**
- `animation: false`
- `autoScroll: true`
- `dataZoom: [{ type: 'inside' }, { type: 'slider' }]`
- `sampling: 'lttb'`, `samplingThreshold: 2500`

**Memory (preferred):** Stream with a fixed-capacity ring via `appendData(index, newPoints, { maxPoints })` — GPU modular ring writes, O(append), no full retained-window rewrite. Prefer this over sliding-window full `setOption` for high-rate FIFO.

**Cold FIFO seed (G7 / multi‑M setup):** create the chart with empty series (styles/axes only), then seed with `appendData(i, fullColumns, { maxPoints: N })` when the batch length is ≥ `N`. That is a **strict replace into capacity** — one ring allocation at `N`, one pack/upload per series, ring mode active immediately. Do **not** cold-load multi‑M via full-data `setOption` then switch to `appendData` + `maxPoints` on the stream (linear residency + later promote was the G7 10M setup hang path). Suite group 7 uses this idiomatic path; SciChart parity is `fifoCapacity` at first real ingest.

**Memory (fallback):** When you must fully replace series data, trim client-side then `setOption({ series: [{ data: rawData.slice(-maxPoints) }] })`. See [`examples/live-streaming/`](../examples/live-streaming/) and [Chart API — appendData](https://chartgpu.io/docs/api/streaming/#appenddata).

### Hover / hit-test during multi‑M streaming

Pointer-in-plot work (highlight ring + optional tooltip) must stay cheap while appending:

| Path | Behavior |
|------|----------|
| **Shared nearest-point** | One `findNearestPoint` result feeds **highlight + item tooltip**. **Time-only rate limit (~60 Hz / 16 ms)** — pointer move does **not** bypass the throttle. Each allowed sample uses the **latest** pointer; suppressed frames reuse the last match and schedule a follow-up render. Crosshair still tracks every frame. |
| **findNearest multi‑M** | Above ~8k points: **skip mono check entirely**, domain x-window for the hit radius, then expand. When that window still has **≫4k** points (full-span multi‑M: points-per-pixel × maxDist), **stride + local refine** so hover stays O(thousands) not O(100k+). At ~**16M** (128 MiB storage bind / 8 bytes per f32 xy) device auto-window engages ring FIFO — without dense-stride expand, hover freezes streaming even with binary search. |
| **Tooltip dual-store ring bounds** | When `tooltip.show: true` and device/`maxPoints` ring wraps, hit-test bounds use **O(1) endpoint x + batch y** (same as coordinator) — not a full O(n) rescan of the ~16M ring every append. |
| **Monotonic X cache** | **Growing XY / arrays** (owned MutableXYColumns): `{ mono, count, lastX, proven }` — pure mono growth re-checks **only the new tail** after proven mono. First visit of n ≫ 250k: strided sample may only **reject** mono; otherwise progressive full-scan in 250k chunks until proven (then tight binary windows). Never mono=true from stride alone. **Ring / staging**: generation-aware cache + `contentEpoch`; same progressive proof for multi-M first visit. |
| **`tooltip.show: false`** | Skips dual hit-test columnar store maintenance on `appendData` (GPU/coordinator only). Highlight/crosshair still use the shared gated path above — turning tooltips off alone does **not** disable hit-test. |
| **`tooltip.show: true`** | Dual store kept for history/hit APIs; tooltip DOM updates share the same ~60 Hz gate as highlight. |

Prefer library defaults (crosshair + highlight on) over demo-only `tooltip: false` when measuring interactive FPS. CPU-sampled series already hit-test their display resolution; GPU-decimation series keep raw resident data and use binary search when X is mono.

## appendData vs setOption

| Method | Use case | GPU upload | Animation |
|--------|----------|------------|-----------|
| `appendData(index, newPoints)` | Streaming, incremental | Incremental when possible | No |
| `setOption({ series })` | Full replacement |

**appendData:** Cartesian only, append-only. **setOption:** Full data/config changes, supports animation.

### Axes-only multi-series `setOption`

When only axis ranges / grid change and each series config object is identity-stable, resolve reuses the prior series array (O(1) vs O(series count)). Treat series elements as immutable; use `appendData` or new series objects when data changes. See [options](https://chartgpu.io/docs/api/options/#series-configuration).

### Multi-series dense hairline (draw LOD)

Many short line series (e.g. 1000×1000) can exceed a **~500k total-segment** budget and switch to **1 device-px hairline** draw (post-resolve sampleCount 1) even when each series is under the 25k per-series threshold. This is draw-only; sampling and data residency are unchanged. Prefer fewer series or lower N for thick AA strokes. Details: [options — multi-series dense hairline](https://chartgpu.io/docs/api/options/#series-configuration).

### Adaptive draw LOD (`performance.lod`)

Chart-level option controlling dense draw fidelity:

| Value | Lines | Scatter | Mountain / area fill | Equal-N LTTB |
|-------|-------|---------|---------------------|--------------|
| `'auto'` (default) | ≥25k **draw** points or multi-series segment budget ≥500k → 1 device-px hairline; multi‑M **raw residency** (≥1M) on GPU-decimation path also forces hairline while draw instance count stays on buckets; multi-M hairline also caps **drawn** segments toward `max(8192, 4× plotWidth)` | High points/pixel → compact marker radius toward ~1 device px | N ≥ 1M and over pixel budget → draw-stride fill (resident data unchanged; `sampling: 'none'` still full raw); dense fill draws sampleCount:1 post-resolve (or direct SS1 when no annotations/hover) | Index-sorted equal-N rewrites may freeze prior LTTB indices (O(k) y remap) |
| `'strict'` | Always honor `lineStyle.width` + AA quads + full N segments | Always honor `symbolSize` | Full N−1 fill trapezoids | Full LTTB recompute on every y change (honest sampling) |

**Thresholds (auto only):**

- Dense hairline: `DENSE_HAIRLINE_POINT_THRESHOLD = 25_000` **draw / displayed** points per series (raw stroke length or GPU-decimation bucket/`pointCountOverride` count), or multi-series total segments ≥ `500_000`. **GPU-decimation multi‑M residency:** when raw residency ≥ `DENSE_DRAW_POINT_THRESHOLD` (`1_000_000`), hairline policy may use that raw count even if draw N is only a few thousand LTTB buckets (multi‑M FIFO exits 4× MSAA AA-quad fill). Mid-N raw (50k–500k) with low draw N keeps full AA quads + configured width.
- Dense draw stride (mountain fill + multi-M hairline stroke): N ≥ `1_000_000` and segments over `max(8192, 4× plotWidthDevicePx)` → index stride in VS (`denseDrawLod.ts` / `areaDrawPolicy.ts`); residency and sampling mode unchanged. Mid-N product demos (≤999k, including 250k–500k) keep full N−1 under auto. **May draw ≪ N−1** at multi-M protect rows under auto — use `lod: 'strict'` when full geometry is required
- Dense mountain under auto may use **sampleCount:1** for dense fill/stroke (post-resolve, or a direct swapchain SS1 path when every series layer is deferred and there are no annotations / pointer overlays). Overlay axes stay correct; main 4× MSAA is skipped only on that narrow dense-only path
- Dense scatter: density LO `0.08` / HI `0.30` points per plot pixel, plus N ≥ `250_000` full-compact floor; **only fully compact** const-radius draws sampleCount:1 post-resolve (partial blends stay main 4×); deferred only on pure-scatter charts (any visible line keeps scatter on main for z-order — see `scatterDrawPolicy.ts`)

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

- [API Reference](https://chartgpu.io/docs/api/) — Sampling, zoom, lifecycle
- [Getting Started](https://chartgpu.io/docs/getting-started/)
- [examples/sampling/](../examples/sampling/), [examples/live-streaming/](../examples/live-streaming/), [examples/million-points/](../examples/million-points/)
