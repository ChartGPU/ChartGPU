import { describe, it, expect } from 'vitest';
import {
  heatmapGridBounds,
  heatmapGridPlacement,
  heatmapCellIndex,
  heatmapHitTest,
  computeHeatmapZExtent,
  normalizeZ,
  applyNullHandling,
  sanitizeHeatmapGeometry,
  heatmapZContentStamp,
} from '../heatmapLayout';
import type { HeatmapData } from '../../config/types';

const makeData = (overrides: Partial<HeatmapData> = {}): HeatmapData => {
  const columns = overrides.columns ?? 4;
  const rows = overrides.rows ?? 3;
  const expected = columns * rows;
  const z = overrides.z ?? Float32Array.from({ length: expected }, (_, k) => k);
  return {
    xStart: overrides.xStart ?? 0,
    xStep: overrides.xStep ?? 1,
    yStart: overrides.yStart ?? 0,
    yStep: overrides.yStep ?? 2,
    columns,
    rows,
    z,
  };
};

describe('heatmapGridBounds', () => {
  it('corner anchor: [xStart, xStart+cols*step] × [yStart, yStart+rows*step]', () => {
    const b = heatmapGridBounds(makeData(), 'corner');
    expect(b).toEqual({ xMin: 0, xMax: 4, yMin: 0, yMax: 6 });
  });

  it('center anchor shifts by half step', () => {
    const b = heatmapGridBounds(makeData({ xStart: 0.5, yStart: 1, xStep: 1, yStep: 2 }), 'center');
    expect(b).toEqual({ xMin: 0, xMax: 4, yMin: 0, yMax: 6 });
  });

  it('negative xStep reverses min/max', () => {
    const b = heatmapGridBounds(makeData({ xStart: 10, xStep: -1, columns: 4, rows: 1 }), 'corner');
    expect(b.xMin).toBe(6);
    expect(b.xMax).toBe(10);
  });
});

describe('heatmapGridPlacement', () => {
  it('uses signed extent (not sorted AABB)', () => {
    const p = heatmapGridPlacement({ xStart: 10, xStep: -1, yStart: 0, yStep: 2, columns: 4, rows: 2 }, 'corner');
    expect(p.x0).toBe(10);
    expect(p.xExtent).toBe(-4);
    expect(p.y0).toBe(0);
    expect(p.yExtent).toBe(4);
  });
});

