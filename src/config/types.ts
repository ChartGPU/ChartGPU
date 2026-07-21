/**
 * Chart configuration types (Phase 1).
 */

import type { ThemeConfig } from '../themes/types';

export type AxisType = 'value' | 'time' | 'category' | 'log';
export type SeriesType =
  | 'line'
  | 'area'
  | 'bar'
  | 'scatter'
  | 'pie'
  | 'candlestick'
  | 'ohlc'
  | 'heatmap'
  | 'band'
  | 'errorBar'
  | 'impulse'
  | 'pointCloud3d'
  | 'surface3d';

/**
 * Step (digital) connection mode for line / area mountain.
 *
 * - `'after'`  — hold y_i until x_{i+1}, then vertical to y_{i+1}
 *                (SciChart `isDigitalLine` default; D3 `curveStepAfter`)
 * - `'before'` — vertical first at x_i to y_{i+1}, then horizontal to x_{i+1}
 *                (D3 `curveStepBefore`)
 * - `'middle'` — horizontal to midpoint, vertical, horizontal to next
 *                (D3 `curveStep`)
 *
 * Boolean `true` on series config resolves to `'after'`. Omitted / `false` → linear.
 */
export type StepMode = 'before' | 'middle' | 'after';

/**
 * Chart coordinate modality.
 * - `'cartesian2d'` (default): classic 2D chart path (zoom/pan, axes, MSAA overlays).
 * - `'cartesian3d'`: separate 3D path with camera, depth, and 3D series only.
 */
export type CoordinateSystem = 'cartesian2d' | 'cartesian3d';

/** Camera for `coordinateSystem: 'cartesian3d'`. */
export interface Chart3DCameraOptions {
  readonly type?: 'perspective' | 'orthographic';
  /** Radians; perspective only. Default π/4. */
  readonly fovY?: number;
  readonly near?: number;
  readonly far?: number;
  /** World-space eye. If omitted with target, fit-to-data on first bounds. */
  readonly eye?: readonly [number, number, number];
  readonly target?: readonly [number, number, number];
  /** Default [0,1,0] (Y-up). */
  readonly up?: readonly [number, number, number];
  /** Orthographic half-extent (world Y) when type === 'orthographic'. */
  readonly orthoSize?: number;
}

/** Pointer/wheel interaction for 3D charts (not 2D dataZoom). */
export interface Interaction3DOptions {
  readonly orbit?: boolean;
  readonly pan?: boolean;
  readonly zoom?: boolean;
  /** Radians per CSS pixel for orbit. Default ~0.005. */
  readonly orbitSpeed?: number;
  readonly zoomSpeed?: number;
  readonly panSpeed?: number;
}

/** Per-axis options for `axes3d` (value domain only in this epic). */
export interface Axis3DOptions {
  readonly name?: string;
  /** v1 only; log 3D axes out of scope. */
  readonly type?: 'value';
  /** Optional fixed domain; default from scene AABB. */
  readonly min?: number;
  readonly max?: number;
  /** Major tick count hint (nice ticks may adjust). Default ~5. */
  readonly tickCount?: number;
  /** Default true. */
  readonly visible?: boolean;
}

/**
 * 3D world axes: AABB box, wall/floor grids, tick marks, and projected labels.
 * Keep the key name `axes3d` (not `axis3D` / `worldAxes`).
 */
export interface Axes3DOptions {
  readonly x?: Axis3DOptions;
  readonly y?: Axis3DOptions;
  readonly z?: Axis3DOptions;
  /** Draw AABB edge box. Default true. */
  readonly showBox?: boolean;
  /** Wall/floor major grid lines. Default true. */
  readonly showGrid?: boolean;
  /**
   * Where to draw axis tick numbers + titles:
   * - `'auto'` (default): prefer WebGPU glyph atlas when atlas init succeeds; else DOM
   * - `'dom'`: DOM-projected spans (maximum font fidelity / always available)
   * - `'gpu'`: WebGPU billboard quads from a canvas-baked atlas (falls back to DOM + warn on atlas failure)
   */
  readonly labelMode?: 'auto' | 'dom' | 'gpu';
}

/** Isolines on a uniform `surface3d` height field. */
export interface Surface3DContourOptions {
  /** Default false. */
  readonly show?: boolean;
  /** Count of levels between yMin/yMax, or explicit heights. */
  readonly levels?: number | readonly number[];
  readonly color?: string;
  /**
   * Visual weight for isoline stroke (world-space hairline line-list).
   * Default 1.5 — **not CSS px thickness**; maps to alpha/brightness weight only.
   */
  readonly width?: number;
  readonly opacity?: number;
}

/**
 * Streaming / partial update for `surface3d` via `chart.updateSurface3D`.
 *
 * - `replaceY`: full field, length columns*rows, **row-major** `y[j * columns + i]`.
 * - `appendColumns`: new columns on +X; payload **column-major strips** `y[c * rows + r]`.
 * - `appendRows`: new rows on +Z; payload **row-major** block `y[r * columns + i]`.
 */
export type Surface3DUpdate =
  | Readonly<{
      mode: 'replaceY';
      y: ArrayLike<number>;
      yMin?: number;
      yMax?: number;
    }>
  | Readonly<{
      mode: 'appendColumns';
      columns: number;
      y: ArrayLike<number>;
      /** Drop oldest columns and shift xStart (spectrogram scroll). Default true. */
      scrollX?: boolean;
    }>
  | Readonly<{
      mode: 'appendRows';
      rows: number;
      y: ArrayLike<number>;
      scrollZ?: boolean;
    }>;

/**
 * Streaming / partial update for `heatmap` via `chart.updateHeatmap`.
 *
 * Full field layout (replaceZ / stored grid): **row-major** `z[j * columns + i]`.
 * appendColumns payload: **column-major** strips `z[c * rows + r]` for each new column.
 * appendRows payload: **row-major** blocks `z[r * columns + i]`.
 *
 * Mirrors {@link Surface3DUpdate} (`replaceZ` ↔ `replaceY`, scrollX / scrollY).
 */
export type HeatmapUpdate =
  | Readonly<{
      mode: 'replaceZ';
      z: ArrayLike<number>;
      /** Optional colormap domain; when both set, skip full-field domain recompute. */
      zMin?: number;
      zMax?: number;
    }>
  | Readonly<{
      mode: 'appendColumns';
      columns: number;
      z: ArrayLike<number>; // length >= columns * rows (column-major strips)
      /** Drop oldest columns and shift xStart (spectrogram scroll). Default true. */
      scrollX?: boolean;
    }>
  | Readonly<{
      mode: 'appendRows';
      rows: number;
      z: ArrayLike<number>; // length >= columns * rows (row-major blocks)
      /** Drop oldest rows and shift yStart. Default true. */
      scrollY?: boolean;
    }>;

/**
 * Render mode for chart rendering.
 *
 * - `'auto'` (default): ChartGPU schedules renders automatically using requestAnimationFrame
 * - `'external'`: Application is responsible for calling renderFrame() on each frame
 */
