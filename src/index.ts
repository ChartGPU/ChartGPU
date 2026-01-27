/**
 * ChartGPU - A GPU-accelerated charting library built with WebGPU
 */

export const version = '1.0.0';

// Chart API (Phase 1)
import { ChartGPU as ChartGPUNamespace } from './ChartGPU';
import { createChartInWorker } from './worker/createChartInWorker';

// Export ChartGPU namespace with both create and createInWorker
export const ChartGPU = {
  ...ChartGPUNamespace,
  createInWorker: createChartInWorker,
};

export { createChartGPU as createChart } from './ChartGPU';
export type { ChartGPUInstance } from './ChartGPU';
export type {
  ChartGPUEventName,
  ChartGPUEventPayload,
  ChartGPUCrosshairMovePayload,
  ChartGPUEventCallback,
  ChartGPUCrosshairMoveCallback,
} from './ChartGPU';
export type {
  AreaStyleConfig,
  AnimationConfig,
  AxisConfig,
  AxisLabel,
  AxisType,
  BarItemStyleConfig,
  CandlestickItemStyleConfig,
  CandlestickSeriesConfig,
  CandlestickStyle,
  ChartGPUOptions,
  DataZoomConfig,
  DataPoint,
  GridConfig,
  LegendItem,
  LineStyleConfig,
  AreaSeriesConfig,
  LineSeriesConfig,
  BarSeriesConfig,
  NormalizedPointerEvent,
  PointerEventData,
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
  TooltipData,
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
  ResolvedSeriesConfig,
} from './config/OptionResolver';

// Themes
export type { ThemeConfig } from './themes/types';
export { darkTheme, lightTheme, getTheme } from './themes';
export type { ThemeName } from './themes';

// Scales - Pure utilities
export { createLinearScale, createCategoryScale } from './utils/scales';
export type { LinearScale, CategoryScale } from './utils/scales';

// Data utilities - Zero-copy transfer helpers
export { packDataPoints, packOHLCDataPoints } from './data/packDataPoints';

// Chart sync (interaction)
export { connectCharts } from './interaction/createChartSync';

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

// Render coordinator types
export type { RenderCoordinatorCallbacks } from './core/createRenderCoordinator';

// Class-based API (for backward compatibility)
export { RenderScheduler } from './core/RenderScheduler';

// Worker API - Main thread proxy and types
export { ChartGPUWorkerProxy } from './worker/ChartGPUWorkerProxy';
export { ChartGPUWorkerError, XY_STRIDE, OHLC_STRIDE } from './worker/types';
export type { WorkerConfig, PendingRequest, StrideBytes } from './worker/types';

// Worker protocol types (Main ↔ Worker communication)
export type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  InitMessage,
  SetOptionMessage,
  AppendDataMessage,
  AppendDataBatchMessage,
  ResizeMessage,
  ForwardPointerEventMessage,
  SetZoomRangeMessage,
  SetInteractionXMessage,
  SetAnimationMessage,
  DisposeMessage,
  ReadyMessage,
  RenderedMessage,
  TooltipUpdateMessage,
  LegendUpdateMessage,
  AxisLabelsUpdateMessage,
  WorkerEventPayload,
  HoverChangeMessage,
  ClickMessage,
  CrosshairMoveMessage,
  ZoomChangeMessage,
  DeviceLostMessage,
  DisposedMessage,
  ErrorMessage,
} from './worker/protocol';
