import type {
  AreaStyleConfig,
  AxisConfig,
  ChartGPUOptions,
  DataPoint,
  DataPointTuple,
  DataZoomConfig,
  GridConfig,
  LineStyleConfig,
  AreaSeriesConfig,
  BarSeriesConfig,
  LineSeriesConfig,
  PieDataItem,
  PieSeriesConfig,
  ScatterSeriesConfig,
  SeriesSampling,
} from './types';
import { defaultAreaStyle, defaultLineStyle, defaultOptions, defaultPalette } from './defaults';
import { getTheme } from '../themes';
import type { ThemeConfig } from '../themes/types';
import { sampleSeriesDataPoints } from '../data/sampleSeries';

export type ResolvedGridConfig = Readonly<Required<GridConfig>>;
export type ResolvedLineStyleConfig = Readonly<Required<Omit<LineStyleConfig, 'color'>> & { readonly color: string }>;
export type ResolvedAreaStyleConfig = Readonly<Required<Omit<AreaStyleConfig, 'color'>> & { readonly color: string }>;

export type RawBounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

export type ResolvedLineSeriesConfig = Readonly<
  Omit<LineSeriesConfig, 'color' | 'lineStyle' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data'> & {
    readonly color: string;
    readonly lineStyle: ResolvedLineStyleConfig;
    readonly areaStyle?: ResolvedAreaStyleConfig;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    /**
     * Original (unsampled) series data.
     *
     * Used at runtime for zoom-aware re-sampling so we can increase detail when zoomed-in without
     * losing outliers or permanently discarding points.
     */
    readonly rawData: Readonly<LineSeriesConfig['data']>;
    readonly data: Readonly<LineSeriesConfig['data']>;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
  }
>;

export type ResolvedAreaSeriesConfig = Readonly<
  Omit<AreaSeriesConfig, 'color' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data'> & {
    readonly color: string;
    readonly areaStyle: ResolvedAreaStyleConfig;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    /** Original (unsampled) series data (see `ResolvedLineSeriesConfig.rawData`). */
    readonly rawData: Readonly<AreaSeriesConfig['data']>;
    readonly data: Readonly<AreaSeriesConfig['data']>;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
  }
>;

export type ResolvedBarSeriesConfig = Readonly<
  Omit<BarSeriesConfig, 'color' | 'sampling' | 'samplingThreshold' | 'data'> & {
    readonly color: string;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    /** Original (unsampled) series data (see `ResolvedLineSeriesConfig.rawData`). */
    readonly rawData: Readonly<BarSeriesConfig['data']>;
    readonly data: Readonly<BarSeriesConfig['data']>;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
  }
>;

export type ResolvedScatterSeriesConfig = Readonly<
  Omit<ScatterSeriesConfig, 'color' | 'sampling' | 'samplingThreshold' | 'data'> & {
    readonly color: string;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    /** Original (unsampled) series data (see `ResolvedLineSeriesConfig.rawData`). */
    readonly rawData: Readonly<ScatterSeriesConfig['data']>;
    readonly data: Readonly<ScatterSeriesConfig['data']>;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
  }
>;

export type ResolvedPieDataItem = Readonly<Omit<PieDataItem, 'color'> & { readonly color: string }>;

export type ResolvedPieSeriesConfig = Readonly<
  Omit<PieSeriesConfig, 'color' | 'data'> & {
    readonly color: string;
    readonly data: ReadonlyArray<ResolvedPieDataItem>;
  }
>;

export type ResolvedSeriesConfig =
  | ResolvedLineSeriesConfig
  | ResolvedAreaSeriesConfig
  | ResolvedBarSeriesConfig
  | ResolvedScatterSeriesConfig
  | ResolvedPieSeriesConfig;

export interface ResolvedChartGPUOptions
  extends Omit<ChartGPUOptions, 'grid' | 'xAxis' | 'yAxis' | 'theme' | 'palette' | 'series'> {
  readonly grid: ResolvedGridConfig;
  readonly xAxis: AxisConfig;
  readonly yAxis: AxisConfig;
  readonly autoScroll: boolean;
  readonly theme: ThemeConfig;
  readonly palette: ReadonlyArray<string>;
  readonly series: ReadonlyArray<ResolvedSeriesConfig>;
}

const sanitizeDataZoom = (input: unknown): ReadonlyArray<DataZoomConfig> | undefined => {
  if (!Array.isArray(input)) return undefined;

  const out: DataZoomConfig[] = [];

  for (const item of input) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;

    const type = record.type;
    if (type !== 'inside' && type !== 'slider') continue;

    const xAxisIndexRaw = record.xAxisIndex;
    const startRaw = record.start;
    const endRaw = record.end;
    const minSpanRaw = record.minSpan;
    const maxSpanRaw = record.maxSpan;

    const xAxisIndex =
      typeof xAxisIndexRaw === 'number' && Number.isFinite(xAxisIndexRaw) ? xAxisIndexRaw : undefined;
    const start = typeof startRaw === 'number' && Number.isFinite(startRaw) ? startRaw : undefined;
    const end = typeof endRaw === 'number' && Number.isFinite(endRaw) ? endRaw : undefined;
    const minSpan =
      typeof minSpanRaw === 'number' && Number.isFinite(minSpanRaw) ? minSpanRaw : undefined;
    const maxSpan =
      typeof maxSpanRaw === 'number' && Number.isFinite(maxSpanRaw) ? maxSpanRaw : undefined;

    out.push({ type, xAxisIndex, start, end, minSpan, maxSpan });
  }

  return out;
};