export type RenderMode = 'auto' | 'external';

/**
 * A single data point for a series.
 */
export type DataPointTuple = readonly [x: number, y: number, size?: number];

export type DataPoint = DataPointTuple | Readonly<{ x: number; y: number; size?: number }>;

/**
 * Separate x/y/size arrays for cartesian series data.
 * Allows providing data as parallel arrays instead of array-of-objects.
 */
export type XYArraysData = Readonly<{
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  size?: ArrayLike<number>;
}>;

/**
 * Pre-interleaved XY cartesian data as a typed array view.
 * Data must be laid out as [x0, y0, x1, y1, ...] with even length.
 * Size dimension is NOT interleaved (use XYArraysData.size if needed).
 *
 * Prefer Float32Array for GPU-friendly data transfer, but any ArrayBufferView is accepted.
 */
export type InterleavedXYData = ArrayBufferView;

/**
 * Union type for cartesian series data formats.
 * Supports three input formats:
 * - Traditional array of DataPoint objects/tuples
 * - Separate x/y arrays (XYArraysData)
 * - Pre-interleaved typed array (InterleavedXYData)
 */
export type CartesianSeriesData = ReadonlyArray<DataPoint | null> | XYArraysData | InterleavedXYData;

/**
 * OHLC (Open-High-Low-Close) data point for candlestick charts.
 * Order matches ECharts convention: [timestamp, open, close, low, high].
 */
export type OHLCDataPointTuple = readonly [timestamp: number, open: number, close: number, low: number, high: number];

export type OHLCDataPointObject = Readonly<{
  timestamp: number;
  open: number;
  close: number;
  low: number;
  high: number;
}>;

export type OHLCDataPoint = OHLCDataPointTuple | OHLCDataPointObject;

export type SeriesSampling = 'none' | 'lttb' | 'average' | 'max' | 'min' | 'ohlc';

/**
 * Adaptive draw LOD policy for dense charts.
 *
 * - `'auto'` (default): may switch dense lines to 1 device-px hairline and compact
 *   dense scatter markers toward ~1 device px for fill-rate (suite-friendly).
 * - `'strict'`: always honor configured line width and scatter marker size;
 *   also forces full LTTB recompute on equal-N y-only updates (no frozen indices).
 *
 * Does not change sampling algorithms or uploaded point counts for hairline/compact
 * alone — those are draw-only. See `docs/performance.md`.
 */
export type PerformanceLod = 'auto' | 'strict';

export interface PerformanceConfig {
  /**
   * Dense-draw LOD for lines (hairline) and scatter (radius compaction).
   * Default: `'auto'`.
   */
  readonly lod?: PerformanceLod;
}

/**
 * Scatter points use the tuple form `[x, y, size?]`.
 */
export type ScatterPointTuple = DataPointTuple;

export type ScatterSymbol = 'circle' | 'rect' | 'triangle';

/**
 * Grid/padding around the plot area, in CSS pixels.
 */
export interface GridConfig {
  readonly left?: number;
  readonly right?: number;
  readonly top?: number;
  readonly bottom?: number;
}

export interface AxisConfig {
  readonly id?: string;
  readonly position?: 'left' | 'right';
  readonly type: AxisType;
  readonly min?: number;
  readonly max?: number;
  /** Tick length in CSS pixels (default: 6). */
  readonly tickLength?: number;
  readonly name?: string;
  /**
   * Non-rotated unit header at the top of a Y-axis rail (e.g. `"USDT"`).
   * Independent of `name` (which remains a rotated side title).
   * Only applied to Y axes (`yAxis` / `axes.y`); ignored for `xAxis`.
   */
  readonly header?: string;
  /**
   * Axis domain auto-bounds mode (primarily used for y-axis):
   * - `'global'`: derive from full dataset (pre-zoom behavior)
   * - `'visible'`: derive from visible/zoomed data range (default for y-axis)
   *
   * Note: explicit `min`/`max` always take precedence over auto-bounds.
   * This option is primarily intended for `yAxis` (it has no effect on `xAxis` currently).
   */
  readonly autoBounds?: 'global' | 'visible';
  /**
   * Custom formatter for axis tick labels.
   * When provided, replaces the built-in tick label formatting.
   * For time axes, `value` is a timestamp in milliseconds (epoch-ms).
   * For log axes, `value` is the **data-space** tick value (e.g. `1000`, not `3` for \(10^3\)).
   * Return `null` to suppress a specific tick label.
   */
  readonly tickFormatter?: (value: number) => string | null;
  /**
   * Logarithm base when `type === 'log'`. Default: `10`.
   * Must be finite and > 0, and ≠ 1. Invalid values fall back to 10 with a dev warning.
   * Ignored for non-log axes.
   */
  readonly logBase?: number;
}

export interface DataZoomConfig {
  readonly type: 'inside' | 'slider';
  readonly xAxisIndex?: number;
  /** Start percent in [0, 100]. */
  readonly start?: number;
  /** End percent in [0, 100]. */
  readonly end?: number;
  readonly minSpan?: number;
  readonly maxSpan?: number;
}

export interface LineStyleConfig {
  readonly width?: number;
  readonly opacity?: number;
  readonly color?: string;
}

export interface AreaStyleConfig {
  readonly opacity?: number;
  readonly color?: string;
}

export interface SeriesConfigBase {
  readonly name?: string;
  readonly yAxis?: string;
  readonly data: CartesianSeriesData;
  readonly color?: string;
  /**
   * Controls whether the series is visible and rendered.
   * When `false`, the series is hidden from the chart and excluded from interactions.
   * Defaults to `true`.
   */
  readonly visible?: boolean;
  /**
   * Optional per-series sampling strategy for large datasets.
   *
   * When `sampling !== 'none'` and `data.length > samplingThreshold`, ChartGPU may downsample
   * the series for rendering and interaction hit-testing. Sampling does not affect axis
   * auto-bounds derivation (bounds use raw/unsampled series data).
   */
  readonly sampling?: SeriesSampling;
  /**
   * Auto-sample when point count exceeds this threshold.
   *
   * Note: when `sampling === 'none'`, this value is ignored at runtime but may still be provided.
   */
  readonly samplingThreshold?: number;
}

export interface LineSeriesConfig extends SeriesConfigBase {
  readonly type: 'line';
  readonly lineStyle?: LineStyleConfig;
  /**
   * Optional filled-area styling for a line series.
   * When provided, renderers may choose to render a filled area under the line.
   */
  readonly areaStyle?: AreaStyleConfig;
  /**
   * When true, null/undefined gaps in data are bridged by connecting
   * the surrounding valid points. When false (default), gaps break the line.
   */
  readonly connectNulls?: boolean;
  /**
   * Stack group id for **mountain fill** composition (multi-series stacked area).
   * Non-empty string + `areaStyle` → this series stacks with peers sharing the same id
   * (and the same `yAxis`). Stroke-only lines (no `areaStyle`) ignore `stack` for fill.
   * Same string semantics as {@link BarSeriesConfig.stack}. Series array order within
   * the stack = bottom → top. Omitted / empty → unstacked single-series mountain.
   */
  readonly stack?: string;
  /**
   * When set, connect samples with stairs instead of diagonals (digital / step line).
   * Applies to stroke and to mountain fill when `areaStyle` is present.
   * `true` ≡ `'after'` (SciChart `isDigitalLine`). See {@link StepMode}.
   */
  readonly step?: boolean | StepMode;
}

