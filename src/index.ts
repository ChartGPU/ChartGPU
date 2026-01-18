/**
 * ChartGPU - A GPU-accelerated charting library built with WebGPU
 */

export const version = '1.0.0';

// Chart API (Phase 1)
export { ChartGPU } from './ChartGPU';
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
  BarItemStyleConfig,
  AxisConfig,
  AxisType,
  ChartGPUOptions,
  DataPoint,
  GridConfig,
  LineStyleConfig,
  AreaSeriesConfig,
  LineSeriesConfig,
  BarSeriesConfig,
  ScatterSeriesConfig,
  ScatterSymbol,
  ScatterPointTuple,
  SeriesConfig,
  SeriesType,
  TooltipParams,
} from './config/types';

// Options defaults + resolution
export { defaultOptions } from './config/defaults';
export { OptionResolver, resolveOptions } from './config/OptionResolver';
export type {
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

// Chart sync (interaction)
export { connectCharts } from './interaction/createChartSync';

// Core exports - Functional API (preferred)
export type { GPUContextState } from './core/GPUContext';
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
