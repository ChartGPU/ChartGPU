/**
 * Step expand cache: identity reuse, mode invalidation, stable Cartesian refs.
 */
import { describe, it, expect } from 'vitest';
import type { CartesianSeriesData } from '../../../../config/types';
import {
  createStepExpandCache,
  getExpandedStepPolyline,
  getExpandedStepStacked,
  invalidateStepExpandCache,
} from '../stepExpandCache';

describe('stepExpandCache', () => {
  const source: CartesianSeriesData = { x: [0, 1, 2], y: [1, 2, 3] };

  it('reuses stable cartesian identity on consecutive expands with same source+mode', () => {
    const cache = createStepExpandCache();
    const a = getExpandedStepPolyline(cache, 0, source, 'after', false);
    const b = getExpandedStepPolyline(cache, 0, source, 'after', false);
    expect(b.cartesian).toBe(a.cartesian);
    expect(b.poly).toBe(a.poly);
    expect(a.poly.x.length).toBe(5); // 2n-1 for after
  });

  it('re-expands when mode changes and produces a new cartesian ref', () => {
    const cache = createStepExpandCache();
    const a = getExpandedStepPolyline(cache, 0, source, 'after', false);
    const b = getExpandedStepPolyline(cache, 0, source, 'before', false);
    expect(b.cartesian).not.toBe(a.cartesian);
    expect(Array.from(b.poly.x)).not.toEqual(Array.from(a.poly.x));
  });

  it('re-expands when source identity changes', () => {
    const cache = createStepExpandCache();
    const a = getExpandedStepPolyline(cache, 0, source, 'after', false);
    const source2: CartesianSeriesData = { x: [0, 1, 2], y: [1, 2, 3] };
    const b = getExpandedStepPolyline(cache, 0, source2, 'after', false);
    expect(b.cartesian).not.toBe(a.cartesian);
  });

  it('invalidateStepExpandCache forces re-expand', () => {
    const cache = createStepExpandCache();
    const a = getExpandedStepPolyline(cache, 0, source, 'after', false);
    invalidateStepExpandCache(cache);
    const b = getExpandedStepPolyline(cache, 0, source, 'after', false);
    expect(b.cartesian).not.toBe(a.cartesian);
    expect(Array.from(b.poly.x)).toEqual(Array.from(a.poly.x));
  });

  it('stacked expand reuses stackedPack identity', () => {
    const cache = createStepExpandCache();
    const yBottom = [0, 1, 2];
    const yTop = [1, 3, 5];
    const a = getExpandedStepStacked(cache, 1, source, yBottom, yTop, 'after', false);
    const b = getExpandedStepStacked(cache, 1, source, yBottom, yTop, 'after', false);
    expect(b.stackedPack).toBe(a.stackedPack);
    expect(b.strokeData).toBe(a.stackedPack);
    expect(a.stacked.yBottom.length).toBe(a.stacked.yTop.length);
    expect(a.stacked.yBottom.length).toBe(a.stacked.x.length);
  });

  it('poly rewrite on mode change drops stacked fields', () => {
    const cache = createStepExpandCache();
    const yBottom = [0, 1, 2];
    const yTop = [1, 3, 5];
    getExpandedStepStacked(cache, 0, source, yBottom, yTop, 'after', false);
    expect(cache.byIndex.get(0)?.stacked).toBeDefined();
    // Mode change forces poly re-expand and clears stacked fields on write.
    getExpandedStepPolyline(cache, 0, source, 'before', false);
    expect(cache.byIndex.get(0)?.stacked).toBeUndefined();
    expect(cache.byIndex.get(0)?.stackedPack).toBeUndefined();
  });

  it('connectNulls key forces re-expand even when pure expand ignores it', () => {
    const cache = createStepExpandCache();
    const a = getExpandedStepPolyline(cache, 0, source, 'after', false);
    const b = getExpandedStepPolyline(cache, 0, source, 'after', true);
    // Different key → new entry (even though expander uses connectNulls:false).
    expect(b.cartesian).not.toBe(a.cartesian);
  });
});
