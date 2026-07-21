# Internal modules (Contributor notes)

This document is intentionally **short**. It’s a map to the internal modules that implement ChartGPU behavior, plus a few contracts that are easy to break.

## Where to start

- **Render orchestration (shell)**: [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) → impl [`createRenderCoordinatorImpl.ts`](../../src/core/renderCoordinator/createRenderCoordinatorImpl.ts)
- **Options resolution**: [`OptionResolver.ts`](../../src/config/OptionResolver.ts)
- **Public wrapper**: [`ChartGPU.ts`](../../src/ChartGPU.ts)

## Data pipeline (internal)

- **Data store + GPU uploads**: [`createDataStore.ts`](../../src/data/createDataStore.ts)
- **Series residency + upload policy**: [`seriesResidency.ts`](../../src/data/seriesResidency.ts) — shared verbs (`skip` | `rangedAppend` | `fullRewrite` | `growWithGpuCopy` | `yOnlyRewrite`). **Line** (`prepareSeries` / `setSeriesIfChanged`), **scatter**, and **candlestick** call `resolveUploadPolicy`. Pure append eligibility: [`canRangedAppendLine.ts`](../../src/core/renderCoordinator/data/canRangedAppendLine.ts). Display sample-vs-raw: [`resolveSeriesDisplayData.ts`](../../src/core/renderCoordinator/data/resolveSeriesDisplayData.ts). Area shares line storage when chronological (linear layout or decimation output).
- **`mappedAtCreation`**: Still **unused** in production series paths (default remains `queue.writeBuffer`). Performance canvas task “Use mappedAtCreation for Initial Uploads” is **incomplete** — do not treat as done.
- **Streaming GPU buffers** (double-buffered): [`createStreamBuffer.ts`](../../src/data/createStreamBuffer.ts)
- **CPU downsampling (LTTB helper)**: [`lttbSample.ts`](../../src/data/lttbSample.ts)
- **Content stamps / rewrite detect**: [`seriesContentHash.ts`](../../src/data/seriesContentHash.ts), [`seriesRewriteDetect.ts`](../../src/data/seriesRewriteDetect.ts) — `classifyEqualNYOnlyRewrite` / `isEqualNSortedXYOnlyRewrite` gate equal-N y-only (must not fire for Brownian xy).

### Upload residuals (documented intentionally)

| Residual | Choice | Notes |
|----------|--------|--------|
| **Line DataStore y-only GPU** (2.1) | **Closed (Track C Option B)** | CPU packs y-only when x matches staging; GPU uploads **N×4** dense y + compute-shader rewrites y lanes into interleaved storage (line/area/decimation keep one layout). Full FNV skipped when y-only proved change. Modular ring / length / x-change stay full N×8. **Scatter const-radius** dual-buffer still uploads only N×4 y (Option A). |
| **Scatter Brownian draw** (group 2) | **Closed — fullyCompact + post-resolve SS1** | Full xy rewrite (`sampling: 'none'`); y-only correctly does not activate. `resolveScatterDrawPolicy` fully compacts radius at suite 500k (density LO/HI 0.08/0.30 + N≥250k floor). **Only `fullyCompact`** frames defer to a **post-resolve sampleCount:1** pass (partial blends stay on main 4×). Defer is disabled when any visible **line** series is present so markers stay under strokes (main order: scatter then lines; post-resolve draws scatter before hairline). Main/overlay MSAA stay **4×** for non-deferred content (WebGPU forbids portable sampleCount 2). Hard gate: suite group 2 @ 500k ≥119 Avg FPS. |
| **CPU zoom pan** (2.2) | **Debounced resample** | Non–GPU-eligible series still full-`setSeries` on zoom debounce fire. GPU-eligible lines keep raw resident (zero raw re-upload on pan). Holding previous sample under clip mid-pan is not wired (would need a dedicated hold buffer). |
| **Update animation** (2.3) | **Full re-upload while interpolating** | Identity caches clear every frame (correctness under in-place mutation). N>20k skips lerp. GPU-side lerp dual-buffer is deferred. |

### Full-series rewrite contracts (`setOption` every frame)

