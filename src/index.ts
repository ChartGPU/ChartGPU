/**
 * ChartGPU - A GPU-accelerated charting library built with WebGPU
 */

export const version = '1.0.0';

// Chart API (Phase 1)
import { ChartGPU as ChartGPUNamespace } from './ChartGPU';

// Export ChartGPU namespace
export const ChartGPU = ChartGPUNamespace;

export { createChartGPU as createChart } from './ChartGPU';
export type { ChartGPUInstance } from './ChartGPU';
export type {
  ChartGPUEventName,
  ChartGPUEventPayload,
  ChartGPUCrosshairMovePayload,
  ChartGPUEventCallback,
  ChartGPUCrosshairMoveCallback,
  ChartGPUZoomRangeChangePayload,
  ChartGPUZoomRangeChangeCallback,
  ChartGPUDeviceLostPayload,
  ChartGPUDeviceLostCallback,
  ChartGPUCreateContext,
  ChartGPUHitTestMatch,
  ChartGPUHitTestResult,
  ZoomChangeSourceKind,
} from './ChartGPU';
export type {
  AnnotationConfig,
  AnnotationConfigBase,
  AnnotationLabel,
  AnnotationLabelAnchor,
  AnnotationLabelBackground,
  AnnotationLabelPadding,
  AnnotationLayer,
  AnnotationLineX,
  AnnotationLineY,
  AnnotationPoint,
  AnnotationPointMarker,
  AnnotationPosition,
  AnnotationStyle,
  AnnotationText,
  AreaStyleConfig,
  AnimationConfig,
  AxisConfig,
  AxisType,
  BarItemStyleConfig,
  CandlestickItemStyleConfig,
  CandlestickPriceLabelConfig,
  CandlestickSeriesConfig,
  CandlestickStyle,
  OhlcSeriesConfig,
  ChartGPUOptions,
  DataZoomConfig,
  DataPoint,
  GridConfig,
  GridLinesConfig,
  GridLinesDirectionConfig,
  LegendConfig,
  LegendPosition,
  LineStyleConfig,
  AreaSeriesConfig,
  LineSeriesConfig,
  BarSeriesConfig,
  PerformanceMetrics,
  OHLCDataPoint,
  PieCenter,
  PieDataItem,
  PieItemStyleConfig,
  PieRadius,
  PieSeriesConfig,
  HeatmapSeriesConfig,
  HeatmapData,
  HeatmapUpdate,
  HeatmapColormap,
  HeatmapNullHandling,
  BandSeriesConfig,
  BandSeriesData,
  BandDataPoint,
  BandDataPointTuple,
  BandDataPointObject,
  BandXYYArraysData,
  InterleavedXYYData,
  ErrorBarSeriesConfig,
  ErrorBarSeriesData,
  ErrorBarPointTuple,
  ErrorBarPointObject,
  ErrorBarHlcArraysData,
  ErrorBarRelativeArraysData,
  ErrorBarMode,
  ErrorBarDirection,
  ErrorBarItemStyleConfig,
  ImpulseSeriesConfig,
  StepMode,
  CoordinateSystem,
  Chart3DCameraOptions,
  Interaction3DOptions,
  Axes3DOptions,
  Axis3DOptions,
  PointCloud3DSeriesConfig,
  PointCloud3DData,
  PointCloud3DArraysData,
  InterleavedXYZData,
  Surface3DSeriesConfig,
  Surface3DGridData,
  Surface3DContourOptions,
  Surface3DUpdate,
  RenderMode,
  ScatterSeriesConfig,
  ScatterSymbol,
  ScatterPointTuple,
  SeriesConfig,
  SeriesSampling,
  SeriesType,
  TooltipConfig,
  TooltipParams,
} from './config/types';