const sanitizePalette = (palette: unknown): string[] => {
  if (!Array.isArray(palette)) return [];
  return palette
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
};

const resolveTheme = (themeInput: unknown): ThemeConfig => {
  const base = getTheme('dark');

  if (typeof themeInput === 'string') {
    const name = themeInput.trim().toLowerCase();
    return name === 'light' ? getTheme('light') : getTheme('dark');
  }

  if (themeInput === null || typeof themeInput !== 'object' || Array.isArray(themeInput)) {
    return base;
  }

  const input = themeInput as Partial<Record<keyof ThemeConfig, unknown>>;
  const takeString = (key: keyof ThemeConfig): string | undefined => {
    const v = input[key];
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const fontSizeRaw = input.fontSize;
  const fontSize =
    typeof fontSizeRaw === 'number' && Number.isFinite(fontSizeRaw) ? fontSizeRaw : undefined;

  const colorPaletteCandidate = sanitizePalette(input.colorPalette);

  return {
    backgroundColor: takeString('backgroundColor') ?? base.backgroundColor,
    textColor: takeString('textColor') ?? base.textColor,
    axisLineColor: takeString('axisLineColor') ?? base.axisLineColor,
    axisTickColor: takeString('axisTickColor') ?? base.axisTickColor,
    gridLineColor: takeString('gridLineColor') ?? base.gridLineColor,
    colorPalette: colorPaletteCandidate.length > 0 ? colorPaletteCandidate : Array.from(base.colorPalette),
    fontFamily: takeString('fontFamily') ?? base.fontFamily,
    fontSize: fontSize ?? base.fontSize,
  };
};

const normalizeOptionalColor = (color: unknown): string | undefined => {
  if (typeof color !== 'string') return undefined;
  const trimmed = color.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeSampling = (value: unknown): SeriesSampling | undefined => {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'none' || v === 'lttb' || v === 'average' || v === 'max' || v === 'min'
    ? (v as SeriesSampling)
    : undefined;
};

const normalizeSamplingThreshold = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const t = Math.floor(value);
  return t > 0 ? t : undefined;
};

const isTupleDataPoint = (p: DataPoint): p is DataPointTuple => Array.isArray(p);

const computeRawBoundsFromData = (data: ReadonlyArray<DataPoint>): RawBounds | undefined => {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const p = data[i]!;
    const x = isTupleDataPoint(p) ? p[0] : p.x;
    const y = isTupleDataPoint(p) ? p[1] : p.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return undefined;
  }

  // Keep bounds usable for downstream scale derivation.
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
};

const assertUnreachable = (value: never): never => {
  // Should never happen if SeriesConfig union is exhaustively handled.
  // This is defensive runtime safety for JS callers / invalid inputs.
  throw new Error(
    `Unhandled series type: ${
      (value as unknown as { readonly type?: unknown } | null)?.type ?? 'unknown'
    }`
  );
};