describe('heatmapCellIndex / hit-test (shared GPU UV convention)', () => {
  it('returns correct indices at known cell centers (corner)', () => {
    const data = makeData();
    const hit = heatmapHitTest(data, 2.5, 3, 'corner');
    expect(hit).not.toBeNull();
    expect(hit!.i).toBe(2);
    expect(hit!.j).toBe(1);
    expect(hit!.dataIndex).toBe(1 * 4 + 2);
    expect(hit!.z).toBe(6);
  });

  it('returns null for out-of-bounds', () => {
    const data = makeData();
    expect(heatmapHitTest(data, -0.1, 1, 'corner')).toBeNull();
    expect(heatmapHitTest(data, 4, 1, 'corner')).toBeNull();
    expect(heatmapHitTest(data, 1, 6, 'corner')).toBeNull();
    expect(heatmapHitTest(data, Number.NaN, 1, 'corner')).toBeNull();
  });

  it('center anchor maps from cell centers at xStart/yStart', () => {
    const data = makeData({ xStart: 0, yStart: 0, xStep: 2, yStep: 2, columns: 2, rows: 2 });
    const hit = heatmapHitTest(data, 0, 0, 'center');
    expect(hit).not.toBeNull();
    expect(hit!.i).toBe(0);
    expect(hit!.j).toBe(0);
  });

  it('negative xStep: cell i=0 is near xStart, GPU UV u=0 maps same', () => {
    // columns=4, xStart=10, xStep=-1 → cells cover [10,6)
    // cell 0: [10,9), center 9.5; cell 3: [7,6), center 6.5
    const data = makeData({
      xStart: 10,
      xStep: -1,
      yStart: 0,
      yStep: 1,
      columns: 4,
      rows: 1,
      z: new Float32Array([0, 1, 2, 3]),
    });
    const c0 = heatmapCellIndex(data, 9.5, 0.5, 'corner');
    expect(c0).toEqual({ i: 0, j: 0 });
    const c3 = heatmapCellIndex(data, 6.5, 0.5, 'corner');
    expect(c3).toEqual({ i: 3, j: 0 });
    const hit0 = heatmapHitTest(data, 9.5, 0.5, 'corner');
    expect(hit0).not.toBeNull();
    expect(hit0!.z).toBe(0);
    const hit3 = heatmapHitTest(data, 6.5, 0.5, 'corner');
    expect(hit3).not.toBeNull();
    expect(hit3!.z).toBe(3);
  });

  it('negative yStep: cell j=0 is near yStart', () => {
    const data = makeData({
      xStart: 0,
      xStep: 1,
      yStart: 100,
      yStep: -10,
      columns: 1,
      rows: 3,
      z: new Float32Array([10, 20, 30]),
    });
    const hit0 = heatmapHitTest(data, 0.5, 95, 'corner');
    expect(hit0).not.toBeNull();
    expect(hit0!.z).toBe(10);
    const hit2 = heatmapHitTest(data, 0.5, 75, 'corner');
    expect(hit2).not.toBeNull();
    expect(hit2!.z).toBe(30);
  });

  it('zero step returns null from hit-test', () => {
    expect(heatmapHitTest(makeData({ xStep: 0 }), 0.5, 0.5, 'corner')).toBeNull();
    expect(heatmapHitTest(makeData({ yStep: 0 }), 0.5, 0.5, 'corner')).toBeNull();
    expect(heatmapCellIndex(makeData({ xStep: 0 }), 0.5, 0.5, 'corner')).toBeNull();
  });

  it('reads z at edge of finite array when length mismatches (clamp draw)', () => {
    const data = makeData({
      columns: 2,
      rows: 2,
      xStep: 1,
      yStep: 1,
      z: new Float32Array([10, 20]),
    });
    const hit = heatmapHitTest(data, 0.5, 0.5, 'corner');
    expect(hit).not.toBeNull();
    expect(hit!.z).toBe(10);
    const hitMissing = heatmapHitTest(data, 0.5, 1.5, 'corner');
    expect(hitMissing).not.toBeNull();
    expect(Number.isNaN(hitMissing!.z)).toBe(true);
  });
});

describe('computeHeatmapZExtent', () => {
  it('finds min/max of finite values', () => {
    const z = new Float32Array([1, 5, Number.NaN, -2, 3]);
    expect(computeHeatmapZExtent(z, z.length, 'linear')).toEqual({ zMin: -2, zMax: 5 });
  });

  it('expands equal min/max by epsilon', () => {
    const z = new Float32Array([3, 3, 3]);
    const e = computeHeatmapZExtent(z, 3, 'linear');
    expect(e.zMin).toBeLessThan(3);
    expect(e.zMax).toBeGreaterThan(3);
  });

  it('log scale ignores non-positive', () => {
    const z = new Float32Array([-1, 0, 2, 8]);
    expect(computeHeatmapZExtent(z, 4, 'log')).toEqual({ zMin: 2, zMax: 8 });
  });

  it('all nonfinite → default 0..1', () => {
    expect(computeHeatmapZExtent(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]), 2)).toEqual({
      zMin: 0,
      zMax: 1,
    });
  });
});

