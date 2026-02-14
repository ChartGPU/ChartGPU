/**
 * Renderer pool management for the RenderCoordinator.
 *
 * Manages dynamic arrays of chart renderers with lazy instantiation and proper disposal.
 * Each chart type (line, area, scatter, etc.) maintains a pool of renderer instances
 * that grows/shrinks based on the number of series.
 *
 * @module rendererPool
 */

import { createAreaRenderer } from '../../../renderers/createAreaRenderer';
import { createLineRenderer } from '../../../renderers/createLineRenderer';
import { createScatterRenderer } from '../../../renderers/createScatterRenderer';
import { createScatterDensityRenderer } from '../../../renderers/createScatterDensityRenderer';
import { createPieRenderer } from '../../../renderers/createPieRenderer';
import { createCandlestickRenderer } from '../../../renderers/createCandlestickRenderer';
import { createBarRenderer } from '../../../renderers/createBarRenderer';
import type { PipelineCache } from '../../PipelineCache';

/**
 * Configuration for renderer pool creation.
 */
export interface RendererPoolConfig {
  readonly device: GPUDevice;
  readonly targetFormat: GPUTextureFormat;
  readonly pipelineCache?: PipelineCache;
}

/**
 * Renderer pool state exposed to the render coordinator.
 */
export interface RendererPoolState {
  readonly areaRenderers: ReadonlyArray<ReturnType<typeof createAreaRenderer>>;
  readonly lineRenderers: ReadonlyArray<ReturnType<typeof createLineRenderer>>;
  readonly scatterRenderers: ReadonlyArray<ReturnType<typeof createScatterRenderer>>;
  readonly scatterDensityRenderers: ReadonlyArray<ReturnType<typeof createScatterDensityRenderer>>;
  readonly pieRenderers: ReadonlyArray<ReturnType<typeof createPieRenderer>>;
  readonly candlestickRenderers: ReadonlyArray<ReturnType<typeof createCandlestickRenderer>>;
  readonly barRenderer: ReturnType<typeof createBarRenderer>;
}

/**
 * Renderer pool interface returned by factory function.
 */
export interface RendererPool {
  /**
   * Ensures area renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of area renderers
   */
  ensureAreaRendererCount(count: number): void;

  /**
   * Ensures line renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of line renderers
   */
  ensureLineRendererCount(count: number): void;

  /**
   * Ensures scatter renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of scatter renderers
   */
  ensureScatterRendererCount(count: number): void;

  /**
   * Ensures scatter density renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of scatter density renderers
   */
  ensureScatterDensityRendererCount(count: number): void;

  /**
   * Ensures pie renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of pie renderers
   */
  ensurePieRendererCount(count: number): void;

  /**
   * Ensures candlestick renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of candlestick renderers
   */
  ensureCandlestickRendererCount(count: number): void;

  /**
   * Gets current renderer pool state for rendering.
   * Returns readonly arrays to prevent external mutation.
   *
   * @returns Current state with all renderer arrays
   */
  getState(): RendererPoolState;

  /**
   * Disposes all renderers in the pool.
   * Clears all arrays and destroys GPU resources.
   */
  dispose(): void;
}

/**
 * Creates a renderer pool for dynamic renderer management.
 *
 * The renderer pool uses lazy instantiation: renderers are only created when
 * the pool grows, and are disposed when the pool shrinks. This allows the
 * render coordinator to efficiently handle varying numbers of series.
 *
 * **Architecture:**
 * - Each chart type has a dedicated renderer array
 * - Bar renderer is a singleton (not pooled)
 * - Renderers are disposed when removed from the pool
 * - Arrays are cleared to release references
 *
 * @param config - Configuration with device and target format
 * @returns Renderer pool instance
 */