1. **Cheap stamps**: On data-ref change, `cheapCartesianContentStamp` / `cheapOHLCContentStamp` (O(1)). Full `hashCartesianSeriesData` is not used on that path. Stamps use a module-global generation counter (dirty tokens only; multi-chart stamp coupling is harmless).
2. **rawBounds modes**: `synthetic` (all axes explicit), `xDataYAxis` (y fixed, x from data), `data` (full scan). Mode is stored so switching axes back to auto under a stable data ref cannot keep synthetic extents.
3. **Dual-store (tooltip off)**: ChartGPU hit-test columns are not rebuilt on every setOption; `hitTestStoreNeedsResync` + resync from coordinator on `hitTest` / tooltip on. Append with `maxPoints` uses the same skip when tooltip off.
4. **Raw ref → promote**: Coordinator stores setOption data by reference; `appendData` promotes via branded owned `MutableXYColumns` (never mutates caller XY arrays).
5. **No double LTTB**: Full data rewrite uses OptionResolver-sampled series; baseline recompute does not re-sample.
6. **Equal-N y-only (group 4)**: `classifyEqualNYOnlyRewrite` → index-sorted + `sampling === 'lttb'` with matching prior sampling/threshold remaps prior LTTB sample y in O(k) (frozen index set; full LTTB on length/x/sampling config change). **Sticky `indexSortedProven`**: one full O(n) `isIndexSortedX` proof is stored on the resolved series; subsequent equal-N frames at the same N skip re-proving when samples still look like x=i (cleared on Brownian / length change). min/max/average always re-sample. Scatter const-radius dual-buffer writes only the y channel. Brownian xy (group 2) and unsorted line (group 3) must stay on the full path — never y-only / never sticky indexSorted.
7. **DataStore line y-only**: CPU y pack when staging x matches; GPU uploads dense y (N×4) + compute y-lane rewrite into interleaved storage. False positives (x change, length change, modular ring) take full N×8 `writeBuffer`.
8. **Unsorted full rewrite (group 3)**: `line` + `sampling: 'none'` + non-monotonic x every frame. No LTTB, no y-only, no `indexSortedProven`. Pack uses specialized dense tuple path. Draw policy `resolveLineDrawPolicy` → **`denseHairline`** when **displayed** point count ≥ `DENSE_HAIRLINE_POINT_THRESHOLD` (**25 000**): WebGPU `line-list` (1 device px), deferred out of the main 4× MSAA pass and drawn in a **post-resolve sampleCount:1** load-pass on `mainResolveTexture` (`renderCoordinator/denseHairlinePass`). Grid / non-dense series keep main **4×**. **Visual tradeoff:** high-N lines are native 1 device-px strokes (no thick SDF AA quads); `lineStyle.width` config is unchanged. **Never** use portable `sampleCount: 2` (WebGPU allows only 1 or 4; 2 fails validation).
9. **Multi-series N×M (group 1)**: axes-only y-range `setOption` with stable series **element** identities. Full resolved-series array reuse (`canReuseEntireUserSeriesArray` + `lastUserSeriesElements` snapshot). Resolved **theme** object identity reused when user theme/palette refs are unchanged (legend DOM skip). Type-aware renderer pools (line-only charts do not allocate area/scatter/pie/candle/decimation × N). Multi-series hairline when `visibleLineCount × (pointCount−1) ≥ MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET` (**500 000**), equal-N approximation. Each line renderer owns a **private VS uniform buffer** with dirty-skip (device-global shared VS was removed — unsafe under multi-chart deferred submit). Batched hairline: one `setPipeline` + N draws.
10. **Dense scatter draw (group 2)**: `resolveScatterDrawPolicy` — draw-only radius compact when density high or N ≥ `DENSE_SCATTER_POINT_COUNT_FULL_COMPACT` (250k); upload dual-buffer full xy; harness remains `sampling: 'none'`. Post-resolve SS1 defer (`isDenseDeferred` / `renderDense`) only when **`fullyCompact`** and **no visible line series** (z-order: scatter under lines). Partial density blends keep main 4×. Shared post-resolve pass with dense hairline draws scatter before hairline strokes.

## Interaction (internal)

Interaction code lives under [`src/interaction/`](../../src/interaction/).

- **Event normalization**: [`createEventManager.ts`](../../src/interaction/createEventManager.ts)
  - `payload.x/y`: canvas-local **CSS px**
  - `payload.gridX/gridY`: plot/grid-local **CSS px**
- **Zoom state + inside gestures**: [`createZoomState.ts`](../../src/interaction/createZoomState.ts), [`createInsideZoom.ts`](../../src/interaction/createInsideZoom.ts)
- **Hit-testing**: [`findNearestPoint.ts`](../../src/interaction/findNearestPoint.ts), [`findPointsAtX.ts`](../../src/interaction/findPointsAtX.ts), [`findPieSlice.ts`](../../src/interaction/findPieSlice.ts)

