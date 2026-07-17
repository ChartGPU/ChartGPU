import type {
  AreaStyleConfig,
  AnnotationConfig,
  AnnotationLabel,
  AnnotationLabelAnchor,
  AnnotationLabelBackground,
  AnnotationPointMarker,
  AxisConfig,
  CandlestickItemStyleConfig,
  CandlestickSeriesConfig,
  CandlestickStyle,
  ChartGPUOptions,
  DataZoomConfig,
  GridConfig,
  GridLinesConfig,
  GridLinesDirectionConfig,
  LineStyleConfig,
  OHLCDataPoint,
  OHLCDataPointTuple,
  AreaSeriesConfig,
  BarSeriesConfig,
  LineSeriesConfig,
  PieDataItem,
  PieSeriesConfig,
  ScatterSeriesConfig,
  ScatterSymbol,
  SeriesSampling,
  SeriesType,
  CartesianSeriesData,
  PerformanceLod,
} from './types';
import {
  candlestickDefaults,
  defaultAreaStyle,
  defaultGridLines,
  defaultLineStyle,
  defaultOptions,
  defaultPalette,
  scatterDefaults,
} from './defaults';
import { getTheme } from '../themes';
import type { ThemeConfig } from '../themes/types';
import { sampleSeriesDataPoints } from '../data/sampleSeries';
import { ohlcSample } from '../data/ohlcSample';
import {
  computeRawBoundsFromCartesianData,
  computeRawXExtentFromCartesianData,
  getPointCount,
  hasNullGaps,
} from '../data/cartesianData';
import { cheapCartesianContentStamp, cheapOHLCContentStamp } from '../data/seriesContentHash';
import {
  classifyEqualNYOnlyRewrite,
  indexSortedXFingerprint,
  isIndexSortedX,
  remapIndexSortedSampleY,
  sampleLooksIndexSortedX,
} from '../data/seriesRewriteDetect';
import { parseCssColorToRgba01 } from '../utils/colors';

export type ResolvedGridConfig = Readonly<Required<GridConfig>>;
export type ResolvedLineStyleConfig = Readonly<Required<Omit<LineStyleConfig, 'color'>> & { readonly color: string }>;
export type ResolvedAreaStyleConfig = Readonly<Required<Omit<AreaStyleConfig, 'color'>> & { readonly color: string }>;

/**
 * Resolved grid lines direction configuration with all defaults applied.
 */
export type ResolvedGridLinesDirectionConfig = Readonly<{
  readonly show: boolean;
  readonly count: number;
  readonly color: string;
}>;

/**
 * Resolved grid lines configuration with all defaults and color resolution applied.
 */
export type ResolvedGridLinesConfig = Readonly<{
  readonly show: boolean;
  readonly color: string;
  readonly opacity: number;
  readonly horizontal: ResolvedGridLinesDirectionConfig;
  readonly vertical: ResolvedGridLinesDirectionConfig;
}>;

export type RawBounds = Readonly<{
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}>;

/**
 * How `rawBounds` was derived. Prevents sticky synthetic bounds when axes switch
 * from explicit min/max back to auto under a stable data ref.
 * @internal
 */
export type RawBoundsMode = 'synthetic' | 'xDataYAxis' | 'data';

export type ResolvedLineSeriesConfig = Readonly<
  Omit<
    LineSeriesConfig,
    'color' | 'lineStyle' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data' | 'connectNulls'
  > & {
    readonly connectNulls: boolean;
    readonly color: string;
    readonly lineStyle: ResolvedLineStyleConfig;
    readonly areaStyle?: ResolvedAreaStyleConfig;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    /** Original (unsampled) series data. */
    readonly rawData: Readonly<LineSeriesConfig['data']>;
    readonly data: Readonly<LineSeriesConfig['data']>;
    readonly yAxis: string;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
    /** @internal How rawBounds was derived (synthetic / xDataYAxis / data). */
    readonly rawBoundsMode?: RawBoundsMode;
  }
>;

export type ResolvedAreaSeriesConfig = Readonly<
  Omit<AreaSeriesConfig, 'color' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data' | 'connectNulls'> & {
    readonly connectNulls: boolean;
    readonly color: string;
    readonly areaStyle: ResolvedAreaStyleConfig;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    /** Original (unsampled) series data (see `ResolvedLineSeriesConfig.rawData`). */
    readonly rawData: Readonly<AreaSeriesConfig['data']>;
    readonly data: Readonly<AreaSeriesConfig['data']>;
    readonly yAxis: string;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
    /** @internal How rawBounds was derived (synthetic / xDataYAxis / data). */
    readonly rawBoundsMode?: RawBoundsMode;
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
    readonly yAxis: string;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
    /** @internal How rawBounds was derived (synthetic / xDataYAxis / data). */
    readonly rawBoundsMode?: RawBoundsMode;
  }
>;

export type ResolvedScatterSeriesConfig = Readonly<
  Omit<
    ScatterSeriesConfig,
    | 'color'
    | 'sampling'
    | 'samplingThreshold'
    | 'data'
    | 'mode'
    | 'binSize'
    | 'densityColormap'
    | 'densityNormalization'
  > & {
    readonly color: string;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    readonly mode: NonNullable<ScatterSeriesConfig['mode']>;
    readonly binSize: number;
    readonly densityColormap: NonNullable<ScatterSeriesConfig['densityColormap']>;
    readonly densityNormalization: NonNullable<ScatterSeriesConfig['densityNormalization']>;
    /** Original (unsampled) series data (see `ResolvedLineSeriesConfig.rawData`). */
    readonly rawData: Readonly<ScatterSeriesConfig['data']>;
    readonly data: Readonly<ScatterSeriesConfig['data']>;
    readonly yAxis: string;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
    /**
     * @internal Full O(n) proved that raw data is x=i at {@link indexSortedPointCount}.
     * Sticky across equal-N y-only rewrites so subsequent frames skip re-proving.
     */
    readonly indexSortedProven?: boolean;
    /** @internal Point count when {@link indexSortedProven} was set. */
    readonly indexSortedPointCount?: number;
    /** @internal X fingerprint when {@link indexSortedProven} was set (issue 1.6). */
    readonly indexSortedFingerprint?: number;
    /** @internal How rawBounds was derived (synthetic / xDataYAxis / data). */
    readonly rawBoundsMode?: RawBoundsMode;
  }
>;

export type ResolvedPieDataItem = Readonly<
  Omit<PieDataItem, 'color' | 'visible'> & {
    readonly color: string;
    readonly visible: boolean;
  }
>;

export type ResolvedPieSeriesConfig = Readonly<
  Omit<PieSeriesConfig, 'color' | 'data'> & {
    readonly color: string;
    readonly data: ReadonlyArray<ResolvedPieDataItem>;
  }
>;

export type ResolvedCandlestickItemStyleConfig = Readonly<Required<CandlestickItemStyleConfig>>;

export type ResolvedCandlestickSeriesConfig = Readonly<
  Omit<
    CandlestickSeriesConfig,
    | 'color'
    | 'style'
    | 'itemStyle'
    | 'barWidth'
    | 'barMinWidth'
    | 'barMaxWidth'
    | 'sampling'
    | 'samplingThreshold'
    | 'data'
  > & {
    readonly color: string;
    readonly style: CandlestickStyle;
    readonly itemStyle: ResolvedCandlestickItemStyleConfig;
    readonly barWidth: number | string;
    readonly barMinWidth: number;
    readonly barMaxWidth: number;
    readonly sampling: 'none' | 'ohlc';
    readonly samplingThreshold: number;
    /** Original (unsampled) series data. */
    readonly rawData: Readonly<CandlestickSeriesConfig['data']>;
    readonly data: Readonly<CandlestickSeriesConfig['data']>;
    readonly yAxis: string;
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
    /** @internal How rawBounds was derived (synthetic / xDataYAxis / data). */
    readonly rawBoundsMode?: RawBoundsMode;
  }