export function createRendererPool(config: RendererPoolConfig): RendererPool {
  const { device, targetFormat, pipelineCache } = config;

  // Mutable renderer arrays (exposed as readonly externally)
  const areaRenderers: Array<ReturnType<typeof createAreaRenderer>> = [];
  const lineRenderers: Array<ReturnType<typeof createLineRenderer>> = [];
  const scatterRenderers: Array<ReturnType<typeof createScatterRenderer>> = [];
  const scatterDensityRenderers: Array<ReturnType<typeof createScatterDensityRenderer>> = [];
  const pieRenderers: Array<ReturnType<typeof createPieRenderer>> = [];
  const candlestickRenderers: Array<ReturnType<typeof createCandlestickRenderer>> = [];

  // Bar renderer is a singleton (one instance handles all bar series)
  const barRenderer = createBarRenderer(device, { targetFormat, pipelineCache });

  /**
   * Ensures area renderer count matches the given count.
   * Shrinks pool by popping and disposing excess renderers.
   * Grows pool by pushing new renderer instances.
   */
  function ensureAreaRendererCount(count: number): void {
    while (areaRenderers.length > count) {
      const r = areaRenderers.pop();
      r?.dispose();
    }
    while (areaRenderers.length < count) {
      areaRenderers.push(createAreaRenderer(device, { targetFormat, pipelineCache }));
    }
  }

  /**
   * Ensures line renderer count matches the given count.
   * Shrinks pool by popping and disposing excess renderers.
   * Grows pool by pushing new renderer instances.
   */
  function ensureLineRendererCount(count: number): void {
    while (lineRenderers.length > count) {
      const r = lineRenderers.pop();
      r?.dispose();
    }
    while (lineRenderers.length < count) {
      lineRenderers.push(createLineRenderer(device, { targetFormat, pipelineCache }));
    }
  }

  /**
   * Ensures scatter renderer count matches the given count.
   * Shrinks pool by popping and disposing excess renderers.
   * Grows pool by pushing new renderer instances.
   */
  function ensureScatterRendererCount(count: number): void {
    while (scatterRenderers.length > count) {
      const r = scatterRenderers.pop();
      r?.dispose();
    }
    while (scatterRenderers.length < count) {
      scatterRenderers.push(createScatterRenderer(device, { targetFormat, pipelineCache }));
    }
  }

  /**
   * Ensures scatter density renderer count matches the given count.
   * Shrinks pool by popping and disposing excess renderers.
   * Grows pool by pushing new renderer instances.
   */
  function ensureScatterDensityRendererCount(count: number): void {
    while (scatterDensityRenderers.length > count) {
      const r = scatterDensityRenderers.pop();
      r?.dispose();
    }
    while (scatterDensityRenderers.length < count) {
      scatterDensityRenderers.push(createScatterDensityRenderer(device, { targetFormat, pipelineCache }));
    }
  }

  /**
   * Ensures pie renderer count matches the given count.
   * Shrinks pool by popping and disposing excess renderers.
   * Grows pool by pushing new renderer instances.
   */
  function ensurePieRendererCount(count: number): void {
    while (pieRenderers.length > count) {
      const r = pieRenderers.pop();
      r?.dispose();
    }
    while (pieRenderers.length < count) {
      pieRenderers.push(createPieRenderer(device, { targetFormat, pipelineCache }));
    }
  }

  /**
   * Ensures candlestick renderer count matches the given count.
   * Shrinks pool by popping and disposing excess renderers.
   * Grows pool by pushing new renderer instances.
   */
  function ensureCandlestickRendererCount(count: number): void {
    while (candlestickRenderers.length > count) {
      const r = candlestickRenderers.pop();
      r?.dispose();
    }
    while (candlestickRenderers.length < count) {
      candlestickRenderers.push(createCandlestickRenderer(device, { targetFormat, pipelineCache }));
    }
  }

  /**
   * Gets current renderer pool state.
   * Returns readonly arrays to prevent external mutation.
   */
  function getState(): RendererPoolState {
    return {
      areaRenderers,
      lineRenderers,
      scatterRenderers,
      scatterDensityRenderers,
      pieRenderers,
      candlestickRenderers,
      barRenderer,
    };
  }

  /**
   * Disposes all renderers and clears arrays.
   * IMPORTANT: Also disposes scatterDensityRenderers which was missing in original code.
   */
  function dispose(): void {
    // Dispose area renderers
    for (let i = 0; i < areaRenderers.length; i++) {
      areaRenderers[i].dispose();
    }
    areaRenderers.length = 0;

    // Dispose line renderers
    for (let i = 0; i < lineRenderers.length; i++) {
      lineRenderers[i].dispose();
    }
    lineRenderers.length = 0;

    // Dispose scatter renderers
    for (let i = 0; i < scatterRenderers.length; i++) {
      scatterRenderers[i].dispose();
    }
    scatterRenderers.length = 0;

    // Dispose scatter density renderers (BUGFIX: was missing in original code)
    for (let i = 0; i < scatterDensityRenderers.length; i++) {
      scatterDensityRenderers[i].dispose();
    }
    scatterDensityRenderers.length = 0;

    // Dispose pie renderers
    for (let i = 0; i < pieRenderers.length; i++) {
      pieRenderers[i].dispose();
    }
    pieRenderers.length = 0;

    // Dispose candlestick renderers
    for (let i = 0; i < candlestickRenderers.length; i++) {
      candlestickRenderers[i].dispose();
    }
    candlestickRenderers.length = 0;

    // Dispose bar renderer (singleton)
    barRenderer.dispose();
  }

  return {
    ensureAreaRendererCount,
    ensureLineRendererCount,
    ensureScatterRendererCount,
    ensureScatterDensityRendererCount,
    ensurePieRendererCount,
    ensureCandlestickRendererCount,
    getState,
    dispose,
  };
}
