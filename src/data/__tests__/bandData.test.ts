import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getBandLength,
  getBandPoint,
  bandBounds,
  packBandPoints,
  packBandStrokeXY,
  sampleBandSeries,
  filterBandGaps,
  hasBandNullGaps,
  sliceBandByX,
  appendBandIntoXYYColumns,
  extendBoundsWithBandData,
  scanBandVisibleYBounds,
  scanBandPositiveYBounds,
  isBandShapedPayload,
  resetBandLengthMismatchWarnings,
} from '../bandData';
import type { BandSeriesData } from '../../config/types';

beforeEach(() => {
  resetBandLengthMismatchWarnings();
});

describe('bandData length / accessors', () => {
  it('reads object arrays, tuples, XYY arrays, and interleaved', () => {
    const objects: BandSeriesData = [
      { x: 0, y: 1, y1: 2 },
      { x: 1, y: 2, y1: 3 },
    ];
    expect(getBandLength(objects)).toBe(2);
    expect(getBandPoint(objects, 1)).toEqual({ x: 1, y: 2, y1: 3 });

    const tuples: BandSeriesData = [
      [0, 1, 2],
      [1, 3, 4],
    ];
    expect(getBandLength(tuples)).toBe(2);
    expect(getBandPoint(tuples, 0)).toEqual({ x: 0, y: 1, y1: 2 });

    const xyy: BandSeriesData = {
      x: [0, 1, 2],
      y: [10, 11, 12],
      y1: [20, 21, 22],
    };
    expect(getBandLength(xyy)).toBe(3);
    expect(getBandPoint(xyy, 2)).toEqual({ x: 2, y: 12, y1: 22 });

    const interleaved = new Float32Array([0, 1, 2, 1, 3, 4, 2, 5, 6]);
    expect(getBandLength(interleaved)).toBe(3);
    expect(getBandPoint(interleaved, 1)).toEqual({ x: 1, y: 3, y1: 4 });
  });

  it('uses min length on x/y/y1 mismatch and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data: BandSeriesData = { x: [0, 1, 2], y: [0, 1], y1: [0, 1, 2, 3] };
    expect(getBandLength(data)).toBe(2);
    expect(getBandLength(data)).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('handles null array slots', () => {
    const data: BandSeriesData = [[0, 1, 2], null, [2, 3, 4]];
    expect(getBandLength(data)).toBe(3);
    expect(getBandPoint(data, 1)).toBeNull();
    expect(hasBandNullGaps(data)).toBe(true);
  });

  it('handles leading nulls without NaN silent loss in pack', () => {
    const data: BandSeriesData = [null, [1, 2, 3], [2, 4, 5]];
    const out = new Float32Array(12);
    packBandPoints(data, out);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[4]).toBe(1);
    expect(out[5]).toBe(2);
    expect(out[6]).toBe(3);
  });
});

describe('bandBounds', () => {
  it('includes both y and y1', () => {
    const data: BandSeriesData = {
      x: [0, 1, 2],
      y: [5, 4, 6],
      y1: [10, 12, 8],
    };
    const b = bandBounds(data)!;
    expect(b.xMin).toBe(0);
    expect(b.xMax).toBe(2);
    expect(b.yMin).toBe(4);
    expect(b.yMax).toBe(12);
  });

  it('matches hand calculation for crossing curves', () => {
    const data: BandSeriesData = [
      [0, 10, 0],
      [1, 0, 10],
    ];
    const b = bandBounds(data)!;
    expect(b.yMin).toBe(0);
    expect(b.yMax).toBe(10);
  });

  it('scanBandVisibleYBounds respects x window', () => {
    const data: BandSeriesData = {
      x: [0, 1, 2, 3],
      y: [0, 100, 0, 0],
      y1: [1, 200, 1, 1],
    };
    const scanned = scanBandVisibleYBounds(data, { min: 1.5, max: 3 });
    expect(scanned).toEqual({ yMin: 0, yMax: 1 });
  });
});

describe('packBandPoints', () => {
  it('round-trips interleaved stride-3 into stride-4 pack', () => {
    const interleaved = new Float32Array([0, 1, 2, 1, 3, 4]);
    const out = new Float32Array(8);
    const n = packBandPoints(interleaved, out);
    expect(n).toBe(2);
    expect(Array.from(out)).toEqual([0, 1, 2, 0, 1, 3, 4, 0]);
  });
});

