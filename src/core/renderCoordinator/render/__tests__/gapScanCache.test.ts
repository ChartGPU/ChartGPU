import { describe, it, expect } from 'vitest';
import { createGapScanCache } from '../gapScanCache';
import { appendIntoRingXY, createRingXYColumns } from '../../../../data/cartesianData';

describe('gapScanCache', () => {
  it('reuses a clean result while ref and point count are unchanged', () => {
    const cache = createGapScanCache();
    const data = { x: [0, 1, 2], y: [1, 2, 3] };
    expect(cache.hasNullGaps(data)).toBe(false);
    data.y[1] = Number.NaN;
    expect(cache.hasNullGaps(data)).toBe(false);
  });

  it('rescans after clear() (in-place mutation under a stable ref)', () => {
    const cache = createGapScanCache();
    const data = { x: [0, 1, 2], y: [1, 2, 3] };
    expect(cache.hasNullGaps(data)).toBe(false);
    data.y[1] = Number.NaN;
    cache.clear();
    expect(cache.hasNullGaps(data)).toBe(true);
  });

  it('rescans when point count changes under the same ref', () => {
    const cache = createGapScanCache();
    const data = { x: [0, 1], y: [1, 2] };
    expect(cache.hasNullGaps(data)).toBe(false);
    data.x.push(2);
    data.y.push(Number.NaN);
    expect(cache.hasNullGaps(data)).toBe(true);
  });

  it('defers ring columns to the epoch-aware hasNullGaps cache', () => {
    const cache = createGapScanCache();
    const ring = createRingXYColumns(4);
    appendIntoRingXY(ring, { x: [0, 1], y: [1, 2] }, 0, 2, 0);
    expect(cache.hasNullGaps(ring)).toBe(false);
    appendIntoRingXY(ring, { x: [2, 3], y: [3, Number.NaN] }, 0, 2, 0);
    expect(cache.hasNullGaps(ring)).toBe(true);
  });

  it('is false for nullish data', () => {
    const cache = createGapScanCache();
    expect(cache.hasNullGaps(null as never)).toBe(false);
  });
});
