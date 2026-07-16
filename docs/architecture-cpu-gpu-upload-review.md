# Architectural Review: CPU→GPU Upload Paths in ChartGPU

**Date:** 2026-07-15  
**Scope:** Read-only architecture review with emphasis on CPU→GPU data transfer  
**Branch context:** `further-performance-improvements`  
**Method:** Multi-agent codebase audit of `src/data`, `src/core`, `src/renderers`, plus grounding in WebGPU Fundamentals lessons and W3C/WebGPU performance constraints.

---

## Executive summary

ChartGPU’s **line-series gold path** is real WebGPU architecture: long-lived device-local buffers (`VERTEX | STORAGE | COPY_DST`), geometric capacity growth, ranged `queue.writeBuffer` appends, modular ring FIFO under `maxPoints`, bind groups keyed by buffer identity, GPU compute decimation that keeps raw points resident across zoom, and **one `queue.submit` per frame**.

That gold path is **not the product surface**. Performance ceilings are set by:

1. **Parallel upload universes** — DataStore for lines vs independent packers for scatter, candlestick, area, and bars.
2. **Cache contracts that break streaming** — post-append cache invalidation can force a full `setSeries` and **linearize an active ring**.
3. **Growth without GPU copy** — buffer reallocation destroys the old GPU buffer and re-uploads the retained window from CPU staging.
4. **Reference-identity skip caches** — excellent for static frames; hostile to in-place mutation, animation, and equal-length rewrites.
5. **Dual/triple CPU residency** by default (runtime columns + Float32 staging + GPU).

### One-line judgment

> WebGPU wants few large aligned transfers into long-lived device-local buffers, with reduction staying on the GPU once data is resident. ChartGPU implements this for eligible lines; other series and several fallback paths still re-pay full CPU pack + bus traffic per frame.

### Severity map (upload-focused)

| Severity | Finding |
|----------|---------|
| **Critical** | Scatter-density dirty gate omits scale affine and content version → stale heatmaps after y-zoom / equal-length rewrite |
| **High** | Post-append `lastSetSeriesCache.delete` without re-seed → idle frame full `setSeries` + **ring layout destroyed** |
| **High** | Buffer growth has no `COPY_SRC` / `copyBufferToBuffer` → growth always O(N) full re-upload from CPU staging |
| **High** | Scatter points + candlestick re-upload every `prepare` (no identity cache; candle packs **clip space**) |
| **High** | CPU zoom/pan path allocates new sliced/sampled data refs → full re-upload (GPU path avoids this only for eligible lines) |
| **Medium** | Dual residency (CPU columns + staging + GPU); dual pack for line+`areaStyle`; area exact-size buffer thrash |
| **Medium** | Update animation: mandatory full re-upload every frame (correctness tradeoff) |
| **Medium** | `setSeries` always packs + FNV-hashes before content early-return (O(N) CPU even when GPU write is skipped) |
| **Low** | Dead packing APIs, doc drift (`auto` sampling, AGENTS GPU-copy claim, “render bundles”), uniform always-write |

### What does **not** need a full rewrite

- Interleaved `vec2f` storage + `xOffset` for time-axis Float32 precision  
- Modular ring FIFO + shared `planMaxPointsWindow`  
- GPU decimation eligibility as a **single predicate** + content-version dirty gate  
- `setSeriesIfChanged` / presentation-only setOption skip  
- Overlay prepare memo, 2-pass MSAA frame graph, bind-group-by-buffer-identity  
- Default use of `queue.writeBuffer` (correct per WebGPU Fundamentals and maintainer guidance)

---

## 1. WebGPU ground truth (judgment criteria)

