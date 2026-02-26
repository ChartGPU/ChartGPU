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
import { computeRawBoundsFromCartesianData, hasNullGaps } from '../data/cartesianData';
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

export type RawBounds = Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;

export type ResolvedLineSeriesConfig = Readonly<
  Omit<LineSeriesConfig, 'color' | 'lineStyle' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data' | 'connectNulls'> & {
    readonly connectNulls: boolean;
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
  Omit<AreaSeriesConfig, 'color' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data' | 'connectNulls'> & {
    readonly connectNulls: boolean;
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
  Omit<
    ScatterSeriesConfig,
    'color' | 'sampling' | 'samplingThreshold' | 'data' | 'mode' | 'binSize' | 'densityColormap' | 'densityNormalization'
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
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
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
  Omit<CandlestickSeriesConfig, 'color' | 'style' | 'itemStyle' | 'barWidth' | 'barMinWidth' | 'barMaxWidth' | 'sampling' | 'samplingThreshold' | 'data'> & {
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
    /**
     * Bounds computed from the original (unsampled) data. Used for axis auto-bounds so sampling
     * cannot clip outliers.
     */
    readonly rawBounds?: RawBounds;
  }
>;

export type ResolvedSeriesConfig =
  | ResolvedLineSeriesConfig
  | ResolvedAreaSeriesConfig
  | ResolvedBarSeriesConfig
  | ResolvedScatterSeriesConfig
  | ResolvedPieSeriesConfig
  | ResolvedCandlestickSeriesConfig;

