/**
 * buildPriceLineInstances — canvas-local Y, rgba parse, OOD clamp vs hide, empty.
 */

import { describe, it, expect } from 'vitest';
import { buildPriceLineInstances } from '../buildPriceLineInstances';
import type { LastCandleState } from '../priceLabelHelpers';
import type { ContinuousScale } from '../../../../utils/scales';
import { clipYToCanvasCssPx } from '../../utils/axisUtils';
import { parseCssColorToRgba01 } from '../../../../utils/colors';

/** Linear scale domain→clip range (matches coordinator: range(plotBottom, plotTop)). */
function makeYScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): ContinuousScale {
  let d0 = domainMin;
  let d1 = domainMax;
  let r0 = rangeMin;
  let r1 = rangeMax;
  return {
    kind: 'linear',
    domain(min, max) {
      d0 = min;
      d1 = max;
      return this;
    },
    range(min, max) {
      r0 = min;
      r1 = max;
      return this;
    },
    scale(value: number) {
      if (d1 === d0) return (r0 + r1) / 2;
      const t = (value - d0) / (d1 - d0);
      return r0 + t * (r1 - r0);
    },
    invert(pixel: number) {
      if (r1 === r0) return d0;
      const t = (pixel - r0) / (r1 - r0);
      return d0 + t * (d1 - d0);
    },
    getDomain: () => ({ min: d0, max: d1 }),
    getRange: () => ({ min: r0, max: r1 }),
  };
}

function makeLast(overrides: Partial<LastCandleState> = {}): LastCandleState {
  return {
    seriesIndex: 0,
    yAxisId: 'y',
    open: 100,
    close: 105,
    timestamp: 1_000,
    isUp: true,
    upColor: '#22c55e',
    downColor: '#ef4444',
    directionColor: '#22c55e',
    barEndMs: null,
    ...overrides,
  };
}

const CANVAS_H = 300;
/** Clip-space plot: bottom=-1, top=1 (full canvas). */
const yScaleInDomain = () => makeYScale(0, 200, -1, 1);

