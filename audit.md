# ChartGPU WebGPU Performance Audit

**Date:** 2026-07-15  
**Scope:** Current `src/` tree (TypeScript source of truth for development).  
**Method:** Static code review of upload, render-pass, pipeline, compute, sampling, and interaction paths, grounded in the [W3C WebGPU specification](https://www.w3.org/TR/webgpu/) and ChartGPU’s own performance guidance (`docs/performance.md`, `AGENTS.md` learned facts).

**Important:** Profile recommendations against a **production** examples build (`bun run build:examples && bun run preview:examples`), not the Vite dev server. Dev mode incurs large GPU-process overhead that masks real costs.

---

## Severity legend

| Severity | Meaning |
|----------|---------|
| **P0** | Correctness bug and/or major runtime cost on common paths; fix first |
| **P1** | High impact on large datasets, streaming, or hover; clear wins |
| **P2** | Medium impact, architectural debt, or measurable but secondary cost |
| **P3** | Low impact, polish, or opportunistic cleanup |

---

## Executive summary

ChartGPU’s frame architecture is fundamentally sound for a browser charting library:

- One command encoder and **one `queue.submit()`** per chart frame
- MSAA resolve with **`storeOp: "discard"`** on multisampled attachments (spec-aligned for tile GPUs)
- Line series path uses domain-space storage buffers + uniform transforms
- Streaming append can do ranged `writeBuffer` when capacity and sampling allow
- `PipelineCache` dedupes shader modules across charts

However, several high-impact issues remain in **current `src/`**, and **docs/AGENTS.md describe optimizations that are not present in source** (GPU decimation, line bind-group cache by buffer identity, grid dynamic-offset uniforms, overlay prepare memo / render bundles, 2-pass collapse, tooltip 30 Hz throttle). Stale `dist/` still references decimation types — treat `src/` as authoritative for this audit.

The highest-leverage themes:

1. **CPU sampling remains the primary large-data path** (no GPU decimation in `src/`).
2. **Hover drives full GPU frames** with duplicate hit-testing.
3. **Per-frame GPU object / upload churn** (line bind groups, area full re-upload, `setSeries` pack-before-skip).
4. **Grid multi-batch uniform writes inside `render()`** (correctness + wasted queue traffic).
5. **Dual 4× MSAA + 3-pass architecture** as the main GPU bandwidth cost.

---

## Spec grounding (performance-relevant WebGPU rules)

Findings below map to these WebGPU/spec behaviors:

| Spec topic | Performance implication | ChartGPU relevance |
|------------|-------------------------|-------------------|
| `queue.writeBuffer` | Data may cross script → staging → GPU memory; size/offset multiples of 4 | All uploads |
| Map / staging | Mapped buffers cannot be used by GPU; double-buffer streaming | `createStreamBuffer` good; DataStore growth is full re-upload |
| Pipeline creation | Sync `createRenderPipeline` may stall device timeline at first use; prefer async | Only sync paths |
| `compilationHints` | Allow early shader compile | Not used |
| Render pass load/store | `"clear"` often cheaper than `"load"` on TBDR; `"discard"` avoids writing MSAA back | Main/overlay MSAA good; top overlay correctly uses `"load"` |
| Render bundles | Encode once, `executeBundles` many times to cut JS encode cost | Not used |
| Dynamic uniform offsets | Must align to `minUniformBufferOffsetAlignment` (often 256) | Grid multi-color needs this pattern |
| Submit batching | Prefer one submit over many | Chart frame does one submit |
| Timestamp queries | Need `"timestamp-query"` feature | Not requested / not implemented |
| Resource `destroy()` | Don’t rely on GC for GPU memory | Generally followed |
| Request only needed limits | Higher limits can hurt | Default `requestDevice()` |

---

## Already-good patterns (do not regress)

| Pattern | Location | Spec / rationale |
|---------|----------|------------------|
| Single encoder + single `queue.submit` per frame | `createRenderCoordinator.ts` | Avoids multi-submit overhead |
| MSAA `storeOp: "discard"` after resolve | main + overlay passes | Avoids storing multisampled memory |
| Top overlay `loadOp: "load"` on swapchain | top overlay pass | Preserves resolved scene without full clear |
| `DataStore` append fast path (ranged write) | `createDataStore.ts` | Minimizes upload bytes when capacity allows |
| Incremental FNV hash on append | `createDataStore.ts` | Cheap change tracking after append |
| Content-hash skip of GPU upload | `createDataStore.ts` | Avoids redundant `writeBuffer` when bits match |
| Uniform 16-byte sizing + 4-byte write checks | `rendererUtils.ts` | Matches writeBuffer / uniform layout rules |
| CPU uniform scratch reuse (line, scatter, etc.) | renderers | Reduces GC on uniform path |
| StreamBuffer double-buffer + word-diff uploads | `createStreamBuffer.ts` | Avoids writing a buffer the GPU may still read |
| Scatter density: dirty gate + bind group cache | `createScatterDensityRenderer.ts` | Skip compute when stable |
| Texture manager dimension-gated realloc | `textureManager.ts` | No per-frame texture churn when size stable |
| Pipeline / shader module cache | `PipelineCache.ts` | Cuts compile cost across multi-chart dashboards |
| Zoom resample debounce (~100 ms) | coordinator | Caps CPU LTTB during pan |
| Append flush coalescing (rAF) | coordinator | Batches streaming updates |
| Animation point cap (20k) | coordinator | Bounds interpolation CPU |
| Monotonic hit-test binary search | `findNearestPoint.ts` | O(log n) + local expand for sorted series |
| Explicit `buffer.destroy()` / dispose chains | DataStore, renderers, GPUContext | GPU memory reclaim |

---

## Findings by severity

### P0 — Critical

#### P0-1. Grid multi-batch fragment colors via `queue.writeBuffer` inside `render()`

| | |
|--|--|
| **Where** | `src/renderers/createGridRenderer.ts` — `render()` batch loop |
| **What** | For each batch, allocates a color `ArrayBuffer`, calls `writeUniformBuffer` → `queue.writeBuffer` on the **same** FS uniform buffer, then `draw()`. Triggered when horizontal and vertical grid colors differ (`renderOverlays.ts` two-batch prepare with `append: true`). |
| **Why it matters** | Queue writes are not sequenced inside the render pass the way draw calls are. Multiple writes into one uniform buffer for different draws in the same submitted command buffer commonly resolve so **all draws see the last written color** (correctness). Even when colors match, this is wasted queue traffic and GC. Spec-aligned fix: pack per-batch colors into a single uniform buffer with **`hasDynamicOffset: true`** and 256-byte-aligned slots (`minUniformBufferOffsetAlignment`), or store color in vertex data. |
| **Spec** | Uniform dynamic offsets; queue write ordering vs command buffers |
| **Fix direction** | Dynamic-offset FS uniform ring; never call `writeBuffer` between draws that share one buffer for different values |

---

#### P0-2. CPU LTTB / sampling is the only large-data path in `src/` (GPU decimation missing)

| | |
|--|--|
| **Where** | `recomputeRuntimeBaseSeries` / `recomputeRenderSeries` in `createRenderCoordinator.ts`; `sampleSeriesDataPoints` in `src/data/sampleSeries.ts`; `OptionResolver` sampling |
| **What** | No `src/shaders/decimation.wgsl`, no eligibility module, no `createDecimationCompute`. Baseline and zoom paths always call CPU `sampleSeriesDataPoints` for line/area/etc. `dist/` still ships decimation `.d.ts` artifacts; `AGENTS.md` documents Stretch S1 GPU decimation — **not in current source**. |
| **Why it matters** | Default `sampling: 'lttb'` with large series is **O(n)** CPU on baseline rebuild and zoom resample. This is the dominant cost for “millions of points” product claims when sampling is enabled. GPU compute decimation would keep raw data on GPU and emit bucket samples without main-thread LTTB. |
| **Spec** | Compute dispatches as separate usage scopes; storage buffers for raw + output |
| **Fix direction** | Land GPU decimation in `src/` with a single eligibility gate used at baseline, zoom, and prepare/swap sites |

---

#### P0-3. Streaming with default sampling defeats incremental GPU append

| | |
|--|--|
| **Where** | `createRenderCoordinator.ts` — `canUseFastPath` requires `sampling === 'none'` + full-span zoom + `fullRawLine`; `flushPendingAppends` always `recomputeRuntimeBaseSeries()` |
| **What** | With `sampling: 'lttb'` (default), every append flush re-samples the **entire** series on CPU and forces full re-upload path. Library already warns in console for this case. |
| **Why it matters** | Live dashboards using recommended streaming + LTTB pay O(n) CPU + full `writeBuffer` per batch — the opposite of “append-only” performance. |
| **Spec** | Prefer ranged uploads; minimize PCIe/staging traffic |
| **Fix direction** | GPU decimation on raw appends, or incremental LTTB/windowed sampling; expand fast path when GPU holds raw data |

---

#### P0-4. Pointer move triggers a full chart `render()` every time

| | |
|--|--|
| **Where** | `onMouseMove` → `requestRender()` in `createRenderCoordinator.ts` |
| **What** | Hover updates pointer state then requests a full frame: prepare series, multi-pass GPU encode, DOM axis/annotation labels, tooltips. No interaction-only pass; no ~30 Hz throttle in `src/` (mentioned in docs, not implemented). |
| **Why it matters** | Continuous mousemove can force ~60 full GPU frames/sec even when series data is static. Crosshair/highlight only need overlay work + light hit-test, not full series re-prepare/upload checks. |
| **Spec** | Encode/submit cost is pure waste if attachments/data unchanged |
| **Fix direction** | Throttle hit-test/tooltip; optional overlay-only encode path; skip series prepare when data/scales unchanged |

---

#### P0-5. Duplicate `findNearestPoint` per hover frame

| | |
|--|--|
| **Where** | Tooltip path in `createRenderCoordinator.ts`; highlight path in `renderOverlays.ts` |
| **What** | Both call `findNearestPoint` on the same pointer position and series set in the same frame. |
| **Why it matters** | Up to **2×** hit-test cost on every hover frame (including O(n) for non-monotonic series). |
| **Fix direction** | Compute once per frame; share result for tooltip + highlight |

---

### P1 — High

#### P1-1. Line renderer recreates `GPUBindGroup` every `prepare()`

| | |
|--|--|
| **Where** | `src/renderers/createLineRenderer.ts` |
| **What** | `device.createBindGroup(...)` every prepare, even when `dataBuffer` identity is unchanged (DataStore only reallocates on growth). |
| **Why it matters** | Bind-group creation is non-trivial CPU + validation work. With N line series, expect N creates per frame on pan/zoom/hover-driven renders. `AGENTS.md` claims cache-by-buffer-identity; **not in source**. |
| **Spec** | Bind groups are immutable objects; safe to reuse while bound resources live |
| **Fix direction** | Cache `boundDataBuffer !== dataBuffer` (same pattern as candlestick / density) |

---

#### P1-2. `DataStore.setSeries` packs and hashes before the unchanged early-out

| | |
|--|--|
| **Where** | `src/data/createDataStore.ts` — `setSeries` |
| **What** | Always `packCartesianData` (new `ArrayBuffer`) + full FNV hash, then compares hash/pointCount and may skip `writeBuffer`. |
| **Why it matters** | On static frames, `prepareSeries` still calls `setSeries` for every line series that did not append this frame → **O(n) pack + hash with zero GPU benefit**. |
| **Spec** | Avoid unnecessary staging copies into the writeBuffer path |
| **Fix direction** | Cheap pre-check (pointCount + data reference / version / precomputed hash); reuse staging buffer; pack only when dirty |

---

#### P1-3. Area series: full CPU vertex rebuild + full `writeBuffer` every prepare

| | |
|--|--|
| **Where** | `src/renderers/createAreaRenderer.ts` |
| **What** | `createAreaVertices` allocates `Float32Array(n*4)` domain vertices and uploads the entire buffer every prepare. Vertices are domain-space; only transform uniforms need to change for zoom/pan. |
| **Why it matters** | Line series already keep domain data in GPU storage and update uniforms. Area (and line+`areaStyle`) redoes O(n) CPU + upload every frame. |
| **Spec** | Prefer stable GPU data + uniform affine transforms |
| **Fix direction** | Share DataStore storage / triangle strip from GPU data, or skip upload when data hash/ref unchanged |

---

#### P1-4. Line + `areaStyle` runs two full data paths

| | |
|--|--|
| **Where** | `src/core/renderCoordinator/render/renderSeries.ts` |
| **What** | Line uploads via DataStore; area fill rebuilds vertices from the same logical series. |
| **Why it matters** | ~2× prepare/upload for filled line charts. |
| **Fix direction** | Shared GPU data + dual draw (fill then stroke) |

---

#### P1-5. Three full-screen passes + dual 4× MSAA color targets

| | |
|--|--|
| **Where** | `textureManager.ts` (`MAIN_SCENE_MSAA_SAMPLE_COUNT = 4`, `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT = 4`); `createRenderCoordinator.ts` main → overlay MSAA blit → top 1× overlay |
| **What** | Per frame: (1) 4× MSAA main → resolve, (2) clear 4× overlay + full-screen blit + annotations → resolve to swapchain, (3) load swapchain for axes/crosshair/highlight. Docs claim 2-pass collapse; **code still has 3**. |
| **Why it matters** | Memory ≈ multiple full-resolution color surfaces (MSAA samples + resolves). Fill-rate and bandwidth dominate simple charts. Quality choice, but primary GPU cost. |
| **Spec** | `storeOp: discard` is already used (good); still pay resolve + blit bandwidth |
| **Fix direction** | Profile quality vs FPS; consider collapsing top overlay into annotation pass with 4× pipelines; optional 2× MSAA; skip overlay MSAA when no annotations |

---

#### P1-6. No render bundles; no overlay prepare memoization

| | |
|--|--|
| **Where** | `renderOverlays.ts`, grid/axis renderers; no `GPURenderBundle` / `executeBundles` in `src/` |
| **What** | Grid and axes re-prepare vertices and `writeBuffer` whenever a frame runs, even if grid area, tick counts, colors, and scale affines are unchanged. Spec promotes bundles for static/repeated draws. |
| **Why it matters** | Hover and pan frames re-encode cheap but non-zero overlay geometry; JS encode cost adds up multi-chart. |
| **Spec** | [Render bundles](https://www.w3.org/TR/webgpu/#render-bundles) — encode once, execute many times |
| **Fix direction** | `OverlayPrepareMemo` signature → skip prepare; optional `GPURenderBundle` for grid/axes |

---

#### P1-7. Redundant multi-stage CPU sampling

| | |
|--|--|
| **Where** | `OptionResolver` samples on resolve; `recomputeRuntimeBaseSeries` samples again; zoom path samples buffered slice again |
| **What** | `setOptions` always runs baseline + zoom recompute even for theme/legend-only changes. |
| **Why it matters** | Extra LTTB/pack on non-data option updates and double work vs resolve for static charts. |
| **Fix direction** | Dirty flags for raw data vs presentation; skip baseline when raw unchanged |

---

#### P1-8. Non-monotonic hit testing is O(n); no domain grid index

| | |
|--|--|
| **Where** | `src/interaction/findNearestPoint.ts` |
| **What** | Binary search only when x is monotonic non-decreasing; else full linear scan. Docs mention WeakMap grid index — **not implemented**. |
| **Why it matters** | Scatter / unsorted series: tooltip + highlight (P0-5) become 2×O(n) per hover frame. |
| **Fix direction** | Lazy domain-space grid / spatial index with WeakMap cache |

---

#### P1-9. Annotation prepare duplicated for MSAA and non-MSAA renderer pairs

| | |
|--|--|
| **Where** | `createRenderCoordinator.ts` — `referenceLineRenderer` + `…Msaa`, marker pair |
| **What** | Both pairs `prepare()` every frame (duplicate instance builds and uploads). |
| **Why it matters** | 2× CPU/GPU prep for the same logical annotations. |
| **Fix direction** | Share instance buffer/upload; dual pipelines only at draw time |

---

#### P1-10. Clip-space instance re-upload every zoom for bar / scatter / candlestick / pie

| | |
|--|--|
| **Where** | `createBarRenderer.ts`, `createScatterRenderer.ts`, `createCandlestickRenderer.ts`, `createPieRenderer.ts` |
| **What** | Instances baked in clip/device space → any scale change rebuilds and full `writeBuffer`. |
| **Why it matters** | Expected tradeoff for instancing simplicity; dominates large scatter/bar zoom. Line’s domain+uniform model scales better. |
| **Fix direction** | Domain instances + uniform transform where possible; or GPU transform |

---

### P2 — Medium

#### P2-1. Synchronous pipeline creation only (no `createRenderPipelineAsync` / `createComputePipelineAsync`)

| | |
|--|--|
| **Where** | `rendererUtils.ts`, `PipelineCache.ts` |
| **What** | All pipelines created via sync APIs. Spec warns that pipeline creation may stall the device timeline between create and first `submit`. |
| **Why it matters** | First chart open / new series type can hitch; multi-chart first paint slower. |
| **Fix direction** | Async create + warm-up after `ChartGPU.create`; keep sync cache hits for hot path |

---

#### P2-2. No `compilationHints` on `createShaderModule`

| | |
|--|--|
| **Where** | `rendererUtils.ts`, `PipelineCache.ts` |
| **What** | Modules created with `{ code, label }` only. |
| **Why it matters** | Missed opportunity for earlier/parallel compile when layout is known. |
| **Spec** | `GPUShaderModuleDescriptor.compilationHints` |
| **Fix direction** | Hints for `vsMain`/`fsMain` when pipeline layout is stable |

---

#### P2-3. Explicit `createPipelineLayout` limits cross-chart pipeline cache hits

| | |
|--|--|
| **Where** | `rendererUtils.ts` (commented tradeoff) |
| **What** | Each renderer creates its own bind group layouts + pipeline layout; cache keys include layout identity. Shader modules still dedupe. |
| **Why it matters** | Shared `PipelineCache` across charts helps modules more than full pipelines. |
| **Fix direction** | Shared bind group layouts at device scope for identical series types |

---

#### P2-4. DataStore buffer growth: destroy + full CPU re-upload (no GPU copy)

| | |
|--|--|
| **Where** | `createDataStore.ts` — `appendSeries` growth path |
| **What** | On capacity growth: destroy old buffer, allocate new, copy staging CPU-side, full `writeBuffer`. Usage is `VERTEX | STORAGE | COPY_DST` — **no `COPY_SRC`**, so GPU `copyBufferToBuffer` is impossible without usage change. |
| **Why it matters** | Streaming growth spikes are O(n) CPU + full upload. Spec/practice: copy retained prefix on GPU, write only the tail. |
| **Fix direction** | Add `COPY_SRC`; encoder or self-submitted `copyBufferToBuffer` for prefix |

---

#### P2-5. Line prepare re-scans bounds every frame (`computeRawBoundsFromCartesianData`)

| | |
|--|--|
| **Where** | `createLineRenderer.ts` |
| **What** | Full data scan for affine setup even when series/data buffer unchanged. |
| **Why it matters** | With `sampling: 'none'` and huge n, pan/zoom CPU is O(n) per series per frame just for bounds. |
| **Fix direction** | Pass cached `rawBounds` from coordinator into prepare |

---

#### P2-6. Scatter density: full bin clear via `queue.writeBuffer` of zero staging

| | |
|--|--|
| **Where** | `createScatterDensityRenderer.ts` — `encodeCompute` |
| **What** | Clears entire bins buffer from CPU staging every dirty compute. |
| **Why it matters** | Large plot × fine binSize → large upload before compute. Prefer GPU clear/compute zero pass. |
| **Spec** | Prefer keeping clear work on GPU timeline when buffers are large |

---

#### P2-7. Dual MSAA annotation path + clear-before-full-screen-blit

| | |
|--|--|
| **Where** | Overlay pass clears MSAA then full-screen blit covers all pixels |
| **What** | Clear bandwidth may be partly wasted when blit is complete coverage. |
| **Why it matters** | Minor on some GPUs; clear is often free on TBDR, not always free elsewhere. |
| **Fix direction** | Profile; consider `loadOp: "clear"` only if blit may not cover; or skip clear if guaranteed cover |

---

#### P2-8. Texture / canvas resize can thrash MSAA targets

| | |
|--|--|
| **Where** | `textureManager.ensureTextures`, `ChartGPU` resize with `Math.round(rect * dpr)` |
| **What** | Any 1px dimension change destroys/recreates 3 large textures + blit bind group. |
| **Why it matters** | Animated layout / fractional DPR can spike memory traffic. |
| **Fix direction** | Hysteresis, pad to multiples of 64, or debounce resize |

---

#### P2-9. GPU timestamp queries not implemented

| | |
|--|--|
| **Where** | `ChartGPU.ts` — `gpuTimingSupported: false`, `gpuTiming.enabled: false` |
| **What** | Device is not requested with `"timestamp-query"`; no `timestampWrites` on passes. Profiler is CPU/wall-clock oriented. |
| **Why it matters** | Hard to know GPU-bound vs CPU-bound in-library (docs/performance.md recommends comparing CPU submit vs GPU time). |
| **Spec** | Optional feature `"timestamp-query"`; resolve query set + map readback |
| **Fix direction** | Feature-detect, request feature, pass-level timestamps, ring-buffer readback |

---

#### P2-10. Owned devices: `requestDevice()` with no elevated limits

| | |
|--|--|
| **Where** | `GPUContext.ts` |
| **What** | Default device limits only; shared devices validated against 32 MiB min buffer sizes. |
| **Why it matters** | Very large series may fail at DataStore rather than requesting higher `maxBufferSize` / storage binding when available. Spec: only request higher limits when needed (good default stance), but document failure modes. |
| **Fix direction** | Optional limit bump for large-data mode; clear errors |

---

#### P2-11. Docs / `AGENTS.md` / `dist` drift vs `src/`

| | |
|--|--|
| **Where** | Workspace facts vs current tree |
| **What** | Documented but missing or different in `src/`: GPU decimation, bind-group cache, grid dynamic offsets, overlay memo/bundles, 2-pass pipeline, tooltip 30 Hz throttle, non-monotonic grid index. |
| **Why it matters** | Agents and humans optimize against phantom code; `dist/` can mislead. |
| **Fix direction** | Align docs with `src/`, or re-land missing optimizations; rebuild `dist` from source |

---

#### P2-12. `connectNulls` → `filterGaps` allocates every prepare frame

| | |
|--|--|
| **Where** | `renderSeries.ts` + `cartesianData.ts` |
| **What** | New filtered arrays every frame when connectNulls is true. |
| **Why it matters** | GC pressure on gap-heavy series. |
| **Fix direction** | Cache filtered series until data changes |

---

### P3 — Low

#### P3-1. No `mappedAtCreation` upload path

All uploads use `queue.writeBuffer`. Acceptable for dynamic charts; for one-shot huge static loads, `mappedAtCreation` can reduce copies on some implementations.

#### P3-2. Power-of-two buffer growth wastes up to ~2× VRAM / staging

`DataStore` geometric growth is intentional to reduce realloc frequency; document memory tradeoff for huge series.

#### P3-3. Per-frame small allocations in overlay renderers

Grid/axis/crosshair/highlight still allocate small `ArrayBuffer`s for colors/identity matrices. Line/scatter already use scratch buffers — extend that pattern.

#### P3-4. `STORAGE` usage on all DataStore series buffers

Only line storage-read and density compute need storage. Extra usage flags can affect validation/limits slightly; split usage by series kind if needed.

#### P3-5. Overlay blit clear-then-cover (see P2-7)

Listed as low when blit is guaranteed full-screen.

#### P3-6. Bar hit-test category sort each layout

`computeBarCategoryStep` may sort all bar x values when hit-testing bars.

#### P3-7. DOM axis/annotation label work on every full render including hover

`renderAxisLabels` / annotation labels run after GPU submit even when only pointer moved.

#### P3-8. PipelineCache / create path creates layouts eagerly

Fine for init; ensure pool growth for new series doesn’t hit mid-interaction frames without warm-up.

---

## Architecture map (current frame)

```
requestRender (rAF)
  └─ render()
       ├─ flush appends / resample (CPU, possibly heavy)
       ├─ prepareOverlays (grid, axes, crosshair, highlight + findNearestPoint)
       ├─ prepareSeries (DataStore setSeries, per-renderer prepare)
       ├─ encodeScatterDensityCompute (optional)
       ├─ mainPass: 4× MSAA → resolve (grid + series + below annotations)
       ├─ overlayPass: 4× MSAA clear + blit + above annotations → resolve swapchain
       ├─ topOverlayPass: load swapchain (highlight, axes, crosshair)
       ├─ queue.submit([one command buffer])
       └─ DOM: axis labels, annotation labels, tooltip (second findNearestPoint)
```

---

## Prioritized remediation roadmap

| Priority | Action | Expected impact |
|----------|--------|-----------------|
| 1 | Fix grid multi-batch uniforms (dynamic offsets / vertex color) | Correctness + small CPU |
| 2 | Interaction path: throttle + single hit-test + avoid full series prepare on hover | Large idle/hover FPS win |
| 3 | Cache line bind groups by buffer identity | CPU win multi-series |
| 4 | `setSeries` cheap dirty check before pack/hash | Large static-frame CPU win |
| 5 | Land GPU decimation in `src/` (or drop docs claiming it) | Primary large-n / streaming win |
| 6 | Area: skip re-upload / share DataStore path | Zoom/pan filled-area win |
| 7 | Overlay prepare memo ± render bundles | Multi-chart encode win |
| 8 | Append growth: `COPY_SRC` + GPU copy | Streaming growth spikes |
| 9 | Pass/MSAA budget (profile 2× vs 4×, pass collapse) | GPU bandwidth / mobile |
| 10 | Async pipeline create + compilationHints + timestamp queries | Startup + observability |

---

## How to verify fixes

1. **Production build:** `bun run build:examples && bun run preview:examples` (port 4173).
2. **Performance baseline harness (preferred):** [`examples/performance-baseline/`](examples/performance-baseline/) — fixed scenarios, FPS + CPU percentiles, JSON report. Establish `benchmarks/baselines/main.json` before changes; compare with `bun run benchmark:baseline:compare`. **Goals + autonomous verification:** [`docs/PERFORMANCE_GOALS.md`](docs/PERFORMANCE_GOALS.md). Operator docs: [`benchmarks/baseline/README.md`](benchmarks/baseline/README.md).
3. **Million-points / ultimate benchmark:** interactive FPS UI for exploratory checks.
4. **Regression matrix:**
   - Static large line, hover only
   - Zoom/pan with `sampling: 'lttb'` and `'none'`
   - `appendData` streaming at 5–60 Hz
   - Multi-chart shared device dashboard
   - Grid with distinct H/V colors (P0-1 correctness)
5. **Chrome WebGPU internals / DevTools:** validate no validation errors after bind-group and dynamic-offset changes.

---

## Finding index (quick reference)

| ID | Severity | One-line |
|----|----------|----------|
| P0-1 | P0 | Grid FS uniforms written per-batch in `render()` (correctness + waste) |
| P0-2 | P0 | GPU decimation absent from `src/`; CPU LTTB primary |
| P0-3 | P0 | Streaming + sampling → full resample/re-upload |
| P0-4 | P0 | Mousemove → full GPU frame |
| P0-5 | P0 | Double `findNearestPoint` per hover frame |
| P1-1 | P1 | Line `createBindGroup` every prepare |
| P1-2 | P1 | `setSeries` pack+hash before skip |
| P1-3 | P1 | Area full vertex rebuild/upload every prepare |
| P1-4 | P1 | Line+areaStyle dual data path |
| P1-5 | P1 | 3 passes + dual 4× MSAA bandwidth |
| P1-6 | P1 | No render bundles / overlay memo |
| P1-7 | P1 | Redundant multi-stage CPU sampling |
| P1-8 | P1 | Non-monotonic hit-test O(n) |
| P1-9 | P1 | Duplicate MSAA/non-MSAA annotation prepare |
| P1-10 | P1 | Clip-space instance re-upload on zoom |
| P2-1 | P2 | Sync-only pipeline creation |
| P2-2 | P2 | No compilationHints |
| P2-3 | P2 | Per-renderer layouts hurt pipeline cache |
| P2-4 | P2 | Append growth full re-upload, no COPY_SRC |
| P2-5 | P2 | Line bounds O(n) every prepare |
| P2-6 | P2 | Density bins cleared via large writeBuffer |
| P2-7 | P2 | Overlay clear before full blit |
| P2-8 | P2 | Resize texture thrash |
| P2-9 | P2 | No GPU timestamp queries |
| P2-10 | P2 | Default device limits only |
| P2-11 | P2 | Docs/dist vs src drift |
| P2-12 | P2 | filterGaps alloc every frame |
| P3-1…P3-8 | P3 | Mapping, PoT waste, small allocs, STORAGE flags, DOM on hover, etc. |

---

## References

- [W3C WebGPU](https://www.w3.org/TR/webgpu/) — buffers, mapping, pipelines, render passes, bundles, queries, limits  
- [W3C WGSL](https://www.w3.org/TR/WGSL/) — resource layout / workgroups  
- Project: `docs/performance.md`, `docs/api/INTERNALS.md`, `AGENTS.md` (treat workspace “learned facts” as aspirational where they diverge from `src/`)  
- Project skill: `.cursor/skills/webgpu-performance/SKILL.md` (spec-distilled checklist used for this audit)

---

*This audit is evidence-based static analysis of the repository state as of the date above. Absolute FPS impact should be confirmed with production-build profiling before prioritizing multi-week work (especially MSAA/pass architecture and GPU decimation).*