>;

export type ResolvedSeriesConfig =
  | ResolvedLineSeriesConfig
  | ResolvedAreaSeriesConfig
  | ResolvedBarSeriesConfig
  | ResolvedScatterSeriesConfig
  | ResolvedPieSeriesConfig
  | ResolvedCandlestickSeriesConfig;

export type ResolvedPerformanceConfig = Readonly<{
  readonly lod: PerformanceLod;
}>;

export interface ResolvedChartGPUOptions extends Omit<
  ChartGPUOptions,
  'grid' | 'gridLines' | 'xAxis' | 'yAxis' | 'axes' | 'theme' | 'palette' | 'series' | 'legend' | 'performance'
> {
  readonly grid: ResolvedGridConfig;
  readonly gridLines: ResolvedGridLinesConfig;
  readonly xAxis: AxisConfig;
  readonly yAxes: ReadonlyArray<AxisConfig>;
  readonly autoScroll: boolean;
  readonly theme: ThemeConfig;
  readonly palette: ReadonlyArray<string>;
  readonly series: ReadonlyArray<ResolvedSeriesConfig>;
  readonly annotations?: ReadonlyArray<AnnotationConfig>;
  readonly legend?: import('./types').LegendConfig;
  readonly performance: ResolvedPerformanceConfig;
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

    const xAxisIndex = typeof xAxisIndexRaw === 'number' && Number.isFinite(xAxisIndexRaw) ? xAxisIndexRaw : undefined;
    const start = typeof startRaw === 'number' && Number.isFinite(startRaw) ? startRaw : undefined;
    const end = typeof endRaw === 'number' && Number.isFinite(endRaw) ? endRaw : undefined;
    const minSpan = typeof minSpanRaw === 'number' && Number.isFinite(minSpanRaw) ? minSpanRaw : undefined;
    const maxSpan = typeof maxSpanRaw === 'number' && Number.isFinite(maxSpanRaw) ? maxSpanRaw : undefined;

    out.push({ type, xAxisIndex, start, end, minSpan, maxSpan });
  }

  return out;
};

const sanitizeAnnotations = (input: unknown): ReadonlyArray<AnnotationConfig> | undefined => {
  if (!Array.isArray(input)) return undefined;

  const out: AnnotationConfig[] = [];

  const isLabelAnchor = (v: unknown): v is AnnotationLabelAnchor => v === 'start' || v === 'center' || v === 'end';

  const isScatterSymbol = (v: unknown): v is ScatterSymbol => v === 'circle' || v === 'rect' || v === 'triangle';

  const sanitizeString = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };

  const sanitizeFiniteNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const sanitizeOpacity01 = (v: unknown): number | undefined => {
    const n = sanitizeFiniteNumber(v);
    if (n == null) return undefined;
    return Math.min(1, Math.max(0, n));
  };

  const sanitizeLineDash = (v: unknown): readonly number[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const cleaned = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).map((x) => x);
    if (cleaned.length === 0) return undefined;
    Object.freeze(cleaned);
    return cleaned;
  };

  const sanitizePadding = (v: unknown): number | readonly [number, number, number, number] | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!Array.isArray(v) || v.length !== 4) return undefined;
    const t = sanitizeFiniteNumber(v[0]);
    const r = sanitizeFiniteNumber(v[1]);
    const b = sanitizeFiniteNumber(v[2]);
    const l = sanitizeFiniteNumber(v[3]);
    if (t == null || r == null || b == null || l == null) return undefined;
    return [t, r, b, l] as const;
  };

  for (const item of input) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;

    const type = record.type;
    if (type !== 'lineX' && type !== 'lineY' && type !== 'point' && type !== 'text' && type !== 'bandX') continue;

    const id = sanitizeString(record.id);
    const layerRaw = record.layer;
    const layer = layerRaw === 'belowSeries' || layerRaw === 'aboveSeries' ? layerRaw : undefined;

    const styleRaw = record.style;
    const style =
      styleRaw && typeof styleRaw === 'object' && !Array.isArray(styleRaw)
        ? (() => {
            const s = styleRaw as Record<string, unknown>;
            const color = sanitizeString(s.color);
            const lineWidth = sanitizeFiniteNumber(s.lineWidth);
            const lineDash = sanitizeLineDash(s.lineDash);
            const opacity = sanitizeOpacity01(s.opacity);
            const next: Record<string, unknown> = {
              ...(color ? { color } : {}),
              ...(lineWidth != null ? { lineWidth } : {}),
              ...(lineDash ? { lineDash } : {}),
              ...(opacity != null ? { opacity } : {}),
            };
            return Object.keys(next).length > 0 ? (next as AnnotationConfig['style']) : undefined;
          })()
        : undefined;

    const labelRaw = record.label;
    const label =
      labelRaw && typeof labelRaw === 'object' && !Array.isArray(labelRaw)
        ? (() => {
            const l = labelRaw as Record<string, unknown>;
            const text = sanitizeString(l.text);
            const template = sanitizeString(l.template);
            const decimalsRaw = l.decimals;
            const decimals =
              typeof decimalsRaw === 'number' && Number.isFinite(decimalsRaw) && decimalsRaw >= 0
                ? Math.min(20, Math.floor(decimalsRaw))
                : undefined;
            const offsetRaw = l.offset;
            const offset =
              Array.isArray(offsetRaw) &&
              offsetRaw.length === 2 &&
              typeof offsetRaw[0] === 'number' &&
              Number.isFinite(offsetRaw[0]) &&
              typeof offsetRaw[1] === 'number' &&
              Number.isFinite(offsetRaw[1])
                ? ([offsetRaw[0], offsetRaw[1]] as const)
                : undefined;
            const anchorRaw = l.anchor;
            const anchor = isLabelAnchor(anchorRaw) ? anchorRaw : undefined;
            const bgRaw = l.background;
            const background =
              bgRaw && typeof bgRaw === 'object' && !Array.isArray(bgRaw)
                ? (() => {
                    const bg = bgRaw as Record<string, unknown>;
                    const color = sanitizeString(bg.color);
                    const opacity = sanitizeOpacity01(bg.opacity);
                    const padding = sanitizePadding(bg.padding);
                    const borderRadius = sanitizeFiniteNumber(bg.borderRadius);
                    const next: AnnotationLabelBackground = {
                      ...(color ? { color } : {}),
                      ...(opacity != null ? { opacity } : {}),
                      ...(padding != null ? { padding } : {}),
                      ...(borderRadius != null ? { borderRadius } : {}),
                    };
                    return Object.keys(next).length > 0 ? next : undefined;
                  })()
                : undefined;

            const next: AnnotationLabel = {
              ...(text ? { text } : {}),
              ...(template ? { template } : {}),
              ...(decimals != null ? { decimals } : {}),
              ...(offset ? { offset } : {}),
              ...(anchor ? { anchor } : {}),
              ...(background ? { background } : {}),
            };

            return Object.keys(next).length > 0 ? next : undefined;
          })()
        : undefined;

    if (type === 'bandX') {
      const from = sanitizeFiniteNumber(record.from);
      const to = sanitizeFiniteNumber(record.to);
      if (from == null || to == null) continue;
      const base: AnnotationConfig = {
        type: 'bandX',
        from,
        to,
        ...(id ? { id } : {}),
        ...(layer ? { layer } : {}),
        ...(style ? { style } : {}),
      };
      out.push(base);
      continue;
    }

    if (type === 'lineX') {
      const x = sanitizeFiniteNumber(record.x);
      if (x == null) continue;
      const base: AnnotationConfig = {
        type: 'lineX',
        x,
        ...(id ? { id } : {}),
        ...(layer ? { layer } : {}),
        ...(style ? { style } : {}),
        ...(label ? { label } : {}),
      };
      out.push(base);
      continue;
    }

    if (type === 'lineY') {
      const y = sanitizeFiniteNumber(record.y);
      if (y == null) continue;
      const base: AnnotationConfig = {
        type: 'lineY',
        y,
        ...(id ? { id } : {}),
        ...(layer ? { layer } : {}),
        ...(style ? { style } : {}),
        ...(label ? { label } : {}),
      };
      out.push(base);
      continue;
    }

    if (type === 'point') {
      const x = sanitizeFiniteNumber(record.x);
      const y = sanitizeFiniteNumber(record.y);
      if (x == null || y == null) continue;
      const markerRaw = record.marker;
      const marker =
        markerRaw && typeof markerRaw === 'object' && !Array.isArray(markerRaw)
          ? (() => {
              const m = markerRaw as Record<string, unknown>;
              const symbolRaw = m.symbol;
              const symbol = isScatterSymbol(symbolRaw) ? symbolRaw : undefined;
              const size = sanitizeFiniteNumber(m.size);
              const mStyleRaw = m.style;
              const mStyle =
                mStyleRaw && typeof mStyleRaw === 'object' && !Array.isArray(mStyleRaw)
                  ? (() => {
                      const s = mStyleRaw as Record<string, unknown>;
                      const color = sanitizeString(s.color);
                      const opacity = sanitizeOpacity01(s.opacity);
                      const lineWidth = sanitizeFiniteNumber(s.lineWidth);
                      const lineDash = sanitizeLineDash(s.lineDash);
                      const next: Record<string, unknown> = {
                        ...(color ? { color } : {}),
                        ...(opacity != null ? { opacity } : {}),
                        ...(lineWidth != null ? { lineWidth } : {}),
                        ...(lineDash ? { lineDash } : {}),
                      };
                      return Object.keys(next).length > 0 ? (next as AnnotationConfig['style']) : undefined;
                    })()
                  : undefined;
              const next: AnnotationPointMarker = {
                ...(symbol ? { symbol } : {}),
                ...(size != null ? { size } : {}),
                ...(mStyle ? { style: mStyle } : {}),
              };
              return Object.keys(next).length > 0 ? next : undefined;
            })()
          : undefined;

      const base: AnnotationConfig = {
        type: 'point',
        x,
        y,
        ...(marker ? { marker } : {}),
        ...(id ? { id } : {}),
        ...(layer ? { layer } : {}),
        ...(style ? { style } : {}),
        ...(label ? { label } : {}),
      };
      out.push(base);
      continue;
    }

    // type === 'text'
    {
      const positionRaw = record.position;
      const text = sanitizeString(record.text);
      if (!text) continue;
      if (!positionRaw || typeof positionRaw !== 'object' || Array.isArray(positionRaw)) continue;
      const p = positionRaw as Record<string, unknown>;
      const space = p.space;
      if (space !== 'data' && space !== 'plot') continue;
      const x = sanitizeFiniteNumber(p.x);
      const y = sanitizeFiniteNumber(p.y);
      if (x == null || y == null) continue;
      const position = { space, x, y } as const;

      const base: AnnotationConfig = {
        type: 'text',
        position,
        text,
        ...(id ? { id } : {}),
        ...(layer ? { layer } : {}),
        ...(style ? { style } : {}),
        ...(label ? { label } : {}),
      };
      out.push(base);
      continue;
    }
  }

  if (out.length === 0) return undefined;
  Object.freeze(out);
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
  const fontSize = typeof fontSizeRaw === 'number' && Number.isFinite(fontSizeRaw) ? fontSizeRaw : undefined;

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
  return v === 'none' || v === 'lttb' || v === 'average' || v === 'max' || v === 'min' || v === 'ohlc'
    ? (v as SeriesSampling)
    : undefined;
};

