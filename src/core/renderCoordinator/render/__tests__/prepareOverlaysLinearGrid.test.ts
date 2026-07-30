/**
 * Linear (value) grid is tick-aligned: horizontalClipYs / verticalClipXs match scale(tick).
 */

import { describe, it, expect, vi } from 'vitest';
import { createLinearScale } from '../../../../utils/scales';
import { prepareOverlays } from '../renderOverlays';
import { generateValueAxisTicks } from '../../axis/computeAxisTicks';
import type { ResolvedChartGPUOptions } from '../../../../config/OptionResolver';
import type { GridArea } from '../../../../renderers/createGridRenderer';

function makeGridArea(): GridArea {
  return {
    left: 40,
    right: 20,
    top: 20,
    bottom: 40,
    canvasWidth: 800,
    canvasHeight: 600,
    devicePixelRatio: 1,
  };
}

function makeOptions(overrides: Partial<ResolvedChartGPUOptions> = {}): ResolvedChartGPUOptions {
  return {
    grid: { left: 40, right: 20, top: 20, bottom: 40 },
    gridLines: {
      show: true,
      color: 'rgba(255,255,255,0.15)',
      opacity: 1,
      horizontal: { show: true, count: 5, color: 'rgba(255,255,255,0.15)' },
      vertical: { show: true, count: 6, color: 'rgba(255,255,255,0.15)' },
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
    series: [{ type: 'line', data: [] }],
    ...overrides,
  } as ResolvedChartGPUOptions;
}

function makeMockRenderers() {
  return {
    gridRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() },
    xAxisRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() },
    yAxisRenderers: new Map([['y', { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() }]]),
    crosshairRenderer: { prepare: vi.fn(), setVisible: vi.fn(), render: vi.fn(), dispose: vi.fn() },
    highlightRenderer: { prepare: vi.fn(), setVisible: vi.fn(), render: vi.fn(), dispose: vi.fn() },
  };
}

