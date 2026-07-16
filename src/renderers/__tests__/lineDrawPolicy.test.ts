import { describe, it, expect } from 'vitest';
import {
  resolveLineDrawPolicy,
  DENSE_LINE_POINT_THRESHOLD,
  DENSE_LINE_MIN_WIDTH_CSS,
} from '../lineDrawPolicy';

describe('resolveLineDrawPolicy', () => {
  it('keeps standard width below threshold (group 3 ≤10k / 100k protection)', () => {
    const r = resolveLineDrawPolicy({ pointCount: 100_000, lineWidthCssPx: 2 });
    expect(r.policy).toBe('standard');
    expect(r.effectiveLineWidthCssPx).toBe(2);
  });

  it('stays standard at exactly THRESHOLD (t=0)', () => {
    const r = resolveLineDrawPolicy({
      pointCount: DENSE_LINE_POINT_THRESHOLD,
      lineWidthCssPx: 2,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveLineWidthCssPx).toBe(2);
  });

  it('enters denseThin above threshold (group 3 @ 1M)', () => {
    const r = resolveLineDrawPolicy({ pointCount: 1_000_000, lineWidthCssPx: 2 });
    expect(r.policy).toBe('denseThin');
    expect(r.effectiveLineWidthCssPx).toBe(DENSE_LINE_MIN_WIDTH_CSS);
  });

  it('mid-blend width is between min and nominal', () => {
    // t = (600k - 200k) / 800k = 0.5 → width = 2*0.5 + 1*0.5 = 1.5
    const r = resolveLineDrawPolicy({ pointCount: 600_000, lineWidthCssPx: 2 });
    expect(r.policy).toBe('denseThin');
    expect(r.effectiveLineWidthCssPx).toBeGreaterThan(DENSE_LINE_MIN_WIDTH_CSS);
    expect(r.effectiveLineWidthCssPx).toBeLessThan(2);
    expect(r.effectiveLineWidthCssPx).toBeCloseTo(1.5, 5);
  });

  it('false-positive miss: just under threshold stays standard', () => {
    const r = resolveLineDrawPolicy({
      pointCount: DENSE_LINE_POINT_THRESHOLD - 1,
      lineWidthCssPx: 2,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveLineWidthCssPx).toBe(2);
  });

  it('defaults invalid width to 2 then may thin', () => {
    const r = resolveLineDrawPolicy({ pointCount: 10, lineWidthCssPx: Number.NaN });
    expect(r.effectiveLineWidthCssPx).toBe(2);
  });

  it('does not thicken hairline width 0.5 at 1M points', () => {
    const r = resolveLineDrawPolicy({ pointCount: 1_000_000, lineWidthCssPx: 0.5 });
    expect(r.policy).toBe('denseThin');
    expect(r.effectiveLineWidthCssPx).toBe(0.5);
    expect(r.effectiveLineWidthCssPx).toBeLessThan(DENSE_LINE_MIN_WIDTH_CSS);
  });

  it('does not thicken hairline mid-blend either', () => {
    // t = 0.5; floor = min(0.5, 1) = 0.5 → effective stays 0.5
    const r = resolveLineDrawPolicy({ pointCount: 600_000, lineWidthCssPx: 0.5 });
    expect(r.effectiveLineWidthCssPx).toBe(0.5);
  });
});
