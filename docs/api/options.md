# Chart Options

Chart configuration options.

See [`types.ts`](../../src/config/types.ts) for the full type definition.

## `ChartGPUOptions`

**Theme (essential):**

- **`ChartGPUOptions.theme`**: accepts `'dark' | 'light'` or a [`ThemeConfig`](themes.md#themeconfig) object. See [`ChartGPUOptions`](../../src/config/types.ts) and [`ThemeName` / `getTheme`](../../src/themes/index.ts).

**Data points (essential):**

- **`DataPoint`**: a series data point is either a tuple (`readonly [x, y, size?]`) or an object (`Readonly<{ x, y, size? }>`). See [`types.ts`](../../src/config/types.ts).

**Auto-scroll (streaming):**

- **`ChartGPUOptions.autoScroll?: boolean`**: when `true`, calls to `ChartGPUInstance.appendData(...)` may automatically keep the visible x-range "anchored" to the newest data **only when x-axis data zoom is enabled** (i.e. there is a percent-space zoom window `{ start, end }` in \([0, 100]\)) and `xAxis.min`/`xAxis.max` are not set. Default: `false` (see [`defaults.ts`](../../src/config/defaults.ts)).
  - **Pinned-to-end behavior**: when the current zoom window is effectively "at the end" (`end` near `100`), ChartGPU preserves the current window span and keeps `end` pinned at `100` as new data arrives.
  - **Panned-away behavior**: when the user has panned away from the end (`end` meaningfully less than `100`), ChartGPU preserves the previous visible domain instead of yanking the view back to the newest data.
  - **Limitations**: auto-scroll is applied on streaming append (not on `setOption(...)`). See the runtime implementation in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts). For a working demo (including a toggle and slider), see [`examples/live-streaming/`](../../examples/live-streaming/).

## Annotations

- **`ChartGPUOptions.annotations?: ReadonlyArray<AnnotationConfig>`**: optional annotation overlays (lines, points, and text). An annotation can be a vertical line (`type: 'lineX'`), horizontal line (`type: 'lineY'`), point marker (`type: 'point'`), or free text (`type: 'text'`). For `type: 'text'` with `position.space: 'plot'`, `position.x` and `position.y` are **fractions in [0, 1]** of the plot grid (0 = left/top, 1 = right/bottom). See [`AnnotationConfig`](../../src/config/types.ts).
- **Layering**: `layer?: 'belowSeries' | 'aboveSeries'` controls whether an annotation draws under or over series marks.
- **Styling**: `style?: { color?, lineWidth?, lineDash?, opacity? }` (and `marker.style` for points) accepts CSS color strings and basic line styling.
- **Labels**: annotations support `label?: { text?, template?, decimals?, offset?, anchor?, background? }`.
- **Interactive authoring (main thread)**: for a helper that adds right-click annotation authoring (context menu + toolbar) and updates `options.annotations` via `setOption(...)`, see `createAnnotationAuthoring(...)` and [`examples/annotation-authoring/`](../../examples/annotation-authoring/).
- **Full documentation**: see [Annotations API](./annotations.md) for comprehensive guide including annotation types, interactive authoring, drag-to-reposition, and advanced usage examples.

## Series Configuration

- **`SeriesType`**: `'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'candlestick'`. See [`types.ts`](../../src/config/types.ts).
- **`SeriesConfig`**: `LineSeriesConfig | AreaSeriesConfig | BarSeriesConfig | ScatterSeriesConfig | PieSeriesConfig | CandlestickSeriesConfig` (discriminated by `series.type`). See [`types.ts`](../../src/config/types.ts).
- **Sampling (cartesian series only)**: cartesian series support optional `sampling?: 'none' | 'lttb' | 'average' | 'max' | 'min'` and optional `samplingThreshold?: number` (applied when the input series data length exceeds the threshold). When omitted, defaults are `sampling: 'lttb'` and `samplingThreshold: 5000` via [`resolveOptions`](../../src/config/OptionResolver.ts) and baseline defaults in [`defaults.ts`](../../src/config/defaults.ts). Sampling affects rendering and cartesian hit-testing only; axis auto-bounds are derived from raw (unsampled) series data unless you set `xAxis.min`/`xAxis.max` or `yAxis.min`/`yAxis.max` (see [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts)). When x-axis data zoom is enabled, sampling is re-applied against the **visible x-range** (from the percent-space zoom window in \([0, 100]\)) using raw data; visible-range slicing is applied **immediately** during zoom/pan for smooth visual feedback, while full resampling is **debounced (~100ms)** for performance; a ±10% buffer zone reduces resampling frequency during small pans (see [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts)). Pie series (`type: 'pie'`) do not support these fields (pie is non-cartesian).

