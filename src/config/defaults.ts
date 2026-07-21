import type {
  AreaStyleConfig,
  CandlestickItemStyleConfig,
  CandlestickStyle,
  ChartGPUOptions,
  GridConfig,
  GridLinesConfig,
  LineStyleConfig,
} from './types';

export const defaultGrid = {
  left: 60,
  right: 20,
  top: 40,
  bottom: 40,
} as const satisfies Required<GridConfig>;

/**
 * Soft grid gutter defaults for candle-primary charts (first series is candlestick).
 * Applied only when the corresponding `grid.left` / `grid.right` key is unset.
 * Left depends on whether any Y axis ends up on the left after position defaults.
 */
export const candlePrimaryGridDefaults = {
  /** No left-positioned Y (price on right only). */
  leftNoLeftY: 20,
  /** At least one left-positioned Y (e.g. volume dual-Y). */
  leftWithLeftY: 60,
  /** Room for right-side price ladder labels. */
  right: 70,
} as const;

export const defaultPalette = [
  '#5470C6',
  '#91CC75',
  '#FAC858',
  '#EE6666',
  '#73C0DE',
  '#3BA272',
  '#FC8452',
  '#9A60B4',
  '#EA7CCC',
] as const;

export const defaultLineStyle = {
  width: 2,
  opacity: 1,
} as const satisfies Required<Omit<LineStyleConfig, 'color'>>;

export const defaultAreaStyle = {
  opacity: 0.25,
} as const satisfies Required<Omit<AreaStyleConfig, 'color'>>;

export const candlestickDefaults = {
  style: 'classic' as CandlestickStyle,
  itemStyle: {
    upColor: '#22c55e',
    downColor: '#ef4444',
    upBorderColor: '#22c55e',
    downBorderColor: '#ef4444',
    borderWidth: 1,
  } as const satisfies Required<CandlestickItemStyleConfig>,
  barWidth: '80%' as const,
  barMinWidth: 1,
  barMaxWidth: 50,
  sampling: 'ohlc' as const,
  samplingThreshold: 5000,
} as const;

/** Defaults for thin OHLC bars (`type: 'ohlc'`). Sampling matches candlestick. */
export const ohlcDefaults = {
  itemStyle: {
    upColor: '#22c55e',
    downColor: '#ef4444',
    upBorderColor: '#22c55e',
    downBorderColor: '#ef4444',
    borderWidth: 1,
  } as const satisfies Required<CandlestickItemStyleConfig>,
  barWidth: '60%' as const,
  barMinWidth: 1,
  barMaxWidth: 50,
  /** Stem thickness in CSS px. */
  stemWidth: 1,
  /**
   * Open/close tick length as fraction of resolved body width when a percent string,
   * or absolute CSS px when a number. Default ~half-category arms.
   */
  tickLength: '45%' as const,
  sampling: 'ohlc' as const,
  samplingThreshold: 5000,
} as const;

export const scatterDefaults = {
  mode: 'points' as const,
  // Bin size in CSS pixels for density mode. Must be > 0.
  binSize: 2,
  densityColormap: 'viridis' as const,
  densityNormalization: 'log' as const,
} as const;

export const heatmapDefaults = {
  colormap: 'viridis' as const,
  zScale: 'linear' as const,
  opacity: 1,
  cellAnchor: 'corner' as const,
  nullHandling: 'transparent' as const,
  cellGapPx: 0,
} as const;

export const pointCloud3dDefaults = {
  pointSize: 3,
  opacity: 0.9,
  color: '#38bdf8',
} as const;

export const surface3dDefaults = {
  colormap: 'viridis' as const,
  opacity: 1,
  wireframe: false,
  lighting: 0.65,
  contoursShow: false,
  contoursLevels: 12,
  contoursColor: '#e2e8f0',
  contoursWidth: 1.5,
  contoursOpacity: 0.85,
} as const;

export const axes3dDefaults = {
  showBox: true,
  showGrid: true,
  labelMode: 'auto' as const,
  tickCount: 5,
} as const;

export const camera3dDefaults = {
  type: 'perspective' as const,
  fovY: Math.PI / 4,
  near: 0.01,
  far: 10000,
  orthoSize: 1,
  up: [0, 1, 0] as const,
};

export const interaction3dDefaults = {
  orbit: true,
  pan: true,
  zoom: true,
  orbitSpeed: 0.005,
  zoomSpeed: 1,
  panSpeed: 1,
} as const;

/**
 * Default grid lines configuration.
 * Matches createGridRenderer defaults: horizontal=5, vertical=6.
 */
export const defaultGridLines = {
  show: true,
  horizontal: {
    show: true,
    count: 5,
  },
  vertical: {
    show: true,
    count: 6,
  },
} as const satisfies Required<Omit<GridLinesConfig, 'color' | 'opacity'>> & {
  readonly horizontal: Required<Omit<import('./types').GridLinesDirectionConfig, 'color'>>;
  readonly vertical: Required<Omit<import('./types').GridLinesDirectionConfig, 'color'>>;
};

export const defaultOptions = {
  grid: defaultGrid,
  xAxis: { type: 'value' },
  yAxis: { type: 'value', autoBounds: 'visible' },
  autoScroll: false,
  theme: 'dark',
  palette: defaultPalette,
  series: [],
} as const satisfies Readonly<
  Required<Pick<ChartGPUOptions, 'grid' | 'xAxis' | 'yAxis' | 'autoScroll' | 'theme' | 'palette'>> & {
    readonly series: readonly [];
  }
>;
