# Chart Options

Chart configuration. Full types: [`types.ts`](../../src/config/types.ts).

## `ChartGPUOptions`

- **`theme`**: `'dark' | 'light'` or [`ThemeConfig`](themes.md#themeconfig)
- **`DataPoint`**: tuple `[x, y, size?]` or object `{ x, y, size? }`
- **`autoScroll?: boolean`**: when `true`, `appendData()` keeps visible x-range anchored to newest data (only when data zoom enabled and `xAxis.min`/`max` unset). Demo: [`live-streaming/`](../../examples/live-streaming/)

## Annotations

- **`annotations?: ReadonlyArray<AnnotationConfig>`**: overlays (lineX, lineY, point, text). `position.space: 'plot'` uses fractions [0,1] for x/y. Full guide: [annotations.md](annotations.md). Authoring: [`annotation-authoring/`](../../examples/annotation-authoring/).

## Series Configuration

- **`SeriesType`**: `'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'candlestick'`. See [`types.ts`](../../src/config/types.ts).
- **Sampling (cartesian)**: `sampling?: 'none' | 'lttb' | 'average' | 'max' | 'min'`, `samplingThreshold?: number` (default 5000). Zoom-aware resampling when data zoom enabled.
- **`visible?: boolean`**: hide series from rendering and interaction. Legend toggle updates both.

### CandlestickSeriesConfig

- **Data**: `OHLCDataPoint` — tuple `[timestamp, open, close, low, high]` or object.
- **`style?: 'classic' | 'hollow'`**. **`sampling?: 'none' | 'ohlc'`** for bucket aggregation. Body-only hit-testing. Demos: [`candlestick/`](../../examples/candlestick/), [`candlestick-streaming/`](../../examples/candlestick-streaming/).
- **Acceptance test**: for OHLC sampling validation (endpoint preservation, aggregation rules, edge cases), see [`examples/acceptance/ohlc-sample.ts`](../../examples/acceptance/ohlc-sample.ts).

### LineSeriesConfig

- **`lineStyle?: { width?, opacity?, color? }`** (default width 2). **`areaStyle?`** for fill under line. Color precedence: `lineStyle.color` → `series.color` → palette.

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

- Non-cartesian. No x/y bounds or cartesian hit-test. Slice hit-test via `findPieSlice`. **`radius?`**, **`center?`**, **`startAngle?`**. Example: [`pie/`](../../examples/pie/).

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
- **`AxisConfig.tickFormatter?: (value: number) => string | null`**: custom formatter for axis tick labels. When provided, replaces the built-in tick label formatting for that axis.
  - For `type: 'value'` axes, `value` is the numeric tick value.
  - For `type: 'time'` axes, `value` is a timestamp in milliseconds (epoch-ms, same unit as `new Date(ms)`).
  - Return a `string` to display as the label, or `null` to suppress that specific tick label.
  - When omitted, ChartGPU uses its built-in formatting: `Intl.NumberFormat` for value axes, adaptive tier-based date formatting for time axes.
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
  | `< 1 day` | `HH:mm` |
  | `1–7 days` | `MM/DD HH:mm` |
  | `~1–12 weeks` *(or `< ~3 months`)* | `MM/DD` |
  | `~3–12 months` *(≤ ~1 year)* | `MMM DD` |
  | `> ~1 year` | `YYYY/MM` |

  Notes: month/year thresholds are **approximate** (30d / 365d), and formatting uses the browser's `Date` semantics (local timezone). See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).
- **Adaptive tick count (overlap avoidance, time x-axis only)**: when `xAxis.type === 'time'`, ChartGPU may **vary the tick count per render** to avoid DOM label overlap. It picks the largest tick count in **\[1, 9]** whose measured labels do not overlap (minimum gap **6 CSS px**); if measurement isn't available it falls back to the default tick count. **GPU tick marks and DOM tick labels use the same computed tick count.** See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and [`createAxisRenderer.ts`](../../src/renderers/createAxisRenderer.ts).
- **`AxisConfig.name?: string`**: renders an axis title for cartesian charts when provided (and non-empty after `trim()`): x-axis titles are centered below x-axis tick labels, and y-axis titles are rotated \(-90°\) and placed left of y-axis tick labels; titles can be clipped if `grid.bottom` / `grid.left` margins are too small. When `dataZoom` includes a slider (see below), ChartGPU reserves extra bottom space so the x-axis title remains visible above the slider overlay and is centered within the remaining space above the slider track. See [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) and option resolution in [`OptionResolver.ts`](../../src/config/OptionResolver.ts).
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

- **Default grid**: `left: 60`, `right: 20`, `top: 40`, `bottom: 40`
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
