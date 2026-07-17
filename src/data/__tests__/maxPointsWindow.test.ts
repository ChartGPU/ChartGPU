import { describe, it, expect } from 'vitest';
import {
  deviceMaxPointsFromLimits,
  maxPointsPeakRetention,
  normalizeMaxPoints,
  planMaxPointsWindow,
  resolveEffectiveMaxPointsForAppend,
} from '../maxPointsWindow';

describe('normalizeMaxPoints', () => {
  it('returns undefined for missing/invalid values', () => {
    expect(normalizeMaxPoints(undefined)).toBeUndefined();
    expect(normalizeMaxPoints(null)).toBeUndefined();
    expect(normalizeMaxPoints(0)).toBeUndefined();
    expect(normalizeMaxPoints(-1)).toBeUndefined();
    expect(normalizeMaxPoints(NaN)).toBeUndefined();
  });

  it('floors positive finite values', () => {
    expect(normalizeMaxPoints(4.9)).toBe(4);
    expect(normalizeMaxPoints(1)).toBe(1);
  });
});

describe('planMaxPointsWindow (fixed-capacity ring)', () => {
  it('pure append without maxPoints', () => {
    const p = planMaxPointsWindow(10, 3, undefined);
    expect(p).toMatchObject({
      nextCount: 13,
      dropPrevCount: 0,
      newSrcOffset: 0,
      keepNewCount: 3,
      didWindow: false,
      isStrictReplace: false,
      ringCapacity: 0,
      isRing: false,
    });
  });

  it('pure append under ring capacity (fill phase)', () => {
    // prev=4, new=2, max=8 → uncapped 6 ≤ 8
    const p = planMaxPointsWindow(4, 2, 8);
    expect(p).toMatchObject({
      nextCount: 6,
      dropPrevCount: 0,
      keepNewCount: 2,
      didWindow: false,
      isStrictReplace: false,
      ringCapacity: 8,
      isRing: true,
    });
  });

  it('ring wrap when uncapped exceeds maxPoints (no soft 2×)', () => {
    // prev=8, new=1, max=4 → drop 5, next=4 (hard cap, not soft 2×)
    const p = planMaxPointsWindow(8, 1, 4);
    expect(p).toMatchObject({
      nextCount: 4,
      dropPrevCount: 5,
      newSrcOffset: 0,
      keepNewCount: 1,
      didWindow: true,
      isStrictReplace: false,
      ringCapacity: 4,
      isRing: true,
    });
  });

  it('ring wrap when full: prev=max, append n → drop n', () => {
    // Steady-state FIFO: capacity full, append batch < capacity.
    const p = planMaxPointsWindow(1000, 100, 1000);
    expect(p).toMatchObject({
      nextCount: 1000,
      dropPrevCount: 100,
      keepNewCount: 100,
      didWindow: true,
      isStrictReplace: false,
      ringCapacity: 1000,
    });
  });

  it('strict replace when newCount === maxPoints (suite FIFO 100/100)', () => {
    const p = planMaxPointsWindow(100, 100, 100);
    expect(p).toMatchObject({
      nextCount: 100,
      dropPrevCount: 100,
      newSrcOffset: 0,
      keepNewCount: 100,
      didWindow: true,
      isStrictReplace: true,
      ringCapacity: 100,
    });
  });

  it('strict replace keeps only tail when newCount > maxPoints', () => {
    const p = planMaxPointsWindow(50, 10, 4);
    expect(p).toMatchObject({
      nextCount: 4,
      dropPrevCount: 50,
      newSrcOffset: 6,
      keepNewCount: 4,
      didWindow: true,
      isStrictReplace: true,
    });
  });

  it('maxPoints=1 always strict-replaces non-empty batches', () => {
    const p = planMaxPointsWindow(20, 3, 1);
    expect(p).toMatchObject({
      nextCount: 1,
      dropPrevCount: 20,
      newSrcOffset: 2,
      keepNewCount: 1,
      isStrictReplace: true,
    });
  });

  it('peak retention equals maxPoints (ring, not soft 2×)', () => {
    expect(maxPointsPeakRetention(5)).toBe(5);
  });

  it('newCount === 0 is a no-op keep of prev', () => {
    const p = planMaxPointsWindow(10, 0, 8);
    expect(p).toMatchObject({
      nextCount: 10,
      dropPrevCount: 0,
      keepNewCount: 0,
      didWindow: false,
      isStrictReplace: false,
      ringCapacity: 8,
      isRing: true,
    });
  });

  it('exact fill prev + new === maxPoints is pure append under ring', () => {
    const p = planMaxPointsWindow(6, 2, 8);
    expect(p).toMatchObject({
      nextCount: 8,
      dropPrevCount: 0,
      newSrcOffset: 0,
      keepNewCount: 2,
      didWindow: false,
      isStrictReplace: false,
      ringCapacity: 8,
      isRing: true,
    });
  });
});

describe('resolveEffectiveMaxPointsForAppend (issue 1.1)', () => {
  const tinyLimits = { maxBufferSize: 1024, maxStorageBufferBindingSize: 1024 };
  // deviceMax = floor(1024 / 8) = 128

  it('returns undefined when unbounded and under device budget', () => {
    expect(resolveEffectiveMaxPointsForAppend(undefined, 10, 5, tinyLimits)).toBeUndefined();
  });

  it('engages device auto-window when uncapped next exceeds budget', () => {
    const deviceMax = deviceMaxPointsFromLimits(tinyLimits);
    expect(deviceMax).toBe(128);
    expect(resolveEffectiveMaxPointsForAppend(undefined, 100, 50, tinyLimits)).toBe(deviceMax);
  });

  it('caller maxPoints still wins when tighter than device', () => {
    expect(resolveEffectiveMaxPointsForAppend(50, 40, 20, tinyLimits)).toBe(50);
  });

  it('device hard-clamps when caller max exceeds device budget', () => {
    const deviceMax = deviceMaxPointsFromLimits(tinyLimits);
    expect(resolveEffectiveMaxPointsForAppend(10_000, 0, 1, tinyLimits)).toBe(deviceMax);
  });
});

describe('device auto-window dual-store lockstep (issue 1.1)', () => {
  it('planner and deviceMax agree on retained window size', () => {
    const limits = { maxBufferSize: 512, maxStorageBufferBindingSize: 512 };
    const deviceMax = deviceMaxPointsFromLimits(limits);
    expect(deviceMax).toBe(64);
    const effective = resolveEffectiveMaxPointsForAppend(undefined, 64, 10, limits);
    expect(effective).toBe(64);
    const plan = planMaxPointsWindow(64, 10, effective);
    expect(plan.nextCount).toBe(64);
    expect(plan.didWindow).toBe(true);
    expect(plan.dropPrevCount).toBe(10);
  });
});
