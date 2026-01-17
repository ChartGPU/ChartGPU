import type { AreaStyleConfig, ChartGPUOptions, GridConfig, LineStyleConfig } from './types';

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
} as const satisfies Required<LineStyleConfig>;

export const defaultAreaStyle = {
  opacity: 0.25,
} as const satisfies Required<AreaStyleConfig>;

export const defaultOptions = {
  grid: defaultGrid,
  xAxis: { type: 'value' },
  yAxis: { type: 'value' },
  palette: defaultPalette,
  series: [],
} as const satisfies Readonly<
  Required<Pick<ChartGPUOptions, 'grid' | 'xAxis' | 'yAxis' | 'palette'>> & {
    readonly series: readonly [];
  }
>;

