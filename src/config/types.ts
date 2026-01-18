/**
 * Chart configuration types (Phase 1).
 */

import type { ThemeConfig } from '../themes/types';

export type AxisType = 'value' | 'time' | 'category';
export type SeriesType = 'line' | 'area' | 'bar' | 'scatter' | 'pie';

/**
 * A single data point for a series.
 */
export type DataPointTuple = readonly [x: number, y: number, size?: number];

export type DataPoint = DataPointTuple | Readonly<{ x: number; y: number; size?: number }>;

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
  readonly type: AxisType;
  readonly min?: number;
  readonly max?: number;
  /** Tick length in CSS pixels (default: 6). */
  readonly tickLength?: number;
  readonly name?: string;
}

export interface LineStyleConfig {
  readonly width?: number;
  readonly opacity?: number;
}

export interface AreaStyleConfig {
  readonly opacity?: number;
}

export interface SeriesConfigBase {
  readonly name?: string;
  readonly data: ReadonlyArray<DataPoint>;
  readonly color?: string;
}

export interface LineSeriesConfig extends SeriesConfigBase {
  readonly type: 'line';
  readonly lineStyle?: LineStyleConfig;
  /**
   * Optional filled-area styling for a line series.
   * When provided, renderers may choose to render a filled area under the line.
   */
  readonly areaStyle?: AreaStyleConfig;
}

export interface AreaSeriesConfig extends SeriesConfigBase {
  readonly type: 'area';
  /**
   * Baseline in data-space used as the filled area floor.
   * If omitted, ChartGPU will default to the y-axis minimum.
   */
  readonly baseline?: number;
  readonly areaStyle?: AreaStyleConfig;
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
   * Scatter symbol size in CSS pixels. When a function is provided, it receives
   * the point tuple `[x, y, size?]`.
   */
  readonly symbolSize?: number | ((value: ScatterPointTuple) => number);
  readonly symbol?: ScatterSymbol;
}

export type PieDataItem = Readonly<{ value: number; name: string; color?: string }>;

export interface PieItemStyleConfig {
  readonly borderRadius?: number;
  readonly borderWidth?: number;
}

export type PieRadius = number | string | readonly [inner: number | string, outer: number | string];
export type PieCenter = readonly [x: number | string, y: number | string];

export interface PieSeriesConfig extends Omit<SeriesConfigBase, 'data'> {
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

export type SeriesConfig =
  | LineSeriesConfig
  | AreaSeriesConfig
  | BarSeriesConfig
  | ScatterSeriesConfig
  | PieSeriesConfig;

/**
 * Parameters passed to tooltip formatter function.
 */
export interface TooltipParams {
  readonly seriesName: string;
  readonly seriesIndex: number;
  readonly dataIndex: number;
  readonly value: [number, number];
  readonly color: string;
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

export interface ChartGPUOptions {
  readonly grid?: GridConfig;
  readonly xAxis?: AxisConfig;
  readonly yAxis?: AxisConfig;
  readonly series?: ReadonlyArray<SeriesConfig>;
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
}

