/**
 * Visible Slice Computation Utilities
 *
 * Provides efficient data slicing for zoom operations using binary search
 * when data is monotonic, with fallback to linear filtering.
 *
 * Key features:
 * - Binary search slicing for O(log n) performance on sorted data
 * - WeakMap caching of monotonicity checks to avoid O(n) scans
 * - Separate implementations for cartesian (x-based) and OHLC (timestamp-based) data
 * - Support for DataPoint[], XYArraysData, InterleavedXYData, plus internal
 *   RingXYColumns / StagingRingView (materialized chronologically when sliced)
 */

import type {
  CartesianSeriesData,
  DataPoint,
  OHLCDataPoint,
  OHLCDataPointTuple,
  OHLCDataPointObject,
  XYArraysData,
  InterleavedXYData,
} from '../../../config/types';
import {
  getPointCount,
  getX,
  getY,
  isRingXYColumns,
  isStagingRingView,
  type CoordinatorCartesianData,
  type RingXYColumns,
  type StagingRingView,
} from '../../../data/cartesianData';
import { clampInt } from '../utils/canvasUtils';

// Type guards for OHLC data
export function isTupleOHLCDataPoint(p: OHLCDataPoint): p is OHLCDataPointTuple {
  return Array.isArray(p);
}

/**
 * Cache monotonicity for array / XY / interleaved identities that may **grow
 * in place** (owned MutableXYColumns under a stable object ref).
 * Storing only `boolean` was wrong for streaming: first hover after multi‑M
 * growth forced a full O(n) rescan every time the identity was new, and even
 * with a boolean cache a later grow never re-verified the tail cheaply.
 */
type ArrayMonoCacheEntry = {
  mono: boolean;
  count: number;
  lastX: number;
  /**
   * When false, a progressive full-scan is in progress for n ≫ soft cap.
   * mono=true is only returned when proven (full scan completed under/over soft cap).
   * Never treat unproven partial progress as mono for binary-search consumers (M2).
   */
  proven: boolean;
  /** Next chronological index to full-scan when !proven. */
  scanNext: number;
};
const monotonicXCache = new WeakMap<object, ArrayMonoCacheEntry>();
const monotonicTimestampCache = new WeakMap<ReadonlyArray<OHLCDataPoint>, boolean>();

/** Cap one-shot / progressive chunk size so multi‑M first visits do not freeze the tab. */
const MONO_FULL_SCAN_SOFT_CAP = 250_000;

/**
 * Strided sample may only **reject** mono (never prove it). Catches unsorted multi-M
 * quickly without trusting sparse samples as mono=true.
 */
function stridedMonoRejects(data: CoordinatorCartesianData, n: number): boolean {
  let prevX = Number.NEGATIVE_INFINITY;
  const stride = Math.max(1, Math.floor(n / 2048));
  for (let i = 0; i < n; i += stride) {
    const x = getX(data, i);
    if (!Number.isFinite(x) || x < prevX) return true;
    prevX = x;
  }
  if (n > 0) {
    const lastX = getX(data, n - 1);
    if (!Number.isFinite(lastX) || lastX < prevX) return true;
  }
  return false;
}

/**
 * Generation-aware mono state for mutable ring / staging storage.
 * Identity alone is unsafe (content mutates in place); generation is
 * (start, count, capacity, xOffset, staging buffer identity, contentEpoch).
 *
 * `contentEpoch` is bumped by writers ({@link appendIntoRingXY},
 * {@link createStagingRingView}) so strict full-buffer rewrite under unchanged
 * layout fields cannot leave stale mono=true.
 *
 * Incremental path: pure append and partial FIFO drop+append of mono data only
 * verify newly written chronological points — O(append) not O(n). Full replace
 * (drop ≥ previous count / content rewrite under same layout) full-scans.
 */
type MutableMonoCacheEntry = {
  mono: boolean;
  start: number;
  count: number;
  capacity: number;
  xOffset: number;
  contentEpoch: number;
  /** Ring full-clear generation; staging always 0. */
  rewriteGen: number;
  /** Staging buffer identity; null for RingXYColumns. */
  staging: Float32Array | null;
  /** Last chronological x when mono (or −∞ when empty). */
  lastX: number;
  /** Progressive multi-M full scan proven (see ArrayMonoCacheEntry). */
  proven: boolean;
  scanNext: number;
};

const mutableMonoCache = new WeakMap<object, MutableMonoCacheEntry>();

