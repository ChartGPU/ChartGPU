/**
 * prepareOverlays respects precomputed nearestMatch (including null) and
 * skips findNearestPoint when the coordinator provides a shared result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLinearScale } from '../../../../utils/scales';
import { prepareOverlays } from '../renderOverlays';
import type { ResolvedChartGPUOptions } from '../../../../config/OptionResolver';
import type { GridArea } from '../../../../renderers/createGridRenderer';
import * as findNearestMod from '../../../../interaction/findNearestPoint';

vi.mock('../../../../interaction/findNearestPoint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../interaction/findNearestPoint')>();
  return {
    ...actual,
    findNearestPoint: vi.fn(actual.findNearestPoint),
  };
});

function makeGridArea(): GridArea {
  return {
    left: 40,
    right: 20,
    top: 20,
    bottom: 40,
    canvasWidth: 1280,
    canvasHeight: 720,
    devicePixelRatio: 2,
  };
}

function makeOptions(): ResolvedChartGPUOptions {
  return {
    grid: { left: 40, right: 20, top: 20, bottom: 40 },
    gridLines: {
      show: false,
      color: 'rgba(255,255,255,0.15)',
      opacity: 1,
      horizontal: { show: false, count: 5, color: 'rgba(255,255,255,0.15)' },
      vertical: { show: false, count: 6, color: 'rgba(255,255,255,0.15)' },
    },
    xAxis: { type: 'value', id: 'x' },
    yAxes: [{ type: 'value', id: 'y', position: 'left' }],
    autoScroll: false,
    theme: {
      backgroundColor: '#000',
      textColor: '#fff',
      axisLineColor: '#888',
      axisTickColor: '#666',
      gridLineColor: 'rgba(255,255,255,0.15)',
      colorPalette: ['#0af'],
    },
    palette: ['#0af'],
    series: [
      {
        type: 'line',
        name: 'S0',
        color: '#0af',
        data: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      },
    ],
  } as unknown as ResolvedChartGPUOptions;
}

function makeMockRenderers() {
  return {
    gridRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() },
    xAxisRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() },
    yAxisRenderers: new Map([['y', { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() }]]),
    crosshairRenderer: {
      prepare: vi.fn(),
      setVisible: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    },
    highlightRenderer: {
      prepare: vi.fn(),
      setVisible: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    },
  };
}

describe('prepareOverlays nearestMatch (shared hit-test)', () => {
  beforeEach(() => {
    vi.mocked(findNearestMod.findNearestPoint).mockClear();
  });

  it('skips findNearestPoint when nearestMatch is provided and prepares highlight', () => {
    const renderers = makeMockRenderers();
    const xScale = createLinearScale().domain(0, 10).range(0, 100);
    const yScale = createLinearScale().domain(0, 10).range(100, 0);
    const yScales = new Map([['y', yScale]]);
    const seriesForRender = makeOptions().series;

    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions(),
        xScale,
        yScales,
        gridArea: makeGridArea(),
        xTickCount: 5,
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: true,
          isInGrid: true,
          source: 'mouse',
          x: 50,
          y: 50,
          gridX: 50,
          gridY: 50,
        },
        interactionScales: { xScale, yScales },
        seriesForRender,
        withAlpha: (c: string) => c,
        nearestMatch: {
          seriesIndex: 0,
          dataIndex: 1,
          point: [1, 1],
          distance: 0,
        },
      } as any
    );

    expect(findNearestMod.findNearestPoint).not.toHaveBeenCalled();
    expect(renderers.highlightRenderer.prepare).toHaveBeenCalledTimes(1);
    expect(renderers.highlightRenderer.setVisible).toHaveBeenCalledWith(true);
  });

  it('skips findNearestPoint when nearestMatch is explicit null and hides highlight', () => {
    const renderers = makeMockRenderers();
    const xScale = createLinearScale().domain(0, 10).range(0, 100);
    const yScale = createLinearScale().domain(0, 10).range(100, 0);
    const yScales = new Map([['y', yScale]]);

    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions(),
        xScale,
        yScales,
        gridArea: makeGridArea(),
        xTickCount: 5,
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: true,
          isInGrid: true,
          source: 'mouse',
          x: 50,
          y: 50,
          gridX: 50,
          gridY: 50,
        },
        interactionScales: { xScale, yScales },
        seriesForRender: makeOptions().series,
        withAlpha: (c: string) => c,
        nearestMatch: null,
      } as any
    );

    expect(findNearestMod.findNearestPoint).not.toHaveBeenCalled();
    expect(renderers.highlightRenderer.prepare).not.toHaveBeenCalled();
    expect(renderers.highlightRenderer.setVisible).toHaveBeenCalledWith(false);
  });

  it('falls back to findNearestPoint when nearestMatch is omitted', () => {
    const renderers = makeMockRenderers();
    const xScale = createLinearScale().domain(0, 10).range(0, 100);
    const yScale = createLinearScale().domain(0, 10).range(100, 0);
    const yScales = new Map([['y', yScale]]);
    vi.mocked(findNearestMod.findNearestPoint).mockReturnValue({
      seriesIndex: 0,
      dataIndex: 0,
      point: [0, 0],
      distance: 1,
    });

    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions(),
        xScale,
        yScales,
        gridArea: makeGridArea(),
        xTickCount: 5,
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: true,
          isInGrid: true,
          source: 'mouse',
          x: 50,
          y: 50,
          gridX: 50,
          gridY: 50,
        },
        interactionScales: { xScale, yScales },
        seriesForRender: makeOptions().series,
        withAlpha: (c: string) => c,
        // nearestMatch omitted
      } as any
    );

    expect(findNearestMod.findNearestPoint).toHaveBeenCalledTimes(1);
    expect(renderers.highlightRenderer.prepare).toHaveBeenCalledTimes(1);
  });
});
