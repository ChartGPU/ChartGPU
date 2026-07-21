import { describe, it, expect } from 'vitest';
import {
  resolveScatterDrawPolicy,
  DENSE_SCATTER_DENSITY_LO,
  DENSE_SCATTER_DENSITY_HI,
  DENSE_SCATTER_MIN_RADIUS_DEVICE_PX,
  DENSE_SCATTER_POINT_COUNT_FULL_COMPACT,
} from '../scatterDrawPolicy';

describe('resolveScatterDrawPolicy', () => {
  // Suite-like plot: 800×600 CSS @ dpr2 with grid insets ≈ 1412×1064 device px.
  const suitePlot = { plotWidthDevicePx: 1412, plotHeightDevicePx: 1064 };
  // Compact unit-test plot used by older cases.
  const plot = { plotWidthDevicePx: 800, plotHeightDevicePx: 400 }; // 320k px
  const area = plot.plotWidthDevicePx * plot.plotHeightDevicePx;

  it('keeps standard radius at low density (group 2 ≤100k protection)', () => {
    // 100k / suite plot ≈ 0.066 < LO 0.08
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: 100_000,
      ...suitePlot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveRadiusDevicePx).toBe(10);
    expect(r.fullyCompact).toBe(false);
  });

  it('just below density LO stays standard', () => {
    const count = Math.floor(DENSE_SCATTER_DENSITY_LO * area) - 1;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(DENSE_SCATTER_POINT_COUNT_FULL_COMPACT);
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: count,
      ...plot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveRadiusDevicePx).toBe(10);
    expect(r.fullyCompact).toBe(false);
  });

  it('at/above density HI is fully compact (min radius) without point-count floor', () => {
    // Pin density ≥ HI with N strictly below the point-count floor so the density
    // ramp (not N floor) drives fullyCompact.
    const count = Math.ceil(DENSE_SCATTER_DENSITY_HI * area);
    expect(count).toBeGreaterThanOrEqual(DENSE_SCATTER_DENSITY_HI * area);
    expect(count).toBeLessThan(DENSE_SCATTER_POINT_COUNT_FULL_COMPACT);
    expect(count / area).toBeGreaterThanOrEqual(DENSE_SCATTER_DENSITY_HI);

    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: count,
      ...plot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.effectiveRadiusDevicePx).toBe(DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
    expect(r.fullyCompact).toBe(true);
  });

  it('N = floor-1 on huge plot is not forced by point-count floor', () => {
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: DENSE_SCATTER_POINT_COUNT_FULL_COMPACT - 1,
      plotWidthDevicePx: 2_000_000,
      plotHeightDevicePx: 2_000_000,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('standard');
    expect(r.fullyCompact).toBe(false);
    expect(r.effectiveRadiusDevicePx).toBe(10);
  });

  it('fully compacts at suite 500k (hard gate density + point-count floor)', () => {
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: 500_000,
      ...suitePlot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.effectiveRadiusDevicePx).toBe(DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
    expect(r.fullyCompact).toBe(true);
  });

  it('enters denseCompact at high density (group 2 @ 1M)', () => {
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: 1_000_000,
      ...plot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.effectiveRadiusDevicePx).toBe(DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
    expect(r.fullyCompact).toBe(true);
  });

  it('point-count floor forces full compact even on huge plots (low density)', () => {
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: DENSE_SCATTER_POINT_COUNT_FULL_COMPACT,
      plotWidthDevicePx: 2_000_000,
      plotHeightDevicePx: 2_000_000,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.effectiveRadiusDevicePx).toBe(DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
    expect(r.fullyCompact).toBe(true);
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
    expect(r.fullyCompact).toBe(false);
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
    expect(r.fullyCompact).toBe(false);
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

  it('blends radius between density LO and HI without fullyCompact', () => {
    const midDensity = (DENSE_SCATTER_DENSITY_LO + DENSE_SCATTER_DENSITY_HI) / 2;
    const count = Math.min(Math.floor(midDensity * area), DENSE_SCATTER_POINT_COUNT_FULL_COMPACT - 1);
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: count,
      ...plot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.fullyCompact).toBe(false);
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
    expect(r.fullyCompact).toBe(true);
  });

  it('suite 200k is denser than LO (may blend) but not fullyCompact by point-count floor', () => {
    expect(200_000).toBeLessThan(DENSE_SCATTER_POINT_COUNT_FULL_COMPACT);
    const r = resolveScatterDrawPolicy({
      constRadius: true,
      pointCount: 200_000,
      ...suitePlot,
      radiusDevicePx: 10,
    });
    expect(r.policy).toBe('denseCompact');
    expect(r.fullyCompact).toBe(false);
    expect(r.effectiveRadiusDevicePx).toBeGreaterThan(DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
    expect(r.effectiveRadiusDevicePx).toBeLessThan(10);
  });
});
