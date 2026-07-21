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
import { createHeatmapRenderer } from '../../../renderers/createHeatmapRenderer';
import { createCandlestickRenderer } from '../../../renderers/createCandlestickRenderer';
import { createOhlcRenderer } from '../../../renderers/createOhlcRenderer';
import { createBarRenderer } from '../../../renderers/createBarRenderer';
import { createBandRenderer } from '../../../renderers/createBandRenderer';
import { createDecimationCompute } from '../../../renderers/createDecimationCompute';
import type { PipelineCache } from '../../PipelineCache';
import type { ResolvedSeriesConfig } from '../../../config/OptionResolver';
import { GPU_DECIMATION_SAMPLING_MODES } from '../../../data/gpuDecimationEligibility';

/**
 * Configuration for renderer pool creation.
 */
interface RendererPoolConfig {
  readonly device: GPUDevice;
  readonly targetFormat: GPUTextureFormat;
  readonly pipelineCache?: PipelineCache;
  /**
   * Multisample count for all renderer pipelines.
   *
   * Must match the render pass color attachment sampleCount.
   * Defaults to 1 (no MSAA).
   */
  readonly sampleCount?: number;
}

/**
 * Renderer pool state exposed to the render coordinator.
 */
interface RendererPoolState {
  readonly areaRenderers: ReadonlyArray<ReturnType<typeof createAreaRenderer>>;
  readonly lineRenderers: ReadonlyArray<ReturnType<typeof createLineRenderer>>;
  readonly scatterRenderers: ReadonlyArray<ReturnType<typeof createScatterRenderer>>;
  readonly scatterDensityRenderers: ReadonlyArray<ReturnType<typeof createScatterDensityRenderer>>;
  readonly pieRenderers: ReadonlyArray<ReturnType<typeof createPieRenderer>>;
  readonly heatmapRenderers: ReadonlyArray<ReturnType<typeof createHeatmapRenderer>>;
  readonly candlestickRenderers: ReadonlyArray<ReturnType<typeof createCandlestickRenderer>>;
  readonly ohlcRenderers: ReadonlyArray<ReturnType<typeof createOhlcRenderer>>;
  readonly bandRenderers: ReadonlyArray<ReturnType<typeof createBandRenderer>>;
  /**
   * Per-line-series GPU decimation compute instances. Sized 1:1 with
   * `lineRenderers`. Ineligible series simply never call `.prepare()`.
   */
  readonly decimationComputes: ReadonlyArray<ReturnType<typeof createDecimationCompute>>;
  readonly barRenderer: ReturnType<typeof createBarRenderer>;
}

/**
 * Renderer pool interface returned by factory function.
 */
interface RendererPool {
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
   * Ensures heatmap renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of heatmap renderers
   */
  ensureHeatmapRendererCount(count: number): void;

  /**
   * Ensures band renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of band renderers
   */
  ensureBandRendererCount(count: number): void;

  /**
   * Ensures candlestick renderer count matches the given count.
   * Grows or shrinks the pool as needed, disposing excess renderers.
   *
   * @param count - Desired number of candlestick renderers
   */
  ensureCandlestickRendererCount(count: number): void;

  /**
   * Ensures OHLC bar renderer count matches the given count.
   */
  ensureOhlcRendererCount(count: number): void;