describe('prepareOverlays linear tick-aligned grid (WS2)', () => {
  it('maps primary Y nice ticks → horizontalClipYs via yScale.scale', () => {
    const yDomain = { min: 0, max: 100 };
    const yScale = createLinearScale().domain(yDomain.min, yDomain.max).range(-1, 1);
    const xScale = createLinearScale().domain(0, 10).range(-1, 1);
    const yTicks = generateValueAxisTicks(yDomain.min, yDomain.max, 5);
    const expectedYs = yTicks.map((t) => yScale.scale(t)).filter((c) => Number.isFinite(c));

    const renderers = makeMockRenderers();
    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions(),
        xScale,
        yScales: new Map([['y', yScale]]),
        gridArea: makeGridArea(),
        xTickCount: 5,
        xTickValues: [0, 2, 4, 6, 8, 10],
        yTickValuesByAxis: new Map([['y', yTicks]]),
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );

    expect(renderers.gridRenderer.prepare).toHaveBeenCalled();
    const call = renderers.gridRenderer.prepare.mock.calls[0]!;
    const opts = call[1] as {
      horizontalClipYs?: readonly number[];
      verticalClipXs?: readonly number[];
      lineCount?: { horizontal: number; vertical: number };
    };
    expect(opts.horizontalClipYs).toBeDefined();
    expect(opts.horizontalClipYs!.length).toBe(expectedYs.length);
    for (let i = 0; i < expectedYs.length; i++) {
      expect(opts.horizontalClipYs![i]).toBeCloseTo(expectedYs[i]!, 10);
    }
  });

  it('maps value X tick values → verticalClipXs via xScale.scale', () => {
    const xTicks = [0, 25, 50, 75, 100];
    const xScale = createLinearScale().domain(0, 100).range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(-1, 1);
    const expectedXs = xTicks.map((t) => xScale.scale(t));

    const renderers = makeMockRenderers();
    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions(),
        xScale,
        yScales: new Map([['y', yScale]]),
        gridArea: makeGridArea(),
        xTickCount: xTicks.length,
        xTickValues: xTicks,
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );

    const call = renderers.gridRenderer.prepare.mock.calls[0]!;
    const opts = call[1] as { verticalClipXs?: readonly number[] };
    expect(opts.verticalClipXs).toBeDefined();
    expect(opts.verticalClipXs!.length).toBe(expectedXs.length);
    for (let i = 0; i < expectedXs.length; i++) {
      expect(opts.verticalClipXs![i]).toBeCloseTo(expectedXs[i]!, 10);
    }
  });

  it('log Y path still tick-aligns (unchanged contract)', () => {
    const yTicks = [1, 10, 100];
    // Use linear scale with domain matching log tick values for clip math only —
    // prepareOverlays maps ticks through whatever scale is provided.
    const yScale = createLinearScale().domain(1, 100).range(-1, 1);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    const expectedYs = yTicks.map((t) => yScale.scale(t));

    const renderers = makeMockRenderers();
    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions({
          yAxes: [{ type: 'log', id: 'y', position: 'left', logBase: 10 }],
        }),
        xScale,
        yScales: new Map([['y', yScale]]),
        gridArea: makeGridArea(),
        xTickCount: 2,
        xTickValues: [0, 1],
        yTickValuesByAxis: new Map([['y', yTicks]]),
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );

    const opts = renderers.gridRenderer.prepare.mock.calls[0]![1] as {
      horizontalClipYs?: readonly number[];
    };
    expect(opts.horizontalClipYs).toBeDefined();
    for (let i = 0; i < expectedYs.length; i++) {
      expect(opts.horizontalClipYs![i]).toBeCloseTo(expectedYs[i]!, 10);
    }
  });

  it('uses same y tick list for yAxisRenderer.prepare (single source of truth)', () => {
    const yTicks = generateValueAxisTicks(0, 100, 5);
    const yScale = createLinearScale().domain(0, 100).range(-1, 1);
    const xScale = createLinearScale().domain(0, 10).range(-1, 1);
    const renderers = makeMockRenderers();

    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions(),
        xScale,
        yScales: new Map([['y', yScale]]),
        gridArea: makeGridArea(),
        xTickCount: 5,
        xTickValues: [0, 2, 4, 6, 8],
        yTickValuesByAxis: new Map([['y', yTicks]]),
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );

    const yPrepare = renderers.yAxisRenderers.get('y')!.prepare as ReturnType<typeof vi.fn>;
    expect(yPrepare).toHaveBeenCalled();
    const args = yPrepare.mock.calls[0]!;
    // prepare(axisConfig, scale, 'y', gridArea, lineColor, tickColor, tickCount, tickValues)
    expect(args[7]).toEqual(yTicks);
  });

  it('H grid show false → no horizontalClipYs / zero H count', () => {
    const renderers = makeMockRenderers();
    const yScale = createLinearScale().domain(0, 100).range(-1, 1);
    const xScale = createLinearScale().domain(0, 10).range(-1, 1);
    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions({
          gridLines: {
            show: true,
            color: 'rgba(255,255,255,0.15)',
            opacity: 1,
            horizontal: { show: false, count: 5, color: 'rgba(255,255,255,0.15)' },
            vertical: { show: true, count: 6, color: 'rgba(255,255,255,0.15)' },
          },
        }),
        xScale,
        yScales: new Map([['y', yScale]]),
        gridArea: makeGridArea(),
        xTickCount: 3,
        xTickValues: [0, 5, 10],
        yTickValuesByAxis: new Map([['y', [0, 50, 100]]]),
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );
    const opts = renderers.gridRenderer.prepare.mock.calls[0]![1] as {
      horizontalClipYs?: readonly number[];
      lineCount?: { horizontal: number; vertical: number };
    };
    expect(opts.horizontalClipYs).toBeUndefined();
    expect(opts.lineCount?.horizontal ?? 0).toBe(0);
  });

  it('empty xTickValues → no verticalClipXs (count fallback)', () => {
    const renderers = makeMockRenderers();
    const yScale = createLinearScale().domain(0, 1).range(-1, 1);
    const xScale = createLinearScale().domain(0, 10).range(-1, 1);
    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions(),
        xScale,
        yScales: new Map([['y', yScale]]),
        gridArea: makeGridArea(),
        xTickCount: 6,
        xTickValues: [],
        yTickValuesByAxis: new Map([['y', [0, 1]]]),
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );
    const opts = renderers.gridRenderer.prepare.mock.calls[0]![1] as {
      verticalClipXs?: readonly number[];
      lineCount?: { horizontal: number; vertical: number };
    };
    expect(opts.verticalClipXs).toBeUndefined();
    expect(opts.lineCount?.vertical).toBe(6);
  });

  it('omitted yTickValuesByAxis regenerates nice ticks for value Y', () => {
    const renderers = makeMockRenderers();
    const yScale = createLinearScale().domain(0, 100).range(-1, 1);
    const xScale = createLinearScale().domain(0, 10).range(-1, 1);
    const expected = generateValueAxisTicks(0, 100, 5);
    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions(),
        xScale,
        yScales: new Map([['y', yScale]]),
        gridArea: makeGridArea(),
        xTickCount: 2,
        xTickValues: [0, 10],
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );
    const yPrepare = renderers.yAxisRenderers.get('y')!.prepare as ReturnType<typeof vi.fn>;
    expect(yPrepare.mock.calls[0]![7]).toEqual(expected);
  });

  it('multi-Y: primary only drives horizontal clips', () => {
    const renderers = makeMockRenderers();
    renderers.yAxisRenderers.set('y2', { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() });
    const yPrimary = createLinearScale().domain(0, 100).range(-1, 1);
    const ySec = createLinearScale().domain(0, 1000).range(-1, 1);
    const xScale = createLinearScale().domain(0, 1).range(-1, 1);
    // Distinct tick sets so primary clips cannot match secondary scale(tick) list.
    const primaryTicks = [0, 25, 50, 75, 100];
    const secondaryTicks = [0, 1000];
    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions({
          yAxes: [
            { type: 'value', id: 'y', position: 'left' },
            { type: 'value', id: 'y2', position: 'right' },
          ],
        }),
        xScale,
        yScales: new Map([
          ['y', yPrimary],
          ['y2', ySec],
        ]),
        gridArea: makeGridArea(),
        xTickCount: 2,
        xTickValues: [0, 1],
        yTickValuesByAxis: new Map([
          ['y', primaryTicks],
          ['y2', secondaryTicks],
        ]),
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );
    const opts = renderers.gridRenderer.prepare.mock.calls[0]![1] as {
      horizontalClipYs?: readonly number[];
    };
    const primaryClips = primaryTicks.map((t) => yPrimary.scale(t));
    const secondaryClips = secondaryTicks.map((t) => ySec.scale(t));
    expect(opts.horizontalClipYs).toEqual(primaryClips);
    expect(opts.horizontalClipYs!.length).toBe(5);
    expect(opts.horizontalClipYs).not.toEqual(secondaryClips);
  });

  it('time X tick values map to verticalClipXs', () => {
    const renderers = makeMockRenderers();
    const t0 = 1_700_000_000_000;
    const xTicks = [t0, t0 + 60_000, t0 + 120_000];
    const xScale = createLinearScale()
      .domain(t0, t0 + 120_000)
      .range(-1, 1);
    const yScale = createLinearScale().domain(0, 1).range(-1, 1);
    prepareOverlays(
      renderers as any,
      {
        currentOptions: makeOptions({ xAxis: { type: 'time', id: 'x' } }),
        xScale,
        yScales: new Map([['y', yScale]]),
        gridArea: makeGridArea(),
        xTickCount: xTicks.length,
        xTickValues: xTicks,
        yTickValuesByAxis: new Map([['y', [0, 1]]]),
        hasCartesianSeries: true,
        effectivePointer: {
          hasPointer: false,
          isInGrid: false,
          source: 'mouse',
          x: 0,
          y: 0,
          gridX: 0,
          gridY: 0,
        },
        interactionScales: null,
        seriesForRender: [],
        withAlpha: (c: string) => c,
      } as any
    );
    const opts = renderers.gridRenderer.prepare.mock.calls[0]![1] as {
      verticalClipXs?: readonly number[];
    };
    expect(opts.verticalClipXs).toEqual(xTicks.map((t) => xScale.scale(t)));
  });
});