const normalizeScatterMode = (value: unknown): NonNullable<ScatterSeriesConfig['mode']> | undefined => {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'points' || v === 'density' ? (v as NonNullable<ScatterSeriesConfig['mode']>) : undefined;
};

const normalizeDensityNormalization = (
  value: unknown
): NonNullable<ScatterSeriesConfig['densityNormalization']> | undefined => {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'linear' || v === 'sqrt' || v === 'log'
    ? (v as NonNullable<ScatterSeriesConfig['densityNormalization']>)
    : undefined;
};

const normalizeDensityBinSize = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const v = Math.floor(value);
  return v > 0 ? Math.max(1, v) : undefined;
};

const normalizeDensityColormap = (value: unknown): NonNullable<ScatterSeriesConfig['densityColormap']> | undefined => {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'viridis' || v === 'plasma' || v === 'inferno'
      ? (v as NonNullable<ScatterSeriesConfig['densityColormap']>)
      : undefined;
  }

  if (!Array.isArray(value)) return undefined;

  const isAlreadyCleanStringArray =
    value.length > 0 && value.every((c) => typeof c === 'string' && c.length > 0 && c === c.trim());

  if (isAlreadyCleanStringArray) {
    const arr = value as string[];
    if (!Object.isFrozen(arr)) Object.freeze(arr);
    return arr as readonly string[];
  }

  const sanitized = value
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  if (sanitized.length === 0) return undefined;
  Object.freeze(sanitized);
  return sanitized as readonly string[];
};

const normalizeCandlestickSampling = (value: unknown): 'none' | 'ohlc' | undefined => {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'none' || v === 'ohlc' ? (v as 'none' | 'ohlc') : undefined;
};

const normalizeSamplingThreshold = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const t = Math.floor(value);
  return t > 0 ? t : undefined;
};

const normalizeAxisAutoBounds = (value: unknown): AxisConfig['autoBounds'] | undefined => {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'global' || v === 'visible' ? (v as AxisConfig['autoBounds']) : undefined;
};

const isTupleOHLCDataPoint = (p: OHLCDataPoint): p is OHLCDataPointTuple => Array.isArray(p);