export interface AreaSeriesConfig extends SeriesConfigBase {
  readonly type: 'area';
  /**
   * Baseline in data-space used as the filled area floor.
   * If omitted, ChartGPU will default to the y-axis minimum.
   * Ignored for layout when non-empty {@link AreaSeriesConfig.stack} is set
   * (stack floor is the cumulative sum of layers below, from 0).
   */
  readonly baseline?: number;
  readonly areaStyle?: AreaStyleConfig;
  /**
   * When true, null/undefined gaps in data are bridged by connecting
   * the surrounding valid points. When false (default), gaps break the area fill.
   */
  readonly connectNulls?: boolean;
  /**
   * Stack group id. Non-empty → stacked with peers of the same id (and same `yAxis`).
   * Same semantics as {@link BarSeriesConfig.stack} / line mountain `stack`.
   * When stacked, per-series `baseline` is ignored for geometry.
   */
  readonly stack?: string;
  /**
   * When set, the area top edge (and any stroke overlay) uses step geometry.
   * `true` ≡ `'after'`. See {@link StepMode}.
   */
  readonly step?: boolean | StepMode;
}

export interface BarItemStyleConfig {
  readonly borderRadius?: number;
  readonly borderWidth?: number;
  readonly borderColor?: string;
}

export interface BarSeriesConfig extends SeriesConfigBase {
  readonly type: 'bar';
  /**
   * Bar width in CSS pixels, or as a percentage of the category width (e.g. '50%').
   */
  readonly barWidth?: number | string;
  /**
   * Gap between bars in the same category, as a ratio in [0, 1].
   */
  readonly barGap?: number;
  /**
   * Gap between categories, as a ratio in [0, 1].
   */
  readonly barCategoryGap?: number;
  /** Stack group id. Bars with the same id may be stacked. */
  readonly stack?: string;
  readonly itemStyle?: BarItemStyleConfig;
}

export interface ScatterSeriesConfig extends SeriesConfigBase {
  readonly type: 'scatter';
  /**
   * Scatter rendering mode.
   *
   * - `'points'` (default): draw point markers (current behavior).
   * - `'density'`: render a binned density heatmap in **screen space** from a point cloud
   *   (not a data-grid uniform heatmap — use `type: 'heatmap'` for spectrograms / matrices).
   */
  readonly mode?: 'points' | 'density';
  /**
   * Density bin size in CSS pixels (used only when `mode === 'density'`).
   *
   * Smaller bins increase detail but can reduce performance.
   */
  readonly binSize?: number;
  /**
   * Colormap used for density rendering (used only when `mode === 'density'`).
   *
   * - Named: `'viridis' | 'plasma' | 'inferno'`
   * - Custom: a low→high `string[]` of CSS colors
   *
   * Same named stops as {@link HeatmapSeriesConfig.colormap} for visual consistency.
   */
  readonly densityColormap?: 'viridis' | 'plasma' | 'inferno' | readonly string[];
  /**
   * Normalization curve applied to per-bin counts before mapping to the colormap
   * (used only when `mode === 'density'`).
   */
  readonly densityNormalization?: 'linear' | 'sqrt' | 'log';
  /**
   * Scatter symbol size in CSS pixels. When a function is provided, it receives
   * the point tuple `[x, y, size?]`.
   */
  readonly symbolSize?: number | ((value: ScatterPointTuple) => number);
  readonly symbol?: ScatterSymbol;
}

export type PieDataItem = Readonly<{
  value: number;
  name: string;
  color?: string;
  /**
   * Controls whether the pie slice is visible and rendered.
   * When `false`, the slice is hidden from the chart and excluded from interactions.
   * Defaults to `true`.
   */
  visible?: boolean;
}>;

export interface PieItemStyleConfig {
  readonly borderRadius?: number;
  readonly borderWidth?: number;
}

export type PieRadius = number | string | readonly [inner: number | string, outer: number | string];
export type PieCenter = readonly [x: number | string, y: number | string];

export interface PieSeriesConfig extends Omit<SeriesConfigBase, 'data' | 'sampling' | 'samplingThreshold'> {
  readonly type: 'pie';
  /**
   * Radius in CSS pixels, as a percent string (e.g. '50%'), or a tuple [inner, outer].
   * When inner > 0, the series renders as a donut.
   */
  readonly radius?: PieRadius;
  /**
   * Center position as [x, y] in CSS pixels or percent strings.
   */
  readonly center?: PieCenter;
  /**
   * Start angle in degrees (default: 90 = top).
   */
  readonly startAngle?: number;
  readonly data: ReadonlyArray<PieDataItem>;
  readonly itemStyle?: PieItemStyleConfig;
}

export type CandlestickStyle = 'classic' | 'hollow';

export interface CandlestickItemStyleConfig {
  readonly upColor?: string;
  readonly downColor?: string;
  readonly upBorderColor?: string;
  readonly downBorderColor?: string;
  readonly borderWidth?: number;
}

/**
 * Last-price badge / horizontal price line on a candlestick series (exchange-style).
 *
 * Sugar: `priceLabel: true` enables with defaults; `priceLabel: false` forces off.
 * Object form enables unless `show: false`. Countdown requires a finite `intervalMs > 0`.
 *
 * **Series element identity:** under axes-only `setOption` reuse, changing `priceLabel`
 * requires a **new series config object** in `series[]`. In-place mutation of
 * `series[i].priceLabel` on a stable element is not re-resolved.
 */
export interface CandlestickPriceLabelConfig {
  /**
   * Show the last-price badge on the series' Y-axis rail.
   * When omitted inside an object form, treated as `true` (providing config implies enable).
   */
  readonly show?: boolean;

  /**
   * Draw a horizontal line at last close across the plot.
   * Default: same as resolved `show`.
   */
  readonly showLine?: boolean;

  /**
   * Candle period in ms for countdown secondary line.
   * Required for countdown; when omitted, price-only badge.
   */
  readonly intervalMs?: number;

  /**
   * Show countdown under price when `intervalMs` is set and bar end is known.
   * Default: `true` if `intervalMs` is finite and > 0, else `false`.
   */
  readonly showCountdown?: boolean;

  /**
   * Clock for countdown remaining time. Default at use site: `() => Date.now()`.
   * Streaming demos with accelerated time must pass their simulated clock.
   */
  readonly nowMs?: () => number;

  /**
   * Format last close for the badge. Default: library price formatter (not axis tickFormatter).
   */
  readonly formatter?: (close: number) => string;

