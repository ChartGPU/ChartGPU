import { describe, it, expect } from 'vitest';
import {
  resolveDenseDrawStride,
  resolveMaxDrawSegments,
  DENSE_DRAW_POINT_THRESHOLD,
  DENSE_DRAW_MIN_TARGET_SEGMENTS,
  DENSE_DRAW_WIDTH_OVERSAMPLE,
} from '../denseDrawLod';
import { resolveAreaDrawPolicy, DENSE_AREA_POINT_THRESHOLD } from '../areaDrawPolicy';

describe('resolveMaxDrawSegments', () => {
  it('floors at DENSE_DRAW_MIN_TARGET_SEGMENTS when width unknown', () => {
    expect(resolveMaxDrawSegments(undefined)).toBe(DENSE_DRAW_MIN_TARGET_SEGMENTS);
    expect(resolveMaxDrawSegments(0)).toBe(DENSE_DRAW_MIN_TARGET_SEGMENTS);
  });

  it('uses width × oversample when larger than min floor', () => {
    const w = 8000;
    expect(resolveMaxDrawSegments(w)).toBe(w * DENSE_DRAW_WIDTH_OVERSAMPLE);
  });
});

describe('resolveDenseDrawStride', () => {
  it('returns zero segments below 2 points', () => {
    expect(resolveDenseDrawStride({ pointCount: 0 }).drawSegmentCount).toBe(0);
    expect(resolveDenseDrawStride({ pointCount: 1 }).drawSegmentCount).toBe(0);
  });

  it('keeps full N−1 below point threshold', () => {
    const n = DENSE_DRAW_POINT_THRESHOLD - 1;
    const r = resolveDenseDrawStride({ pointCount: n, plotWidthDevicePx: 100 });
    expect(r.dense).toBe(false);
    expect(r.stride).toBe(1);
    expect(r.drawSegmentCount).toBe(n - 1);
    expect(r.lastPointIndex).toBe(n - 1);
  });

  it('forceStandard always full geometry at multi-M', () => {
    const r = resolveDenseDrawStride({
      pointCount: 10_000_000,
      plotWidthDevicePx: 1500,
      forceStandard: true,
    });
    expect(r.dense).toBe(false);
    expect(r.stride).toBe(1);
    expect(r.drawSegmentCount).toBe(9_999_999);
  });

  it('enters dense LOD at 5M toward plot budget (group 8 gate A shape)', () => {
    const plotW = 1400;
    const maxSeg = resolveMaxDrawSegments(plotW);
    const r = resolveDenseDrawStride({
      pointCount: 5_000_000,
      plotWidthDevicePx: plotW,
    });
    expect(r.dense).toBe(true);
    expect(r.stride).toBeGreaterThan(1);
    // ceil math can land slightly above maxDraw by < stride (still ≪ full N).
    expect(r.drawSegmentCount).toBeLessThanOrEqual(maxSeg + r.stride);
    expect(r.drawSegmentCount).toBeLessThan(20_000);
    // Still enough segments for a continuous mountain under suite camera.
    expect(r.drawSegmentCount).toBeGreaterThanOrEqual(DENSE_DRAW_MIN_TARGET_SEGMENTS - 1);
  });

  it('enters dense LOD at 10M (group 8 gate B)', () => {
    const r = resolveDenseDrawStride({
      pointCount: 10_000_000,
      plotWidthDevicePx: 1400,
    });
    expect(r.dense).toBe(true);
    expect(r.drawSegmentCount).toBeLessThan(20_000);
  });

  it('covers last point: i0..last with ceil segments', () => {
    // High N + maxDraw 4 → stride ceil((N-1)/4); final i1 pins lastPointIndex.
    const r2 = resolveDenseDrawStride({
      pointCount: DENSE_DRAW_POINT_THRESHOLD,
      maxDrawSegments: 4,
    });
    expect(r2.dense).toBe(true);
    expect(r2.stride).toBe(Math.ceil((DENSE_DRAW_POINT_THRESHOLD - 1) / 4));
    expect(r2.lastPointIndex).toBe(DENSE_DRAW_POINT_THRESHOLD - 1);
    // Final instance reaches last index: (drawSegmentCount-1)*stride may be < last, but
    // i1 = min(i0+stride, last) pins the end.
    expect(r2.drawSegmentCount * r2.stride).toBeGreaterThanOrEqual(r2.lastPointIndex);
  });

  it('1M with typical suite plot still densifies (display-refresh budget)', () => {
    const r = resolveDenseDrawStride({
      pointCount: 1_000_000,
      plotWidthDevicePx: 1400,
    });
    expect(r.dense).toBe(true);
    expect(r.drawSegmentCount).toBeLessThan(10_000);
  });

  it('budget is max(2048, 1× plotWidth) — not 4096 / 2×', () => {
    expect(DENSE_DRAW_MIN_TARGET_SEGMENTS).toBe(2_048);
    expect(DENSE_DRAW_WIDTH_OVERSAMPLE).toBe(1);
    expect(resolveMaxDrawSegments(1400)).toBe(2_048); // floor wins under 2048
    expect(resolveMaxDrawSegments(3000)).toBe(3000);
  });

  it('500k protect row densifies under auto (document intentional)', () => {
    const r = resolveDenseDrawStride({
      pointCount: 500_000,
      plotWidthDevicePx: 1400,
    });
    expect(r.dense).toBe(true);
    expect(r.drawSegmentCount).toBeLessThan(500_000 - 1);
  });
});

describe('resolveAreaDrawPolicy', () => {
  it('aliases dense area threshold to shared floor', () => {
    expect(DENSE_AREA_POINT_THRESHOLD).toBe(DENSE_DRAW_POINT_THRESHOLD);
  });

  it('maps dense stride to denseLod policy', () => {
    const r = resolveAreaDrawPolicy({
      pointCount: 5_000_000,
      plotWidthDevicePx: 1400,
    });
    expect(r.policy).toBe('denseLod');
    expect(r.stride).toBeGreaterThan(1);
  });

  it('strict lod → standard policy', () => {
    const r = resolveAreaDrawPolicy({
      pointCount: 5_000_000,
      plotWidthDevicePx: 1400,
      forceStandard: true,
    });
    expect(r.policy).toBe('standard');
    expect(r.stride).toBe(1);
  });
});
