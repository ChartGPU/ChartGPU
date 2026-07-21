import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  errorBarInstanceQuads,
  errorBarStemRange,
  resolveErrorBarCapLengthDomain,
  resolveErrorBarStemHalfWidthDomain,
} from '../errorBarGeometry';
import {
  errorBarBounds,
  isErrorBarSampleDrawable,
  normalizeErrorBarHighLow,
  relativeToAbsoluteHlc,
  resolveErrorBarToHlc,
  resetErrorBarWarnings,
} from '../../data/errorBarData';
import { findErrorBarAtPointer } from '../../interaction/findErrorBar';
import type { ResolvedErrorBarSeriesConfig } from '../../config/OptionResolver';
import type { ContinuousScale } from '../../utils/scales';

describe('resolveErrorBarCapLengthDomain', () => {
  it('defaults to 40% of category step', () => {
    expect(resolveErrorBarCapLengthDomain({ capWidth: undefined, categoryStep: 100 })).toBeCloseTo(40);
  });

  it('uses percent of category step', () => {
    expect(resolveErrorBarCapLengthDomain({ capWidth: '50%', categoryStep: 80 })).toBeCloseTo(40);
  });

  it('uses preconverted domain length for number capWidth', () => {
    expect(
      resolveErrorBarCapLengthDomain({
        capWidth: 4,
        categoryStep: 100,
        capWidthAsDomain: 12,
      })
    ).toBeCloseTo(12);
  });

  it('clamps percent to [0,1]', () => {
    expect(resolveErrorBarCapLengthDomain({ capWidth: '150%', categoryStep: 20 })).toBeCloseTo(20);
  });

  it('falls back to default for unrecognized strings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveErrorBarCapLengthDomain({ capWidth: 'nope', categoryStep: 100 })).toBeCloseTo(40);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveErrorBarStemHalfWidthDomain', () => {
  it('halves finite positive stem width', () => {
    expect(resolveErrorBarStemHalfWidthDomain(2)).toBeCloseTo(1);
  });

  it('returns 0 for non-positive / non-finite', () => {
    expect(resolveErrorBarStemHalfWidthDomain(0)).toBe(0);
    expect(resolveErrorBarStemHalfWidthDomain(-1)).toBe(0);
    expect(resolveErrorBarStemHalfWidthDomain(Number.NaN)).toBe(0);
  });
});

describe('errorBarStemRange', () => {
  const p = { x: 1, y: 5, high: 8, low: 2 };
  it('both: low → high', () => {
    expect(errorBarStemRange(p, 'both')).toEqual({ a: 2, b: 8 });
  });
  it('high: y → high', () => {
    expect(errorBarStemRange(p, 'high')).toEqual({ a: 5, b: 8 });
  });
  it('low: low → y', () => {
    expect(errorBarStemRange(p, 'low')).toEqual({ a: 2, b: 5 });
  });
});

describe('errorBarInstanceQuads', () => {
  it('matches vertical both-mode anchors', () => {
    const q = errorBarInstanceQuads({
      x: 100,
      y: 50,
      high: 70,
      low: 40,
      stemHalf: 1,
      capHalf: 10,
      capHalfThick: 1,
      errorMode: 'both',
    });
    expect(q.stem).toEqual({ minX: 99, maxX: 101, minY: 40, maxY: 70 });
    expect(q.highCap).toEqual({ minX: 90, maxX: 110, minY: 69, maxY: 71 });
    expect(q.lowCap).toEqual({ minX: 90, maxX: 110, minY: 39, maxY: 41 });
  });

  it('uses independent capHalfThick so domain-X stem width is not applied as Y thickness', () => {
    const q = errorBarInstanceQuads({
      x: 0,
      y: 100,
      high: 102,
      low: 99,
      stemHalf: 5000, // would be catastrophic if reused as Y thickness
      capHalf: 20,
      capHalfThick: 0.5,
      errorMode: 'both',
    });
    expect(q.highCap!.minY).toBeCloseTo(101.5);
    expect(q.highCap!.maxY).toBeCloseTo(102.5);
    expect(q.stem!.minX).toBe(-5000);
    expect(q.stem!.maxX).toBe(5000);
  });

  it('high mode: stem y→high, high cap only', () => {
    const q = errorBarInstanceQuads({
      x: 0,
      y: 10,
      high: 15,
      low: 5,
      stemHalf: 1,
      capHalf: 4,
      capHalfThick: 0.5,
      errorMode: 'high',
    });
    expect(q.stem!.minY).toBe(10);
    expect(q.stem!.maxY).toBe(15);
    expect(q.highCap).not.toBeNull();
    expect(q.lowCap).toBeNull();
  });

  it('drawConnector false omits stem', () => {
    const q = errorBarInstanceQuads({
      x: 0,
      y: 10,
      high: 15,
      low: 5,
      stemHalf: 1,
      capHalf: 4,
      capHalfThick: 0.5,
      drawConnector: false,
    });
    expect(q.stem).toBeNull();
    expect(q.highCap).not.toBeNull();
  });

  it('horizontal: stem along X, caps vertical', () => {
    const q = errorBarInstanceQuads({
      x: 50, // center x unused for horizontal stem position (high/low are X)
      y: 20,
      high: 60,
      low: 40,
      stemHalf: 1,
      capHalf: 5,
      capHalfThick: 0.5,
      direction: 'horizontal',
      errorMode: 'both',
    });
    expect(q.stem).toEqual({ minX: 40, maxX: 60, minY: 19, maxY: 21 });
    expect(q.highCap!.minX).toBeCloseTo(59.5);
    expect(q.highCap!.maxX).toBeCloseTo(60.5);
    expect(q.highCap!.minY).toBe(15);
    expect(q.highCap!.maxY).toBe(25);
  });
});

describe('normalizeErrorBarHighLow / relative', () => {
  beforeEach(() => {
    resetErrorBarWarnings();
  });

  it('swaps low > high', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeErrorBarHighLow(3, 10)).toEqual({ high: 10, low: 3, swapped: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('relative symmetric → absolute HLC', () => {
    const hlc = relativeToAbsoluteHlc({
      x: [0, 1],
      y: [10, 20],
      yError: [2, 3],
    });
    expect(hlc.high[0]).toBe(12);
    expect(hlc.low[0]).toBe(8);
    expect(hlc.high[1]).toBe(23);
    expect(hlc.low[1]).toBe(17);
  });

  it('relative asymmetric uses abs offsets', () => {
    const hlc = relativeToAbsoluteHlc({
      x: [0],
      y: [10],
      yErrorHigh: 1.5,
      yErrorLow: 0.5,
    });
    expect(hlc.high[0]).toBeCloseTo(11.5);
    expect(hlc.low[0]).toBeCloseTo(9.5);
  });

  it('resolveErrorBarToHlc owns arrays (does not alias caller)', () => {
    const x = [1, 2];
    const y = [3, 4];
    const high = [5, 6];
    const low = [1, 2];
    const hlc = resolveErrorBarToHlc({ x, y, high, low });
    expect(hlc.x).not.toBe(x);
    expect(Array.from(hlc.x as number[])).toEqual([1, 2]);
  });
});

describe('errorBarBounds / null policy', () => {
  it('includes high/low in Y bounds', () => {
    const b = errorBarBounds({
      x: [0, 1],
      y: [5, 5],
      high: [9, 6],
      low: [1, 4],
    });
    expect(b).not.toBeNull();
    expect(b!.yMin).toBe(1);
    expect(b!.yMax).toBe(9);
  });

  it('skips non-drawable samples for both mode', () => {
    expect(isErrorBarSampleDrawable({ x: 0, y: Number.NaN, high: 1, low: 0 }, 'both')).toBe(false);
    expect(isErrorBarSampleDrawable({ x: 0, y: 1, high: Number.NaN, low: 0 }, 'both')).toBe(false);
    expect(isErrorBarSampleDrawable({ x: 0, y: 1, high: 2, low: 0 }, 'both')).toBe(true);
    expect(isErrorBarSampleDrawable({ x: 0, y: 1, high: Number.NaN, low: 0 }, 'high')).toBe(false);
    expect(isErrorBarSampleDrawable({ x: 0, y: 1, high: Number.NaN, low: 0 }, 'low')).toBe(true);
  });
});

function mockScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): ContinuousScale {
  const dSpan = domainMax - domainMin;
  const rSpan = rangeMax - rangeMin;
  return {
    kind: 'linear',
    scale: (v: number) => rangeMin + ((v - domainMin) / dSpan) * rSpan,
    invert: (v: number) => domainMin + ((v - rangeMin) / rSpan) * dSpan,
    getDomain: () => ({ min: domainMin, max: domainMax }),
    getRange: () => ({ min: rangeMin, max: rangeMax }),
  } as unknown as ContinuousScale;
}

describe('findErrorBarAtPointer', () => {
  const series = {
    type: 'errorBar' as const,
    name: 'eb',
    visible: true,
    color: '#fff',
    itemStyle: { color: '#fff', borderWidth: 2, opacity: 1 },
    capWidth: '40%',
    errorMode: 'both' as const,
    direction: 'vertical' as const,
    drawWhiskers: true,
    drawConnector: true,
    showCenter: false,
    symbolSize: 6,
    sampling: 'none' as const,
    rawData: { x: [10], y: [50], high: [70], low: [30] },
    data: { x: [10], y: [50], high: [70], low: [30] },
    yAxis: 'y',
  } satisfies ResolvedErrorBarSeriesConfig;

  const xScale = mockScale(0, 100, 0, 100);
  const yScale = mockScale(0, 100, 100, 0); // CSS Y inverted
  const plot = { width: 100, height: 100 };

  it('hits stem at center', () => {
    // domain (10, 50) → plot css: x=10, y=50 (because y range inverted 100→0)
    const plotY = yScale.scale(50);
    const hit = findErrorBarAtPointer([{ seriesIndex: 0, series }], 10, plotY, xScale, yScale, plot);
    expect(hit).not.toBeNull();
    expect(hit!.dataIndex).toBe(0);
    expect(hit!.point.y).toBe(50);
  });

  it('misses far from stem/caps', () => {
    const hit = findErrorBarAtPointer([{ seriesIndex: 0, series }], 80, yScale.scale(50), xScale, yScale, plot);
    expect(hit).toBeNull();
  });
});