  /**
   * Out-of-domain behavior when last close is outside the current Y domain.
   * - `'clamp'`: pin badge to nearest plot edge, dimmed (default)
   * - `'hide'`: hide badge and price line
   */
  readonly outOfDomain?: 'clamp' | 'hide';

  /** Override badge text color (default `#ffffff`). */
  readonly color?: string;

  /**
   * Override **line** color only (default: direction color).
   * Badge background is always direction color.
   */
  readonly lineColor?: string;

  /** Line stroke width in CSS px (default: 1). */
  readonly lineWidth?: number;
}

export interface CandlestickSeriesConfig extends Omit<SeriesConfigBase, 'data'> {
  readonly type: 'candlestick';
  readonly data: ReadonlyArray<OHLCDataPoint>;
  readonly style?: CandlestickStyle;
  readonly itemStyle?: CandlestickItemStyleConfig;
  readonly barWidth?: number | string;
  readonly barMinWidth?: number;
  readonly barMaxWidth?: number;
  /**
   * Sampling strategy for candlestick data. Only 'none' and 'ohlc' are supported.
   */
  readonly sampling?: 'none' | 'ohlc';
  /**
   * Exchange-style last-price badge and optional horizontal price line.
   * - `undefined`: auto-enable when the chart is candle-primary (`series[0].type === 'candlestick'` or `'ohlc'`)
   * - `true` / `false`: force on/off with field defaults
   * - object: enable unless `show: false`; see {@link CandlestickPriceLabelConfig}
   *
   * Changing this option requires a **new series element identity** (immutable `setOption` pattern).
   */
  readonly priceLabel?: boolean | CandlestickPriceLabelConfig;
}

/**
 * OHLC bar series — thin open / high / low / close bars (center stem + open/close ticks).
 * Data layout is identical to {@link CandlestickSeriesConfig} (`OHLCDataPoint`, ECharts order).
 */
export interface OhlcSeriesConfig extends Omit<SeriesConfigBase, 'data'> {
  readonly type: 'ohlc';
  readonly data: ReadonlyArray<OHLCDataPoint>;

  /**
   * Category width for open/close tick length scale and hit-test box.
   * Same contract as candlestick `barWidth` (CSS px number or percentage string).
   */
  readonly barWidth?: number | string;
  readonly barMinWidth?: number;
  readonly barMaxWidth?: number;

  /**
   * Stroke width of the vertical high–low stem in CSS px.
   * Default: 1.
   */
  readonly stemWidth?: number;

  /**
   * Length of open/close ticks as a fraction of category body width, or CSS px.
   * Default: 45% of resolved body width (half-category arms).
   */
  readonly tickLength?: number | string;

  /** Up/down fill colors (border fields ignored for stroke-only OHLC bars). */
  readonly itemStyle?: CandlestickItemStyleConfig;

  /**
   * Only `'none' | 'ohlc'` (same as candlestick).
   */
  readonly sampling?: 'none' | 'ohlc';

  /**
   * Same sugar as candlestick priceLabel.
   * Auto-enable when chart is finance-primary (`series[0].type === 'ohlc'` or `'candlestick'`).
   */
  readonly priceLabel?: boolean | CandlestickPriceLabelConfig;
}

/**
 * Uniform rectangular heatmap / spectrogram grid in data space.
 *
 * Cells form a regular grid:
 *   x_i = xStart + i * xStep,   i ∈ [0, columns)
 *   y_j = yStart + j * yStep,   j ∈ [0, rows)
 *
 * `z` is row-major:
 *   z[j * columns + i] = value at column i, row j
 * Row j = 0 is the band starting at yStart (increasing j → increasing y).
 *
 * Cell (i,j) covers [x_i, x_i + xStep) × [y_j, y_j + yStep) when `cellAnchor === 'corner'`
 * (default). With `'center'`, (xStart, yStart) is the center of cell (0,0).
 *
 * Prefer `Float32Array` for efficient packing into the GPU upload path.
 * `number[]` is accepted and copied. Rows are still padded/copied for WebGPU
 * `bytesPerRow` alignment — not a strict zero-copy path.
 *
 * **Not** scatter `mode: 'density'` (screen-space point-cloud bins). This is a true data grid.
 */
export type HeatmapData = Readonly<{
  /** Left edge (or center — see cellAnchor) of column 0. */
  readonly xStart: number;
  /** Data-space width of one column. Must be finite and ≠ 0 (negative allowed). */
  readonly xStep: number;
  /** Bottom/top edge (or center) of row 0 — see cellAnchor. */
  readonly yStart: number;
  /** Data-space height of one row. Must be finite and ≠ 0 (negative allowed). */
  readonly yStep: number;
  /** Integer ≥ 1 — X cell count. */
  readonly columns: number;
  /** Integer ≥ 1 — Y cell count. */
  readonly rows: number;
  /**
   * Length must be `columns * rows`.
   * Prefer Float32Array for efficient packing (GPU still pads rows for alignment).
   */
  readonly z: Float32Array | ReadonlyArray<number>;
}>;

/** Named colormap or custom low→high CSS color stops. */
export type HeatmapColormap = 'viridis' | 'plasma' | 'inferno' | 'magma' | 'grayscale' | readonly string[];

/** How non-finite z (NaN/±Inf) is colored. */
export type HeatmapNullHandling = 'transparent' | 'lowest' | 'highest';

/**
 * Uniform heatmap / spectrogram series.
 *
 * Sampling / LTTB / GPU line decimation are ignored.
 * **Streaming:** use `chart.updateHeatmap(seriesIndex, update)` for `replaceZ`,
 * `appendColumns` (+scrollX), and `appendRows` (+scrollY). Equal-size `setOption`
 * z replace still works. **`appendData` is unsupported** (wrong payload model —
 * points vs grid); the warning points at `updateHeatmap`.
 * `color` on the series base is ignored (colormap owns color).
 */
export interface HeatmapSeriesConfig extends Omit<SeriesConfigBase, 'data' | 'sampling' | 'samplingThreshold'> {
  readonly type: 'heatmap';
  readonly data: HeatmapData;

  /**
   * Ignored for rendering (colormap owns color). Optional for SeriesConfigBase /
   * legend / tooltip helper compatibility.
   */
  readonly color?: string;

  /** Named colormap or custom stops. Default: `'viridis'`. */
  readonly colormap?: HeatmapColormap;

  /**
   * Explicit z range for color mapping.
   * If either omitted, resolve from finite z values.
   */
  readonly zMin?: number;
  readonly zMax?: number;

  /**
   * How to normalize z before colormap.
   * - `'linear'` (default): t = (z - zMin) / (zMax - zMin)
   * - `'log'`: t from log(z) over positive range only; non-positive cells use nullHandling
   */
  readonly zScale?: 'linear' | 'log';

  /** Opacity multiplier for the whole series [0, 1]. Default 1. */
  readonly opacity?: number;