function fullScanMonotonicX(data: CoordinatorCartesianData): { mono: boolean; lastX: number } {
  let prevX = Number.NEGATIVE_INFINITY;
  const n = getPointCount(data);
  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    if (!Number.isFinite(x) || x < prevX) {
      return { mono: false, lastX: prevX };
    }
    prevX = x;
  }
  return { mono: true, lastX: prevX };
}

/**
 * Verify chronological indices [from, to) stay non-decreasing vs `prevX`.
 * Returns updated lastX on success, or null on violation.
 */
function verifyMonoRange(data: CoordinatorCartesianData, from: number, to: number, prevX: number): number | null {
  let last = prevX;
  for (let i = from; i < to; i++) {
    const x = getX(data, i);
    if (!Number.isFinite(x) || x < last) return null;
    last = x;
  }
  return last;
}

function readContentEpoch(data: RingXYColumns | StagingRingView): number {
  const epoch = data.contentEpoch;
  return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch | 0 : 0;
}

function readRewriteGen(data: RingXYColumns | StagingRingView): number {
  if (isStagingRingView(data)) return 0;
  const g = (data as RingXYColumns).rewriteGen;
  return typeof g === 'number' && Number.isFinite(g) ? g | 0 : 0;
}

function isMonotonicMutableRingOrStaging(data: RingXYColumns | StagingRingView): boolean {
  const start = data.start;
  const count = data.count;
  const capacity = data.capacity;
  const xOffset = isStagingRingView(data) ? data.xOffset : 0;
  const staging = isStagingRingView(data) ? data.staging : null;
  const contentEpoch = readContentEpoch(data);
  const rewriteGen = readRewriteGen(data);

  const cached = mutableMonoCache.get(data as object);

  // Same generation (layout + contentEpoch + rewriteGen) + proven → reuse.
  if (
    cached &&
    cached.proven &&
    cached.start === start &&
    cached.count === count &&
    cached.capacity === capacity &&
    cached.xOffset === xOffset &&
    cached.staging === staging &&
    cached.contentEpoch === contentEpoch &&
    cached.rewriteGen === rewriteGen
  ) {
    return cached.mono;
  }

  const store = (
    mono: boolean,
    lastX: number,
    opts?: { proven?: boolean; scanNext?: number }
  ): boolean => {
    const proven = opts?.proven ?? true;
    mutableMonoCache.set(data as object, {
      mono,
      start,
      count,
      capacity,
      xOffset,
      contentEpoch,
      rewriteGen,
      staging,
      lastX,
      proven,
      scanNext: opts?.scanNext ?? (proven ? count : 0),
    });
    return proven ? mono : false;
  };

  /**
   * Multi-M first visit / full replace: strided sample may only reject; otherwise
   * progressive full-scan in soft-cap chunks until proven (M2).
   */
  const maybeSoftOrProgressiveMono = (): boolean => {
    if (count <= MONO_FULL_SCAN_SOFT_CAP) {
      const scanned = fullScanMonotonicX(data);
      return store(scanned.mono, scanned.lastX, { proven: true, scanNext: count });
    }
    // Same-gen progressive continuation.
    const continuing =
      cached &&
      !cached.proven &&
      cached.start === start &&
      cached.count === count &&
      cached.capacity === capacity &&
      cached.xOffset === xOffset &&
      cached.staging === staging &&
      cached.contentEpoch === contentEpoch &&
      cached.rewriteGen === rewriteGen;

    if (!continuing) {
      // Fast reject unsorted multi-M (never prove mono from stride alone).
      if (stridedMonoRejects(data, count)) {
        return store(false, Number.NEGATIVE_INFINITY, { proven: true, scanNext: count });
      }
    }

    let scanFrom = continuing ? cached!.scanNext : 0;
    let prevX = continuing ? cached!.lastX : Number.NEGATIVE_INFINITY;
    const scanEnd = Math.min(count, scanFrom + MONO_FULL_SCAN_SOFT_CAP);
    for (let i = scanFrom; i < scanEnd; i++) {
      const x = getX(data, i);
      if (!Number.isFinite(x) || x < prevX) {
        return store(false, prevX, { proven: true, scanNext: count });
      }
      prevX = x;
    }
    if (scanEnd >= count) {
      return store(true, prevX, { proven: true, scanNext: count });
    }
    // Not yet proven — return false for this call; next poll continues.
    return store(true, prevX, { proven: false, scanNext: scanEnd });
  };

  // Full-clear rewrite: retained prefix is invalid — soft/full scan.
  if (cached && cached.rewriteGen !== rewriteGen) {
    return maybeSoftOrProgressiveMono();
  }

  // Incremental pure append: start unchanged, count grew, prior **proven** mono.
  // contentEpoch may advance by >1 if mono was not polled between appends.
  if (
    cached &&
    cached.proven &&
    cached.mono &&
    cached.capacity === capacity &&
    cached.xOffset === xOffset &&
    cached.staging === staging &&
    cached.start === start &&
    count > cached.count &&
    contentEpoch > cached.contentEpoch
  ) {
    const last = verifyMonoRange(data, cached.count, count, cached.lastX);
    if (last == null) return store(false, cached.lastX, { proven: true });
    return store(true, last, { proven: true });
  }

  // Incremental FIFO at capacity: start advanced by total drops since last
  // check (one or more appends). Verify only the newly written chronological
  // tail — O(dropped), not O(capacity). Device auto-window hover depends on this.
  if (
    cached &&
    cached.proven &&
    cached.mono &&
    cached.capacity === capacity &&
    capacity > 0 &&
    cached.xOffset === xOffset &&
    cached.staging === staging &&
    count === cached.count &&
    count === capacity &&
    start !== cached.start &&
    contentEpoch > cached.contentEpoch &&
    rewriteGen === cached.rewriteGen
  ) {
    const dropped = (start - cached.start + capacity) % capacity;
    if (dropped > 0 && dropped < count) {
      const retainedLastIdx = count - dropped - 1;
      const prevX = getX(data, retainedLastIdx);
      if (!Number.isFinite(prevX)) return store(false, cached.lastX, { proven: true });
      const last = verifyMonoRange(data, count - dropped, count, prevX);
      if (last == null) return store(false, prevX, { proven: true });
      return store(true, last, { proven: true });
    }
  }

  // Unrecognized transition, first visit, progressive continue, or full replace.
  return maybeSoftOrProgressiveMono();
}

