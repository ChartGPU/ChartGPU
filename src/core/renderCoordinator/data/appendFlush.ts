/**
 * Append flush ownership — pending-append flush for the render coordinator.
 * Uses a single deps bag (d) for all closed-over state/helpers.
 * @module appendFlush
 * @internal
 */

import type { ResolvedChartGPUOptions } from '../../../config/OptionResolver';
import type { BandSeriesData, CartesianSeriesData, ErrorBarSeriesData, OHLCDataPoint } from '../../../config/types';
import type { ZoomRange } from '../../../interaction/createZoomState';
import type { DataStore } from '../../../data/createDataStore';
import type { DataStoreBufferKind, CanRangedAppendLineInput } from './canRangedAppendLine';
import {
  appendBandIntoXYYColumns,
  asBandXYYArrays,
  bandBounds,
  bandDataToMutableXYY,
  extendBoundsWithBandData,
  getBandLength,
  isBandShapedPayload,
} from '../../../data/bandData';
import {
  appendErrorBarIntoHlcColumns,
  asErrorBarHlcArrays,
  errorBarBounds,
  errorBarDataToMutableHlc,
  extendBoundsWithErrorBarData,
  getErrorBarLength,
  isErrorBarShapedPayload,
  type MutableErrorBarHlcColumns,
} from '../../../data/errorBarData';
import { impulseBounds } from '../../../data/impulseGeometry';

/** Fold impulse baseline into auto-Y bounds after cartesian extend/rescan. */
function foldImpulseBaseline(
  series: { readonly type?: string; readonly baseline?: number },
  data: CartesianSeriesData,
  current: AppendFlushBounds | null | undefined
): AppendFlushBounds | null | undefined {
  if (series.type !== 'impulse') return current ?? undefined;
  const baseline = typeof series.baseline === 'number' && Number.isFinite(series.baseline) ? series.baseline : 0;
  // Full rescan includes all retained y + baseline (correct after FIFO drop).
  const full = impulseBounds(data, baseline);
  if (full) return full;
  if (!current) return undefined;
  let yMin = current.yMin;
  let yMax = current.yMax;
  if (baseline < yMin) yMin = baseline;
  if (baseline > yMax) yMax = baseline;
  return { xMin: current.xMin, xMax: current.xMax, yMin, yMax };
}

/** Pending append batch stored per series index. */
type PendingAppendBatch = {
  readonly points: CartesianSeriesData | ReadonlyArray<OHLCDataPoint> | BandSeriesData | ErrorBarSeriesData;
  readonly maxPoints?: number;
};

/** Bounds slot used by flush for domain extension. */
type AppendFlushBounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
} | null;

/**
 * Typed dependency bag for the owned append flush.
 *
 * Structural types are intentionally wide where coordinator helpers differ
 * slightly (e.g. normalizeMaxPoints null vs undefined). Call site uses
 * `as AppendFlushDeps` after assembling live bindings.
 */
export interface AppendFlushDeps {
  pendingAppendByIndex: Map<number, PendingAppendBatch[]>;
  appendedGpuThisFrame: Set<number>;
  zoomState: {
    getRange: () => ZoomRange | null;
    setRange: (start: number, end: number) => void;
    setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
    setRangeAnchored?: (start: number, end: number, anchor: 'start' | 'end' | 'center') => void;
  } | null;
  currentOptions: ResolvedChartGPUOptions;
  dataStore: DataStore;
  /** Runtime raw slots (columns / ring / staging / OHLC). */
  runtimeRawDataByIndex: unknown[];
  runtimeRawBoundsByIndex: AppendFlushBounds[];
  gpuSeriesKindByIndex: DataStoreBufferKind[];
  lastSetSeriesCache: Map<number, { data: unknown; xOffset: number }>;
  filterGapsCache: { delete: (index: number) => void; clear?: () => void };
  /**
   * Invalidate stacked mountain prepare cache (and similar peer caches) when
   * append mutates data under stable refs / grows columns.
   */
  invalidateStackedMountainCache?: () => void;
  /** Invalidate step (digital) expand identity cache on append. */
  invalidateStepExpandCache?: () => void;
  lastSampledData: unknown[];
  warnedSamplingDefeatsFastPath: Set<number>;
  recomputeRuntimeBaseSeries: () => void;
  recomputeCachedVisibleYBoundsIfNeeded: () => void;
  ensureMutableRuntimeColumns: (seriesIndex: number, s: unknown) => unknown;
  isOwnedMutableColumns: (data: unknown) => boolean;
  brandOwnedColumns: (cols: unknown) => unknown;
  computeBaseXDomain: (options: ResolvedChartGPUOptions, bounds: unknown) => { min: number; max: number };
  computeVisibleXDomain: (
    base: { min: number; max: number },
    zoom: ZoomRange | null
  ) => { min: number; max: number; spanFraction: number };
  isFullSpanZoomRange: (range: ZoomRange | null) => boolean;
  computeEffectiveZoomSpanConstraints: () => { minSpan?: number; maxSpan?: number };
  extendBoundsWithCartesianData: (b: unknown, data: unknown) => unknown;
  extendBoundsWithOHLCDataPoints: (b: unknown, points: unknown) => unknown;
  canRangedAppendLine: (input: CanRangedAppendLineInput) => boolean;
  isGpuDecimationEligible: (series: unknown, raw: unknown) => boolean;
  normalizeMaxPoints: (maxPoints?: number | null) => number | null | undefined;
  planMaxPointsWindow: (
    prevLen: number,
    newCount: number,
    maxPoints?: number | null
  ) => {
    didWindow: boolean;
    dropPrevCount: number;
    keepNewCount: number;
    newSrcOffset: number;
    isRing: boolean;
    ringCapacity: number;
    [key: string]: unknown;
  };
  getPointCount: (data: unknown) => number;
  getX: (data: unknown, i: number) => number;
  getY: (data: unknown, i: number) => number;
  getSize: (data: unknown, i: number) => number | undefined;
  createRingXYColumns: (capacity: number, withSize?: boolean) => unknown;
  appendIntoRingXY: (
    ring: unknown,
    data: unknown,
    newSrcOffset: number,
    keepNewCount: number,
    dropPrevCount: number
  ) => void;
  dropPrefixXY: (x: number[], y: number[], drop: number, size?: unknown) => void;
  createStagingRingView: (...args: unknown[]) => unknown;
  isRingXYColumns: (data: unknown) => boolean;
  isStagingRingView: (data: unknown) => boolean;
  demoteStagingViewAfterRebindFailure: (raw: unknown) => unknown;
  computeRawBoundsFromCartesianData: (data: unknown) => unknown;
  runtimeBaseSeries: ResolvedChartGPUOptions['series'];
  renderSeries: ResolvedChartGPUOptions['series'];
  pendingZoomSourceKind: unknown;
}

