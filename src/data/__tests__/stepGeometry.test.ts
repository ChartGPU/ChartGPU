import { describe, it, expect } from 'vitest';
import {
  expandStepPolyline,
  expandStepStacked,
  resolveStepMode,
  isInvalidStepValue,
  stepExpandedCount,
  maybeExpandStepPolyline,
} from '../stepGeometry';
import type { CartesianSeriesData } from '../../config/types';

function asPairs(poly: { x: ArrayLike<number>; y: ArrayLike<number> }): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.x.length; i++) {
    out.push([poly.x[i]!, poly.y[i]!]);
  }
  return out;
}

describe('resolveStepMode', () => {
  it('maps true → after, false/undefined → null, modes pass through', () => {
    expect(resolveStepMode(true)).toBe('after');
    expect(resolveStepMode(false)).toBeNull();
    expect(resolveStepMode(undefined)).toBeNull();
    expect(resolveStepMode(null)).toBeNull();
    expect(resolveStepMode('after')).toBe('after');
    expect(resolveStepMode('before')).toBe('before');
    expect(resolveStepMode('middle')).toBe('middle');
  });

  it('rejects invalid strings', () => {
    expect(resolveStepMode('diagonal')).toBeNull();
    expect(resolveStepMode('step')).toBeNull();
    expect(isInvalidStepValue('diagonal')).toBe(true);
    expect(isInvalidStepValue('after')).toBe(false);
    expect(isInvalidStepValue(true)).toBe(false);
  });
});

describe('stepExpandedCount', () => {
  it('matches closed-form counts', () => {
    expect(stepExpandedCount(0, 'after')).toBe(0);
    expect(stepExpandedCount(1, 'after')).toBe(1);
    expect(stepExpandedCount(2, 'after')).toBe(3);
    expect(stepExpandedCount(3, 'after')).toBe(5);
    expect(stepExpandedCount(2, 'before')).toBe(3);
    expect(stepExpandedCount(2, 'middle')).toBe(4);
    expect(stepExpandedCount(3, 'middle')).toBe(7);
  });
});

describe('expandStepPolyline', () => {
  const two: CartesianSeriesData = {
    x: [0, 1],
    y: [1, 2],
  };

  it('mode after: P0 → (x1,y0) → P1', () => {
    const poly = expandStepPolyline(two, 'after');
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [1, 1],
      [1, 2],
    ]);
  });

  it('mode before: P0 → (x0,y1) → P1', () => {
    const poly = expandStepPolyline(two, 'before');
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
  });

  it('mode middle: midpoint x = 0.5', () => {
    const poly = expandStepPolyline(two, 'middle');
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [0.5, 1],
      [0.5, 2],
      [1, 2],
    ]);
  });

  it('three samples after: 2n-1 corners', () => {
    const data: CartesianSeriesData = {
      x: [0, 2, 4],
      y: [1, 3, 0],
    };
    const poly = expandStepPolyline(data, 'after');
    expect(poly.x.length).toBe(5);
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [2, 1],
      [2, 3],
      [4, 3],
      [4, 0],
    ]);
  });

  it('null gap breaks path (no stair across gap)', () => {
    const data = [[0, 1], null, [2, 3]] as unknown as CartesianSeriesData;
    const poly = expandStepPolyline(data, 'after');
    // Two isolated points — no connecting corner
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('connectNulls still breaks on remaining non-finite in this helper', () => {
    // Caller normally filterGaps first; if nulls remain and connectNulls, we skip them
    // without ending the run — so adjacent finite points still connect.
    const data = [[0, 1], null, [2, 3]] as unknown as CartesianSeriesData;
    const poly = expandStepPolyline(data, 'after', { connectNulls: true });
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [2, 1],
      [2, 3],
    ]);
  });

  it('single point → one vertex', () => {
    const data: CartesianSeriesData = { x: [5], y: [9] };
    const poly = expandStepPolyline(data, 'after');
    expect(asPairs(poly)).toEqual([[5, 9]]);
  });

  it('empty data', () => {
    const poly = expandStepPolyline([], 'after');
    expect(poly.x.length).toBe(0);
  });

  it('tuple DataPoint[] input', () => {
    const data: CartesianSeriesData = [
      [0, 1],
      [2, 3],
    ];
    const poly = expandStepPolyline(data, 'after');
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [2, 1],
      [2, 3],
    ]);
  });

  it('does not mutate input arrays', () => {
    const x = [0, 1];
    const y = [1, 2];
    const data: CartesianSeriesData = { x, y };
    expandStepPolyline(data, 'after');
    expect(x).toEqual([0, 1]);
    expect(y).toEqual([1, 2]);
  });

  it('maybeExpandStepPolyline returns null when step off', () => {
    expect(maybeExpandStepPolyline(two, false)).toBeNull();
    expect(maybeExpandStepPolyline(two, undefined)).toBeNull();
    const poly = maybeExpandStepPolyline(two, true);
    expect(poly).not.toBeNull();
    expect(asPairs(poly!)).toEqual([
      [0, 1],
      [1, 1],
      [1, 2],
    ]);
  });
});

