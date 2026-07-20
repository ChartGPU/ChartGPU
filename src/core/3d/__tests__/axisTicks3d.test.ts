import { describe, it, expect } from 'vitest';
import { generateNiceAxisTicks3D, niceNum, resolveAxisDomain3D, formatAxisTick3D } from '../axisTicks3d';

describe('axisTicks3d', () => {
  it('niceNum returns 1/2/5×10^n ladder', () => {
    expect(niceNum(100, false)).toBe(100);
    // round: f=3.0 → not < 3 → 5×10^1
    expect(niceNum(30, true)).toBe(50);
    expect(niceNum(12, true)).toBe(10);
    expect(niceNum(0, false)).toBe(1);
  });

  it('generateNiceAxisTicks3D covers domain with ascending values', () => {
    const ticks = generateNiceAxisTicks3D(0, 100, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
    }
    expect(ticks[0]!).toBeLessThanOrEqual(0 + 1e-9);
    expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(100 - 1e-6);
  });

  it('handles equal min/max', () => {
    const ticks = generateNiceAxisTicks3D(5, 5, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]!).toBeLessThan(ticks[ticks.length - 1]!);
  });

  it('resolveAxisDomain3D prefers fixed min/max', () => {
    expect(resolveAxisDomain3D(-1, 2, 0, 10)).toEqual({ min: -1, max: 2 });
    expect(resolveAxisDomain3D(undefined, undefined, 0, 10)).toEqual({ min: 0, max: 10 });
  });

  it('formatAxisTick3D is compact', () => {
    expect(formatAxisTick3D(0)).toBe('0');
    expect(formatAxisTick3D(1000)).toBe('1000');
    expect(formatAxisTick3D(Number.NaN)).toBe('—');
  });
});
