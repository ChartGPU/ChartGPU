/**
 * Chart configuration types (Phase 1).
 */

export type AxisType = 'value' | 'time' | 'category';
export type SeriesType = 'line' | 'area';

/**
 * A single data point for a series.
 */
export type DataPoint =
  | readonly [x: number, y: number]
  | Readonly<{ x: number; y: number }>;

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

export type SeriesConfig = LineSeriesConfig | AreaSeriesConfig;

export interface ChartGPUOptions {
  readonly grid?: GridConfig;
  readonly xAxis?: AxisConfig;
  readonly yAxis?: AxisConfig;
  readonly series?: ReadonlyArray<SeriesConfig>;
  /**
   * Color palette used for series color assignment when a series does not
   * explicitly specify `color`. Colors should be valid CSS color strings.
   */
  readonly palette?: ReadonlyArray<string>;
}