describe('sampleBandSeries', () => {
  it('LTTB keeps y and y1 aligned via index remap (not independent LTTB)', () => {
    // Distinct channels so independent LTTB would mis-pair: y=i, y1=i*1000+7.
    const n = 100;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const y1 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i;
      y[i] = i;
      y1[i] = i * 1000 + 7;
    }
    const sampled = sampleBandSeries({ x, y, y1 }, 'lttb', 12);
    const sn = getBandLength(sampled);
    expect(sn).toBeLessThanOrEqual(12);
    expect(sn).toBeGreaterThan(0);
    for (let i = 0; i < sn; i++) {
      const p = getBandPoint(sampled, i)!;
      // Exact pairing: y1 must be y*1000+7 from the same source index.
      expect(p.y1).toBe(p.y * 1000 + 7);
    }
  });

  it('min/max are full-envelope aliases covering source extrema', () => {
    const data: BandSeriesData = {
      x: [0, 1, 2, 3, 4, 5, 6, 7],
      y: [0, 1, -5, 2, 3, 1, 0, 2],
      y1: [1, 2, 4, 5, 6, 3, 2, 4],
    };
    const sampledMin = sampleBandSeries(data, 'min', 2);
    const sampledMax = sampleBandSeries(data, 'max', 2);
    const bMin = bandBounds(sampledMin)!;
    const bMax = bandBounds(sampledMax)!;
    expect(bMin.yMin).toBe(-5);
    expect(bMin.yMax).toBe(6);
    expect(bMax.yMin).toBe(-5);
    expect(bMax.yMax).toBe(6);
  });

  it('average averages each channel only over finite values', () => {
    const data: BandSeriesData = {
      x: [0, 1, 2, 3],
      y: [2, 4, Number.NaN, 6],
      y1: [10, 20, 30, Number.NaN],
    };
    const sampled = sampleBandSeries(data, 'average', 1);
    expect(getBandLength(sampled)).toBe(1);
    const p = getBandPoint(sampled, 0)!;
    // y: (2+4+6)/3 = 4; y1: (10+20+30)/3 = 20 — NaN not treated as 0.
    expect(p.y).toBeCloseTo(4, 10);
    expect(p.y1).toBeCloseTo(20, 10);
  });

  it('none returns identity', () => {
    const data: BandSeriesData = [[0, 1, 2]];
    expect(sampleBandSeries(data, 'none', 1)).toBe(data);
  });
});

describe('sliceBandByX', () => {
  const data: BandSeriesData = {
    x: [0, 1, 2, 3, 4],
    y: [10, 11, 12, 13, 14],
    y1: [20, 21, 22, 23, 24],
  };

  it('includes endpoints of inclusive window', () => {
    const sliced = sliceBandByX(data, 1, 3);
    expect(sliced).toEqual([
      [1, 11, 21],
      [2, 12, 22],
      [3, 13, 23],
    ]);
  });

  it('handles swapped min/max', () => {
    const sliced = sliceBandByX(data, 3, 1);
    expect(sliced.map((p) => p[0])).toEqual([1, 2, 3]);
  });

  it('skips null samples and preserves y+y1', () => {
    const withNull: BandSeriesData = [[0, 1, 2], null, [2, 3, 4], [3, 5, 6]];
    const sliced = sliceBandByX(withNull, 0, 2);
    expect(sliced).toEqual([
      [0, 1, 2],
      [2, 3, 4],
    ]);
  });
});

