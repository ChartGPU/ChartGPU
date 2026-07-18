import { describe, it, expect } from 'vitest';
import { isFullSpanZoomRange, scanCartesianVisibleYBounds, scanCartesianPositiveYBounds } from '../visibleYBounds';

describe('isFullSpanZoomRange', () => {
  it('treats null/undefined as full span', () => {
    expect(isFullSpanZoomRange(null)).toBe(true);
    expect(isFullSpanZoomRange(undefined)).toBe(true);
  });

  it('accepts start/end at 0/100 and within 0.5% tolerance (zoomHelpers)', () => {
    expect(isFullSpanZoomRange({ start: 0, end: 100 })).toBe(true);
    expect(isFullSpanZoomRange({ start: -1, end: 100 })).toBe(true);
    // Shared 0.5% UI/float tolerance — not a strict start≤0 && end≥100 only.
    expect(isFullSpanZoomRange({ start: 0.4, end: 99.6 })).toBe(true);
  });

  it('rejects partial zoom windows outside tolerance', () => {
    expect(isFullSpanZoomRange({ start: 10, end: 90 })).toBe(false);
    expect(isFullSpanZoomRange({ start: 0, end: 99 })).toBe(false);
    expect(isFullSpanZoomRange({ start: 1, end: 100 })).toBe(false);
  });
});

describe('scanCartesianVisibleYBounds', () => {
  const data = {
    x: new Float64Array([0, 10, 20, 30, 40]),
    y: new Float64Array([100, 1, 50, 2, 200]),
  };

  it('full scan returns global y extrema', () => {
    const b = scanCartesianVisibleYBounds(data);
    expect(b).toEqual({ yMin: 1, yMax: 200 });
  });

  it('x-window filter excludes off-window peaks (zoomed GPU-raw path)', () => {
    // Window [10, 30] sees y = 1, 50, 2 — not 100 or 200
    const b = scanCartesianVisibleYBounds(data, { min: 10, max: 30 });
    expect(b).toEqual({ yMin: 1, yMax: 50 });
  });

  it('returns null when window has no points', () => {
    expect(scanCartesianVisibleYBounds(data, { min: 100, max: 200 })).toBeNull();
  });

  it('expands equal y to unit span', () => {
    const flat = { x: new Float64Array([0, 1]), y: new Float64Array([7, 7]) };
    expect(scanCartesianVisibleYBounds(flat)).toEqual({ yMin: 7, yMax: 8 });
  });
});

describe('scanCartesianPositiveYBounds', () => {
  // Global positives: 100,1,50,2,200. Window [10,30] has 1,50,2 and also 0/-5 noise.
  const data = {
    x: new Float64Array([0, 10, 20, 30, 40, 25]),
    y: new Float64Array([100, 1, 0, 2, 200, -5]),
  };

  it('ignores ≤0 globally', () => {
    const b = scanCartesianPositiveYBounds(data);
    expect(b).toEqual({ yMin: 1, yMax: 200 });
  });

  it('x-window restricts positives (does not use off-window peaks)', () => {
    // Window [10, 30]: positives 1, 2 (0 and -5 ignored; 100/200 off-window)
    const b = scanCartesianPositiveYBounds(data, { min: 10, max: 30 });
    expect(b).toEqual({ yMin: 1, yMax: 2 });
  });

  it('returns null when window has no positive y', () => {
    const onlyNonPos = {
      x: new Float64Array([0, 1]),
      y: new Float64Array([0, -3]),
    };
    expect(scanCartesianPositiveYBounds(onlyNonPos)).toBeNull();
    expect(scanCartesianPositiveYBounds(data, { min: 100, max: 200 })).toBeNull();
  });
});