  /**
   * Cell placement relative to xStart/yStart.
   * - `'corner'` (default): (xStart, yStart) is the min-corner of cell (0,0)
   * - `'center'`: (xStart, yStart) is the center of cell (0,0)
   */
  readonly cellAnchor?: 'corner' | 'center';

  /** Non-finite z handling. Default `'transparent'`. */
  readonly nullHandling?: HeatmapNullHandling;

  /**
   * Optional border gap between cells in CSS px (0 = none). Default 0.
   * Implemented as a slight UV inset when > 0.
   */
  readonly cellGapPx?: number;
}

/**
 * One sample of a band / range series: shared x, two y values.
 * Order: y = first/lower curve by convention in docs, y1 = second/upper.
 * Crossing is allowed (y may be > y1 at some samples).
 */
export type BandDataPointTuple = readonly [x: number, y: number, y1: number];

export type BandDataPointObject = Readonly<{
  readonly x: number;
  readonly y: number;
  readonly y1: number;
}>;

export type BandDataPoint = BandDataPointTuple | BandDataPointObject;

/**
 * Separate arrays for band series (SciChart Xyy-style).
 * All arrays must have the same length (resolver uses min length and may warn).
 */
export type BandXYYArraysData = Readonly<{
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly y1: ArrayLike<number>;
}>;

/**
 * Pre-interleaved band data: [x0, y0, y1_0, x1, y1, y1_1, ...]
 * stride = 3. Prefer Float32Array for GPU-friendly transfer.
 *
 * Do NOT reuse InterleavedXYData (stride 2) — that would silently drop y1.
 */
export type InterleavedXYYData = ArrayBufferView;

/**
 * Accepted band data formats.
 * Distinct from CartesianSeriesData so `[x,y,size?]` scatter tuples are never
 * misread as `[x,y,y1]`.
 */
export type BandSeriesData = ReadonlyArray<BandDataPoint | null> | BandXYYArraysData | InterleavedXYYData;

/**
 * Band / range series: fill between two curves that share x (confidence bands,
 * min–max envelopes, threshold fills). Not area-to-baseline and not annotation `bandX`.
 */
export interface BandSeriesConfig {
  readonly type: 'band';
  readonly name?: string;
  readonly yAxis?: string;
  readonly visible?: boolean;
  readonly data: BandSeriesData;

  /**
   * Optional shared series color fallback for strokes/fill when styles omit color.
   * Theme palette still applies when fully omitted.
   */
  readonly color?: string;

  /**
   * Stroke for the `y` curve. Omit or set width 0 / opacity 0 to hide.
   * Default when present: width 1, color from series/theme, opacity 1.
   */
  readonly lineStyle?: LineStyleConfig;

  /**
   * Stroke for the `y1` curve. When omitted, no y1 stroke (fill-only is valid).
   * When provided, defaults width/opacity like line.
   */
  readonly lineStyleY1?: LineStyleConfig;

  /**
   * Fill between y and y1. Default: series color @ opacity 0.25 (or theme).
   * Color + opacity only in v1 (no gradient).
   */
  readonly areaStyle?: AreaStyleConfig;

  /**
   * When true, null/NaN gaps are bridged. When false (default), gaps break
   * fill segments and strokes (same contract as line/area).
   */
  readonly connectNulls?: boolean;

  /**
   * Sampling for large N. v1: `'none' | 'lttb' | 'average' | 'max' | 'min'`.
   * **No** `'ohlc'`. GPU decimation is not used for band in v1.
   *
   * LTTB/min/max/average consider both y and y1 (index-aligned dual-Y policy).
   */
  readonly sampling?: Exclude<SeriesSampling, 'ohlc'>;
  readonly samplingThreshold?: number;
}

/**
 * 3D point cloud — one sample per point in world XYZ.
 * Only valid when `coordinateSystem: 'cartesian3d'`.
 * Not scatter density / 2D scatter.
 */
export type PointCloud3DArraysData = Readonly<{
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly z: ArrayLike<number>;
  /** Optional scalar for colormap; length should match N. */
  readonly value?: ArrayLike<number>;
  /** Optional per-point size (reserved; v1 uses series pointStyle.size). */
  readonly size?: ArrayLike<number>;
}>;

/** Interleaved: [x0,y0,z0, x1,y1,z1, ...] stride 3. Prefer Float32Array. */
export type InterleavedXYZData = ArrayBufferView;

export type PointCloud3DData =
  | ReadonlyArray<readonly [number, number, number] | { x: number; y: number; z: number } | null>
  | PointCloud3DArraysData
  | InterleavedXYZData;

export interface PointCloud3DSeriesConfig {
  readonly type: 'pointCloud3d';
  readonly name?: string;
  readonly visible?: boolean;
  /** Fallback solid color when pointStyle.color omitted (also used by legend). */
  readonly color?: string;
  readonly data: PointCloud3DData;
  readonly pointStyle?: {
    /** Billboard diameter in CSS pixels. Default 3. */
    readonly size?: number;
    readonly color?: string;
    readonly opacity?: number;
  };
  /** When set, color from value channel + colormap (overrides solid color). */
  readonly colorBy?: {
    readonly values?: ArrayLike<number>;
    readonly colormap?: HeatmapColormap;
    readonly min?: number;
    readonly max?: number;
  };
}

/**
 * Uniform grid surface. Height along +Y; grid in XZ plane.
 *   x_i = xStart + i * xStep
 *   z_j = zStart + j * zStep
 *   y = height[j * columns + i]
 * Only valid when `coordinateSystem: 'cartesian3d'`.
 */
export type Surface3DGridData = Readonly<{
  readonly xStart: number;
  readonly xStep: number;
  readonly zStart: number;
  readonly zStep: number;
  readonly columns: number;
  readonly rows: number;
  /** Row-major heights, length === columns * rows. */
  readonly y: ArrayLike<number>;
}>;

export interface Surface3DSeriesConfig {
  readonly type: 'surface3d';
  readonly name?: string;
  readonly visible?: boolean;
  /** Legend / palette color (surface uses colormap for mesh). */
  readonly color?: string;
  readonly data: Surface3DGridData;
  readonly colormap?: HeatmapColormap;
  /** Colormap domain; auto from data heights if omitted. */
  readonly yMin?: number;
  readonly yMax?: number;
  readonly wireframe?: boolean;
  readonly opacity?: number;
  /** Simple lighting strength 0..1; 0 = unlit colormap. Default 0.65. */
  readonly lighting?: number;
  /** Height isolines (marching squares → depth-tested line list). */
  readonly contours?: Surface3DContourOptions;
}

/**
 * Absolute HLC sample (SciChart HlcDataSeries parity).
 * `high` / `low` are data-space endpoints (resolver swaps if low > high).
 */
export type ErrorBarPointTuple = readonly [x: number, y: number, high: number, low: number];

export type ErrorBarPointObject = Readonly<{
  readonly x: number;
  readonly y: number;
  readonly high: number;
  readonly low: number;
}>;

/**
 * Columnar absolute HLC (preferred for streaming).
 * Length = min(x, y, high, low); mismatch warns.
 */
