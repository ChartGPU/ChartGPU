# Chart Options

Chart configuration. Full types: [`types.ts`](../../src/config/types.ts).

## `ChartGPUOptions`

- **`theme`**: `'dark' | 'light'` or [`ThemeConfig`](themes.md#themeconfig)
- **`DataPoint`**: tuple `[x, y, size?]` or object `{ x, y, size? }`
- **`autoScroll?: boolean`**: when `true`, `appendData()` keeps visible x-range anchored to newest data (only when data zoom enabled and `xAxis.min`/`max` unset). Demo: [`live-streaming/`](../../examples/live-streaming/). **Disables sticky X headroom** so FIFO/`maxPoints` sliding windows track the retained data min/max (sticky would freeze historical xMin and compress the waveform into a thin strip on the right).
- **`antialias?: boolean`** (default `true`): main + overlay GPU passes use **4× MSAA** when `true`, or `sampleCount: 1` when `false` (lower fill-rate / memory for multi-chart dashboards). WebGPU portable multisample counts are only **1 or 4**. **Create-only:** takes effect at `ChartGPU.create` / coordinator construction; changing via `setOption` does **not** rebuild MSAA pipelines or the texture manager. Dispose and recreate the chart to change.
- **`devicePixelRatio?: number`**: canvas backing-store pixel ratio. **Create-time policy** (`setOption` cannot change it): omitted → every `resize()` re-reads live `window.devicePixelRatio` (page zoom); explicit finite `> 0` → frozen for buffer + text overlays for the chart lifetime. Set to `1` on multi-chart dashboards to cap GPU fill rate. Buffer size is `max(1, round(clientWidth|Height × dpr))` (layout CSS pixels), not `getBoundingClientRect()` (visual size under CSS zoom). Dispose and recreate to change policy.

## Annotations

- **`annotations?: ReadonlyArray<AnnotationConfig>`**: overlays (lineX, lineY, point, text). `position.space: 'plot'` uses fractions [0,1] for x/y. Full guide: [annotations.md](annotations.md). Authoring: [`annotation-authoring/`](../../examples/annotation-authoring/).

## Series Configuration

- **`SeriesType`**: `'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'candlestick' | 'ohlc' | 'heatmap' | 'band' | 'errorBar' | 'pointCloud3d' | 'surface3d'`. See [`types.ts`](../../src/config/types.ts).
- **`coordinateSystem`**: `'cartesian2d'` (default) | `'cartesian3d'`. 3D charts use a separate depth + camera path; only `pointCloud3d` / `surface3d` are valid there. Full 3D API: [`docs/api/3d.md`](./3d.md).
- **Sampling (cartesian)**: `sampling?: 'none' | 'lttb' | 'average' | 'max' | 'min'`, `samplingThreshold?: number` (default 5000). Zoom-aware resampling when data zoom enabled.
- **`visible?: boolean`**: hide series from rendering and interaction. Legend toggle updates both.
- **Data identity / in-place mutation**: ChartGPU treats series `data` by **reference identity** for hot paths (`setOption` resolve, content hashing, GPU upload skip, area geometry cache). Mutating point values under a stable array / columns object **without** replacing the reference may not be detected. Prefer a new array (or `appendData(...)`) when content changes. Axes-only / presentation-only updates that re-pass the same `data` reference are intentionally O(1) on the data path.
- **Series array identity reuse (axes-only `setOption`)**: When consecutive `setOption` calls re-pass the **same series config object identities** (outer `series` array may be the same or a new array wrapping the same elements) and theme/palette refs are unchanged, ChartGPU may **reuse the entire previous resolved series array** without re-walking each series. Treat the outer `series` array **and each series config object** as **immutable** for this path: to change data, color, visibility, style, or candlestick **`priceLabel`**, pass a **new series element object** (or a new `series` array of new objects). Index assignment (`series[i] = {...}`) is detected; mutating properties under a stable element object (e.g. `series[i].data = newData`, `series[i].priceLabel = false`) is **not** detected on the full-array path.
- **Full rewrite (`setOption` with a new `data` array every frame)**: When the data **reference** changes, ChartGPU uses an O(1) content **stamp** (not a full float hash) for dirty tracking. GPU buffers are reused when capacity fits; pack goes into retained staging. Tooltip off skips ChartGPU hit-test columnar rebuild until `hitTest()` or tooltip re-enable (dual-store relief). The coordinator may keep your data array by reference until `appendData` — append always **copies** into owned columns and never mutates caller `{ x, y }` arrays.
- **Y-only DataStore rewrite (lines)**: When length is stable and every x matches the previous pack, only y floats are rewritten in CPU staging; GPU uploads a dense **N×4** y channel and a compute pass rewrites y lanes into interleaved storage (not a full N×8 `writeBuffer`). Length change, any x change, **any non-finite x** in the series or staging (including stable null gaps), or modular ring layout force a full interleaved rewrite. Unsorted Brownian xy (group 3) never hits this path.
- **Equal-N y-only scatter (const radius)**: When x is stable (e.g. `x = i`), scatter uses dual x/y instance buffers and uploads only the y channel (N×4). Index-sorted equal-N rewrites with `sampling: 'lttb'` (matching prior sampling + threshold) under **`performance.lod: 'auto'`** re-bind y at the **frozen prior LTTB index set** in O(k) instead of full O(N) LTTB — approximate hold: newly emerging y extrema between retained indices do not appear until full LTTB resumes (length, x change, sampling/threshold change, or `performance.lod: 'strict'`). Under **`strict`**, plain `'lttb'` always full-recomputes on y change. min/max/average always re-sample. Brownian xy updates stay on the full path.
- **Dense scatter draw (const radius)**: When points-per-plot-pixel is high **and** `performance.lod !== 'strict'`, drawn marker radius may compact toward ~1 device pixel (draw-only; does not change `sampling` or uploaded point count). Low-density charts and `strict` keep full `symbolSize`.
- **Dense line draw (hairline)**: When a line series has **≥ ~25 000 displayed points** (raw or `pointCountOverride` after GPU decimation) **and** `performance.lod !== 'strict'`, ChartGPU switches **draw only** to a native **1 device-px `line-list` hairline** (`denseHairline`). Those segments are drawn in a **post-resolve sampleCount:1** pass (not under main 4× MSAA overdraw). Series `lineStyle.width` config is unchanged; low-N lines (e.g. ≤10k, or FIFO rows after LTTB/GPU decimation keeps N low) keep full AA quads + configured width. Applies to **all** high-N lines under auto LOD, not only unsorted full rewrites.
- **Multi-series dense hairline (total-segment budget)**: When the chart has **≥ 2 visible line series** and the approximate total segment count `visibleLineSeriesCount × max(0, pointCount − 1)` is **≥ ~500 000** (equal-N approximation using each series' own point count) **and** lod is auto, those lines also enter `denseHairline` even if each series is below the 25k per-series threshold. Example: **1000 series × 1000 points** hairlines; **500 × 500** stays standard AA. **Visual tradeoff:** multi-series stress charts draw 1 device-px strokes instead of thick width-2 AA quads. Does not change sampling or uploaded data.
- **`performance.lod`**: `'auto'` (default) enables dense hairline / scatter radius compaction and approximate equal-N LTTB index freeze; `'strict'` always honors configured line width and marker size and full-recomputes LTTB on equal-N y updates. See [performance.md](../performance.md#adaptive-draw-lod-performancelod).
- **Main scene MSAA (library-wide)**: Main series pass and overlay UI both use **4× MSAA** (`MAIN_SCENE_MSAA_SAMPLE_COUNT` / `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT`) by default, or **1×** when `antialias: false` is passed at create. Dense hairline lines additionally use a **legal sampleCount:1** pass after main resolve (see Internals group-3 contract). WebGPU only allows portable multisample counts of **1 or 4** — `sampleCount: 2` is invalid and will fail validation (`Invalid CommandBuffer`). **`antialias` is create-only.** **`devicePixelRatio` is a create-time policy** (explicit freezes buffer + overlays; omitted tracks live window DPR on resize) — see top of this page.

### CandlestickSeriesConfig

- **Data**: `OHLCDataPoint` — tuple `[timestamp, open, close, low, high]` or object.
- **`style?: 'classic' | 'hollow'`**. **`sampling?: 'none' | 'ohlc'`** for bucket aggregation. Body-only hit-testing. Demos: [`candlestick/`](../../examples/candlestick/), [`candlestick-streaming/`](../../examples/candlestick-streaming/).
- **`priceLabel?: boolean | CandlestickPriceLabelConfig`**: exchange-style **last-price badge** (DOM) and optional **horizontal price line** (GPU) on the series Y-axis rail. v1: **one badge + one line per chart** — first visible candlestick **or** ohlc series with resolved `priceLabel.show` wins.
  - **Sugar**: `true` / `false` force on/off with field defaults; object form enables unless `show: false`.
  - **`undefined` (default)**: auto-enables when the chart is **finance-primary** (`series[0].type === 'candlestick'` or `'ohlc'`); off when neither is first. See **Migration (P1 default badge)** under Axis Configuration.
  - **Full options** (`CandlestickPriceLabelConfig`):

    | Field | Default | Notes |
    |-------|---------|-------|
    | `show?` | `true` when object form; else sugar / auto | Hard off with `false` or `priceLabel: false` |
    | `showLine?` | same as resolved `show` | Horizontal last-close line; always omitted when `show` is false |
    | `intervalMs?` | — | Finite `> 0` candle period (ms). Required for countdown; omitted → price-only badge |
    | `showCountdown?` | `true` when `intervalMs` valid; else forced `false` | Secondary countdown line under the price |
    | `nowMs?: () => number` | wall clock (`Date.now`) at use site | Injectable clock for accelerated / simulated streams |
    | `formatter?: (close) => string` | library `formatPriceLabelValue` | **Not** axis `tickFormatter` (which may return `null` / sparse precision). Output is plain text (`textContent`), never HTML |
    | `outOfDomain?` | `'clamp'` | `'clamp'`: pin badge to plot edge (dimmed); price line still draws at true Y (scissor may clip). `'hide'`: hide **badge and line** |
    | `color?` | `#ffffff` | Badge **text** color |
    | `lineColor?` | candle direction color | Line only; badge **background** is always up/down from last open/close |
    | `lineWidth?` | `1` | CSS px |

  - **Direction color**: last candle `close >= open` → `itemStyle.upColor` (default green); else `itemStyle.downColor` (default red). Flat candles count as up.
  - **Countdown**: DOM-only timer (does **not** call `requestRender` / GPU). Streaming demos with simulated time must pass a **stable** `nowMs` function identity across `setOption` rewrites (see [`candlestick-streaming/`](../../examples/candlestick-streaming/)).
  - **setOption replace semantics**: `setOption` **replaces** the full options object (not deep-merge). Always re-pass `priceLabel` (including `intervalMs` / `nowMs`) on every options rewrite that should keep the badge/countdown. Prefer caching a full options object and updating fields, as the streaming example does.
  - **Series element identity**: under axes-only `setOption` reuse, changing `priceLabel` requires a **new series element object** in `series[]`. In-place mutation (`series[i].priceLabel = false` on a stable element) is **not** re-resolved. Same contract as other series fields (see **Series array identity reuse** above).
  - **Public exports**: `CandlestickPriceLabelConfig`, `ResolvedCandlestickPriceLabel`, `resolvePriceLabel`, `createPriceLabel`, `PriceLabel`, `formatPriceLabelValue`, `isCandlePrimaryChart` (package entry / `resolveOptions`).
  - **Examples**:
```ts
// Candle-primary: badge + line auto-on (omit priceLabel or leave undefined)
series: [{ type: 'candlestick', data }]

// Opt out (keep right axis defaults but no badge/line)
series: [{ type: 'candlestick', data, priceLabel: false }]

// Countdown + simulated clock (streaming)
series: [{
  type: 'candlestick',
  data,
  priceLabel: {
    intervalMs: 60_000,
    nowMs: () => simulatedTimeMs, // stable function ref across setOption
  },
}]

// Badge only, custom format, hide when zoomed past last close
series: [{
  type: 'candlestick',
  data,
  priceLabel: {
    showLine: false,
    formatter: (c) => c.toFixed(2),
    outOfDomain: 'hide',
  },
}]
```
- **Acceptance**: OHLC sampling — [`examples/acceptance/ohlc-sample.ts`](../../examples/acceptance/ohlc-sample.ts). Candle-primary layout + `priceLabel` resolve — [`examples/acceptance/candle-price-axis.ts`](../../examples/acceptance/candle-price-axis.ts).

### OhlcSeriesConfig

Thin **open / high / low / close** bars (not filled candle bodies). Same data contract as candlestick.

```
          high
           │
  open ────┤
           │
           ├──── close
           │
          low
```

- **Data**: identical `OHLCDataPoint` / ECharts tuple order `[timestamp, open, close, low, high]`.
- **Geometry**: vertical stem `low`→`high` at the bar timestamp; **left** horizontal tick at `open`; **right** tick at `close`. Color: `close > open` → `itemStyle.upColor`, else `downColor` (doji uses down; same as candlestick body fill). Stroke-only in v1 — `itemStyle.border*` fields are accepted on the shared style type but do not change OHLC stroke geometry.
- **`barWidth` / `barMinWidth` / `barMaxWidth`**: category slot width (same resolve as candlestick); drives default tick length scale.
- **`stemWidth?: number`**: stroke thickness in CSS px (default `1`). Stem uses **domain X** conversion; open/close tick thickness uses the same CSS px via **domain Y** (must not share the X conversion — time-scale widths are huge in price space). Updated via uniforms on zoom without re-packing.
- **`tickLength?: number | string`**: open/close arm **length** (horizontal) — CSS px number or percent of resolved body width (default `'45%'`). Not vertical thickness.
- **`sampling?: 'none' | 'ohlc'`** only (default `'ohlc'`); other modes fall back like candlestick. Invalid modes are ignored (default applied).
- **`priceLabel`**: same sugar as candlestick; auto when finance-primary (`series[0].type === 'ohlc'`).
- **Hit-test**: `kind: 'ohlc'`; category-width box with Y over `[low, high]` (stem range) for **both** `ChartGPU.hitTest` and tooltip/hover (`findCandlestick` `yHitMode: 'lowHigh'`). Candlestick remains body-only (`openClose`). Tooltip / events still surface timestamp + close at the ChartGPU wrapper (same as candlestick).
- **Streaming**: `appendData` / `maxPoints` FIFO parity with candlestick.
- **Demo**: [`examples/ohlc-bars/`](../../examples/ohlc-bars/) — toggle candlestick ↔ ohlc on the same data.

```ts
series: [{
  type: 'ohlc',
  name: 'BTC-USD',
  data: ohlcBars, // same OHLCDataPoint[] as candlestick
  barWidth: '60%',
  stemWidth: 1,
  tickLength: '45%',
  itemStyle: { upColor: '#22c55e', downColor: '#ef4444' },
  sampling: 'ohlc',
  // priceLabel auto when series[0]
}]
```

### LineSeriesConfig

- **`lineStyle?: { width?, opacity?, color? }`** (default width 2). **`areaStyle?`** for fill under line. Color precedence: `lineStyle.color` → `series.color` → palette.
- **`stack?: string`**: stack group id for **mountain fill composition** (multi-series stacked area). Non-empty + `areaStyle` → this series stacks with peers sharing the same id **and the same `yAxis`**. Stroke-only lines (no `areaStyle`) ignore `stack` for fill (dev warning once). Same string semantics as bar `stack`. Series array order within the stack = **bottom → top**. Omitted / empty / whitespace → unstacked single-series mountain (suite group 8 path).
- **High-N hairline topology**: Under **`performance.lod: 'auto'`** (default), at ≥ ~25k displayed points **or** multi-series total-segment budget ≥ ~500k, the GPU may draw with `line-list` hairline topology (1 device px) regardless of `lineStyle.width` — draw-only LOD; does not change sampling or uploaded point count. Under **`performance.lod: 'strict'`**, configured width + AA quads are always honored. See **Dense line draw (hairline)** / **`performance.lod`** above and [performance.md](../performance.md#adaptive-draw-lod-performancelod).

#### Null Gaps (Line Segmentation)

Line and area series support `null` entries in `DataPoint[]` arrays to represent gaps (disconnected segments):

```ts
series: [{
  type: 'line',
  data: [[0, 1], [1, 3], null, [3, 5], [4, 7]],  // gap between x=1 and x=3
}]
```

- **`connectNulls?: boolean`** (default: `false`): when `true`, null entries are stripped and the line/area draws through the gap. When `false`, null entries produce visible gaps.
- **Multi-segment pattern**: concatenate pre-split data with null separators: `[...segment1, null, ...segment2]`.
- **Sampling**: when data contains null gaps and sampling is enabled, ChartGPU bypasses sampling and uses raw data to preserve gap positions. Gap-aware sampling may be added in a future release.
- **Supported formats**: `DataPoint[]` only. `XYArraysData` and `InterleavedXYData` do not support null gaps.

### AreaSeriesConfig

- **`baseline?: number`** (default: y-axis min). **`areaStyle?: { opacity?, color? }`**.
- **`stack?: string`**: stack group id (same as line mountain / bar). Non-empty → stacked with peers of the same id and `yAxis`. When stacked, per-series `baseline` is **ignored** for layout (cumulative floor from 0; dev warning once if both set).

### Stacked mountain / area (`stack` on line mountain or area)

Multi-series **composition** fill — each layer’s floor is the sum of layers below (SciChart stacked mountain parity). **Not** single-series mountain (already: `line` + `areaStyle` / `type: 'area'` without `stack`; performance suite group 8 is 1-series only). **Not** `type: 'band'` (dual-curve envelope on one series). **Not** a new `type: 'stackedArea'`.

```ts
series: [
  { type: 'line', stack: 'traffic', data: { x: t, y: organic }, areaStyle: { opacity: 0.85 }, color: '#38bdf8' },
  { type: 'line', stack: 'traffic', data: { x: t, y: paid }, areaStyle: { opacity: 0.85 }, color: '#a78bfa' },
  { type: 'line', stack: 'traffic', data: { x: t, y: referral }, areaStyle: { opacity: 0.85 }, color: '#34d399' },
  // Unstacked guide line (no stack / no areaStyle)
  { type: 'line', data: { x: t, y: target }, lineStyle: { width: 2, color: '#f472b6' } },
]
```

| Topic | Behavior |
|-------|----------|
| **Order** | Within a stack id, ascending `series[]` index = bottom → top (first drawn near 0). |
| **Pos / neg** | Positive y stack upward from 0; negative stack downward independently (bar parity). |
| **X alignment** | Equal length + equal x[i] → index align (fast). Sparse / unequal → align by x-value key; missing peer at x contributes **0**. No linear interpolation of missing peers in v1. |
| **Auto Y** | Includes stacked tops/bottoms (composition totals), not raw per-layer max alone. |
| **Stroke** | Optional line stroke draws at **layer top** (baseline + y), not raw unstacked y. |
| **Tooltip** | `value[1]` = **layer contribution**; optional `stack` + `stackTotal` on `TooltipParams`. Hit prefers topmost layer under the cursor. |
| **Sampling** | Prefer `sampling: 'none'` or identical thresholds for stack peers; independent LTTB per series is imperfect after stack. Non-empty `stack` **with mountain fill** (`isStackedMountainSeries`) → **not** GPU line-decimation eligible. Stroke-only lines with inert `stack` (no `areaStyle`) remain eligible. |
| **connectNulls** | Stack baselines use the **same** view as pack (gaps filtered when `connectNulls: true`) so indices stay aligned. Prefer identical gap patterns across peers. |
| **Visibility** | Legend-hidden layers (`visible: false`) do **not** participate in composition, auto-Y, or hit-test (toggle recompute). |
| **Multi-axis** | Same `stack` string on different `yAxis` ids → independent stacks; hit-test uses per-axis Y scale. |
| **Streaming** | `appendData` / equal-N `setOption` recompute stack baselines for the group (caller data never mutated to cumulative y). Ranged GPU append is disabled for stacked mountain (kind `other`). |

Example: [`examples/stacked-mountain/`](../../examples/stacked-mountain/). Pure math: [`src/data/stackedArea.ts`](../../src/data/stackedArea.ts). Stacked fill shader: [`src/shaders/areaStacked.wgsl`](../../src/shaders/areaStacked.wgsl).

### BarSeriesConfig

Extends the shared series fields with `type: 'bar'` and bar-specific layout/styling. See [`types.ts`](../../src/config/types.ts).

- **`barWidth?: number | string`**: bar width in CSS pixels (number) or as a percentage string.
  - When `barWidth` is a percentage string (e.g. `'80%'`), it is interpreted as a percentage of the **maximum per-bar width that still avoids overlap within a category**, given the current `clusterCount` (derived from `stack`) and `barGap`.
    - `'100%'` equals the default “auto” width (the max non-overlap width).
    - Values are clamped to \([0, 100]\)%, and the resulting layout guarantees `clusterWidth <= categoryInnerWidth` (no intra-category overlap).
  - When `barWidth` is a number (CSS px), it is clamped to the same maximum non-overlap per-bar width.
  - When omitted, ChartGPU uses the same “auto” width (max non-overlap) behavior.
- **`barGap?: number`**: gap between bars in the same category/group (ratio in \([0, 1]\)). Default: `0.01` (minimal gap). To make grouped bars flush (no gap between bars within a group), set `barGap` to `0` or a value near `0`. See [`createBarRenderer.ts`](../../src/renderers/createBarRenderer.ts).
- **`barCategoryGap?: number`**: gap between categories (ratio in \([0, 1]\)). Default: `0.2`. See [`createBarRenderer.ts`](../../src/renderers/createBarRenderer.ts).
- **`stack?: string`**: stack group id (bars with the same id may be stacked).
- **`itemStyle?: BarItemStyleConfig`**: per-bar styling.
- **Rendering (current)**: bar series render as clustered bars per x-category via an instanced draw path. If multiple bar series share the same **non-empty** `stack` id, they render as stacked segments within the same cluster slot (positive values stack upward from the baseline; negative values stack downward). Bars are clipped to the plot grid (scissor) so they do not render into the chart margins. See [`createBarRenderer.ts`](../../src/renderers/createBarRenderer.ts), shader source [`bar.wgsl`](../../src/shaders/bar.wgsl), and coordinator wiring in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts). For an example, see [`examples/grouped-bar/`](../../examples/grouped-bar/).
  - Note: y-axis auto bounds are currently derived from raw series y-values (not stacked totals). If stacked bars clip, set `yAxis.min` / `yAxis.max`.

### ScatterSeriesConfig

Extends the shared series fields with `type: 'scatter'`, optional `symbol?: ScatterSymbol`, and optional `symbolSize?: number | ((value: ScatterPointTuple) => number)`. See [`types.ts`](../../src/config/types.ts).

- Scatter point tuples may include an optional third `size` value (`readonly [x, y, size?]`).
- **Rendering (current)**: scatter series render as instanced circles (SDF + alpha blending). Size is treated as a **radius in CSS pixels** from either the per-point `size` (when provided) or `series.symbolSize` as a fallback. See the internal renderer [`createScatterRenderer.ts`](../../src/renderers/createScatterRenderer.ts) and shader [`scatter.wgsl`](../../src/shaders/scatter.wgsl).
- **`mode?: 'points' | 'density'`**: scatter rendering mode. Default: `'points'`.
  - When `mode === 'points'`, ChartGPU draws individual point markers (current behavior).
  - When `mode === 'density'`, ChartGPU renders a binned density heatmap in screen space (useful for very large point clouds where markers overplot).
- **`binSize?: number`**: density bin size in **CSS pixels** (used only when `mode === 'density'`). Default: `2`.
  - **DPR behavior**: `binSize` is specified in CSS px, but bins are computed in device pixels using `round(binSize * devicePixelRatio)` (minimum 1 device pixel). This keeps the visual bin size roughly consistent across displays. See [`createScatterDensityRenderer.ts`](../../src/renderers/createScatterDensityRenderer.ts).
- **`densityColormap?: 'viridis' | 'plasma' | 'inferno' | readonly string[]`**: colormap used for density rendering (used only when `mode === 'density'`). Default: `'viridis'`.
  - **Named presets**: `'viridis' | 'plasma' | 'inferno'` use built-in “anchor” color stops that are interpolated into a 256-entry lookup table. See [`createScatterDensityRenderer.ts`](../../src/renderers/createScatterDensityRenderer.ts).
  - **Custom gradient**: a `readonly string[]` is interpreted as a low→high gradient of CSS color strings (interpolated into a 256-entry lookup table). Invalid color strings fall back to black. Note: the current density shader renders output as fully opaque (`alpha = 1.0`) regardless of any alpha in your color stops. See [`createScatterDensityRenderer.ts`](../../src/renderers/createScatterDensityRenderer.ts) and [`scatterDensityColormap.wgsl`](../../src/shaders/scatterDensityColormap.wgsl).
- **`densityNormalization?: 'linear' | 'sqrt' | 'log'`**: normalization curve used to map per-bin counts to color intensity (used only when `mode === 'density'`). Default: `'log'`.
  - Normalization is applied **relative to the maximum bin count in the current view**: linear uses `count / max`, sqrt uses `sqrt(count / max)`, and log uses `log1p(count) / log1p(max)`. This means color intensity can rescale as you zoom/pan (because the per-view max changes). See [`scatterDensityColormap.wgsl`](../../src/shaders/scatterDensityColormap.wgsl).

Notes (density mode):

- **Correctness (important)**: density mode uses raw (unsampled) points for binning, even when `sampling` is configured, to avoid undercounting.
- **Zoom/pan behavior**: density is recomputed as the view changes. When x-values are monotonic, ChartGPU limits compute to the current visible x-range; otherwise it may process the full series. See the coordinator wiring in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and compute shader [`scatterDensityBinning.wgsl`](../../src/shaders/scatterDensityBinning.wgsl).
- **Performance vs resolution**: `binSize` trades resolution for performance. Smaller bins increase detail but increase both bin count and compute cost per recompute.
- **Example**: for a working 1M-point density scatter demo (including controls for colormap, normalization, and bin size), see [`examples/scatter-density-1m/`](../../examples/scatter-density-1m/).
- **Not a data-grid heatmap**: scatter density bins a **point cloud** in **screen space**. For spectrograms / correlation matrices / regular fields, use **`type: 'heatmap'`** ([HeatmapSeriesConfig](#heatmapseriesconfig)).

### HeatmapSeriesConfig

Uniform rectangular **data-grid** heatmap / spectrogram (`type: 'heatmap'`). Distinct from scatter `mode: 'density'`.

#### Data layout (`HeatmapData`)

```ts
{
  xStart, xStep, yStart, yStep,
  columns, rows,
  z: Float32Array | number[], // length === columns * rows, row-major
}
```

- Cell indices: `z[j * columns + i]` at column `i`, row `j`.
- Row `j = 0` is the band starting at `yStart` (increasing `j` → increasing `y`).
- Prefer `Float32Array` for upload efficiency.

#### Options

| Field | Default | Notes |
|-------|---------|--------|
| `colormap` | `'viridis'` | `'viridis' \| 'plasma' \| 'inferno' \| 'magma' \| 'grayscale'` or custom low→high CSS stops |
| `zMin` / `zMax` | auto from finite z | If equal, expanded by epsilon so colormap t does not NaN |
| `zScale` | `'linear'` | `'log'` uses positive finite z only; non-positive cells follow `nullHandling` |
| `opacity` | `1` | Series-wide alpha multiplier |
| `cellAnchor` | `'corner'` | `'corner'`: `(xStart,yStart)` is min-corner of cell (0,0); `'center'`: center of cell (0,0) |
| `nullHandling` | `'transparent'` | `'transparent' \| 'lowest' \| 'highest'` for NaN/±Inf (and log-invalid) z |
| `cellGapPx` | `0` | Optional UV inset between cells (CSS px) |

#### Behavior (v1)

- **GPU path**: `r32float` z texture + 256-entry colormap LUT + single data-space quad (main pass **4× MSAA**). Shared colormap stops with density via [`src/utils/colormap.ts`](../../src/utils/colormap.ts). Prefer `Float32Array` for packing efficiency; GPU still **pads/copies** rows for `bytesPerRow` alignment (not a zero-copy path).
- **No** LTTB / GPU line decimation / cartesian DataStore XY packing.
- **Draw order**: all heatmaps render **before** area/bar/candlestick/scatter/line strokes (under overlays). Relative order among heatmaps follows `series[]`. Series array order does **not** interleave heatmaps above lines.
- **Zoom / pan**: reprojects via uniforms only when z size/ref/content are unchanged (no z re-upload). Opacity / zMin / zMax / colormap changes do not force a z rewrite (LUT rebuilds on colormap only).
- **Streaming**: prefer **`chart.updateHeatmap(seriesIndex, update)`** (below). Equal-size `setOption` z replace still works. **`appendData` is unsupported** (console warning points at `updateHeatmap`).
- **Axis auto-bounds**: grid extent from `heatmapGridBounds` contributes to X/Y domains (z does not). After scroll, auto X tracks the new `xStart`/width.
- **Tooltip**: cell under cursor → `TooltipParams` with `value: [cellCenterX, cellCenterY]`, optional `z`, and `dataIndex = j * columns + i`. **Hit priority (item)**: pie → candlestick body → nearest cartesian point → heatmap cell (heatmaps are under strokes). **Axis** mode appends heatmap params alongside `findPointsAtX` matches, not instead of them. Transparent `nullHandling` + non-finite z → miss (no tooltip). **Chart-sync** tooltips are x-only and **do not** include heatmap cells (need data-space Y); heatmap tooltips require a **local pointer** over the plot.
- **Legend**: series name + solid palette placeholder color only (not a colormap gradient swatch; gradient legend is a follow-up).
- **Log axes**: VS uses the same log projection flags as other continuous series when X/Y are log.
- **Negative steps**: supported. UV `u=0`/`v=0` always maps to cell `(0,0)` (signed origin+extent), matching CPU `heatmapHitTest` / `heatmapCellIndex`. Axis bounds normalize so min ≤ max.

#### Streaming (`chart.updateHeatmap`)

Mirrors 3D `updateSurface3D`. Discriminated union `HeatmapUpdate`:

| Mode | Payload layout | Notes |
|------|----------------|--------|
| `replaceZ` | Full field **row-major** `z[j * columns + i]` | Optional `zMin`/`zMax`; when both set, skip full-field domain recompute |
| `appendColumns` | **Column-major strips** `z[c * rows + r]` | `scrollX` default **true**: fixed window, drop oldest, `xStart += drop * xStep`. `scrollX: false` **grows** `columns` (texture recreate) |
| `appendRows` | **Row-major blocks** `z[r * columns + i]` | `scrollY` default true: drop oldest rows, `yStart += drop * yStep`; `scrollY: false` grows `rows` |

```ts
// Spectrogram: one new spectrum column per frame (length === series.rows)
chart.updateHeatmap(0, {
  mode: 'appendColumns',
  columns: 1,
  z: spectrumColumn, // Float32Array(rows), column-major
  scrollX: true,
});
```

**GPU hot path:** single-column `appendColumns` + `scrollX` uses a **modular texture ring** + strip `writeTexture` (O(rows) GPU z traffic), not a full-grid pack/upload every frame. Multi-column batch / `replaceZ` / dimension change reset the ring and full-upload. CPU `z` for hit-test stays a **linear logical window** (oldest column at index 0).

**Stream vs `setOption` (same policy as surface3d):**

| Action | Behavior |
|--------|----------|
| `updateHeatmap` | Owns a stream override (`xStart` / `yStart` / `z` / dims) |
| `setOption` with **same** `series[i].data` object identity | Stream **kept** (style-only: colormap, opacity, zMin/zMax, …) |
| `setOption` with a **new** `data` object | Stream **cleared**; user data wins |
| First seed (`prevUser == null`) | Stream not cleared spuriously |

**Colormap domain on stream (D5):**

| Situation | Behavior |
|-----------|----------|
| Series has **both** finite user `zMin`/`zMax` (`zDomainExplicit`) | Keep that range on append (no expand-from-strip drift) |
| Style `setOption` with same `data` ref and new `zMin`/`zMax` | Style domain wins; stream field (xStart/z) kept |
| `replaceZ` with both `zMin`/`zMax` in the update | Use those values |
| Auto domain + single-column scroll | Expand min/max from the new strip only |
| Auto domain + multi-column / `appendRows` / replace without pair | Recompute from full field |

Live spectrogram demos should set explicit `zMin`/`zMax` (fixed dB range).

Example: [`examples/heatmap-spectrogram/`](../../examples/heatmap-spectrogram/). Implementation: [`createHeatmapRenderer.ts`](../../src/renderers/createHeatmapRenderer.ts), [`heatmap.wgsl`](../../src/shaders/heatmap.wgsl), [`heatmapStream.ts`](../../src/data/heatmapStream.ts).

### BandSeriesConfig

Band / range series (`type: 'band'`) fills the region **between two curves that share the same x** — confidence / prediction intervals, sensor min–max envelopes, bid–ask ranges, and threshold fills (constant `y` vs varying `y1`).

**Not** the same as:

| | `type: 'area'` | Annotation `bandX` | `type: 'band'` |
|--|----------------|--------------------|----------------|
| Input | `(x, y)[]` | `from`/`to` x-span | `(x, y, y1)[]` |
| Fill | Curve → **baseline** | Full-height vertical strip | Curve **y** ↔ curve **y1** |
| Use | Mountain under a series | Regime / outage highlight | Confidence / min–max range |

- **`data`**: one of:
  - `ReadonlyArray<BandDataPoint | null>` — tuple `[x, y, y1]` or `{ x, y, y1 }`
  - `{ x, y, y1 }` parallel arrays (SciChart Xyy-style); length = min of the three (mismatch warns)
  - Interleaved `ArrayBufferView` stride **3**: `[x0,y0,y1_0, …]` — **do not** use stride-2 `InterleavedXYData` (would drop `y1`). `appendData` rejects interleaved views whose length is not a multiple of 3.
- **`y` / `y1`**: first and second curves; convention in docs is lower/upper but **crossing is allowed** (`y` may exceed `y1`).
- **`areaStyle?: { color?, opacity? }`**: fill between curves. Default opacity **0.25**. Color falls back to `series.color` → palette.
- **`lineStyle?`**: stroke for the `y` curve. **When omitted, no y stroke** (fill-only). When present, width defaults to **1**; width 0 / opacity 0 also hides.
- **`lineStyleY1?`**: stroke for the `y1` curve. **When omitted, no y1 stroke** (fill-only is valid).
- **`connectNulls?: boolean`** (default `false`): null/NaN gaps break fill + both strokes unless `true`.
- **`sampling?`**: `'none' | 'lttb' | 'average' | 'max' | 'min'` (default like other series: `lttb`). **No `ohlc`** (rejected with warn → `lttb`). **No GPU compute decimation** in v1.
  - **LTTB**: runs on midline `m = (y+y1)/2`, then **carries both y and y1 from chosen indices** (aligned).
  - **min / max**: **aliases in v1** — both keep the full dual-Y envelope per bucket (`y = envMin`, `y1 = envMax` of `min/max(y,y1)`), so axis bounds retain envelope fidelity under downsample.
  - **average**: average each of y and y1 separately per bucket (only over finite samples in that channel).
- **Draw layering**: bands are **type-layered** after heatmaps and before area fills / lines (not strict `series[]` z-order vs area/line). Put mean lines after bands in the array for readability; strokes of the same band series still draw after its fill.
- **Axis auto-bounds**: X from finite `x`; Y from **both** finite `y` and `y1`.
- **Tooltip**: nearest sample by x; `value: [x, y]`, plus optional `y1`, `yMid`, `yRange`.
- **`appendData`**: **supported** with Xyy payloads (`{x,y,y1}`, tuples, or interleaved). FIFO `maxPoints` works like cartesian series.
- **GPU**: private storage buffer of `BandPoint { x, y, y1, pad }` (16-byte); per-segment trapezoid triangle-list (area topology, dual tops). Zoom/pan rewrites VS uniforms only when data identity is stable.
- **Log axes**: same log projection as area/line; non-positive y/y1 on log Y discard that segment endpoint. Log auto-bounds scan **both** y channels for strictly positive values.

Example: [`examples/band-range/`](../../examples/band-range/). Implementation: [`createBandRenderer.ts`](../../src/renderers/createBandRenderer.ts), [`band.wgsl`](../../src/shaders/band.wgsl), [`bandData.ts`](../../src/data/bandData.ts).

### ErrorBarSeriesConfig

Error bars (`type: 'errorBar'`) draw **per-point high/low whiskers around a measured center** — SciChart **HLC** style for scientific uncertainty, SEM/CI, and assay plots.

**Not** the same as:

| | `type: 'band'` | `type: 'ohlc'` | `type: 'errorBar'` |
|--|----------------|----------------|---------------------|
| Geometry | Continuous **fill** between two curves | Finance stem + open/close ticks | Discrete stem + whisker caps per sample |
| Data | `{x,y,y1}` | OHLC open/close/high/low | Center `y` + absolute `high`/`low` (or relative `yError`) |
| Use | Confidence envelope | Candles / OHLC bars | Per-x measurement uncertainty |

- **`data`**: one of:
  - Absolute HLC columns `{ x, y, high, low }` (preferred for streaming)
  - Relative columns: `{ x, y, yError }` (symmetric) or `{ x, y, yErrorHigh, yErrorLow }` (asymmetric offsets; abs applied → `high = y + |eH|`, `low = y - |eL|`)
  - `ReadonlyArray` of:
    - tuples `[x, y, high, low]`
    - absolute objects `{ x, y, high, low }`
    - relative objects `{ x, y, yError }` or `{ x, y, yErrorHigh, yErrorLow }` (resolved to absolute at resolve time)
    - `null` gaps
  - Length = min of channels; mismatch warns. Relative forms resolve to **owned** absolute HLC (caller arrays never mutated).
- **`errorMode?: 'both' | 'high' | 'low'`** (default `'both'`):
  - `both` — stem low→high, both caps
  - `high` — stem y→high, high cap only
  - `low` — stem low→y, low cap only
- **`direction?: 'vertical' | 'horizontal'`** (default `'vertical'`). Horizontal reinterprets `high`/`low` as absolute **X** extents (stem along X at `y`; category/sample axis is **Y**). Remap data when switching direction (centers on Y, whiskers on X).
- **`capWidth?: number | string`**: whisker tip-to-tip length.
  - **number**: CSS px (converted to domain along the **cap** axis — X when vertical, Y when horizontal)
  - **percent string** (e.g. `'40%'`): fraction of **category step** — min positive **Δx** for vertical, min positive **Δy** for horizontal
  - Default `'40%'`. Pure zoom recomputes domain length into uniforms without re-uploading instances.
- **`itemStyle?: { color?, borderWidth?, opacity? }`**: stem + whisker stroke. `borderWidth` is CSS px (default **1.5**). Color falls back to `series.color` → palette.
- **`drawWhiskers?: boolean`** (default `true`), **`drawConnector?: boolean`** (default `true` — the stem).
- **`showCenter?: boolean`** (default `false`) + **`symbolSize?: number`** (default 6): optional center marker. Prefer overlaying a separate scatter/line for the SciChart dual-series pattern.
- **`sampling`**: **`'none'` only**. Other modes warn and are ignored (error bars are sparse science series; no LTTB / GPU line decimation).
- **Null / NaN**: skip sample if `y` non-finite, or if required ends are non-finite for the active `errorMode` (`both` needs both ends; `high` needs high; `low` needs low). `low > high` swaps with a one-shot warn.
- **Axis auto-bounds**: vertical — X from finite `x`, Y from finite `y`/`high`/`low`. Horizontal — X from `x`/`high`/`low`, Y from `y`. Bounds reuse on `setOption` is direction-keyed (vertical↔horizontal toggles recompute).
- **Tooltip / hit-test**: stem + caps (CSS-px pad). `TooltipParams`: `value: [x, y]` plus `high`, `low`, optional `yErrorHigh`/`yErrorLow`. Hit priority: pie → candle/ohlc → **errorBar** → nearest cartesian → heatmap. Multi-axis: hit uses the series `yAxis` scale.
- **`appendData`**: supported with the same HLC / relative / tuple / relative-object shapes. FIFO `maxPoints` works like band.
- **Draw order**: respects `series[]` order among peers; typical pattern places `errorBar` **before** a mean `line`/`scatter` so markers sit on top.
- **GPU**: instanced stem + caps (+ optional center) via `errorBar.wgsl`. Domain pack + affine uniforms; zoom/pan without re-upload when data identity is stable. **Horizontal** packs `high`/`low` relative to the same packing origin as `x`. **Stem thickness** is domain **X** (vertical) / **Y** (horizontal); **cap thickness** uses the opposite axis (OHLC lesson — never reuse domain-X as Y thickness).

```ts
// Absolute HLC + companion mean line (recommended dual-series pattern)
series: [
  {
    type: 'errorBar',
    name: 'Assay ±SEM',
    data: { x: doses, y: means, high: highs, low: lows },
    itemStyle: { color: '#38bdf8', borderWidth: 2 },
    capWidth: '40%',
    errorMode: 'both',
    showCenter: true,
    symbolSize: 8,
  },
  {
    type: 'line',
    name: 'Mean',
    data: { x: doses, y: means },
    lineStyle: { color: '#38bdf8', width: 2 },
    sampling: 'none',
  },
]
// Relative SEM: data: { x, y: means, yError: sems }
```

Example: [`examples/error-bars/`](../../examples/error-bars/). Implementation: [`createErrorBarRenderer.ts`](../../src/renderers/createErrorBarRenderer.ts), [`errorBar.wgsl`](../../src/shaders/errorBar.wgsl), [`errorBarData.ts`](../../src/data/errorBarData.ts), [`errorBarGeometry.ts`](../../src/renderers/errorBarGeometry.ts).

### PieSeriesConfig

- Non-cartesian. No x/y bounds or cartesian hit-test. Slice hit-test via `findPieSlice`. **`radius?`**, **`center?`**, **`startAngle?`**. Example: [`pie/`](../../examples/pie/).

## Axis Configuration

- **`AxisConfig`**: configuration for `xAxis` / `yAxes`. See [`types.ts`](../../src/config/types.ts).
- **`AxisType`**: `'value' | 'time' | 'category' | 'log'`.
- **Logarithmic axes (`type: 'log'`)**:
  - Available on **`xAxis`** and each **`yAxis` / `yAxes[]`** independently.
  - **`logBase?: number`**: logarithm base (default **10**). Must be finite, > 0, and ≠ 1; invalid values fall back to 10 with a dev warning.
  - **Projection**: data stays in linear storage (DataStore / GPU buffers). Log is applied in series vertex shaders before the clip affine — toggling log does not force a full re-upload.
  - **Ticks / grid**: major ticks at integer powers of the base (e.g. \(10^{-2}, 10^{0}, 10^{3}\)) for the **visible** domain (updates on zoom/pan; not locked to full explicit `min`/`max`). When the window has few majors, intermediate ticks densify (e.g. 2×/5× within a decade). GPU grid lines for log axes are co-located with those ticks (not even data-space splits). Labels use a scientific/`1eN` hybrid by default; custom **`tickFormatter`** still receives **data-space** values (e.g. `1000`, not `3`).
  - **Domain must be strictly positive**: auto-bounds ignore ≤0 samples; if no positive data exists the domain falls back to `[1, 10]` with a warning. Explicit `min`/`max` ≤ 0 are clamped using the smallest positive data value `pd`: prefer `pd × 0.5`, then **floor to a power of `logBase`** (`base ** floor(log_b(pd × 0.5))`), with a dev warning. Example (base 10): `pd = 9` → half `4.5` → floored power `1`.
  - **Non-positive points**: treated as **gaps** on line/area (NaN packing path / VS discard) and **omitted** on scatter under log projection.
  - **Area / bar baseline**: classic “fill to zero” is unsupported on log; baseline uses the positive axis min (or first major ≤ data min). Document that fill-to-zero is not available on log Y.
  - **Sticky headroom** on log axes is applied in **log space** (decade headroom).
  - **Zoom** `start`/`end` percents remain percent of **data-space** base domain (not log-percent).
  - **No library UI log toggle** — config only (`setOption({ yAxis: { type: 'log' } })`). Examples may include demo chrome.
  - Showcase: [`examples/log-axis-y/`](../../examples/log-axis-y/), [`log-axis-x/`](../../examples/log-axis-x/), [`log-axis-scatter/`](../../examples/log-axis-scatter/), [`log-axis-multi/`](../../examples/log-axis-multi/), [`log-axis-compare/`](../../examples/log-axis-compare/).
- **Multiple Y-Axes**:
  - Instead of a single `yAxis` object, ChartGPU supports an array of Y axes via `axes.y` for independent scales (e.g. Price vs Volume).
  - Each axis in `axes.y` may specify an `id: string` (defaults: first axis `"y"`, then `"y1"`, …).
  - Series map to a specific axis via `yAxis` id in their config.
  - Axes can be positioned on the right using `position: "right"`. Default position is `"left"`, except for **candle-primary** charts (see below).
  - Dual Y may mix log + linear (e.g. log pressure + linear temperature). Horizontal grid follows the **primary** (first) Y axis ticks when that axis is log.
- **Finance-primary layout defaults** (when `series[0].type === 'candlestick'` or `'ohlc'`):
  - **Predicate**: only the first series type matters. Overlay lines as `series[0]` mean the chart is **not** candle-primary (set `position: 'right'` explicitly if needed). Helper: `isCandlePrimaryChart(userOptions)`.
  - **Y position**: the **first** Y axis defaults to `position: 'right'` when the user leaves `position` unset (`yAxis` or `axes.y[0]`). Secondary Y axes still default to `'left'`. Explicit `position` always wins.
  - **Soft grid gutters** (per-key only — each of `grid.left` / `grid.right` is set only when that key is `undefined` on user options; `0` is preserved):

    | Scenario | `grid.left` if unset | `grid.right` if unset |
    |----------|----------------------|------------------------|
    | Single candle, price on right | `20` | `70` |
    | Candle + volume (left Y remains) | `60` | `70` |
    | User set `grid.left: 80` only | `80` (kept) | `70` |
    | User set both margins | unchanged | unchanged |
    | Non-candle-primary | `60` | `20` |

  - Non-candle-primary charts keep the standard grid defaults and left Y.
  - **Migration (P1 default badge)**: candle-primary charts also **auto-enable** `priceLabel` (last-price badge + price line) when `priceLabel` is omitted. This is a **default visual change** for existing candle consumers. Opt out with `priceLabel: false`. To restore a pre-upgrade left-axis look:

```ts
{
  yAxis: { type: 'value', position: 'left' },
  grid: { left: 70, right: 24 },
  series: [{ type: 'candlestick', data, priceLabel: false }],
}
```

  - Recommended candle + volume dual-Y (or omit both gutters — dual-Y policy yields left `60` / right `70`):

```ts
{
  grid: { left: 60, right: 70 },
  axes: {
    y: [
      { id: 'price', position: 'right', type: 'value', header: 'USDT' },
      { id: 'vol', position: 'left', type: 'value' },
    ],
  },
  series: [
    {
      type: 'candlestick',
      yAxis: 'price',
      data,
      // Optional: countdown needs intervalMs (and nowMs for simulated clocks)
      priceLabel: { intervalMs: 60_000 },
    },
    { type: 'bar', yAxis: 'vol', data: volumes },
  ],
}
```

  - **Visual / acceptance checklist** (manual or example review):
    1. Candle-only, no axis/grid overrides → right price rail, thicker right gutter (~70), last-price badge + horizontal line at last close.
    2. `priceLabel: false` → no badge/line; axis defaults still apply unless you also set `position` / `grid`.
    3. Explicit `yAxis.position: 'left'` → left rail; badge anchors on the left when still shown.
    4. Dual-Y volume on left → left gutter ≥ 60, right 70; badge follows the **price** candlestick series only.
    5. Streaming with `intervalMs` + stable `nowMs` → countdown ticks under the price without extra GPU frames.
    6. `yAxis.header: 'USDT'` (or quote unit) → non-rotated top-rail label (not the rotated `name` title).
    7. Unit tests / acceptance: [`src/config/__tests__/OptionResolver.test.ts`](../../src/config/__tests__/OptionResolver.test.ts), [`resolvePriceLabel.test.ts`](../../src/config/__tests__/resolvePriceLabel.test.ts), [`examples/acceptance/candle-price-axis.ts`](../../examples/acceptance/candle-price-axis.ts).
- **Explicit domains (override auto-bounds)**:
  - **`AxisConfig.min?: number` / `AxisConfig.max?: number`**: when set, ChartGPU uses these explicit axis bounds and does **not** auto-derive bounds from data for that axis.
  - **Precedence**: explicit `min`/`max` always override any auto-bounds behavior.
  - **One-sided explicit**: if only `min` or only `max` is set, the other end is still data-derived; sticky auto-domain headroom (below) is **disabled** whenever either end is explicit so growBy padding never extends past a locked edge.
  - **Log**: both ends must resolve to strictly positive values (see log policy above).
- **Sticky auto-domain headroom (streaming / multi-chart)**:
  - When **both** ends of an axis are auto (no explicit `min`/`max`), ChartGPU uses a sticky domain: **first establish matches the data extrema exactly** (static column/mountain charts fill the plot).
  - **Y**: ~**10% growBy headroom** is added only when data **breaches** that domain (amortizes overlay rebuild under amplitude noise).
  - **X**: headroom is **0** so unbounded `appendData` tracks data max tightly and the series stays **full plot width**. Non-zero X pad previously left an empty right gutter that filled then re-expanded on every breach (visible as a grow/reset loop in examples like ultimate-benchmark streaming).
  - If the data **min slides upward** (FIFO/`maxPoints` drop-oldest), sticky **follows** the new min instead of freezing the historical origin. Sticky X is off entirely when `autoScroll: true`.
  - Cleared on `setOption` (including axes-only rewrites) and when any end becomes explicit.
  - Does **not** change sampling contracts (`lttb` stays `lttb`).
- **Y-axis auto-bounds during x-zoom (new default)**:
  - **`yAxis.autoBounds?: 'visible' | 'global'`** controls how ChartGPU derives the **y-axis** domain when `yAxis.min`/`yAxis.max` are not set.
    - **`'visible'` (default)**: when x-axis data zoom is active, ChartGPU derives y-bounds from the **visible** (zoomed) x-range (using the same sticky X domain the paint path uses when sticky is active).
    - **`'global'`**: derive y-bounds from the **full dataset** (pre-zoom behavior), even while x-zoomed.
  - This option is intended for `yAxis` (it has no effect on `xAxis`).
- **`AxisConfig.tickFormatter?: (value: number) => string | null`**: custom formatter for axis tick labels. When provided, replaces the built-in tick label formatting for that axis.
  - For `type: 'value'` axes, `value` is the numeric tick value.
  - For `type: 'time'` axes, `value` is a timestamp in milliseconds (epoch-ms, same unit as `new Date(ms)`).
  - For `type: 'log'` axes, `value` is the **data-space** tick value (e.g. `1000` for \(10^3\)), not the log exponent.
  - Return a `string` to display as the label, or `null` to suppress that specific tick label.
  - When omitted, ChartGPU uses its built-in formatting: `Intl.NumberFormat` for value axes, adaptive tier-based date formatting for time axes, and scientific/`1eN` hybrid labels for log axes.
  - The formatter is also used for label width measurement in the adaptive time x-axis tick count algorithm, ensuring overlap avoidance uses the correct label widths.

#### Tick Formatter Examples

```ts
// Duration formatting (seconds → human-readable)
yAxis: {
  tickFormatter: (seconds) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h`;
  }
}

// Percentage formatting (0–1 → 0%–100%)
yAxis: { tickFormatter: (v) => `${(v * 100).toFixed(0)}%` }

// Integer-only ticks (suppress fractional labels)
xAxis: { tickFormatter: (v) => Number.isInteger(v) ? v.toLocaleString() : null }

// Custom time axis formatting
xAxis: {
  type: 'time',
  tickFormatter: (ms) => new Date(ms).toLocaleDateString('de-DE')
}

// Append units
yAxis: { tickFormatter: (v) => `${v.toFixed(1)} ms` }
```

- **`xAxis.type: 'time'` (timestamps)**: when `xAxis.type === 'time'`, x-values are interpreted as **timestamps in milliseconds since Unix epoch** (the same unit accepted by `new Date(ms)`), including candlestick `timestamp` values. For GPU precision, ChartGPU may internally **rebase** large time x-values (e.g. epoch-ms domains) before uploading to Float32 vertex buffers; this is automatic and does not change your units. See the runtime axis label/tick logic in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- **Time x-axis tick labels (automatic tiers)**: when `xAxis.type === 'time'`, x-axis tick labels are formatted based on the **current visible x-range** (after data zoom):

  | Visible x-range (approx.) | Label format |
  |---|---|
  | `< 2 seconds` | `HH:mm:ss.SSS` |
  | `< 5 minutes` | `HH:mm:ss` |
  | `< 1 day` | `HH:mm` |
  | `1–7 days` | `MM/DD HH:mm` |
  | `~1–12 weeks` *(or `< ~3 months`)* | `MM/DD` |
  | `~3–12 months` *(≤ ~1 year)* | `MMM DD` |
  | `> ~1 year` | `YYYY/MM` |

  Notes: month/year thresholds are **approximate** (30d / 365d), and formatting uses the browser's `Date` semantics (**local timezone**). Sub-5-minute / sub-second tiers keep labels unique when deeply zoomed and update as you pan. Implementation: [`timeAxisUtils.ts`](../../src/core/renderCoordinator/utils/timeAxisUtils.ts) (`formatTimeTickValue`); wired from [`createRenderCoordinatorImpl.ts`](../../src/core/renderCoordinator/createRenderCoordinatorImpl.ts) (public shell: [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts)).
- **Nice time tick positions (time x-axis only)**: for `xAxis.type === 'time'`, tick **values** are snapped to a ladder of **epoch-aligned nice steps** (ms → s → min → h → day → week → ~month/~quarter/~year), not raw equal splits of `dataMin`→`dataMax`. Steps are absolute multiples of each ladder duration from Unix epoch (e.g. whole-hour UTC boundaries for hour steps)—not local midnights, week starts, or true calendar month boundaries. Label text still uses local `Date` formatting, so wall-clock labels can differ from the absolute grid depending on timezone offset. That still avoids awkward mid-interval times like `02:41` / `08:40` on a full-day view in favor of nice hour/day spacing. Non-time (`value`) axes still use evenly spaced linear ticks. See [`timeAxisUtils.ts`](../../src/core/renderCoordinator/utils/timeAxisUtils.ts).
- **Adaptive tick count (overlap avoidance, time x-axis only)**: when `xAxis.type === 'time'`, ChartGPU may **vary tick density per render** to avoid DOM label overlap. Density is **step-wise**, not an exact linear count: it tries denser nice-step sets first (target count in **\[1, 9]**), and when a candidate set's labels overlap it may **subsample** that set (every 2nd / 3rd tick) before dropping to a coarser ladder target. The densest non-overlapping set is kept (minimum gap **6 CSS px**); if measurement isn't available it falls back to a default-density nice tick set. **GPU tick marks and DOM tick labels share the same computed tick values** (nice time steps for time axes; linear domain splits for value axes). See [`timeAxisUtils.ts`](../../src/core/renderCoordinator/utils/timeAxisUtils.ts) (`computeAdaptiveTimeXAxisTicks`), [`createRenderCoordinatorImpl.ts`](../../src/core/renderCoordinator/createRenderCoordinatorImpl.ts), and [`createAxisRenderer.ts`](../../src/renderers/createAxisRenderer.ts).
- **`AxisConfig.name?: string`**: renders an axis title for cartesian charts when provided (and non-empty after `trim()`): x-axis titles are centered below x-axis tick labels, and y-axis titles are rotated \(-90°\) and placed left of y-axis tick labels (or \(+90°\) on the right rail); titles can be clipped if `grid.bottom` / `grid.left` / `grid.right` margins are too small. When `dataZoom` includes a slider (see below), ChartGPU reserves extra bottom space so the x-axis title remains visible above the slider overlay and is centered within the remaining space above the slider track. See [`createRenderCoordinatorImpl.ts`](../../src/core/renderCoordinator/createRenderCoordinatorImpl.ts) (public shell: [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts)) and option resolution in [`OptionResolver.ts`](../../src/config/OptionResolver.ts).
- **`AxisConfig.header?: string`**: optional **non-rotated** unit header at the **top of a Y-axis rail** (e.g. `"USDT"` for a quote currency). Independent of `name` — use `header` for short exchange-style unit labels and keep `name` for a longer rotated side title if needed. Applies to `yAxis` / `axes.y` only (ignored for `xAxis`). Place it with enough `grid.top` margin so it is not clipped. Rendered via the same axis text overlay as tick labels (bold, theme `textColor` / `fontFamily`).

```ts
// Exchange-style right price axis with unit header
yAxis: { type: 'value', header: 'USDT' } // candle-primary defaults position to 'right'
```

- **Axis title styling**: titles are rendered via the internal DOM text overlay and use the resolved theme's `textColor` and `fontFamily` with slightly larger, bold text (label elements also set `dir='auto'`).

## Grid Lines Configuration

- **`ChartGPUOptions.gridLines?: GridLinesConfig`**: optional configuration for the background grid lines drawn inside the plot area. See [`GridLinesConfig`](../../src/config/types.ts) and [`defaults.ts`](../../src/config/defaults.ts).
- **What grid lines are**: grid lines are evenly-spaced lines drawn across the plot grid to aid visual reading of values. They are **not aligned to axis ticks** — they are distributed uniformly across the horizontal and vertical extent of the plot area. Lines are rendered via a WebGPU `line-list` primitive, so they are always **1 device pixel wide** (this is a WebGPU limitation; line width is not configurable).
- **Default behavior**: when `gridLines` is omitted, grid lines are shown using the theme's `gridLineColor` (dark theme: `rgba(255,255,255,0.1)`; light theme: `rgba(0,0,0,0.1)`) with 5 horizontal and 6 vertical lines. See [`defaultGridLines`](../../src/config/defaults.ts) and [`createGridRenderer.ts`](../../src/renderers/createGridRenderer.ts).

### `GridLinesConfig`

Top-level grid lines configuration. See [`types.ts`](../../src/config/types.ts).

- **`show?: boolean`**: global toggle for all grid lines. When `false`, no grid lines are drawn. Default: `true`.
- **`color?: string`**: CSS color string for all grid lines. Can be overridden per-direction via `horizontal.color` or `vertical.color`. Falls back to `theme.gridLineColor` when not specified. Expected formats: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`, `rgba(r,g,b,a)`.
- **`opacity?: number`**: global opacity multiplier for grid lines (0–1). This multiplies the alpha channel of the resolved color (including per-direction overrides). Default: `1`.
- **`horizontal?: boolean | GridLinesDirectionConfig`**: horizontal grid lines (constant-Y, spanning left→right). Accepts a boolean shorthand (`true` = show with defaults, `false` = hide) or a detailed [`GridLinesDirectionConfig`](#gridlinesdirectionconfig). Default: `{ show: true, count: 5 }`.
- **`vertical?: boolean | GridLinesDirectionConfig`**: vertical grid lines (constant-X, spanning top→bottom). Accepts a boolean shorthand (`true` = show with defaults, `false` = hide) or a detailed [`GridLinesDirectionConfig`](#gridlinesdirectionconfig). Default: `{ show: true, count: 6 }`.

### `GridLinesDirectionConfig`

Per-direction (horizontal or vertical) grid line settings. See [`types.ts`](../../src/config/types.ts).

- **`show?: boolean`**: whether to show grid lines in this direction. When `false`, no lines are drawn regardless of `count`. Default: `true`.
- **`count?: number`**: number of evenly-spaced grid lines. Default: `5` (horizontal), `6` (vertical).
- **`color?: string`**: CSS color string for lines in this direction. Overrides the top-level `gridLines.color` and `theme.gridLineColor`.

### Grid Lines Examples

```ts
gridLines: { show: false }  // hide all
gridLines: { horizontal: true, vertical: false }  // horizontal only
gridLines: { color: 'rgba(100,100,255,0.2)', horizontal: { count: 8 }, vertical: { count: 10 } }
```

## Data Zoom Configuration

- **`ChartGPUOptions.dataZoom?: ReadonlyArray<DataZoomConfig>`**: optional data-zoom configuration list. See [`ChartGPUOptions`](../../src/config/types.ts) and [`DataZoomConfig`](../../src/config/types.ts).
- **Runtime behavior (current)**: data zoom controls a shared percent-space zoom window `{ start, end }` in \([0, 100]\) that is applied to the effective x-domain for both rendering and pointer interaction. See the x-domain application in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and percent-space semantics in [`createZoomState.ts`](../../src/interaction/createZoomState.ts).
  - **Span constraints (min/max)**: ChartGPU clamps the zoom window span using `DataZoomConfig.minSpan` / `DataZoomConfig.maxSpan` **at runtime** (applies consistently to inside zoom, slider UI, and programmatic APIs), and re-applies constraints when options/data change (e.g. on `setOption(...)` and streaming `appendData(...)`). See [`createZoomState.ts`](../../src/interaction/createZoomState.ts) and coordinator wiring in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
    - When `minSpan` / `maxSpan` are omitted, ChartGPU uses a **dataset-aware default minimum span** for `xAxis.type: 'value' | 'time'`, targeting roughly **one data interval**: approximately \(100/(N-1)\)% where \(N\) is the **largest raw point count** across non-pie cartesian series (raw/unsampled data; updates as points are appended). When there is insufficient data to infer an interval (\(N < 2\)), ChartGPU falls back to **0.5%** to keep the UI usable. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
    - For `xAxis.type: 'category'`, no dataset-aware default is currently applied; use `minSpan` explicitly if you need deeper zoom for very large category counts.
  - **Zoom-aware sampling (cartesian)**: when a cartesian series has sampling enabled, ChartGPU resamples from raw (unsampled) series data over the current visible x-range; visible-range slicing is applied **immediately** during zoom/pan for smooth visual feedback, while full resampling is **debounced (~100ms)** for performance; a ±10% buffer zone reduces resampling frequency during small pans. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
  - **Inside zoom**: when `ChartGPUOptions.dataZoom` includes `{ type: 'inside' }`, ChartGPU enables an internal wheel/drag interaction. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and [`createInsideZoom.ts`](../../src/interaction/createInsideZoom.ts).
  - **Zoom gesture**: mouse wheel zoom, centered on the current cursor x-position (only when the pointer is inside the plot grid).
  - **Pan gesture**: shift+left-drag or middle-mouse drag pans left/right (only when the pointer is inside the plot grid).
  - **Scope**: the zoom window is applied to the x-domain; the y-domain is derived from data unless you set explicit `yAxis.min`/`yAxis.max`.
    - Default behavior: during x-zoom, `yAxis.autoBounds: 'visible'` derives y-bounds from the **visible** x-range.
    - Opt out: set `yAxis.autoBounds: 'global'` to keep y-bounds derived from the **full dataset**, or set explicit `yAxis.min`/`yAxis.max`.
  - **Grid-only**: input is ignored outside the plot grid (respects `grid` margins).
  - **Slider UI**: when `ChartGPUOptions.dataZoom` includes `{ type: 'slider' }`, ChartGPU mounts a slider-style UI that manipulates the same percent zoom window. ChartGPU also reserves **40 CSS px** of additional bottom plot space so x-axis tick labels and the x-axis title remain visible above the slider overlay (you generally should not need to manually “make room” by increasing `grid.bottom`). See [`ChartGPU.ts`](../../src/ChartGPU.ts), option resolution in [`OptionResolver.ts`](../../src/config/OptionResolver.ts), and the internal UI helper [`createDataZoomSlider.ts`](../../src/components/createDataZoomSlider.ts).
  - **Coexistence**: multiple data-zoom configs can coexist (e.g. inside + slider) and drive the same x-zoom window.
  - **Config fields**: `start` / `end` are used as the initial percent window (defaulting to `0` / `100` when omitted). `minSpan` / `maxSpan` are applied to the runtime clamping behavior (see above). `xAxisIndex` is currently accepted by the type but only `xAxisIndex: 0` is supported by the runtime zoom path.
- **`DataZoomConfig`**: data zoom configuration type. See [`DataZoomConfig`](../../src/config/types.ts).
  - **`type: 'inside' | 'slider'`**
  - **`xAxisIndex?: number`**
  - **`start?: number`**: start percent in \([0, 100]\)
  - **`end?: number`**: end percent in \([0, 100]\)
  - **`minSpan?: number`**
  - **`maxSpan?: number`**

## Tooltip Configuration

- **`tooltip?: TooltipConfig`**: `show`, `trigger: 'item' | 'axis'`, `formatter`. Enabled by default.
- **`TooltipParams.value`**: `[x, y]` (cartesian/pie), `[timestamp, open, close, low, high]` (candlestick). Distinguish via `value.length`.
- **Safety**: tooltip uses `innerHTML` — return trusted/sanitized strings only.
- Helpers: `formatTooltipItem`, `formatTooltipAxis` in [`formatTooltip.ts`](../../src/components/formatTooltip.ts). Examples: [`basic-line/`](../../examples/basic-line/), [`interactive/`](../../examples/interactive/).

## Animation Configuration

- **`ChartGPUOptions.animation?: AnimationConfig | boolean`**: optional animation configuration.
  - **Default**: when omitted, animation is enabled with defaults (equivalent to `true`). See [`OptionResolver.ts`](../../src/config/OptionResolver.ts).
  - **Disablement**: set to `false` to disable all animation.
  - **Defaults**: when enabled, `AnimationConfig.duration` defaults to `300`ms when omitted.
- **`AnimationConfig`**: supports optional `duration?: number` (ms), `easing?: 'linear' | 'cubicOut' | 'cubicInOut' | 'bounceOut'`, and `delay?: number` (ms). See [`types.ts`](../../src/config/types.ts).
  - **Built-in easing implementations (internal)**: see [`easing.ts`](../../src/utils/easing.ts) and the name→function helper `getEasing(...)`.
- **Initial-load intro animation**: when animation is enabled, series marks animate on first render. Axes, grid lines, and labels render immediately (not animated). Per-series effects: line/area series reveal left-to-right via plot scissor; bar series grow upward from baseline; pie slices expand radius; scatter points fade in. The intro animation requests frames internally during the transition. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts). Streaming demos may prefer disabling animation (`animation: false`).
- **Data update transition animation**: when animation is enabled, subsequent calls to `ChartGPUInstance.setOption(...)` (and the internal `RenderCoordinator.setOptions(...)`) that change series data can animate transitions after the initial render has occurred. See the internal implementation in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and the visual acceptance examples in [`examples/data-update-animation/`](../../examples/data-update-animation/) (bar + line + pie) and [`examples/multi-series-animation/`](../../examples/multi-series-animation/) (area + bar + line + scatter on a single chart, with configurable line width).
  - **When it triggers (high-level)**: a post-initial-render options update that changes `series[i].data` (cartesian and pie), with `ChartGPUOptions.animation` enabled.
  - **What animates (high-level)**:
    - **Cartesian series**: y-values interpolate by index while x-values come from the new series (index-aligned). Bars morph via the same y interpolation.
    - **Pie series**: slice values interpolate by index, producing animated angle changes.
    - **Derived domains/scales**: when auto-derived axis domains change (from updated data), the domain values animate to the new extents.
  - **Constraints / notes (high-level)**:
    - **Match-by-index**: interpolation is index-based; length changes and type/shape mismatches may skip interpolation and apply the new series immediately.
    - **Large-series safeguard**: very large series may skip per-point interpolation while still animating derived domains (internal safeguard).
    - **Mid-flight updates**: a new `setOption(...)` during an active transition rebases the transition from the current displayed state (avoids a visual jump).

## OHLC Data Types

**`OHLCDataPoint` (public export):** exported from the public entrypoint [`src/index.ts`](../../src/index.ts) and defined in [`types.ts`](../../src/config/types.ts). Represents a candlestick data point as either a tuple (`readonly [timestamp, open, close, low, high]`, ECharts order) or an object (`Readonly<{ timestamp, open, close, low, high }>`). Used by `CandlestickSeriesConfig`. Both candlestick rendering and OHLC sampling are fully functional (see **CandlestickSeriesConfig** above).

**`candlestickDefaults` (public export):** exported from the public entrypoint [`src/index.ts`](../../src/index.ts) and defined in [`defaults.ts`](../../src/config/defaults.ts). Provides default configuration values for candlestick series. Both candlestick rendering and OHLC sampling are fully functional (see **CandlestickSeriesConfig** above).

## Default Options

Default chart options used as a baseline for resolution.

See [`defaults.ts`](../../src/config/defaults.ts) for the defaults (including grid, grid lines, palette, and axis defaults).

**Behavior notes (essential):**

- **Default grid**: `left: 60`, `right: 20`, `top: 40`, `bottom: 40` (non-candle-primary). Candle-primary soft gutters: see **Candle-primary layout defaults** under Axis Configuration (`right: 70`; `left: 20` or `60` depending on left Y axes).
- **Palette / series colors**: `ChartGPUOptions.palette` acts as an override for the resolved theme palette (`resolvedOptions.theme.colorPalette`). When `series[i].color` is missing, the default series color comes from `resolvedOptions.theme.colorPalette[i % ...]`. For backward compatibility, the resolved `palette` is the resolved theme palette. See [`resolveOptions`](../../src/config/OptionResolver.ts) and [`ThemeConfig`](themes.md#themeconfig).
- **Line series stroke color precedence**: for `type: 'line'`, effective stroke color follows: `lineStyle.color` → `series.color` → theme palette. See [`resolveOptions`](../../src/config/OptionResolver.ts).
- **Line series fill color precedence**: for `type: 'line'` with `areaStyle`, effective fill color follows: `areaStyle.color` → resolved stroke color (from above precedence). See [`resolveOptions`](../../src/config/OptionResolver.ts).
- **Area series fill color precedence**: for `type: 'area'`, effective fill color follows: `areaStyle.color` → `series.color` → theme palette. See [`resolveOptions`](../../src/config/OptionResolver.ts).
- **Axis ticks**: `AxisConfig.tickLength` controls tick length in CSS pixels (default: 6)

## Performance Metrics Types

- **`PerformanceMetrics`**: `fps`, `frameTimeStats` (min/max/avg/p50/p95/p99), `gpuTiming`, `memory`, `frameDrops`, `totalFrames`, `elapsedTime`. Returns `null` before first frame.
- **`PerformanceCapabilities`**: `gpuTimingSupported`, `highResTimerSupported`, `performanceMetricsSupported`.
- Branded types: `ExactFPS`, `Milliseconds`, `Bytes`. See [`types.ts`](../../src/config/types.ts).

## `resolveOptions(userOptions?: ChartGPUOptions)` / `OptionResolver.resolve(userOptions?: ChartGPUOptions)`

Resolves user options against defaults by deep-merging user-provided values with defaults and returning a resolved options object.

See [`OptionResolver.ts`](../../src/config/OptionResolver.ts) for the resolver API and resolved option types.

**Behavior notes (essential):**

- **Theme input**: `ChartGPUOptions.theme` accepts `'dark' | 'light'` or a [`ThemeConfig`](themes.md#themeconfig); the resolved `theme` is always a concrete `ThemeConfig`. See [`ChartGPUOptions`](../../src/config/types.ts) and [`resolveOptions`](../../src/config/OptionResolver.ts).
- **Default theme**: when `theme` is omitted, the resolved theme defaults to `'dark'` via [`getTheme`](../../src/themes/index.ts) (preset: [`darkTheme`](../../src/themes/darkTheme.ts)).
- **Theme name resolution**: `resolveOptions({ theme: 'light' })` resolves `theme` to the light preset config (see [`lightTheme`](../../src/themes/lightTheme.ts)).
- **Palette override**: when `ChartGPUOptions.palette` is provided (non-empty), it overrides the resolved theme palette (`resolvedOptions.theme.colorPalette`). The resolved `palette` mirrors the resolved theme palette for backward compatibility. See [`resolveOptions`](../../src/config/OptionResolver.ts).
