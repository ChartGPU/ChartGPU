import { describe, it, expect } from 'vitest';
import {
  impulseStemForSample,
  impulseStemRect,
  impulseBounds,
  forEachImpulseStem,
  pointInImpulseRect,
  impulseMarkerRect,
  expandImpulseRect,
} from '../impulseGeometry';
import type { CartesianSeriesData } from '../../config/types';

describe('impulseStemForSample', () => {
  it('returns stem endpoints for finite sample', () => {
    const s = impulseStemForSample(1, 5, 0);
    expect(s).toEqual({ x: 1, y: 5, baseline: 0, zeroLength: false });
  });

  it('skips non-finite x/y', () => {
    expect(impulseStemForSample(Number.NaN, 1, 0)).toBeNull();
    expect(impulseStemForSample(1, Number.NaN, 0)).toBeNull();
    expect(impulseStemForSample(1, Number.POSITIVE_INFINITY, 0)).toBeNull();
  });

  it('marks zero-length when y === baseline', () => {
    const s = impulseStemForSample(2, 0, 0);
    expect(s?.zeroLength).toBe(true);
    expect(impulseStemRect(s!, 0.1)).toBeNull();
  });

  it('uses 0 when baseline non-finite', () => {
    const s = impulseStemForSample(1, 2, Number.NaN);
    expect(s?.baseline).toBe(0);
  });
});

describe('impulseStemRect', () => {
  it('builds vertical domain rect with half thickness', () => {
    const s = impulseStemForSample(10, 4, 1)!;
    const r = impulseStemRect(s, 0.5)!;
    expect(r.minX).toBe(9.5);
    expect(r.maxX).toBe(10.5);
    expect(r.minY).toBe(1);
    expect(r.maxY).toBe(4);
  });

  it('handles negative y below baseline', () => {
    const s = impulseStemForSample(0, -2, 0)!;
    const r = impulseStemRect(s, 0.25)!;
    expect(r.minY).toBe(-2);
    expect(r.maxY).toBe(0);
  });
});

describe('impulseBounds', () => {
  it('includes baseline below data range', () => {
    const data: CartesianSeriesData = {
      x: [0, 1, 2],
      y: [2, 3, 4],
    };
    const b = impulseBounds(data, 0)!;
    expect(b.yMin).toBe(0);
    expect(b.yMax).toBe(4);
    expect(b.xMin).toBe(0);
    expect(b.xMax).toBe(2);
  });

  it('includes baseline above data range', () => {
    const data: CartesianSeriesData = { x: [0], y: [-5] };
    const b = impulseBounds(data, 0)!;
    expect(b.yMin).toBe(-5);
    expect(b.yMax).toBe(0);
  });

  it('skips non-finite samples via data bounds', () => {
    const data = [[0, 1], null, [2, 3]] as unknown as CartesianSeriesData;
    const b = impulseBounds(data, 0)!;
    expect(b.xMin).toBe(0);
    expect(b.xMax).toBe(2);
    expect(b.yMin).toBe(0);
    expect(b.yMax).toBe(3);
  });
});

describe('forEachImpulseStem', () => {
  it('visits finite samples only', () => {
    const data = [[0, 2], null, [1, -1], [2, 3]] as unknown as CartesianSeriesData;
    const stems: number[] = [];
    forEachImpulseStem(data, 0, (s, i) => {
      stems.push(i);
      expect(Number.isFinite(s.x)).toBe(true);
    });
    expect(stems).toEqual([0, 2, 3]);
  });
});

describe('hit helpers', () => {
  it('pointInImpulseRect and marker', () => {
    const stem = impulseStemForSample(1, 4, 0)!;
    const r = impulseStemRect(stem, 0.2)!;
    expect(pointInImpulseRect(1, 2, r)).toBe(true);
    expect(pointInImpulseRect(2, 2, r)).toBe(false);
    const m = impulseMarkerRect(1, 4, 0.5);
    expect(pointInImpulseRect(1.2, 4.1, m)).toBe(true);
  });
});

describe('impulseBounds empty + expandImpulseRect', () => {
  it('empty data exposes baseline floor', () => {
    const b = impulseBounds([], 3)!;
    expect(b.yMin).toBe(3);
    expect(b.yMax).toBe(3);
  });

  it('expandImpulseRect pads and clamps pad ≤ 0 to zero expand', () => {
    const r = { minX: 1, maxX: 2, minY: 0, maxY: 4 };
    const expanded = expandImpulseRect(r, 0.5, 1);
    expect(expanded.minX).toBe(0.5);
    expect(expanded.maxX).toBe(2.5);
    expect(expanded.minY).toBe(-1);
    expect(expanded.maxY).toBe(5);
    const noPad = expandImpulseRect(r, -1, 0);
    expect(noPad).toEqual(r);
  });
});