  /**
   * Ensures decimation compute count matches the given count. Kept in lock-step
   * with `ensureLineRendererCount` so `decimationComputes[i]` pairs with
   * `lineRenderers[i]`.
   */
  ensureDecimationComputeCount(count: number): void;

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
 * Per-type pool sizes for index-aligned renderer arrays.
 *
 * Arrays are still indexed by **series index** (not dense-by-type). When any
 * series of a type exists, that type's pool is sized to `series.length` so
 * `renderers.lineRenderers[i]` matches series i. Types that never appear get
 * size **0** — critical for group 1 pure multi-line (avoids allocating
 * area/scatter/pie/candle/decimation × N at create time).
 */
type RendererPoolNeeds = Readonly<{
  readonly seriesCount: number;
  readonly area: number;
  readonly line: number;
  readonly scatter: number;
  readonly scatterDensity: number;
  readonly pie: number;
  readonly heatmap: number;
  readonly band: number;
  readonly candlestick: number;
  readonly ohlc: number;
  readonly decimation: number;
}>;

/**
 * Compute type-aware pool sizes from resolved series.
 *
 * - Line+`areaStyle` also needs an area slot at the same index.
 * - Decimation pool only when any line uses a GPU-decimation sampling mode
 *   (`lttb`/`min`/`max`). `sampling: 'none'` charts (group 1) get **0**.
 */
function computeRendererPoolNeeds(series: ReadonlyArray<ResolvedSeriesConfig>): RendererPoolNeeds {
  const n = series.length;
  let anyArea = false;
  let anyLine = false;
  let anyScatter = false;
  let anyScatterDensity = false;
  let anyPie = false;
  let anyHeatmap = false;
  let anyBand = false;
  let anyCandle = false;
  let anyOhlc = false;
  let anyDecimation = false;

  for (let i = 0; i < n; i++) {
    const s = series[i]!;
    switch (s.type) {
      case 'line': {
        anyLine = true;
        if (s.areaStyle) anyArea = true;
        // Pool sizing is cheap — do not scan for null gaps; over-allocating
        // decimation when gaps force CPU path is rare vs under-alloc crash.
        if (GPU_DECIMATION_SAMPLING_MODES.has(s.sampling)) anyDecimation = true;
        break;
      }
      case 'area':
        anyArea = true;
        break;
      case 'scatter':
        if (s.mode === 'density') anyScatterDensity = true;
        else anyScatter = true;
        break;
      case 'pie':
        anyPie = true;
        break;
      case 'heatmap':
        anyHeatmap = true;
        break;
      case 'band':
        anyBand = true;
        break;
      case 'candlestick':
        anyCandle = true;
        break;
      case 'ohlc':
        anyOhlc = true;
        break;
      case 'bar':
        // Singleton bar renderer — no pool growth.
        break;
      default:
        break;
    }
  }

  return {
    seriesCount: n,
    area: anyArea ? n : 0,
    line: anyLine ? n : 0,
    scatter: anyScatter ? n : 0,
    scatterDensity: anyScatterDensity ? n : 0,
    pie: anyPie ? n : 0,
    heatmap: anyHeatmap ? n : 0,
    band: anyBand ? n : 0,
    candlestick: anyCandle ? n : 0,
    ohlc: anyOhlc ? n : 0,
    decimation: anyDecimation ? n : 0,
  };
}

/**
 * Grow/shrink all type pools to match {@link computeRendererPoolNeeds}.
 */
export function ensureRendererPoolsForSeries(
  pool: RendererPool,
  series: ReadonlyArray<ResolvedSeriesConfig>
): RendererPoolNeeds {
  const needs = computeRendererPoolNeeds(series);
  pool.ensureAreaRendererCount(needs.area);
  pool.ensureLineRendererCount(needs.line);
  pool.ensureDecimationComputeCount(needs.decimation);
  pool.ensureScatterRendererCount(needs.scatter);
  pool.ensureScatterDensityRendererCount(needs.scatterDensity);
  pool.ensurePieRendererCount(needs.pie);
  pool.ensureHeatmapRendererCount(needs.heatmap);
  pool.ensureBandRendererCount(needs.band);
  pool.ensureCandlestickRendererCount(needs.candlestick);
  pool.ensureOhlcRendererCount(needs.ohlc);
  return needs;
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
 * - Prefer {@link ensureRendererPoolsForSeries} so unused types stay at size 0
 *
 * @param config - Configuration with device and target format
 * @returns Renderer pool instance
 */
export function createRendererPool(config: RendererPoolConfig): RendererPool {
  const { device, targetFormat, pipelineCache, sampleCount } = config;

  // Mutable renderer arrays (exposed as readonly externally)
  const areaRenderers: Array<ReturnType<typeof createAreaRenderer>> = [];
  const lineRenderers: Array<ReturnType<typeof createLineRenderer>> = [];
  const scatterRenderers: Array<ReturnType<typeof createScatterRenderer>> = [];
  const scatterDensityRenderers: Array<ReturnType<typeof createScatterDensityRenderer>> = [];
  const pieRenderers: Array<ReturnType<typeof createPieRenderer>> = [];
  const heatmapRenderers: Array<ReturnType<typeof createHeatmapRenderer>> = [];
  const bandRenderers: Array<ReturnType<typeof createBandRenderer>> = [];
  const candlestickRenderers: Array<ReturnType<typeof createCandlestickRenderer>> = [];
  const ohlcRenderers: Array<ReturnType<typeof createOhlcRenderer>> = [];
  const decimationComputes: Array<ReturnType<typeof createDecimationCompute>> = [];

  // Bar renderer is a singleton (one instance handles all bar series)
  const barRenderer = createBarRenderer(device, {
    targetFormat,
    pipelineCache,
    sampleCount,
  });

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
      areaRenderers.push(
        createAreaRenderer(device, {
          targetFormat,
          pipelineCache,
          sampleCount,
        })
      );
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
      lineRenderers.push(
        createLineRenderer(device, {
          targetFormat,
          pipelineCache,
          sampleCount,
        })
      );
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
      scatterRenderers.push(
        createScatterRenderer(device, {
          targetFormat,
          pipelineCache,
          sampleCount,
        })
      );
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
      scatterDensityRenderers.push(
        createScatterDensityRenderer(device, {
          targetFormat,
          pipelineCache,
          sampleCount,
        })
      );
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
      pieRenderers.push(createPieRenderer(device, { targetFormat, pipelineCache, sampleCount }));
    }
  }

