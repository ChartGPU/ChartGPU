import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  appendErrorBarIntoHlcColumns,
  computeErrorBarCategoryStep,
  errorBarBounds,
  getErrorBarLength,
  isErrorBarShapedPayload,
  relativeToAbsoluteHlc,
  resolveErrorBarToHlc,
  resetErrorBarWarnings,
} from '../errorBarData';

describe('errorBarData', () => {
  beforeEach(() => {
    resetErrorBarWarnings();
  });

  it('getErrorBarLength uses min of HLC channels and warns on mismatch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      getErrorBarLength({
        x: [0, 1, 2],
        y: [0, 1],
        high: [1, 2, 3],
        low: [0, 0, 0],
      })
    ).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('isErrorBarShapedPayload accepts HLC and relative', () => {
    expect(isErrorBarShapedPayload({ x: [0], y: [1], high: [2], low: [0] })).toBe(true);
    expect(isErrorBarShapedPayload({ x: [0], y: [1], yError: 0.5 })).toBe(true);
    expect(isErrorBarShapedPayload({ x: [0], y: [1] })).toBe(false);
    expect(isErrorBarShapedPayload([[0, 1, 2, 0]])).toBe(true);
  });

  it('appendErrorBarIntoHlcColumns extends columns', () => {
    const cols = { x: [0], y: [1], high: [2], low: [0] };
    appendErrorBarIntoHlcColumns(cols, {
      x: [1, 2],
      y: [3, 4],
      high: [5, 6],
      low: [1, 2],
    });
    expect(cols.x).toEqual([0, 1, 2]);
    expect(cols.high).toEqual([2, 5, 6]);
  });

  it('append relative batch resolves to absolute', () => {
    const cols = { x: [] as number[], y: [] as number[], high: [] as number[], low: [] as number[] };
    appendErrorBarIntoHlcColumns(cols, { x: [0], y: [10], yError: 2 });
    expect(cols.high[0]).toBe(12);
    expect(cols.low[0]).toBe(8);
  });

  it('bounds after absolute resolve include whiskers', () => {
    const hlc = relativeToAbsoluteHlc({ x: [0, 1], y: [10, 20], yError: 5 });
    const b = errorBarBounds(hlc);
    expect(b!.yMin).toBe(5);
    expect(b!.yMax).toBe(25);
  });

  it('tuple form resolves with low>high swap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hlc = resolveErrorBarToHlc([[1, 5, 2, 8]]);
    expect(hlc.high[0]).toBe(8);
    expect(hlc.low[0]).toBe(2);
    warn.mockRestore();
  });

  it('resolves relative object points in array payloads (no silent all-NaN)', () => {
    const hlc = resolveErrorBarToHlc([
      { x: 0, y: 10, yError: 2 },
      { x: 1, y: 20, yErrorHigh: 1, yErrorLow: 3 },
    ] as any);
    expect(Number(hlc.high[0])).toBe(12);
    expect(Number(hlc.low[0])).toBe(8);
    expect(Number(hlc.high[1])).toBe(21);
    expect(Number(hlc.low[1])).toBe(17);
    // Not silent NaN columns
    expect(Number.isFinite(Number(hlc.high[0]))).toBe(true);
  });

  it('computeErrorBarCategoryStep uses Δy for horizontal', () => {
    const data = {
      x: [100, 200, 300], // large X spacing
      y: [0, 1, 2], // unit Y spacing
      high: [110, 210, 310],
      low: [90, 190, 290],
    };
    expect(computeErrorBarCategoryStep(data, 'vertical')).toBeCloseTo(100);
    expect(computeErrorBarCategoryStep(data, 'horizontal')).toBeCloseTo(1);
  });
});
