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
  OhlcSeriesConfig,
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
  HeatmapSeriesConfig,
  HeatmapData,
  HeatmapColormap,
  HeatmapNullHandling,
  BandSeriesConfig,
  BandSeriesData,
  ErrorBarSeriesConfig,
  ErrorBarSeriesData,
  ErrorBarHlcArraysData,
  ErrorBarMode,
  ErrorBarDirection,
  ImpulseSeriesConfig,
  StepMode,
  CoordinateSystem,
  Chart3DCameraOptions,
  Interaction3DOptions,
  Axes3DOptions,
  PointCloud3DSeriesConfig,
  PointCloud3DData,
  Surface3DSeriesConfig,
  Surface3DGridData,
} from './types';
import {
  candlePrimaryGridDefaults,
  candlestickDefaults,
  ohlcDefaults,
  errorBarDefaults,
  impulseDefaults,
  defaultAreaStyle,
  defaultGridLines,
  defaultLineStyle,
  defaultOptions,
  defaultPalette,
  scatterDefaults,
  heatmapDefaults,
  pointCloud3dDefaults,
  surface3dDefaults,
  camera3dDefaults,
  interaction3dDefaults,
  axes3dDefaults,
} from './defaults';
import { isNamedColormap } from '../utils/colormap';
import {
  computeHeatmapZExtent,
  heatmapGridBounds,
  sanitizeHeatmapGeometry,
  type HeatmapCellAnchor,
} from '../utils/heatmapLayout';
import { isCandlePrimaryChart } from './isCandlePrimaryChart';
import { resolvePriceLabel, type ResolvedCandlestickPriceLabel } from './resolvePriceLabel';
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
import {
  computeStackedAreaBaselines,
  computeStackedYExtents,
  groupStackedMountainLayers,
  isStackedMountainSeries,
  normalizeStackId,
} from '../data/stackedArea';
import { bandBounds, cheapBandContentStamp, getBandLength, hasBandNullGaps, sampleBandSeries } from '../data/bandData';
import {
  cheapErrorBarContentStamp,
  errorBarBounds,
  getErrorBarLength,
  resolveErrorBarToHlc,
} from '../data/errorBarData';
import { impulseBounds } from '../data/impulseGeometry';
import { isInvalidStepValue, resolveStepMode } from '../data/stepGeometry';

export type { ResolvedCandlestickPriceLabel } from './resolvePriceLabel';
export { resolvePriceLabel } from './resolvePriceLabel';
export { isCandlePrimaryChart, isFinanceOhlcSeriesType, isFinanceOhlcSeries } from './isCandlePrimaryChart';
export type { FinanceOhlcSeriesType } from './isCandlePrimaryChart';
import { cheapCartesianContentStamp, cheapOHLCContentStamp } from '../data/seriesContentHash';
import {
  classifyEqualNYOnlyRewrite,
  indexSortedXFingerprint,
  isIndexSortedX,
  remapIndexSortedSampleY,
  sampleLooksIndexSortedX,
} from '../data/seriesRewriteDetect';
import { parseCssColorToRgba01 } from '../utils/colors';
import { pointCloud3dHasDrawableSample } from '../data/pointCloud3dData';

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

export type ResolvedHeatmapSeriesConfig = Readonly<
  Omit<
    HeatmapSeriesConfig,
    'data' | 'colormap' | 'zMin' | 'zMax' | 'zScale' | 'opacity' | 'cellAnchor' | 'nullHandling' | 'cellGapPx' | 'color'
  > & {
    readonly type: 'heatmap';
    readonly data: HeatmapData;
    readonly colormap: HeatmapColormap;
    readonly zMin: number;
    readonly zMax: number;
    /**
     * True when the user supplied **both** finite `zMin` and `zMax` on the series config.
     * Stream append must keep this fixed colormap domain (no auto expand-from-strip).
     */
    readonly zDomainExplicit: boolean;
    readonly zScale: 'linear' | 'log';
    readonly opacity: number;
    readonly cellAnchor: HeatmapCellAnchor;
    readonly nullHandling: HeatmapNullHandling;
    readonly cellGapPx: number;
    /** Palette fallback for legend/tooltip; not used for cell coloring. */
    readonly color: string;
    readonly yAxis: string;
    /**
     * Grid extent in data space for axis auto-bounds.
     * Always set for valid geometry; omitted only when series is empty/invalid.
     */
    readonly rawBounds?: RawBounds;
    /**
     * When false, renderer should skip draw (invalid geometry or empty drawCells).
     */
    readonly drawable: boolean;
    /** Expected cells = columns * rows after coercion. */
    readonly cellCount: number;
  }
>;