describe('packBandStrokeXY / positive bounds / payload shape', () => {
  it('packs y and y1 stroke channels', () => {
    const data: BandSeriesData = {
      x: [0, 1],
      y: [2, 3],
      y1: [4, 5],
    };
    const out = new Float32Array(4);
    packBandStrokeXY(data, out, 0);
    expect(Array.from(out)).toEqual([0, 2, 1, 3]);
    packBandStrokeXY(data, out, 1);
    expect(Array.from(out)).toEqual([0, 4, 1, 5]);
  });

  it('scanBandPositiveYBounds uses both channels', () => {
    const data: BandSeriesData = {
      x: [0, 1],
      y: [-1, -2],
      y1: [3, 5],
    };
    const pos = scanBandPositiveYBounds(data)!;
    expect(pos.yMin).toBe(3);
    expect(pos.yMax).toBe(5);
  });

  it('isBandShapedPayload rejects plain XY tuples and accepts Xyy', () => {
    expect(isBandShapedPayload([[0, 1]])).toBe(false);
    expect(isBandShapedPayload([[0, 1, 2]])).toBe(true);
    expect(isBandShapedPayload({ x: [0], y: [1] })).toBe(false);
    expect(isBandShapedPayload({ x: [0], y: [1], y1: [2] })).toBe(true);
  });

  it('isBandShapedPayload requires interleaved length % 3 === 0', () => {
    expect(isBandShapedPayload(new Float32Array([0, 1, 2, 3, 4, 5]))).toBe(true);
    expect(isBandShapedPayload(new Float32Array([0, 1, 2, 3]))).toBe(false); // stride-2-ish
    expect(isBandShapedPayload(new Float32Array([]))).toBe(true);
  });
});

describe('bandData edge cases', () => {
  it('packBandPoints throws when out buffer is undersized', () => {
    const data: BandSeriesData = [
      [0, 1, 2],
      [1, 3, 4],
    ];
    expect(() => packBandPoints(data, new Float32Array(4))).toThrow(/out length/);
  });

  it('bandBounds returns null for empty data', () => {
    expect(bandBounds({ x: [], y: [], y1: [] })).toBeNull();
    expect(bandBounds([])).toBeNull();
  });

  it('getBandPoint out-of-range returns null', () => {
    const data: BandSeriesData = [[0, 1, 2]];
    expect(getBandPoint(data, -1)).toBeNull();
    expect(getBandPoint(data, 1)).toBeNull();
    expect(getBandPoint(data, 99)).toBeNull();
  });

  it('interleaved length not multiple of 3 truncates to floor(n/3)', () => {
    const interleaved = new Float32Array([0, 1, 2, 3, 4]); // 5 floats → 1 full triple
    expect(getBandLength(interleaved)).toBe(1);
    expect(getBandPoint(interleaved, 0)).toEqual({ x: 0, y: 1, y1: 2 });
  });
});

describe('filterBandGaps / append', () => {
  it('filterBandGaps drops nulls', () => {
    const data: BandSeriesData = [[0, 1, 2], null, [2, 3, 4]];
    const filtered = filterBandGaps(data);
    expect(getBandLength(filtered)).toBe(2);
    expect(getBandPoint(filtered, 0)).toEqual({ x: 0, y: 1, y1: 2 });
  });

  it('appendBandIntoXYYColumns grows columns', () => {
    const cols = { x: [0], y: [1], y1: [2] };
    appendBandIntoXYYColumns(cols, [
      [1, 3, 4],
      [2, 5, 6],
    ]);
    expect(cols.x).toEqual([0, 1, 2]);
    expect(cols.y).toEqual([1, 3, 5]);
    expect(cols.y1).toEqual([2, 4, 6]);
  });

  it('appendBandIntoXYYColumns keepNewCount / offset keeps aligned triples', () => {
    const cols = { x: [0, 1, 2], y: [10, 11, 12], y1: [20, 21, 22] };
    // Drop oldest 2 then append subset of new batch (FIFO-style).
    cols.x.splice(0, 2);
    cols.y.splice(0, 2);
    cols.y1.splice(0, 2);
    appendBandIntoXYYColumns(
      cols,
      [
        [3, 13, 23],
        [4, 14, 24],
        [5, 15, 25],
      ],
      { newSrcOffset: 1, keepNewCount: 2 }
    );
    expect(cols.x).toEqual([2, 4, 5]);
    expect(cols.y).toEqual([12, 14, 15]);
    expect(cols.y1).toEqual([22, 24, 25]);
    expect(cols.x.length).toBe(cols.y.length);
    expect(cols.y.length).toBe(cols.y1.length);
  });

  it('extendBoundsWithBandData merges envelopes', () => {
    const prev = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    // Single-point bandBounds expands degenerate x/y by +1.
    const next = extendBoundsWithBandData(prev, [
      [2, -1, 5],
      [3, 0, 4],
    ]);
    expect(next).toEqual({ xMin: 0, xMax: 3, yMin: -1, yMax: 5 });
  });
});