export function resolveOptions(userOptions: ChartGPUOptions = {}): ResolvedChartGPUOptions {
  const baseTheme = resolveTheme(userOptions.theme);

  // runtime safety for JS callers
  const autoScrollRaw = (userOptions as unknown as { readonly autoScroll?: unknown }).autoScroll;
  const autoScroll = typeof autoScrollRaw === 'boolean' ? autoScrollRaw : defaultOptions.autoScroll;

  // runtime safety for JS callers
  const animationRaw = (userOptions as unknown as { readonly animation?: unknown }).animation;
  const animationCandidate: ChartGPUOptions['animation'] =
    typeof animationRaw === 'boolean' ||
    (animationRaw !== null && typeof animationRaw === 'object' && !Array.isArray(animationRaw))
      ? (animationRaw as ChartGPUOptions['animation'])
      : undefined;
  // Default: animation enabled (with defaults) unless explicitly disabled.
  const animation: ChartGPUOptions['animation'] = animationCandidate ?? true;

  // Backward compatibility:
  // - If `userOptions.palette` is provided (non-empty), treat it as an override for the theme palette.
  const paletteOverride = sanitizePalette(userOptions.palette);

  const themeCandidate: ThemeConfig =
    paletteOverride.length > 0 ? { ...baseTheme, colorPalette: paletteOverride } : baseTheme;

  // Ensure palette used for modulo indexing is never empty.
  const paletteFromTheme = sanitizePalette(themeCandidate.colorPalette);
  const safePalette =
    paletteFromTheme.length > 0
      ? paletteFromTheme
      : sanitizePalette(defaultOptions.palette ?? defaultPalette).length > 0
        ? sanitizePalette(defaultOptions.palette ?? defaultPalette)
        : Array.from(defaultPalette);

  const paletteForIndexing = safePalette.length > 0 ? safePalette : ['#000000'];
  const theme: ThemeConfig = { ...themeCandidate, colorPalette: paletteForIndexing.slice() };

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
    const inheritedColor = theme.colorPalette[i % theme.colorPalette.length];
    const color = explicitColor ?? inheritedColor;

    const sampling: SeriesSampling = normalizeSampling((s as unknown as { sampling?: unknown }).sampling) ?? 'lttb';
    const samplingThreshold: number =
      normalizeSamplingThreshold((s as unknown as { samplingThreshold?: unknown }).samplingThreshold) ?? 5000;

    switch (s.type) {
      case 'area': {
        // Resolve effective fill color with precedence: areaStyle.color → series.color → palette
        const areaStyleColor = normalizeOptionalColor(s.areaStyle?.color);
        const effectiveColor = areaStyleColor ?? explicitColor ?? inheritedColor;

        const areaStyle: ResolvedAreaStyleConfig = {
          opacity: s.areaStyle?.opacity ?? defaultAreaStyle.opacity,
          color: effectiveColor,
        };

        const rawBounds = computeRawBoundsFromData(s.data);
        return {
          ...s,
          rawData: s.data,
          data: sampleSeriesDataPoints(s.data, sampling, samplingThreshold),
          color: effectiveColor,
          areaStyle,
          sampling,
          samplingThreshold,
          rawBounds,
        };
      }
      case 'line': {
        // Resolve effective stroke color with precedence: lineStyle.color → series.color → palette
        const lineStyleColor = normalizeOptionalColor(s.lineStyle?.color);
        const effectiveStrokeColor = lineStyleColor ?? explicitColor ?? inheritedColor;

        const lineStyle: ResolvedLineStyleConfig = {
          width: s.lineStyle?.width ?? defaultLineStyle.width,
          opacity: s.lineStyle?.opacity ?? defaultLineStyle.opacity,
          color: effectiveStrokeColor,
        };

        // Avoid leaking the unresolved (user) areaStyle shape via object spread.
        const { areaStyle: _userAreaStyle, ...rest } = s;
        const rawBounds = computeRawBoundsFromData(s.data);
        const sampledData = sampleSeriesDataPoints(s.data, sampling, samplingThreshold);

        return {
          ...rest,
          rawData: s.data,
          data: sampledData,
          color: effectiveStrokeColor,
          lineStyle,
          ...(s.areaStyle
            ? {
                areaStyle: {
                  opacity: s.areaStyle.opacity ?? defaultAreaStyle.opacity,
                  // Fill color precedence: areaStyle.color → resolved stroke color
                  color: normalizeOptionalColor(s.areaStyle.color) ?? effectiveStrokeColor,
                },
              }
            : {}),
          sampling,
          samplingThreshold,
          rawBounds,
        };
      }
      case 'bar': {
        const rawBounds = computeRawBoundsFromData(s.data);
        return {
          ...s,
          rawData: s.data,
          data: sampleSeriesDataPoints(s.data, sampling, samplingThreshold),
          color,
          sampling,
          samplingThreshold,
          rawBounds,
        };
      }
      case 'scatter': {
        const rawBounds = computeRawBoundsFromData(s.data);
        return {
          ...s,
          rawData: s.data,
          data: sampleSeriesDataPoints(s.data, sampling, samplingThreshold),
          color,
          sampling,
          samplingThreshold,
          rawBounds,
        };
      }
      case 'pie': {
        // Pie series intentionally do NOT support sampling at runtime.
        // For JS callers, strip any extra sampling keys so they don't leak through the resolver.
        const { sampling: _sampling, samplingThreshold: _samplingThreshold, ...rest } = s as PieSeriesConfig & {
          readonly sampling?: unknown;
          readonly samplingThreshold?: unknown;
        };

        const resolvedData: ReadonlyArray<ResolvedPieDataItem> = (s.data ?? []).map((item, itemIndex) => {
          const itemColor = normalizeOptionalColor(item?.color);
          const fallback = theme.colorPalette[(i + itemIndex) % theme.colorPalette.length];
          return {
            ...item,
            color: itemColor ?? fallback,
          };
        });

        return { ...rest, color, data: resolvedData };
      }
      default: {
        return assertUnreachable(s);
      }
    }
  });

  return {
    grid,
    xAxis,
    yAxis,
    autoScroll,
    dataZoom: sanitizeDataZoom((userOptions as ChartGPUOptions).dataZoom),
    animation,
    theme,
    palette: theme.colorPalette,
    series,
  };
}

export const OptionResolver = { resolve: resolveOptions } as const;

