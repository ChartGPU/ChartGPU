import { describe, it, expect, vi } from 'vitest';
import {
  computeOhlcCategoryStep,
  getOHLC,
  ohlcBarQuads,
  parsePercent,
  resolveOhlcDirection,
  resolveOhlcStemHalfWidthDomain,
  resolveOhlcTickLengthDomain,
} from '../ohlcGeometry';

describe('resolveOhlcDirection', () => {
  it('marks close > open as up', () => {
    expect(resolveOhlcDirection(10, 11)).toBe('up');
  });

  it('marks close < open as down', () => {
    expect(resolveOhlcDirection(11, 10)).toBe('down');
  });

  it('marks doji (close === open) as down (match candlestick body fill)', () => {
    expect(resolveOhlcDirection(10, 10)).toBe('down');
  });
});

describe('resolveOhlcTickLengthDomain', () => {
  it('defaults to 45% of body width', () => {
    expect(resolveOhlcTickLengthDomain({ tickLength: undefined, bodyWidthDomain: 100 })).toBeCloseTo(45);
  });

  it('uses percent of body width', () => {
    expect(resolveOhlcTickLengthDomain({ tickLength: '50%', bodyWidthDomain: 80 })).toBeCloseTo(40);
  });

  it('uses preconverted domain length for number tickLength', () => {
    expect(
      resolveOhlcTickLengthDomain({
        tickLength: 4,
        bodyWidthDomain: 100,
        tickLengthAsDomain: 12,
      })
    ).toBeCloseTo(12);
  });

  it('clamps percent to [0,1]', () => {
    expect(resolveOhlcTickLengthDomain({ tickLength: '150%', bodyWidthDomain: 20 })).toBeCloseTo(20);
  });

  it('falls back to default fraction for unrecognized tickLength strings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveOhlcTickLengthDomain({ tickLength: 'nope', bodyWidthDomain: 100 })).toBeCloseTo(45);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveOhlcStemHalfWidthDomain', () => {
  it('halves finite positive stem width', () => {
    expect(resolveOhlcStemHalfWidthDomain(2)).toBeCloseTo(1);
  });

  it('returns 0 for non-positive / non-finite', () => {
    expect(resolveOhlcStemHalfWidthDomain(0)).toBe(0);
    expect(resolveOhlcStemHalfWidthDomain(-1)).toBe(0);
    expect(resolveOhlcStemHalfWidthDomain(Number.NaN)).toBe(0);
  });
});

describe('ohlcBarQuads', () => {
  it('matches appendix A geometry for known anchors', () => {
    const q = ohlcBarQuads({
      x: 100,
      open: 50,
      close: 60,
      low: 40,
      high: 70,
      stemHalf: 1,
      tickLength: 10,
      tickHalfY: 1,
    });
    expect(q.stem).toEqual({ minX: 99, maxX: 101, minY: 40, maxY: 70 });
    expect(q.openTick).toEqual({ minX: 90, maxX: 100, minY: 49, maxY: 51 });
    expect(q.closeTick).toEqual({ minX: 100, maxX: 110, minY: 59, maxY: 61 });
  });

  it('uses independent tickHalfY so domain-X stem width is not applied as price thickness', () => {
    const q = ohlcBarQuads({
      x: 0,
      open: 100,
      close: 101,
      low: 99,
      high: 102,
      stemHalf: 5000, // would be catastrophic if reused as Y thickness
      tickLength: 20,
      tickHalfY: 0.5,
    });
    expect(q.openTick.minY).toBeCloseTo(99.5);
    expect(q.openTick.maxY).toBeCloseTo(100.5);
    expect(q.stem.minX).toBe(-5000);
    expect(q.stem.maxX).toBe(5000);
  });
});

describe('getOHLC', () => {
  it('reads object OHLC fields', () => {
    expect(getOHLC({ timestamp: 1, open: 2, close: 3, low: 0, high: 4 })).toEqual({
      timestamp: 1,
      open: 2,
      close: 3,
      low: 0,
      high: 4,
    });
  });

  it('reads tuple [t,o,c,l,h]', () => {
    expect(getOHLC([10, 1, 2, 0.5, 3])).toEqual({
      timestamp: 10,
      open: 1,
      close: 2,
      low: 0.5,
      high: 3,
    });
  });
});

describe('parsePercent', () => {
  it('parses valid percent strings', () => {
    expect(parsePercent('50%')).toBeCloseTo(0.5);
    expect(parsePercent(' 12.5% ')).toBeCloseTo(0.125);
  });

  it('returns null for invalid strings', () => {
    expect(parsePercent('nope')).toBeNull();
    expect(parsePercent('50')).toBeNull();
    expect(parsePercent('%')).toBeNull();
  });
});

describe('computeOhlcCategoryStep', () => {
  it('returns 1 for empty or single finite timestamp', () => {
    expect(computeOhlcCategoryStep([])).toBe(1);
    expect(computeOhlcCategoryStep([{ timestamp: 5, open: 1, close: 1, low: 1, high: 1 }])).toBe(1);
  });

  it('uses min positive Δtimestamp across unsorted input', () => {
    const data = [
      { timestamp: 30, open: 1, close: 1, low: 1, high: 1 },
      { timestamp: 10, open: 1, close: 1, low: 1, high: 1 },
      { timestamp: 20, open: 1, close: 1, low: 1, high: 1 },
    ];
    expect(computeOhlcCategoryStep(data)).toBe(10);
  });

  it('ignores non-finite timestamps', () => {
    const data = [
      { timestamp: Number.NaN, open: 1, close: 1, low: 1, high: 1 },
      { timestamp: 100, open: 1, close: 1, low: 1, high: 1 },
      { timestamp: 125, open: 1, close: 1, low: 1, high: 1 },
    ];
    expect(computeOhlcCategoryStep(data)).toBe(25);
  });

  it('returns 1 when no positive step exists', () => {
    const data = [
      { timestamp: 5, open: 1, close: 1, low: 1, high: 1 },
      { timestamp: 5, open: 1, close: 1, low: 1, high: 1 },
    ];
    expect(computeOhlcCategoryStep(data)).toBe(1);
  });
});
