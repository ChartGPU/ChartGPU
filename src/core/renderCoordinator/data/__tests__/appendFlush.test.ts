import { describe, it, expect, vi } from 'vitest';
import { createAppendFlush, type AppendFlushDeps } from '../appendFlush';
import { canRangedAppendLine } from '../canRangedAppendLine';
import { demoteStagingViewAfterRebindFailure } from '../stagingThinPath';
import { createStagingRingView } from '../../../../data/cartesianData';

function baseDeps(overrides: Partial<AppendFlushDeps> = {}): AppendFlushDeps {
  const pendingAppendByIndex = new Map<
    number,
    AppendFlushDeps['pendingAppendByIndex'] extends Map<number, infer V> ? V : never
  >();
  const lastSetSeriesCache = new Map<number, { data: unknown; xOffset: number }>();
  const deps: AppendFlushDeps = {
    pendingAppendByIndex: pendingAppendByIndex as AppendFlushDeps['pendingAppendByIndex'],
    appendedGpuThisFrame: new Set(),
    zoomState: null,
    currentOptions: {
      series: [
        {
          type: 'line',
          sampling: 'none',
          samplingThreshold: 0,
          data: { x: [0, 1], y: [0, 1] },
          rawData: { x: [0, 1], y: [0, 1] },
        } as any,
      ],
      autoScroll: false,
      xAxis: {},
    } as any,
    dataStore: {
      appendSeries: vi.fn(() => true),
      getSeriesXOffset: vi.fn(() => 0),
    } as any,
    runtimeRawDataByIndex: [{ x: [0, 1], y: [0, 1] }],
    runtimeRawBoundsByIndex: [{ xMin: 0, xMax: 1, yMin: 0, yMax: 1 }],
    gpuSeriesKindByIndex: ['fullRawLine'],
    lastSetSeriesCache,
    filterGapsCache: { delete() {}, clear() {} },
    lastSampledData: [],
    warnedSamplingDefeatsFastPath: new Set(),
    recomputeRuntimeBaseSeries: vi.fn(),
    recomputeCachedVisibleYBoundsIfNeeded: vi.fn(),
    ensureMutableRuntimeColumns: () => ({ x: [0, 1], y: [0, 1] }),
    isOwnedMutableColumns: () => false,
    brandOwnedColumns: (c: any) => c,
    computeBaseXDomain: () => ({ min: 0, max: 1 }),
    computeVisibleXDomain: () => ({ min: 0, max: 1, spanFraction: 1 }),
    isFullSpanZoomRange: () => true,
    computeEffectiveZoomSpanConstraints: () => ({ minSpan: 0, maxSpan: 100 }),
    extendBoundsWithCartesianData: (_b, _d) => ({ xMin: 0, xMax: 2, yMin: 0, yMax: 2 }),
    extendBoundsWithOHLCDataPoints: () => null,
    canRangedAppendLine,
    isGpuDecimationEligible: () => false,
    normalizeMaxPoints: () => null,
    planMaxPointsWindow: () => ({
      didWindow: false,
      dropPrevCount: 0,
      keepNewCount: 0,
      newSrcOffset: 0,
      isRing: false,
      ringCapacity: 0,
    }),
    getPointCount: (data: any) => (Array.isArray(data?.x) ? data.x.length : 0),
    getX: (data: any, i: number) => data.x[i],
    getY: (data: any, i: number) => data.y[i],
    getSize: () => undefined,
    createRingXYColumns: () => ({}),
    appendIntoRingXY: () => {},
    dropPrefixXY: () => {},
    createStagingRingView: () => ({}),
    isRingXYColumns: () => false,
    isStagingRingView: () => false,
    demoteStagingViewAfterRebindFailure,
    computeRawBoundsFromCartesianData: () => null,
    runtimeBaseSeries: [],
    renderSeries: [],
    pendingZoomSourceKind: null,
    ...overrides,
  };
  return deps;
}