Contracts worth keeping in mind:

- **Visibility**: most helpers ignore `series.visible === false`.
- **Index mapping**: if you filter series, preserve original indices in results.
- **Sorted-x** (cartesian): several fast paths assume increasing x.
- **Units must match**: if a helper expects range-space inputs, your scales must output the same space.

## DOM overlays (internal)

- **Text overlay**: [`createTextOverlay.ts`](../../src/components/createTextOverlay.ts)
- **Legend**: [`createLegend.ts`](../../src/components/createLegend.ts)
- **Tooltip**: [`createTooltip.ts`](../../src/components/createTooltip.ts)
  - Tooltip content is assigned via `innerHTML` (only pass trusted/sanitized strings).
- **DataZoom slider**: [`createDataZoomSlider.ts`](../../src/components/createDataZoomSlider.ts)

## Render coordinator (internal)

- **Shell**: [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) (re-exports public factory/types)
- **Implementation**: [`createRenderCoordinatorImpl.ts`](../../src/core/renderCoordinator/createRenderCoordinatorImpl.ts)
- **Domain modules**: [`src/core/renderCoordinator/`](../../src/core/renderCoordinator/) — `data/` (append policy, display resolve, packing xOffset, sampling dirty), `render/` (series/frame helpers, overlays), `gpu/`, `zoom/`, utils/axis/animation/ui/interaction, annotations

The coordinator computes layout/scales, prepares renderers, uploads data, and emits DOM overlays.

## Renderer map (internal)

Renderer factories live under [`src/renderers/`](../../src/renderers/).

| Feature | Factory | Shader(s) |
|---|---|---|
| Line | [`createLineRenderer.ts`](../../src/renderers/createLineRenderer.ts) | [`line.wgsl`](../../src/shaders/line.wgsl) |
| Area | [`createAreaRenderer.ts`](../../src/renderers/createAreaRenderer.ts) | [`area.wgsl`](../../src/shaders/area.wgsl) |
| Bar | [`createBarRenderer.ts`](../../src/renderers/createBarRenderer.ts) | [`bar.wgsl`](../../src/shaders/bar.wgsl) |
| Scatter | [`createScatterRenderer.ts`](../../src/renderers/createScatterRenderer.ts) | [`scatter.wgsl`](../../src/shaders/scatter.wgsl) |
| Scatter density | [`createScatterDensityRenderer.ts`](../../src/renderers/createScatterDensityRenderer.ts) | [`scatterDensityBinning.wgsl`](../../src/shaders/scatterDensityBinning.wgsl), [`scatterDensityColormap.wgsl`](../../src/shaders/scatterDensityColormap.wgsl) |
| Pie | [`createPieRenderer.ts`](../../src/renderers/createPieRenderer.ts) | [`pie.wgsl`](../../src/shaders/pie.wgsl) |
| Candlestick | [`createCandlestickRenderer.ts`](../../src/renderers/createCandlestickRenderer.ts) | [`candlestick.wgsl`](../../src/shaders/candlestick.wgsl) |
| Grid lines | [`createGridRenderer.ts`](../../src/renderers/createGridRenderer.ts) | [`grid.wgsl`](../../src/shaders/grid.wgsl) |
| Axis baseline + ticks | [`createAxisRenderer.ts`](../../src/renderers/createAxisRenderer.ts) | [`grid.wgsl`](../../src/shaders/grid.wgsl) *(shared)* |
| Crosshair | [`createCrosshairRenderer.ts`](../../src/renderers/createCrosshairRenderer.ts) | [`crosshair.wgsl`](../../src/shaders/crosshair.wgsl) |
| Hover highlight | [`createHighlightRenderer.ts`](../../src/renderers/createHighlightRenderer.ts) | [`highlight.wgsl`](../../src/shaders/highlight.wgsl) |

Notes:

- **Grid lines**: driven by resolved options (`ResolvedChartGPUOptions.gridLines`) and wired in [`renderOverlays.ts`](../../src/core/renderCoordinator/render/renderOverlays.ts).
- **WGSL imports**: renderers may import WGSL via Vite `?raw` (types in [`wgsl-raw.d.ts`](../../src/wgsl-raw.d.ts)).

## WebGPU contracts

- `queue.writeBuffer(...)` offsets/sizes must be **4-byte aligned**.
- Uniform buffers are typically **16-byte aligned**.
- Pipeline target formats must match the render pass attachment format.
