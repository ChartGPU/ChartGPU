/**
 * P1-6: Overlay prepare memo — skip grid/axis prepare when signatures match.
 * Drives real `prepareOverlays` with mock renderers that count prepare calls.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createLinearScale } from '../../../../utils/scales';
import {
  createOverlayPrepareMemo,
  buildGridPrepareSignature,
  gridPrepareSignaturesEqual,
  buildAxisPrepareSignature,
  axisPrepareSignaturesEqual,
} from '../overlayPrepareMemo';
import { prepareOverlays } from '../renderOverlays';
import type { ResolvedChartGPUOptions } from '../../../../config/OptionResolver';
import type { GridArea } from '../../../../renderers/createGridRenderer';

beforeAll(() => {
  // prepareOverlays does not need real WebGPU for the memo path.
});

function makeGridArea(overrides: Partial<GridArea> = {}): GridArea {
  return {
    left: 40,
    right: 20,
    top: 20,
    bottom: 40,
    canvasWidth: 1280,
    canvasHeight: 720,
    devicePixelRatio: 2,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ResolvedChartGPUOptions> = {}): ResolvedChartGPUOptions {
  return {
    grid: { left: 40, right: 20, top: 20, bottom: 40 },
    gridLines: {
      show: true,
      color: 'rgba(255,255,255,0.15)',
      opacity: 1,
      horizontal: {
        show: true,
        count: 5,
        color: 'rgba(255,255,255,0.15)',
      },
      vertical: {
        show: true,
        count: 6,
        color: 'rgba(255,255,255,0.15)',
      },
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
    series: [],
    ...overrides,
  } as ResolvedChartGPUOptions;
}

function makeMockRenderers() {
  return {
    gridRenderer: {
      prepare: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    },
    xAxisRenderer: {
      prepare: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    },
    yAxisRenderers: new Map([
      [
        'y',
        {
          prepare: vi.fn(),
          render: vi.fn(),
          dispose: vi.fn(),
        },
      ],
    ]),
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

function baseContext(
  renderers: ReturnType<typeof makeMockRenderers>,
  memo: ReturnType<typeof createOverlayPrepareMemo>,
  overrides: Record<string, unknown> = {}
) {
  const xScale = createLinearScale().domain(0, 100).range(0, 1);
  const yScale = createLinearScale().domain(0, 50).range(1, 0);
  const yScales = new Map([['y', yScale]]);
  return {
    currentOptions: makeOptions(),
    xScale,
    yScales,
    gridArea: makeGridArea(),
    xTickCount: 5,
    hasCartesianSeries: true,
    effectivePointer: {
      hasPointer: false,
      isInGrid: false,
      source: 'mouse' as const,
      x: 0,
      y: 0,
      gridX: 0,
      gridY: 0,
    },
    interactionScales: null,
    seriesForRender: [],
    withAlpha: (c: string) => c,
    overlayPrepareMemo: memo,
    ...overrides,
  };
}

describe('overlayPrepareMemo signatures (P1-6)', () => {
  it('gridPrepareSignaturesEqual is true only for identical inputs', () => {
    const area = makeGridArea();
    const a = buildGridPrepareSignature({
      gridArea: area,
      show: true,
      horizontalCount: 5,
      verticalCount: 6,
      horizontalColor: '#aaa',
      verticalColor: '#bbb',
    });
    const b = buildGridPrepareSignature({
      gridArea: area,
      show: true,
      horizontalCount: 5,
      verticalCount: 6,
      horizontalColor: '#aaa',
      verticalColor: '#bbb',
    });
    expect(gridPrepareSignaturesEqual(a, b)).toBe(true);
    expect(
      gridPrepareSignaturesEqual(a, {
        ...b,
        horizontalCount: 7,
      })
    ).toBe(false);
    expect(gridPrepareSignaturesEqual(null, b)).toBe(false);
  });

  it('axisPrepareSignaturesEqual tracks scale affine samples', () => {
    const scaleA = createLinearScale().domain(0, 100).range(0, 1);
    const scaleB = createLinearScale().domain(0, 200).range(0, 1);
    const area = makeGridArea();
    const axis = { type: 'value' as const, id: 'x' };
    const a = buildAxisPrepareSignature({
      axisConfig: axis,
      scale: scaleA,
      orientation: 'x',
      axisId: 'x',
      gridArea: area,
      axisLineColor: '#888',
      axisTickColor: '#666',
      tickCount: 5,
    });
    const b = buildAxisPrepareSignature({
      axisConfig: axis,
      scale: scaleA,
      orientation: 'x',
      axisId: 'x',
      gridArea: area,
      axisLineColor: '#888',
      axisTickColor: '#666',
      tickCount: 5,
    });
    expect(axisPrepareSignaturesEqual(a, b)).toBe(true);
    const c = buildAxisPrepareSignature({
      axisConfig: axis,
      scale: scaleB,
      orientation: 'x',
      axisId: 'x',
      gridArea: area,
      axisLineColor: '#888',
      axisTickColor: '#666',
      tickCount: 5,
    });
    expect(axisPrepareSignaturesEqual(a, c)).toBe(false);
  });

  it('axisPrepareSignaturesEqual tracks explicit tick values (same count, different values)', () => {
    const scale = createLinearScale().domain(0, 100).range(0, 1);
    const area = makeGridArea();
    const axis = { type: 'time' as const, id: 'x' };
    const a = buildAxisPrepareSignature({
      axisConfig: axis,
      scale,
      orientation: 'x',
      axisId: 'x',
      gridArea: area,
      axisLineColor: '#888',
      axisTickColor: '#666',
      tickCount: 3,
      tickValues: [10, 20, 30],
    });
    const b = buildAxisPrepareSignature({
      axisConfig: axis,
      scale,
      orientation: 'x',
      axisId: 'x',
      gridArea: area,
      axisLineColor: '#888',
      axisTickColor: '#666',
      tickCount: 3,
      tickValues: [10, 20, 30],
    });
    expect(axisPrepareSignaturesEqual(a, b)).toBe(true);
    const c = buildAxisPrepareSignature({
      axisConfig: axis,
      scale,
      orientation: 'x',
      axisId: 'x',
      gridArea: area,
      axisLineColor: '#888',
      axisTickColor: '#666',
      tickCount: 3,
      tickValues: [15, 25, 35],
    });
    expect(axisPrepareSignaturesEqual(a, c)).toBe(false);
  });
});

describe('prepareOverlays with OverlayPrepareMemo (P1-6)', () => {
  it('skips grid and axis prepare on matching second frame', () => {
    const memo = createOverlayPrepareMemo();
    const renderers = makeMockRenderers();
    const ctx = baseContext(renderers, memo);

    prepareOverlays(renderers as any, ctx as any);
    expect(renderers.gridRenderer.prepare).toHaveBeenCalledTimes(1);
    expect(renderers.xAxisRenderer.prepare).toHaveBeenCalledTimes(1);
    expect(renderers.yAxisRenderers.get('y')!.prepare).toHaveBeenCalledTimes(1);

    prepareOverlays(renderers as any, ctx as any);
    expect(renderers.gridRenderer.prepare).toHaveBeenCalledTimes(1);
    expect(renderers.xAxisRenderer.prepare).toHaveBeenCalledTimes(1);
    expect(renderers.yAxisRenderers.get('y')!.prepare).toHaveBeenCalledTimes(1);
  });

  it('re-prepares grid when color signature changes', () => {
    const memo = createOverlayPrepareMemo();
    const renderers = makeMockRenderers();
    const ctx = baseContext(renderers, memo);

    prepareOverlays(renderers as any, ctx as any);
    expect(renderers.gridRenderer.prepare).toHaveBeenCalledTimes(1);

    const nextOptions = makeOptions({
      gridLines: {
        show: true,
        color: 'rgba(255,0,0,0.2)',
        opacity: 1,
        horizontal: {
          show: true,
          count: 5,
          color: 'rgba(255,0,0,0.2)',
        },
        vertical: {
          show: true,
          count: 6,
          color: 'rgba(255,0,0,0.2)',
        },
      },
    });
    prepareOverlays(
      renderers as any,
      {
        ...ctx,
        currentOptions: nextOptions,
      } as any
    );
    expect(renderers.gridRenderer.prepare).toHaveBeenCalledTimes(2);
  });

  it('re-prepares axes when scale affine changes', () => {
    const memo = createOverlayPrepareMemo();
    const renderers = makeMockRenderers();
    const ctx = baseContext(renderers, memo);

    prepareOverlays(renderers as any, ctx as any);
    expect(renderers.xAxisRenderer.prepare).toHaveBeenCalledTimes(1);

    const zoomedX = createLinearScale().domain(10, 50).range(0, 1);
    prepareOverlays(
      renderers as any,
      {
        ...ctx,
        xScale: zoomedX,
      } as any
    );
    expect(renderers.xAxisRenderer.prepare).toHaveBeenCalledTimes(2);
    // Grid signature does not include scale — still skipped.
    expect(renderers.gridRenderer.prepare).toHaveBeenCalledTimes(1);
  });

  it('passes xTickValues to xAxisRenderer.prepare and re-prepares when values change', () => {
    const memo = createOverlayPrepareMemo();
    const renderers = makeMockRenderers();
    const ticksA = [0, 25, 50, 75, 100];
    const ticksB = [10, 30, 50, 70, 90];
    const ctx = baseContext(renderers, memo, {
      xTickCount: ticksA.length,
      xTickValues: ticksA,
    });

    prepareOverlays(renderers as any, ctx as any);
    expect(renderers.xAxisRenderer.prepare).toHaveBeenCalledTimes(1);
    const firstArgs = renderers.xAxisRenderer.prepare.mock.calls[0]!;
    expect(firstArgs[6]).toBe(ticksA.length);
    expect(firstArgs[7]).toEqual(ticksA);

    // Same values → skip
    prepareOverlays(renderers as any, ctx as any);
    expect(renderers.xAxisRenderer.prepare).toHaveBeenCalledTimes(1);

    // Same count, different values → re-prepare
    prepareOverlays(
      renderers as any,
      {
        ...ctx,
        xTickCount: ticksB.length,
        xTickValues: ticksB,
      } as any
    );
    expect(renderers.xAxisRenderer.prepare).toHaveBeenCalledTimes(2);
    const secondArgs = renderers.xAxisRenderer.prepare.mock.calls[1]!;
    expect(secondArgs[7]).toEqual(ticksB);
  });

  it('always prepares crosshair even when grid/axis memo hits', () => {
    const memo = createOverlayPrepareMemo();
    const renderers = makeMockRenderers();
    const pointer = {
      hasPointer: true,
      isInGrid: true,
      source: 'mouse' as const,
      x: 100,
      y: 100,
      gridX: 60,
      gridY: 80,
    };
    const ctx = baseContext(renderers, memo, { effectivePointer: pointer });

    prepareOverlays(renderers as any, ctx as any);
    prepareOverlays(renderers as any, ctx as any);

    expect(renderers.gridRenderer.prepare).toHaveBeenCalledTimes(1);
    expect(renderers.crosshairRenderer.prepare).toHaveBeenCalledTimes(2);
    expect(renderers.crosshairRenderer.setVisible).toHaveBeenCalledWith(true);
  });
});
