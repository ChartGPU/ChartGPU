import { describe, it, expect } from 'vitest';
import {
  resolveScatterDrawPolicy,
  DENSE_SCATTER_DENSITY_LO,
  DENSE_SCATTER_MIN_RADIUS_DEVICE_PX,
} from '../scatterDrawPolicy';

describe('resolveScatterDrawPolicy', () => {
  const plot = { plotWidthDevicePx: 800, plotHeightDevicePx: 400 }; // 320k px

  it('keeps standard radius at low density (group 2 ≤100k protection)', () => {
    // 100k / 320k ≈ 0.31 < 0.5
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: 100_000,
      ...plot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveRadiusDevicePx).toBe(10);
  });

  it('enters denseCompact at high density (group 2 @ 1M)', () => {
    // 1M / 320k ≈ 3.125 → fully compact
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: 1_000_000,
      ...plot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.effectiveRadiusDevicePx).toBe(DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
  });

  it('forceStandard (performance.lod strict) keeps configured radius at high density (issue 2.2)', () => {
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: 1_000_000,
      ...plot,
      radiusDevicePx: 10,
      forceStandard: true,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveRadiusDevicePx).toBe(10);
  });

  it('never applies to variable-radius path', () => {
    const r = resolveScatterDrawPolicy({
      constRadius: false,
      pointCount: 1_000_000,
      ...plot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveRadiusDevicePx).toBe(10);
  });

  it('false-positive miss: empty / zero radius stays standard', () => {
    expect(
      resolveScatterDrawPolicy({
        constRadius: true,
        pointCount: 0,
        ...plot,
        radiusDevicePx: 10,
      }).policy
    ).toBe('standard');
    expect(
      resolveScatterDrawPolicy({
        constRadius: true,
        pointCount: 1_000_000,
        ...plot,
        radiusDevicePx: 0,
      }).effectiveRadiusDevicePx
    ).toBe(0);
  });

  it('blends radius between density LO and HI', () => {
    const area = plot.plotWidthDevicePx * plot.plotHeightDevicePx;
    const midDensity = (DENSE_SCATTER_DENSITY_LO + 3.0) / 2;
    const count = Math.floor(midDensity * area);
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: count,
      ...plot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.effectiveRadiusDevicePx).toBeGreaterThan(DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
    expect(r.effectiveRadiusDevicePx).toBeLessThan(10);
  });

  it('does not thicken sub-MIN radius at high density (1M)', () => {
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: 1_000_000,
      ...plot,
      radiusDevicePx: 0.5,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.effectiveRadiusDevicePx).toBe(0.5);
    expect(r.effectiveRadiusDevicePx).toBeLessThan(DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
  });
});