export interface ResolvedChartGPUOptions
  extends Omit<ChartGPUOptions, 'grid' | 'gridLines' | 'xAxis' | 'yAxis' | 'theme' | 'palette' | 'series' | 'legend'> {
  readonly grid: ResolvedGridConfig;
  readonly gridLines: ResolvedGridLinesConfig;
  readonly xAxis: AxisConfig;
  readonly yAxis: AxisConfig;
  readonly autoScroll: boolean;
  readonly theme: ThemeConfig;
  readonly palette: ReadonlyArray<string>;
  readonly series: ReadonlyArray<ResolvedSeriesConfig>;
  readonly annotations?: ReadonlyArray<AnnotationConfig>;
  readonly legend?: import('./types').LegendConfig;
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

const sanitizeAnnotations = (input: unknown): ReadonlyArray<AnnotationConfig> | undefined => {
  if (!Array.isArray(input)) return undefined;

  const out: AnnotationConfig[] = [];

  const isLabelAnchor = (v: unknown): v is AnnotationLabelAnchor =>
    v === 'start' || v === 'center' || v === 'end';

  const isScatterSymbol = (v: unknown): v is ScatterSymbol =>
    v === 'circle' || v === 'rect' || v === 'triangle';

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
    const cleaned = v
      .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
      .map((x) => x);
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
    if (type !== 'lineX' && type !== 'lineY' && type !== 'point' && type !== 'text') continue;

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

    if (type === 'lineX') {
      const x = sanitizeFiniteNumber(record.x);
      if (x == null) continue;
      const base: AnnotationConfig = { type: 'lineX', x, ...(id ? { id } : {}), ...(layer ? { layer } : {}), ...(style ? { style } : {}), ...(label ? { label } : {}) };
      out.push(base);
      continue;
    }

    if (type === 'lineY') {
      const y = sanitizeFiniteNumber(record.y);
      if (y == null) continue;
      const base: AnnotationConfig = { type: 'lineY', y, ...(id ? { id } : {}), ...(layer ? { layer } : {}), ...(style ? { style } : {}), ...(label ? { label } : {}) };
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

const normalizeDensityColormap = (
  value: unknown
): NonNullable<ScatterSeriesConfig['densityColormap']> | undefined => {
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
    `Unhandled series type: ${
      (value as unknown as { readonly type?: unknown } | null)?.type ?? 'unknown'
    }`
  );
};

let candlestickWarned = false;
const warnCandlestickNotImplemented = (): void => {
  if (!candlestickWarned) {
    console.warn(
      'ChartGPU: Candlestick series rendering is not yet implemented. Series will be skipped.'
    );
    candlestickWarned = true;
  }
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

  // Resolve grid lines configuration with color hierarchy:
  // 1. per-direction color (horizontal.color / vertical.color)
  // 2. gridLines.color
  // 3. theme.gridLineColor
  const resolveGridLines = (
    input: GridLinesConfig | undefined,
    theme: ThemeConfig
  ): ResolvedGridLinesConfig => {
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
        return { show: globalShow, count: defaultCount, color: resolvedGlobalColor };
      }
      // Object config
      const directionShow = direction.show !== false && globalShow; // respect global show
      const directionCount =
        typeof direction.count === 'number' && Number.isFinite(direction.count) && direction.count >= 0
          ? Math.floor(direction.count)
          : defaultCount;
      // Direction colors still receive the global opacity multiplier.
      const directionColorRaw = normalizeOptionalColor(direction.color);
      const directionColor = directionColorRaw != null ? applyOpacity(directionColorRaw, globalOpacity) : resolvedGlobalColor;
      return { show: directionShow, count: directionCount, color: directionColor };
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

  const yAxis: AxisConfig = userOptions.yAxis
    ? {
        ...defaultOptions.yAxis,
        ...userOptions.yAxis,
        // runtime safety for JS callers
        type: (userOptions.yAxis as unknown as Partial<AxisConfig>).type ?? defaultOptions.yAxis.type,
        autoBounds:
          normalizeAxisAutoBounds((userOptions.yAxis as unknown as { readonly autoBounds?: unknown }).autoBounds) ??
          defaultOptions.yAxis.autoBounds,
      }
    : { ...defaultOptions.yAxis };

  const series: ReadonlyArray<ResolvedSeriesConfig> = (userOptions.series ?? []).map((s, i) => {
    const explicitColor = normalizeOptionalColor(s.color);
    const inheritedColor = theme.colorPalette[i % theme.colorPalette.length];
    const color = explicitColor ?? inheritedColor;

    // Ensure visible defaults to true (converts undefined to true, preserves explicit false)
    const visible = s.visible !== false;

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

        const rawBounds = computeRawBoundsFromCartesianData(s.data) ?? undefined;
        // Bypass sampling when data contains null gap markers to preserve gap structure
        const sampledAreaData = hasNullGaps(s.data)
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
          connectNulls: s.connectNulls ?? false,
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
        const rawBounds = computeRawBoundsFromCartesianData(s.data) ?? undefined;
        // Bypass sampling when data contains null gap markers to preserve gap structure
        const sampledData = hasNullGaps(s.data)
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
          connectNulls: s.connectNulls ?? false,
        };
      }
      case 'bar': {
        const rawBounds = computeRawBoundsFromCartesianData(s.data) ?? undefined;
        return {
          ...s,
          visible,
          rawData: s.data,
          data: sampleSeriesDataPoints(s.data, sampling, samplingThreshold),
          color,
          sampling,
          samplingThreshold,
          rawBounds,
        };
      }
      case 'scatter': {
        const rawBounds = computeRawBoundsFromCartesianData(s.data) ?? undefined;
        const mode =
          normalizeScatterMode((s as unknown as { readonly mode?: unknown }).mode) ?? scatterDefaults.mode;
        const binSize =
          normalizeDensityBinSize((s as unknown as { readonly binSize?: unknown }).binSize) ?? scatterDefaults.binSize;
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
          data: sampleSeriesDataPoints(s.data, sampling, samplingThreshold),
          color,
          mode,
          binSize,
          densityColormap,
          densityNormalization,
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
          upBorderColor: normalizeOptionalColor(s.itemStyle?.upBorderColor) ?? candlestickDefaults.itemStyle.upBorderColor,
          downBorderColor: normalizeOptionalColor(s.itemStyle?.downBorderColor) ?? candlestickDefaults.itemStyle.downBorderColor,
          borderWidth: typeof s.itemStyle?.borderWidth === 'number' && Number.isFinite(s.itemStyle.borderWidth)
            ? s.itemStyle.borderWidth
            : candlestickDefaults.itemStyle.borderWidth,
        };

        const rawBounds = computeRawBoundsFromOHLC(s.data);

        const sampledData =
          resolvedSampling === 'ohlc' && s.data.length > resolvedSamplingThreshold
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
    yAxis,
    autoScroll,
    dataZoom: sanitizeDataZoom((userOptions as ChartGPUOptions).dataZoom),
    annotations: sanitizeAnnotations((userOptions as ChartGPUOptions).annotations),
    animation,
    theme,
    palette: theme.colorPalette,
    series,
    legend: userOptions.legend,
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
const DATA_ZOOM_SLIDER_RESERVE_CSS_PX =
  DATA_ZOOM_SLIDER_HEIGHT_CSS_PX + DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX;

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
export function resolveOptionsForChart(userOptions: ChartGPUOptions = {}): ResolvedChartGPUOptions {
  const base: ResolvedChartGPUOptions = { ...resolveOptions(userOptions), tooltip: userOptions.tooltip };
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