export type ErrorBarHlcArraysData = Readonly<{
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly high: ArrayLike<number>;
  readonly low: ArrayLike<number>;
}>;

/**
 * Relative error convenience forms — resolved to absolute high/low:
 * - yError: symmetric → high = y + |e|, low = y - |e|
 * - yErrorHigh / yErrorLow: asymmetric offsets (abs applied)
 */
export type ErrorBarRelativeArraysData =
  | Readonly<{
      readonly x: ArrayLike<number>;
      readonly y: ArrayLike<number>;
      readonly yError: ArrayLike<number> | number;
    }>
  | Readonly<{
      readonly x: ArrayLike<number>;
      readonly y: ArrayLike<number>;
      readonly yErrorHigh: ArrayLike<number> | number;
      readonly yErrorLow: ArrayLike<number> | number;
    }>;

/** Accepted error-bar data formats. */
export type ErrorBarSeriesData =
  | ReadonlyArray<ErrorBarPointTuple | ErrorBarPointObject | null>
  | ErrorBarHlcArraysData
  | ErrorBarRelativeArraysData;

export type ErrorBarMode = 'both' | 'high' | 'low';
export type ErrorBarDirection = 'vertical' | 'horizontal';

export interface ErrorBarItemStyleConfig {
  /** Stem + whisker stroke color (CSS). Default: series color / theme palette. */
  readonly color?: string;
  /** Stroke width in CSS px. Default 1.5. */
  readonly borderWidth?: number;
  readonly opacity?: number;
}

/**
 * Error bar series — per-point high/low whiskers around a center value.
 * SciChart HLC-style; not band fill and not OHLC open/close ticks.
 *
 * Sampling is `'none'` only (sparse science series). Other modes warn + ignore.
 */
export interface ErrorBarSeriesConfig {
  readonly type: 'errorBar';
  readonly name?: string;
  readonly yAxis?: string;
  readonly visible?: boolean;
  readonly data: ErrorBarSeriesData;

  /** Shared color fallback when itemStyle.color omitted. */
  readonly color?: string;

  readonly itemStyle?: ErrorBarItemStyleConfig;

  /**
   * Whisker cap length.
   * - number: CSS px
   * - percent string: fraction of category spacing / mean Δx (vertical bars)
   * Default: 40% of category step.
   */
  readonly capWidth?: number | string;

  /** Which ends to draw. Default `'both'`. */
  readonly errorMode?: ErrorBarMode;

  /**
   * `'vertical'` (default): high/low along Y at x.
   * `'horizontal'`: high/low along X at y (SciChart EErrorDirection.Horizontal).
   */
  readonly direction?: ErrorBarDirection;

  /** Draw end caps (whiskers). Default true. */
  readonly drawWhiskers?: boolean;

  /**
   * Draw the stem connecting low↔high (SciChart drawConnector).
   * Default true. If false and drawWhiskers true, only caps are drawn.
   */
  readonly drawConnector?: boolean;

  /**
   * Draw a center marker at (x, y). Default false.
   * When true, uses a circle-like square marker with `symbolSize`.
   */
  readonly showCenter?: boolean;
  readonly symbolSize?: number;

  /**
   * Sampling: `'none'` only. LTTB / ohlc / average not applicable — warn + ignore other modes.
   */
  readonly sampling?: 'none';
}

/**
 * Impulse / stem series — one vertical stem per sample from baseline to y.
 * SciChart FastImpulseRenderableSeries parity. XY data only (not HLC).
 */
export interface ImpulseSeriesConfig extends SeriesConfigBase {
  readonly type: 'impulse';
  /** Data-space y of stem floor. Default 0. */
  readonly baseline?: number;
  /** Stem stroke. Width default ~1.5–2 CSS px; color falls back to series color. */
  readonly lineStyle?: LineStyleConfig;
  /**
   * Draw a marker at (x, y) (lollipop head). Default true to match SciChart demos;
   * set false for pure stems.
   */
  readonly showMarker?: boolean;
  /** Marker size (CSS px diameter-ish, same spirit as scatter symbolSize). Default ~6. */
  readonly symbolSize?: number;
  /**
   * Sampling: `'none'` only (sparse event series). Other modes warn + ignore.
   * GPU line decimation is **not** used for impulse (stem topology).
   */
  readonly sampling?: 'none';
}

export type SeriesConfig =
  | LineSeriesConfig
  | AreaSeriesConfig
  | BarSeriesConfig
  | ScatterSeriesConfig
  | PieSeriesConfig
  | CandlestickSeriesConfig
  | OhlcSeriesConfig
  | HeatmapSeriesConfig
  | BandSeriesConfig
  | ErrorBarSeriesConfig
  | ImpulseSeriesConfig
  | PointCloud3DSeriesConfig
  | Surface3DSeriesConfig;

/**
 * Parameters passed to tooltip formatter function.
 */
export interface TooltipParams {
  readonly seriesName: string;
  readonly seriesIndex: number;
  readonly dataIndex: number;
  /**
   * Value tuple for the data point.
   * - Cartesian series (line, area, bar, scatter): [x, y]
   * - Stacked mountain/area: [x, y] where **y is this layer’s contribution** (not cumulative top)
   * - Band series: [x, y] (lower/first curve); see also optional `y1` / `yMid` / `yRange`
   * - Candlestick series: [timestamp, open, close, low, high]
   * - Heatmap: [cellCenterX, cellCenterY] (see also optional `z`)
   * - Error bar: [x, y] center; see optional `high` / `low` / `yErrorHigh` / `yErrorLow`
   * - Impulse: [x, y] tip of stem; see optional `baseline`
   */
  readonly value: readonly [number, number] | readonly [number, number, number, number, number];
  readonly color: string;
  /**
   * Heatmap cell z value when the hit is a heatmap cell.
   * `value` is still [cellCenterX, cellCenterY]; `dataIndex` is row-major `j * columns + i`.
   */
  readonly z?: number;
  /**
   * Band series: second curve value at the hit sample (`y1`).
   * `value` remains `[x, y]` for backward compatibility with cartesian formatters.
   */
  readonly y1?: number;
  /** Band series: midpoint `(y + y1) / 2` when both are finite. */
  readonly yMid?: number;
  /** Band series: absolute range `|y1 - y|` when both are finite. */
  readonly yRange?: number;
  /** Error bar: absolute high endpoint. */
  readonly high?: number;
  /** Error bar: absolute low endpoint. */
  readonly low?: number;
  /** Error bar: derived `high - y` when both finite. */
  readonly yErrorHigh?: number;
  /** Error bar: derived `y - low` when both finite. */
  readonly yErrorLow?: number;
  /** Impulse series: stem floor in data space. */
  readonly baseline?: number;
  /**
   * Stack group id when the hit is a stacked mountain/area layer
   * (`stack` on line+`areaStyle` or `type: 'area'`).
   */
  readonly stack?: string;
  /**
   * Stacked mountain/area: composition total at this x (top of positive stack /
   * bottom of negative stack net). `value[1]` remains the **layer contribution**.
   */
  readonly stackTotal?: number;
}