describe('normalizeZ', () => {
  it('linear maps endpoints to 0 and 1', () => {
    expect(normalizeZ(0, 0, 10, 'linear')).toBe(0);
    expect(normalizeZ(10, 0, 10, 'linear')).toBe(1);
    expect(normalizeZ(5, 0, 10, 'linear')).toBeCloseTo(0.5, 6);
  });

  it('clamps outside range', () => {
    expect(normalizeZ(-5, 0, 10, 'linear')).toBe(0);
    expect(normalizeZ(15, 0, 10, 'linear')).toBe(1);
  });

  it('NaN input → NaN', () => {
    expect(Number.isNaN(normalizeZ(Number.NaN, 0, 1, 'linear'))).toBe(true);
  });

  it('log scale', () => {
    expect(normalizeZ(1, 1, 100, 'log')).toBeCloseTo(0, 6);
    expect(normalizeZ(100, 1, 100, 'log')).toBeCloseTo(1, 6);
    expect(Number.isNaN(normalizeZ(0, 1, 100, 'log'))).toBe(true);
  });
});

describe('applyNullHandling', () => {
  it('finite passes through clamped', () => {
    expect(applyNullHandling(0.5, 'transparent')).toBe(0.5);
  });
  it('transparent → null', () => {
    expect(applyNullHandling(Number.NaN, 'transparent')).toBeNull();
  });
  it('lowest / highest', () => {
    expect(applyNullHandling(Number.NaN, 'lowest')).toBe(0);
    expect(applyNullHandling(Number.NaN, 'highest')).toBe(1);
  });
});

describe('sanitizeHeatmapGeometry', () => {
  it('accepts valid geometry', () => {
    const g = sanitizeHeatmapGeometry(makeData());
    expect(g).not.toBeNull();
    expect(g!.columns).toBe(4);
    expect(g!.drawCells).toBe(12);
  });

  it('rejects zero step', () => {
    expect(sanitizeHeatmapGeometry(makeData({ xStep: 0 }))).toBeNull();
  });

  it('rejects NaN yStep and NaN starts', () => {
    expect(sanitizeHeatmapGeometry(makeData({ yStep: Number.NaN }))).toBeNull();
    expect(sanitizeHeatmapGeometry(makeData({ xStart: Number.NaN }))).toBeNull();
  });

  it('rejects non-positive dimensions', () => {
    expect(sanitizeHeatmapGeometry(makeData({ columns: 0 }))).toBeNull();
    expect(sanitizeHeatmapGeometry(makeData({ rows: -1 }))).toBeNull();
  });

  it('clamps drawCells when z is short', () => {
    const g = sanitizeHeatmapGeometry(makeData({ columns: 10, rows: 10, z: new Float32Array(5) }));
    expect(g!.drawCells).toBe(5);
    expect(g!.zLength).toBe(5);
  });

  it('accepts empty z (drawCells 0)', () => {
    const g = sanitizeHeatmapGeometry(makeData({ columns: 2, rows: 2, z: new Float32Array(0) }));
    expect(g).not.toBeNull();
    expect(g!.drawCells).toBe(0);
  });
});

describe('heatmapZContentStamp', () => {
  it('changes when content changes', () => {
    const a = new Float32Array([1, 2, 3, 4]);
    const b = new Float32Array([1, 2, 3, 5]);
    expect(heatmapZContentStamp(a, 4)).not.toBe(heatmapZContentStamp(b, 4));
  });

  it('stable for same content', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(heatmapZContentStamp(a, 3)).toBe(heatmapZContentStamp(a, 3));
  });

  it('is order-sensitive (cell swap)', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([3, 2, 1]);
    expect(heatmapZContentStamp(a, 3)).not.toBe(heatmapZContentStamp(b, 3));
  });

  it('detects column ring-shift (spectrogram-style)', () => {
    // 3 cols × 2 rows; shift columns left by 1 with wrap
    const a = new Float32Array([
      1,
      2,
      3, // row 0
      4,
      5,
      6, // row 1
    ]);
    const b = new Float32Array([2, 3, 1, 5, 6, 4]);
    expect(heatmapZContentStamp(a, 6)).not.toBe(heatmapZContentStamp(b, 6));
  });

  it('detects sub-1/1024 float edits (bit pattern, not quantized)', () => {
    const a = new Float32Array([1.0]);
    const b = new Float32Array([1.0 + 1e-7]);
    expect(heatmapZContentStamp(a, 1)).not.toBe(heatmapZContentStamp(b, 1));
  });
});
