import type {
  AreaStyleConfig,
  AxisConfig,
  ChartGPUOptions,
  GridConfig,
  LineStyleConfig,
  AreaSeriesConfig,
  LineSeriesConfig,
} from './types';
import { defaultAreaStyle, defaultLineStyle, defaultOptions, defaultPalette } from './defaults';

export type ResolvedGridConfig = Readonly<Required<GridConfig>>;
export type ResolvedLineStyleConfig = Readonly<Required<LineStyleConfig>>;
export type ResolvedAreaStyleConfig = Readonly<Required<AreaStyleConfig>>;

export type ResolvedLineSeriesConfig = Readonly<
  Omit<LineSeriesConfig, 'color' | 'lineStyle' | 'areaStyle'> & {
    readonly color: string;
    readonly lineStyle: ResolvedLineStyleConfig;
    readonly areaStyle?: ResolvedAreaStyleConfig;
  }
>;

export type ResolvedAreaSeriesConfig = Readonly<
  Omit<AreaSeriesConfig, 'color' | 'areaStyle'> & {
    readonly color: string;
    readonly areaStyle: ResolvedAreaStyleConfig;
  }
>;

export type ResolvedSeriesConfig = ResolvedLineSeriesConfig | ResolvedAreaSeriesConfig;

export interface ResolvedChartGPUOptions
  extends Omit<ChartGPUOptions, 'grid' | 'xAxis' | 'yAxis' | 'palette' | 'series'> {
  readonly grid: ResolvedGridConfig;
  readonly xAxis: AxisConfig;
  readonly yAxis: AxisConfig;
  readonly palette: ReadonlyArray<string>;
  readonly series: ReadonlyArray<ResolvedSeriesConfig>;
}

const sanitizePalette = (palette: unknown): string[] => {
  if (!Array.isArray(palette)) return [];
  return palette
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
};

const normalizeOptionalColor = (color: unknown): string | undefined => {
  if (typeof color !== 'string') return undefined;
  const trimmed = color.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export function resolveOptions(userOptions: ChartGPUOptions = {}): ResolvedChartGPUOptions {
  const paletteCandidate = sanitizePalette(userOptions.palette);
  const palette =
    paletteCandidate.length > 0 ? paletteCandidate : Array.from(defaultOptions.palette ?? defaultPalette);

  // Ensure palette used for modulo indexing is never empty.
  const safePalette = palette.length > 0 ? palette : Array.from(defaultPalette);
  const paletteForIndexing = safePalette.length > 0 ? safePalette : ['#000000'];

  const grid: ResolvedGridConfig = {
    left: userOptions.grid?.left ?? defaultOptions.grid.left,
    right: userOptions.grid?.right ?? defaultOptions.grid.right,
    top: userOptions.grid?.top ?? defaultOptions.grid.top,
    bottom: userOptions.grid?.bottom ?? defaultOptions.grid.bottom,
  };

  const xAxis: AxisConfig = userOptions.xAxis
    ? {
        ...defaultOptions.xAxis,
        ...userOptions.xAxis,
        // runtime safety for JS callers
        type: (userOptions.xAxis as unknown as Partial<AxisConfig>).type ?? defaultOptions.xAxis.type,
      }
    : { ...defaultOptions.xAxis };

  const yAxis: AxisConfig = userOptions.yAxis
    ? {
        ...defaultOptions.yAxis,
        ...userOptions.yAxis,
        // runtime safety for JS callers
        type: (userOptions.yAxis as unknown as Partial<AxisConfig>).type ?? defaultOptions.yAxis.type,
      }
    : { ...defaultOptions.yAxis };

  const series: ReadonlyArray<ResolvedSeriesConfig> = (userOptions.series ?? []).map((s, i) => {
    const explicitColor = normalizeOptionalColor(s.color);
    const inheritedColor = paletteForIndexing[i % paletteForIndexing.length];
    const color = explicitColor ?? inheritedColor;

    if (s.type === 'area') {
      const areaStyle: ResolvedAreaStyleConfig = {
        opacity: s.areaStyle?.opacity ?? defaultAreaStyle.opacity,
      };

      return {
        ...s,
        color,
        areaStyle,
      };
    }

    const lineStyle: ResolvedLineStyleConfig = {
      width: s.lineStyle?.width ?? defaultLineStyle.width,
      opacity: s.lineStyle?.opacity ?? defaultLineStyle.opacity,
    };

    // Avoid leaking the unresolved (user) areaStyle shape via object spread.
    const { areaStyle: _userAreaStyle, ...rest } = s;

    return {
      ...rest,
      color,
      lineStyle,
      ...(s.areaStyle
        ? {
            areaStyle: {
              opacity: s.areaStyle.opacity ?? defaultAreaStyle.opacity,
            },
          }
        : null),
    };
  });

  return {
    grid,
    xAxis,
    yAxis,
    palette: safePalette,
    series,
  };
}

export const OptionResolver = { resolve: resolveOptions } as const;

