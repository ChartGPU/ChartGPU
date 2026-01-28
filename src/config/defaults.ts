import type {
  AreaStyleConfig,
  CandlestickItemStyleConfig,
  CandlestickStyle,
  ChartGPUOptions,
  GridConfig,
  LineStyleConfig,
} from './types';

export const defaultGrid = {
  left: 60,
  right: 20,
  top: 40,
  bottom: 40,
} as const satisfies Required<GridConfig>;

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

export const scatterDefaults = {
  mode: 'points' as const,
  // Bin size in CSS pixels for density mode. Must be > 0.
  binSize: 2,
  densityColormap: 'viridis' as const,
  densityNormalization: 'log' as const,
} as const;

export const defaultOptions = {
  grid: defaultGrid,
  xAxis: { type: 'value' },
  yAxis: { type: 'value' },
  autoScroll: false,
  theme: 'dark',
  palette: defaultPalette,
  series: [],
} as const satisfies Readonly<
  Required<Pick<ChartGPUOptions, 'grid' | 'xAxis' | 'yAxis' | 'autoScroll' | 'theme' | 'palette'>> & {
    readonly series: readonly [];
  }
>;

