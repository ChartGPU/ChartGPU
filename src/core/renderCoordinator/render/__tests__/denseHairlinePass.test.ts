/**
 * Unit contract: dense hairline multi-layer consistency.
 * - hasDenseHairlineLines only true when a line renderer reports hairline
 * - renderDenseHairlineLines calls renderHairline (not main render)
 * - false-positive: standard line does not open hairline draws
 */

import { describe, it, expect, vi } from 'vitest';
import {
  hasDenseHairlineLines,
  hasDenseDeferredScatter,
  renderDenseHairlineLines,
  renderDenseDeferredScatter,
  type SeriesPreparationResult,
  type SeriesRenderers,
} from '../renderSeries';
import type { LineRenderer } from '../../../../renderers/createLineRenderer';
import type { ScatterRenderer } from '../../../../renderers/createScatterRenderer';
import type { ResolvedLineSeriesConfig } from '../../../../config/OptionResolver';

function makePrep(series: Array<{ type: string; originalIndex: number; mode?: string }>): SeriesPreparationResult {
  return {
    visibleSeriesForRender: series.map((s) => ({
      series: {
        type: s.type,
        data: [],
        visible: true,
        ...(s.mode != null ? { mode: s.mode } : s.type === 'scatter' ? { mode: 'points' } : {}),
      } as unknown as ResolvedLineSeriesConfig,
      originalIndex: s.originalIndex,
    })),
    barSeriesConfigs: [],
    visibleBarSeriesConfigs: [],
  };
}

function mockLine(opts: {
  hairline: boolean;
  render?: ReturnType<typeof vi.fn>;
  renderHairline?: ReturnType<typeof vi.fn>;
  bindHairlinePipeline?: ReturnType<typeof vi.fn>;
}): LineRenderer {
  return {
    prepare: vi.fn(),
    render: opts.render ?? vi.fn(),
    isDenseHairline: () => opts.hairline,
    renderHairline: opts.renderHairline ?? vi.fn(),
    bindHairlinePipeline: opts.bindHairlinePipeline ?? vi.fn(),
    dispose: vi.fn(),
  } as unknown as LineRenderer;
}

function emptyRenderers(lines: LineRenderer[], scatters: ScatterRenderer[] = []): SeriesRenderers {
  return {
    lineRenderers: lines,
    areaRenderers: [],
    barRenderer: { prepare: vi.fn(), render: vi.fn(), dispose: vi.fn() } as any,
    scatterRenderers: scatters,
    scatterDensityRenderers: [],
    pieRenderers: [],
    heatmapRenderers: [],
    candlestickRenderers: [],
    ohlcRenderers: [],
    errorBarRenderers: [],
    impulseRenderers: [],
    decimationComputes: [],
  };
}

function mockScatter(opts: {
  deferred: boolean;
  render?: ReturnType<typeof vi.fn>;
  renderDense?: ReturnType<typeof vi.fn>;
}): ScatterRenderer {
  return {
    prepare: vi.fn(),
    invalidateGeometry: vi.fn(),
    render: opts.render ?? vi.fn(),
    isDenseDeferred: () => opts.deferred,
    renderDense: opts.renderDense ?? vi.fn(),
    dispose: vi.fn(),
  } as unknown as ScatterRenderer;
}

