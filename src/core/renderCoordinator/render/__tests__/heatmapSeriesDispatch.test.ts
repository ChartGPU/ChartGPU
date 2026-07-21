/**
 * Multi-series prepare/render dispatch: heatmap slots 0 and 2 prepare;
 * render draws heatmaps before lines.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
  // @ts-ignore
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
});

import { prepareSeries, renderSeries, type SeriesRenderers, type SeriesPreparationResult } from '../renderSeries';
import type { ResolvedHeatmapSeriesConfig, ResolvedLineSeriesConfig } from '../../../../config/OptionResolver';
import type { HeatmapRenderer } from '../../../../renderers/createHeatmapRenderer';
import type { LineRenderer } from '../../../../renderers/createLineRenderer';
import { createLinearScale } from '../../../../utils/scales';

function mockHeatmap(): HeatmapRenderer {
  return {
    prepare: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    getZUploadCount: () => 0,
    getLutUploadCount: () => 0,
    hasZTexture: () => false,
  };
}

function mockLine(): LineRenderer {
  return {
    prepare: vi.fn(),
    render: vi.fn(),
    isDenseHairline: () => false,
    renderHairline: vi.fn(),
    bindHairlinePipeline: vi.fn(),
    dispose: vi.fn(),
  } as unknown as LineRenderer;
}

function hmConfig(i: number): ResolvedHeatmapSeriesConfig {
  return {
    type: 'heatmap',
    name: `h${i}`,
    data: {
      xStart: 0,
      xStep: 1,
      yStart: 0,
      yStep: 1,
      columns: 2,
      rows: 2,
      z: new Float32Array([1, 2, 3, 4]),
    },
    colormap: 'viridis',
    zMin: 0,
    zMax: 4,
    zScale: 'linear',
    opacity: 1,
    cellAnchor: 'corner',
    nullHandling: 'transparent',
    cellGapPx: 0,
    yAxis: 'y',
    color: '#888',
    rawBounds: { xMin: 0, xMax: 2, yMin: 0, yMax: 2 },
    drawable: true,
    cellCount: 4,
    visible: true,
  };
}

function lineConfig(): ResolvedLineSeriesConfig {
  return {
    type: 'line',
    name: 'L',
    data: [
      [0, 1],
      [1, 2],
    ],
    rawData: [
      [0, 1],
      [1, 2],
    ],
    color: '#0af',
    lineStyle: { width: 2, opacity: 1, color: '#0af' },
    sampling: 'none',
    samplingThreshold: 5000,
    connectNulls: false,
    yAxis: 'y',
    visible: true,
  } as ResolvedLineSeriesConfig;
}

describe('heatmap multi-series prepare/render dispatch', () => {
  it('prepares heatmap renderers at series indices 0 and 2 only (pie in middle)', () => {
    const h0 = mockHeatmap();
    const h1 = mockHeatmap();
    const h2 = mockHeatmap();
    const pie = { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() };
    const renderers: SeriesRenderers = {
      lineRenderers: [],
      areaRenderers: [],
      barRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() } as any,
      scatterRenderers: [],
      scatterDensityRenderers: [],
      pieRenderers: [pie as any, pie as any, pie as any],
      heatmapRenderers: [h0, h1, h2],
      candlestickRenderers: [],
      ohlcRenderers: [],
      decimationComputes: [],
    };

    const xScale = createLinearScale().domain(0, 2).range(-1, 1);
    const yScale = createLinearScale().domain(0, 2).range(-1, 1);
    const gridArea = {
      left: 10,
      right: 10,
      top: 10,
      bottom: 10,
      canvasWidth: 200,
      canvasHeight: 200,
      devicePixelRatio: 1,
    };

    const dataStore = {
      setSeries: vi.fn(),
      getSeriesBuffer: vi.fn(),
      getSeriesPointCount: vi.fn(() => 0),
      getSeriesContentHash: vi.fn(() => 0),
      isSeriesRingMode: vi.fn(() => false),
      getSeriesRingLayout: vi.fn(() => ({ ringStart: 0, ringCapacity: 0 })),
    } as any;

    const pieSeries = {
      type: 'pie',
      name: 'P',
      data: [{ name: 'A', value: 1, color: '#f00', visible: true }],
      color: '#f00',
      visible: true,
    } as any;

    const seriesForRender = [hmConfig(0), pieSeries, hmConfig(2)];
    prepareSeries(renderers, {
      currentOptions: {
        series: seriesForRender,
        yAxes: [{ id: 'y', type: 'value' }],
        xAxis: { type: 'value' },
        theme: { backgroundColor: '#000' },
      } as any,
      seriesForRender,
      xScale: xScale as any,
      yScales: new Map([['y', yScale as any]]),
      gridArea,
      dataStore,
      appendedGpuThisFrame: new Set(),
      gpuSeriesKindByIndex: ['unknown', 'unknown', 'unknown'],
      zoomState: null,
      visibleXDomain: { min: 0, max: 2 },
      introPhase: 'done',
      introProgress01: 1,
      withAlpha: (c) => c,
      maxRadiusCss: 50,
      lastSetSeriesCache: new Map(),
      filterGapsCache: new Map(),
    });

    expect(h0.prepare).toHaveBeenCalledTimes(1);
    expect(h1.prepare).not.toHaveBeenCalled();
    expect(h2.prepare).toHaveBeenCalledTimes(1);
    expect(pie.prepare).toHaveBeenCalled();
    expect((h0.prepare as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ type: 'heatmap' });
    expect((h2.prepare as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ type: 'heatmap' });
  });

  it('renders heatmaps before lines (draw order)', () => {
    const order: string[] = [];
    const h0 = mockHeatmap();
    (h0.render as any).mockImplementation(() => order.push('heatmap0'));
    const h2 = mockHeatmap();
    (h2.render as any).mockImplementation(() => order.push('heatmap2'));
    const line = mockLine();
    (line.render as any).mockImplementation(() => order.push('line'));

    const renderers: SeriesRenderers = {
      lineRenderers: [line, line, line],
      areaRenderers: [],
      barRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() } as any,
      scatterRenderers: [],
      scatterDensityRenderers: [],
      pieRenderers: [],
      heatmapRenderers: [h0, mockHeatmap(), h2],
      candlestickRenderers: [],
      ohlcRenderers: [],
      decimationComputes: [],
    };

    const prep: SeriesPreparationResult = {
      visibleSeriesForRender: [
        { series: hmConfig(0), originalIndex: 0 },
        { series: lineConfig(), originalIndex: 1 },
        { series: hmConfig(2), originalIndex: 2 },
      ],
      barSeriesConfigs: [],
      visibleBarSeriesConfigs: [],
    };

    const mainPass = {
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as any;

    const gridArea = {
      left: 10,
      right: 10,
      top: 10,
      bottom: 10,
      canvasWidth: 200,
      canvasHeight: 200,
      devicePixelRatio: 1,
    };

    renderSeries(
      renderers,
      {
        referenceLineRenderer: { render: vi.fn() } as any,
        referenceLineRendererMsaa: { render: vi.fn() } as any,
        annotationMarkerRenderer: { render: vi.fn() } as any,
        annotationMarkerRendererMsaa: { render: vi.fn() } as any,
      },
      {
        hasCartesianSeries: true,
        gridArea,
        mainPass,
        plotScissor: { x: 0, y: 0, w: 100, h: 100 },
        introPhase: 'done',
        introProgress01: 1,
        referenceLineBelowCount: 0,
        markerBelowCount: 0,
      },
      prep
    );

    const hi0 = order.indexOf('heatmap0');
    const hi2 = order.indexOf('heatmap2');
    const li = order.indexOf('line');
    expect(hi0).toBeGreaterThanOrEqual(0);
    expect(hi2).toBeGreaterThanOrEqual(0);
    expect(li).toBeGreaterThanOrEqual(0);
    expect(hi0).toBeLessThan(li);
    expect(hi2).toBeLessThan(li);
  });
});
