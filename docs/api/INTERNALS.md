# Internal modules (Contributor notes)

This document is intentionally **short**. It’s a map to the internal modules that implement ChartGPU behavior, plus a few contracts that are easy to break.

## Where to start

- **Render orchestration**: [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts)
- **Options resolution**: [`OptionResolver.ts`](../../src/config/OptionResolver.ts)
- **Public wrapper**: [`ChartGPU.ts`](../../src/ChartGPU.ts)

## Data pipeline (internal)

- **Data store + GPU uploads**: [`createDataStore.ts`](../../src/data/createDataStore.ts)
- **Series residency + upload policy** (issue 3.4 / 2.2): [`seriesResidency.ts`](../../src/data/seriesResidency.ts) — shared verbs (`skip` | `rangedAppend` | `fullRewrite` | `growWithGpuCopy` | `yOnlyRewrite`). **Scatter and candlestick** call `resolveUploadPolicy` for geometry-cache / y-only decisions. Line/DataStore keep equivalent inlined policy (same verbs). Area shares line storage only when chronological (linear layout or decimation output).
- **`mappedAtCreation`**: Still **unused** in production series paths (default remains `queue.writeBuffer`). Performance canvas task “Use mappedAtCreation for Initial Uploads” is **incomplete** — do not treat as done.
- **Streaming GPU buffers** (double-buffered): [`createStreamBuffer.ts`](../../src/data/createStreamBuffer.ts)
- **CPU downsampling (LTTB helper)**: [`lttbSample.ts`](../../src/data/lttbSample.ts)
- **Content stamps / rewrite detect**: [`seriesContentHash.ts`](../../src/data/seriesContentHash.ts), [`seriesRewriteDetect.ts`](../../src/data/seriesRewriteDetect.ts) — `classifyEqualNYOnlyRewrite` / `isEqualNSortedXYOnlyRewrite` gate equal-N y-only (must not fire for Brownian xy).

### Upload residuals (documented intentionally)

| Residual | Choice | Notes |
|----------|--------|--------|
| **Line DataStore y-only GPU** (2.1 residual) | **Accept residual GPU bandwidth for lines** | CPU packs y-only when x matches staging; GPU is still a full interleaved `writeBuffer` of N×8 (WebGPU has no strided write). Full FNV is skipped when y-only proved change. **Scatter const-radius** uses dual x/y instance buffers so equal-N y-only uploads **only N×4 y bytes** (Option A). |
| **Scatter Brownian draw** (group 2 @ 1M) | **Hard residual — draw/MSAA bound** | Full xy rewrite every frame (`sampling: 'none'`); y-only path correctly does not activate. ~14 FPS @ 1M after dual-buffer; SciChart ~66 FPS. Further wins need cheaper point primitive / LOD / MSAA policy (not sampling hacks). |
| **CPU zoom pan** (2.2) | **Debounced resample** | Non–GPU-eligible series still full-`setSeries` on zoom debounce fire. GPU-eligible lines keep raw resident (zero raw re-upload on pan). Holding previous sample under clip mid-pan is not wired (would need a dedicated hold buffer). |
| **Update animation** (2.3) | **Full re-upload while interpolating** | Identity caches clear every frame (correctness under in-place mutation). N>20k skips lerp. GPU-side lerp dual-buffer is deferred. |

### Full-series rewrite contracts (SciChart-style setOption)

1. **Cheap stamps**: On data-ref change, `cheapCartesianContentStamp` / `cheapOHLCContentStamp` (O(1)). Full `hashCartesianSeriesData` is not used on that path. Stamps use a module-global generation counter (dirty tokens only; multi-chart stamp coupling is harmless).
2. **rawBounds modes**: `synthetic` (all axes explicit), `xDataYAxis` (y fixed, x from data), `data` (full scan). Mode is stored so switching axes back to auto under a stable data ref cannot keep synthetic extents.
3. **Dual-store (tooltip off)**: ChartGPU hit-test columns are not rebuilt on every setOption; `hitTestStoreNeedsResync` + resync from coordinator on `hitTest` / tooltip on. Append with `maxPoints` uses the same skip when tooltip off.
4. **Raw ref → promote**: Coordinator stores setOption data by reference; `appendData` promotes via branded owned `MutableXYColumns` (never mutates caller XY arrays).
5. **No double LTTB**: Full data rewrite uses OptionResolver-sampled series; baseline recompute does not re-sample.
6. **Equal-N y-only (group 4)**: `classifyEqualNYOnlyRewrite` → index-sorted + `sampling === 'lttb'` with matching prior sampling/threshold remaps prior LTTB sample y in O(k) (frozen index set; full LTTB on length/x/sampling config change). **Sticky `indexSortedProven`**: one full O(n) `isIndexSortedX` proof is stored on the resolved series; subsequent equal-N frames at the same N skip re-proving when samples still look like x=i (cleared on Brownian / length change). min/max/average always re-sample. Scatter const-radius dual-buffer writes only the y channel. Brownian xy (group 2) must stay on the full path.
7. **DataStore line y-only**: CPU y pack when staging x matches; GPU upload remains full interleaved (residual).

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

- **Factory**: [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts)
- **Decomposed modules**: [`src/core/renderCoordinator/`](../../src/core/renderCoordinator/)

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