/**
 * Checks if cartesian data is monotonic non-decreasing by X coordinate with all finite values.
 *
 * **Array / XY / interleaved** (including coordinator-owned MutableXYColumns that
 * grow under a stable identity): WeakMap entry `{ mono, count, lastX }`. Pure
 * mono growth only re-checks the new tail (O(append)) — critical for multi‑M
 * streaming hover so we never re-scan 15M points every hit-test.
 *
 * **Mutable ring / staging:** generation-aware cache (start/count/capacity/
 * xOffset/staging/`contentEpoch`). Pure mono append and partial FIFO drop+append
 * re-verify only new points; strict full replace full-scans.
 *
 * First visit of huge series (n ≫ soft cap): strided sample may only **reject**
 * mono; otherwise progressive full-scan in soft-cap chunks until proven mono.
 * Never return mono=true from optimistic stride alone (M2). Sorted multi-M gains
 * tight binary windows after progressive proof completes (not permanent full-span).
 */
export function isMonotonicNonDecreasingFiniteX(data: CartesianSeriesData): boolean {
  if (isRingXYColumns(data) || isStagingRingView(data)) {
    return isMonotonicMutableRingOrStaging(data);
  }

  const cacheKey = typeof data === 'object' && data !== null ? (data as object) : null;
  const n = getPointCount(data);
  const cart = data as CoordinatorCartesianData;

  const storeArray = (
    mono: boolean,
    lastX: number,
    opts: { proven: boolean; scanNext: number }
  ): boolean => {
    if (cacheKey) {
      monotonicXCache.set(cacheKey, {
        mono,
        count: n,
        lastX,
        proven: opts.proven,
        scanNext: opts.scanNext,
      });
    }
    return opts.proven ? mono : false;
  };

  if (cacheKey) {
    const cached = monotonicXCache.get(cacheKey);
    if (cached) {
      if (cached.count === n && cached.proven) return cached.mono;
      // Pure mono growth after **proven** mono: verify only the new chronological tail.
      if (cached.proven && cached.mono && n > cached.count) {
        const last = verifyMonoRange(cart, cached.count, n, cached.lastX);
        if (last == null) {
          return storeArray(false, cached.lastX, { proven: true, scanNext: n });
        }
        return storeArray(true, last, { proven: true, scanNext: n });
      }
      // Same-n progressive continue handled below; shrink / mono=false growth → rescan.
    }
  }

  // Under soft cap: one-shot full scan (proves mono or not).
  if (n <= MONO_FULL_SCAN_SOFT_CAP) {
    let prevX = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const x = getX(cart, i);
      if (!Number.isFinite(x) || x < prevX) {
        return storeArray(false, prevX, { proven: true, scanNext: n });
      }
      prevX = x;
    }
    return storeArray(true, prevX, { proven: true, scanNext: n });
  }

  // Multi-M: progressive full scan. Stride may only reject.
  const cached = cacheKey ? monotonicXCache.get(cacheKey) : undefined;
  const continuing = !!(cached && cached.count === n && !cached.proven);

  if (!continuing && stridedMonoRejects(cart, n)) {
    return storeArray(false, Number.NEGATIVE_INFINITY, { proven: true, scanNext: n });
  }

  let scanFrom = continuing ? cached!.scanNext : 0;
  let prevX = continuing ? cached!.lastX : Number.NEGATIVE_INFINITY;
  const scanEnd = Math.min(n, scanFrom + MONO_FULL_SCAN_SOFT_CAP);
  for (let i = scanFrom; i < scanEnd; i++) {
    const x = getX(cart, i);
    if (!Number.isFinite(x) || x < prevX) {
      return storeArray(false, prevX, { proven: true, scanNext: n });
    }
    prevX = x;
  }
  if (scanEnd >= n) {
    return storeArray(true, prevX, { proven: true, scanNext: n });
  }
  // Not proven yet — safe full-span consumers until progressive completes.
  return storeArray(true, prevX, { proven: false, scanNext: scanEnd });
}

