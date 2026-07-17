/**
 * Detect full-series rewrite shapes for setOption fast paths.
 *
 * Used when harnesses regenerate a new data array every frame (e.g. scatter /
 * sorted-Y update stress paths). Detection must not false-positive Brownian scatter (x and y
 * both change) as y-only.
 *
 * @module seriesRewriteDetect
 * @internal
 */

import type { CartesianSeriesData, DataPoint } from '../config/types';
import { getPointCount, getX, getY } from './cartesianData';

const INDEX_X_EPS = 1e-6;

/**
 * True when every finite x equals its index (0..n-1) within a tight epsilon.
 * Matches index-sorted x (`x = i`) without matching Brownian scatter.
 *
 * Always fully verifies all points after a cheap endpoints/mid reject (plan 1.1:
 * no false positives for indexSorted O(k) remap or O(1) axis extents). Empty
 * series returns false.
 *
 * Cost: O(1) sample reject + O(n) full scan when samples pass.
 */
export function isIndexSortedX(data: CartesianSeriesData): boolean {
  const n = getPointCount(data);
  if (n <= 0) return false;

  // Cheap reject: endpoints and midpoint must already look like indices.
  const samples = n === 1 ? [0] : n === 2 ? [0, 1] : [0, (n / 2) | 0, n - 1];
  for (let s = 0; s < samples.length; s++) {
    const i = samples[s]!;
    const x = getX(data, i);
    if (!Number.isFinite(x) || Math.abs(x - i) > INDEX_X_EPS) return false;
  }

  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    if (!Number.isFinite(x) || Math.abs(x - i) > INDEX_X_EPS) return false;
  }
  return true;
}

/** Kind of equal-N y-only rewrite, or `false` when not applicable. */
export type EqualNYOnlyKind = false | 'indexSorted' | 'equalX';

/**
 * Cheap multi-probe check that x looks like index (endpoints + quartiles).
 * Not a full proof — used for reject and sticky continuity only.
 */
export function sampleLooksIndexSortedX(data: CartesianSeriesData): boolean {
  const n = getPointCount(data);
  if (n <= 0) return false;
  const samples = n === 1 ? [0] : n === 2 ? [0, 1] : [0, (n / 4) | 0, (n / 2) | 0, ((3 * n) / 4) | 0, n - 1];
  for (let s = 0; s < samples.length; s++) {
    const i = samples[s]!;
    const x = getX(data, i);
    if (!Number.isFinite(x) || Math.abs(x - i) > INDEX_X_EPS) return false;
  }
  return true;
}

/**
 * Classify equal-length y-only rewrites.
 *
 * - `indexSorted`: both series are `x = i` — safe for O(k)
 *   LTTB sample y-remap via {@link remapIndexSortedSampleY}
 * - `equalX`: every x matches prev but not index-sorted — y-only GPU pack OK;
 *   must not use index-as-x sample remap
 * - `false`: length mismatch, empty, or any x change (group 2 Brownian)
 *
 * Cost:
 * - Cheap sample reject always
 * - Cold path: one full O(n) `isIndexSortedX(next)` when samples look index-sorted
 * - Sticky path (`prevIndexSortedProven`): when a prior resolve fully proved x=i at
 *   the same N and samples still look index-sorted on both sides, skip re-scan.
 *   Sticky is cleared by length change, sample reject, or non-indexSorted classify.
 */
export function classifyEqualNYOnlyRewrite(
  prev: CartesianSeriesData | null | undefined,
  next: CartesianSeriesData,
  options?: Readonly<{ prevIndexSortedProven?: boolean }>
): EqualNYOnlyKind {
  if (prev == null) return false;
  const n = getPointCount(next);
  if (n <= 0 || getPointCount(prev) !== n) return false;

  // Shared sample set for cheap reject (Brownian fails immediately on mid points).
  const samples = n === 1 ? [0] : n === 2 ? [0, 1] : [0, (n / 4) | 0, (n / 2) | 0, ((3 * n) / 4) | 0, n - 1];
  let nextLooksIndex = true;
  let prevLooksIndex = true;
  for (let s = 0; s < samples.length; s++) {
    const i = samples[s]!;
    const nx = getX(next, i);
    const px = getX(prev, i);
    if (!Number.isFinite(nx) || Math.abs(nx - i) > INDEX_X_EPS) nextLooksIndex = false;
    if (!Number.isFinite(px) || Math.abs(px - i) > INDEX_X_EPS) prevLooksIndex = false;
    if (!nextLooksIndex && !prevLooksIndex) break;
  }

  // Group 4 shape: samples look like x=i on both series.
  if (nextLooksIndex && prevLooksIndex) {
    // Sticky: prior resolve fully proved x=i at this N; samples still continuous → trust.
    if (options?.prevIndexSortedProven) {
      return 'indexSorted';
    }
    // Cold: full O(n) proof of next (no probabilistic short-circuit).
    if (isIndexSortedX(next)) {
      return 'indexSorted';
    }
  }

  // General equal-x path (stable x, not necessarily x=i).
  for (let i = 0; i < n; i++) {
    const px = getX(prev, i);
    const nx = getX(next, i);
    if (!Number.isFinite(px) || !Number.isFinite(nx) || px !== nx) return false;
  }
  return 'equalX';
}

