/**
 * Tests for cartesianData helpers - guards against undefined/null entries.
 */

import { describe, it, expect } from 'vitest';
import {
  getX,
  getY,
  getSize,
  getPointCount,
  hasAnyPerPointSize,
  computeRawBoundsFromCartesianData,
  dropPrefixXY,
  packXYInto,
  createRingXYColumns,
  appendIntoRingXY,
  createStagingRingView,
  isStagingRingView,
  stagingRingViewToRingXYColumns,
  hasNullGaps,
} from '../cartesianData';
import type { DataPoint } from '../../config/types';

describe('hasAnyPerPointSize', () => {
  it('detects tuple [x,y,size] including sparse later size', () => {
    const data: DataPoint[] = [
      [0, 1],
      [1, 2],
      [2, 3, 8],
    ];
    expect(hasAnyPerPointSize(data)).toBe(true);
  });

  it('detects object size only on a later point', () => {
    const data: DataPoint[] = [
      { x: 0, y: 1 },
      { x: 1, y: 2, size: 4 },
    ];
    expect(hasAnyPerPointSize(data)).toBe(true);
  });

  it('is false for dense [x,y] tuples', () => {
    expect(
      hasAnyPerPointSize([
        [0, 1],
        [1, 2],
      ])
    ).toBe(false);
  });

  it('detects XYArraysData.size channel', () => {
    expect(
      hasAnyPerPointSize({
        x: [0, 1],
        y: [1, 2],
        size: [undefined, 3],
      })
    ).toBe(true);
  });

  it('is false for interleaved Float32Array', () => {
    expect(hasAnyPerPointSize(new Float32Array([0, 1, 1, 2]))).toBe(false);
  });
});

describe('cartesianData - sparse array handling', () => {
  describe('getX', () => {
    it('returns NaN for undefined DataPoint entries', () => {
      const sparseData: DataPoint[] = [{ x: 1, y: 2 }, undefined as any, { x: 3, y: 4 }];

      expect(getX(sparseData, 0)).toBe(1);
      expect(Number.isNaN(getX(sparseData, 1))).toBe(true);
      expect(getX(sparseData, 2)).toBe(3);
    });

    it('returns NaN for null DataPoint entries', () => {
      const invalidData: any = [{ x: 1, y: 2 }, null, { x: 3, y: 4 }];

      expect(getX(invalidData, 0)).toBe(1);
      expect(Number.isNaN(getX(invalidData, 1))).toBe(true);
      expect(getX(invalidData, 2)).toBe(3);
    });

    it('handles tuple format with undefined entries', () => {
      const sparseData: DataPoint[] = [[1, 2], undefined as any, [3, 4]];

      expect(getX(sparseData, 0)).toBe(1);
      expect(Number.isNaN(getX(sparseData, 1))).toBe(true);
      expect(getX(sparseData, 2)).toBe(3);
    });
  });

  describe('getY', () => {
    it('returns NaN for undefined DataPoint entries', () => {
      const sparseData: DataPoint[] = [{ x: 1, y: 2 }, undefined as any, { x: 3, y: 4 }];

      expect(getY(sparseData, 0)).toBe(2);
      expect(Number.isNaN(getY(sparseData, 1))).toBe(true);
      expect(getY(sparseData, 2)).toBe(4);
    });

    it('returns NaN for null DataPoint entries', () => {
      const invalidData: any = [{ x: 1, y: 2 }, null, { x: 3, y: 4 }];

      expect(getY(invalidData, 0)).toBe(2);
      expect(Number.isNaN(getY(invalidData, 1))).toBe(true);
      expect(getY(invalidData, 2)).toBe(4);
    });

    it('handles tuple format with undefined entries', () => {
      const sparseData: DataPoint[] = [[1, 2], undefined as any, [3, 4]];

      expect(getY(sparseData, 0)).toBe(2);
      expect(Number.isNaN(getY(sparseData, 1))).toBe(true);
      expect(getY(sparseData, 2)).toBe(4);
    });
  });

  describe('getSize', () => {
    it('returns undefined for undefined DataPoint entries', () => {
      const sparseData: DataPoint[] = [{ x: 1, y: 2, size: 10 }, undefined as any, { x: 3, y: 4, size: 20 }];

      expect(getSize(sparseData, 0)).toBe(10);
      expect(getSize(sparseData, 1)).toBeUndefined();
      expect(getSize(sparseData, 2)).toBe(20);
    });

    it('returns undefined for null DataPoint entries', () => {
      const invalidData: any = [{ x: 1, y: 2, size: 10 }, null, { x: 3, y: 4, size: 20 }];

      expect(getSize(invalidData, 0)).toBe(10);
      expect(getSize(invalidData, 1)).toBeUndefined();
      expect(getSize(invalidData, 2)).toBe(20);
    });

    it('handles tuple format with undefined entries', () => {
      const sparseData: DataPoint[] = [[1, 2, 10], undefined as any, [3, 4, 20]];

      expect(getSize(sparseData, 0)).toBe(10);
      expect(getSize(sparseData, 1)).toBeUndefined();
      expect(getSize(sparseData, 2)).toBe(20);
    });
  });

  describe('computeRawBoundsFromCartesianData', () => {
    it('skips undefined and null DataPoint entries when computing bounds', () => {
      const sparseData: DataPoint[] = [{ x: 1, y: 2 }, undefined as any, { x: 3, y: 4 }, null as any, { x: 5, y: 6 }];

      const bounds = computeRawBoundsFromCartesianData(sparseData);

      expect(bounds).not.toBeNull();
      expect(bounds?.xMin).toBe(1);
      expect(bounds?.xMax).toBe(5);
      expect(bounds?.yMin).toBe(2);
      expect(bounds?.yMax).toBe(6);
    });
  });
});