/**
 * Owned flush implementation. Mutates d.runtime* / d.pending* fields in place.
 * Public entry requires {@link AppendFlushDeps}; the mutation loop uses a
 * structural bag for ring/staging casts (opaque helper returns).
 */
function flushPendingAppendsImpl(d: AppendFlushDeps): boolean {
  return flushPendingAppendsImplInner(d);
}

/** @internal Ring/staging mutation loop — entry point is {@link flushPendingAppendsImpl}. */
function flushPendingAppendsImplInner(d: any): boolean {
  if (d.pendingAppendByIndex.size === 0) return false;

  d.appendedGpuThisFrame.clear();
  // Append grows / mutates peer data under stable refs — stack baselines must recompute.
  if (typeof d.invalidateStackedMountainCache === 'function') {
    d.invalidateStackedMountainCache();
  }
  if (typeof d.invalidateStepExpandCache === 'function') {
    d.invalidateStepExpandCache();
  }

  const zoomRangeBefore = d.zoomState?.getRange() ?? null;
  const canAutoScroll =
    d.currentOptions.autoScroll === true &&
    d.zoomState != null &&
    d.currentOptions.xAxis.min == null &&
    d.currentOptions.xAxis.max == null;

  // Capture pre-append visible domain so we can preserve it for "panned away" behavior.
  const prevBaseXDomain = d.computeBaseXDomain(d.currentOptions, d.runtimeRawBoundsByIndex);
  const prevVisibleXDomain = zoomRangeBefore ? d.computeVisibleXDomain(prevBaseXDomain, zoomRangeBefore) : null;

  let didAppendAny = false;

  for (const [seriesIndex, batches] of d.pendingAppendByIndex) {
    if (batches.length === 0) continue;
    const s = d.currentOptions.series[seriesIndex];
    if (!s || s.type === 'pie' || s.type === 'heatmap') continue;
    didAppendAny = true;

    if (s.type === 'candlestick' || s.type === 'ohlc') {
      // Handle candlestick OHLC data.
      let raw = d.runtimeRawDataByIndex[seriesIndex] as OHLCDataPoint[] | null;
      if (!raw) {
        const seed = (s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>;
        raw = seed.length === 0 ? [] : seed.slice();
        d.runtimeRawDataByIndex[seriesIndex] = raw;
        d.runtimeRawBoundsByIndex[seriesIndex] = s.rawBounds ?? null;
      }

      let didWindow = false;
      for (const batch of batches) {
        const ohlcPoints = batch.points as ReadonlyArray<OHLCDataPoint>;
        const maxPoints = d.normalizeMaxPoints(batch.maxPoints);
        const prevLen = raw.length;
        const plan = d.planMaxPointsWindow(prevLen, ohlcPoints.length, maxPoints);
        if (plan.dropPrevCount > 0) {
          raw.splice(0, plan.dropPrevCount);
          didWindow = true;
        }
        if (plan.keepNewCount > 0) {
          const start = plan.newSrcOffset;
          const end = start + plan.keepNewCount;
          for (let i = start; i < end; i++) {
            raw.push(ohlcPoints[i]!);
          }
        }
        if (!plan.didWindow) {
          d.runtimeRawBoundsByIndex[seriesIndex] = d.extendBoundsWithOHLCDataPoints(
            d.runtimeRawBoundsByIndex[seriesIndex],
            ohlcPoints
          );
        } else {
          didWindow = true;
        }
      }
      if (didWindow) {
        // Windowing can invalidate prior y/x extrema — full rescan.
        d.runtimeRawBoundsByIndex[seriesIndex] = d.extendBoundsWithOHLCDataPoints(null, raw);
      }
    } else if (s.type === 'band') {
      // Band Xyy columns (private GPU buffer re-packs on prepare).
      type BandCols = { x: number[]; y: number[]; y1: number[] };
      let cols = d.runtimeRawDataByIndex[seriesIndex] as BandCols | null;
      if (!cols || !('y1' in cols)) {
        const seed = (s.rawData ?? s.data) as BandSeriesData;
        cols = bandDataToMutableXYY(seed);
        d.runtimeRawDataByIndex[seriesIndex] = asBandXYYArrays(cols);
        d.runtimeRawBoundsByIndex[seriesIndex] = s.rawBounds ?? bandBounds(seed) ?? null;
      } else {
        // Ensure mutable arrays (runtime may hold readonly views)
        cols = {
          x: Array.isArray(cols.x) ? cols.x : Array.from(cols.x as ArrayLike<number>),
          y: Array.isArray(cols.y) ? cols.y : Array.from(cols.y as ArrayLike<number>),
          y1: Array.isArray(cols.y1) ? cols.y1 : Array.from(cols.y1 as ArrayLike<number>),
        };
        d.runtimeRawDataByIndex[seriesIndex] = asBandXYYArrays(cols);
      }

      let didWindow = false;
      for (const batch of batches) {
        const bandPoints = batch.points as BandSeriesData;
        if (!isBandShapedPayload(bandPoints)) {
          console.warn(
            `RenderCoordinator.appendData(${seriesIndex}, ...): band series requires Xyy payloads. Skipping batch.`
          );
          continue;
        }
        const maxPoints = d.normalizeMaxPoints(batch.maxPoints);
        const appendN = getBandLength(bandPoints);
        if (appendN === 0) continue;
        const prevLen = cols.x.length;
        const plan = d.planMaxPointsWindow(prevLen, appendN, maxPoints);
        if (plan.dropPrevCount > 0) {
          cols.x.splice(0, plan.dropPrevCount);
          cols.y.splice(0, plan.dropPrevCount);
          cols.y1.splice(0, plan.dropPrevCount);
          didWindow = true;
        }
        appendBandIntoXYYColumns(cols, bandPoints, {
          newSrcOffset: plan.newSrcOffset,
          keepNewCount: plan.keepNewCount,
        });
        if (!plan.didWindow) {
          d.runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithBandData(
            d.runtimeRawBoundsByIndex[seriesIndex],
            bandPoints
          );
        } else {
          didWindow = true;
        }
      }
      d.runtimeRawDataByIndex[seriesIndex] = asBandXYYArrays(cols);
      if (didWindow) {
        d.runtimeRawBoundsByIndex[seriesIndex] = bandBounds(asBandXYYArrays(cols));
      }
    } else if (s.type === 'errorBar') {
      // Error-bar HLC columns (private GPU instance buffer re-packs on prepare).
      let cols = d.runtimeRawDataByIndex[seriesIndex] as MutableErrorBarHlcColumns | null;
      const direction =
        (s as { direction?: 'vertical' | 'horizontal' }).direction === 'horizontal' ? 'horizontal' : 'vertical';
      if (!cols || !('high' in cols) || !('low' in cols)) {
        const seed = (s.rawData ?? s.data) as ErrorBarSeriesData;
        cols = errorBarDataToMutableHlc(seed);
        d.runtimeRawDataByIndex[seriesIndex] = asErrorBarHlcArrays(cols);
        d.runtimeRawBoundsByIndex[seriesIndex] = s.rawBounds ?? errorBarBounds(seed, direction) ?? null;
      } else {
        cols = {
          x: Array.isArray(cols.x) ? cols.x : Array.from(cols.x as ArrayLike<number>),
          y: Array.isArray(cols.y) ? cols.y : Array.from(cols.y as ArrayLike<number>),
          high: Array.isArray(cols.high) ? cols.high : Array.from(cols.high as ArrayLike<number>),
          low: Array.isArray(cols.low) ? cols.low : Array.from(cols.low as ArrayLike<number>),
        };
        d.runtimeRawDataByIndex[seriesIndex] = asErrorBarHlcArrays(cols);
      }

      let didWindow = false;
      for (const batch of batches) {
        const ebPoints = batch.points as ErrorBarSeriesData;
        if (!isErrorBarShapedPayload(ebPoints)) {
          console.warn(
            `RenderCoordinator.appendData(${seriesIndex}, ...): errorBar series requires HLC or relative-error payloads. Skipping batch.`
          );
          continue;
        }
        const maxPoints = d.normalizeMaxPoints(batch.maxPoints);
        const appendN = getErrorBarLength(ebPoints);
        if (appendN === 0) continue;
        const prevLen = cols.x.length;
        const plan = d.planMaxPointsWindow(prevLen, appendN, maxPoints);
        if (plan.dropPrevCount > 0) {
          cols.x.splice(0, plan.dropPrevCount);
          cols.y.splice(0, plan.dropPrevCount);
          cols.high.splice(0, plan.dropPrevCount);
          cols.low.splice(0, plan.dropPrevCount);
          didWindow = true;
        }
        appendErrorBarIntoHlcColumns(cols, ebPoints, {
          newSrcOffset: plan.newSrcOffset,
          keepNewCount: plan.keepNewCount,
        });
        if (!plan.didWindow) {
          d.runtimeRawBoundsByIndex[seriesIndex] = extendBoundsWithErrorBarData(
            d.runtimeRawBoundsByIndex[seriesIndex],
            ebPoints,
            direction
          );
        } else {
          didWindow = true;
        }
      }
      d.runtimeRawDataByIndex[seriesIndex] = asErrorBarHlcArrays(cols);
      if (didWindow) {
        d.runtimeRawBoundsByIndex[seriesIndex] = errorBarBounds(asErrorBarHlcArrays(cols), direction);
      }
    } else {
      // Handle other cartesian series (line, area, bar, scatter).
      // Optional fast-path: append just the new points when the DataStore buffer
      // holds full raw line data (sampling='none' any zoom, or GPU decimation raw).
      const kind = d.gpuSeriesKindByIndex[seriesIndex] ?? 'unknown';
      const existingRuntime = d.runtimeRawDataByIndex[seriesIndex] as CartesianSeriesData | null;
      const rawForAppend = existingRuntime ?? ((s.rawData ?? s.data) as CartesianSeriesData);
      const canUseFastPath = d.canRangedAppendLine({
        seriesType: s.type,
        sampling: (s as { sampling?: string }).sampling as any,
        kind,
        rawData: rawForAppend,
        series: s as any,
      });

      // Thin path = GPU append fast path: bind coordinator raw to DataStore
      // staging (zero-copy) instead of dual-packing into any /
      // growing any every frame.
      const useStagingThinPath = canUseFastPath;

      // setOption rewrite may store a raw DataPoint[] ref — promote before mutate
      // (unless thin path will replace the slot with a staging view).
      let raw: any = null;
      if (!useStagingThinPath) {
        raw = d.ensureMutableRuntimeColumns(seriesIndex, s);
      } else if (d.isStagingRingView(existingRuntime)) {
        raw = existingRuntime;
      } else if (d.isRingXYColumns(existingRuntime)) {
        raw = existingRuntime;
      }

      let didWindow = false;
      for (const batch of batches) {
        const cartesianData = batch.points as CartesianSeriesData;
        const maxPoints = d.normalizeMaxPoints(batch.maxPoints);
        const appendGpuOptions = maxPoints != null ? ({ maxPoints } as const) : undefined;

        // prevLen for d.planMaxPointsWindow: staging view / ring / linear / DataStore.
        let prevLen = 0;
        if (d.isStagingRingView(raw)) {
          prevLen = raw.count;
        } else if (d.isRingXYColumns(raw)) {
          prevLen = raw.count;
        } else if (raw != null && d.isOwnedMutableColumns(raw)) {
          prevLen = (raw as any).x.length;
        } else {
          try {
            prevLen = d.dataStore.getSeriesPointCount(seriesIndex);
          } catch {
            prevLen = existingRuntime ? d.getPointCount(existingRuntime) : 0;
          }
        }

        // Effective window after GPU append may be device-derived when caller
        // omitted maxPoints (storage binding auto-window). Dual-store must match.
        let effectiveMaxPoints = maxPoints;
        if (canUseFastPath) {
          try {
            // Pass CartesianSeriesData directly to DataStore (avoids per-point allocations).
            // Shared d.planMaxPointsWindow policy keeps GPU length in sync with columns below.
            d.dataStore.appendSeries(seriesIndex, cartesianData, appendGpuOptions);
            d.appendedGpuThisFrame.add(seriesIndex);
            if (effectiveMaxPoints == null) {
              try {
                const deviceCap = d.dataStore.getSeriesEffectiveMaxPoints(seriesIndex);
                if (deviceCap != null && deviceCap > 0) {
                  // Prefer tighter of caller (none) and device — device is the only cap.
                  effectiveMaxPoints = deviceCap;
                }
              } catch {
                // Series missing — ignore.
              }
            } else {
              // Caller maxPoints still hard-clamped by device when tighter.
              try {
                const deviceCap = d.dataStore.getSeriesEffectiveMaxPoints(seriesIndex);
                if (deviceCap != null && deviceCap > 0 && deviceCap < effectiveMaxPoints) {
                  effectiveMaxPoints = deviceCap;
                }
              } catch {
                // ignore
              }
            }
          } catch (err) {
            // Cold path: DataStore has no series yet ("Call setSeries first") — fall
            // through to dual-pack + full upload on prepare. Device capacity errors
            // must NOT fall through: that grew CPU/domain past GPU-resident data
            // (empty-right gutter at ~16.7M pts / 128 MiB). Unbounded oversize is
            // normally auto-windowed in DataStore; if a hard-cap throw still escapes,
            // skip the batch so domain stays tied to GPU data.
            const msg = err instanceof Error ? err.message : String(err);
            const isDeviceCapacity = /maxStorageBufferBindingSize|maxBufferSize|required buffer size/i.test(msg);
            if (isDeviceCapacity) {
              if (typeof console !== 'undefined' && typeof console.warn === 'function') {
                console.warn(
                  `[ChartGPU] appendData() hit device buffer limit for series ${seriesIndex}; ` +
                    `skipping batch to keep domain in sync with GPU-resident data.`,
                  err
                );
              }
              continue;
            }
            // Recoverable (cold series / other): dual-pack below + setSeries later.
          }
        } else if (
          (s.type === 'line' || s.type === 'area') &&
          s.sampling !== 'none' &&
          !canUseFastPath &&
          !d.warnedSamplingDefeatsFastPath.has(seriesIndex)
        ) {
          // Warn users that sampling defeats the incremental append optimization.
          // Pure area is never GPU-decimation eligible — only recommend sampling='none'.
          d.warnedSamplingDefeatsFastPath.add(seriesIndex);
          const advice =
            s.type === 'area'
              ? `For optimal streaming performance, use sampling='none'. `
              : `For optimal streaming performance, use sampling='none' or rely on GPU decimation for lttb/min/max. `;
          console.warn(
            `[ChartGPU] appendData() on series ${seriesIndex} with sampling='${s.sampling}' causes full buffer re-upload every frame. ` +
              advice +
              `See docs/internal/INCREMENTAL_APPEND_OPTIMIZATION.md for details.`
          );
        }

        // Thin path: after GPU modular/ranged append, point coordinator raw at
        // staging (no RingXY / MutableXY dual-pack). Bounds from O(1) endpoints
        // + new-batch y. FIFO (maxPoints) and unbounded pure growth both qualify.
        if (useStagingThinPath && d.appendedGpuThisFrame.has(seriesIndex)) {
          const n = d.getPointCount(cartesianData);
          const plan = d.planMaxPointsWindow(prevLen, n, effectiveMaxPoints);
          try {
            const layout = d.dataStore.getSeriesRingLayout(seriesIndex);
            const staging = d.dataStore.getSeriesStagingBuffer(seriesIndex);
            const count = d.dataStore.getSeriesPointCount(seriesIndex);
            const xOffset = d.dataStore.getSeriesXOffset(seriesIndex);
            const prevView = d.isStagingRingView(raw) ? raw : null;
            raw = d.createStagingRingView(staging, layout.start, layout.capacity, count, xOffset, prevView);
            d.runtimeRawDataByIndex[seriesIndex] = raw;

            // O(1) x endpoints from any (staging is mirrored) +
            // O(append) y scan of the new batch. Never shrinks y on drop —
            // same conservative product policy as any path.
            const x0 = d.getX(raw as unknown as CartesianSeriesData, 0);
            const x1 = d.getX(raw as unknown as CartesianSeriesData, Math.max(0, count - 1));
            const prevB = d.runtimeRawBoundsByIndex[seriesIndex];
            let yMin = prevB?.yMin ?? Number.POSITIVE_INFINITY;
            let yMax = prevB?.yMax ?? Number.NEGATIVE_INFINITY;
            const end = plan.newSrcOffset + plan.keepNewCount;
            // FIFO / compression suite: shared Float64 y columns — scan column
            // directly (avoid d.getY dispatch × large append batches / frame).
            const yCol =
              typeof cartesianData === 'object' &&
              cartesianData !== null &&
              !Array.isArray(cartesianData) &&
              !d.isStagingRingView(cartesianData) &&
              !d.isRingXYColumns(cartesianData) &&
              'y' in cartesianData
                ? (cartesianData as { y: ArrayLike<number> }).y
                : null;
            if (yCol != null) {
              for (let i = plan.newSrcOffset; i < end; i++) {
                const y = yCol[i] as number;
                if (Number.isFinite(y)) {
                  if (y < yMin) yMin = y;
                  if (y > yMax) yMax = y;
                }
              }
            } else {
              for (let i = plan.newSrcOffset; i < end; i++) {
                const y = d.getY(cartesianData, i);
                if (Number.isFinite(y)) {
                  if (y < yMin) yMin = y;
                  if (y > yMax) yMax = y;
                }
              }
            }
            if (Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(yMin) && Number.isFinite(yMax)) {
              let xMin = x0;
              let xMax = x1;
              if (xMin === xMax) xMax = xMin + 1;
              if (yMin === yMax) yMax = yMin + 1;
              d.runtimeRawBoundsByIndex[seriesIndex] = {
                xMin,
                xMax,
                yMin,
                yMax,
              };
            } else if (plan.didWindow) {
              didWindow = true;
            }
          } catch {
            // DataStore not ready or rebind failed after append — demote any
            // stale any so fallthrough dual-pack can re-sync.
            raw = d.demoteStagingViewAfterRebindFailure(raw);
          }
          if (d.isStagingRingView(raw)) {
            continue;
          }
        }

        // Full column path (thin path ineligible / rebind failed).
        if (raw == null || d.isStagingRingView(raw)) {
          raw = d.ensureMutableRuntimeColumns(seriesIndex, s);
        }

        // Update runtime columnar storage with the same window policy as DataStore
        // (including device auto-window effectiveMaxPoints).
        const n = d.getPointCount(cartesianData);
        let plan = d.planMaxPointsWindow(prevLen, n, effectiveMaxPoints);

        // Leave-ring or capacity mismatch: demote RingXY → chronological linear
        // so we match DataStore rebuild (linearize + ringStart=0).
        if (d.isRingXYColumns(raw)) {
          const capMismatch = plan.isRing && plan.ringCapacity > 0 && raw.capacity !== plan.ringCapacity;
          if (!plan.isRing || capMismatch) {
            // Preserve size channel on demote so re-promote keeps per-point radii (1.4).
            const hasSize = raw.size != null;
            const demoted = d.brandOwnedColumns({
              x: [] as number[],
              y: [] as number[],
              ...(hasSize ? { size: [] as (number | undefined)[] } : {}),
            }) as { x: number[]; y: number[]; size?: (number | undefined)[] };
            const count = raw.count;
            for (let i = 0; i < count; i++) {
              demoted.x.push(d.getX(raw as unknown as CartesianSeriesData, i));
              demoted.y.push(d.getY(raw as unknown as CartesianSeriesData, i));
              if (hasSize && demoted.size) {
                const sz = d.getSize(raw as unknown as CartesianSeriesData, i);
                demoted.size.push(sz);
              }
            }
            raw = demoted;
            d.runtimeRawDataByIndex[seriesIndex] = demoted;
            prevLen = demoted.x.length;
            plan = d.planMaxPointsWindow(prevLen, n, effectiveMaxPoints);
          }
        }

        // Promote to modular ring when maxPoints / device window is active so
        // steady-state FIFO is O(append) on CPU columns (no O(n) dropPrefix every frame).
        if (plan.isRing && plan.ringCapacity > 0 && !d.isRingXYColumns(raw)) {
          const linear = raw as any;
          const hasSize =
            Array.isArray(linear.size) &&
            linear.size.some((v: unknown) => typeof v === 'number' && Number.isFinite(v as number));
          const ring = d.createRingXYColumns(plan.ringCapacity, hasSize);
          // Tail of linear matches d.planMaxPointsWindow drop semantics when
          // prevCount > capacity (keep last min(prev, cap) before packing new).
          const seedCount = Math.min(linear.x.length, plan.ringCapacity);
          const seedStart = Math.max(0, linear.x.length - seedCount);
          for (let i = 0; i < seedCount; i++) {
            ring.x[i] = linear.x[seedStart + i]!;
            ring.y[i] = linear.y[seedStart + i]!;
            if (ring.size && linear.size) {
              const sv = linear.size[seedStart + i];
              ring.size[i] = typeof sv === 'number' && Number.isFinite(sv) ? sv : Number.NaN;
            }
          }
          ring.count = seedCount;
          ring.start = 0;
          raw = ring;
          d.runtimeRawDataByIndex[seriesIndex] = ring;
          // Re-plan against the ring's current length (may have trimmed seed).
          const plan2 = d.planMaxPointsWindow(ring.count, n, effectiveMaxPoints);
          d.appendIntoRingXY(ring, cartesianData, plan2.newSrcOffset, plan2.keepNewCount, plan2.dropPrevCount);
          if (plan2.didWindow) {
            // Promote+window: cheap endpoint bounds (same as steady ring path).
            // Note: y-range never shrinks on drop (O(1) conservative); x uses ends.
            const x0 = d.getX(ring as unknown as CartesianSeriesData, 0);
            const x1 = d.getX(ring as unknown as CartesianSeriesData, ring.count - 1);
            const prevB = d.runtimeRawBoundsByIndex[seriesIndex];
            let yMin = prevB?.yMin ?? Number.POSITIVE_INFINITY;
            let yMax = prevB?.yMax ?? Number.NEGATIVE_INFINITY;
            const end = plan2.newSrcOffset + plan2.keepNewCount;
            for (let i = plan2.newSrcOffset; i < end; i++) {
              const y = d.getY(cartesianData, i);
              if (Number.isFinite(y)) {
                if (y < yMin) yMin = y;
                if (y > yMax) yMax = y;
              }
            }
            if (Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(yMin) && Number.isFinite(yMax)) {
              let xMin = x0;
              let xMax = x1;
              if (xMin === xMax) xMax = xMin + 1;
              if (yMin === yMax) yMax = yMin + 1;
              d.runtimeRawBoundsByIndex[seriesIndex] = {
                xMin,
                xMax,
                yMin,
                yMax,
              };
            } else {
              didWindow = true;
            }
          } else {
            d.runtimeRawBoundsByIndex[seriesIndex] = d.extendBoundsWithCartesianData(
              d.runtimeRawBoundsByIndex[seriesIndex],
              cartesianData
            );
          }
          continue;
        }

        if (d.isRingXYColumns(raw)) {
          d.appendIntoRingXY(raw, cartesianData, plan.newSrcOffset, plan.keepNewCount, plan.dropPrevCount);
          if (plan.didWindow) {
            // O(1) endpoint bounds for ring (avoid O(n) full rescan every wrap frame).
            // y-range never shrinks when peaks leave the window (intentionally
            // conservative product behavior for high-rate FIFO). x uses
            // chronological ends of the retained ring.
            const prevB = d.runtimeRawBoundsByIndex[seriesIndex];
            const x0 = d.getX(raw as unknown as CartesianSeriesData, 0);
            const x1 = d.getX(raw as unknown as CartesianSeriesData, raw.count - 1);
            let yMin = prevB?.yMin ?? Number.POSITIVE_INFINITY;
            let yMax = prevB?.yMax ?? Number.NEGATIVE_INFINITY;
            const end = plan.newSrcOffset + plan.keepNewCount;
            for (let i = plan.newSrcOffset; i < end; i++) {
              const y = d.getY(cartesianData, i);
              if (Number.isFinite(y)) {
                if (y < yMin) yMin = y;
                if (y > yMax) yMax = y;
              }
            }
            if (Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(yMin) && Number.isFinite(yMax)) {
              let xMin = x0;
              let xMax = x1;
              if (xMin === xMax) xMax = xMin + 1;
              if (yMin === yMax) yMax = yMin + 1;
              d.runtimeRawBoundsByIndex[seriesIndex] = {
                xMin,
                xMax,
                yMin,
                yMax,
              };
            } else {
              didWindow = true; // fall through to full rescan below
            }
          } else {
            d.runtimeRawBoundsByIndex[seriesIndex] = d.extendBoundsWithCartesianData(
              d.runtimeRawBoundsByIndex[seriesIndex],
              cartesianData
            );
          }
          continue;
        }

        // Linear any path (unbounded append or demoted ring).
        const linear = raw as any;
        if (plan.dropPrevCount > 0) {
          d.dropPrefixXY(linear.x, linear.y, plan.dropPrevCount, linear.size);
          didWindow = true;
        }
        const rawLenBefore = linear.x.length;
        const end = plan.newSrcOffset + plan.keepNewCount;
        for (let i = plan.newSrcOffset; i < end; i++) {
          linear.x.push(d.getX(cartesianData, i));
          linear.y.push(d.getY(cartesianData, i));

          const sizeValue = d.getSize(cartesianData, i);
          if (sizeValue !== undefined) {
            if (!linear.size) {
              linear.size = new Array(rawLenBefore + (i - plan.newSrcOffset));
            }
            linear.size.push(sizeValue);
          } else if (linear.size) {
            linear.size.push(undefined);
          }
        }

        if (!plan.didWindow) {
          d.runtimeRawBoundsByIndex[seriesIndex] = d.extendBoundsWithCartesianData(
            d.runtimeRawBoundsByIndex[seriesIndex],
            cartesianData
          );
        } else {
          didWindow = true;
        }
      }

      if (didWindow) {
        // Dropping a prefix can invalidate xMin / y extrema — rescan retained window.
        d.runtimeRawBoundsByIndex[seriesIndex] = d.computeRawBoundsFromCartesianData(raw as CartesianSeriesData);
      }
      // Impulse: always fold baseline into auto-Y (extend, O(1) ring ends, or full rescan).
      // Without this, FIFO/streaming can snap yMin to min(y) and cut stems short of the floor.
      if (s.type === 'impulse') {
        d.runtimeRawBoundsByIndex[seriesIndex] = foldImpulseBaseline(
          s,
          raw as CartesianSeriesData,
          d.runtimeRawBoundsByIndex[seriesIndex]
        );
      }
    }

    // Data changed under a possibly-stable ref — clear filterGaps + sampled
    // caches. Re-seed d.lastSetSeriesCache with the post-append runtime raw so
    // the first idle prepare hits the identity skip instead of setSeries,
    // which would linearize an active modular ring (issue 0.2).
    d.lastSampledData[seriesIndex] = null;
    d.filterGapsCache.delete(seriesIndex);
    const reseedRaw = d.runtimeRawDataByIndex[seriesIndex];
    if (reseedRaw != null) {
      let reseedXOffset = 0;
      if (d.isStagingRingView(reseedRaw)) {
        reseedXOffset = reseedRaw.xOffset;
      } else {
        try {
          reseedXOffset = d.dataStore.getSeriesXOffset(seriesIndex);
        } catch {
          reseedXOffset = 0;
        }
      }
      d.lastSetSeriesCache.set(seriesIndex, {
        data: reseedRaw,
        xOffset: reseedXOffset,
      });
    } else {
      d.lastSetSeriesCache.delete(seriesIndex);
    }
  }

  d.pendingAppendByIndex.clear();
  if (!didAppendAny) return false;

  // Dataset-aware zoom span constraints depend on raw point density.
  // When streaming appends add points, recompute and apply constraints so wheel+slider remain consistent.
  // Arm auto-scroll source kind before setSpanConstraints (clamping may emit onChange).
  if (canAutoScroll) d.pendingZoomSourceKind = 'auto-scroll';
  if (d.zoomState) {
    const constraints = d.computeEffectiveZoomSpanConstraints();
    const withConstraints = d.zoomState as unknown as {
      setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
    };
    withConstraints.setSpanConstraints?.(constraints.minSpan, constraints.maxSpan);
  }

  // Auto-scroll is applied only on append (not on `setOptions`).
  // Re-arm in case setSpanConstraints already triggered onChange and cleared.
  if (canAutoScroll && zoomRangeBefore && prevVisibleXDomain) {
    d.pendingZoomSourceKind = 'auto-scroll';
    const r = zoomRangeBefore;
    if (r.end >= 99.5) {
      const span = r.end - r.start;
      const anchored = d.zoomState! as unknown as {
        setRangeAnchored?: (start: number, end: number, anchor: 'start' | 'end' | 'center') => void;
      };
      // Keep end pinned when constraints clamp the span.
      if (anchored.setRangeAnchored) {
        anchored.setRangeAnchored(100 - span, 100, 'end');
      } else {
        d.zoomState!.setRange(100 - span, 100);
      }
    } else {
      const nextBaseXDomain = d.computeBaseXDomain(d.currentOptions, d.runtimeRawBoundsByIndex);
      const span = nextBaseXDomain.max - nextBaseXDomain.min;
      if (Number.isFinite(span) && span > 0) {
        const nextStartRaw = ((prevVisibleXDomain.min - nextBaseXDomain.min) / span) * 100;
        const nextEndRaw = ((prevVisibleXDomain.max - nextBaseXDomain.min) / span) * 100;
        // Clamp defensively; ZoomState also clamps/orders internally.
        const nextStart = Math.max(0, Math.min(100, nextStartRaw));
        const nextEnd = Math.max(0, Math.min(100, nextEndRaw));
        d.zoomState!.setRange(nextStart, nextEnd);
      }
    }
  }
  // Fallback clear if no onChange fired (e.g. range unchanged).
  if (canAutoScroll) d.pendingZoomSourceKind = undefined;

  // Streaming append hot path: when every series is already GPU-decimation
  // eligible on the baseline, patch rawData/rawBounds in place instead of
  // reallocating the full resolved-series array (series compression / multi-
  // chart line slots append every frame).
  let patchedInPlace = false;
  if (d.runtimeBaseSeries.length === d.currentOptions.series.length && d.runtimeBaseSeries.length > 0) {
    patchedInPlace = true;
    for (let i = 0; i < d.runtimeBaseSeries.length; i++) {
      const base = d.runtimeBaseSeries[i]!;
      const cfg = d.currentOptions.series[i]!;
      if (base.type === 'pie' || cfg.type === 'pie') continue;
      if (base.type === 'heatmap' || cfg.type === 'heatmap') continue;
      if (base.type === 'candlestick' || base.type === 'ohlc' || cfg.type === 'candlestick' || cfg.type === 'ohlc') {
        patchedInPlace = false;
        break;
      }
      const rawCartesian =
        (d.runtimeRawDataByIndex[i] as CartesianSeriesData | null) ??
        ((cfg.rawData ?? cfg.data) as CartesianSeriesData);
      if (!d.isGpuDecimationEligible(cfg, rawCartesian) || !d.isGpuDecimationEligible(base, rawCartesian)) {
        patchedInPlace = false;
        break;
      }
      const bounds = d.runtimeRawBoundsByIndex[i] ?? base.rawBounds ?? undefined;
      // Mutate shared resolved object — display path only reads these fields.
      (base as { rawData: CartesianSeriesData }).rawData = rawCartesian;
      (base as { data: CartesianSeriesData }).data = rawCartesian;
      if (bounds) {
        (base as { rawBounds?: typeof bounds }).rawBounds = bounds;
      }
    }
  }
  if (!patchedInPlace) {
    d.recomputeRuntimeBaseSeries();
  }

  // If zoom is disabled or full-span, `d.renderSeries` is just the baseline.
  // (Zoom-visible resampling is handled by the unified flush when needed.)
  const zoomRangeAfter = d.zoomState?.getRange() ?? null;
  if (zoomRangeAfter == null || d.isFullSpanZoomRange(zoomRangeAfter)) {
    d.renderSeries = d.runtimeBaseSeries;
    // Recompute visible y-bounds from the baseline series
    d.recomputeCachedVisibleYBoundsIfNeeded();
  }

  return true;
}

export function createAppendFlush(getDeps: () => AppendFlushDeps): () => boolean {
  return () => flushPendingAppendsImpl(getDeps());
}