### Series Visibility

- **`SeriesConfig.visible?: boolean`**: Controls whether a series is rendered and included in interaction (hover, tooltips, clicks).
  - When `visible === false`, the series is hidden from both rendering and interaction hit-testing.
  - When `visible !== false` (default), the series is visible and participates in rendering and interaction.
- **Legend toggle interaction**: When users click legend items to toggle series visibility, the chart correctly updates both rendering and interaction state. Hovering over remaining visible series works correctly regardless of other series' visibility state.
  - Hit-testing functions (`findNearestPoint`, `findPointsAtX`, `findPieSlice`, `findCandlestick`) filter for visible series internally and preserve correct series indices.
  - This ensures tooltips, hover highlights, and click events work accurately on visible series after others are hidden.

### CandlestickSeriesConfig

Extends shared series fields with `type: 'candlestick'` and OHLC-specific configuration. See [`types.ts`](../../src/config/types.ts).

- **Data format**: uses `OHLCDataPoint` (either tuple `[timestamp, open, close, low, high]` or object `{ timestamp, open, close, low, high }`). See [`types.ts`](../../src/config/types.ts).
- **Rendering**: candlestick series are now rendered with bodies (rectangles) and wicks (thin lines) via the internal renderer [`createCandlestickRenderer.ts`](../../src/renderers/createCandlestickRenderer.ts) using shader [`candlestick.wgsl`](../../src/shaders/candlestick.wgsl). The render coordinator orchestrates candlestick rendering in the series drawing pass; see [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- **Candlestick styles**: candlesticks support two rendering styles via `CandlestickSeriesConfig.style`: `'classic'` (default, filled bodies for all candles) and `'hollow'` (hollow body when close > open, filled when close < open). See [`types.ts`](../../src/config/types.ts).
- **OHLC sampling**: candlestick series support `sampling?: 'none' | 'ohlc'`. When `sampling === 'ohlc'`, ChartGPU applies bucket aggregation that preserves OHLC semantics: first and last candles are preserved exactly; middle candles aggregate into buckets where each bucket uses `timestamp` and `open` from the first candle in the bucket, `close` from the last candle in the bucket, `high` as the max of all highs in the bucket, and `low` as the min of all lows in the bucket. Endpoints are always preserved. See [`ohlcSample.ts`](../../src/data/ohlcSample.ts).
- **Zoom-aware OHLC resampling**: when x-axis data zoom is enabled and `sampling === 'ohlc'`, ChartGPU resamples based on the visible timestamp range with a policy of `targetPoints = min(visibleDataLength * 32, 200000)` (32× multiplier with 200K cap). Visible-range slicing is applied **immediately** during zoom/pan for smooth visual feedback, while full resampling is **debounced (~100ms)** for performance; a ±10% buffer zone reduces resampling frequency during small pans. Uses raw (unsampled) data as the source. Axis bounds and zoom mapping always use raw (unsampled) bounds regardless of sampling mode. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- **Interaction limitations (important)**: candlesticks support **body-only** hit-testing for tooltip/hover/click interactions (wicks are not hoverable). See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and [`findCandlestick.ts`](../../src/interaction/findCandlestick.ts).
- **Example**: for a working candlestick chart with style toggle, see [`examples/candlestick/`](../../examples/candlestick/).
- **Streaming example**: for a live tick simulator aggregating into candles (append new candles at the candle boundary, throttle forming-candle updates), see [`examples/candlestick-streaming/`](../../examples/candlestick-streaming/).
- **Acceptance test**: for OHLC sampling validation (endpoint preservation, aggregation rules, edge cases), see [`examples/acceptance/ohlc-sample.ts`](../../examples/acceptance/ohlc-sample.ts).

### LineSeriesConfig

Extends the shared series fields with `type: 'line'`, optional `lineStyle?: LineStyleConfig`, and optional `areaStyle?: AreaStyleConfig`.

- **`lineStyle.width?: number`**: Line width in CSS pixels. Default: `2` (see [`defaults.ts`](../../src/config/defaults.ts)). Lines are rendered with SDF (Signed Distance Field) anti-aliasing, producing smooth edges at any width.
- **`lineStyle.opacity?: number`**: Line opacity (0.0–1.0). Default: `1`. Composites via alpha blending.
- **`lineStyle.color?: string`**: Line color (CSS color string). When omitted, uses series color precedence (see [Default Options](#default-options)).
- When a line series includes `areaStyle`, ChartGPU renders a filled area behind the line (area fills then line strokes). See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

### AreaSeriesConfig

Extends the shared series fields with `type: 'area'`, optional `baseline?: number`, and optional `areaStyle?: AreaStyleConfig`.

- **`baseline`** is a data-space "filled area floor". If omitted, ChartGPU defaults it to the y-axis minimum.
- **`areaStyle.opacity`** controls the fill opacity.

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

### PieSeriesConfig

Extends the shared series fields with `type: 'pie'`. See [`types.ts`](../../src/config/types.ts).

- **Behavior notes (important)**: pie series are **non-cartesian** and are rendered as pie/donut slices by the render coordinator (see [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and [`createPieRenderer.ts`](../../src/renderers/createPieRenderer.ts)).
- **Interaction + bounds notes (important)**:
  - Pie series do **not** participate in cartesian x/y bounds derivation (they do not affect `xAxis`/`yAxis` min/max auto-derivation).
  - Pie series do **not** participate in cartesian hit-testing utilities (see [`findNearestPoint.ts`](../../src/interaction/findNearestPoint.ts) and [`findPointsAtX.ts`](../../src/interaction/findPointsAtX.ts)).
  - Pie slices **do** support hover hit-testing for ChartGPU's internal tooltip and ChartGPU instance events (`'click'`, `'mouseover'`, `'mouseout'`) via [`findPieSlice.ts`](../../src/interaction/findPieSlice.ts) (wired in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and [`ChartGPU.ts`](../../src/ChartGPU.ts)).
- **Pie-only charts**: when `series` contains only `type: 'pie'`, the render coordinator skips cartesian x/y axis rendering and does not render the DOM tick value labels. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- **Slice colors**: each `PieDataItem` supports `color?: string`. Color precedence is **`item.color`** when provided, otherwise a palette fallback (see [`resolveOptions`](../../src/config/OptionResolver.ts)). For a working example, see [`examples/pie/`](../../examples/pie/).

### BarItemStyleConfig

Bar styling options. See [`types.ts`](../../src/config/types.ts).

- **`borderRadius?: number`**
- **`borderWidth?: number`**
- **`borderColor?: string`**

## Axis Configuration

- **`AxisConfig`**: configuration for `xAxis` / `yAxis`. See [`types.ts`](../../src/config/types.ts).
- **Explicit domains (override auto-bounds)**:
  - **`AxisConfig.min?: number` / `AxisConfig.max?: number`**: when set, ChartGPU uses these explicit axis bounds and does **not** auto-derive bounds from data for that axis.
  - **Precedence**: explicit `min`/`max` always override any auto-bounds behavior.
- **Y-axis auto-bounds during x-zoom (new default)**:
  - **`yAxis.autoBounds?: 'visible' | 'global'`** controls how ChartGPU derives the **y-axis** domain when `yAxis.min`/`yAxis.max` are not set.
    - **`'visible'` (default)**: when x-axis data zoom is active, ChartGPU derives y-bounds from the **visible** (zoomed) x-range.
    - **`'global'`**: derive y-bounds from the **full dataset** (pre-zoom behavior), even while x-zoomed.
  - This option is intended for `yAxis` (it has no effect on `xAxis`).
- **`xAxis.type: 'time'` (timestamps)**: when `xAxis.type === 'time'`, x-values are interpreted as **timestamps in milliseconds since Unix epoch** (the same unit accepted by `new Date(ms)`), including candlestick `timestamp` values. For GPU precision, ChartGPU may internally **rebase** large time x-values (e.g. epoch-ms domains) before uploading to Float32 vertex buffers; this is automatic and does not change your units. See the runtime axis label/tick logic in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- **Time x-axis tick labels (automatic tiers)**: when `xAxis.type === 'time'`, x-axis tick labels are formatted based on the **current visible x-range** (after data zoom):

  | Visible x-range (approx.) | Label format |
  |---|---|
  | `< 1 day` | `HH:mm` |
  | `1–7 days` | `MM/DD HH:mm` |
  | `~1–12 weeks` *(or `< ~3 months`)* | `MM/DD` |
  | `~3–12 months` *(≤ ~1 year)* | `MMM DD` |
  | `> ~1 year` | `YYYY/MM` |

  Notes: month/year thresholds are **approximate** (30d / 365d), and formatting uses the browser's `Date` semantics (local timezone). See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- **Adaptive tick count (overlap avoidance, time x-axis only)**: when `xAxis.type === 'time'`, ChartGPU may **vary the tick count per render** to avoid DOM label overlap. It picks the largest tick count in **\[1, 9]** whose measured labels do not overlap (minimum gap **6 CSS px**); if measurement isn't available it falls back to the default tick count. **GPU tick marks and DOM tick labels use the same computed tick count.** See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and [`createAxisRenderer.ts`](../../src/renderers/createAxisRenderer.ts).
- **`AxisConfig.name?: string`**: renders an axis title for cartesian charts when provided (and non-empty after `trim()`): x-axis titles are centered below x-axis tick labels, and y-axis titles are rotated \(-90°\) and placed left of y-axis tick labels; titles can be clipped if `grid.bottom` / `grid.left` margins are too small. When `dataZoom` includes a slider (see below), ChartGPU reserves extra bottom space so the x-axis title remains visible above the slider overlay and is centered within the remaining space above the slider track. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and option resolution in [`OptionResolver.ts`](../../src/config/OptionResolver.ts).
- **Axis title styling**: titles are rendered via the internal DOM text overlay and use the resolved theme's `textColor` and `fontFamily` with slightly larger, bold text (label elements also set `dir='auto'`).

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

- **`ChartGPUOptions.tooltip?: TooltipConfig`**: optional tooltip configuration. See [`types.ts`](../../src/config/types.ts).
- **Enablement**: when `tooltip.show !== false`, ChartGPU creates an internal DOM tooltip overlay and updates it on hover; when `tooltip.show === false`, the tooltip is not shown.
- **Hover behavior**: tooltip updates on pointer movement within the plot grid and hides on pointer leave. For cartesian series it uses cartesian hit-testing (see [`findNearestPoint.ts`](../../src/interaction/findNearestPoint.ts) and [`findPointsAtX.ts`](../../src/interaction/findPointsAtX.ts)); for pie series it uses pie slice hit-testing (see [`findPieSlice.ts`](../../src/interaction/findPieSlice.ts)). See the tooltip logic in [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- **`TooltipConfig.trigger?: 'item' | 'axis'`**: tooltip trigger mode.
- **`TooltipConfig.formatter?: (params: TooltipParams | TooltipParams[]) => string`**: custom formatter function. Receives a single `TooltipParams` when `trigger` is `'item'`, or an array of `TooltipParams` when `trigger` is `'axis'`. See [`types.ts`](../../src/config/types.ts) for `TooltipParams` fields (`seriesName`, `seriesIndex`, `dataIndex`, `value`, `color`). The `value` field is a readonly tuple: `[x, y]` for cartesian series (line, area, bar, scatter), or `[timestamp, open, close, low, high]` for candlestick series. Custom formatters can distinguish by checking `params.value.length` (2 vs 5). See [`formatTooltip.ts`](../../src/components/formatTooltip.ts) for the default formatter implementations.
- **Candlestick tooltip positioning**: when a candlestick series is hovered or included in axis-trigger mode, the tooltip anchors to the candle body center (vertical midpoint between open and close values) rather than the cursor position, providing stable positioning. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

### `TooltipParams` (public export)

Exported from the public entrypoint [`src/index.ts`](../../src/index.ts) and defined in [`types.ts`](../../src/config/types.ts).

Tooltip value tuples:

- **Cartesian series** (line, area, bar, scatter): `params.value` is `readonly [number, number]` for `[x, y]`.
- **Candlestick series**: `params.value` is `readonly [number, number, number, number, number]` for `[timestamp, open, close, low, high]`. Candlestick tooltips anchor to the candle body center rather than cursor position.
- **Pie series**: `params.value` is `readonly [number, number]` for `[0, sliceValue]` (non-cartesian; x-slot is `0`).

Custom formatters can distinguish series types by checking `params.value.length` or by using a type guard. See [`formatTooltip.ts`](../../src/components/formatTooltip.ts) for examples.

Default tooltip formatter helpers are available in [`formatTooltip.ts`](../../src/components/formatTooltip.ts): `formatTooltipItem(params: TooltipParams): string` (item mode) and `formatTooltipAxis(params: TooltipParams[]): string` (axis mode). Both return HTML strings intended for the internal tooltip overlay's `innerHTML` usage; the axis formatter includes an x header line.

Notes:

- For pie slice tooltips, `TooltipParams.seriesName` uses the slice `name` (not the series `name`), and `TooltipParams.value` is `readonly [number, number]` for `[0, sliceValue]` (pie is non-cartesian; the x-slot is `0`). See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- For candlestick tooltips, `TooltipParams.value` is `readonly [number, number, number, number, number]` for `[timestamp, open, close, low, high]`. In both item and axis trigger modes, the tooltip anchors to the candle body center (vertical midpoint between open and close) rather than the cursor position for stable positioning. See [`formatTooltip.ts`](../../src/components/formatTooltip.ts) and [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

**Content safety (important)**: the tooltip overlay assigns `content` via `innerHTML`. Only return trusted/sanitized strings from `TooltipConfig.formatter`. See the internal tooltip overlay helper in [`createTooltip.ts`](../../src/components/createTooltip.ts) and the default formatter helpers in [`formatTooltip.ts`](../../src/components/formatTooltip.ts).

For a working configuration (including axis titles via `AxisConfig.name` and a filled line series via `areaStyle`), see [`examples/basic-line/main.ts`](../../examples/basic-line/main.ts).

For an axis-trigger tooltip formatter that renders all series values at the hovered x (e.g. time-series), see [`examples/interactive/main.ts`](../../examples/interactive/main.ts).

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

See [`defaults.ts`](../../src/config/defaults.ts) for the defaults (including grid, palette, and axis defaults).

**Behavior notes (essential):**

- **Default grid**: `left: 60`, `right: 20`, `top: 40`, `bottom: 40`
- **Palette / series colors**: `ChartGPUOptions.palette` acts as an override for the resolved theme palette (`resolvedOptions.theme.colorPalette`). When `series[i].color` is missing, the default series color comes from `resolvedOptions.theme.colorPalette[i % ...]`. For backward compatibility, the resolved `palette` is the resolved theme palette. See [`resolveOptions`](../../src/config/OptionResolver.ts) and [`ThemeConfig`](themes.md#themeconfig).
- **Line series stroke color precedence**: for `type: 'line'`, effective stroke color follows: `lineStyle.color` → `series.color` → theme palette. See [`resolveOptions`](../../src/config/OptionResolver.ts).
- **Line series fill color precedence**: for `type: 'line'` with `areaStyle`, effective fill color follows: `areaStyle.color` → resolved stroke color (from above precedence). See [`resolveOptions`](../../src/config/OptionResolver.ts).
- **Area series fill color precedence**: for `type: 'area'`, effective fill color follows: `areaStyle.color` → `series.color` → theme palette. See [`resolveOptions`](../../src/config/OptionResolver.ts).
- **Axis ticks**: `AxisConfig.tickLength` controls tick length in CSS pixels (default: 6)

## Performance Metrics Types

ChartGPU provides comprehensive performance monitoring types for tracking rendering performance.

### Branded Types

ChartGPU uses TypeScript branded types for type safety with performance metrics:

**`ExactFPS`**

Branded type for exact FPS measurements. Distinguishes FPS from other numeric values at compile time.

**Source:** [`types.ts`](../../src/config/types.ts)

**`Milliseconds`**

Branded type for millisecond durations. Distinguishes time durations from other numeric values at compile time.

**Source:** [`types.ts`](../../src/config/types.ts)

**`Bytes`**

Branded type for byte sizes. Distinguishes memory sizes from other numeric values at compile time.

**Source:** [`types.ts`](../../src/config/types.ts)

### `FrameTimeStats`

Statistics for frame time measurements. All times are in milliseconds.

**Fields:**
- `min: Milliseconds`: Minimum frame time in the measurement window
- `max: Milliseconds`: Maximum frame time in the measurement window
- `avg: Milliseconds`: Average (mean) frame time
- `p50: Milliseconds`: 50th percentile (median) frame time
- `p95: Milliseconds`: 95th percentile frame time
- `p99: Milliseconds`: 99th percentile frame time

**Source:** [`types.ts`](../../src/config/types.ts)

### `GPUTimingStats`

GPU timing statistics that track CPU vs GPU time for render operations.

**Fields:**
- `enabled: boolean`: Whether GPU timing is enabled and supported
- `cpuTime: Milliseconds`: CPU time spent preparing render commands
- `gpuTime: Milliseconds`: GPU time spent executing render commands

**Note:** GPU timing requires the `timestamp-query` WebGPU feature. Check `PerformanceCapabilities.gpuTimingSupported` to determine availability.

**Source:** [`types.ts`](../../src/config/types.ts)

### `MemoryStats`

Memory usage statistics tracking GPU buffer allocations.

**Fields:**
- `used: Bytes`: Currently used memory in bytes
- `peak: Bytes`: Peak memory usage in bytes since initialization
- `allocated: Bytes`: Total allocated memory in bytes (may include freed regions)

**Source:** [`types.ts`](../../src/config/types.ts)

### `FrameDropStats`

Frame drop detection statistics that track when frame time exceeds expected interval.

**Fields:**
- `totalDrops: number`: Total number of dropped frames
- `consecutiveDrops: number`: Consecutive dropped frames (current streak)
- `lastDropTimestamp: Milliseconds`: Timestamp of last dropped frame

**Note:** A frame is considered "dropped" when frame time exceeds 33ms (approximately 30 FPS threshold).

**Source:** [`types.ts`](../../src/config/types.ts)

### `PerformanceMetrics`

Comprehensive performance metrics providing exact FPS measurement and detailed frame statistics.

**Fields:**
- `fps: ExactFPS`: Exact FPS calculated from frame time deltas using circular buffer
- `frameTimeStats: FrameTimeStats`: Frame time statistics (min/max/avg/percentiles)
- `gpuTiming: GPUTimingStats`: GPU timing statistics (CPU vs GPU time)
- `memory: MemoryStats`: Memory usage statistics
- `frameDrops: FrameDropStats`: Frame drop detection statistics
- `totalFrames: number`: Total frames rendered since initialization
- `elapsedTime: Milliseconds`: Total time elapsed since initialization

**When null:** `getPerformanceMetrics()` returns `null` if metrics are not yet available (e.g., before first frame render).

**Source:** [`types.ts`](../../src/config/types.ts)

### `PerformanceCapabilities`

Performance capabilities of the current environment, indicating which performance features are supported.

**Fields:**
- `gpuTimingSupported: boolean`: Whether GPU timing is supported (requires `timestamp-query` WebGPU feature)
- `highResTimerSupported: boolean`: Whether high-resolution timer is available (`performance.now`)
- `performanceMetricsSupported: boolean`: Whether performance metrics API is available

**Use case:** Check capabilities before relying on specific metrics (e.g., `gpuTiming` may not be available on all devices).

**Source:** [`types.ts`](../../src/config/types.ts)

## `resolveOptions(userOptions?: ChartGPUOptions)` / `OptionResolver.resolve(userOptions?: ChartGPUOptions)`

Resolves user options against defaults by deep-merging user-provided values with defaults and returning a resolved options object.

See [`OptionResolver.ts`](../../src/config/OptionResolver.ts) for the resolver API and resolved option types.

**Behavior notes (essential):**

- **Theme input**: `ChartGPUOptions.theme` accepts `'dark' | 'light'` or a [`ThemeConfig`](themes.md#themeconfig); the resolved `theme` is always a concrete `ThemeConfig`. See [`ChartGPUOptions`](../../src/config/types.ts) and [`resolveOptions`](../../src/config/OptionResolver.ts).
- **Default theme**: when `theme` is omitted, the resolved theme defaults to `'dark'` via [`getTheme`](../../src/themes/index.ts) (preset: [`darkTheme`](../../src/themes/darkTheme.ts)).
- **Theme name resolution**: `resolveOptions({ theme: 'light' })` resolves `theme` to the light preset config (see [`lightTheme`](../../src/themes/lightTheme.ts)).
- **Palette override**: when `ChartGPUOptions.palette` is provided (non-empty), it overrides the resolved theme palette (`resolvedOptions.theme.colorPalette`). The resolved `palette` mirrors the resolved theme palette for backward compatibility. See [`resolveOptions`](../../src/config/OptionResolver.ts).