const computeRawBoundsFromOHLC = (data: ReadonlyArray<OHLCDataPoint>): RawBounds | undefined => {
  if (data.length === 0) return undefined;

  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  // Hoist tuple-vs-object detection once (assume homogeneous arrays).
  const isTuple = isTupleOHLCDataPoint(data[0]!);

  if (isTuple) {
    // Tuple format path: [timestamp, open, close, low, high]
    const dataAsTuples = data as ReadonlyArray<OHLCDataPointTuple>;

    for (let i = 0; i < dataAsTuples.length; i++) {
      const p = dataAsTuples[i]!;
      const x = p[0];
      const low = p[3];
      const high = p[4];
      if (!Number.isFinite(x) || !Number.isFinite(low) || !Number.isFinite(high)) continue;

      const yLow = Math.min(low, high);
      const yHigh = Math.max(low, high);

      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (yLow < yMin) yMin = yLow;
      if (yHigh > yMax) yMax = yHigh;
    }
  } else {
    // Object format path: { timestamp, open, close, low, high }
    const dataAsObjects = data as ReadonlyArray<Exclude<OHLCDataPoint, OHLCDataPointTuple>>;

    for (let i = 0; i < dataAsObjects.length; i++) {
      const p = dataAsObjects[i]!;
      const x = p.timestamp;
      const low = p.low;
      const high = p.high;
      if (!Number.isFinite(x) || !Number.isFinite(low) || !Number.isFinite(high)) continue;

      const yLow = Math.min(low, high);
      const yHigh = Math.max(low, high);

      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (yLow < yMin) yMin = yLow;
      if (yHigh > yMax) yMax = yHigh;
    }
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
    `Unhandled series type: ${(value as unknown as { readonly type?: unknown } | null)?.type ?? 'unknown'}`
  );
};

let candlestickWarned = false;
const warnCandlestickNotImplemented = (): void => {
  if (!candlestickWarned) {
    console.warn('ChartGPU: Candlestick series rendering is not yet implemented. Series will be skipped.');
    candlestickWarned = true;
  }
};

/**
 * Optional reuse of a prior resolve result (P1-7).
 * When raw data refs + sampling config match, skip O(n) bounds scan and sampleSeriesDataPoints.
 *
 * `previousUserOptions` + `lastUserSeriesElements` enable full-series-array reuse when:
 * - each series **element** matches the prior snapshot (detects `series[i] = {...}`),
 * - theme/palette refs match.
 *
 * Treat the outer `series` array **and each series config object** as immutable for this
 * fast path. Element replace is detected; property mutation under a stable element
 * (e.g. `series[i].data = newData`) is **not** (same as per-series data-ref contract).
 * Axes-only y-range rewrites typically re-pass the same stored series objects.
 */
export type ResolveOptionsReuse = Readonly<{
  readonly previousResolved?: ResolvedChartGPUOptions | null;
  /**
   * Prior **user** options object from the last `setOption` / create (not resolved).
   * Full resolved-series reuse requires **per-element** identity (+ theme/palette
   * identity); the outer `series` array may be a new array wrapping the same elements.
   * When user `theme`/`palette` refs match, the prior **resolved** theme object is
   * also reused (stable identity for legend / chrome skip paths).
   */
  readonly previousUserOptions?: ChartGPUOptions | null;
  /**
   * Snapshot of user series **element** refs captured after the last resolve.
   * Required to detect `series[i] = newConfig` under a stable outer array identity.
   * ChartGPU maintains this; unit tests should pass it for false-positive coverage.
   */
  readonly lastUserSeriesElements?: ReadonlyArray<unknown> | null;
}>;

/**
 * Gate for wholesale resolved-series reuse (axes-only multi-series).
 *
 * Requires:
 * 1. previous resolved series present and same length
 * 2. previousUserOptions present with a series array
 * 3. theme + palette identity match
 * 4. each next series element matches `lastUserSeriesElements[i]` (preferred) or,
 *    when no snapshot, each element matches `previousUserOptions.series[i]`
 *    (covers a new outer array wrapping the same element objects)
 *
 * **Immutable series contract:** Treat the outer `series` array and each config
 * object as immutable for this path. Mutating `series[i].data` / colors under a
 * stable element object is still not detected (same as per-series data-ref contract);
 * replace the series element or the whole array when content/style changes.
 */
export function canReuseEntireUserSeriesArray(input: {
  readonly previousResolvedSeries: ReadonlyArray<unknown> | null | undefined;
  readonly previousUserOptions: ChartGPUOptions | null | undefined;
  readonly userOptions: ChartGPUOptions;
  readonly lastUserSeriesElements?: ReadonlyArray<unknown> | null;
}): boolean {
  const { previousResolvedSeries, previousUserOptions, userOptions, lastUserSeriesElements } = input;
  if (previousResolvedSeries == null || previousUserOptions == null) return false;
  const userSeriesArr = userOptions.series;
  if (userSeriesArr == null) return false;
  if (previousUserOptions.theme !== userOptions.theme) return false;
  if (previousUserOptions.palette !== userOptions.palette) return false;
  if (previousResolvedSeries.length !== userSeriesArr.length) return false;

  const prevUserSeries = previousUserOptions.series;
  if (prevUserSeries == null || prevUserSeries.length !== userSeriesArr.length) return false;

  // Prefer explicit element snapshot (detects index reassignment under stable outer array).
  // When the outer array identity is stable and no snapshot is provided, comparing
  // prevUserSeries[i] to userSeriesArr[i] is tautological — fail closed so
  // series[i]=… cannot silently reuse without ChartGPU's snapshot.
  if (prevUserSeries === userSeriesArr && lastUserSeriesElements == null) {
    return false;
  }
  const baseline = lastUserSeriesElements ?? prevUserSeries;
  if (baseline.length !== userSeriesArr.length) return false;
  for (let i = 0; i < userSeriesArr.length; i++) {
    if (baseline[i] !== userSeriesArr[i]) return false;
  }
  return true;
}

/**
 * True when the previous resolved series can supply `data` + `rawBounds` without re-sampling.
 * Requires stable raw data reference, identical sampling-related config, and a matching
 * content hash.
 *
 * **In-place mutation contract:** Mutating point values under a stable data array / columns
 * object reference (without replacing the array) is not detected by resolve. Callers must
 * pass a new data reference (or use `appendData` / other explicit paths) to force a re-hash
 * and re-sample. This matches high-performance chart APIs and axes-only update patterns.
 */
export function canReuseResolvedSeriesSample(
  prev: ResolvedSeriesConfig | undefined,
  nextType: SeriesType,
  rawData: unknown,
  sampling: SeriesSampling | undefined,
  samplingThreshold: number | undefined,
  connectNulls: boolean | undefined,
  contentHash: number
): boolean {
  if (!prev || prev.type !== nextType || prev.type === 'pie') return false;
  const prevAny = prev as {
    readonly rawData?: unknown;
    readonly data?: unknown;
    readonly sampling?: SeriesSampling;
    readonly samplingThreshold?: number;
    readonly connectNulls?: boolean;
    readonly contentHash?: number;
    readonly areaStyle?: unknown;
  };
  if ((prevAny.rawData ?? prevAny.data) !== rawData) return false;
  if (prevAny.sampling !== sampling) return false;
  if (prevAny.samplingThreshold !== samplingThreshold) return false;
  if ((prevAny.connectNulls ?? false) !== (connectNulls ?? false)) {
    return false;
  }
  // contentHash is required for reuse — missing hash means we cannot prove stability.
  if (typeof prevAny.contentHash !== 'number' || prevAny.contentHash !== contentHash) {
    return false;
  }
  return true;
}

type WithResolvedDataIdentity = {
  readonly rawData?: unknown;
  readonly data?: unknown;
  readonly contentHash?: number;
};

/**
 * Content hash for a series resolve, O(1) when raw data identity is stable.
 *
 * When `previousResolved` has the same raw data reference (`prev.rawData ?? prev.data`)
 * and a stored `contentHash`, reuse that hash without scanning points.
 *
 * When the data reference changes, callers should pass an O(1) stamp
 * (`cheapCartesianContentStamp` / `cheapOHLCContentStamp`) via `hashData` —
 * full float scans are not needed because identity-reuse requires a stable ref.
 *
 * **In-place mutation:** Values mutated under a stable array ref are not detected until
 * a new data reference is provided.
 */