describe('packXYInto - Float32 interleaved bulk set (issue 2.4)', () => {
  it('bulk-sets Float32 interleaved when xOffset is 0', () => {
    const src = new Float32Array([0, 1, 2, 3, 4, 5]);
    const out = new Float32Array(6);
    packXYInto(out, 0, src, 0, 3, 0);
    expect(Array.from(out)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('still subtracts xOffset per-element when non-zero', () => {
    const src = new Float32Array([10, 1, 20, 2]);
    const out = new Float32Array(4);
    packXYInto(out, 0, src, 0, 2, 10);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(10);
    expect(out[3]).toBe(2);
  });
});

/**
 * XY-arrays pack path (Float64 columns) — ×4 unroll for xOffset===0 plus
 * remainder / offset / xOffset≠0. FIFO suite uses this layout.
 */
describe('packXYInto - XY arrays unroll (FIFO typed columns)', () => {
  function makeXY(n: number): { x: Float64Array; y: Float64Array } {
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = 100 + i;
      y[i] = i * 0.5;
    }
    return { x, y };
  }

  function expectedInterleaved(n: number, srcPointOffset: number, pointCount: number, xOffset: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < pointCount; i++) {
      const idx = srcPointOffset + i;
      out.push(100 + idx - xOffset, idx * 0.5);
    }
    return out;
  }

  it.each([1, 3, 4, 5, 7, 8])('packs count=%s with xOffset 0 (unroll + remainder)', (n) => {
    const src = makeXY(n);
    const out = new Float32Array(n * 2);
    packXYInto(out, 0, src, 0, n, 0);
    expect(Array.from(out)).toEqual(expectedInterleaved(n, 0, n, 0));
  });

  it('honors srcPointOffset > 0', () => {
    const src = makeXY(10);
    const out = new Float32Array(6);
    packXYInto(out, 0, src, 3, 3, 0);
    expect(Array.from(out)).toEqual(expectedInterleaved(10, 3, 3, 0));
  });

  it('subtracts non-zero xOffset (non-unroll path)', () => {
    const src = makeXY(5);
    const out = new Float32Array(10);
    packXYInto(out, 0, src, 0, 5, 100);
    expect(Array.from(out)).toEqual(expectedInterleaved(5, 0, 5, 100));
  });

  it('combines srcPointOffset + xOffset + remainder length', () => {
    const src = makeXY(12);
    const out = new Float32Array(10);
    // 5 points from offset 2 with xOffset 50 — exercises non-zero offset + remainder.
    packXYInto(out, 0, src, 2, 5, 50);
    expect(Array.from(out)).toEqual(expectedInterleaved(12, 2, 5, 50));
  });

  it('writes at outFloatOffset (not only at 0)', () => {
    const src = makeXY(4);
    const out = new Float32Array(12);
    out.fill(-1);
    packXYInto(out, 4, src, 0, 4, 0);
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(-1);
    expect(out[2]).toBe(-1);
    expect(out[3]).toBe(-1);
    expect(Array.from(out.subarray(4))).toEqual(expectedInterleaved(4, 0, 4, 0));
  });
});

describe('packXYInto - null gap handling', () => {
  it('writes NaN for null entries in DataPoint array', () => {
    const data: (DataPoint | null)[] = [[0, 1], null, [2, 3]];
    const out = new Float32Array(6);
    packXYInto(out, 0, data as any, 0, 3, 0);

    expect(out[0]).toBe(0); // x0
    expect(out[1]).toBe(1); // y0
    expect(Number.isNaN(out[2])).toBe(true); // x1 (null -> NaN)
    expect(Number.isNaN(out[3])).toBe(true); // y1 (null -> NaN)
    expect(out[4]).toBe(2); // x2
    expect(out[5]).toBe(3); // y2
  });

  it('handles consecutive null entries', () => {
    const data: (DataPoint | null)[] = [[0, 1], null, null, [3, 4]];
    const out = new Float32Array(8);
    packXYInto(out, 0, data as any, 0, 4, 0);

    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(Number.isNaN(out[2])).toBe(true);
    expect(Number.isNaN(out[3])).toBe(true);
    expect(Number.isNaN(out[4])).toBe(true);
    expect(Number.isNaN(out[5])).toBe(true);
    expect(out[6]).toBe(3);
    expect(out[7]).toBe(4);
  });

  it('writes NaN for undefined entries in DataPoint array', () => {
    const data: DataPoint[] = [[0, 1], undefined as any, [2, 3]];
    const out = new Float32Array(6);
    packXYInto(out, 0, data as any, 0, 3, 0);

    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(Number.isNaN(out[2])).toBe(true);
    expect(Number.isNaN(out[3])).toBe(true);
    expect(out[4]).toBe(2);
    expect(out[5]).toBe(3);
  });

  it('applies xOffset correctly alongside null entries', () => {
    const data: (DataPoint | null)[] = [[10, 1], null, [20, 3]];
    const out = new Float32Array(6);
    packXYInto(out, 0, data as any, 0, 3, 10);

    expect(out[0]).toBe(0); // 10 - 10
    expect(out[1]).toBe(1);
    expect(Number.isNaN(out[2])).toBe(true); // null -> NaN (xOffset not applied)
    expect(Number.isNaN(out[3])).toBe(true);
    expect(out[4]).toBe(10); // 20 - 10
    expect(out[5]).toBe(3);
  });

  it('dense tuple path packs [x,y] without xOffset', () => {
    const data: DataPoint[] = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    const out = new Float32Array(6);
    packXYInto(out, 0, data, 0, 3, 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('dense homogeneous group-3 path packs large pure [x,y] tuples (hit)', () => {
    // Full-scan dense eligibility; large N matches suite-scale pure tuples.
    const n = 64;
    const data: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i * 2] as DataPoint);
    const out = new Float32Array(n * 2);
    packXYInto(out, 0, data, 0, n, 0);
    for (let i = 0; i < n; i++) {
      expect(out[i * 2]).toBe(i);
      expect(out[i * 2 + 1]).toBe(i * 2);
    }
  });

  it('mid-series null forces safe tuple path (denseHomogeneous false-positive miss)', () => {
    const data: (DataPoint | null)[] = [[0, 0], [1, 1], null, [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8]];
    const out = new Float32Array(data.length * 2);
    packXYInto(out, 0, data as any, 0, data.length, 0);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(Number.isNaN(out[4])).toBe(true);
    expect(Number.isNaN(out[5])).toBe(true);
    expect(out[6]).toBe(3);
    expect(out[7]).toBe(3);
  });

  it('large-N mid-null off lattice forces safe path (Issue 2 review)', () => {
    // Previously a sparse ⅛-step probe could miss index 17 and take the dense
    // unchecked path (throw / corrupt). Full-scan eligibility must catch this.
    const n = 128;
    const data: (DataPoint | null)[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
    const nullAt = 17; // off any /8 lattice that would start at 0
    data[nullAt] = null;
    const out = new Float32Array(n * 2);
    packXYInto(out, 0, data as any, 0, n, 0);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(1);
    expect(Number.isNaN(out[nullAt * 2])).toBe(true);
    expect(Number.isNaN(out[nullAt * 2 + 1])).toBe(true);
    expect(out[(nullAt + 1) * 2]).toBe(nullAt + 1);
    expect(out[(n - 1) * 2]).toBe(n - 1);
  });

  it('leading null then tuples still packs later tuples (Issue 1)', () => {
    const data: (DataPoint | null)[] = [null, [1, 2], [3, 4]];
    const out = new Float32Array(6);
    packXYInto(out, 0, data as any, 0, 3, 0);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBe(1);
    expect(out[3]).toBe(2);
    expect(out[4]).toBe(3);
    expect(out[5]).toBe(4);
  });

  it('leading undefined then tuples packs correctly', () => {
    const data: DataPoint[] = [undefined as any, [10, 20], [30, 40]];
    const out = new Float32Array(6);
    packXYInto(out, 0, data as any, 0, 3, 0);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[2]).toBe(10);
    expect(out[3]).toBe(20);
    expect(out[4]).toBe(30);
    expect(out[5]).toBe(40);
  });

  it('srcPointOffset mid-null starts packing from offset', () => {
    const data: (DataPoint | null)[] = [[0, 0], null, [2, 3], [4, 5]];
    const out = new Float32Array(6);
    // Start at index 1 (null) → probe scans to [2,3]
    packXYInto(out, 0, data as any, 1, 3, 0);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBe(2);
    expect(out[3]).toBe(3);
    expect(out[4]).toBe(4);
    expect(out[5]).toBe(5);
  });

  it('object DataPoint path still packs x/y fields', () => {
    const data: DataPoint[] = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const out = new Float32Array(4);
    packXYInto(out, 0, data, 0, 2, 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('mixed tuple then object packs both shapes', () => {
    const data: DataPoint[] = [[1, 2], { x: 3, y: 4 } as DataPoint];
    const out = new Float32Array(4);
    packXYInto(out, 0, data, 0, 2, 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('mixed object then tuple packs both via object path', () => {
    const data: DataPoint[] = [{ x: 1, y: 2 }, [3, 4] as DataPoint];
    const out = new Float32Array(4);
    packXYInto(out, 0, data, 0, 2, 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });
});

describe('dropPrefixXY', () => {
  it('shifts x/y left and shortens length', () => {
    const x = [0, 1, 2, 3, 4];
    const y = [10, 11, 12, 13, 14];
    dropPrefixXY(x, y, 2);
    expect(x).toEqual([2, 3, 4]);
    expect(y).toEqual([12, 13, 14]);
  });

  it('clears when dropCount >= length', () => {
    const x = [0, 1];
    const y = [10, 11];
    dropPrefixXY(x, y, 5);
    expect(x).toEqual([]);
    expect(y).toEqual([]);
  });

  it('keeps size aligned when present', () => {
    const x = [0, 1, 2];
    const y = [10, 11, 12];
    const size: (number | undefined)[] = [1, 2, 3];
    dropPrefixXY(x, y, 1, size);
    expect(x).toEqual([1, 2]);
    expect(y).toEqual([11, 12]);
    expect(size).toEqual([2, 3]);
  });
});

describe('RingXYColumns (FIFO modular CPU columns)', () => {
  it('fill then wrap keeps chronological getX/getY and count at capacity', () => {
    const ring = createRingXYColumns(4);
    appendIntoRingXY(
      ring,
      {
        x: [0, 1, 2, 3],
        y: [10, 11, 12, 13],
      },
      0,
      4,
      0
    );
    expect(getPointCount(ring as any)).toBe(4);
    expect(getX(ring as any, 0)).toBe(0);
    expect(getY(ring as any, 3)).toBe(13);

    // Steady wrap: drop 1, append 1 → [1,2,3,100]
    appendIntoRingXY(ring, { x: [100], y: [50] }, 0, 1, 1);
    expect(getPointCount(ring as any)).toBe(4);
    expect(getX(ring as any, 0)).toBe(1);
    expect(getX(ring as any, 3)).toBe(100);
    expect(getY(ring as any, 3)).toBe(50);
  });

  it('strict replace via drop-all then keep tail', () => {
    const ring = createRingXYColumns(3);
    appendIntoRingXY(ring, { x: [0, 1], y: [0, 1] }, 0, 2, 0);
    // newCount > capacity: drop all prev, keep last 3 of new batch
    appendIntoRingXY(
      ring,
      { x: [10, 11, 12, 13], y: [20, 21, 22, 23] },
      1, // newSrcOffset
      3,
      2 // drop all previous
    );
    expect(getPointCount(ring as any)).toBe(3);
    expect(getX(ring as any, 0)).toBe(11);
    expect(getX(ring as any, 2)).toBe(13);
  });

  it('multi-wrap advances start and keeps capacity', () => {
    const ring = createRingXYColumns(4);
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [0, 1, 2, 3] }, 0, 4, 0);
    for (let i = 0; i < 5; i++) {
      appendIntoRingXY(ring, { x: [100 + i], y: [200 + i] }, 0, 1, 1);
    }
    expect(ring.count).toBe(4);
    expect(ring.capacity).toBe(4);
    // After 5 unit wraps from [0,1,2,3]: last retained = [101,102,103,104]
    // (dropped 0,1,2,3,100).
    expect(getX(ring as any, 0)).toBe(101);
    expect(getX(ring as any, 3)).toBe(104);
  });

  it('packXYInto on chronological linear XY layout', () => {
    const out = new Float32Array(8);
    packXYInto(
      out,
      0,
      {
        x: [1, 2, 3, 4],
        y: [10, 20, 30, 40],
      },
      0,
      4,
      0
    );
    expect(Array.from(out)).toEqual([1, 10, 2, 20, 3, 30, 4, 40]);
  });

  it('packXYInto from modular RingXYColumns (start ≠ 0) is chronological', () => {
    const ring = createRingXYColumns(4);
    appendIntoRingXY(ring, { x: [0, 1, 2, 3], y: [10, 11, 12, 13] }, 0, 4, 0);
    // Two wraps → start advances; logical [2,3,100,101]
    appendIntoRingXY(ring, { x: [100], y: [110] }, 0, 1, 1);
    appendIntoRingXY(ring, { x: [101], y: [111] }, 0, 1, 1);
    expect(ring.start).not.toBe(0);
    expect(getX(ring as any, 0)).toBe(2);
    expect(getX(ring as any, 3)).toBe(101);

    const out = new Float32Array(8);
    packXYInto(out, 0, ring as any, 0, 4, 0);
    expect(Array.from(out)).toEqual([2, 12, 3, 13, 100, 110, 101, 111]);
  });

  it('bounds skip OOB and empty ring', () => {
    const empty = createRingXYColumns(4);
    expect(getPointCount(empty as any)).toBe(0);
    expect(Number.isNaN(getX(empty as any, 0))).toBe(true);
    const ring = createRingXYColumns(3);
    appendIntoRingXY(ring, { x: [1, 2, 3], y: [4, 5, 6] }, 0, 3, 0);
    expect(Number.isNaN(getX(ring as any, 99))).toBe(true);
    expect(Number.isNaN(getY(ring as any, -1))).toBe(true);
    const b = computeRawBoundsFromCartesianData(ring as any);
    expect(b.xMin).toBe(1);
    expect(b.xMax).toBe(3);
    expect(b.yMin).toBe(4);
    expect(b.yMax).toBe(6);
  });
});

describe('StagingRingView (zero-copy DataStore staging alias)', () => {
  it('reads modular staging with xOffset restored', () => {
    // Physical: [p2, p3, p0, p1] with start=2, capacity=4, count=4
    // logical 0→phys2=(10,100), 1→phys3=(11,110), 2→phys0=(12,120), 3→phys1=(13,130)
    const staging = new Float32Array([12, 120, 13, 130, 10, 100, 11, 110]);
    const view = createStagingRingView(staging, 2, 4, 4, 1000);
    expect(isStagingRingView(view)).toBe(true);
    expect(getPointCount(view as any)).toBe(4);
    expect(getX(view as any, 0)).toBe(1010); // 10 + 1000
    expect(getY(view as any, 0)).toBe(100);
    expect(getX(view as any, 3)).toBe(1013);
    expect(getY(view as any, 3)).toBe(130);
    expect(hasNullGaps(view as any)).toBe(false);
  });

  it('reuses object identity on createStagingRingView', () => {
    const staging = new Float32Array([1, 2, 3, 4]);
    const a = createStagingRingView(staging, 0, 0, 2, 0);
    const b = createStagingRingView(staging, 1, 2, 2, 5, a);
    expect(b).toBe(a);
    expect(a.start).toBe(1);
    expect(a.xOffset).toBe(5);
    expect(a.count).toBe(2);
  });

  it('linear layout (capacity 0) indexes staging directly', () => {
    const staging = new Float32Array([1, 10, 2, 20, 3, 30]);
    const view = createStagingRingView(staging, 0, 0, 3, 0);
    expect(getX(view as any, 1)).toBe(2);
    expect(getY(view as any, 1)).toBe(20);
    const out = new Float32Array(6);
    packXYInto(out, 0, view as any, 0, 3, 0);
    expect(Array.from(out)).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it('stagingRingViewToRingXYColumns preserves capacity and chronological domain x', () => {
    // Physical modular: start=2, capacity=4, count=4, xOffset=1000
    // logical 0→phys2=(10+1000), 1→phys3=(11+1000), 2→phys0=(12+1000), 3→phys1=(13+1000)
    const staging = new Float32Array([12, 120, 13, 130, 10, 100, 11, 110]);
    const view = createStagingRingView(staging, 2, 4, 4, 1000);
    const ring = stagingRingViewToRingXYColumns(view);
    expect(ring.capacity).toBe(4);
    expect(ring.count).toBe(4);
    expect(ring.start).toBe(0);
    expect(ring.x[0]).toBe(1010);
    expect(ring.y[0]).toBe(100);
    expect(ring.x[3]).toBe(1013);
    expect(ring.y[3]).toBe(130);
    // Capacity slots beyond count remain available for modular append.
    expect(ring.x.length).toBe(4);
  });

  it('stagingRingViewToRingXYColumns uses count as capacity when layout is linear', () => {
    const staging = new Float32Array([1, 10, 2, 20, 3, 30]);
    const view = createStagingRingView(staging, 0, 0, 3, 50);
    const ring = stagingRingViewToRingXYColumns(view);
    expect(ring.capacity).toBe(3);
    expect(ring.count).toBe(3);
    expect(ring.x[0]).toBe(51); // 1 + 50
    expect(ring.y[1]).toBe(20);
  });

  it('preserves per-point size through create + append + wrap (issue 1.4)', () => {
    const ring = createRingXYColumns(4, true);
    appendIntoRingXY(
      ring,
      { x: [0, 1, 2, 3], y: [10, 11, 12, 13], size: [1, 2, 3, 4] },
      0,
      4,
      0
    );
    expect(getSize(ring as any, 0)).toBe(1);
    expect(getSize(ring as any, 3)).toBe(4);
    appendIntoRingXY(ring, { x: [100], y: [50], size: [9] }, 0, 1, 1);
    expect(getPointCount(ring as any)).toBe(4);
    expect(getX(ring as any, 0)).toBe(1);
    expect(getSize(ring as any, 0)).toBe(2);
    expect(getSize(ring as any, 3)).toBe(9);
  });

  it('allocates size channel on first sized append after unsized create', () => {
    const ring = createRingXYColumns(3);
    appendIntoRingXY(ring, { x: [0, 1], y: [0, 1] }, 0, 2, 0);
    expect(ring.size).toBeUndefined();
    appendIntoRingXY(ring, { x: [2], y: [2], size: [5] }, 0, 1, 0);
    expect(ring.size).toBeDefined();
    expect(getSize(ring as any, 2)).toBe(5);
    expect(getSize(ring as any, 0)).toBeUndefined(); // unsized prior slots
  });

  it('linear→ring promote with size then wrap preserves chronological sizes (issue 1.4 / 10)', () => {
    // Mirrors ChartGPU / appendFlush promote: sized linear columns → ring seed → wrap.
    const linear = {
      x: [0, 1, 2, 3, 4],
      y: [10, 11, 12, 13, 14],
      size: [1, 2, 3, 4, 5] as (number | undefined)[],
    };
    const maxPoints = 4;
    const hasSize =
      linear.size != null && linear.size.some((v) => v !== undefined && Number.isFinite(v as number));
    const ring = createRingXYColumns(maxPoints, hasSize);
    const seedCount = Math.min(linear.x.length, maxPoints);
    const seedStart = Math.max(0, linear.x.length - seedCount);
    for (let i = 0; i < seedCount; i++) {
      ring.x[i] = linear.x[seedStart + i]!;
      ring.y[i] = linear.y[seedStart + i]!;
      if (ring.size && linear.size) {
        const sv = linear.size[seedStart + i];
        ring.size[i] = typeof sv === 'number' && Number.isFinite(sv) ? sv : Number.NaN;
      }
    }
    ring.count = seedCount;
    ring.start = 0;
    // Seeded tail of linear: [1,2,3,4] with sizes [2,3,4,5]
    expect(getSize(ring as any, 0)).toBe(2);
    expect(getSize(ring as any, 3)).toBe(5);
    // Wrap one: drop oldest (size 2), append size 9
    appendIntoRingXY(ring, { x: [100], y: [50], size: [9] }, 0, 1, 1);
    expect(getPointCount(ring as any)).toBe(4);
    expect(getX(ring as any, 0)).toBe(2);
    expect(getSize(ring as any, 0)).toBe(3);
    expect(getSize(ring as any, 1)).toBe(4);
    expect(getSize(ring as any, 2)).toBe(5);
    expect(getSize(ring as any, 3)).toBe(9);
  });

  it('demote ring with size → linear → re-promote preserves sizes', () => {
    const ring = createRingXYColumns(3, true);
    appendIntoRingXY(
      ring,
      { x: [0, 1, 2], y: [10, 11, 12], size: [1, 2, 3] },
      0,
      3,
      0
    );
    // Demote chronological (mirrors appendFlush capacity-mismatch demote).
    const linear: { x: number[]; y: number[]; size: (number | undefined)[] } = {
      x: [],
      y: [],
      size: [],
    };
    for (let i = 0; i < ring.count; i++) {
      linear.x.push(getX(ring as any, i));
      linear.y.push(getY(ring as any, i));
      linear.size.push(getSize(ring as any, i));
    }
    expect(linear.size).toEqual([1, 2, 3]);
    // Re-promote to larger capacity.
    const next = createRingXYColumns(5, true);
    for (let i = 0; i < linear.x.length; i++) {
      next.x[i] = linear.x[i]!;
      next.y[i] = linear.y[i]!;
      next.size![i] = linear.size[i] as number;
    }
    next.count = linear.x.length;
    next.start = 0;
    expect(getSize(next as any, 0)).toBe(1);
    expect(getSize(next as any, 2)).toBe(3);
  });
});
