/**
 * Issue 0.2: after modular ring append, idle prepare must not linearize the
 * ring via setSeries. lastSetSeriesCache is re-seeded; setSeriesIfChanged
 * hard-guards ring-backed refs.
 */

/// <reference types="@webgpu/types" />

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createDataStore } from '../../../../data/createDataStore';
import { createRingXYColumns, createStagingRingView, isStagingRingView } from '../../../../data/cartesianData';
import { prepareSeries } from '../renderSeries';
import type { SeriesPrepareContext } from '../renderSeries';
import type { ResolvedChartGPUOptions } from '../../../../config/OptionResolver';

beforeAll(() => {
  // @ts-ignore
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  // @ts-ignore
  globalThis.GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
});

function createMockDevice() {
  const buffers: Array<{ size: number; destroy: ReturnType<typeof vi.fn> }> = [];
  const device = {
    limits: {
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 134217728,
    },
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
    createBuffer: vi.fn((desc?: GPUBufferDescriptor) => {
      const b = {
        size: desc?.size ?? 0,
        label: desc?.label ?? '',
        destroy: vi.fn(),
      };
      buffers.push(b);
      return b as unknown as GPUBuffer;
    }),
  } as unknown as GPUDevice;
  return device;
}

function mockLineRenderer() {
  return {
    prepare: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

function mockDecimation() {
  return {
    prepare: vi.fn(),
    encode: vi.fn(),
    getOutputBuffer: vi.fn(() => ({ size: 64 })),
    dispose: vi.fn(),
  };
}

function lineSeries(data: unknown, sampling: 'none' | 'lttb' = 'none') {
  return {
    type: 'line' as const,
    name: 's',
    data,
    rawData: data,
    color: '#0af',
    lineStyle: { width: 1 },
    sampling,
    samplingThreshold: 2500,
    connectNulls: false,
    yAxis: 'y',
    visible: true,
    rawBounds: { xMin: 0, xMax: 100, yMin: 0, yMax: 100 },
  };
}

function baseOptions(series: ReturnType<typeof lineSeries>[]): ResolvedChartGPUOptions {
  return {
    series,
    xAxis: { type: 'value', min: 0, max: 100 },
    yAxes: [{ id: 'y', min: 0, max: 100 }],
    tooltip: { show: false },
  } as unknown as ResolvedChartGPUOptions;
}

function prepareCtx(
  partial: Partial<SeriesPrepareContext> &
    Pick<SeriesPrepareContext, 'dataStore' | 'seriesForRender' | 'lastSetSeriesCache' | 'appendedGpuThisFrame'>
): SeriesPrepareContext {
  return {
    currentOptions: baseOptions(partial.seriesForRender as any),
    seriesForRender: partial.seriesForRender,
    xScale: { scale: (v: number) => v, invert: (v: number) => v } as any,
    yScales: new Map([['y', { scale: (v: number) => v, invert: (v: number) => v } as any]]),
    gridArea: {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      canvasWidth: 800,
      canvasHeight: 600,
      devicePixelRatio: 1,
    } as any,
    dataStore: partial.dataStore,
    appendedGpuThisFrame: partial.appendedGpuThisFrame,
    gpuSeriesKindByIndex: partial.gpuSeriesKindByIndex ?? ['fullRawLine'],
    zoomState: { getRange: () => null },
    visibleXDomain: { min: 0, max: 100 },
    introPhase: 'done',
    introProgress01: 1,
    withAlpha: (c) => c,
    maxRadiusCss: 0,
    lastSetSeriesCache: partial.lastSetSeriesCache,
    filterGapsCache: partial.filterGapsCache ?? new Map(),
  };
}

describe('append cache re-seed / ring guard (issue 0.2)', () => {
  it('idle prepare after ring wrap does not setSeries-linearize (RingXY + reseed)', () => {
    const device = createMockDevice();
    const store = createDataStore(device);
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;

    // Seed full capacity ring then wrap.
    store.setSeries(0, [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    store.appendSeries(0, [[4, 4]], { maxPoints: 4 });
    expect(store.isSeriesRingMode(0)).toBe(true);
    expect(store.getSeriesRingLayout(0).start).toBe(1);

    const ring = createRingXYColumns(4);
    ring.count = 4;
    ring.start = 1;
    // Chronological values matching post-append window [1,2,3,4]
    ring.x[1] = 1;
    ring.y[1] = 1;
    ring.x[2] = 2;
    ring.y[2] = 2;
    ring.x[3] = 3;
    ring.y[3] = 3;
    ring.x[0] = 4;
    ring.y[0] = 4;

    const lastSetSeriesCache = new Map<number, Readonly<{ data: unknown; xOffset: number }>>([
      // Re-seeded as flushPendingAppends would after append (issue 0.2).
      [0, { data: ring, xOffset: 0 }],
    ]);

    writeBuffer.mockClear();
    const setSeriesSpy = vi.spyOn(store, 'setSeries');

    const lineRenderer = mockLineRenderer();
    prepareSeries(
      {
        lineRenderers: [lineRenderer as any],
        areaRenderers: [],
        barRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() } as any,
        scatterRenderers: [],
        scatterDensityRenderers: [],
        pieRenderers: [],
        heatmapRenderers: [],
        candlestickRenderers: [],
        ohlcRenderers: [],
        decimationComputes: [mockDecimation() as any],
      },
      prepareCtx({
        dataStore: store,
        seriesForRender: [lineSeries(ring, 'none') as any],
        lastSetSeriesCache,
        appendedGpuThisFrame: new Set(), // idle frame after append
        gpuSeriesKindByIndex: ['fullRawLine'],
      })
    );

    expect(setSeriesSpy).not.toHaveBeenCalled();
    // Ring layout preserved (not linearized).
    expect(store.getSeriesRingLayout(0)).toEqual({ start: 1, capacity: 4 });
    expect(store.isSeriesRingMode(0)).toBe(true);
  });

  it('StagingRingView never calls setSeries even on cache miss', () => {
    const device = createMockDevice();
    const store = createDataStore(device);
    store.setSeries(0, [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    store.appendSeries(0, [[4, 4]], { maxPoints: 4 });

    const layout = store.getSeriesRingLayout(0);
    const staging = store.getSeriesStagingBuffer(0);
    const view = createStagingRingView(
      staging,
      layout.start,
      layout.capacity,
      store.getSeriesPointCount(0),
      store.getSeriesXOffset(0)
    );
    expect(isStagingRingView(view)).toBe(true);

    const setSeriesSpy = vi.spyOn(store, 'setSeries');
    const lastSetSeriesCache = new Map<number, Readonly<{ data: unknown; xOffset: number }>>(); // cache miss

    prepareSeries(
      {
        lineRenderers: [mockLineRenderer() as any],
        areaRenderers: [],
        barRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() } as any,
        scatterRenderers: [],
        scatterDensityRenderers: [],
        pieRenderers: [],
        heatmapRenderers: [],
        candlestickRenderers: [],
        ohlcRenderers: [],
        decimationComputes: [mockDecimation() as any],
      },
      prepareCtx({
        dataStore: store,
        seriesForRender: [lineSeries(view, 'none') as any],
        lastSetSeriesCache,
        appendedGpuThisFrame: new Set(),
        gpuSeriesKindByIndex: ['fullRawLine'],
      })
    );

    expect(setSeriesSpy).not.toHaveBeenCalled();
    expect(store.getSeriesRingLayout(0)).toEqual({ start: 1, capacity: 4 });
  });

  it('ring hard-guard skips setSeries for RingXY even without reseed', () => {
    const device = createMockDevice();
    const store = createDataStore(device);
    store.setSeries(0, [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    store.appendSeries(0, [[4, 4]], { maxPoints: 4 });

    const ring = createRingXYColumns(4);
    ring.count = 4;
    ring.start = 1;
    ring.x[0] = 4;
    ring.y[0] = 4;
    ring.x[1] = 1;
    ring.y[1] = 1;
    ring.x[2] = 2;
    ring.y[2] = 2;
    ring.x[3] = 3;
    ring.y[3] = 3;

    const setSeriesSpy = vi.spyOn(store, 'setSeries');
    // Empty cache — hard-guard must still protect.
    const lastSetSeriesCache = new Map<number, Readonly<{ data: unknown; xOffset: number }>>();

    prepareSeries(
      {
        lineRenderers: [mockLineRenderer() as any],
        areaRenderers: [],
        barRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() } as any,
        scatterRenderers: [],
        scatterDensityRenderers: [],
        pieRenderers: [],
        heatmapRenderers: [],
        candlestickRenderers: [],
        ohlcRenderers: [],
        decimationComputes: [mockDecimation() as any],
      },
      prepareCtx({
        dataStore: store,
        seriesForRender: [lineSeries(ring, 'none') as any],
        lastSetSeriesCache,
        appendedGpuThisFrame: new Set(),
        gpuSeriesKindByIndex: ['fullRawLine'],
      })
    );

    expect(setSeriesSpy).not.toHaveBeenCalled();
    expect(store.isSeriesRingMode(0)).toBe(true);
    // Guard re-seeds so subsequent frames stay cheap.
    expect(lastSetSeriesCache.get(0)?.data).toBe(ring);
  });
});