export type ResolvedBandSeriesConfig = Readonly<
  Omit<
    BandSeriesConfig,
    'color' | 'lineStyle' | 'lineStyleY1' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data' | 'connectNulls'
  > & {
    readonly type: 'band';
    readonly connectNulls: boolean;
    readonly color: string;
    /**
     * Stroke for y curve. **Undefined when user omitted `lineStyle`** (fill-only).
     * When present, width defaults to 1; width 0 / opacity 0 also hides.
     */
    readonly lineStyle?: ResolvedLineStyleConfig;
    /** Stroke for y1 curve; undefined when user omitted lineStyleY1. */
    readonly lineStyleY1?: ResolvedLineStyleConfig;
    readonly areaStyle: ResolvedAreaStyleConfig;
    readonly sampling: Exclude<SeriesSampling, 'ohlc'>;
    readonly samplingThreshold: number;
    readonly rawData: BandSeriesData;
    readonly data: BandSeriesData;
    readonly yAxis: string;
    readonly rawBounds?: RawBounds;
    /** @internal How rawBounds was derived. */
    readonly rawBoundsMode?: RawBoundsMode;
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
    | 'priceLabel'
  > & {
    readonly color: string;
    readonly style: CandlestickStyle;
    readonly itemStyle: ResolvedCandlestickItemStyleConfig;
    readonly barWidth: number | string;
    readonly barMinWidth: number;
    readonly barMaxWidth: number;
    readonly sampling: 'none' | 'ohlc';
    readonly samplingThreshold: number;
    /** Resolved last-price badge / line (always attached on the non-reuse path). */
    readonly priceLabel: ResolvedCandlestickPriceLabel;
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

/** Resolved thin OHLC bar series (shared itemStyle / sampling / priceLabel with candlestick). */
export type ResolvedOhlcSeriesConfig = Readonly<
  Omit<
    OhlcSeriesConfig,
    | 'color'
    | 'itemStyle'
    | 'barWidth'
    | 'barMinWidth'
    | 'barMaxWidth'
    | 'stemWidth'
    | 'tickLength'
    | 'sampling'
    | 'samplingThreshold'
    | 'data'
    | 'priceLabel'
  > & {
    readonly color: string;
    readonly itemStyle: ResolvedCandlestickItemStyleConfig;
    readonly barWidth: number | string;
    readonly barMinWidth: number;
    readonly barMaxWidth: number;
    readonly stemWidth: number;
    readonly tickLength: number | string;
    readonly sampling: 'none' | 'ohlc';
    readonly samplingThreshold: number;
    readonly priceLabel: ResolvedCandlestickPriceLabel;
    readonly rawData: Readonly<OhlcSeriesConfig['data']>;
    readonly data: Readonly<OhlcSeriesConfig['data']>;
    readonly yAxis: string;
    readonly rawBounds?: RawBounds;
    readonly rawBoundsMode?: RawBoundsMode;
  }
>;

export type ResolvedErrorBarItemStyleConfig = Readonly<{
  readonly color: string;
  readonly borderWidth: number;
  readonly opacity: number;
}>;

/** Resolved error-bar series — data is always owned absolute HLC columns. */
export type ResolvedErrorBarSeriesConfig = Readonly<{
  readonly type: 'errorBar';
  readonly name?: string;
  readonly visible: boolean;
  readonly color: string;
  readonly itemStyle: ResolvedErrorBarItemStyleConfig;
  readonly capWidth: number | string;
  readonly errorMode: ErrorBarMode;
  readonly direction: ErrorBarDirection;
  readonly drawWhiskers: boolean;
  readonly drawConnector: boolean;
  readonly showCenter: boolean;
  readonly symbolSize: number;
  readonly sampling: 'none';
  /** Original user payload (may be relative). */
  readonly rawData: ErrorBarSeriesData;
  /** Owned absolute HLC columns after relative→absolute resolve. */
  readonly data: ErrorBarHlcArraysData;
  readonly yAxis: string;
  readonly rawBounds?: RawBounds;
  readonly rawBoundsMode?: RawBoundsMode;
}>;

/** Resolved impulse / stem series — XY cartesian + baseline + stem style. */
export type ResolvedImpulseSeriesConfig = Readonly<{
  readonly type: 'impulse';
  readonly name?: string;
  readonly visible: boolean;
  readonly color: string;
  readonly baseline: number;
  readonly lineStyle: ResolvedLineStyleConfig;
  readonly showMarker: boolean;
  readonly symbolSize: number;
  /** Sampling is `'none'` only (sparse event series). */
  readonly sampling: 'none';
  readonly rawData: Readonly<ImpulseSeriesConfig['data']>;
  readonly data: Readonly<ImpulseSeriesConfig['data']>;
  readonly yAxis: string;
  readonly rawBounds?: RawBounds;
  readonly rawBoundsMode?: RawBoundsMode;
}>;

export type ResolvedPointCloud3DSeriesConfig = Readonly<{
  readonly type: 'pointCloud3d';
  readonly name?: string;
  readonly visible: boolean;
  readonly data: PointCloud3DData;
  readonly color: string;
  readonly pointStyle: Readonly<{
    readonly size: number;
    readonly color: string;
    readonly opacity: number;
  }>;
  readonly colorBy?: Readonly<{
    readonly values?: ArrayLike<number>;
    readonly colormap: HeatmapColormap;
    readonly min?: number;
    readonly max?: number;
  }>;
  /** False when empty / undrawable. */
  readonly drawable: boolean;
}>;

export type ResolvedSurface3DSeriesConfig = Readonly<{
  readonly type: 'surface3d';
  readonly name?: string;
  readonly visible: boolean;
  readonly data: Surface3DGridData;
  readonly colormap: HeatmapColormap;
  readonly yMin: number;
  readonly yMax: number;
  readonly wireframe: boolean;
  readonly opacity: number;
  readonly lighting: number;
  readonly color: string;
  readonly drawable: boolean;
  readonly contours: ResolvedSurface3DContours;
}>;

export type ResolvedSeriesConfig2D =
  | ResolvedLineSeriesConfig
  | ResolvedAreaSeriesConfig
  | ResolvedBarSeriesConfig
  | ResolvedScatterSeriesConfig
  | ResolvedPieSeriesConfig
  | ResolvedCandlestickSeriesConfig
  | ResolvedOhlcSeriesConfig
  | ResolvedHeatmapSeriesConfig
  | ResolvedBandSeriesConfig
  | ResolvedErrorBarSeriesConfig
  | ResolvedImpulseSeriesConfig;

export type ResolvedSeriesConfig =
  | ResolvedSeriesConfig2D
  | ResolvedPointCloud3DSeriesConfig
  | ResolvedSurface3DSeriesConfig;

/** True for classic 2D series (excludes pointCloud3d / surface3d). */
export function isResolvedSeries2D(s: ResolvedSeriesConfig): s is ResolvedSeriesConfig2D {
  return s.type !== 'pointCloud3d' && s.type !== 'surface3d';
}

export type ResolvedPerformanceConfig = Readonly<{
  readonly lod: PerformanceLod;
}>;

export type ResolvedCamera3D = Readonly<{
  readonly type: 'perspective' | 'orthographic';
  readonly fovY: number;
  readonly near: number;
  readonly far: number;
  readonly eye?: readonly [number, number, number];
  readonly target?: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly orthoSize: number;
}>;

export type ResolvedInteraction3D = Readonly<{
  readonly orbit: boolean;
  readonly pan: boolean;
  readonly zoom: boolean;
  readonly orbitSpeed: number;
  readonly zoomSpeed: number;
  readonly panSpeed: number;
}>;

export type ResolvedAxis3D = Readonly<{
  readonly name: string;
  readonly type: 'value';
  readonly min?: number;
  readonly max?: number;
  readonly tickCount: number;
  readonly visible: boolean;
}>;

export type ResolvedAxes3D = Readonly<{
  readonly x: ResolvedAxis3D;
  readonly y: ResolvedAxis3D;
  readonly z: ResolvedAxis3D;
  /** @deprecated use x.name — kept for back-compat reads in tests/docs */
  readonly xName: string;
  readonly yName: string;
  readonly zName: string;
  readonly showBox: boolean;
  readonly showGrid: boolean;
  readonly labelMode: 'auto' | 'dom' | 'gpu';
}>;

export type ResolvedSurface3DContours = Readonly<{
  readonly show: boolean;
  readonly levels: number | readonly number[];
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
}>;

export interface ResolvedChartGPUOptions extends Omit<
  ChartGPUOptions,
  | 'grid'
  | 'gridLines'
  | 'xAxis'
  | 'yAxis'
  | 'axes'
  | 'theme'
  | 'palette'
  | 'series'
  | 'legend'
  | 'performance'
  | 'camera'
  | 'interaction3d'
  | 'axes3d'
  | 'coordinateSystem'
> {
  readonly coordinateSystem: CoordinateSystem;
  readonly camera: ResolvedCamera3D;
  readonly interaction3d: ResolvedInteraction3D;
  readonly axes3d: ResolvedAxes3D;
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

const SERIES_2D_TYPES = new Set<SeriesType>([
  'line',
  'area',
  'bar',
  'scatter',
  'pie',
  'candlestick',
  'ohlc',
  'heatmap',
  'band',
  'errorBar',
  'impulse',
]);
const SERIES_3D_TYPES = new Set<SeriesType>(['pointCloud3d', 'surface3d']);

function resolveCamera3D(input: Chart3DCameraOptions | undefined): ResolvedCamera3D {
  const type = input?.type === 'orthographic' ? 'orthographic' : camera3dDefaults.type;
  const fovY =
    typeof input?.fovY === 'number' && Number.isFinite(input.fovY) && input.fovY > 0
      ? input.fovY
      : camera3dDefaults.fovY;
  const near =
    typeof input?.near === 'number' && Number.isFinite(input.near) && input.near > 0
      ? input.near
      : camera3dDefaults.near;
  const far =
    typeof input?.far === 'number' && Number.isFinite(input.far) && input.far > near ? input.far : camera3dDefaults.far;
  const orthoSize =
    typeof input?.orthoSize === 'number' && Number.isFinite(input.orthoSize) && input.orthoSize > 0
      ? input.orthoSize
      : camera3dDefaults.orthoSize;
  const up =
    Array.isArray(input?.up) &&
    input!.up!.length === 3 &&
    input!.up!.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? ([input!.up![0], input!.up![1], input!.up![2]] as const)
      : camera3dDefaults.up;
  const eye =
    Array.isArray(input?.eye) &&
    input!.eye!.length === 3 &&
    input!.eye!.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? ([input!.eye![0], input!.eye![1], input!.eye![2]] as const)
      : undefined;
  const target =
    Array.isArray(input?.target) &&
    input!.target!.length === 3 &&
    input!.target!.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? ([input!.target![0], input!.target![1], input!.target![2]] as const)
      : undefined;
  return { type, fovY, near, far, eye, target, up, orthoSize };
}

function resolveInteraction3D(input: Interaction3DOptions | undefined): ResolvedInteraction3D {
  return {
    orbit: input?.orbit !== false,
    pan: input?.pan !== false,
    zoom: input?.zoom !== false,
    orbitSpeed:
      typeof input?.orbitSpeed === 'number' && Number.isFinite(input.orbitSpeed)
        ? input.orbitSpeed
        : interaction3dDefaults.orbitSpeed,
    zoomSpeed:
      typeof input?.zoomSpeed === 'number' && Number.isFinite(input.zoomSpeed)
        ? input.zoomSpeed
        : interaction3dDefaults.zoomSpeed,
    panSpeed:
      typeof input?.panSpeed === 'number' && Number.isFinite(input.panSpeed)
        ? input.panSpeed
        : interaction3dDefaults.panSpeed,
  };
}

function resolveOneAxis3D(input: Axes3DOptions['x'] | undefined, fallbackName: string): ResolvedAxis3D {
  const name = typeof input?.name === 'string' && input.name.trim() ? input.name : fallbackName;
  const tickCount =
    typeof input?.tickCount === 'number' && Number.isFinite(input.tickCount) && input.tickCount >= 2
      ? Math.min(20, Math.floor(input.tickCount))
      : axes3dDefaults.tickCount;
  const min = typeof input?.min === 'number' && Number.isFinite(input.min) ? input.min : undefined;
  const max = typeof input?.max === 'number' && Number.isFinite(input.max) ? input.max : undefined;
  return {
    name,
    type: 'value',
    min,
    max,
    tickCount,
    visible: input?.visible !== false,
  };
}

function resolveAxes3D(input: Axes3DOptions | undefined): ResolvedAxes3D {
  const x = resolveOneAxis3D(input?.x, 'X');
  const y = resolveOneAxis3D(input?.y, 'Y');
  const z = resolveOneAxis3D(input?.z, 'Z');
  const labelMode =
    input?.labelMode === 'dom' || input?.labelMode === 'gpu' || input?.labelMode === 'auto'
      ? input.labelMode
      : axes3dDefaults.labelMode;
  return {
    x,
    y,
    z,
    xName: x.name,
    yName: y.name,
    zName: z.name,
    showBox: input?.showBox !== false,
    showGrid: input?.showGrid !== false,
    labelMode,
  };
}

function resolvePointCloud3DSeries(
  s: PointCloud3DSeriesConfig,
  ctx: { readonly visible: boolean; readonly color: string; readonly seriesIndex: number }
): ResolvedPointCloud3DSeriesConfig {
  const size =
    typeof s.pointStyle?.size === 'number' && Number.isFinite(s.pointStyle.size) && s.pointStyle.size > 0
      ? s.pointStyle.size
      : pointCloud3dDefaults.pointSize;
  const opacity =
    typeof s.pointStyle?.opacity === 'number' && Number.isFinite(s.pointStyle.opacity)
      ? Math.min(1, Math.max(0, s.pointStyle.opacity))
      : pointCloud3dDefaults.opacity;
  const styleColor =
    typeof s.pointStyle?.color === 'string' && s.pointStyle.color.trim() ? s.pointStyle.color : ctx.color;

  let colorBy: ResolvedPointCloud3DSeriesConfig['colorBy'];
  if (s.colorBy != null) {
    const cm = s.colorBy.colormap;
    const colormap: HeatmapColormap =
      typeof cm === 'string' && isNamedColormap(cm) ? cm : Array.isArray(cm) && cm.length > 0 ? cm : 'viridis';
    colorBy = {
      values: s.colorBy.values,
      colormap,
      min: typeof s.colorBy.min === 'number' && Number.isFinite(s.colorBy.min) ? s.colorBy.min : undefined,
      max: typeof s.colorBy.max === 'number' && Number.isFinite(s.colorBy.max) ? s.colorBy.max : undefined,
    };
  }

  // drawable: at least one finite XYZ sample (matches pack skip policy)
  const drawable = pointCloud3dHasDrawableSample(s.data);

  return {
    type: 'pointCloud3d',
    name: s.name,
    visible: ctx.visible,
    data: s.data,
    color: styleColor,
    pointStyle: { size, color: styleColor, opacity },
    colorBy,
    drawable,
  };
}

function resolveSurface3DSeries(
  s: Surface3DSeriesConfig,
  ctx: { readonly visible: boolean; readonly color: string; readonly seriesIndex: number }
): ResolvedSurface3DSeriesConfig {
  const cm = s.colormap;
  const colormap: HeatmapColormap =
    typeof cm === 'string' && isNamedColormap(cm)
      ? cm
      : Array.isArray(cm) && cm.length > 0
        ? cm
        : surface3dDefaults.colormap;
  const opacity =
    typeof s.opacity === 'number' && Number.isFinite(s.opacity)
      ? Math.min(1, Math.max(0, s.opacity))
      : surface3dDefaults.opacity;
  const lighting =
    typeof s.lighting === 'number' && Number.isFinite(s.lighting)
      ? Math.min(1, Math.max(0, s.lighting))
      : surface3dDefaults.lighting;
  const wireframe = s.wireframe === true;
  const columns = Math.floor(Number(s.data?.columns));
  const rows = Math.floor(Number(s.data?.rows));
  const drawable =
    s.data != null &&
    columns >= 2 &&
    rows >= 2 &&
    Number.isFinite(s.data.xStep) &&
    s.data.xStep !== 0 &&
    Number.isFinite(s.data.zStep) &&
    s.data.zStep !== 0 &&
    s.data.y != null &&
    s.data.y.length > 0;

  // yMin/yMax: use explicit or placeholder (renderer pack fills from data)
  let yMin = typeof s.yMin === 'number' && Number.isFinite(s.yMin) ? s.yMin : 0;
  let yMax = typeof s.yMax === 'number' && Number.isFinite(s.yMax) ? s.yMax : 1;
  if (drawable && (s.yMin == null || s.yMax == null) && s.data.y) {
    let lo = Infinity;
    let hi = -Infinity;
    const len = Math.min(s.data.y.length, columns * rows);
    for (let i = 0; i < len; i++) {
      const v = Number(s.data.y[i]);
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (Number.isFinite(lo)) {
      if (s.yMin == null) yMin = lo;
      if (s.yMax == null) yMax = hi > lo ? hi : lo + 1;
    }
  }
  if (!(yMax > yMin)) yMax = yMin + 1;

  const c = s.contours;
  const contShow = c?.show === true;
  let contLevels: number | readonly number[] = surface3dDefaults.contoursLevels;
  if (c?.levels != null) {
    if (Array.isArray(c.levels)) {
      contLevels = c.levels.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    } else if (typeof c.levels === 'number' && Number.isFinite(c.levels) && c.levels > 0) {
      contLevels = Math.min(64, Math.floor(c.levels));
    }
  }
  const contColor = typeof c?.color === 'string' && c.color.trim() ? c.color : surface3dDefaults.contoursColor;
  const contWidth =
    typeof c?.width === 'number' && Number.isFinite(c.width) && c.width > 0 ? c.width : surface3dDefaults.contoursWidth;
  const contOpacity =
    typeof c?.opacity === 'number' && Number.isFinite(c.opacity)
      ? Math.min(1, Math.max(0, c.opacity))
      : surface3dDefaults.contoursOpacity;

  return {
    type: 'surface3d',
    name: s.name,
    visible: ctx.visible,
    data: s.data,
    colormap,
    yMin,
    yMax,
    wireframe,
    opacity,
    lighting,
    color: ctx.color,
    drawable: Boolean(drawable),
    contours: {
      show: contShow,
      levels: contLevels,
      color: contColor,
      width: contWidth,
      opacity: contOpacity,
    },
  };
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

const VALID_AXIS_TYPES = new Set(['value', 'time', 'category', 'log']);

const normalizeAxisType = (value: unknown, fallback: AxisConfig['type']): AxisConfig['type'] => {
  if (typeof value === 'string' && VALID_AXIS_TYPES.has(value)) {
    return value as AxisConfig['type'];
  }
  return fallback;
};

/**
 * Resolve `logBase` for log axes. Default 10; invalid bases fall back to 10 with a
 * one-shot dev warning. Omitted / non-log axes leave logBase undefined.
 */
const resolveAxisLogBase = (type: AxisConfig['type'], logBase: unknown): number | undefined => {
  if (type !== 'log') return undefined;
  if (logBase === undefined || logBase === null) return 10;
  if (typeof logBase === 'number' && Number.isFinite(logBase) && logBase > 0 && logBase !== 1) {
    return logBase;
  }
  console.warn(`[ChartGPU] Invalid axis logBase (${String(logBase)}); falling back to 10.`);
  return 10;
};

const finalizeAxisConfig = (axis: AxisConfig): AxisConfig => {
  const type = normalizeAxisType(axis.type, 'value');
  const logBase = resolveAxisLogBase(type, axis.logBase);
  if (type === axis.type && logBase === axis.logBase) return axis;
  return logBase !== undefined ? { ...axis, type, logBase } : { ...axis, type };
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

const warnedInvalidStep = new Set<string>();
function warnInvalidStepOnce(seriesIndex: number, raw: unknown): void {
  const key = `${seriesIndex}:${String(raw)}`;
  if (warnedInvalidStep.has(key)) return;
  warnedInvalidStep.add(key);
  console.warn(
    `ChartGPU: series[${seriesIndex}] step value ${JSON.stringify(raw)} is invalid; using linear geometry. ` +
      `Valid: true | false | 'before' | 'middle' | 'after'.`
  );
}

/**
 * Normalize public `step` to resolved StepMode | undefined (linear when omitted).
 * `true` → `'after'`; invalid strings warn once and treat as linear.
 */
export function normalizeSeriesStep(
  step: boolean | StepMode | string | undefined | null,
  seriesIndex: number
): StepMode | undefined {
  if (step == null || step === false) return undefined;
  if (isInvalidStepValue(step)) {
    warnInvalidStepOnce(seriesIndex, step);
    return undefined;
  }
  const mode = resolveStepMode(step as boolean | StepMode);
  return mode ?? undefined;
}

const warnedStepSampling = new Set<number>();
/** Prefer sampling:'none' for exact digital edges; LTTB-then-step is approximate. */
function warnStepWithSamplingOnce(seriesIndex: number, sampling: SeriesSampling): void {
  if (sampling === 'none' || warnedStepSampling.has(seriesIndex)) return;
  warnedStepSampling.add(seriesIndex);
  console.warn(
    `ChartGPU: series[${seriesIndex}] has step + sampling '${sampling}'; ` +
      `step is applied after sampling and is approximate for digital signals — prefer sampling: 'none'.`
  );
}

let candlestickWarned = false;
const warnedStackedAreaBaseline = new Set<number>();
const warnStackedAreaBaselineIgnored = (seriesIndex: number): void => {
  if (warnedStackedAreaBaseline.has(seriesIndex)) return;
  warnedStackedAreaBaseline.add(seriesIndex);
  console.warn(
    `ChartGPU: series[${seriesIndex}] has both stack and baseline; baseline is ignored for stacked mountain/area layout (cumulative floor from 0).`
  );
};

const warnedLineStackNoArea = new Set<number>();
const warnLineStackWithoutAreaStyle = (seriesIndex: number): void => {
  if (warnedLineStackNoArea.has(seriesIndex)) return;
  warnedLineStackNoArea.add(seriesIndex);
  console.warn(
    `ChartGPU: series[${seriesIndex}] has stack without areaStyle; stack has no fill effect on stroke-only lines.`
  );
};

/**
 * Expand per-series rawBounds y extents so auto Y includes stacked composition totals
 * (not raw per-layer max alone). Mutates resolved series objects in place (resolver-owned).
 */
function applyStackedMountainBounds(series: ResolvedSeriesConfig[]): void {
  // Visible peers only — legend-hidden layers do not lift auto Y (issue 9).
  const groups = groupStackedMountainLayers(series, { includeHidden: false });
  if (groups.size === 0) return;

  for (const members of groups.values()) {
    if (members.length === 0) continue;
    const layers = members.map((m) => ({
      seriesIndex: m.seriesIndex,
      data: ((m.series as { data?: CartesianSeriesData }).data ?? []) as CartesianSeriesData,
    }));
    const geometries = computeStackedAreaBaselines(layers);
    const ext = computeStackedYExtents(geometries);
    if (!ext) continue;

    for (const m of members) {
      const s = series[m.seriesIndex] as ResolvedSeriesConfig & {
        rawBounds?: RawBounds;
      };
      if (!s) continue;
      const prev = s.rawBounds;
      // Y is composition-authoritative (do not keep zero-span contribution yMax+1).
      // X still comes from per-series data extents when available.
      if (!prev) {
        (s as { rawBounds?: RawBounds }).rawBounds = {
          xMin: 0,
          xMax: 1,
          yMin: ext.yMin,
          yMax: ext.yMax,
        };
        continue;
      }
      (s as { rawBounds?: RawBounds }).rawBounds = {
        xMin: prev.xMin,
        xMax: prev.xMax,
        yMin: ext.yMin,
        yMax: ext.yMax,
      };
    }
  }
}

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
 * (e.g. `series[i].data = newData`, `series[i].priceLabel = …`) is **not** re-resolved
 * (same as per-series data-ref contract). Changing candlestick `priceLabel` requires a
 * **new series element reference**. Axes-only y-range rewrites typically re-pass the same
 * stored series objects.
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
 * object as immutable for this path. Mutating `series[i].data` / colors /
 * `priceLabel` under a stable element object is still not detected (same as
 * per-series data-ref contract); replace the series element or the whole array
 * when content/style/priceLabel changes.
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
  // Modality change invalidates wholesale series reuse (2D vs 3D paths).
  const prevCs = previousUserOptions.coordinateSystem ?? 'cartesian2d';
  const nextCs = userOptions.coordinateSystem ?? 'cartesian2d';
  if (prevCs !== nextCs) return false;
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
  if (!prev || prev.type !== nextType || prev.type === 'pie' || prev.type === 'heatmap') return false;
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
  if (prev && prev.type === nextType && prev.type !== 'pie' && prev.type !== 'heatmap') {
    const prevAny = prev as WithResolvedDataIdentity;
    if ((prevAny.rawData ?? prevAny.data) === rawData && typeof prevAny.contentHash === 'number') {
      return prevAny.contentHash;
    }
  }
  return hashData();
}

const warnedHeatmapInvalid = new Set<string>();
function warnHeatmapOnce(key: string, message: string): void {
  if (warnedHeatmapInvalid.has(key)) return;
  warnedHeatmapInvalid.add(key);
  console.warn(message);
}

function normalizeHeatmapColormap(v: unknown): HeatmapColormap {
  if (isNamedColormap(v)) return v;
  if (Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === 'string')) {
    return v as readonly string[];
  }
  return heatmapDefaults.colormap;
}

function normalizeHeatmapNullHandling(v: unknown): HeatmapNullHandling {
  if (v === 'transparent' || v === 'lowest' || v === 'highest') return v;
  return heatmapDefaults.nullHandling;
}

function normalizeHeatmapCellAnchor(v: unknown): HeatmapCellAnchor {
  if (v === 'corner' || v === 'center') return v;
  return heatmapDefaults.cellAnchor;
}

function resolveHeatmapSeries(
  s: HeatmapSeriesConfig,
  ctx: {
    readonly visible: boolean;
    readonly yAxis: string;
    readonly seriesIndex: number;
    readonly color: string;
  }
): ResolvedHeatmapSeriesConfig {
  const {
    sampling: _sampling,
    samplingThreshold: _samplingThreshold,
    color: _color,
    ...rest
  } = s as HeatmapSeriesConfig & {
    readonly sampling?: unknown;
    readonly samplingThreshold?: unknown;
    readonly color?: unknown;
  };

  const geom = sanitizeHeatmapGeometry(s.data);
  const cellAnchor = normalizeHeatmapCellAnchor(s.cellAnchor);
  const colormap = normalizeHeatmapColormap(s.colormap);
  const zScale = s.zScale === 'log' ? 'log' : heatmapDefaults.zScale;
  const nullHandling = normalizeHeatmapNullHandling(s.nullHandling);
  const opacityRaw = typeof s.opacity === 'number' && Number.isFinite(s.opacity) ? s.opacity : heatmapDefaults.opacity;
  const opacity = Math.min(1, Math.max(0, opacityRaw));
  const cellGapPx =
    typeof s.cellGapPx === 'number' && Number.isFinite(s.cellGapPx) && s.cellGapPx > 0 ? s.cellGapPx : 0;

  if (!geom) {
    warnHeatmapOnce(
      `geom:${ctx.seriesIndex}`,
      `ChartGPU: heatmap series[${ctx.seriesIndex}] has invalid dimensions or zero/non-finite steps; series will not draw.`
    );
    return {
      ...rest,
      type: 'heatmap',
      visible: ctx.visible,
      yAxis: ctx.yAxis,
      color: ctx.color,
      data: s.data,
      colormap,
      zMin: 0,
      zMax: 1,
      zDomainExplicit: false,
      zScale,
      opacity,
      cellAnchor,
      nullHandling,
      cellGapPx,
      drawable: false,
      cellCount: 0,
    };
  }

  const expected = geom.columns * geom.rows;
  if (geom.zLength !== expected) {
    warnHeatmapOnce(
      `zlen:${ctx.seriesIndex}:${geom.zLength}:${expected}`,
      `ChartGPU: heatmap series[${ctx.seriesIndex}] z.length (${geom.zLength}) !== columns*rows (${expected}); drawing min(len, cols*rows) cells.`
    );
  }

  // Resolve zMin/zMax: explicit pair, one + data extremum, or full auto.
  const userZMin = typeof s.zMin === 'number' && Number.isFinite(s.zMin) ? s.zMin : undefined;
  const userZMax = typeof s.zMax === 'number' && Number.isFinite(s.zMax) ? s.zMax : undefined;
  const zDomainExplicit = userZMin != null && userZMax != null;
  const auto = computeHeatmapZExtent(s.data.z, expected, zScale);
  let zMin = userZMin ?? auto.zMin;
  let zMax = userZMax ?? auto.zMax;
  if (userZMin != null && userZMax == null) {
    zMax = Math.max(userZMin, auto.zMax);
  }
  if (userZMax != null && userZMin == null) {
    zMin = Math.min(userZMax, auto.zMin);
  }
  if (zMin === zMax) {
    const eps = zMin === 0 ? 1e-6 : Math.abs(zMin) * 1e-6;
    zMin -= eps;
    zMax += eps;
  }

  const bounds = heatmapGridBounds(
    {
      xStart: geom.xStart,
      xStep: geom.xStep,
      yStart: geom.yStart,
      yStep: geom.yStep,
      columns: geom.columns,
      rows: geom.rows,
    },
    cellAnchor
  );

  const data: HeatmapData = {
    xStart: geom.xStart,
    xStep: geom.xStep,
    yStart: geom.yStart,
    yStep: geom.yStep,
    columns: geom.columns,
    rows: geom.rows,
    z: s.data.z,
  };

  return {
    ...rest,
    type: 'heatmap',
    visible: ctx.visible,
    yAxis: ctx.yAxis,
    color: ctx.color,
    data,
    colormap,
    zMin,
    zMax,
    zDomainExplicit,
    zScale,
    opacity,
    cellAnchor,
    nullHandling,
    cellGapPx,
    rawBounds: bounds,
    drawable: geom.drawCells > 0,
    cellCount: expected,
  };
}

export function resolveOptions(
  userOptions: ChartGPUOptions = {},
  reuse?: ResolveOptionsReuse
): ResolvedChartGPUOptions {
  const previousSeries = reuse?.previousResolved?.series;
  const previousTheme = reuse?.previousResolved?.theme;
  const prevUserForTheme = reuse?.previousUserOptions;

  const coordinateSystem: CoordinateSystem =
    userOptions.coordinateSystem === 'cartesian3d' ? 'cartesian3d' : 'cartesian2d';
  const camera = resolveCamera3D(userOptions.camera);
  const interaction3d = resolveInteraction3D(userOptions.interaction3d);
  const axes3d = resolveAxes3D(userOptions.axes3d);

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

  // grid.left / grid.right depend on candle-primary + Y-axis positions (resolved below).
  // top/bottom can use standard defaults immediately; left/right filled after yAxes.
  const candlePrimary = isCandlePrimaryChart(userOptions);

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

  const xAxis: AxisConfig = finalizeAxisConfig(
    userOptions.xAxis
      ? {
          ...defaultOptions.xAxis,
          ...userOptions.xAxis,
          // runtime safety for JS callers
          type: normalizeAxisType(
            (userOptions.xAxis as unknown as Partial<AxisConfig>).type,
            defaultOptions.xAxis.type
          ),
          autoBounds:
            normalizeAxisAutoBounds((userOptions.xAxis as unknown as { readonly autoBounds?: unknown }).autoBounds) ??
            (defaultOptions.xAxis as AxisConfig).autoBounds,
        }
      : { ...defaultOptions.xAxis }
  );

  // First Y axis defaults to 'right' on candle-primary charts when position is unset.
  // Secondary Y axes keep the existing default ('left' when unset).
  const defaultFirstYPosition: 'left' | 'right' = candlePrimary ? 'right' : 'left';

  const yAxes: AxisConfig[] = [];
  if (userOptions.axes?.y && userOptions.axes.y.length > 0) {
    for (let index = 0; index < userOptions.axes.y.length; index++) {
      const yConfig = userOptions.axes.y[index]!;
      const positionDefault = index === 0 ? defaultFirstYPosition : 'left';
      yAxes.push(
        finalizeAxisConfig({
          ...defaultOptions.yAxis,
          ...yConfig,
          id: yConfig.id ?? (index === 0 ? 'y' : `y${index}`),
          position: yConfig.position ?? positionDefault,
          type: normalizeAxisType(yConfig.type, defaultOptions.yAxis.type),
          autoBounds:
            normalizeAxisAutoBounds((yConfig as unknown as { readonly autoBounds?: unknown }).autoBounds) ??
            defaultOptions.yAxis.autoBounds,
        })
      );
    }
  } else {
    yAxes.push(
      finalizeAxisConfig(
        userOptions.yAxis
          ? {
              ...defaultOptions.yAxis,
              ...userOptions.yAxis,
              id: userOptions.yAxis.id ?? 'y',
              position: userOptions.yAxis.position ?? defaultFirstYPosition,
              type: normalizeAxisType(
                (userOptions.yAxis as unknown as Partial<AxisConfig>).type,
                defaultOptions.yAxis.type
              ),
              autoBounds:
                normalizeAxisAutoBounds(
                  (userOptions.yAxis as unknown as { readonly autoBounds?: unknown }).autoBounds
                ) ?? defaultOptions.yAxis.autoBounds,
            }
          : { ...defaultOptions.yAxis, id: 'y', position: defaultFirstYPosition }
      )
    );
  }

  // Soft gutters for candle-primary: per-key only when user left that key undefined.
  // Dual-Y safety: keep left 60 when any Y remains on the left after position defaults.
  const hasLeftY = yAxes.some((a) => (a.position ?? 'left') === 'left');
  const candleLeftDefault = hasLeftY ? candlePrimaryGridDefaults.leftWithLeftY : candlePrimaryGridDefaults.leftNoLeftY;
  const grid: ResolvedGridConfig = {
    left: userOptions.grid?.left ?? (candlePrimary ? candleLeftDefault : defaultOptions.grid.left),
    right: userOptions.grid?.right ?? (candlePrimary ? candlePrimaryGridDefaults.right : defaultOptions.grid.right),
    top: userOptions.grid?.top ?? defaultOptions.grid.top,
    bottom: userOptions.grid?.bottom ?? defaultOptions.grid.bottom,
  };

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
  // Note: wholesale reuse does not re-enter per-series resolve — changing candlestick
  // `priceLabel` requires a new series element identity (same as other series fields).
  const prevUser = reuse?.previousUserOptions;
  const canReuseEntireSeriesArray = canReuseEntireUserSeriesArray({
    previousResolvedSeries: previousSeries,
    previousUserOptions: prevUser,
    userOptions,
    lastUserSeriesElements: reuse?.lastUserSeriesElements,
  });

  const series: ReadonlyArray<ResolvedSeriesConfig> = canReuseEntireSeriesArray
    ? previousSeries!
    : ((userOptions.series ?? [])
        .map((s, i) => {
          const seriesType = s.type as SeriesType;
          // 2D/3D exclusivity: skip invalid series with a warning (do not throw).
          if (coordinateSystem === 'cartesian3d' && SERIES_2D_TYPES.has(seriesType)) {
            console.warn(
              `ChartGPU: series[${i}] type '${seriesType}' is not valid in coordinateSystem 'cartesian3d'; skipping.`
            );
            return null;
          }
          if (coordinateSystem === 'cartesian2d' && SERIES_3D_TYPES.has(seriesType)) {
            console.warn(
              `ChartGPU: series[${i}] type '${seriesType}' requires coordinateSystem 'cartesian3d'; skipping.`
            );
            return null;
          }

          const explicitColor = normalizeOptionalColor((s as { color?: string }).color);
          const inheritedColor = theme.colorPalette[i % theme.colorPalette.length];
          const color = explicitColor ?? inheritedColor;
          const prevResolved = previousSeries?.[i];

          // Ensure visible defaults to true (converts undefined to true, preserves explicit false)
          const visible = s.visible !== false;

          const sampling: SeriesSampling =
            normalizeSampling((s as unknown as { sampling?: unknown }).sampling) ?? 'lttb';
          const samplingThreshold: number =
            normalizeSamplingThreshold((s as unknown as { samplingThreshold?: unknown }).samplingThreshold) ?? 5000;

          const yAxis = (s as { yAxis?: string }).yAxis ?? defaultYAxisId;

          switch (s.type) {
            case 'pointCloud3d': {
              return resolvePointCloud3DSeries(s, { visible, color, seriesIndex: i });
            }
            case 'surface3d': {
              return resolveSurface3DSeries(s, { visible, color, seriesIndex: i });
            }
            case 'area': {
              // Resolve effective fill color with precedence: areaStyle.color → series.color → palette
              const areaStyleColor = normalizeOptionalColor(s.areaStyle?.color);
              const effectiveColor = areaStyleColor ?? explicitColor ?? inheritedColor;

              const areaStyle: ResolvedAreaStyleConfig = {
                opacity: s.areaStyle?.opacity ?? defaultAreaStyle.opacity,
                color: effectiveColor,
              };

              const stack = normalizeStackId(s.stack);
              if (stack !== '' && s.baseline !== undefined && Number.isFinite(s.baseline)) {
                warnStackedAreaBaselineIgnored(i);
              }

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
              const step = normalizeSeriesStep(s.step, i);
              if (step != null) warnStepWithSamplingOnce(i, sampling);
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
                // Normalized stack id (empty → omitted / unstacked).
                ...(stack !== '' ? { stack } : { stack: undefined }),
                // Normalized step mode (true → 'after'); omit when linear.
                ...(step != null ? { step } : { step: undefined }),
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

              // Avoid leaking the unresolved (user) areaStyle / step shape via object spread.
              const { areaStyle: _userAreaStyle, stack: _userStack, step: _userStep, ...rest } = s;
              const stack = normalizeStackId(s.stack);
              if (stack !== '' && s.areaStyle == null) {
                warnLineStackWithoutAreaStyle(i);
              }
              const connectNulls = s.connectNulls ?? false;
              const step = normalizeSeriesStep(s.step, i);
              if (step != null) warnStepWithSamplingOnce(i, sampling);
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
                ...(stack !== '' ? { stack } : { stack: undefined }),
                ...(step != null ? { step } : { step: undefined }),
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
                const yOnlyKind = classifyEqualNYOnlyRewrite(
                  prevScatterResolved.rawData as CartesianSeriesData,
                  s.data,
                  {
                    prevIndexSortedProven: stickyIndexSorted,
                    prevIndexSortedFingerprint: prevScatterResolved.indexSortedFingerprint,
                  }
                );
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
            case 'heatmap': {
              return resolveHeatmapSeries(s, {
                visible,
                yAxis,
                seriesIndex: i,
                color,
              });
            }
            case 'band': {
              // Fill color: areaStyle.color → series.color → palette
              const areaStyleColor = normalizeOptionalColor(s.areaStyle?.color);
              const effectiveFillColor = areaStyleColor ?? explicitColor ?? inheritedColor;

              const areaStyle: ResolvedAreaStyleConfig = {
                opacity: s.areaStyle?.opacity ?? defaultAreaStyle.opacity,
                color: effectiveFillColor,
              };

              // lineStyle omitted → no y stroke (fill-only; locked plan rule).
              // When present, default width 1 / opacity like line edges.
              let lineStyle: ResolvedLineStyleConfig | undefined;
              if (s.lineStyle != null) {
                const lineStyleColor = normalizeOptionalColor(s.lineStyle.color);
                const effectiveStrokeColor = lineStyleColor ?? explicitColor ?? inheritedColor;
                lineStyle = {
                  width: s.lineStyle.width ?? 1,
                  opacity: s.lineStyle.opacity ?? defaultLineStyle.opacity,
                  color: effectiveStrokeColor,
                };
              }

              // lineStyleY1 omitted → no y1 stroke (v1 locked decision).
              let lineStyleY1: ResolvedLineStyleConfig | undefined;
              if (s.lineStyleY1 != null) {
                const y1Color = normalizeOptionalColor(s.lineStyleY1.color) ?? explicitColor ?? inheritedColor;
                lineStyleY1 = {
                  width: s.lineStyleY1.width ?? 1,
                  opacity: s.lineStyleY1.opacity ?? defaultLineStyle.opacity,
                  color: y1Color,
                };
              }

              // Reject ohlc for band (never map to candle sampling).
              let bandSampling: Exclude<SeriesSampling, 'ohlc'> =
                sampling === 'ohlc' ? 'lttb' : (sampling as Exclude<SeriesSampling, 'ohlc'>);
              if (sampling === 'ohlc') {
                console.warn(`ChartGPU band series[${i}]: sampling 'ohlc' is not supported; using 'lttb'.`);
              }

              const connectNulls = s.connectNulls ?? false;
              const contentHash = resolveSeriesContentHash(prevResolved, 'band', s.data, () =>
                cheapBandContentStamp(s.data)
              );
              const reuseSample = canReuseResolvedSeriesSample(
                prevResolved,
                'band',
                s.data,
                bandSampling,
                samplingThreshold,
                connectNulls,
                contentHash
              );
              const prevBand = reuseSample
                ? (prevResolved as ResolvedBandSeriesConfig & {
                    contentHash?: number;
                    rawBoundsMode?: RawBoundsMode;
                  })
                : null;

              let rawBounds: RawBounds | undefined;
              let rawBoundsMode: RawBoundsMode;
              if (prevBand?.rawBounds && prevBand.rawBoundsMode === 'data') {
                rawBounds = prevBand.rawBounds;
                rawBoundsMode = 'data';
              } else {
                rawBounds = bandBounds(s.data) ?? undefined;
                rawBoundsMode = rawBounds ? 'data' : 'synthetic';
              }

              // Touch length for mismatch warnings (getBandLength).
              getBandLength(s.data);

              const sampledBandData = prevBand
                ? prevBand.data
                : bandSampling === 'none' || hasBandNullGaps(s.data)
                  ? s.data
                  : sampleBandSeries(s.data, bandSampling, samplingThreshold);

              return {
                type: 'band' as const,
                name: s.name,
                visible,
                rawData: s.data,
                data: sampledBandData,
                color: effectiveFillColor,
                areaStyle,
                ...(lineStyle ? { lineStyle } : {}),
                ...(lineStyleY1 ? { lineStyleY1 } : {}),
                sampling: bandSampling,
                samplingThreshold,
                rawBounds,
                rawBoundsMode,
                connectNulls,
                yAxis,
                contentHash,
              };
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

              const resolvedPriceLabel = resolvePriceLabel(s.priceLabel, { candlePrimary });

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
                priceLabel: resolvedPriceLabel,
                rawBounds,
                yAxis,
                contentHash,
              };
            }
            case 'ohlc': {
              const ohlcSeries = s as OhlcSeriesConfig;
              const resolvedSampling: 'none' | 'ohlc' =
                normalizeCandlestickSampling((ohlcSeries as unknown as { sampling?: unknown }).sampling) ??
                ohlcDefaults.sampling;

              const resolvedSamplingThreshold: number =
                normalizeSamplingThreshold(
                  (ohlcSeries as unknown as { samplingThreshold?: unknown }).samplingThreshold
                ) ?? ohlcDefaults.samplingThreshold;

              const resolvedItemStyle: ResolvedCandlestickItemStyleConfig = {
                upColor: normalizeOptionalColor(ohlcSeries.itemStyle?.upColor) ?? ohlcDefaults.itemStyle.upColor,
                downColor: normalizeOptionalColor(ohlcSeries.itemStyle?.downColor) ?? ohlcDefaults.itemStyle.downColor,
                upBorderColor:
                  normalizeOptionalColor(ohlcSeries.itemStyle?.upBorderColor) ?? ohlcDefaults.itemStyle.upBorderColor,
                downBorderColor:
                  normalizeOptionalColor(ohlcSeries.itemStyle?.downBorderColor) ??
                  ohlcDefaults.itemStyle.downBorderColor,
                borderWidth:
                  typeof ohlcSeries.itemStyle?.borderWidth === 'number' &&
                  Number.isFinite(ohlcSeries.itemStyle.borderWidth)
                    ? ohlcSeries.itemStyle.borderWidth
                    : ohlcDefaults.itemStyle.borderWidth,
              };

              const contentHash = resolveSeriesContentHash(prevResolved, 'ohlc', ohlcSeries.data, () =>
                cheapOHLCContentStamp(ohlcSeries.data)
              );
              const reuseOhlc = canReuseResolvedSeriesSample(
                prevResolved,
                'ohlc',
                ohlcSeries.data,
                resolvedSampling,
                resolvedSamplingThreshold,
                undefined,
                contentHash
              );
              const prevOhlc = reuseOhlc
                ? (prevResolved as ResolvedOhlcSeriesConfig & {
                    contentHash?: number;
                  })
                : null;
              const rawBounds = prevOhlc?.rawBounds ?? computeRawBoundsFromOHLC(ohlcSeries.data);

              const sampledData = prevOhlc
                ? prevOhlc.data
                : resolvedSampling === 'ohlc' && ohlcSeries.data.length > resolvedSamplingThreshold
                  ? ohlcSample(ohlcSeries.data, resolvedSamplingThreshold)
                  : ohlcSeries.data;

              const resolvedPriceLabel = resolvePriceLabel(ohlcSeries.priceLabel, { candlePrimary });

              const stemWidth =
                typeof ohlcSeries.stemWidth === 'number' &&
                Number.isFinite(ohlcSeries.stemWidth) &&
                ohlcSeries.stemWidth > 0
                  ? ohlcSeries.stemWidth
                  : ohlcDefaults.stemWidth;

              const tickLength = ohlcSeries.tickLength ?? ohlcDefaults.tickLength;

              return {
                type: 'ohlc' as const,
                name: ohlcSeries.name,
                visible,
                rawData: ohlcSeries.data,
                data: sampledData,
                color,
                itemStyle: resolvedItemStyle,
                barWidth: ohlcSeries.barWidth ?? ohlcDefaults.barWidth,
                barMinWidth: ohlcSeries.barMinWidth ?? ohlcDefaults.barMinWidth,
                barMaxWidth: ohlcSeries.barMaxWidth ?? ohlcDefaults.barMaxWidth,
                stemWidth,
                tickLength,
                sampling: resolvedSampling,
                samplingThreshold: resolvedSamplingThreshold,
                priceLabel: resolvedPriceLabel,
                rawBounds,
                yAxis,
                contentHash,
              };
            }
            case 'errorBar': {
              const eb = s as ErrorBarSeriesConfig;
              // Sampling: 'none' only — warn + ignore other modes (D10).
              const rawSampling = (eb as unknown as { sampling?: unknown }).sampling;
              if (rawSampling != null && rawSampling !== 'none') {
                console.warn(
                  `ChartGPU errorBar series[${i}]: sampling '${String(rawSampling)}' is not supported; using 'none'.`
                );
              }

              const itemColor = normalizeOptionalColor(eb.itemStyle?.color) ?? explicitColor ?? inheritedColor;
              const borderWidth =
                typeof eb.itemStyle?.borderWidth === 'number' && Number.isFinite(eb.itemStyle.borderWidth)
                  ? eb.itemStyle.borderWidth
                  : errorBarDefaults.itemStyle.borderWidth;
              const opacity =
                typeof eb.itemStyle?.opacity === 'number' && Number.isFinite(eb.itemStyle.opacity)
                  ? Math.min(1, Math.max(0, eb.itemStyle.opacity))
                  : errorBarDefaults.itemStyle.opacity;

              const errorMode: ErrorBarMode =
                eb.errorMode === 'high' || eb.errorMode === 'low' || eb.errorMode === 'both'
                  ? eb.errorMode
                  : errorBarDefaults.errorMode;
              const direction: ErrorBarDirection =
                eb.direction === 'horizontal' || eb.direction === 'vertical'
                  ? eb.direction
                  : errorBarDefaults.direction;

              const contentHash = resolveSeriesContentHash(prevResolved, 'errorBar', eb.data, () =>
                cheapErrorBarContentStamp(eb.data)
              );
              // samplingThreshold is undefined on ResolvedErrorBarSeriesConfig (no threshold field).
              // Pass undefined so canReuseResolvedSeriesSample matches prev (0 would never equal undefined).
              const reuseEb = canReuseResolvedSeriesSample(
                prevResolved,
                'errorBar',
                eb.data,
                'none',
                undefined,
                undefined,
                contentHash
              );
              const prevEb = reuseEb
                ? (prevResolved as ResolvedErrorBarSeriesConfig & {
                    contentHash?: number;
                    rawBoundsMode?: RawBoundsMode;
                  })
                : null;

              // Touch length for mismatch warnings.
              getErrorBarLength(eb.data);

              const hlcData: ErrorBarHlcArraysData = prevEb ? prevEb.data : resolveErrorBarToHlc(eb.data);

              let rawBounds: RawBounds | undefined;
              let rawBoundsMode: RawBoundsMode;
              // Bounds depend on direction (vertical vs horizontal extents) — do not reuse across toggles.
              if (prevEb?.rawBounds && prevEb.rawBoundsMode === 'data' && prevEb.direction === direction) {
                rawBounds = prevEb.rawBounds;
                rawBoundsMode = 'data';
              } else {
                rawBounds = errorBarBounds(hlcData, direction) ?? undefined;
                rawBoundsMode = rawBounds ? 'data' : 'synthetic';
              }

              const capWidth = eb.capWidth ?? errorBarDefaults.capWidth;
              const drawWhiskers = eb.drawWhiskers !== false;
              const drawConnector = eb.drawConnector !== false;
              const showCenter = eb.showCenter === true;
              const symbolSize =
                typeof eb.symbolSize === 'number' && Number.isFinite(eb.symbolSize) && eb.symbolSize > 0
                  ? eb.symbolSize
                  : errorBarDefaults.symbolSize;

              return {
                type: 'errorBar' as const,
                name: eb.name,
                visible,
                color: itemColor,
                itemStyle: {
                  color: itemColor,
                  borderWidth,
                  opacity,
                } satisfies ResolvedErrorBarItemStyleConfig,
                capWidth,
                errorMode,
                direction,
                drawWhiskers,
                drawConnector,
                showCenter,
                symbolSize,
                sampling: 'none' as const,
                rawData: eb.data,
                data: hlcData,
                rawBounds,
                rawBoundsMode,
                yAxis,
                contentHash,
              };
            }
            case 'impulse': {
              const imp = s as ImpulseSeriesConfig;
              const lineStyleColor = normalizeOptionalColor(imp.lineStyle?.color);
              const effectiveStrokeColor = lineStyleColor ?? explicitColor ?? inheritedColor;
              const widthRaw = imp.lineStyle?.width;
              const width =
                typeof widthRaw === 'number' && Number.isFinite(widthRaw) && widthRaw > 0
                  ? widthRaw
                  : impulseDefaults.lineStyle.width;
              // Clamp non-positive resolved widths to minimum 1 (CSS px).
              const stemWidth = width > 0 ? width : 1;
              const opacity =
                typeof imp.lineStyle?.opacity === 'number' && Number.isFinite(imp.lineStyle.opacity)
                  ? Math.min(1, Math.max(0, imp.lineStyle.opacity))
                  : impulseDefaults.lineStyle.opacity;

              let baseline: number = impulseDefaults.baseline;
              if (imp.baseline !== undefined) {
                if (Number.isFinite(imp.baseline)) {
                  baseline = imp.baseline as number;
                } else {
                  console.warn(`ChartGPU impulse series[${i}]: non-finite baseline; using 0.`);
                  baseline = 0;
                }
              }

              const showMarker = imp.showMarker !== false;
              const symbolSize =
                typeof imp.symbolSize === 'number' && Number.isFinite(imp.symbolSize) && imp.symbolSize > 0
                  ? imp.symbolSize
                  : impulseDefaults.symbolSize;

              // Sampling: 'none' only — sparse event stems; other modes warn + ignore (errorBar parity).
              const rawSampling = (imp as unknown as { sampling?: unknown }).sampling;
              if (rawSampling != null && rawSampling !== 'none') {
                console.warn(
                  `ChartGPU impulse series[${i}]: sampling '${String(rawSampling)}' is not supported; using 'none'.`
                );
              }

              const contentHash = resolveSeriesContentHash(prevResolved, 'impulse', imp.data, () =>
                cheapCartesianContentStamp(imp.data)
              );
              // samplingThreshold is undefined on ResolvedImpulseSeriesConfig when none-only —
              // pass undefined so canReuse matches prev (0 would never equal undefined).
              const reuseSample = canReuseResolvedSeriesSample(
                prevResolved,
                'impulse',
                imp.data,
                'none',
                undefined,
                undefined,
                contentHash
              );
              const prevImp = reuseSample
                ? (prevResolved as ResolvedImpulseSeriesConfig & {
                    contentHash?: number;
                    rawBoundsMode?: RawBoundsMode;
                    baseline?: number;
                  })
                : null;

              // Bounds include baseline — recompute when baseline changes even if data reuses.
              let rawBounds: RawBounds | undefined;
              let rawBoundsMode: RawBoundsMode;
              if (prevImp?.rawBounds && prevImp.rawBoundsMode === 'data' && prevImp.baseline === baseline) {
                rawBounds = prevImp.rawBounds;
                rawBoundsMode = 'data';
              } else {
                rawBounds = impulseBounds(imp.data, baseline) ?? undefined;
                rawBoundsMode = rawBounds ? 'data' : 'synthetic';
              }

              return {
                type: 'impulse' as const,
                name: imp.name,
                visible,
                color: effectiveStrokeColor,
                baseline,
                lineStyle: {
                  width: stemWidth,
                  opacity,
                  color: effectiveStrokeColor,
                } satisfies ResolvedLineStyleConfig,
                showMarker,
                symbolSize,
                sampling: 'none' as const,
                rawData: imp.data,
                data: prevImp ? prevImp.data : imp.data,
                rawBounds,
                rawBoundsMode,
                yAxis,
                contentHash,
              };
            }
            default: {
              return assertUnreachable(s);
            }
          }
        })
        .filter((s) => s != null) as ResolvedSeriesConfig[]);

  // Stacked mountain/area: expand rawBounds so auto Y includes composition totals.
  // Skip when reusing entire series array (bounds already expanded on prior resolve).
  if (!canReuseEntireSeriesArray && series.some((s) => isStackedMountainSeries(s))) {
    applyStackedMountainBounds(series as ResolvedSeriesConfig[]);
  }

  return {
    coordinateSystem,
    camera,
    interaction3d,
    axes3d,
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
    // Create-time canvas / text-overlay DPR. Undefined → live window.devicePixelRatio on resize.
    devicePixelRatio: userOptions.devicePixelRatio,
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