describe('appendFlush module ownership', () => {
  it('canRangedAppendLine and demoteStagingViewAfterRebindFailure live in policy modules', () => {
    expect(
      canRangedAppendLine({
        seriesType: 'line',
        sampling: 'none',
        kind: 'fullRawLine',
        rawData: { x: [0, 1], y: [0, 1] },
      })
    ).toBe(true);
    const view = createStagingRingView(new Float64Array(4), 0, 2, 2, 0);
    expect(demoteStagingViewAfterRebindFailure(view)).toBeNull();
  });

  it('createAppendFlush returns false when no pending appends', () => {
    const deps = baseDeps();
    const flush = createAppendFlush(() => deps);
    expect(flush()).toBe(false);
    expect(deps.appendedGpuThisFrame.size).toBe(0);
  });

  it('ranged append (sampling none) updates GPU, reseeds lastSetSeriesCache, extends runtime raw', () => {
    const lastSetSeriesCache = new Map<number, { data: unknown; xOffset: number }>();
    const appendSeries = vi.fn(() => true);
    // Owned mutable columns (array, not typed) so ensureMutable / push path can extend.
    const raw = { x: [0, 1] as number[], y: [10, 11] as number[] };
    const deps = baseDeps({
      lastSetSeriesCache,
      runtimeRawDataByIndex: [raw],
      gpuSeriesKindByIndex: ['fullRawLine'],
      isOwnedMutableColumns: () => true,
      ensureMutableRuntimeColumns: () => raw,
      dataStore: {
        appendSeries,
        getSeriesXOffset: vi.fn(() => 0),
      } as any,
    });
    deps.pendingAppendByIndex.set(0, [{ points: { x: [2], y: [12] } }]);
    deps.runtimeBaseSeries = deps.currentOptions.series as any;
    deps.renderSeries = deps.currentOptions.series as any;

    const flush = createAppendFlush(() => deps);
    expect(flush()).toBe(true);

    expect(appendSeries).toHaveBeenCalled();
    expect(deps.appendedGpuThisFrame.has(0)).toBe(true);
    expect(deps.pendingAppendByIndex.size).toBe(0);
    // Cache reseed for append path
    expect(lastSetSeriesCache.has(0)).toBe(true);
    // Runtime columns extended (owned mutable path)
    expect(raw.x.length).toBeGreaterThanOrEqual(2);
  });

  it('calls recomputeRuntimeBaseSeries when ranged append is not available', () => {
    const recomputeRuntimeBaseSeries = vi.fn();
    const deps = baseDeps({
      recomputeRuntimeBaseSeries,
      gpuSeriesKindByIndex: ['other'],
      dataStore: {
        appendSeries: vi.fn(() => false),
        getSeriesXOffset: vi.fn(() => 0),
      } as any,
    });
    deps.pendingAppendByIndex.set(0, [{ points: { x: [2], y: [12] } }]);
    deps.runtimeBaseSeries = deps.currentOptions.series as any;
    deps.renderSeries = deps.currentOptions.series as any;

    const flush = createAppendFlush(() => deps);
    expect(flush()).toBe(true);
    expect(recomputeRuntimeBaseSeries).toHaveBeenCalled();
  });

  it('ohlc append + maxPoints FIFO grows runtime OHLC, windows, and updates last close (multi-layer finance)', () => {
    const recomputeRuntimeBaseSeries = vi.fn();
    const extendBoundsWithOHLCDataPoints = vi.fn((_b: unknown, points: ReadonlyArray<unknown>) => ({
      xMin: 0,
      xMax: points.length,
      yMin: 0,
      yMax: 200,
    }));
    // Seed three bars; append two more with maxPoints=4 → drop 1 prefix, keep last 4.
    const owned: Array<[number, number, number, number, number]> = [
      [0, 10, 11, 9, 12],
      [1, 11, 12, 10, 13],
      [2, 12, 13, 11, 14],
    ];
    const deps = baseDeps({
      recomputeRuntimeBaseSeries,
      extendBoundsWithOHLCDataPoints: extendBoundsWithOHLCDataPoints as any,
      gpuSeriesKindByIndex: ['other'],
      runtimeRawDataByIndex: [owned],
      runtimeRawBoundsByIndex: [{ xMin: 0, xMax: 2, yMin: 9, yMax: 14 }],
      normalizeMaxPoints: (v) => (typeof v === 'number' ? v : null),
      planMaxPointsWindow: (prevLen: number, newCount: number, maxPoints: number | null | undefined) => {
        const max = maxPoints ?? 1000;
        const total = prevLen + newCount;
        if (total <= max) {
          return {
            didWindow: false,
            dropPrevCount: 0,
            keepNewCount: newCount,
            newSrcOffset: 0,
            isRing: false,
            ringCapacity: 0,
          };
        }
        const drop = total - max;
        const dropPrev = Math.min(prevLen, drop);
        const keepNew = newCount - Math.max(0, drop - prevLen);
        return {
          didWindow: true,
          dropPrevCount: dropPrev,
          keepNewCount: Math.max(0, keepNew),
          newSrcOffset: Math.max(0, newCount - keepNew),
          isRing: false,
          ringCapacity: 0,
        };
      },
      currentOptions: {
        series: [
          {
            type: 'ohlc',
            sampling: 'none',
            samplingThreshold: 0,
            data: owned,
            rawData: owned,
            rawBounds: { xMin: 0, xMax: 2, yMin: 9, yMax: 14 },
            itemStyle: { upColor: '#0f0', downColor: '#f00' },
            priceLabel: { show: true, showLine: true },
            yAxis: 'y',
          } as any,
        ],
        autoScroll: false,
        xAxis: {},
      } as any,
    });
    deps.pendingAppendByIndex.set(0, [
      {
        points: [
          [3, 13, 14, 12, 15],
          [4, 14, 100, 13, 101], // last close = 100 for priceLabel
        ] as any,
        maxPoints: 4,
      },
    ]);
    deps.runtimeBaseSeries = deps.currentOptions.series as any;
    deps.renderSeries = deps.currentOptions.series as any;

    const flush = createAppendFlush(() => deps);
    expect(flush()).toBe(true);

    // FIFO windowed to 4 bars
    expect(owned.length).toBe(4);
    // Dropped first seed bar (t=0); last close is new bar close
    expect(owned[0]![0]).toBe(1);
    expect(owned[owned.length - 1]![2]).toBe(100);
    // OHLC path always recomputes base (not GPU-decimation in-place patch)
    expect(recomputeRuntimeBaseSeries).toHaveBeenCalled();
    expect(extendBoundsWithOHLCDataPoints).toHaveBeenCalled();
  });

  it('band maxPoints FIFO drops aligned x/y/y1 triples', () => {
    const recomputeRuntimeBaseSeries = vi.fn();
    const cols = {
      x: [0, 1, 2] as number[],
      y: [10, 11, 12] as number[],
      y1: [20, 21, 22] as number[],
    };
    const deps = baseDeps({
      recomputeRuntimeBaseSeries,
      gpuSeriesKindByIndex: ['other'],
      runtimeRawDataByIndex: [cols as any],
      runtimeRawBoundsByIndex: [{ xMin: 0, xMax: 2, yMin: 10, yMax: 22 }],
      currentOptions: {
        series: [
          {
            type: 'band',
            sampling: 'none',
            samplingThreshold: 0,
            data: cols,
            rawData: cols,
            rawBounds: { xMin: 0, xMax: 2, yMin: 10, yMax: 22 },
          } as any,
        ],
        autoScroll: false,
        xAxis: {},
      } as any,
      planMaxPointsWindow: (prevLen: number, newCount: number, maxPoints: number | null | undefined) => {
        // Simple FIFO: keep last maxPoints total.
        const max = maxPoints ?? 1000;
        const total = prevLen + newCount;
        if (total <= max) {
          return {
            didWindow: false,
            dropPrevCount: 0,
            keepNewCount: newCount,
            newSrcOffset: 0,
            isRing: false,
            ringCapacity: 0,
          };
        }
        const drop = total - max;
        const dropPrev = Math.min(prevLen, drop);
        const keepNew = newCount - Math.max(0, drop - prevLen);
        return {
          didWindow: true,
          dropPrevCount: dropPrev,
          keepNewCount: Math.max(0, keepNew),
          newSrcOffset: newCount - Math.max(0, keepNew),
          isRing: false,
          ringCapacity: 0,
        };
      },
      normalizeMaxPoints: (v: unknown) => (typeof v === 'number' ? v : null),
    });
    deps.pendingAppendByIndex.set(0, [
      {
        points: {
          x: [3, 4],
          y: [13, 14],
          y1: [23, 24],
        },
        maxPoints: 3,
      },
    ]);
    deps.runtimeBaseSeries = deps.currentOptions.series as any;
    deps.renderSeries = deps.currentOptions.series as any;

    const flush = createAppendFlush(() => deps);
    expect(flush()).toBe(true);

    const out = deps.runtimeRawDataByIndex[0] as { x: number[]; y: number[]; y1: number[] };
    expect(out.x.length).toBe(3);
    expect(out.y.length).toBe(3);
    expect(out.y1.length).toBe(3);
    // Oldest dropped; retained should end with new points.
    expect(out.x[out.x.length - 1]).toBe(4);
    expect(out.y[out.y.length - 1]).toBe(14);
    expect(out.y1[out.y1.length - 1]).toBe(24);
    // Equal lengths always
    expect(out.x.length).toBe(out.y1.length);
  });

  it('band XY-only append is skipped with warn (length unchanged)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cols = {
      x: [0, 1] as number[],
      y: [10, 11] as number[],
      y1: [20, 21] as number[],
    };
    const deps = baseDeps({
      gpuSeriesKindByIndex: ['other'],
      runtimeRawDataByIndex: [cols as any],
      currentOptions: {
        series: [
          {
            type: 'band',
            sampling: 'none',
            data: cols,
            rawData: cols,
          } as any,
        ],
        autoScroll: false,
        xAxis: {},
      } as any,
      recomputeRuntimeBaseSeries: vi.fn(),
      normalizeMaxPoints: () => null,
    });
    // Cartesian XY only — missing y1
    deps.pendingAppendByIndex.set(0, [{ points: { x: [2], y: [12] } as any }]);
    deps.runtimeBaseSeries = deps.currentOptions.series as any;
    deps.renderSeries = deps.currentOptions.series as any;

    const flush = createAppendFlush(() => deps);
    flush();

    expect(cols.x.length).toBe(2);
    expect(cols.y1.length).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
