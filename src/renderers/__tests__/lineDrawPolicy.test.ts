import { describe, it, expect } from 'vitest';
import {
  resolveLineDrawPolicy,
  DENSE_HAIRLINE_POINT_THRESHOLD,
  DENSE_LINE_MIN_WIDTH_CSS,
  MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET,
} from '../lineDrawPolicy';

describe('resolveLineDrawPolicy', () => {
  it('keeps standard width below threshold (group 3 1k / 10k protection)', () => {
    const r = resolveLineDrawPolicy({ pointCount: 10_000, lineWidthCssPx: 2 });
    expect(r.policy).toBe('standard');
    expect(r.effectiveLineWidthCssPx).toBe(2);
  });

  it('stays standard just under hairline threshold', () => {
    const r = resolveLineDrawPolicy({
      pointCount: DENSE_HAIRLINE_POINT_THRESHOLD - 1,
      lineWidthCssPx: 2,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveLineWidthCssPx).toBe(2);
  });

  it('enters denseHairline at threshold (group 3 @ 50k cliff)', () => {
    const r = resolveLineDrawPolicy({
      pointCount: DENSE_HAIRLINE_POINT_THRESHOLD,
      lineWidthCssPx: 2,
      msaaSampleCount: 4,
    });
    expect(r.policy).toBe('denseHairline');
    expect(r.effectiveLineWidthCssPx).toBe(DENSE_LINE_MIN_WIDTH_CSS);
  });

  it('forceStandard (performance.lod strict) keeps configured width at high N (issue 2.1)', () => {
    const r = resolveLineDrawPolicy({
      pointCount: DENSE_HAIRLINE_POINT_THRESHOLD,
      lineWidthCssPx: 2,
      msaaSampleCount: 4,
      forceStandard: true,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveLineWidthCssPx).toBe(2);
  });

  it('msaaSampleCount 1 never enters denseHairline (multi-chart antialias:false)', () => {
    const r = resolveLineDrawPolicy({
      pointCount: 1_000_000,
      lineWidthCssPx: 2,
      lineSeriesCount: 1000,
      msaaSampleCount: 1,
    });
    expect(r.policy).toBe('standard');
    expect(r.effectiveLineWidthCssPx).toBe(2);
  });

  it('enters denseHairline for group 3 @ 50k', () => {
    const r = resolveLineDrawPolicy({ pointCount: 50_000, lineWidthCssPx: 2 });
    expect(r.policy).toBe('denseHairline');
    expect(r.effectiveLineWidthCssPx).toBe(1);
  });

  it('enters denseHairline at 1M', () => {
    const r = resolveLineDrawPolicy({ pointCount: 1_000_000, lineWidthCssPx: 2 });
    expect(r.policy).toBe('denseHairline');
    expect(r.effectiveLineWidthCssPx).toBe(DENSE_LINE_MIN_WIDTH_CSS);
  });

  it('false-positive miss: 10k stays standard (not hairline)', () => {
    const r = resolveLineDrawPolicy({
      pointCount: 10_000,
      lineWidthCssPx: 2,
    });
    expect(r.policy).not.toBe('denseHairline');
    expect(r.policy).toBe('standard');
  });

  it('defaults invalid width to 2 then may hairline', () => {
    const r = resolveLineDrawPolicy({ pointCount: 10, lineWidthCssPx: Number.NaN });
    expect(r.effectiveLineWidthCssPx).toBe(2);
    expect(r.policy).toBe('standard');
  });

  it('does not thicken hairline width 0.5 at high N', () => {
    const r = resolveLineDrawPolicy({ pointCount: 1_000_000, lineWidthCssPx: 0.5 });
    expect(r.policy).toBe('denseHairline');
    expect(r.effectiveLineWidthCssPx).toBe(0.5);
    expect(r.effectiveLineWidthCssPx).toBeLessThan(DENSE_LINE_MIN_WIDTH_CSS);
  });

  it('never returns denseThin (removed dead policy)', () => {
    for (const n of [1, 10_000, 24_999, 25_000, 50_000, 1_000_000]) {
      const r = resolveLineDrawPolicy({ pointCount: n, lineWidthCssPx: 2 });
      expect(r.policy === 'standard' || r.policy === 'denseHairline').toBe(true);
      expect((r.policy as string) === 'denseThin').toBe(false);
    }
  });

  describe('multi-series segment budget (group 1)', () => {
    it('500×500 stays standard (protect display-refresh band)', () => {
      const r = resolveLineDrawPolicy({
        pointCount: 500,
        lineWidthCssPx: 2,
        lineSeriesCount: 500,
      });
      // 500 * 499 = 249_500 < 500_000
      expect(500 * 499).toBeLessThan(MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET);
      expect(r.policy).toBe('standard');
      expect(r.effectiveLineWidthCssPx).toBe(2);
    });

    it('1000×1000 enters denseHairline (mid cliff)', () => {
      const r = resolveLineDrawPolicy({
        pointCount: 1000,
        lineWidthCssPx: 2,
        lineSeriesCount: 1000,
      });
      // 1000 * 999 = 999_000 >= 500_000
      expect(1000 * 999).toBeGreaterThanOrEqual(MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET);
      expect(r.policy).toBe('denseHairline');
    });

    it('2000×2000 enters denseHairline (hard cliff)', () => {
      const r = resolveLineDrawPolicy({
        pointCount: 2000,
        lineWidthCssPx: 2,
        lineSeriesCount: 2000,
      });
      expect(r.policy).toBe('denseHairline');
    });

    it('single series never uses multi-series budget alone at low N', () => {
      const r = resolveLineDrawPolicy({
        pointCount: 1000,
        lineWidthCssPx: 2,
        lineSeriesCount: 1,
      });
      expect(r.policy).toBe('standard');
    });

    it('false-positive: 200×200 multi-series stays standard', () => {
      const r = resolveLineDrawPolicy({
        pointCount: 200,
        lineWidthCssPx: 2,
        lineSeriesCount: 200,
      });
      expect(r.policy).toBe('standard');
    });

    it('just below segment budget stays standard (500 × 1000 → 499500 segs; under per-series 25k)', () => {
      // Use pointCount < 25k so only multi-series budget applies.
      // segments = 500 * (1000 - 1) = 499500 < 500000
      const r = resolveLineDrawPolicy({
        pointCount: 1000,
        lineWidthCssPx: 2,
        lineSeriesCount: 500,
      });
      expect(500 * (1000 - 1)).toBeLessThan(MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET);
      expect(r.policy).toBe('standard');
    });

    it('just at segment budget enters denseHairline (500 × 1001 → 500000 segs; under per-series 25k)', () => {
      // segments = 500 * (1001 - 1) = 500000; pointCount 1001 << 25k
      const r = resolveLineDrawPolicy({
        pointCount: 1001,
        lineWidthCssPx: 2,
        lineSeriesCount: 500,
      });
      expect(500 * (1001 - 1)).toBe(MULTI_SERIES_HAIRLINE_SEGMENT_BUDGET);
      expect(r.policy).toBe('denseHairline');
    });

    it('omitted lineSeriesCount behaves as single series', () => {
      const r = resolveLineDrawPolicy({
        pointCount: 1000,
        lineWidthCssPx: 2,
      });
      expect(r.policy).toBe('standard');
    });
  });
});
