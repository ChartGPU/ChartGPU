import { describe, it, expect } from 'vitest';
import {
  classifyEqualNYOnlyRewrite,
  indexSortedXFingerprint,
  isEqualNSortedXYOnlyRewrite,
  isIndexSortedX,
  isYOnlyRewriteAgainstStaging,
  isYOnlyRewriteAgainstXStaging,
  packYOnlyChannel,
  packYOnlyInto,
  remapIndexSortedSampleY,
} from '../seriesRewriteDetect';
import type { DataPoint } from '../../config/types';

describe('seriesRewriteDetect', () => {
  describe('isIndexSortedX', () => {
    it('accepts x = i for sorted point series (group 4 shape)', () => {
      const data: DataPoint[] = [
        [0, 1.2],
        [1, 3.4],
        [2, 0.5],
        [3, 9],
      ];
      expect(isIndexSortedX(data)).toBe(true);
    });

    it('rejects Brownian scatter where x drifts (group 2 shape)', () => {
      const data: DataPoint[] = [
        [0.1, 1],
        [1.2, 2],
        [1.9, 3],
        [3.4, 4],
      ];
      expect(isIndexSortedX(data)).toBe(false);
    });

    it('rejects empty series', () => {
      expect(isIndexSortedX([])).toBe(false);
    });

    it('rejects single point with non-zero x', () => {
      expect(isIndexSortedX([[5, 1]])).toBe(false);
    });

    it('accepts single point at x=0', () => {
      expect(isIndexSortedX([[0, 42]])).toBe(true);
    });

    it('full-scans mid-range corruption (no large-N probe false positive)', () => {
      // N > endpoints/mid sample set; corruption at index 1 must fail full scan.
      const data: DataPoint[] = Array.from({ length: 20 }, (_, i) => [i, i] as DataPoint);
      data[1] = [1.5, 1];
      expect(isIndexSortedX(data)).toBe(false);
    });

    it('accepts large-N index-sorted series (full O(n) verify)', () => {
      const n = 1000;
      const data: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i * 0.1] as DataPoint);
      expect(isIndexSortedX(data)).toBe(true);
    });

    it('rejects large-N series with interior x corruption', () => {
      const n = 1000;
      const data: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i * 0.1] as DataPoint);
      data[777] = [777.5, 1];
      expect(isIndexSortedX(data)).toBe(false);
    });
  });

  describe('classifyEqualNYOnlyRewrite', () => {
    it('returns indexSorted for group-4 x=i equal-N y change', () => {
      const prev: DataPoint[] = [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      const next: DataPoint[] = [
        [0, 10],
        [1, 20],
        [2, 30],
      ];
      expect(classifyEqualNYOnlyRewrite(prev, next)).toBe('indexSorted');
    });

    it('sticky prevIndexSortedProven + matching fingerprint skips full re-scan', () => {
      const n = 200;
      // Equal-N y-only with true x=i on both sides: sticky + fingerprint → indexSorted.
      const prev: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
      const next: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 1] as DataPoint);
      expect(classifyEqualNYOnlyRewrite(prev, next)).toBe('indexSorted'); // cold full proof
      expect(
        classifyEqualNYOnlyRewrite(prev, next, {
          prevIndexSortedProven: true,
          prevIndexSortedFingerprint: indexSortedXFingerprint(prev),
        })
      ).toBe('indexSorted');
    });

    it('sticky rejects interior x mutation even when quartile probes still look index-sorted (issue 1.6)', () => {
      const n = 200;
      const prev: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i] as DataPoint);
      const next: DataPoint[] = Array.from({ length: n }, (_, i) => [i, i + 1] as DataPoint);
      next[77] = [77.5, 1]; // interior corruption between quartile probes
      expect(classifyEqualNYOnlyRewrite(prev, next)).toBe(false); // cold: full proof fails
      // Sticky + fingerprint mismatch → fall through to cold full scan → not indexSorted.
      expect(
        classifyEqualNYOnlyRewrite(prev, next, {
          prevIndexSortedProven: true,
          prevIndexSortedFingerprint: indexSortedXFingerprint(prev),
        })
      ).toBe(false);
    });

    it('sticky still rejects when sample probes fail (Brownian)', () => {
      const prev: DataPoint[] = Array.from({ length: 20 }, (_, i) => [i, i] as DataPoint);
      const next: DataPoint[] = Array.from({ length: 20 }, (_, i) => [i * 0.1, i] as DataPoint);
      expect(classifyEqualNYOnlyRewrite(prev, next, { prevIndexSortedProven: true })).toBe(false);
    });

    it('returns equalX for stable x that is not x=i', () => {
      const prev: DataPoint[] = [
        [10, 1],
        [20, 2],
        [30, 3],
      ];
      const next: DataPoint[] = [
        [10, 9],
        [20, 8],
        [30, 7],
      ];
      expect(classifyEqualNYOnlyRewrite(prev, next)).toBe('equalX');
    });

    it('returns false for Brownian xy change', () => {
      const prev: DataPoint[] = [
        [0.1, 1],
        [1.2, 2],
        [1.9, 3],
      ];
      const next: DataPoint[] = [
        [0.2, 1.1],
        [1.3, 2.1],
        [2.0, 3.1],
      ];
      expect(classifyEqualNYOnlyRewrite(prev, next)).toBe(false);
    });

    it('returns false for unsorted Brownian line (group 3 shape) — no y-only / indexSorted sticky', () => {
      // Group 3: non-monotonic x, both channels step every frame (fixed deltas).
      const n = 64;
      const prev: DataPoint[] = Array.from({ length: n }, (_, i) => [Math.sin(i) * 10 + i * 0.01, i] as DataPoint);
      const next: DataPoint[] = Array.from(
        { length: n },
        (_, i) => [Math.sin(i) * 10 + i * 0.01 + 0.25, i + 0.1] as DataPoint
      );
      expect(classifyEqualNYOnlyRewrite(prev, next)).toBe(false);
      expect(classifyEqualNYOnlyRewrite(prev, next, { prevIndexSortedProven: true })).toBe(false);
    });

    it('returns false on length change', () => {
      const prev: DataPoint[] = [
        [0, 1],
        [1, 2],
      ];
      const next: DataPoint[] = [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      expect(classifyEqualNYOnlyRewrite(prev, next)).toBe(false);
    });

    it('returns false on empty / missing prev', () => {
      expect(classifyEqualNYOnlyRewrite([], [])).toBe(false);
      expect(classifyEqualNYOnlyRewrite(null, [[0, 1]])).toBe(false);
      expect(classifyEqualNYOnlyRewrite(undefined, [[0, 1]])).toBe(false);
    });
  });

  describe('isEqualNSortedXYOnlyRewrite', () => {
    it('hits on y-only index-sorted equal-N (group 4)', () => {
      const prev: DataPoint[] = [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      const next: DataPoint[] = [
        [0, 10],
        [1, 20],
        [2, 30],
      ];
      expect(isEqualNSortedXYOnlyRewrite(prev, next)).toBe(true);
    });

    it('misses when any x changes (Brownian group 2)', () => {
      const prev: DataPoint[] = [
        [0.1, 1],
        [1.2, 2],
        [1.9, 3],
      ];
      const next: DataPoint[] = [
        [0.2, 1.1],
        [1.3, 2.1],
        [2.0, 3.1],
      ];
      expect(isEqualNSortedXYOnlyRewrite(prev, next)).toBe(false);
    });

    it('misses on length change', () => {
      const prev: DataPoint[] = [
        [0, 1],
        [1, 2],
      ];
      const next: DataPoint[] = [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      expect(isEqualNSortedXYOnlyRewrite(prev, next)).toBe(false);
    });

    it('misses on empty', () => {
      expect(isEqualNSortedXYOnlyRewrite([], [])).toBe(false);
      expect(isEqualNSortedXYOnlyRewrite(null, [[0, 1]])).toBe(false);
      expect(isEqualNSortedXYOnlyRewrite(undefined, [[0, 1]])).toBe(false);
    });

    it('hits when x is stable but not x=i', () => {
      const prev: DataPoint[] = [
        [10, 1],
        [20, 2],
        [30, 3],
      ];
      const next: DataPoint[] = [
        [10, 9],
        [20, 8],
        [30, 7],
      ];
      expect(isEqualNSortedXYOnlyRewrite(prev, next)).toBe(true);
    });
  });

  describe('isYOnlyRewriteAgainstStaging', () => {
    it('detects y-only change against packed staging', () => {
      const staging = new Float32Array([0, 1, 1, 2, 2, 3]);
      const next: DataPoint[] = [
        [0, 10],
        [1, 20],
        [2, 30],
      ];
      expect(isYOnlyRewriteAgainstStaging(next, staging, 3, 0)).toBe(true);
    });

    it('rejects when any x changes (Brownian scatter)', () => {
      const staging = new Float32Array([0, 1, 1, 2, 2, 3]);
      const next: DataPoint[] = [
        [0.5, 10],
        [1, 20],
        [2, 30],
      ];
      expect(isYOnlyRewriteAgainstStaging(next, staging, 3, 0)).toBe(false);
    });

    it('rejects length mismatch', () => {
      const staging = new Float32Array([0, 1, 1, 2]);
      const next: DataPoint[] = [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      expect(isYOnlyRewriteAgainstStaging(next, staging, 2, 0)).toBe(false);
    });

    it('respects xOffset on staging', () => {
      const xOffset = 1000;
      const staging = new Float32Array([0, 1, 1, 2]); // packed as x - xOffset
      const next: DataPoint[] = [
        [1000, 9],
        [1001, 8],
      ];
      expect(isYOnlyRewriteAgainstStaging(next, staging, 2, xOffset)).toBe(true);
    });
  });

  describe('isYOnlyRewriteAgainstXStaging', () => {
    it('detects y-only against dual-buffer x channel', () => {
      const xs = new Float32Array([0, 1, 2]);
      const next: DataPoint[] = [
        [0, 9],
        [1, 8],
        [2, 7],
      ];
      expect(isYOnlyRewriteAgainstXStaging(next, xs, 3)).toBe(true);
    });

    it('rejects Brownian x drift', () => {
      const xs = new Float32Array([0, 1, 2]);
      const next: DataPoint[] = [
        [0.1, 9],
        [1, 8],
        [2, 7],
      ];
      expect(isYOnlyRewriteAgainstXStaging(next, xs, 3)).toBe(false);
    });

    it('rejects length mismatch', () => {
      const xs = new Float32Array([0, 1]);
      const next: DataPoint[] = [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      expect(isYOnlyRewriteAgainstXStaging(next, xs, 2)).toBe(false);
    });

    it('rejects empty', () => {
      expect(isYOnlyRewriteAgainstXStaging([], new Float32Array(0), 0)).toBe(false);
    });

    it('rejects when xStaging is shorter than n', () => {
      const xs = new Float32Array([0, 1]);
      const next: DataPoint[] = [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      expect(isYOnlyRewriteAgainstXStaging(next, xs, 3)).toBe(false);
    });
  });

  describe('packYOnlyInto', () => {
    it('updates only y floats and reports change', () => {
      const out = new Float32Array([0, 1, 1, 2, 2, 3]);
      const changed = packYOnlyInto(
        out,
        [
          [0, 10],
          [1, 20],
          [2, 30],
        ],
        3
      );
      expect(changed).toBe(true);
      expect(Array.from(out)).toEqual([0, 10, 1, 20, 2, 30]);
    });

    it('returns false when every y is identical', () => {
      const out = new Float32Array([0, 1, 1, 2, 2, 3]);
      const changed = packYOnlyInto(
        out,
        [
          [0, 1],
          [1, 2],
          [2, 3],
        ],
        3
      );
      expect(changed).toBe(false);
    });
  });

  describe('packYOnlyChannel', () => {
    it('updates dense y channel only', () => {
      const ys = new Float32Array([1, 2, 3]);
      const changed = packYOnlyChannel(
        ys,
        [
          [0, 10],
          [1, 20],
          [2, 30],
        ],
        3
      );
      expect(changed).toBe(true);
      expect(Array.from(ys)).toEqual([10, 20, 30]);
    });

    it('returns false when y unchanged', () => {
      const ys = new Float32Array([1, 2, 3]);
      expect(
        packYOnlyChannel(
          ys,
          [
            [0, 1],
            [1, 2],
            [2, 3],
          ],
          3
        )
      ).toBe(false);
    });

    it('returns null when any y is non-finite', () => {
      const ys = new Float32Array([1, 2, 3]);
      expect(
        packYOnlyChannel(
          ys,
          [
            [0, 1],
            [1, Number.NaN],
            [2, 3],
          ],
          3
        )
      ).toBeNull();
    });
  });

  describe('remapIndexSortedSampleY', () => {
    it('rebinds y at retained sample x indices in O(k)', () => {
      const prevSampled: DataPoint[] = [
        [0, 1],
        [2, 3],
        [4, 5],
      ];
      const nextRaw: DataPoint[] = [
        [0, 10],
        [1, 11],
        [2, 12],
        [3, 13],
        [4, 14],
      ];
      const remapped = remapIndexSortedSampleY(prevSampled, nextRaw);
      expect(remapped).toEqual([
        [0, 10],
        [2, 12],
        [4, 14],
      ]);
    });

    it('returns null when sample x is out of range', () => {
      const prevSampled: DataPoint[] = [[9, 1]];
      const nextRaw: DataPoint[] = [
        [0, 1],
        [1, 2],
      ];
      expect(remapIndexSortedSampleY(prevSampled, nextRaw)).toBeNull();
    });

    it('returns null for empty prevSampled or nextRaw', () => {
      expect(remapIndexSortedSampleY([], [[0, 1]])).toBeNull();
      expect(remapIndexSortedSampleY([[0, 1]], [])).toBeNull();
    });

    it('returns null when sample x is NaN', () => {
      const prevSampled: DataPoint[] = [[Number.NaN, 1]];
      const nextRaw: DataPoint[] = [
        [0, 1],
        [1, 2],
      ];
      expect(remapIndexSortedSampleY(prevSampled, nextRaw)).toBeNull();
    });
  });
});