  function ensureHeatmapRendererCount(count: number): void {
    while (heatmapRenderers.length > count) {
      const r = heatmapRenderers.pop();
      r?.dispose();
    }
    while (heatmapRenderers.length < count) {
      heatmapRenderers.push(createHeatmapRenderer(device, { targetFormat, pipelineCache, sampleCount }));
    }
  }

  function ensureBandRendererCount(count: number): void {
    while (bandRenderers.length > count) {
      const r = bandRenderers.pop();
      r?.dispose();
    }
    while (bandRenderers.length < count) {
      bandRenderers.push(createBandRenderer(device, { targetFormat, pipelineCache, sampleCount }));
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
      candlestickRenderers.push(
        createCandlestickRenderer(device, {
          targetFormat,
          pipelineCache,
          sampleCount,
        })
      );
    }
  }

  function ensureOhlcRendererCount(count: number): void {
    while (ohlcRenderers.length > count) {
      const r = ohlcRenderers.pop();
      r?.dispose();
    }
    while (ohlcRenderers.length < count) {
      ohlcRenderers.push(
        createOhlcRenderer(device, {
          targetFormat,
          pipelineCache,
          sampleCount,
        })
      );
    }
  }

  /**
   * Ensures decimation compute count matches the given count.
   * Every line series gets a paired slot so decimationComputes[i] ↔ lineRenderers[i].
   */
  function ensureDecimationComputeCount(count: number): void {
    while (decimationComputes.length > count) {
      const r = decimationComputes.pop();
      r?.dispose();
    }
    while (decimationComputes.length < count) {
      decimationComputes.push(createDecimationCompute(device, { pipelineCache }));
    }
  }

  // Cached state object to avoid per-frame allocations.
  // Since the arrays are mutated in-place (push/pop), the cached object's
  // readonly references remain valid — we only need one allocation.
  let cachedState: RendererPoolState | null = null;

  /**
   * Gets current renderer pool state.
   * Returns a cached object with readonly array references to prevent
   * per-frame object allocations. The object is created once and reused
   * because the underlying arrays are mutated in-place.
   */
  function getState(): RendererPoolState {
    if (!cachedState) {
      cachedState = {
        areaRenderers,
        lineRenderers,
        scatterRenderers,
        scatterDensityRenderers,
        pieRenderers,
        heatmapRenderers,
        bandRenderers,
        candlestickRenderers,
        ohlcRenderers,
        decimationComputes,
        barRenderer,
      };
    }
    return cachedState;
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

    // Dispose heatmap renderers
    for (let i = 0; i < heatmapRenderers.length; i++) {
      heatmapRenderers[i].dispose();
    }
    heatmapRenderers.length = 0;

    // Dispose band renderers
    for (let i = 0; i < bandRenderers.length; i++) {
      bandRenderers[i].dispose();
    }
    bandRenderers.length = 0;

    // Dispose candlestick renderers
    for (let i = 0; i < candlestickRenderers.length; i++) {
      candlestickRenderers[i].dispose();
    }
    candlestickRenderers.length = 0;

    // Dispose OHLC bar renderers
    for (let i = 0; i < ohlcRenderers.length; i++) {
      ohlcRenderers[i].dispose();
    }
    ohlcRenderers.length = 0;

    // Dispose decimation compute instances
    for (let i = 0; i < decimationComputes.length; i++) {
      decimationComputes[i].dispose();
    }
    decimationComputes.length = 0;

    // Dispose bar renderer (singleton)
    barRenderer.dispose();
  }

  return {
    ensureAreaRendererCount,
    ensureLineRendererCount,
    ensureScatterRendererCount,
    ensureScatterDensityRendererCount,
    ensurePieRendererCount,
    ensureHeatmapRendererCount,
    ensureBandRendererCount,
    ensureCandlestickRendererCount,
    ensureOhlcRendererCount,
    ensureDecimationComputeCount,
    getState,
    dispose,
  };
}