/**
 * Tooltip configuration.
 */
export interface TooltipConfig {
  readonly show?: boolean;
  readonly trigger?: 'item' | 'axis';
  /**
   * Custom formatter function for tooltip content.
   * When trigger is 'item', receives a single TooltipParams.
   * When trigger is 'axis', receives an array of TooltipParams.
   * When trigger is undefined, formatter should handle both signatures.
   */
  readonly formatter?: ((params: TooltipParams) => string) | ((params: ReadonlyArray<TooltipParams>) => string);
}

/**
 * Animation configuration for transitions (type definitions only).
 *
 * - `duration` is in milliseconds (default: 300).
 * - Set `ChartGPUOptions.animation = false` to disable all animation.
 */
export interface AnimationConfig {
  /** Animation duration in ms (default: 300). */
  readonly duration?: number;
  readonly easing?: 'linear' | 'cubicOut' | 'cubicInOut' | 'bounceOut';
  /** Animation delay in ms. */
  readonly delay?: number;
}

/**
 * Legend position within the chart.
 */
export type LegendPosition = 'top' | 'bottom' | 'left' | 'right';

/**
 * Legend configuration for series display.
 */
export interface LegendConfig {
  readonly show?: boolean;
  readonly position?: LegendPosition;
}

/**
 * Branded type for exact FPS measurements.
 * Use this to distinguish FPS from other numeric values at compile time.
 */
export type ExactFPS = number & { readonly __brand: 'ExactFPS' };

/**
 * Branded type for millisecond durations.
 * Use this to distinguish milliseconds from other numeric values at compile time.
 */
export type Milliseconds = number & { readonly __brand: 'Milliseconds' };

/**
 * Branded type for byte sizes.
 * Use this to distinguish bytes from other numeric values at compile time.
 */
export type Bytes = number & { readonly __brand: 'Bytes' };

/**
 * Statistics for frame time measurements.
 * All times are in milliseconds.
 */
export interface FrameTimeStats {
  /** Minimum frame time in the measurement window. */
  readonly min: Milliseconds;
  /** Maximum frame time in the measurement window. */
  readonly max: Milliseconds;
  /** Average (mean) frame time. */
  readonly avg: Milliseconds;
  /** 50th percentile (median) frame time. */
  readonly p50: Milliseconds;
  /** 95th percentile frame time. */
  readonly p95: Milliseconds;
  /** 99th percentile frame time. */
  readonly p99: Milliseconds;
}

/**
 * GPU timing statistics.
 * Tracks CPU vs GPU time for render operations.
 */
export interface GPUTimingStats {
  /** Whether GPU timing is enabled and supported. */
  readonly enabled: boolean;
  /** CPU time spent preparing render commands (milliseconds). */
  readonly cpuTime: Milliseconds;
  /** GPU time spent executing render commands (milliseconds). */
  readonly gpuTime: Milliseconds;
}

/**
 * Memory usage statistics.
 * Tracks GPU buffer allocations.
 */
export interface MemoryStats {
  /** Currently used memory in bytes. */
  readonly used: Bytes;
  /** Peak memory usage in bytes since initialization. */
  readonly peak: Bytes;
  /** Total allocated memory in bytes (may include freed regions). */
  readonly allocated: Bytes;
}

/**
 * Frame drop detection statistics.
 * Tracks when frame time exceeds expected interval.
 */
export interface FrameDropStats {
  /** Total number of dropped frames. */
  readonly totalDrops: number;
  /** Consecutive dropped frames (current streak). */
  readonly consecutiveDrops: number;
  /** Timestamp of last dropped frame. */
  readonly lastDropTimestamp: Milliseconds;
}

/**
 * Comprehensive performance metrics.
 * Provides exact FPS measurement and detailed frame statistics.
 */
export interface PerformanceMetrics {
  /** Exact FPS calculated from frame time deltas. */
  readonly fps: ExactFPS;
  /** Frame time statistics (min/max/avg/percentiles). */
  readonly frameTimeStats: FrameTimeStats;
  /** GPU timing statistics (CPU vs GPU time). */
  readonly gpuTiming: GPUTimingStats;
  /** Memory usage statistics. */
  readonly memory: MemoryStats;
  /** Frame drop detection statistics. */
  readonly frameDrops: FrameDropStats;
  /** Total frames rendered since initialization. */
  readonly totalFrames: number;
  /** Total time elapsed since initialization (milliseconds). */
  readonly elapsedTime: Milliseconds;
}

/**
 * Performance capabilities of the current environment.
 * Indicates which performance features are supported.
 */
export interface PerformanceCapabilities {
  /** Whether GPU timing is supported (requires timestamp-query feature). */
  readonly gpuTimingSupported: boolean;
  /** Whether high-resolution timer is available (performance.now). */
  readonly highResTimerSupported: boolean;
  /** Whether performance metrics API is available. */
  readonly performanceMetricsSupported: boolean;
}

export type AnnotationLayer = 'belowSeries' | 'aboveSeries';

export interface AnnotationStyle {
  readonly color?: string;
  readonly lineWidth?: number;
  readonly lineDash?: ReadonlyArray<number>;
  readonly opacity?: number;
}

export type AnnotationLabelAnchor = 'start' | 'center' | 'end';

export type AnnotationLabelPadding = number | readonly [top: number, right: number, bottom: number, left: number];

export interface AnnotationLabelBackground {
  readonly color?: string;
  readonly opacity?: number;
  readonly padding?: AnnotationLabelPadding;
  readonly borderRadius?: number;
}

export interface AnnotationLabel {
  /**
   * Explicit label text. If provided, it takes precedence over template rendering.
   */
  readonly text?: string;
  /**
   * A template string for label generation (e.g. 'x={x}, y={y}').
   * Template semantics are implemented at runtime (types only here).
   */
  readonly template?: string;
  /**
   * Decimal places used when formatting numeric values for templates.
   */
  readonly decimals?: number;
  /**
   * Pixel offset from the anchor point, in CSS pixels: [dx, dy].
   */
  readonly offset?: readonly [dx: number, dy: number];
  readonly anchor?: AnnotationLabelAnchor;
  readonly background?: AnnotationLabelBackground;
}

export type AnnotationPosition =
  | Readonly<{ space: 'data'; x: number; y: number }>
  | Readonly<{ space: 'plot'; x: number; y: number }>;

export interface AnnotationLineX {
  readonly type: 'lineX';
  /** Data-space x coordinate for a vertical line. */
  readonly x: number;
  /**
   * Optional y-range in data-space: [minY, maxY].
   * If omitted, runtime may render the full plot height.
   */
  readonly yRange?: readonly [minY: number, maxY: number];
}

export interface AnnotationLineY {
  readonly type: 'lineY';
  /** Data-space y coordinate for a horizontal line. */
  readonly y: number;
  /**
   * Optional x-range in data-space: [minX, maxX].
   * If omitted, runtime may render the full plot width.
   */
  readonly xRange?: readonly [minX: number, maxX: number];
}

