/**
 * Issue 0.2: CPU LTTB must preserve epoch-ms precision through index selection.
 */
import { describe, it, expect } from 'vitest';
import { sampleSeriesDataPoints, packToFloat32ArrayAbsolute } from '../sampleSeries';
import { getPointCount, getX } from '../cartesianData';
import type { DataPoint } from '../../config/types';

describe('sampleSeriesDataPoints LTTB epoch-ms precision (issue 0.2)', () => {
  const base = Date.UTC(2026, 6, 16); // ~1.784e12

  it('documents Float32 absolute pack collapse at epoch scale', () => {
    const data: DataPoint[] = Array.from({ length: 10 }, (_, i) => [base + i * 1000, i] as DataPoint);
    const packed = packToFloat32ArrayAbsolute(data);
    const unique = new Set<number>();
    for (let i = 0; i < 10; i++) unique.add(packed[i * 2]!);
    // ULP ~131072 ms → all second-spaced x collapse to one float.
    expect(unique.size).toBe(1);
  });

  it('LTTB on epoch-ms DataPoint[] keeps many unique x values', () => {
    const data: DataPoint[] = Array.from({ length: 100 }, (_, i) => [base + i * 1000, Math.sin(i)] as DataPoint);
    const sampled = sampleSeriesDataPoints(data, 'lttb', 20);
    const n = getPointCount(sampled);
    expect(n).toBeGreaterThanOrEqual(15);
    const xs = new Set<number>();
    for (let i = 0; i < n; i++) xs.add(getX(sampled, i));
    // Must not collapse to a single Float32 epoch bin.
    expect(xs.size).toBeGreaterThanOrEqual(15);
    // First/last near true domain ends.
    expect(getX(sampled, 0)).toBeCloseTo(base, -1);
    expect(getX(sampled, n - 1)).toBeCloseTo(base + 99 * 1000, -1);
  });

  it('LTTB on epoch-ms XY arrays keeps distinct x', () => {
    const x = Float64Array.from({ length: 100 }, (_, i) => base + i * 1000);
    const y = Float64Array.from({ length: 100 }, (_, i) => i);
    const sampled = sampleSeriesDataPoints({ x, y }, 'lttb', 20);
    const n = getPointCount(sampled);
    const xs = new Set<number>();
    for (let i = 0; i < n; i++) xs.add(getX(sampled, i));
    expect(xs.size).toBeGreaterThanOrEqual(15);
  });

  it('small-index x series still samples correctly (no precision regression)', () => {
    const data: DataPoint[] = Array.from({ length: 100 }, (_, i) => [i, Math.sin(i)] as DataPoint);
    const sampled = sampleSeriesDataPoints(data, 'lttb', 20);
    const n = getPointCount(sampled);
    expect(n).toBe(20);
    expect(getX(sampled, 0)).toBe(0);
    expect(getX(sampled, n - 1)).toBe(99);
  });

  it('null-gap epoch series still keeps distinct x through LTTB (issue 11)', () => {
    const base = Date.UTC(2026, 6, 16);
    const data: Array<DataPoint | null> = Array.from({ length: 100 }, (_, i) =>
      i === 40 || i === 41 ? null : ([base + i * 1000, Math.sin(i)] as DataPoint)
    );
    const sampled = sampleSeriesDataPoints(data as any, 'lttb', 20);
    const n = getPointCount(sampled);
    expect(n).toBeGreaterThanOrEqual(15);
    const xs = new Set<number>();
    for (let i = 0; i < n; i++) xs.add(getX(sampled, i));
    expect(xs.size).toBeGreaterThanOrEqual(15);
  });
});
