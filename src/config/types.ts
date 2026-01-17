/**
 * Chart configuration types (Phase 1).
 */

export type AxisType = 'value' | 'time' | 'category';
export type SeriesType = 'line';

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

export interface SeriesConfig {
  readonly type: SeriesType;
  readonly name?: string;
  readonly data: ReadonlyArray<DataPoint>;
  readonly color?: string;
  readonly lineStyle?: LineStyleConfig;
}

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