export interface AnnotationPointMarker {
  readonly symbol?: ScatterSymbol;
  /** Marker size in CSS pixels. */
  readonly size?: number;
  readonly style?: AnnotationStyle;
}

export interface AnnotationPoint {
  readonly type: 'point';
  readonly x: number;
  readonly y: number;
  readonly marker?: AnnotationPointMarker;
}

export interface AnnotationText {
  readonly type: 'text';
  readonly position: AnnotationPosition;
  readonly text: string;
}

export interface AnnotationBandX {
  readonly type: 'bandX';
  /** Data-space x start of the filled vertical region. */
  readonly from: number;
  /** Data-space x end of the filled vertical region. */
  readonly to: number;
}

export interface AnnotationConfigBase {
  /**
   * Optional stable identifier for updates/diffing in userland.
   * This is not interpreted by ChartGPU runtime yet (types only).
   */
  readonly id?: string;
  readonly layer?: AnnotationLayer;
  readonly style?: AnnotationStyle;
  readonly label?: AnnotationLabel;
}

export type AnnotationConfig = (
  | AnnotationLineX
  | AnnotationLineY
  | AnnotationPoint
  | AnnotationText
  | AnnotationBandX
) &
  AnnotationConfigBase;

/**
 * Grid lines visibility and count configuration.
 */
export interface GridLinesDirectionConfig {
  /**
   * Whether to show grid lines in this direction.
   * When false, no lines are drawn regardless of count.
   */
  readonly show?: boolean;
  /**
   * Number of grid lines to display.
   * When omitted, uses defaults: horizontal=5, vertical=6.
   */
  readonly count?: number;
  /**
   * CSS color string for grid lines in this direction.
   * Overrides top-level gridLines.color and theme.gridLineColor.
   */
  readonly color?: string;
}

/**
 * Grid lines configuration for the chart.
 * Supports boolean shorthand or detailed per-direction config.
 */
export interface GridLinesConfig {
  /**
   * Global show/hide toggle for all grid lines.
   * When false, no grid lines are drawn.
   * Default: true (show grid lines).
   */
  readonly show?: boolean;
  /**
   * CSS color string for all grid lines.
   * Can be overridden per-direction (horizontal.color, vertical.color).
   * Falls back to theme.gridLineColor if not specified.
   */
  readonly color?: string;
  /**
   * Global opacity for all grid lines (0-1).
   * This multiplies the alpha channel of the resolved color (including per-direction overrides).
   * Default: 1.
   */
  readonly opacity?: number;
  /**
   * Horizontal grid lines configuration.
   * Supports boolean shorthand: true (show with defaults), false (hide).
   */
  readonly horizontal?: boolean | GridLinesDirectionConfig;
  /**
   * Vertical grid lines configuration.
   * Supports boolean shorthand: true (show with defaults), false (hide).
   */
  readonly vertical?: boolean | GridLinesDirectionConfig;
}

export interface ChartGPUOptions {
  /**
   * Chart modality. Default `'cartesian2d'`.
   * Use `'cartesian3d'` for point clouds / surfaces (separate render path, depth, camera).
   * Mixing 2D and 3D series in one chart is rejected by OptionResolver.
   */
  readonly coordinateSystem?: CoordinateSystem;
  /** 3D camera (only when coordinateSystem is cartesian3d). */
  readonly camera?: Chart3DCameraOptions;
  /** 3D orbit/pan/zoom (cartesian3d only). */
  readonly interaction3d?: Interaction3DOptions;
  /** Optional 3D axis box / names (cartesian3d only). */
  readonly axes3d?: Axes3DOptions;
  readonly axes?: {
    readonly y?: ReadonlyArray<AxisConfig>;
  };
  readonly grid?: GridConfig;
  /**
   * Grid lines configuration controlling visibility, count, and appearance.
   * When omitted, grid lines are shown with theme defaults.
   */
  readonly gridLines?: GridLinesConfig;
  readonly xAxis?: AxisConfig;
  readonly yAxis?: AxisConfig;
  readonly dataZoom?: ReadonlyArray<DataZoomConfig>;
  readonly series?: ReadonlyArray<SeriesConfig>;
  readonly annotations?: ReadonlyArray<AnnotationConfig>;
  /**
   * When true, the chart may automatically keep the view anchored to the latest data while streaming.
   * Default: false.
   */
  readonly autoScroll?: boolean;
  /**
   * Chart theme used for styling and palette defaults.
   * Accepts a built-in theme name or a custom ThemeConfig override.
   */
  readonly theme?: 'dark' | 'light' | ThemeConfig;
  /**
   * Color palette used for series color assignment when a series does not
   * explicitly specify `color`. Colors should be valid CSS color strings.
   */
  readonly palette?: ReadonlyArray<string>;
  readonly tooltip?: TooltipConfig;
  readonly legend?: LegendConfig;
  /**
   * Animation configuration for transitions.
   *
   * - `false` disables all animation.
   * - `true` enables animation with defaults.
   */
  readonly animation?: AnimationConfig | boolean;
  /**
   * Render mode for controlling when frames are rendered.
   *
   * - `'auto'` (default): ChartGPU schedules renders automatically using requestAnimationFrame
   * - `'external'`: Application is responsible for calling renderFrame() on each frame
   */
  readonly renderMode?: RenderMode;
  /**
   * Multisample antialiasing for the main + overlay GPU passes.
   *
   * - `true` (default): 4× MSAA (WebGPU portable max; sampleCount 2 is invalid)
   * - `false`: sampleCount 1 — lower fill-rate / memory for multi-chart dashboards
   *   and streaming grids where pixel density is already high or cells are small
   *
   * **Create-only:** applied at `ChartGPU.create` / coordinator construction when
   * MSAA pipelines and the texture manager are built. Changing this via
   * `setOption` / `setOptions` does **not** rebuild those resources. To change
   * MSAA after creation, dispose and recreate the chart.
   */
  readonly antialias?: boolean;
  /**
   * Canvas backing-store pixel ratio. **Create-time policy** (not updated by `setOption`):
   * - **Omitted:** every `resize()` re-reads live `window.devicePixelRatio` (page zoom).
   * - **Explicit finite > 0:** frozen for the chart lifetime (buffer + text-overlay DPR).
   *
   * Set to `1` on multi-chart dashboards to cap GPU fill rate on high-DPI displays.
   * Buffer size uses **layout** CSS pixels (`canvas.clientWidth` / `clientHeight`) × DPR,
   * not `getBoundingClientRect()` (visual size under CSS zoom / parent scale).
   * Dispose and recreate the chart to change the create-time DPR policy.
   */
  readonly devicePixelRatio?: number;
  /**
   * Performance / fidelity policy (adaptive dense LOD, equal-N LTTB behavior).
   * See {@link PerformanceConfig}. Default lod is `'auto'`.
   */
  readonly performance?: PerformanceConfig;
}