// Options defaults + resolution
export {
  candlestickDefaults,
  ohlcDefaults,
  errorBarDefaults,
  impulseDefaults,
  defaultOptions,
  heatmapDefaults,
  pointCloud3dDefaults,
  surface3dDefaults,
  camera3dDefaults,
  interaction3dDefaults,
  axes3dDefaults,
} from './config/defaults';
export {
  isCandlePrimaryChart,
  isFinanceOhlcSeriesType,
  isFinanceOhlcSeries,
  OptionResolver,
  resolveOptions,
  resolvePriceLabel,
  isResolvedSeries2D,
} from './config/OptionResolver';
export type {
  FinanceOhlcSeriesType,
  ResolvedCandlestickPriceLabel,
  ResolvedCandlestickSeriesConfig,
  ResolvedOhlcSeriesConfig,
  ResolvedChartGPUOptions,
  ResolvedAreaSeriesConfig,
  ResolvedAreaStyleConfig,
  ResolvedGridConfig,
  ResolvedGridLinesConfig,
  ResolvedGridLinesDirectionConfig,
  ResolvedLineSeriesConfig,
  ResolvedLineStyleConfig,
  ResolvedPieDataItem,
  ResolvedPieSeriesConfig,
  ResolvedHeatmapSeriesConfig,
  ResolvedBandSeriesConfig,
  ResolvedErrorBarSeriesConfig,
  ResolvedImpulseSeriesConfig,
  ResolvedPointCloud3DSeriesConfig,
  ResolvedSurface3DSeriesConfig,
  ResolvedSeriesConfig,
  ResolvedSeriesConfig2D,
  ResolvedCamera3D,
  ResolvedInteraction3D,
  ResolvedAxes3D,
} from './config/OptionResolver';

export type { ResolvedCamera } from './core/3d/camera';

// Heatmap / colormap utilities (shared with scatter density)
export { buildColormapLut, sampleHeatmapColormap, getNamedColormapStops, colormapKey } from './utils/colormap';
export {
  heatmapGridBounds,
  heatmapGridPlacement,
  heatmapCellIndex,
  heatmapHitTest,
  computeHeatmapZExtent,
  normalizeZ,
  heatmapZContentStamp,
} from './utils/heatmapLayout';

// Themes
export type { ThemeConfig } from './themes/types';
export { darkTheme, lightTheme, getTheme } from './themes';
export type { ThemeName } from './themes';

// Scales - Pure utilities
export {
  createLinearScale,
  createLogScale,
  createAxisScale,
  createCategoryScale,
  normalizeLogBase,
  DEFAULT_LOG_BASE,
} from './utils/scales';
export type { LinearScale, ContinuousScale, CategoryScale } from './utils/scales';
export {
  generateLinearTicks,
  generateLogTicks,
  generateLogTicksForVisibleDomain,
  formatLogTickValue,
  createTickFormatter,
  formatTickValue,
} from './core/renderCoordinator/axis/computeAxisTicks';

// Chart sync (interaction)
export { connectCharts } from './interaction/createChartSync';
export type { ChartSyncOptions } from './interaction/createChartSync';

// Annotation authoring (interaction)
export { createAnnotationAuthoring } from './interaction/createAnnotationAuthoring';
export type { AnnotationAuthoringInstance, AnnotationAuthoringOptions } from './interaction/createAnnotationAuthoring';

// Core exports - Functional API (preferred)
export type { GPUContextState, GPUContextOptions, SupportedCanvas } from './core/GPUContext';
export {
  createGPUContext,
  createGPUContextAsync,
  initializeGPUContext,
  getCanvasTexture,
  clearScreen,
  destroyGPUContext,
} from './core/GPUContext';

// Class-based API (for backward compatibility)
export { GPUContext } from './core/GPUContext';

// Render scheduler - Functional API (preferred)
export type { RenderSchedulerState, RenderCallback } from './core/RenderScheduler';
export {
  createRenderScheduler,
  createRenderSchedulerAsync,
  startRenderScheduler,
  stopRenderScheduler,
  requestRender,
  destroyRenderScheduler,
} from './core/RenderScheduler';

// Class-based API (for backward compatibility)
export { RenderScheduler } from './core/RenderScheduler';

// Pipeline cache - Functional API
export type { PipelineCache, PipelineCacheStats } from './core/PipelineCache';
export { createPipelineCache, getPipelineCacheStats, destroyPipelineCache } from './core/createPipelineCache';

// Price label badge (DOM overlay + default formatter) — K15 public export
export { createPriceLabel } from './components/createPriceLabel';
export type { PriceLabel, PriceLabelUpdateState } from './components/createPriceLabel';
export { formatPriceLabelValue } from './core/renderCoordinator/ui/priceLabelHelpers';