export function resolveSeriesContentHash(
  prev: ResolvedSeriesConfig | undefined,
  nextType: SeriesType,
  rawData: unknown,
  hashData: () => number
): number {
  if (prev && prev.type === nextType && prev.type !== 'pie') {
    const prevAny = prev as WithResolvedDataIdentity;
    if ((prevAny.rawData ?? prevAny.data) === rawData && typeof prevAny.contentHash === 'number') {
      return prevAny.contentHash;
    }
  }
  return hashData();
}

export function resolveOptions(
  userOptions: ChartGPUOptions = {},
  reuse?: ResolveOptionsReuse
): ResolvedChartGPUOptions {
  const previousSeries = reuse?.previousResolved?.series;
  const previousTheme = reuse?.previousResolved?.theme;
  const prevUserForTheme = reuse?.previousUserOptions;

  // runtime safety for JS callers
  const autoScrollRaw = (userOptions as unknown as { readonly autoScroll?: unknown }).autoScroll;
  const autoScroll = typeof autoScrollRaw === 'boolean' ? autoScrollRaw : defaultOptions.autoScroll;

  // performance.lod: 'auto' (default product) | 'strict' (honor width/radius; full LTTB).
  const userLodRaw = userOptions.performance?.lod;
  const performanceLod: PerformanceLod = userLodRaw === 'strict' ? 'strict' : 'auto';
  const performance: ResolvedPerformanceConfig = { lod: performanceLod };
  const forceFullLttbOnEqualN = performanceLod === 'strict';

  // runtime safety for JS callers
  const animationRaw = (userOptions as unknown as { readonly animation?: unknown }).animation;
  const animationCandidate: ChartGPUOptions['animation'] =
    typeof animationRaw === 'boolean' ||
    (animationRaw !== null && typeof animationRaw === 'object' && !Array.isArray(animationRaw))
      ? (animationRaw as ChartGPUOptions['animation'])
      : undefined;
  // Default: animation enabled (with defaults) unless explicitly disabled.
  const animation: ChartGPUOptions['animation'] = animationCandidate ?? true;

  // Reuse prior resolved theme identity when user theme/palette inputs are identity-stable.
  // Critical for legend DOM skip: coordinator passes resolved.theme every setOption; a fresh
  // theme object every frame would force N createElement rebuilds on axes-only multi-series.
  const canReuseResolvedTheme =
    previousTheme != null &&
    prevUserForTheme != null &&
    prevUserForTheme.theme === userOptions.theme &&
    prevUserForTheme.palette === userOptions.palette;

  let theme: ThemeConfig;
  if (canReuseResolvedTheme) {
    theme = previousTheme;
  } else {
    const baseTheme = resolveTheme(userOptions.theme);
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
    theme = {
      ...themeCandidate,
      colorPalette: paletteForIndexing.slice(),
    };
  }

  const grid: ResolvedGridConfig = {
    left: userOptions.grid?.left ?? defaultOptions.grid.left,
    right: userOptions.grid?.right ?? defaultOptions.grid.right,
    top: userOptions.grid?.top ?? defaultOptions.grid.top,
    bottom: userOptions.grid?.bottom ?? defaultOptions.grid.bottom,
  };

  // Resolve grid lines configuration with color hierarchy:
  // 1. per-direction color (horizontal.color / vertical.color)
  // 2. gridLines.color
  // 3. theme.gridLineColor
  const resolveGridLines = (input: GridLinesConfig | undefined, theme: ThemeConfig): ResolvedGridLinesConfig => {
    const globalShow = input?.show !== false; // default true
    const globalBaseColor = normalizeOptionalColor(input?.color) ?? theme.gridLineColor;
    const globalOpacity =
      typeof input?.opacity === 'number' && Number.isFinite(input.opacity)
        ? Math.min(1, Math.max(0, input.opacity))
        : 1;

    // Apply opacity multiplier to a CSS color string (best-effort).
    const applyOpacity = (color: string, opacity: number): string => {
      if (opacity === 1) return color;
      // Simple approach: parse and modify alpha channel
      const rgba = parseCssColorToRgba01(color);
      if (!rgba) return color;
      return `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(rgba[2] * 255)}, ${rgba[3] * opacity})`;
    };

    const resolvedGlobalColor = applyOpacity(globalBaseColor, globalOpacity);

    const resolveDirection = (
      direction: boolean | GridLinesDirectionConfig | undefined,
      defaultCount: number
    ): ResolvedGridLinesDirectionConfig => {
      // Boolean shorthand: false = hide, true/undefined = show with defaults
      if (direction === false) {
        return { show: false, count: 0, color: resolvedGlobalColor };
      }
      if (direction === true || direction === undefined) {
        return {
          show: globalShow,
          count: defaultCount,
          color: resolvedGlobalColor,
        };
      }
      // Object config
      const directionShow = direction.show !== false && globalShow; // respect global show
      const directionCount =
        typeof direction.count === 'number' && Number.isFinite(direction.count) && direction.count >= 0
          ? Math.floor(direction.count)
          : defaultCount;
      // Direction colors still receive the global opacity multiplier.
      const directionColorRaw = normalizeOptionalColor(direction.color);
      const directionColor =
        directionColorRaw != null ? applyOpacity(directionColorRaw, globalOpacity) : resolvedGlobalColor;
      return {
        show: directionShow,
        count: directionCount,
        color: directionColor,
      };
    };

    return {
      show: globalShow,
      color: resolvedGlobalColor,
      opacity: globalOpacity,
      horizontal: resolveDirection(input?.horizontal, defaultGridLines.horizontal.count),
      vertical: resolveDirection(input?.vertical, defaultGridLines.vertical.count),
    };
  };

  const gridLines = resolveGridLines(userOptions.gridLines, theme);

  const xAxis: AxisConfig = userOptions.xAxis
    ? {
        ...defaultOptions.xAxis,
        ...userOptions.xAxis,
        // runtime safety for JS callers
        type: (userOptions.xAxis as unknown as Partial<AxisConfig>).type ?? defaultOptions.xAxis.type,
        autoBounds:
          normalizeAxisAutoBounds((userOptions.xAxis as unknown as { readonly autoBounds?: unknown }).autoBounds) ??
          (defaultOptions.xAxis as AxisConfig).autoBounds,
      }
    : { ...defaultOptions.xAxis };

  const yAxes: AxisConfig[] = [];
  if (userOptions.axes?.y && userOptions.axes.y.length > 0) {
    for (let index = 0; index < userOptions.axes.y.length; index++) {
      const yConfig = userOptions.axes.y[index]!;
      yAxes.push({
        ...defaultOptions.yAxis,
        ...yConfig,
        id: yConfig.id ?? (index === 0 ? 'y' : `y${index}`),
        position: yConfig.position ?? 'left',
        type: yConfig.type ?? defaultOptions.yAxis.type,
        autoBounds:
          normalizeAxisAutoBounds((yConfig as unknown as { readonly autoBounds?: unknown }).autoBounds) ??
          defaultOptions.yAxis.autoBounds,
      });
    }
  } else {
    yAxes.push(
      userOptions.yAxis
        ? {
            ...defaultOptions.yAxis,
            ...userOptions.yAxis,
            id: userOptions.yAxis.id ?? 'y',
            position: userOptions.yAxis.position ?? 'left',
            type: (userOptions.yAxis as unknown as Partial<AxisConfig>).type ?? defaultOptions.yAxis.type,
            autoBounds:
              normalizeAxisAutoBounds((userOptions.yAxis as unknown as { readonly autoBounds?: unknown }).autoBounds) ??
              defaultOptions.yAxis.autoBounds,
          }
        : { ...defaultOptions.yAxis, id: 'y', position: 'left' }
    );
  }

  const defaultYAxisId = yAxes[0]!.id ?? 'y';

  // When all axis domains are explicit, rawBounds is unused for scale derivation.
  // Skip O(n) bounds scans on full-series rewrite frames with fixed axes.
  // When only Y is explicit, only scan X extent.
  const finiteAxisBound = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const xFullyExplicit = finiteAxisBound(xAxis.min) && finiteAxisBound(xAxis.max);
  const yFullyExplicit = yAxes.length > 0 && yAxes.every((ax) => finiteAxisBound(ax.min) && finiteAxisBound(ax.max));
  const axesFullyExplicit = xFullyExplicit && yFullyExplicit;
  const syntheticAxisBounds: RawBounds | undefined = axesFullyExplicit
    ? {
        xMin: xAxis.min as number,
        xMax: xAxis.max as number,
        yMin: yAxes[0]!.min as number,
        yMax: yAxes[0]!.max as number,
      }
    : undefined;
  const yAxisSynthetic = yFullyExplicit
    ? {
        yMin: yAxes[0]!.min as number,
        yMax: yAxes[0]!.max as number,
      }
    : undefined;

  /**
   * Resolve rawBounds with an explicit mode tag so axes switching explicit→auto
   * under a stable data ref cannot keep synthetic extents (Bug: sticky bounds).
   */
  const resolveCartesianBounds = (
    reusePrev:
      | {
          readonly rawBounds?: RawBounds;
          readonly rawBoundsMode?: RawBoundsMode;
        }
      | null
      | undefined,
    data: import('../config/types').CartesianSeriesData,
    sampleReusable: boolean,
    opts?: Readonly<{
      /** Skip full isIndexSortedX — caller already sticky/full-proved x=i at this N. */
      readonly trustIndexSorted?: boolean;
    }>
  ): { bounds: RawBounds | undefined; mode: RawBoundsMode; indexSortedHit?: boolean } => {
    if (syntheticAxisBounds) {
      return { bounds: syntheticAxisBounds, mode: 'synthetic' };
    }
    if (yAxisSynthetic) {
      // Reuse only when previous resolve used the same mode + same raw data.
      if (sampleReusable && reusePrev?.rawBoundsMode === 'xDataYAxis' && reusePrev.rawBounds) {
        return {
          bounds: {
            xMin: reusePrev.rawBounds.xMin,
            xMax: reusePrev.rawBounds.xMax,
            yMin: yAxisSynthetic.yMin,
            yMax: yAxisSynthetic.yMax,
          },
          mode: 'xDataYAxis',
        };
      }
      // Index-sorted x (x=i): full O(n) once, or sticky trust.
      // Fail-fast on non-index data, then full x scan.
      let xMin: number;
      let xMax: number;
      let indexSortedHit = false;
      if (opts?.trustIndexSorted || isIndexSortedX(data)) {
        const n = getPointCount(data);
        xMin = 0;
        xMax = Math.max(1, n - 1);
        indexSortedHit = true;
      } else {
        const xExt = computeRawXExtentFromCartesianData(data);
        if (!xExt) return { bounds: undefined, mode: 'xDataYAxis' };
        xMin = xExt.xMin;
        xMax = xExt.xMax;
      }
      return {
        bounds: {
          xMin,
          xMax,
          yMin: yAxisSynthetic.yMin,
          yMax: yAxisSynthetic.yMax,
        },
        mode: 'xDataYAxis',
        indexSortedHit,
      };
    }
    // Full data-driven: only reuse when prior mode was also data-driven.
    if (sampleReusable && reusePrev?.rawBoundsMode === 'data' && reusePrev.rawBounds) {
      return { bounds: reusePrev.rawBounds, mode: 'data' };
    }
    return {
      bounds: computeRawBoundsFromCartesianData(data) ?? undefined,
      mode: 'data',
    };
  };

  // Group-1 axes-only: same series elements + theme/palette → reuse prior resolved
  // series wholesale (no per-series object allocation). Requires per-element identity
  // (and element snapshot when outer array is stable) so series[i]=… is not ignored.
  const prevUser = reuse?.previousUserOptions;
  const canReuseEntireSeriesArray = canReuseEntireUserSeriesArray({
    previousResolvedSeries: previousSeries,
    previousUserOptions: prevUser,
    userOptions,
    lastUserSeriesElements: reuse?.lastUserSeriesElements,
  });

  const series: ReadonlyArray<ResolvedSeriesConfig> = canReuseEntireSeriesArray
    ? previousSeries!
    : (userOptions.series ?? []).map((s, i) => {
        const explicitColor = normalizeOptionalColor(s.color);
        const inheritedColor = theme.colorPalette[i % theme.colorPalette.length];
        const color = explicitColor ?? inheritedColor;
        const prevResolved = previousSeries?.[i];

        // Ensure visible defaults to true (converts undefined to true, preserves explicit false)
        const visible = s.visible !== false;

        const sampling: SeriesSampling = normalizeSampling((s as unknown as { sampling?: unknown }).sampling) ?? 'lttb';
        const samplingThreshold: number =
          normalizeSamplingThreshold((s as unknown as { samplingThreshold?: unknown }).samplingThreshold) ?? 5000;

        const yAxis = s.yAxis ?? defaultYAxisId;

        switch (s.type) {
          case 'area': {
            // Resolve effective fill color with precedence: areaStyle.color → series.color → palette
            const areaStyleColor = normalizeOptionalColor(s.areaStyle?.color);
            const effectiveColor = areaStyleColor ?? explicitColor ?? inheritedColor;

            const areaStyle: ResolvedAreaStyleConfig = {
              opacity: s.areaStyle?.opacity ?? defaultAreaStyle.opacity,
              color: effectiveColor,
            };

            const connectNulls = s.connectNulls ?? false;
            const contentHash = resolveSeriesContentHash(prevResolved, 'area', s.data, () =>
              cheapCartesianContentStamp(s.data)
            );
            const reuseSample = canReuseResolvedSeriesSample(
              prevResolved,
              'area',
              s.data,
              sampling,
              samplingThreshold,
              connectNulls,
              contentHash
            );
            const prevArea = reuseSample
              ? (prevResolved as ResolvedAreaSeriesConfig & {
                  contentHash?: number;
                  rawBoundsMode?: RawBoundsMode;
                })
              : null;
            const { bounds: rawBounds, mode: rawBoundsMode } = resolveCartesianBounds(prevArea, s.data, reuseSample);
            // Bypass sampling when data contains null gap markers to preserve gap structure.
            // sampling:'none' already returns data as-is — skip O(n) hasNullGaps.
            const sampledAreaData = prevArea
              ? prevArea.data
              : sampling === 'none' || hasNullGaps(s.data)
                ? s.data
                : sampleSeriesDataPoints(s.data, sampling, samplingThreshold);
            return {
              ...s,
              visible,
              rawData: s.data,
              data: sampledAreaData,
              color: effectiveColor,
              areaStyle,
              sampling,
              samplingThreshold,
              rawBounds,
              rawBoundsMode,
              connectNulls,
              yAxis,
              contentHash,
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
            const connectNulls = s.connectNulls ?? false;
            const contentHash = resolveSeriesContentHash(prevResolved, 'line', s.data, () =>
              cheapCartesianContentStamp(s.data)
            );
            const reuseSample = canReuseResolvedSeriesSample(
              prevResolved,
              'line',
              s.data,
              sampling,
              samplingThreshold,
              connectNulls,
              contentHash
            );
            const prevLine = reuseSample
              ? (prevResolved as ResolvedLineSeriesConfig & {
                  contentHash?: number;
                  rawBoundsMode?: RawBoundsMode;
                })
              : null;
            const { bounds: rawBounds, mode: rawBoundsMode } = resolveCartesianBounds(prevLine, s.data, reuseSample);
            // Bypass sampling when data contains null gap markers to preserve gap structure.
            // sampling:'none' already returns data as-is — skip O(n) hasNullGaps.
            const sampledData = prevLine
              ? prevLine.data
              : sampling === 'none' || hasNullGaps(s.data)
                ? s.data
                : sampleSeriesDataPoints(s.data, sampling, samplingThreshold);

            return {
              ...rest,
              visible,
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
              rawBoundsMode,
              connectNulls,
              yAxis,
              contentHash,
            };
          }
          case 'bar': {
            const contentHash = resolveSeriesContentHash(prevResolved, 'bar', s.data, () =>
              cheapCartesianContentStamp(s.data)
            );
            const reuseSample = canReuseResolvedSeriesSample(
              prevResolved,
              'bar',
              s.data,
              sampling,
              samplingThreshold,
              undefined,
              contentHash
            );
            const prevBar = reuseSample
              ? (prevResolved as ResolvedBarSeriesConfig & {
                  contentHash?: number;
                  rawBoundsMode?: RawBoundsMode;
                })
              : null;
            const { bounds: rawBounds, mode: rawBoundsMode } = resolveCartesianBounds(prevBar, s.data, reuseSample);
            return {
              ...s,
              visible,
              rawData: s.data,
              data: prevBar ? prevBar.data : sampleSeriesDataPoints(s.data, sampling, samplingThreshold),
              color,
              sampling,
              samplingThreshold,
              rawBounds,
              rawBoundsMode,
              yAxis,
              contentHash,
            };
          }
          case 'scatter': {
            const contentHash = resolveSeriesContentHash(prevResolved, 'scatter', s.data, () =>
              cheapCartesianContentStamp(s.data)
            );
            const reuseSample = canReuseResolvedSeriesSample(
              prevResolved,
              'scatter',
              s.data,
              sampling,
              samplingThreshold,
              undefined,
              contentHash
            );
            const prevScatterResolved =
              prevResolved?.type === 'scatter' ? (prevResolved as ResolvedScatterSeriesConfig) : null;
            const prevScatter = reuseSample
              ? (prevResolved as ResolvedScatterSeriesConfig & {
                  contentHash?: number;
                  rawBoundsMode?: RawBoundsMode;
                })
              : null;
            const rawPointCount = getPointCount(s.data);
            // Sticky index-sorted proof: prior frame fully proved x=i at this N.
            const stickyIndexSorted =
              prevScatterResolved?.indexSortedProven === true &&
              prevScatterResolved.indexSortedPointCount === rawPointCount;

            // Equal-N y-only + index-sorted under **LTTB** (group 4): re-bind y at
            // prior sample x indices in O(k) instead of full O(N) LTTB. Requires
            // matching sampling + threshold (same gate as canReuseResolvedSeriesSample).
            // min/max/average always re-sample (bucket extrema depend on y).
            // Brownian xy (group 2) fails classifyEqualNYOnlyRewrite → full path.
            // Classify before bounds so sticky/full proof is shared (one O(n) max cold).
            // performance.lod === 'strict': full LTTB on every y change (issue 2.3 C).
            let sampledData: CartesianSeriesData;
            /** True when this frame still has a valid index-sorted proof (sticky or cold). */
            let indexSortedThisFrame = false;
            let indexSortedFp: number | undefined =
              stickyIndexSorted && prevScatterResolved?.indexSortedFingerprint !== undefined
                ? prevScatterResolved.indexSortedFingerprint
                : undefined;
            if (prevScatter) {
              sampledData = prevScatter.data;
              // Identity-reuse: keep prior sticky proof when present.
              indexSortedThisFrame = stickyIndexSorted;
            } else if (
              sampling === 'lttb' &&
              prevScatterResolved &&
              prevScatterResolved.sampling === 'lttb' &&
              prevScatterResolved.samplingThreshold === samplingThreshold
            ) {
              const yOnlyKind = classifyEqualNYOnlyRewrite(prevScatterResolved.rawData as CartesianSeriesData, s.data, {
                prevIndexSortedProven: stickyIndexSorted,
                prevIndexSortedFingerprint: prevScatterResolved.indexSortedFingerprint,
              });
              if (yOnlyKind === 'indexSorted') {
                indexSortedThisFrame = true;
                indexSortedFp = indexSortedXFingerprint(s.data);
                if (forceFullLttbOnEqualN) {
                  // Strict LOD: plain LTTB always full recompute on y change.
                  sampledData = sampleSeriesDataPoints(s.data, sampling, samplingThreshold);
                } else {
                  const remapped = remapIndexSortedSampleY(prevScatterResolved.data as CartesianSeriesData, s.data);
                  sampledData = remapped ?? sampleSeriesDataPoints(s.data, sampling, samplingThreshold);
                }
              } else {
                // Clears sticky for this frame (Brownian / equalX) — do not trustIndexSorted.
                sampledData = sampleSeriesDataPoints(s.data, sampling, samplingThreshold);
              }
            } else if (stickyIndexSorted && sampleLooksIndexSortedX(s.data)) {
              // Non-LTTB equal-N stream (e.g. sampling:'none'): keep sticky for bounds O(1).
              // Still require fingerprint continuity (issue 1.6).
              const nextFp = indexSortedXFingerprint(s.data);
              const prevFp =
                prevScatterResolved?.indexSortedFingerprint ??
                (prevScatterResolved?.rawData != null
                  ? indexSortedXFingerprint(prevScatterResolved.rawData as CartesianSeriesData)
                  : nextFp);
              if (nextFp === prevFp) {
                indexSortedThisFrame = true;
                indexSortedFp = nextFp;
              }
              sampledData = sampleSeriesDataPoints(s.data, sampling, samplingThreshold);
            } else {
              sampledData = sampleSeriesDataPoints(s.data, sampling, samplingThreshold);
              // Cold first frame (no sticky / no LTTB remap prev): one full O(n) proof so
              // subsequent equal-N frames can sticky-skip. Cheap sample reject first.
              if (sampleLooksIndexSortedX(s.data) && isIndexSortedX(s.data)) {
                indexSortedThisFrame = true;
                indexSortedFp = indexSortedXFingerprint(s.data);
              }
            }

            const {
              bounds: rawBounds,
              mode: rawBoundsMode,
              indexSortedHit,
            } = resolveCartesianBounds(prevScatter, s.data, reuseSample, {
              // Only trust when this frame re-validated sticky or cold-proved — never
              // after classify rejected (Brownian).
              trustIndexSorted: indexSortedThisFrame,
            });

            const indexSortedProven = Boolean(indexSortedThisFrame || indexSortedHit);
            if (indexSortedProven && indexSortedFp === undefined) {
              indexSortedFp = indexSortedXFingerprint(s.data);
            }
            const mode =
              normalizeScatterMode((s as unknown as { readonly mode?: unknown }).mode) ?? scatterDefaults.mode;
            const binSize =
              normalizeDensityBinSize((s as unknown as { readonly binSize?: unknown }).binSize) ??
              scatterDefaults.binSize;
            const densityColormap =
              normalizeDensityColormap((s as unknown as { readonly densityColormap?: unknown }).densityColormap) ??
              scatterDefaults.densityColormap;
            const densityNormalization =
              normalizeDensityNormalization(
                (s as unknown as { readonly densityNormalization?: unknown }).densityNormalization
              ) ?? scatterDefaults.densityNormalization;

            return {
              ...s,
              visible,
              rawData: s.data,
              data: sampledData,
              color,
              mode,
              binSize,
              densityColormap,
              densityNormalization,
              sampling,
              samplingThreshold,
              rawBounds,
              rawBoundsMode,
              yAxis,
              contentHash,
              ...(indexSortedProven
                ? {
                    indexSortedProven: true as const,
                    indexSortedPointCount: rawPointCount,
                    ...(indexSortedFp !== undefined ? { indexSortedFingerprint: indexSortedFp } : {}),
                  }
                : {}),
            };
          }
          case 'pie': {
            // Pie series intentionally do NOT support sampling at runtime.
            // For JS callers, strip any extra sampling keys so they don't leak through the resolver.
            const {
              sampling: _sampling,
              samplingThreshold: _samplingThreshold,
              ...rest
            } = s as PieSeriesConfig & {
              readonly sampling?: unknown;
              readonly samplingThreshold?: unknown;
            };

            const resolvedData: ReadonlyArray<ResolvedPieDataItem> = (s.data ?? []).map((item, itemIndex) => {
              const itemColor = normalizeOptionalColor(item?.color);
              const fallback = theme.colorPalette[(i + itemIndex) % theme.colorPalette.length];
              // Ensure visible defaults to true (converts undefined to true, preserves explicit false)
              const itemVisible = item?.visible !== false;
              return {
                ...item,
                color: itemColor ?? fallback,
                visible: itemVisible,
              };
            });

            return { ...rest, visible, color, data: resolvedData };
          }
          case 'candlestick': {
            warnCandlestickNotImplemented();

            const resolvedSampling: 'none' | 'ohlc' =
              normalizeCandlestickSampling((s as unknown as { sampling?: unknown }).sampling) ??
              candlestickDefaults.sampling;

            const resolvedSamplingThreshold: number =
              normalizeSamplingThreshold((s as unknown as { samplingThreshold?: unknown }).samplingThreshold) ??
              candlestickDefaults.samplingThreshold;

            const resolvedItemStyle: ResolvedCandlestickItemStyleConfig = {
              upColor: normalizeOptionalColor(s.itemStyle?.upColor) ?? candlestickDefaults.itemStyle.upColor,
              downColor: normalizeOptionalColor(s.itemStyle?.downColor) ?? candlestickDefaults.itemStyle.downColor,
              upBorderColor:
                normalizeOptionalColor(s.itemStyle?.upBorderColor) ?? candlestickDefaults.itemStyle.upBorderColor,
              downBorderColor:
                normalizeOptionalColor(s.itemStyle?.downBorderColor) ?? candlestickDefaults.itemStyle.downBorderColor,
              borderWidth:
                typeof s.itemStyle?.borderWidth === 'number' && Number.isFinite(s.itemStyle.borderWidth)
                  ? s.itemStyle.borderWidth
                  : candlestickDefaults.itemStyle.borderWidth,
            };

            const contentHash = resolveSeriesContentHash(prevResolved, 'candlestick', s.data, () =>
              cheapOHLCContentStamp(s.data)
            );
            const reuseCandle = canReuseResolvedSeriesSample(
              prevResolved,
              'candlestick',
              s.data,
              resolvedSampling,
              resolvedSamplingThreshold,
              undefined,
              contentHash
            );
            const prevCandle = reuseCandle
              ? (prevResolved as ResolvedCandlestickSeriesConfig & {
                  contentHash?: number;
                })
              : null;
            const rawBounds = prevCandle?.rawBounds ?? computeRawBoundsFromOHLC(s.data);

            const sampledData = prevCandle
              ? prevCandle.data
              : resolvedSampling === 'ohlc' && s.data.length > resolvedSamplingThreshold
                ? ohlcSample(s.data, resolvedSamplingThreshold)
                : s.data;

            return {
              ...s,
              visible,
              rawData: s.data,
              data: sampledData,
              color,
              style: s.style ?? candlestickDefaults.style,
              itemStyle: resolvedItemStyle,
              barWidth: s.barWidth ?? candlestickDefaults.barWidth,
              barMinWidth: s.barMinWidth ?? candlestickDefaults.barMinWidth,
              barMaxWidth: s.barMaxWidth ?? candlestickDefaults.barMaxWidth,
              sampling: resolvedSampling,
              samplingThreshold: resolvedSamplingThreshold,
              rawBounds,
              yAxis,
              contentHash,
            };
          }
          default: {
            return assertUnreachable(s);
          }
        }
      });

  return {
    grid,
    gridLines,
    xAxis,
    yAxes,
    autoScroll,
    dataZoom: sanitizeDataZoom((userOptions as ChartGPUOptions).dataZoom),
    annotations: sanitizeAnnotations((userOptions as ChartGPUOptions).annotations),
    animation,
    theme,
    palette: theme.colorPalette,
    series,
    legend: userOptions.legend,
    // Default true (4× MSAA). Explicit false → sampleCount 1 for multi-chart fill/memory.
    antialias: userOptions.antialias !== false,
    performance,
  };
}

/**
 * Data zoom slider dimensions (CSS pixels).
 *
 * Note: these are internal implementation details used to reserve chart space for the
 * slider overlay. We intentionally do not re-export them from the public entrypoint.
 */
const DATA_ZOOM_SLIDER_HEIGHT_CSS_PX = 32;
const DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX = 8;
const DATA_ZOOM_SLIDER_RESERVE_CSS_PX = DATA_ZOOM_SLIDER_HEIGHT_CSS_PX + DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX;

/**
 * Checks if options include a slider-type dataZoom configuration.
 *
 * @param options - Chart options to check
 * @returns True if slider dataZoom exists
 */
const hasSliderDataZoom = (options: ChartGPUOptions): boolean =>
  options.dataZoom?.some((z) => z?.type === 'slider') ?? false;

/**
 * Resolves chart options with slider bottom-space reservation.
 *
 * This function wraps `resolveOptions()` and applies additional grid bottom spacing
 * when a slider-type dataZoom is configured. The reservation ensures x-axis labels
 * and ticks are visible above the slider overlay.
 *
 * **Usage**: Use this function instead of `resolveOptions()` when creating charts
 * to ensure consistent slider layout.
 *
 * @param userOptions - User-provided chart options
 * @returns Resolved options with slider bottom-space applied if needed
 */
export function resolveOptionsForChart(
  userOptions: ChartGPUOptions = {},
  reuse?: ResolveOptionsReuse
): ResolvedChartGPUOptions {
  const base: ResolvedChartGPUOptions = {
    ...resolveOptions(userOptions, reuse),
    tooltip: userOptions.tooltip,
  };
  if (!hasSliderDataZoom(userOptions)) return base;
  return {
    ...base,
    grid: {
      ...base.grid,
      bottom: base.grid.bottom + DATA_ZOOM_SLIDER_RESERVE_CSS_PX,
    },
  };
}

export const OptionResolver = { resolve: resolveOptions } as const;
