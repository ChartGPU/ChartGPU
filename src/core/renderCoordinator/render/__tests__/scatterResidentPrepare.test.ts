/**
 * Fixed-radius scatter streaming must share the DataStore resident XY buffer.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ResolvedScatterSeriesConfig } from '../../../../config/OptionResolver';
import type { ScatterRenderer } from '../../../../renderers/createScatterRenderer';
import { createLinearScale } from '../../../../utils/scales';
import { createStackedMountainCache } from '../stackedMountainCache';
import { prepareSeries, type SeriesPrepareContext, type SeriesRenderers } from '../renderSeries';

function scatterConfig(data: ResolvedScatterSeriesConfig['data']): ResolvedScatterSeriesConfig {
  return {
    type: 'scatter',
    name: 'stream',
    data,
    rawData: data,
    color: '#0af',
    symbolSize: 4,
    mode: 'points',
    binSize: 2,
    densityColormap: 'viridis',
    densityNormalization: 'log',
    sampling: 'none',
    samplingThreshold: 5000,
    yAxis: 'y',
    visible: true,
  } as ResolvedScatterSeriesConfig;
}

function scatterRenderer(): ScatterRenderer {
  return {
    prepare: vi.fn(),
    invalidateGeometry: vi.fn(),
    render: vi.fn(),
    isDenseDeferred: vi.fn(() => false),
    renderDense: vi.fn(),
    dispose: vi.fn(),
  };
}

function renderers(scatter: ScatterRenderer): SeriesRenderers {
  return {
    lineRenderers: [],
    areaRenderers: [],
    barRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() } as any,
    scatterRenderers: [scatter],
    scatterDensityRenderers: [],
    pieRenderers: [],
    heatmapRenderers: [],
    candlestickRenderers: [],
    ohlcRenderers: [],
    bandRenderers: [],
    errorBarRenderers: [],
    impulseRenderers: [],
    decimationComputes: [],
  };
}

describe('prepareSeries fixed-radius scatter residency', () => {
  it('seeds once, then keeps the appended DataStore buffer bound', () => {
    const data = {
      x: new Float32Array([0, 1, 2]),
      y: new Float32Array([1, 2, 3]),
    };
    const series = scatterConfig(data);
    const residentBuffer = { size: 4096 } as unknown as GPUBuffer;
    const pointCount = { value: 3 };
    const dataStore = {
      setSeries: vi.fn(),
      getSeriesBuffer: vi.fn(() => residentBuffer),
      getSeriesPointCount: vi.fn(() => pointCount.value),
      isSeriesRingMode: vi.fn(() => false),
    } as any;
    const scatter = scatterRenderer();
    const gpuSeriesKindByIndex: SeriesPrepareContext['gpuSeriesKindByIndex'] = ['unknown'];
    const xScale = createLinearScale().domain(0, 3).range(-1, 1);
    const yScale = createLinearScale().domain(0, 3).range(-1, 1);
    const context: SeriesPrepareContext = {
      currentOptions: {
        series: [series],
        yAxes: [{ id: 'y', type: 'value' }],
        xAxis: { type: 'value' },
        theme: { backgroundColor: '#000' },
        performance: { lod: 'auto' },
      } as any,
      seriesForRender: [series],
      xScale: xScale as any,
      yScales: new Map([['y', yScale as any]]),
      gridArea: {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        canvasWidth: 200,
        canvasHeight: 100,
        devicePixelRatio: 1,
      },
      dataStore,
      appendedGpuThisFrame: new Set(),
      gpuSeriesKindByIndex,
      zoomState: null,
      visibleXDomain: { min: 0, max: 3 },
      introPhase: 'done',
      introProgress01: 1,
      withAlpha: (color) => color,
      maxRadiusCss: 50,
      lastSetSeriesCache: new Map(),
      filterGapsCache: new Map(),
      stackedMountainCache: createStackedMountainCache(),
    };

    prepareSeries(renderers(scatter), context);

    expect(dataStore.setSeries).toHaveBeenCalledTimes(1);
    expect(gpuSeriesKindByIndex[0]).toBe('fullRawLine');
    expect(scatter.prepare).toHaveBeenLastCalledWith(
      series,
      data,
      xScale,
      yScale,
      context.gridArea,
      false,
      true,
      { buffer: residentBuffer, pointCount: 3 }
    );

    pointCount.value = 4;
    context.appendedGpuThisFrame.add(0);
    prepareSeries(renderers(scatter), context);

    expect(dataStore.setSeries).toHaveBeenCalledTimes(1);
    expect(scatter.prepare).toHaveBeenLastCalledWith(
      series,
      data,
      xScale,
      yScale,
      context.gridArea,
      false,
      true,
      { buffer: residentBuffer, pointCount: 4 }
    );
  });
});