/**
 * Checks if OHLC data is monotonic non-decreasing by timestamp with all finite values.
 * Results are cached in a WeakMap to avoid repeated O(n) scans.
 */
function isMonotonicNonDecreasingFiniteTimestamp(data: ReadonlyArray<OHLCDataPoint>): boolean {
  const cached = monotonicTimestampCache.get(data);
  if (cached !== undefined) return cached;

  let prevTimestamp = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const p = data[i]!;
    const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
    if (!Number.isFinite(timestamp)) {
      monotonicTimestampCache.set(data, false);
      return false;
    }
    if (timestamp < prevTimestamp) {
      monotonicTimestampCache.set(data, false);
      return false;
    }
    prevTimestamp = timestamp;
  }
  monotonicTimestampCache.set(data, true);
  return true;
}

// Binary search: lower bound (first element >= target) for CartesianSeriesData
function lowerBoundX(data: CartesianSeriesData, xTarget: number): number {
  let lo = 0;
  let hi = getPointCount(data);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = getX(data, mid);
    if (x < xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Binary search: upper bound (first element > target) for CartesianSeriesData
function upperBoundX(data: CartesianSeriesData, xTarget: number): number {
  let lo = 0;
  let hi = getPointCount(data);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = getX(data, mid);
    if (x <= xTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundTimestampTuple(data: ReadonlyArray<OHLCDataPointTuple>, timestampTarget: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid][0];
    if (timestamp < timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundTimestampTuple(data: ReadonlyArray<OHLCDataPointTuple>, timestampTarget: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid][0];
    if (timestamp <= timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundTimestampObject(data: ReadonlyArray<OHLCDataPointObject>, timestampTarget: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid].timestamp;
    if (timestamp < timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundTimestampObject(data: ReadonlyArray<OHLCDataPointObject>, timestampTarget: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const timestamp = data[mid].timestamp;
    if (timestamp <= timestampTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Helper: Check if data is XYArraysData format.
 * Excludes modular ring / staging views (they also expose x/y or object shape but
 * must not be linear-sliced by logical index).
 */
function isXYArraysData(data: CartesianSeriesData): data is XYArraysData {
  if (isRingXYColumns(data) || isStagingRingView(data)) return false;
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    'x' in data &&
    'y' in data &&
    typeof (data as any).x === 'object' &&
    typeof (data as any).y === 'object' &&
    'length' in (data as any).x &&
    'length' in (data as any).y
  );
}

/**
 * Helper: Check if data is InterleavedXYData format (ArrayBufferView).
 */
function isInterleavedXYData(data: CartesianSeriesData): data is InterleavedXYData {
  return typeof data === 'object' && data !== null && !Array.isArray(data) && ArrayBuffer.isView(data);
}

/**
 * Materialize a chronological [start, end) window via getX/getY.
 * Used for modular ring columns and StagingRingView (no Array.prototype.slice).
 * Callers never hold null gap markers (rings/staging are columnar floats only).
 */
function materializeCartesianSlice(data: CoordinatorCartesianData, start: number, end: number): DataPoint[] {
  const out: DataPoint[] = new Array(Math.max(0, end - start));
  for (let i = start, j = 0; i < end; i++, j++) {
    out[j] = [getX(data, i), getY(data, i)];
  }
  return out;
}

/**
 * Helper: Slice CartesianSeriesData to index range [start, end).
 * Returns appropriate view/slice for each format.
 *
 * RingXYColumns / StagingRingView (internal streaming shapes) are materialized
 * to DataPoint[] in chronological order — they are not Array-like and modular
 * storage cannot be linear-subarray'd by logical index.
 */
function sliceCartesianData(data: CartesianSeriesData, start: number, end: number): CartesianSeriesData {
  // Clamp indices
  const n = getPointCount(data);
  const s = Math.max(0, Math.min(start, n));
  const e = Math.max(s, Math.min(end, n));

  if (s === 0 && e === n) return data;
  if (e <= s) {
    // Return empty data in appropriate format
    if (isXYArraysData(data)) {
      return { x: [], y: [], ...(data.size ? { size: [] } : {}) };
    }
    if (isInterleavedXYData(data)) {
      // Return empty view of same type
      if (data instanceof DataView) {
        throw new Error('DataView is not supported for InterleavedXYData');
      }
      const TypedArrayConstructor = (data as any).constructor;
      return new TypedArrayConstructor(0);
    }
    return [];
  }

  // Modular ring / zero-copy staging: chronological materialize (getX/getY).
  if (isRingXYColumns(data) || isStagingRingView(data)) {
    return materializeCartesianSlice(data, s, e);
  }

  // XYArraysData: slice x, y, and optional size arrays
  if (isXYArraysData(data)) {
    const xSliced = Array.isArray(data.x)
      ? data.x.slice(s, e)
      : 'subarray' in data.x
        ? (data.x as any).subarray(s, e)
        : Array.from(data.x).slice(s, e);

    const ySliced = Array.isArray(data.y)
      ? data.y.slice(s, e)
      : 'subarray' in data.y
        ? (data.y as any).subarray(s, e)
        : Array.from(data.y).slice(s, e);

    const result: XYArraysData = { x: xSliced, y: ySliced };

    if (data.size) {
      const sizeSliced = Array.isArray(data.size)
        ? data.size.slice(s, e)
        : 'subarray' in data.size
          ? (data.size as any).subarray(s, e)
          : Array.from(data.size).slice(s, e);
      (result as any).size = sizeSliced;
    }

    return result;
  }

  // InterleavedXYData: return subarray view (start*2, end*2)
  if (isInterleavedXYData(data)) {
    if (data instanceof DataView) {
      throw new Error('DataView is not supported for InterleavedXYData');
    }
    return (data as any).subarray(s * 2, e * 2);
  }

  // ReadonlyArray<DataPoint>: standard slice
  if (Array.isArray(data)) {
    return (data as ReadonlyArray<DataPoint>).slice(s, e);
  }

  // Unknown object form: safe chronological materialize via accessors.
  return materializeCartesianSlice(data as CoordinatorCartesianData, s, e);
}

/**
 * Slices cartesian data to the visible X range [xMin, xMax].
 *
 * Uses binary search (O(log n)) when data is monotonic by X;
 * otherwise falls back to linear filtering (O(n)).
 *
 * @param data - Cartesian data in any supported format
 * @param xMin - Minimum X value (inclusive)
 * @param xMax - Maximum X value (inclusive)
 * @returns Sliced data in the same format as input
 */
export function sliceVisibleRangeByX(data: CartesianSeriesData, xMin: number, xMax: number): CartesianSeriesData {
  const n = getPointCount(data);
  if (n === 0) return data;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return data;

  const canBinarySearch = isMonotonicNonDecreasingFiniteX(data);

  if (canBinarySearch) {
    const lo = lowerBoundX(data, xMin);
    const hi = upperBoundX(data, xMax);

    if (lo <= 0 && hi >= n) return data;
    return sliceCartesianData(data, lo, hi);
  }

  // Safe fallback: linear filter (preserves order).
  // For non-monotonic data, we must return a filtered array.
  // DataPoint[] may contain `null` gap markers (line segmentation). Those make
  // X non-finite so the monotonic path never runs — preserve nulls that sit
  // between the first and last in-range finite points so zoom does not join gaps.
  // Product stance: only explicit `null` is a supported gap marker (matches
  // hasNullGaps / connectNulls docs). Sparse `undefined` holes are skipped, not
  // re-emitted as nulls.
  if (Array.isArray(data)) {
    const arr = data as ReadonlyArray<DataPoint | null>;
    let first = -1;
    let last = -1;
    for (let i = 0; i < n; i++) {
      const p = arr[i];
      if (p === null || p === undefined) continue;
      const x = getX(data, i);
      if (!Number.isFinite(x)) continue;
      if (x >= xMin && x <= xMax) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0) return [];
    const out: Array<DataPoint | null> = [];
    for (let i = first; i <= last; i++) {
      const p = arr[i];
      if (p === null) {
        out.push(null);
        continue;
      }
      if (p === undefined) continue;
      const x = getX(data, i);
      if (!Number.isFinite(x)) continue;
      if (x >= xMin && x <= xMax) {
        out.push([x, getY(data, i)]);
      }
    }
    return out;
  }

  // Non-array formats cannot hold null gap markers.
  const out: DataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    if (!Number.isFinite(x)) continue;
    if (x >= xMin && x <= xMax) {
      const y = getY(data, i);
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Finds the index range of visible points in cartesian data.
 *
 * Returns { start, end } indices suitable for slicing or iteration.
 * Only works correctly when data is monotonic; returns full range otherwise.
 *
 * @param data - Cartesian data in any supported format
 * @param xMin - Minimum X value (inclusive)
 * @param xMax - Maximum X value (inclusive)
 * @returns Index range { start, end } for visible data
 */
export function findVisibleRangeIndicesByX(
  data: CartesianSeriesData,
  xMin: number,
  xMax: number
): { readonly start: number; readonly end: number } {
  const n = getPointCount(data);
  if (n === 0) return { start: 0, end: 0 };
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return { start: 0, end: n };

  const canBinarySearch = isMonotonicNonDecreasingFiniteX(data);
  if (!canBinarySearch) {
    // Data is not monotonic by x; we can't represent the visible set as a contiguous index range
    // Fall back to processing the full series for correctness
    return { start: 0, end: n };
  }

  const start = lowerBoundX(data, xMin);
  const end = upperBoundX(data, xMax);

  const s = clampInt(start, 0, n);
  const e = clampInt(end, 0, n);
  return e <= s ? { start: s, end: s } : { start: s, end: e };
}

/**
 * Slices OHLC/candlestick data to the visible timestamp range [xMin, xMax].
 *
 * Uses binary search (O(log n)) when timestamps are monotonic;
 * otherwise falls back to linear filtering (O(n)).
 *
 * @param data - OHLC data points (tuple or object format)
 * @param xMin - Minimum timestamp (inclusive)
 * @param xMax - Maximum timestamp (inclusive)
 * @returns Sliced data array containing only points within [xMin, xMax]
 */
export function sliceVisibleRangeByOHLC(
  data: ReadonlyArray<OHLCDataPoint>,
  xMin: number,
  xMax: number
): ReadonlyArray<OHLCDataPoint> {
  const n = data.length;
  if (n === 0) return data;
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return data;

  const canBinarySearch = isMonotonicNonDecreasingFiniteTimestamp(data);
  const isTuple = n > 0 && isTupleOHLCDataPoint(data[0]!);

  if (canBinarySearch) {
    const lo = isTuple
      ? lowerBoundTimestampTuple(data as ReadonlyArray<OHLCDataPointTuple>, xMin)
      : lowerBoundTimestampObject(data as ReadonlyArray<OHLCDataPointObject>, xMin);
    const hi = isTuple
      ? upperBoundTimestampTuple(data as ReadonlyArray<OHLCDataPointTuple>, xMax)
      : upperBoundTimestampObject(data as ReadonlyArray<OHLCDataPointObject>, xMax);

    if (lo <= 0 && hi >= n) return data;
    if (hi <= lo) return [];
    return data.slice(lo, hi);
  }

  // Safe fallback: linear filter (preserves order, ignores non-finite timestamp)
  const out: OHLCDataPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = data[i]!;
    const timestamp = isTupleOHLCDataPoint(p) ? p[0] : p.timestamp;
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp >= xMin && timestamp <= xMax) out.push(p);
  }
  return out;
}