Grounded in [WebGPU Fundamentals lessons](https://github.com/webgpu/webgpufundamentals/tree/main/webgpu/lessons) — especially **copying data**, **memory layout**, **optimization**, and **how it works** — plus W3C WebGPU constraints distilled in the project’s WebGPU performance skill.

### 1.1 Upload model

CPU and GPU memory are separate worlds. A typical `writeBuffer` path may cross:

1. Script-owned `TypedArray` / `ArrayBuffer`
2. Content ↔ GPU process shared memory
3. Driver staging
4. Device-local buffer (VRAM on discrete GPUs)

Mapping is an **ownership transfer**, not concurrent access. In WebGPU v1, mappable buffers cannot also be vertex/uniform/storage — only staging endpoints for copies. Once mapped, the buffer is unusable by the GPU until `unmap()`.

**Primary lesson:** [WebGPU Copying Data](https://webgpufundamentals.org/webgpu/lessons/webgpu-copying-data.html)  
**Optimization:** [WebGPU Speed and Optimization](https://webgpufundamentals.org/webgpu/lessons/webgpu-optimization.html)  
**Memory layout:** [WebGPU Data Memory Layout](https://webgpufundamentals.org/webgpu/lessons/webgpu-memory-layout.html)

Key takeaways for ChartGPU:

| Mechanism | When it wins | ChartGPU status |
|-----------|--------------|-----------------|
| `queue.writeBuffer` | Default for TypedArray series/uniforms/appends; UA-managed staging | **Production default** for all series paths |
| `mappedAtCreation` | Static one-shot geometry at create (avoids `COPY_DST` + separate write) | **Not used** |
| Staging ring + `mapAsync(WRITE)` + `copyBufferToBuffer` | Large per-frame **regeneration into** mapped memory after profiling | **Not used** for series |
| GPU compute write | Data already on GPU; consumers stay on GPU | Decimation + scatter density |
| One large uniform buffer + offsets | Many small per-object `writeBuffer`s | Not a multi-object 3D case; uniforms are tiny |
| Render bundles | Static repeated draw encoding | **Not used** (overlay memo skips CPU prepare instead) |

**Maintainer guidance** (gpuweb discussions): `writeBuffer` is the preferred default. Map rings only after profiling shows real benefit. ChartGPU’s exclusive use of `writeBuffer` for series is **not an architectural flaw**.

### 1.2 Hard constraints ChartGPU must respect

| Constraint | Value | Chart impact |
|------------|-------|--------------|
| `writeBuffer` offset/size | Multiple of **4** bytes | Point stride 8 is always aligned |
| Uniform struct layout | 16-byte member rules | VS/FS uniform packing |
| Dynamic uniform offset | `minUniformBufferOffsetAlignment` (default **256**) | Grid FS color slots pad to 256 |
| `maxBufferSize` | Default 256 MiB | Caps series capacity |
| Queue vs encode order | `writeBuffer` is queue-time; pass encode is submit-time | Mid-pass per-draw `writeBuffer` on one buffer is wrong (grid Phase 4a lesson) |

### 1.3 Ideal million-point streaming architecture

```
App batch (k points)
    → pack once into growable/ring CPU staging (or zero-copy if already interleaved f32)
    → ranged writeBuffer of k×8 bytes (or modular ring overwrite)
    → GPU buffer holds full retained window
    → GPU compute decimates visible window → draw storage
    → uniforms only for affine/color
    → single queue.submit
```

**Zoom must not re-upload raw data.**  
**Append must not re-upload the retained window.**  
**Growth should GPU-copy retained prefix when possible.**

ChartGPU’s gold path hits most of this for eligible lines. Failures below are where product paths diverge.

---

## 2. End-to-end architecture

```
Consumer app
    │ setOption / appendData
    ▼
ChartGPU instance (src/ChartGPU.ts)
    │ resolve options, hit-test dual-store, schedule
    ▼
createRenderCoordinator (~5k LOC)
    │ runtimeRawDataByIndex (owned columns / ring / staging view / raw ref)
    │ recomputeRuntimeBaseSeries  — CPU sample OR keep raw for GPU decimation
    │ recomputeRenderSeries       — zoom window sample / keep raw
    │ flushPendingAppends         — appendSeries fast path gate
    ▼
prepareSeries (renderSeries.ts)
    │ setSeriesIfChanged → DataStore  OR  skip if append this frame / cache hit
    │ DecimationCompute.prepare (eligible lines)
    │ Per-renderer prepare (line / area / bar / scatter / candle / pie)
    ▼
encode: density compute → decimation compute → main 4× MSAA → overlay 4× MSAA
    ▼
device.queue.submit([one command buffer])
```

### 2.1 Two-tier series upload policy (by design)

| Series | GPU geometry owner | Incremental append? | Steady-state skip? |
|--------|--------------------|---------------------|--------------------|
| **Line** | `DataStore` storage (+ optional decimation output) | Yes, gated | Yes (`lastSetSeriesCache`) |
| **Scatter density** | `DataStore` raw + compute bins | No | Identity skip on raw; compute dirty-gate |
| **Area** | Own `VERTEX` buffer | No | Yes (`boundDataRef`) |
| **Bar** | Own instance buffer | No | Yes (domain layout signature) |
| **Scatter points** | Own instance buffer | No | **No — re-packs every prepare** |
| **Candlestick** | Own instance buffer(s) | No (CPU OHLC only) | **No — clip-space re-pack every prepare** |
| **Pie** | Own instances | Rejected | Re-pack on prepare |
| **Crosshair** | `StreamBuffer` double-buffer | Diff ranges | N/A (pointer-driven) |

**This split is the root architectural flaw for cross-type performance.** Line has a residency model; scatter/candle still behave like “repack for WebGL every frame.”

### 2.2 Frame graph (render, not upload)

| Pass | Role | Sample count |
|------|------|--------------|
| Main | Series scene | 4× MSAA → resolve |
| Overlay | Blit main resolve + annotations + axes/crosshair/highlight | 4× MSAA → swapchain |

**One `queue.submit` per coordinator frame.** Texture bandwidth (MSAA + blit) is orthogonal to series upload volume; uploads are decided in `prepare` before encode.

Docs: 2-pass MSAA is main **4×** / overlay **4×** (WebGPU only allows sampleCount 1 or 4). AGENTS also claims grid/axis cache a `GPURenderBundle` — **false**; the real mechanism is `OverlayPrepareMemo` skipping `prepare()`.

---

## 3. DataStore: the primary upload layer

**File:** `src/data/createDataStore.ts`

### 3.1 Per-series entry

| Field | Role |
|-------|------|
| `buffer` | Device-local GPU buffer (`VERTEX \| STORAGE \| COPY_DST`) |
| `capacityBytes` | Allocated size (pow2 growth, never shrinks) |
| `pointCount` | Logical points for draw / decimation |
| `hash32` | FNV-1a over packed float **bits** (decimation dirty gate) |
| `xOffset` | Subtracted at pack time for Float32 time-axis precision |
| `stagingBuffer` | Capacity-sized interleaved `[x−xOffset, y, …]` CPU mirror |
| `ringStart` / `ringCapacityPoints` | Modular FIFO under `maxPoints` |

**No `COPY_SRC`.** Growth cannot GPU-copy the retained prefix.  
**No `MAP_WRITE` / `mappedAtCreation`.**  
**STORAGE** is required so decimation compute can read raw points.

### 3.2 `setSeries` path

```
pointCount → grow GPU buffer if needed → pack into staging
  → (optional y-only CPU pack when x channel matches)
  → FNV hash of packed floats
  → if same N + same hash + same buffer + linear layout: return (no writeBuffer)
  → else full writeBuffer of N×8 bytes
  → store entry with ringStart=0, ringCapacityPoints=0  ⚠️ always linearizes
```

**CPU copies before GPU:**

| Input | Staging pack | Extra | GPU transfer |
|-------|--------------|-------|--------------|
| Object/tuple `DataPoint[]` | Full pack loop | O(N) FNV | Full N×8 |
| `XYArraysData` | Full pack loop | O(N) FNV | Full N×8 |
| Interleaved `Float32Array` | **Still element copy** into staging | O(N) FNV | Full N×8 |
| Y-only rewrite | O(N) x-compare + y write | O(N) FNV | **Still full N×8** |
| Identical content, new ref | Full pack + hash | — | **0** if hash matches |
| Same data **ref** via coordinator cache | **Never enters setSeries** | — | 0 |

There is **no** “source is already packed Float32 → `writeBuffer` directly” path. Staging is mandatory for hash, ring, and reuse contracts.

Y-only optimization is documented residual (`createDataStore.ts` ~368–370): WebGPU has no strided partial upload, so GPU bandwidth still scales with N even when only y changed.

### 3.3 `appendSeries` path

Shared plan: `planMaxPointsWindow` in `src/data/maxPointsWindow.ts`.

| Branch | Condition | GPU upload |
|--------|-----------|------------|
| Empty | `newPointCount === 0` | none |
| Growth | `targetBytes > capacity` | later full upload of retained window |
| Strict replace | new batch alone ≥ `maxPoints` | full write of kept tail |
| **Steady ring** | maxPoints, no growth, not strict | **O(k)** modular write (1–2 `writeBuffer`s if wrap splits) |
| **Pure linear ranged** | never been ring, no growth, no drop | **O(k)** single ranged write at `prev×8` |
| Rebuild | leave-ring, capacity change, oversized→ring, growth fallthrough | full upload of retained window |

**Growth path (actual code):**

```
destroy old GPU buffer
create larger buffer (no COPY_SRC)
new Float32Array staging
linearizeStagingChronological O(prev) on CPU
pack new points
writeFullPointsToGpu O(next)  // full retained window
```

**AGENTS.md claim that growth “self-submits a GPU-to-GPU copy” is false.** There is no `copyBufferToBuffer` anywhere in production series code. That is **doc drift**, not an intentional growth design.

### 3.4 Fast path gate (above DataStore)

DataStore is format-agnostic. Whether append is used at all is decided in `flushPendingAppends` (`createRenderCoordinator.ts` ~2099–2187):

```
canUseFastPath =
  series is line
  AND (
    kind === 'fullRawLine'          // sampling==='none' AND full-span zoom
    OR kind === 'gpuDecimationRaw'
    OR (kind === 'unknown' AND GPU-decimation-eligible)
  )
  AND (GPU path OR (sampling==='none' AND full-span zoom))
```

Then:

```
dataStore.appendSeries(index, cartesianData, { maxPoints? })
appendedGpuThisFrame.add(index)   // skips setSeries later this frame
```

If the gate fails (CPU LTTB under zoom, scatter, candle, etc.), append only mutates **CPU runtime columns**; next `prepareSeries` does full `setSeries` re-upload.

### 3.5 Thin path (zero-copy coordinator view)

When `canUseFastPath && maxPoints && tooltip.show === false`:

- After modular append, coordinator binds `runtimeRawDataByIndex` to `StagingRingView` over DataStore staging
- Avoids dual-packing into `RingXYColumns` Float64 columns
- `prepareSeries` must **not** `setSeries` that view (`renderSeries.ts:204–206`)

This delivered SciChart-like FIFO streaming parity (see `docs/plans/2026-07-16-scichart-fifo-1m-double-ingest.md`). It remains a **special case**, not the default residency model.

When tooltip is **on**, dual residency remains: pack into staging/GPU **and** pack into ring/mutable columns for hit-test.

---

## 4. Prepare / sample / zoom / animation paths

**Files:** `src/core/renderCoordinator/render/renderSeries.ts`, `src/core/createRenderCoordinator.ts`

### 4.1 `setSeriesIfChanged` (P1-2)

```typescript
// Skip StagingRingView entirely (already GPU-backed)
// Skip if (data ref, xOffset) match lastSetSeriesCache
// Else dataStore.setSeries(...)
```

Steady-state static / hover frames with stable data refs: **zero** series `writeBuffer`s for lines.

### 4.2 GPU decimation vs CPU sampling

**Eligibility** (`src/data/gpuDecimationEligibility.ts`) — all of:

1. `type === 'line'`
2. **Not** line+`areaStyle` (fill must share sampled data with stroke)
3. `sampling ∈ {lttb, min, max}` — default resolves to **`lttb`** (`OptionResolver.ts:1298–1300`)
4. No null gaps in raw

**There is no `'auto'` sampling enum value.** Public `SeriesSampling` is `none | lttb | average | max | min | ohlc`. Docs/AGENTS/warning messages that say `auto` are stale; decimation comments mention mapping `auto→lttb` that is not in the type system.

| | GPU decimation | CPU sampling |
|--|----------------|--------------|
| What lives in DataStore | **Entire raw series** | Sampled (or full if under threshold / `none`) |
| Upload on zoom | **None** if ref stable | Full **visible sample** each resample |
| Upload on append (eligible) | Ranged raw append | Often full re-upload of resampled series |
| Draw buffer | Compute output (bucket count) + `pointCountOverride` | DataStore buffer directly |

Three call sites must stay aligned: `recomputeRuntimeBaseSeries`, `recomputeRenderSeries`, `prepareSeries`. Drift draws raw as if sampled (visually wrong).

### 4.3 Zoom

- Immediate: slice already-sampled baseline for UI (`sliceRenderSeriesDue`)
- Debounced ~100ms: `recomputeRenderSeries` with ±10% buffer zone and threshold `baseT / spanFrac` (cap 32×, abs 200k)
- GPU path: keep full raw; compute scopes via `visibleStart/visibleEnd`

**CPU path pays full re-upload on every resample.** GPU path is the escape hatch.

**Target-bucket policy mismatch:** CPU uses zoom-scaled threshold; GPU uses fixed `samplingThreshold` (or `2× canvasWidth`) over the **visible** raw span. Density can differ when eligibility toggles (e.g. add/remove `areaStyle`).

### 4.4 Animation (Story 5.17)

Interpolation reuses a **stable** array and mutates values in place. Every frame with `updateP < 1`:

```
lastSetSeriesCache.clear()
filterGapsCache.clear()
area/bar invalidateGeometry()
```

→ full pack + FNV + `writeBuffer` every animation frame (correctness; without this, frame 1 would stick).

Cap: series with `n > 20_000` skip per-point lerp and jump to final data (one full upload, not N-frame).

### 4.5 Critical contract bug: post-append cache without re-seed

```2496:2501:src/core/createRenderCoordinator.ts
      // Invalidate cache for this series since data has changed.
      lastSampledData[seriesIndex] = null;
      lastSetSeriesCache.delete(seriesIndex);
      filterGapsCache.delete(seriesIndex);
```

**Same frame:** OK via `appendedGpuThisFrame` (prepare skips setSeries).  
**First idle frame after streaming:** cache miss → `setSeries` on full series → **forces `ringStart=0, ringCapacityPoints=0`** → modular ring destroyed, full N×8 re-upload, staging view desync risk.

`setSeries` is structurally incompatible with modular rings. Only `StagingRingView` is guarded; other modular shapes and cache-miss paths can still linearize.

**Fix direction:** after successful `appendSeries`, **re-seed** `lastSetSeriesCache` with the runtime raw ref (or a sentinel that means “GPU already current”); never call linearizing `setSeries` on an active ring unless intentional rebuild.

### 4.6 Cold-start kind tagging

`kind === 'unknown'` only unlocks fast path for **GPU-eligible** lines, not `sampling: 'none'`. Until one `prepareSeries` tags `fullRawLine`, pure streaming with `sampling: 'none'` may full-upload the whole series every frame after append.

Zoomed + `sampling: 'none'` tags `other`, not `fullRawLine` — append while zoomed always full re-uploads even though data is “raw.”

---

## 5. Per-renderer upload patterns

### 5.1 Summary table

| Renderer | Data source | CPU expansion | Geometry cache | Uniforms every prepare | Bind group |
|----------|-------------|---------------|----------------|------------------------|------------|
| **Line** | DataStore / decimation output | None (GPU expands segments) | N/A | Always VS+FS | **Cache by buffer identity** |
| **Area** | Own VERTEX | **N → 2N** verts for strip | Yes (`boundDataRef`) | Always | Static |
| **Bar** | Own instances | 1:1 domain pack | Yes (layout signature) | Always | Static |
| **Scatter** | Own instances | 1:1 (xy or xy+r) | **No** | Always | Static |
| **Candle** | Own instances | 1:1 **clip-space** | **No** | Always | Static |
| **Pie** | Own instances | 1:1 slices | No | Always | Static |
| **Grid / Axis** | Own small VERTEX | Fixed by tick count | Via overlay memo | When prepared | Static |
| **Decimation** | Reads DataStore; writes output | GPU N→B | Signature dirty-gate dispatch | **Always** (even if not dirty) | Cache by buffers |
| **Scatter density** | DataStore + bins | GPU binning | Dirty-gate (incomplete) | Always | Rebuild on buffer change |
| **Crosshair** | StreamBuffer | Small segments | None | When shown | Static |

### 5.2 Steady-state line chart (happy path)

Assumptions: 1 eligible line, static data, no pointer, full-span, memoized overlays.

| Call site | Steady-state writes | Bytes |
|-----------|---------------------|-------|
| DataStore | **0** (cache hit) | — |
| Line uniforms | 2 | ~96 B |
| Decimation uniforms | 1 (always) | 32 B |
| Decimation dispatch | 0 (not dirty) | — |
| Grid / axes | 0 (memo skip) | — |
| **Total** | **~3–5 tiny uniform writes** | **&lt; 200 B** |

This is excellent. The architecture problem is that **scatter, candle, animation, growth, and idle-after-append leave this path**.

### 5.3 Biggest forced re-upload offenders

1. **Scatter points** (`createScatterRenderer.ts:448–552`) — full instance pack + `writeBuffer` every prepare even on pure pan/zoom. Const-radius path halves stride but still re-uploads. Bar/area already prove identity caches work.

2. **Candlestick** (`createCandlestickRenderer.ts:505–572`) — packs **clip space** every prepare. Any zoom/pan forces O(N) CPU pack + full instance upload. Should mirror bar domain packing.

3. **Area** — N→2N CPU expansion and **fresh `Float32Array` allocation** on every geometry rebuild; exact-size buffer growth (no pow2). Line+`areaStyle` dual-packs (DataStore for stroke + area verts for fill) and forces **CPU** sampling (GPU decimation disabled).

4. **Scatter density dirty bug** (`createScatterDensityRenderer.ts:549–599`) — tracks buffer identity, point count, visible indices, bin size, scissor, canvas size, normalization — **not scale affine, not content hash**. Y-only domain change with stable X indices can leave **stale bins** while uniforms update. Equal-N content rewrite with same buffer identity can skip recompute.

### 5.4 Bind groups and render bundles

- **Line + decimation:** rebuild bind group only when buffer **identity** changes (survives in-place `writeBuffer` and most growth until realloc). Matches AGENTS.md; do not reintroduce per-frame `createBindGroup`.
- **Most other renderers:** bind groups bind only uniforms/fixed buffers, created once.
- **No `GPURenderBundle` usage in the repo.** Overlay “bundle reuse” is actually `OverlayPrepareMemo` skipping prepare. AGENTS.md language is wrong.

### 5.5 `createStreamBuffer`

- Double-buffered fixed-capacity VERTEX slots, word-diff ranged writes, full-write heuristics.
- **Only caller:** `createCrosshairRenderer` (tiny geometry).
- **Not** the series streaming engine. Useful design reference; orthogonal to DataStore.

---

## 6. Memory ownership model

### Typical cartesian series = up to 3–4 copies

| Layer | Location | Format | Purpose |
|-------|----------|--------|---------|
| 1 | Consumer / `runtimeRawDataByIndex` | Often Float64 columns, ring, or caller ref | Bounds, hit-test, sampling input |
| 2 | `DataStore.stagingBuffer` | Interleaved Float32 | Pack target, ring layout, content hash |
| 3 | `DataStore` GPU buffer | Same layout | Draw / compute |
| 4 | ChartGPU hit-test store | Separate columns | Tooltip / `hitTest` (when maintained) |

**Yes: CPU retains full copies while GPU has a copy.** Staging is intentional for append/ring/hash, not accidental — but it is a **constant ~2× CPU RAM** tax versus “GPU only + domain index.”

Thin path proves zero-copy streaming is viable when interaction contracts allow Float32 staging precision.

### Supporting mechanisms

| Mechanism | Production effectiveness |
|-----------|--------------------------|
| `cheapCartesianContentStamp` / `cheapOHLCContentStamp` | **Effective** O(1) dirty tokens for setOption; not content fingerprints |
| `hashCartesianSeriesData` / `hashOHLCSeriesData` | **Dead** production path (tests only) |
| `isYOnlyRewriteAgainstStaging` + `packYOnlyInto` | **Partial** — CPU y-only pack; GPU still full N×8 |
| `maxPointsWindow` / ring FIFO | **Effective** after ring rewrite; shared plan across layers |
| DataStore FNV `hash32` | **Effective** dirty token for decimation; salted on ring drop (not a true content fingerprint after wrap) |

---

## 7. Dead code, abandoned work, doc drift

| Item | Status |
|------|--------|
| `packDataPoints` / `packOHLCDataPoints` | Production-dead; real packing is `packXYInto`. Benchmarks may still use the dead path. |
| `hashCartesianSeriesData` / `hashOHLCSeriesData` | Production-dead; only cheap stamps + tests |
| `maxPointsSoftLimit` | Deprecated alias of peak retention |
| Bar `dataStore` prepare arg | `void dataStore` residue |
| `createStreamBuffer` for series | Never wired; crosshair only |
| Soft 2× window policy | Replaced by fixed ring |
| Performance canvas Phase 1 “storage buffer migrations” / `mappedAtCreation` | Marked complete in places; **not implemented** in live code |
| GPU copy on growth | Documented as intentional in AGENTS.md; **never landed** |
| Sampling `'auto'` | Not in `SeriesSampling`; default is `lttb` |
| AGENTS “GPURenderBundle” for grid/axis | False; overlay memo only |
| Dual `getCompilationInfo` blocks in decimation compute | Redundant noise |

---

## 8. Intentionally bottlenecked vs accidental

### By design (conscious tradeoffs)

| Design | Why |
|--------|-----|
| CPU dual/triple residency | Tooltips, bounds, sampling, Float32 time rebase need domain data |
| Thin path only when tooltip off | StagingRingView is Float32; hit-test prefers Float64 dual-store |
| Y-only still full interleaved upload | WebGPU has no strided partial `writeBuffer` |
| Animation clears caches every frame | Interpolation mutates under stable ref; skip would freeze GPU |
| GPU decimation: line only, no null gaps, no `areaStyle` | Shader/topology limits; fill+stroke must share sampled data |
| `writeBuffer` as default | Correct per WebGPU guidance |
| Overlay memo / tooltip ~30 Hz | Cap interaction CPU |
| Geometric growth, no shrink | Amortize realloc; free only on dispose |
| 2-pass MSAA (main 4× / overlay 4×) | Quality + fill; do not reintroduce third pass; never use sampleCount 2 |

### Accidental / bugs / false contracts

| Severity | Issue |
|----------|-------|
| **Critical** | Scatter density dirty omits scale affine + content version |
| **High** | Idle-after-append cache delete linearizes ring via `setSeries` |
| **High** | Growth = destroy + full CPU re-upload (no GPU copy) |
| **High** | Scatter / candle re-pack every prepare |
| **Medium** | Area exact-size thrash + N→2N + dual pack with line stroke |
| **Medium** | `sampling: 'none'` cold kind / zoomed append not ranged |
| **Doc** | AGENTS growth self-submit, render bundles, sampling `auto` |

---

## 9. Scenario cost model

| Scenario | Ideal bus | Actual |
|----------|-----------|--------|
| Static eligible line, stable ref | 0 | **0** ✓ |
| Hover / axes-only setOption | 0 series | **0** series ✓ |
| Pan zoom, GPU-eligible line | 0 raw | **0** raw + compute if window changes ✓ |
| Stream append k (line fast path, warm) | k×8 | **k×8** while streaming ✓ |
| First idle frame after stream | 0 | **Full N×8 + ring reset** ✗ |
| Growth past pow2 (unbounded) | k×8 + GPU copy | **Full N×8 from CPU** ✗ |
| Static scatter / candle + hover | 0 | **Full instance rewrite** ✗ |
| Zoom pan, CPU LTTB line | 0 (if prior sample OK) | **Full visible sample upload** on debounce ✗ |
| Update animation N≤20k | dual-buffer / GPU lerp | **Full upload every frame** (by design) |
| FIFO 1M×5 tooltip-off | O(append) | **~SciChart parity** after thin path ✓ |
| Density y-only zoom | recompute bins | **May skip (bug)** ✗ |
| Line+areaStyle large N | 1 raw + GPU fill | CPU sample + DataStore + 2N area verts ✗ |

---

## 10. What must be rewritten vs incremental

### Do **not** rewrite (keep)

- DataStore ring FIFO + ranged append  
- GPU decimation single eligibility gate + modular index + `pointCountOverride`  
- `setSeriesIfChanged` / presentation setOption skip  
- Bind-group-by-buffer-identity  
- Bar domain-space geometry cache (template for others)  
- 2-pass MSAA + overlay prepare memo  
- `writeBuffer` as default upload API  

### Structural redesign (upload policy — not a greenfield chart engine)

The missing abstraction is a **single residency + upload policy** for all series:

```
SeriesResidency
  staging + GPU buffer + ring layout + contentVersion + lastDataRef
        │
UploadPolicy
  skip | rangedAppend | fullRewrite | growWithGpuCopy | yOnlyPack
        │
GPU transforms
  decimation | density binning  (dirty-gated on version + window + scale)
        │
Renderers
  bind storage/instance + small uniforms only
  (no private pack-every-frame universes)
```

Coordinator should shrink toward options, layout/scales, interaction, and pass encode — not own divergent per-type upload rules forever.

### Prioritized recommendations

#### P0 — Correctness

1. **Scatter density dirty signature:** include scale affine (`ax,bx,ay,by` or equivalent) **and** DataStore content hash / contentVersion. Force dirty on any `setSeries` for that index.
2. **Post-append cache re-seed:** after successful `appendSeries`, re-seed `lastSetSeriesCache` so idle frames do not call linearizing `setSeries`. Add an explicit “never linearize active ring” assertion in DataStore or a ring-aware set path.

#### P1 — Upload unification (next performance tier)

3. **Growth with GPU copy:** add `COPY_SRC`, `copyBufferToBuffer` retained prefix, ranged write of new points, destroy old after work is enqueued (pending-destroy if batched into frame encoder). Or document `maxPoints` as mandatory for multi-million streams.
4. **Scatter points → identity geometry cache** (mirror bar/area): skip instance `writeBuffer` when data ref + size mode stable; uniforms-only on zoom. Longer-term: DataStore storage + storage-buffer scatter shader like line.
5. **Candlestick → domain instances + geometry cache:** transform in VS; cache category step; drop clip-space pack every frame.
6. **Area:** pow2 growth + reused staging; then share line/decimation storage buffer (unlocks GPU decimation for line+`areaStyle` once fill reads the same buffer).
7. **Default thin residency** for streaming (staging-backed views even with tooltips where Float32 precision is acceptable, or domain index over staging).

#### P2 — Residual SciChart rewrite gaps

8. True partial y-channel strategy (second buffer, compute rewrite, or accept full interleaved write only when y-only is detected without full hash when possible).
9. Zoom CPU path: draw previous sample under clip during pan; re-upload only on debounce for non-GPU series.
10. Update animation dual-buffer / GPU lerp to stop N-frame full re-upload.
11. Direct `writeBuffer` when input is already interleaved Float32, `xOffset===0`, linear, and content version is known dirty from coordinator.
12. Uniform dirty-skip for line/area/bar/decimation (compare affine + color + width).
13. Retire dead packing/hash APIs; fix AGENTS.md + canvas status claims; retarget benchmarks to `packXYInto` + DataStore.

#### P3 — Hygiene

14. Constant identity mat4 / color scratch for grid/axis/crosshair (eliminate per-prepare `ArrayBuffer` churn).
15. Remove dual compilation-info blocks in decimation compute.
16. Align warning strings with real sampling enum (`lttb`, not `auto`).

---

## 11. Key file map

| Path | Role |
|------|------|
| `src/data/createDataStore.ts` | Primary GPU buffers, ring, append/set, hash |
| `src/data/cartesianData.ts` | Formats, `packXYInto`, rings, `StagingRingView` |
| `src/data/maxPointsWindow.ts` | Shared FIFO capacity policy |
| `src/data/seriesContentHash.ts` | Cheap stamps (prod) + full hash (dead) |
| `src/data/seriesRewriteDetect.ts` | Y-only / index-x helpers |
| `src/data/createStreamBuffer.ts` | Overlay streaming only |
| `src/data/gpuDecimationEligibility.ts` | Single GPU sample gate |
| `src/data/packDataPoints.ts` | Dead packing helpers |
| `src/core/createRenderCoordinator.ts` | Append flush, caches, zoom, animation, submit |
| `src/core/renderCoordinator/render/renderSeries.ts` | `setSeriesIfChanged`, decimation swap |
| `src/core/renderCoordinator/render/overlayPrepareMemo.ts` | Grid/axis prepare skip (not render bundles) |
| `src/core/renderCoordinator/gpu/textureManager.ts` | 2-pass MSAA textures |
| `src/renderers/createLineRenderer.ts` | Gold path consumer |
| `src/renderers/createDecimationCompute.ts` | GPU sample + ring uniforms |
| `src/renderers/createScatterRenderer.ts` | Per-prepare instance pack |
| `src/renderers/createScatterDensityRenderer.ts` | Density dirty gap |
| `src/renderers/createCandlestickRenderer.ts` | Clip-space pack |
| `src/renderers/createAreaRenderer.ts` | Secondary verts N→2N |
| `src/renderers/createBarRenderer.ts` | Domain cache template |
| `src/ChartGPU.ts` | Hit-test dual-store relief |
| `docs/plans/2026-07-16-scichart-fifo-1m-double-ingest.md` | FIFO parity win |
| `docs/scichart-vs-chartgpu-local-baseline.md` | Pre-fix baselines |

---

## 12. Bottom line

1. **The line gold path is correct WebGPU.** Keep it. Extend it. Do not replace it with mapAsync cargo cult.

2. **The product is type-asymmetric.** Scatter, candle, and area still live in a second upload universe that re-pays pack+bus on frames that should be uniforms-only.

3. **The highest-leverage correctness bugs** are (a) scatter-density dirty gate and (b) idle-after-append ring destruction via linearizing `setSeries`.

4. **The highest-leverage performance unlocks** are (a) growth GPU copy or mandatory maxPoints, (b) scatter/candle domain identity caches, (c) area sharing line storage, (d) default thin residency for streaming.

5. **No full greenfield rewrite is required.** Rewrite the **residency + upload policy layer** so every series type rides the gold path. Keep shaders, ring FIFO, decimation, 2-pass frame graph, and `writeBuffer` as the default transfer API.

6. **Doc debt is actively harmful** — AGENTS claims (GPU growth copy, render bundles, sampling `auto`) and canvas “completed” marks that never landed will send the next performance pass down dead ends. Treat those as first-class fix targets alongside code.

---

## Appendix A: WebGPU Fundamentals → ChartGPU mapping

| Fundamentals lesson | ChartGPU application |
|---------------------|----------------------|
| Copying data (`writeBuffer`, map, `mappedAtCreation`, `copyBufferToBuffer`) | Series exclusively `writeBuffer`; growth should add `copyBufferToBuffer` |
| Memory layout (alignment, struct packing) | Point stride 8; uniforms 16/256-aligned; grid dynamic offsets |
| Optimization (shared uniforms, less work, less traffic) | Line already shares DataStore; scatter/candle re-do work; uniform dirty-skip missing |
| How it works (CPU/GPU separation, massively parallel independent iterations) | Decimation/density correctly stay on GPU; CPU LTTB on every append is the anti-pattern |
| Multisampling / resources | 2-pass MSAA (main 4× / overlay 4×) is a bandwidth cost independent of upload |

## Appendix B: Representative copy counts

### Static line, same data ref, axes-only re-render
`lastSetSeriesCache` hit → **0 pack, 0 writeBuffer**

### Full rewrite line, new array every frame, N points
1. App allocates new series data  
2. (Optional) CPU sample → new array  
3. `packXYInto` → staging (copy #1, N×8)  
4. FNV scan staging  
5. `writeBuffer` → UA staging → GPU (copy #2–3, N×8)

### Streaming append, fast path, capacity fits, k new points
1. App batch  
2. `packXYInto` into staging tail (k×8)  
3. Incremental FNV on k words  
4. Ranged `writeBuffer` (k×8 only)

### Streaming + maxPoints + tooltip on
Same as above for GPU **plus** pack into Float64 ring columns → dual residency

### Streaming + maxPoints + tooltip off (thin path)
GPU path as above; `StagingRingView` reuses staging — **no** second pack

### Growth on unbounded stream
Destroy GPU buffer → new buffer + staging → linearize O(N) → pack k → full `writeBuffer` O(N+k)

---

*End of review. Generated from multi-agent deep exploration of the live tree on 2026-07-15; all severity claims are grounded in file:line evidence in `src/`.*