describe('hasDenseHairlineLines / renderDenseHairlineLines', () => {
  it('returns false when no line is hairline (false-positive miss)', () => {
    const renderers = emptyRenderers([mockLine({ hairline: false })]);
    const prep = makePrep([{ type: 'line', originalIndex: 0 }]);
    expect(hasDenseHairlineLines(renderers, prep)).toBe(false);
  });

  it('returns true when a visible line is dense hairline (hit)', () => {
    const renderers = emptyRenderers([mockLine({ hairline: false }), mockLine({ hairline: true })]);
    const prep = makePrep([
      { type: 'line', originalIndex: 0 },
      { type: 'line', originalIndex: 1 },
    ]);
    expect(hasDenseHairlineLines(renderers, prep)).toBe(true);
  });

  it('ignores non-line series for hairline detection', () => {
    const renderers = emptyRenderers([mockLine({ hairline: true })]);
    const prep = makePrep([{ type: 'scatter', originalIndex: 0 }]);
    expect(hasDenseHairlineLines(renderers, prep)).toBe(false);
  });

  it('renderDenseHairlineLines only calls renderHairline on hairline lines', () => {
    const renderMain0 = vi.fn();
    const renderHair0 = vi.fn();
    const renderMain1 = vi.fn();
    const renderHair1 = vi.fn();
    const bindPipe1 = vi.fn();
    const renderers = emptyRenderers([
      mockLine({ hairline: false, render: renderMain0, renderHairline: renderHair0 }),
      mockLine({
        hairline: true,
        render: renderMain1,
        renderHairline: renderHair1,
        bindHairlinePipeline: bindPipe1,
      }),
    ]);
    const prep = makePrep([
      { type: 'line', originalIndex: 0 },
      { type: 'line', originalIndex: 1 },
    ]);
    const hairlinePass = {
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;

    renderDenseHairlineLines(
      renderers,
      {
        gridArea: {
          canvasWidth: 800,
          canvasHeight: 600,
          devicePixelRatio: 1,
          left: 0,
          top: 0,
          width: 800,
          height: 600,
        } as any,
        hairlinePass,
        plotScissor: { x: 10, y: 10, w: 700, h: 500 },
        introPhase: 'done',
        introProgress01: 1,
      },
      prep
    );

    expect(renderHair0).not.toHaveBeenCalled();
    expect(renderMain0).not.toHaveBeenCalled();
    expect(renderMain1).not.toHaveBeenCalled();
    expect(bindPipe1).toHaveBeenCalledTimes(1);
    expect(bindPipe1).toHaveBeenCalledWith(hairlinePass);
    expect(renderHair1).toHaveBeenCalledTimes(1);
    // Multi-series batch: pipeline set once, then draw with skipSetPipeline.
    expect(renderHair1).toHaveBeenCalledWith(hairlinePass, { skipSetPipeline: true });
  });

  it('bindHairlinePipeline once for N≥2 hairline series, each draw with skipSetPipeline', () => {
    const bind0 = vi.fn();
    const bind1 = vi.fn();
    const bind2 = vi.fn();
    const hair0 = vi.fn();
    const hair1 = vi.fn();
    const hair2 = vi.fn();
    const renderers = emptyRenderers([
      mockLine({ hairline: true, renderHairline: hair0, bindHairlinePipeline: bind0 }),
      mockLine({ hairline: true, renderHairline: hair1, bindHairlinePipeline: bind1 }),
      mockLine({ hairline: true, renderHairline: hair2, bindHairlinePipeline: bind2 }),
    ]);
    const prep = makePrep([
      { type: 'line', originalIndex: 0 },
      { type: 'line', originalIndex: 1 },
      { type: 'line', originalIndex: 2 },
    ]);
    const hairlinePass = {
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;

    renderDenseHairlineLines(
      renderers,
      {
        gridArea: {
          canvasWidth: 800,
          canvasHeight: 600,
          devicePixelRatio: 1,
          left: 0,
          top: 0,
          width: 800,
          height: 600,
        } as any,
        hairlinePass,
        plotScissor: { x: 10, y: 10, w: 700, h: 500 },
        introPhase: 'done',
        introProgress01: 1,
      },
      prep
    );

    // Only the first hairline series binds the pipeline.
    expect(bind0).toHaveBeenCalledTimes(1);
    expect(bind1).not.toHaveBeenCalled();
    expect(bind2).not.toHaveBeenCalled();
    expect(hair0).toHaveBeenCalledWith(hairlinePass, { skipSetPipeline: true });
    expect(hair1).toHaveBeenCalledWith(hairlinePass, { skipSetPipeline: true });
    expect(hair2).toHaveBeenCalledWith(hairlinePass, { skipSetPipeline: true });
  });
});

describe('hasDenseDeferredScatter / renderDenseDeferredScatter', () => {
  it('returns false when no scatter is deferred (false-positive miss)', () => {
    const renderers = emptyRenderers([], [mockScatter({ deferred: false })]);
    const prep = makePrep([{ type: 'scatter', originalIndex: 0 }]);
    expect(hasDenseDeferredScatter(renderers, prep)).toBe(false);
  });

  it('returns true when a visible scatter is dense-deferred (hit)', () => {
    const renderers = emptyRenderers([], [mockScatter({ deferred: false }), mockScatter({ deferred: true })]);
    const prep = makePrep([
      { type: 'scatter', originalIndex: 0 },
      { type: 'scatter', originalIndex: 1 },
    ]);
    expect(hasDenseDeferredScatter(renderers, prep)).toBe(true);
  });

  it('ignores line series for scatter deferral detection', () => {
    const renderers = emptyRenderers([mockLine({ hairline: true })], [mockScatter({ deferred: true })]);
    const prep = makePrep([{ type: 'line', originalIndex: 0 }]);
    expect(hasDenseDeferredScatter(renderers, prep)).toBe(false);
  });

  it('renderDenseDeferredScatter only calls renderDense on deferred scatter', () => {
    const renderMain0 = vi.fn();
    const renderDense0 = vi.fn();
    const renderMain1 = vi.fn();
    const renderDense1 = vi.fn();
    const renderers = emptyRenderers(
      [],
      [
        mockScatter({ deferred: false, render: renderMain0, renderDense: renderDense0 }),
        mockScatter({ deferred: true, render: renderMain1, renderDense: renderDense1 }),
      ]
    );
    const prep = makePrep([
      { type: 'scatter', originalIndex: 0 },
      { type: 'scatter', originalIndex: 1 },
    ]);
    const densePass = {
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;

    renderDenseDeferredScatter(
      renderers,
      {
        gridArea: {
          canvasWidth: 800,
          canvasHeight: 600,
          devicePixelRatio: 1,
          left: 0,
          top: 0,
          width: 800,
          height: 600,
        } as any,
        densePass,
        plotScissor: { x: 10, y: 10, w: 700, h: 500 },
        introPhase: 'done',
        introProgress01: 1,
      },
      prep
    );

    expect(renderDense0).not.toHaveBeenCalled();
    expect(renderMain0).not.toHaveBeenCalled();
    expect(renderMain1).not.toHaveBeenCalled();
    expect(renderDense1).toHaveBeenCalledTimes(1);
    expect(renderDense1).toHaveBeenCalledWith(densePass);
  });

  it('ignores density-mode scatter (false-positive miss)', () => {
    const renderDense = vi.fn();
    const renderers = emptyRenderers([], [mockScatter({ deferred: true, renderDense })]);
    const prep = makePrep([{ type: 'scatter', originalIndex: 0, mode: 'density' }]);
    expect(hasDenseDeferredScatter(renderers, prep)).toBe(false);

    const densePass = {
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    renderDenseDeferredScatter(
      renderers,
      {
        gridArea: {
          canvasWidth: 800,
          canvasHeight: 600,
          devicePixelRatio: 1,
          left: 0,
          top: 0,
          width: 800,
          height: 600,
        } as any,
        densePass,
        plotScissor: { x: 10, y: 10, w: 700, h: 500 },
        introPhase: 'done',
        introProgress01: 1,
      },
      prep
    );
    expect(renderDense).not.toHaveBeenCalled();
  });

  it('multi deferred scatter series each get renderDense once', () => {
    const d0 = vi.fn();
    const d1 = vi.fn();
    const renderers = emptyRenderers(
      [],
      [mockScatter({ deferred: true, renderDense: d0 }), mockScatter({ deferred: true, renderDense: d1 })]
    );
    const prep = makePrep([
      { type: 'scatter', originalIndex: 0 },
      { type: 'scatter', originalIndex: 1 },
    ]);
    const densePass = {
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    renderDenseDeferredScatter(
      renderers,
      {
        gridArea: {
          canvasWidth: 800,
          canvasHeight: 600,
          devicePixelRatio: 1,
          left: 0,
          top: 0,
          width: 800,
          height: 600,
        } as any,
        densePass,
        plotScissor: { x: 10, y: 10, w: 700, h: 500 },
        introPhase: 'done',
        introProgress01: 1,
      },
      prep
    );
    expect(d0).toHaveBeenCalledTimes(1);
    expect(d1).toHaveBeenCalledTimes(1);
    expect(d0).toHaveBeenCalledWith(densePass);
    expect(d1).toHaveBeenCalledWith(densePass);
  });
});