describe('buildPriceLineInstances', () => {
  it('returns [] when showLine is false', () => {
    expect(
      buildPriceLineInstances({
        last: makeLast(),
        showLine: false,
        outOfDomain: 'clamp',
        yScale: yScaleInDomain(),
        canvasCssHeight: CANVAS_H,
        lineWidth: 1,
        lineColor: null,
      })
    ).toEqual([]);
  });

  it('returns [] when last is null', () => {
    expect(
      buildPriceLineInstances({
        last: null,
        showLine: true,
        outOfDomain: 'clamp',
        yScale: yScaleInDomain(),
        canvasCssHeight: CANVAS_H,
        lineWidth: 1,
        lineColor: null,
      })
    ).toEqual([]);
  });

  it('returns [] when canvasCssHeight is 0', () => {
    expect(
      buildPriceLineInstances({
        last: makeLast(),
        showLine: true,
        outOfDomain: 'clamp',
        yScale: yScaleInDomain(),
        canvasCssHeight: 0,
        lineWidth: 1,
        lineColor: null,
      })
    ).toEqual([]);
  });

  it('returns [] when lineWidth is non-positive', () => {
    expect(
      buildPriceLineInstances({
        last: makeLast(),
        showLine: true,
        outOfDomain: 'clamp',
        yScale: yScaleInDomain(),
        canvasCssHeight: CANVAS_H,
        lineWidth: 0,
        lineColor: null,
      })
    ).toEqual([]);
  });

  it('builds horizontal line at true canvas-local Y (no offset)', () => {
    const last = makeLast({ close: 100 }); // mid domain 0..200 → clip 0
    const yScale = yScaleInDomain();
    const yClip = yScale.scale(100);
    const expectedY = clipYToCanvasCssPx(yClip, CANVAS_H);

    const lines = buildPriceLineInstances({
      last,
      showLine: true,
      outOfDomain: 'clamp',
      yScale,
      canvasCssHeight: CANVAS_H,
      lineWidth: 1,
      lineColor: null,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      axis: 'horizontal',
      positionCssPx: expectedY,
      lineWidth: 1,
    });
    // Canvas-local: mid-domain → half canvas height
    expect(lines[0]!.positionCssPx).toBeCloseTo(CANVAS_H / 2, 5);
  });

  it('uses directionColor when lineColor is null (rgba 0..1)', () => {
    const direction = '#22c55e';
    const expected = parseCssColorToRgba01(direction)!;
    const lines = buildPriceLineInstances({
      last: makeLast({ directionColor: direction, isUp: true }),
      showLine: true,
      outOfDomain: 'clamp',
      yScale: yScaleInDomain(),
      canvasCssHeight: CANVAS_H,
      lineWidth: 2,
      lineColor: null,
    });
    expect(lines[0]!.rgba).toEqual(expected);
    expect(lines[0]!.lineWidth).toBe(2);
  });

  it('prefers lineColor override over direction', () => {
    const override = '#3b82f6';
    const expected = parseCssColorToRgba01(override)!;
    const lines = buildPriceLineInstances({
      last: makeLast({ directionColor: '#22c55e' }),
      showLine: true,
      outOfDomain: 'clamp',
      yScale: yScaleInDomain(),
      canvasCssHeight: CANVAS_H,
      lineWidth: 1,
      lineColor: override,
    });
    expect(lines[0]!.rgba).toEqual(expected);
  });

  it('falls back to directionColor when lineColor fails to parse', () => {
    const direction = '#ef4444';
    const expected = parseCssColorToRgba01(direction)!;
    const lines = buildPriceLineInstances({
      last: makeLast({ directionColor: direction, isUp: false, open: 110, close: 100 }),
      showLine: true,
      outOfDomain: 'clamp',
      yScale: yScaleInDomain(),
      canvasCssHeight: CANVAS_H,
      lineWidth: 1,
      lineColor: 'not-a-color',
    });
    expect(lines[0]!.rgba).toEqual(expected);
  });

  it('OOD clamp: still draws at true Y when close outside domain', () => {
    // Domain 0..100; close 150 extrapolates above plot top
    const yScale = makeYScale(0, 100, -1, 1);
    const last = makeLast({ close: 150, open: 140 });
    const yClip = yScale.scale(150);
    const expectedY = clipYToCanvasCssPx(yClip, CANVAS_H);

    const lines = buildPriceLineInstances({
      last,
      showLine: true,
      outOfDomain: 'clamp',
      yScale,
      canvasCssHeight: CANVAS_H,
      lineWidth: 1,
      lineColor: null,
    });

    expect(lines).toHaveLength(1);
    // True Y (not clamped to plot edge) — scissor will clip at render
    expect(lines[0]!.positionCssPx).toBeCloseTo(expectedY, 5);
    // Outside canvas top (yClip > 1 → positionCssPx < 0)
    expect(lines[0]!.positionCssPx).toBeLessThan(0);
  });

  it('OOD hide: omits line when close outside domain', () => {
    const yScale = makeYScale(0, 100, -1, 1);
    const lines = buildPriceLineInstances({
      last: makeLast({ close: 150, open: 140 }),
      showLine: true,
      outOfDomain: 'hide',
      yScale,
      canvasCssHeight: CANVAS_H,
      lineWidth: 1,
      lineColor: null,
    });
    expect(lines).toEqual([]);
  });

  it('OOD hide: draws when close is inside domain', () => {
    const yScale = makeYScale(0, 100, -1, 1);
    const lines = buildPriceLineInstances({
      last: makeLast({ close: 50 }),
      showLine: true,
      outOfDomain: 'hide',
      yScale,
      canvasCssHeight: CANVAS_H,
      lineWidth: 1,
      lineColor: null,
    });
    expect(lines).toHaveLength(1);
  });

  it('omits lineDash (solid stroke)', () => {
    const lines = buildPriceLineInstances({
      last: makeLast(),
      showLine: true,
      outOfDomain: 'clamp',
      yScale: yScaleInDomain(),
      canvasCssHeight: CANVAS_H,
      lineWidth: 1,
      lineColor: null,
    });
    expect(lines[0]).not.toHaveProperty('lineDash');
  });
});
