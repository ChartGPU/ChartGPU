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
  CandlestickSeriesConfig,
  CandlestickStyle,
  ChartGPUOptions,
  DataZoomConfig,
  DataPoint,
  GridConfig,
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
export { candlestickDefaults, defaultOptions } from './config/defaults';
export { OptionResolver, resolveOptions } from './config/OptionResolver';
export type {
  ResolvedCandlestickSeriesConfig,
  ResolvedChartGPUOptions,
  ResolvedAreaSeriesConfig,
  ResolvedAreaStyleConfig,
  ResolvedGridConfig,
  ResolvedLineSeriesConfig,
  ResolvedLineStyleConfig,
  ResolvedPieDataItem,
  ResolvedPieSeriesConfig,
  ResolvedSeriesConfig,
} from './config/OptionResolver';

// Themes
export type { ThemeConfig } from './themes/types';
export { darkTheme, lightTheme, getTheme } from './themes';
export type { ThemeName } from './themes';

// Scales - Pure utilities
export { createLinearScale, createCategoryScale } from './utils/scales';
export type { LinearScale, CategoryScale } from './utils/scales';

// Chart sync (interaction)
export { connectCharts } from './interaction/createChartSync';
export type { ChartSyncOptions } from './interaction/createChartSync';

// Annotation authoring (interaction)
export { createAnnotationAuthoring } from './interaction/createAnnotationAuthoring';
export type { AnnotationAuthoringInstance, AnnotationAuthoringOptions } from './interaction/createAnnotationAuthoring';

// Core exports - Functional API (preferred)
export type {
  GPUContextState,
  GPUContextOptions,
  SupportedCanvas,
} from './core/GPUContext';
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