/**
 * Equal-length rewrite where every x matches `prev` (or both are `x = i`).
 * Y may differ. Empty / length mismatch / missing prev → false.
 *
 * Single boolean gate for tests; see {@link classifyEqualNYOnlyRewrite} for kind.
 */
export function isEqualNSortedXYOnlyRewrite(
  prev: CartesianSeriesData | null | undefined,
  next: CartesianSeriesData
): boolean {
  return classifyEqualNYOnlyRewrite(prev, next) !== false;
}

/**
 * Compare x channel of `next` against interleaved staging `[x0,y0,x1,y1,...]`
 * packed with the same `xOffset`. Returns true only when lengths match and every
 * finite x equals the prior packed x (y may differ).
 *
 * Used for y-only GPU rewrites without false-positiving Brownian xy updates.
 */
export function isYOnlyRewriteAgainstStaging(
  next: CartesianSeriesData,
  staging: Float32Array,
  pointCount: number,
  xOffset: number
): boolean {
  const n = getPointCount(next);
  if (n !== pointCount || n <= 0) return false;
  if (staging.length < n * 2) return false;

  for (let i = 0; i < n; i++) {
    const x = getX(next, i);
    const prevX = staging[i * 2]! + xOffset;
    // NaN x on either side: treat as not y-only (gap structure may have moved).
    if (!Number.isFinite(x) || !Number.isFinite(prevX)) return false;
    if (x !== prevX) return false;
  }
  return true;
}

/**
 * Compare x of `next` against a packed per-point x staging (const-radius dual
 * buffer). Lengths must match; y is ignored.
 *
 * Cheap multi-probe reject first (group 2 Brownian fails without full O(n) scan),
 * then full verification.
 */
export function isYOnlyRewriteAgainstXStaging(
  next: CartesianSeriesData,
  xStaging: Float32Array,
  pointCount: number
): boolean {
  const n = getPointCount(next);
  if (n !== pointCount || n <= 0) return false;
  if (xStaging.length < n) return false;

  // Cheap reject before full scan (Brownian / drifted x).
  const probes = n === 1 ? [0] : n === 2 ? [0, 1] : [0, (n / 4) | 0, (n / 2) | 0, ((3 * n) / 4) | 0, n - 1];
  for (let s = 0; s < probes.length; s++) {
    const i = probes[s]!;
    const x = getX(next, i);
    const prevX = xStaging[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(prevX) || x !== prevX) return false;
  }

  for (let i = 0; i < n; i++) {
    const x = getX(next, i);
    const prevX = xStaging[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(prevX) || x !== prevX) return false;
  }
  return true;
}

/**
 * Pack only the y channel into an existing interleaved staging buffer, leaving
 * x (and any padding beyond `pointCount`) untouched. `out` must already hold
 * valid x values for `pointCount` points.
 *
 * Returns `true` if any y float actually changed (issue 2.1: skip full FNV when
 * y-only already proved a content change; skip GPU write when y is identical).
 */
export function packYOnlyInto(out: Float32Array, src: CartesianSeriesData, pointCount: number): boolean {
  const n = Math.min(pointCount, getPointCount(src));
  let changed = false;
  for (let i = 0; i < n; i++) {
    const y = getY(src, i);
    const prev = out[i * 2 + 1]!;
    // Treat NaN≠NaN as a change when either side is non-finite.
    if (y !== prev && !(Number.isNaN(y) && Number.isNaN(prev))) {
      changed = true;
    }
    out[i * 2 + 1] = y;
  }
  return changed;
}

/**
 * Pack only y into a dense y staging buffer (dual-buffer scatter const-radius).
 *
 * Returns:
 * - `true` if any y float changed
 * - `false` if every y is identical (skip GPU write)
 * - `null` if any y is non-finite (caller must fall through to full sparse pack)
 */
export function packYOnlyChannel(
  out: Float32Array,
  src: CartesianSeriesData,
  pointCount: number
): boolean | null {
  const n = Math.min(pointCount, getPointCount(src));
  let changed = false;
  for (let i = 0; i < n; i++) {
    const y = getY(src, i);
    if (!Number.isFinite(y)) return null;
    const prev = out[i]!;
    if (y !== prev) {
      changed = true;
    }
    out[i] = y;
  }
  return changed;
}

/**
 * For index-sorted (`x = i`) equal-N y-only rewrites under **LTTB** sampling:
 * rebuild a prior LTTB sample in O(k) by re-reading y at each retained x index.
 * Avoids full O(N) re-sampling every frame when only y changed on index-sorted x.
 *
 * Freezes the prior LTTB index set (approximate hold — newly emerging extrema
 * between retained indices will not appear until a full LTTB resumes on
 * length/x/sampling config change).
 *
 * `prevSampled` x values are treated as raw indices (rounded). Returns null when
 * any index is out of range (caller falls back to full sample).
 */
export function remapIndexSortedSampleY(
  prevSampled: CartesianSeriesData,
  nextRaw: CartesianSeriesData
): DataPoint[] | null {
  const k = getPointCount(prevSampled);
  const n = getPointCount(nextRaw);
  if (k <= 0 || n <= 0) return null;
  const out: DataPoint[] = new Array(k);
  for (let j = 0; j < k; j++) {
    const x = getX(prevSampled, j);
    if (!Number.isFinite(x)) return null;
    const idx = Math.round(x);
    if (idx < 0 || idx >= n) return null;
    out[j] = [x, getY(nextRaw, idx)];
  }
  return out;
}