describe('expandStepStacked', () => {
  it('steps both yBottom and yTop with shared x (after)', () => {
    const data: CartesianSeriesData = { x: [0, 2], y: [1, 1] };
    const yBottom = [0, 1];
    const yTop = [2, 4];
    const poly = expandStepStacked(data, yBottom, yTop, 'after');
    expect(Array.from(poly.x)).toEqual([0, 2, 2]);
    expect(Array.from(poly.yBottom)).toEqual([0, 0, 1]);
    expect(Array.from(poly.yTop)).toEqual([2, 2, 4]);
  });

  it('mode before stacked', () => {
    const data: CartesianSeriesData = { x: [0, 2], y: [0, 0] };
    const poly = expandStepStacked(data, [0, 1], [2, 4], 'before');
    expect(Array.from(poly.x)).toEqual([0, 0, 2]);
    expect(Array.from(poly.yBottom)).toEqual([0, 1, 1]);
    expect(Array.from(poly.yTop)).toEqual([2, 4, 4]);
  });

  it('mode middle stacked', () => {
    const data: CartesianSeriesData = { x: [0, 2], y: [0, 0] };
    const poly = expandStepStacked(data, [0, 1], [2, 4], 'middle');
    expect(Array.from(poly.x)).toEqual([0, 1, 1, 2]);
    expect(Array.from(poly.yBottom)).toEqual([0, 0, 1, 1]);
    expect(Array.from(poly.yTop)).toEqual([2, 2, 4, 4]);
  });

  it('gap breaks stacked run; connectNulls bridges with exact after corners', () => {
    // Parallel arrays: mid sample non-finite → gap
    const data: CartesianSeriesData = { x: [0, 1, 2], y: [0, 0, 0] };
    const yBottom = [0, Number.NaN, 1];
    const yTop = [1, Number.NaN, 3];

    // Without connectNulls: two isolated corners (no stair between 0 and 2)
    const broken = expandStepStacked(data, yBottom, yTop, 'after', { connectNulls: false });
    expect(Array.from(broken.x)).toEqual([0, 2]);
    expect(Array.from(broken.yBottom)).toEqual([0, 1]);
    expect(Array.from(broken.yTop)).toEqual([1, 3]);

    // With connectNulls: skip mid NaN without ending run → after stair from (0,0,1) to (2,1,3)
    // Polyline: P0 → (x1, yBottom0, yTop0) → P1  i.e. (0,0,1), (2,0,1), (2,1,3)
    const bridged = expandStepStacked(data, yBottom, yTop, 'after', { connectNulls: true });
    expect(Array.from(bridged.x)).toEqual([0, 2, 2]);
    expect(Array.from(bridged.yBottom)).toEqual([0, 0, 1]);
    expect(Array.from(bridged.yTop)).toEqual([1, 1, 3]);
  });
});

describe('expandStepPolyline edge cases', () => {
  it('leading null then finite pair', () => {
    const data = [null, [0, 1], [1, 2]] as unknown as CartesianSeriesData;
    const poly = expandStepPolyline(data, 'after');
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [1, 1],
      [1, 2],
    ]);
  });

  it('trailing null after finite pair', () => {
    const data = [[0, 1], [1, 2], null] as unknown as CartesianSeriesData;
    const poly = expandStepPolyline(data, 'after');
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [1, 1],
      [1, 2],
    ]);
  });

  it('object-array DataPoint input', () => {
    const data: CartesianSeriesData = [
      { x: 0, y: 1 },
      { x: 2, y: 3 },
    ];
    const poly = expandStepPolyline(data, 'after');
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [2, 1],
      [2, 3],
    ]);
  });

  it('NaN y breaks path', () => {
    const data: CartesianSeriesData = {
      x: [0, 1, 2],
      y: [1, Number.NaN, 3],
    };
    const poly = expandStepPolyline(data, 'after');
    expect(asPairs(poly)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});
