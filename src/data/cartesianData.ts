/**
 * Internal cartesian data abstraction for CartesianSeriesData.
 *
 * Provides high-performance, allocation-minimizing primitives to support all three cartesian formats:
 * - ReadonlyArray<DataPoint> (tuple or object)
 * - XYArraysData (separate x/y/size arrays)
 * - InterleavedXYData (typed array view with [x0,y0,x1,y1,...] layout)
 *
 * DO NOT export from public entrypoint (src/index.ts). This is internal-only.
 *
 * @module cartesianData
 * @internal
 */

import type { CartesianSeriesData, DataPoint, XYArraysData, InterleavedXYData } from '../config/types';

/**
 * Bounds type for min/max x and y values.
 */
export type Bounds = Readonly<{
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}>;

/**
 * Type for typed arrays with numeric indexing (excluding DataView and BigInt arrays).
 * BigInt arrays are excluded because coordinates must be numbers, not bigints.
 */
type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/**
 * Fixed-capacity modular ring used by FIFO streaming (`maxPoints`).
 * Chronological index `i` maps to physical `(start + i) % capacity`.
 * Internal-only — not part of the public CartesianSeriesData union, but accepted
 * at runtime by getX/getY/getPointCount so coordinator columns stay O(append).
 */
export type RingXYColumns = {
  readonly __ring: true;
  x: Float64Array;
  y: Float64Array;
  size?: Float64Array;
  start: number;
  count: number;
  capacity: number;
  /**
   * Bumped on every mutating write ({@link appendIntoRingXY}).
   * Generation-aware mono / identity caches must include this so strict full
   * replace (start/count/capacity unchanged) cannot leave stale mono=true.
   */
  contentEpoch: number;
  /**
   * Bumped only on full-clear (drop ≥ count) before rewrite. Mono FIFO
   * incremental must full-scan when this changes; partial multi-append epoch
   * jumps alone are still O(dropped) verifiable.
   */
  rewriteGen: number;
};

/**
 * Zero-copy view over DataStore modular staging (interleaved Float32 x,y with
 * `xOffset` already subtracted). Used for tooltip-off + maxPoints + GPU append
 * fast-path streaming so the coordinator does not dual-pack every append into
 * RingXYColumns.
 *
 * Chronological index `i` maps to physical `(start + i) % capacity` when
 * `capacity > 0`; otherwise staging is linear in `[0, count)`.
 *
 * **Precision contract:** staging stores `Float32(x - xOffset)` (same packing as
 * the GPU buffer). {@link getX} restores domain space as `staging[phys*2] + xOffset`,
 * so restored domain x has Float32 error vs `RingXYColumns` Float64 dual-store.
 * That is intentional for zero-copy / tooltip-off streaming; binary-search visible
 * bounds can differ slightly from the dual-column path on large time axes.
 *
 * **WeakMap identity caveat:** `createStagingRingView` reuses one object while
 * mutating `count`/`start`/`xOffset`/floats in place. Identity-keyed caches
 * (e.g. monotonic-x WeakMaps) must not assume stable content under a stable ref —
 * same class of issue as {@link RingXYColumns}. Never pass a StagingRingView as
 * the data source to `DataStore.setSeries` (setSeries linearizes ringStart /
 * capacity and desyncs this view).
 */
export type StagingRingView = {
  readonly __stagingRing: true;
  /** Interleaved packed floats: staging[phys*2]=x-xOffset, staging[phys*2+1]=y. */
  staging: Float32Array;
  start: number;
  count: number;
  /** Modular capacity in points; `0` means linear layout at the start of staging. */
  capacity: number;
  /** Added back in {@link getX} so domain / binary search use original x. */
  xOffset: number;
  /**
   * Bumped on every {@link createStagingRingView} (reuse or new). Staging floats
   * may be rewritten in place under stable start/count — mono caches must key this.
   */
  contentEpoch: number;
};

/**
 * Coordinator / raw-pipeline cartesian data: public input formats plus internal
 * modular ring columns and zero-copy DataStore staging aliases.
 */
export type CoordinatorCartesianData = CartesianSeriesData | RingXYColumns | StagingRingView;

export function isRingXYColumns(data: unknown): data is RingXYColumns {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as RingXYColumns).__ring === true &&
    typeof (data as RingXYColumns).capacity === 'number'
  );
}

export function isStagingRingView(data: unknown): data is StagingRingView {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as StagingRingView).__stagingRing === true &&
    typeof (data as StagingRingView).count === 'number'
  );
}

/**
 * Creates or updates a staging-backed ring view (mutates `reuse` when provided
 * to avoid per-append object allocation on the high-rate FIFO path).
 *
 * Always bumps {@link StagingRingView.contentEpoch} so generation-aware mono
 * caches re-evaluate after in-place float rewrites under stable layout fields.
 */
export function createStagingRingView(
  staging: Float32Array,
  start: number,
  capacity: number,
  count: number,
  xOffset: number,
  reuse?: StagingRingView | null
): StagingRingView {
  if (reuse && reuse.__stagingRing) {
    reuse.staging = staging;
    reuse.start = start;
    reuse.capacity = capacity;
    reuse.count = count;
    reuse.xOffset = xOffset;
    reuse.contentEpoch = (reuse.contentEpoch | 0) + 1;
    return reuse;
  }
  return {
    __stagingRing: true,
    staging,
    start,
    capacity,
    count,
    xOffset,
    contentEpoch: 1,
  };
}

/**
 * Chronological pack of a {@link StagingRingView} into a private
 * {@link RingXYColumns} (domain x via +xOffset, capacity-preserving).
 * Used when leaving the thin path (tooltip on / coordinator dual-column) so
 * subsequent maxPoints appends keep modular FIFO structure.
 */
export function stagingRingViewToRingXYColumns(view: StagingRingView): RingXYColumns {
  const cap = view.capacity > 0 ? view.capacity : Math.max(1, view.count);
  const ring = createRingXYColumns(cap);
  for (let k = 0; k < view.count; k++) {
    // Inline modular read (getX/getY are defined later in this module).
    const phys = view.capacity > 0 ? (view.start + k) % view.capacity : k;
    ring.x[k] = view.staging[phys * 2]! + view.xOffset;
    ring.y[k] = view.staging[phys * 2 + 1]!;
  }
  ring.start = 0;
  ring.count = view.count;
  // Content was written outside appendIntoRingXY — bump so mono cache keys this pack.
  if (view.count > 0) {
    ring.contentEpoch = (ring.contentEpoch | 0) + 1;
  }
  return ring;
}

/**
 * Type guard for XYArraysData format.
 */
function isXYArraysData(data: CartesianSeriesData): data is XYArraysData {
  // Ring columns / staging views also look object-like; detect them first so we
  // don't treat modular storage as linear XYArraysData (wrong length / indexing).
  if (isRingXYColumns(data)) return false;
  if (isStagingRingView(data)) return false;
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
 * Creates a fixed-capacity ring for FIFO streaming. Physical buffers are sized
 * to `capacity`; logical length starts at 0.
 *
 * When `withSize` is true, allocates a per-point size channel. Prefer this when
 * the seed/source has per-point sizes so linear → ring promotion keeps radii.
 * `stagingRingViewToRingXYColumns` remains size-less (staging is xy only).
 */
export function createRingXYColumns(capacity: number, withSize = false): RingXYColumns {
  const cap = Math.max(1, capacity | 0);
  const ring: RingXYColumns = {
    __ring: true,
    x: new Float64Array(cap),
    y: new Float64Array(cap),
    start: 0,
    count: 0,
    capacity: cap,
    contentEpoch: 0,
    rewriteGen: 0,
  };
  if (withSize) {
    ring.size = new Float64Array(cap);
  }
  return ring;
}

/**
 * Ensures `ring.size` exists (allocates a size channel filled with NaN =
 * "no size"). Used when the first sized point arrives after an unsized promote.
 */
export function ensureRingSizeChannel(ring: RingXYColumns): Float64Array {
  if (ring.size) return ring.size;
  // Fill with NaN so prior unsized slots read as "no size" via getSize.
  const size = new Float64Array(ring.capacity);
  size.fill(Number.NaN);
  ring.size = size;
  return size;
}

/**
 * Appends points into a ring, applying the same drop/keep plan as
 * `planMaxPointsWindow`. Drop first, then write — O(keepNewCount) only.
 * Never rewrites the retained window.
 *
 * When any appended point (or the ring already) has per-point size, writes the
 * size channel (allocating if needed). Sources without size leave size[i] as
 * NaN for new slots when the channel exists (getSize treats NaN as undefined).
 */
export function appendIntoRingXY(
  ring: RingXYColumns,
  src: CartesianSeriesData,
  newSrcOffset: number,
  keepNewCount: number,
  dropPrevCount: number
): void {
  const cap = ring.capacity;
  // Any structural or content mutation bumps epoch so mono caches cannot stick
  // after strict full-buffer rewrite (start/count/capacity may be unchanged).
  if (dropPrevCount > 0 || keepNewCount > 0) {
    ring.contentEpoch = (ring.contentEpoch | 0) + 1;
  }
  if (dropPrevCount > 0) {
    if (dropPrevCount >= ring.count) {
      ring.start = 0;
      ring.count = 0;
      // Full clear: entire buffer content is discarded. rewriteGen forces mono
      // full-scan (partial FIFO multi-append can advance contentEpoch by >1
      // without rewriting the retained prefix).
      ring.rewriteGen = (ring.rewriteGen | 0) + 1;
    } else {
      ring.start = (ring.start + dropPrevCount) % cap;
      ring.count -= dropPrevCount;
    }
  }
  if (keepNewCount <= 0) return;
  // After drop, free space is enough for keepNewCount (plan guarantees
  // count + keepNewCount <= capacity). Write head is the first free slot.
  let write = (ring.start + ring.count) % cap;
  let sizeChannel = ring.size;
  for (let i = 0; i < keepNewCount; i++) {
    const srcIdx = newSrcOffset + i;
    ring.x[write] = getX(src, srcIdx);
    ring.y[write] = getY(src, srcIdx);
    const sz = getSize(src, srcIdx);
    if (sz !== undefined) {
      if (!sizeChannel) sizeChannel = ensureRingSizeChannel(ring);
      sizeChannel[write] = sz;
    } else if (sizeChannel) {
      sizeChannel[write] = Number.NaN;
    }
    write++;
    if (write >= cap) write = 0;
  }
  ring.count = Math.min(cap, ring.count + keepNewCount);
}

/**
 * Type guard for InterleavedXYData format (ArrayBufferView).
 */
function isInterleavedXYData(data: CartesianSeriesData): data is InterleavedXYData {
  return typeof data === 'object' && data !== null && !Array.isArray(data) && ArrayBuffer.isView(data);
}

/**
 * Type guard for tuple DataPoint format.
 */
function isTupleDataPoint(p: DataPoint): p is readonly [number, number, number?] {
  return Array.isArray(p);
}

/**
 * Returns the number of points in the CartesianSeriesData.
 */
export function getPointCount(data: CoordinatorCartesianData): number {
  if (isRingXYColumns(data)) {
    return data.count;
  }
  if (isStagingRingView(data)) {
    return data.count;
  }
  if (isXYArraysData(data)) {
    // Use minimum of x and y array lengths for safety
    return Math.min(data.x.length, data.y.length);
  }

  if (isInterleavedXYData(data)) {
    // DataView is unsupported - throw clear error
    if (data instanceof DataView) {
      throw new Error(
        'DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).'
      );
    }
    // Interpret pointCount as floor(length/2), tolerant of odd length
    // Cast to typed array with numeric indexing after DataView check
    const arr = data as TypedArray;
    return Math.floor(arr.length / 2);
  }

  // ReadonlyArray<DataPoint>
  return data.length;
}

/**
 * Returns the x-coordinate of the point at index i.
 * Returns NaN if the point is undefined, null, or non-object (for DataPoint[] format).
 * This allows callers using `Number.isFinite()` to naturally skip missing points.
 */
export function getX(data: CoordinatorCartesianData, i: number): number {
  if (isRingXYColumns(data)) {
    if (i < 0 || i >= data.count) return NaN;
    return data.x[(data.start + i) % data.capacity]!;
  }
  if (isStagingRingView(data)) {
    if (i < 0 || i >= data.count) return NaN;
    // Domain restore: Float32(x - xOffset) + xOffset (see StagingRingView precision contract).
    const phys = data.capacity > 0 ? (data.start + i) % data.capacity : i;
    return data.staging[phys * 2]! + data.xOffset;
  }
  if (isXYArraysData(data)) {
    return data.x[i]!;
  }

  if (isInterleavedXYData(data)) {
    if (data instanceof DataView) {
      throw new Error(
        'DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).'
      );
    }
    const arr = data as TypedArray;
    return arr[i * 2]!;
  }

  // ReadonlyArray<DataPoint>
  const p = data[i];
  // Guard against undefined/null/non-object entries (sparse arrays, holes)
  if (p === undefined || p === null || typeof p !== 'object') {
    return NaN;
  }
  return isTupleDataPoint(p) ? p[0] : p.x;
}

/**
 * Returns the y-coordinate of the point at index i.
 * Returns NaN if the point is undefined, null, or non-object (for DataPoint[] format).
 * This allows callers using `Number.isFinite()` to naturally skip missing points.
 */
export function getY(data: CoordinatorCartesianData, i: number): number {
  if (isRingXYColumns(data)) {
    if (i < 0 || i >= data.count) return NaN;
    return data.y[(data.start + i) % data.capacity]!;
  }
  if (isStagingRingView(data)) {
    if (i < 0 || i >= data.count) return NaN;
    const phys = data.capacity > 0 ? (data.start + i) % data.capacity : i;
    return data.staging[phys * 2 + 1]!;
  }
  if (isXYArraysData(data)) {
    return data.y[i]!;
  }

  if (isInterleavedXYData(data)) {
    if (data instanceof DataView) {
      throw new Error(
        'DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).'
      );
    }
    const arr = data as TypedArray;
    return arr[i * 2 + 1]!;
  }

  // ReadonlyArray<DataPoint>
  const p = data[i];
  // Guard against undefined/null/non-object entries (sparse arrays, holes)
  if (p === undefined || p === null || typeof p !== 'object') {
    return NaN;
  }
  return isTupleDataPoint(p) ? p[1] : p.y;
}

/**
 * Returns the size value of the point at index i, or undefined if not available.
 * Returns undefined if the point is undefined, null, or non-object (for DataPoint[] format).
 * Note: InterleavedXYData does NOT support interleaved size (use XYArraysData.size if needed).
 */
export function getSize(data: CartesianSeriesData, i: number): number | undefined {
  if (isRingXYColumns(data)) {
    if (!data.size || i < 0 || i >= data.count) return undefined;
    const v = data.size[(data.start + i) % data.capacity];
    // NaN marks "no size" for mixed-size ring appends (Float64Array cannot store undefined).
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }
  if (isStagingRingView(data)) {
    return undefined;
  }
  if (isXYArraysData(data)) {
    return data.size?.[i];
  }

  if (isInterleavedXYData(data)) {
    // Size is not interleaved in InterleavedXYData format
    return undefined;
  }

  // ReadonlyArray<DataPoint>
  const p = data[i];
  // Guard against undefined/null/non-object entries (sparse arrays, holes)
  if (p === undefined || p === null || typeof p !== 'object') {
    return undefined;
  }
  return isTupleDataPoint(p) ? p[2] : p.size;
}

/** Identity cache: axes-only / same-ref frames skip O(n) re-scan. */
const perPointSizeCache = new WeakMap<object, boolean>();

/**
 * True when any point exposes a defined per-point size (matching {@link getSize} semantics).
 *
 * Used to gate const-radius scatter packing and dense Float32 LTTB paths that would
 * otherwise drop the size channel. Scans the full series (including sparse size on
 * later points and tuple `[x,y,size]` forms). Interleaved typed arrays never carry size.
 *
 * Results are cached by data object identity (WeakMap) so axes-only / stable-ref
 * frames are O(1) after the first scan. New array refs (full rewrite harnesses)
 * still pay one O(n) scan per identity.
 */
export function hasAnyPerPointSize(data: CartesianSeriesData): boolean {
  if (data != null && typeof data === 'object') {
    const hit = perPointSizeCache.get(data as object);
    if (hit !== undefined) return hit;
  }

  let result = false;
  if (isRingXYColumns(data)) {
    if (data.size) {
      const n = data.count;
      const cap = data.capacity;
      let phys = data.start;
      for (let i = 0; i < n; i++) {
        const v = data.size[phys];
        if (typeof v === 'number' && Number.isFinite(v)) {
          result = true;
          break;
        }
        phys++;
        if (phys >= cap) phys = 0;
      }
    }
  } else if (isXYArraysData(data)) {
    if (data.size) {
      const n = Math.min(data.x.length, data.y.length, data.size.length);
      for (let i = 0; i < n; i++) {
        if (data.size[i] !== undefined) {
          result = true;
          break;
        }
      }
    }
  } else if (isInterleavedXYData(data)) {
    result = false;
  } else {
    // DataPoint[] — tuples with length>=3 or objects with size
    const arr = data as ReadonlyArray<DataPoint | null | undefined>;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (p === undefined || p === null || typeof p !== 'object') continue;
      if (isTupleDataPoint(p)) {
        if (p.length >= 3 && p[2] !== undefined) {
          result = true;
          break;
        }
      } else if ((p as { size?: number }).size !== undefined) {
        result = true;
        break;
      }
    }
  }

  if (data != null && typeof data === 'object') {
    perPointSizeCache.set(data as object, result);
  }
  return result;
}

/**
 * Packs XY coordinates from CartesianSeriesData into a Float32Array in interleaved layout.
 *
 * Writes `pointCount` points starting at `srcPointOffset` in the source data
 * into `out` starting at `outFloatOffset` (measured in float32 elements, not bytes).
 *
 * Each point writes 2 floats: [x - xOffset, y].
 * Size dimension is NOT packed (use getSize() separately if needed).
 *
 * @param out - Target Float32Array to write into
 * @param outFloatOffset - Starting offset in `out` (in float32 elements)
 * @param src - Source CartesianSeriesData
 * @param srcPointOffset - Starting point index in source
 * @param pointCount - Number of points to pack
 * @param xOffset - Value to subtract from x coordinates (for Float32 precision preservation)
 */
export function packXYInto(
  out: Float32Array,
  outFloatOffset: number,
  src: CartesianSeriesData,
  srcPointOffset: number,
  pointCount: number,
  xOffset: number
): void {
  const availablePoints = getPointCount(src) - srcPointOffset;
  const actualPointCount = Math.min(pointCount, availablePoints);

  if (actualPointCount <= 0) return;

  // Validate output buffer capacity
  const requiredOutLength = outFloatOffset + actualPointCount * 2;
  if (requiredOutLength > out.length) {
    throw new Error(`packXYInto: output buffer too small (need ${requiredOutLength} floats, have ${out.length})`);
  }

  if (isRingXYColumns(src)) {
    const cap = src.capacity;
    let phys = (src.start + srcPointOffset) % cap;
    for (let i = 0; i < actualPointCount; i++) {
      const outIdx = outFloatOffset + i * 2;
      out[outIdx] = src.x[phys]! - xOffset;
      out[outIdx + 1] = src.y[phys]!;
      phys++;
      if (phys >= cap) phys = 0;
    }
    return;
  }

  if (isStagingRingView(src)) {
    // Staging is already packed as (x - src.xOffset, y). Re-apply relative offset.
    const delta = src.xOffset - xOffset;
    const cap = src.capacity;
    let phys = cap > 0 ? (src.start + srcPointOffset) % cap : srcPointOffset;
    for (let i = 0; i < actualPointCount; i++) {
      const outIdx = outFloatOffset + i * 2;
      out[outIdx] = src.staging[phys * 2]! + delta;
      out[outIdx + 1] = src.staging[phys * 2 + 1]!;
      if (cap > 0) {
        phys++;
        if (phys >= cap) phys = 0;
      } else {
        phys++;
      }
    }
    return;
  }

  if (isXYArraysData(src)) {
    // Hoist columns + bounds once. FIFO suite packs 250k×5 Float64 splits/frame.
    const xs = src.x;
    const ys = src.y;
    let o = outFloatOffset;
    let i = srcPointOffset;
    const end = srcPointOffset + actualPointCount;
    // Unroll ×4 for the xOffset===0 path (suite value-axis ECG).
    if (xOffset === 0) {
      const end4 = end - 3;
      for (; i < end4; i += 4, o += 8) {
        out[o] = xs[i] as number;
        out[o + 1] = ys[i] as number;
        out[o + 2] = xs[i + 1] as number;
        out[o + 3] = ys[i + 1] as number;
        out[o + 4] = xs[i + 2] as number;
        out[o + 5] = ys[i + 2] as number;
        out[o + 6] = xs[i + 3] as number;
        out[o + 7] = ys[i + 3] as number;
      }
      for (; i < end; i++, o += 2) {
        out[o] = xs[i] as number;
        out[o + 1] = ys[i] as number;
      }
    } else {
      for (; i < end; i++, o += 2) {
        out[o] = (xs[i] as number) - xOffset;
        out[o + 1] = ys[i] as number;
      }
    }
    return;
  }

  if (isInterleavedXYData(src)) {
    if (src instanceof DataView) {
      throw new Error(
        'DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).'
      );
    }

    const arr = src as TypedArray;

    // Issue 2.4: Float32 interleaved + xOffset 0 → bulk TypedArray.set (no per-element pack).
    if (arr instanceof Float32Array && xOffset === 0 && Number.isFinite(outFloatOffset) && outFloatOffset >= 0) {
      const srcStart = srcPointOffset * 2;
      const srcEnd = srcStart + actualPointCount * 2;
      out.set(arr.subarray(srcStart, srcEnd), outFloatOffset);
      return;
    }

    // Fast path: bulk copy with xOffset adjustment
    for (let i = 0; i < actualPointCount; i++) {
      const srcIdx = (srcPointOffset + i) * 2;
      const outIdx = outFloatOffset + i * 2;
      out[outIdx] = arr[srcIdx]! - xOffset;
      out[outIdx + 1] = arr[srcIdx + 1]!;
    }
    return;
  }

  // ReadonlyArray<DataPoint> path — specialize on first *finite* point shape so
  // group 3 full rewrites (dense [x,y] tuples) avoid per-point Array.isArray.
  // Leading null/undefined must not force the object path (Issue 1 review).
  const arr = src as ReadonlyArray<DataPoint | null | undefined>;
  let useTupleFastPath = false;
  for (let s = 0; s < actualPointCount; s++) {
    const probe = arr[srcPointOffset + s];
    if (probe == null) continue;
    if (typeof probe !== 'object') continue;
    useTupleFastPath = Array.isArray(probe);
    break;
  }

  if (useTupleFastPath) {
    // Fast path when first non-null is a tuple (dense homogeneous [x,y]).
    // Dense homogeneous [x,y] (no nulls): skip per-point Array.isArray + null checks.
    //
    // Dense eligibility (must not miss sparse mid-nulls off a coarse lattice):
    // - First + last must be non-null arrays
    // - Full scan for null / non-array (O(n) once; still cheaper than per-point
    //   dual branch when homogeneous — pure group-3 rows have no nulls)
    // Sparse lattice-only probes were unsafe: a single mid-null off the lattice
    // could enter the unchecked dense pack and throw / corrupt.
    let denseHomogeneous = xOffset === 0 && actualPointCount > 0;
    if (denseHomogeneous) {
      const first = arr[srcPointOffset];
      const last = arr[srcPointOffset + actualPointCount - 1];
      if (first == null || !Array.isArray(first) || last == null || !Array.isArray(last)) {
        denseHomogeneous = false;
      } else {
        for (let s = 1; s < actualPointCount - 1; s++) {
          const p = arr[srcPointOffset + s];
          if (p == null || !Array.isArray(p)) {
            denseHomogeneous = false;
            break;
          }
        }
      }
    }

    if (denseHomogeneous) {
      // Hottest group-3 path: pure [x,y] tuples, value-axis (no packing offset).
      let o = outFloatOffset;
      const end = srcPointOffset + actualPointCount;
      for (let i = srcPointOffset; i < end; i++, o += 2) {
        const p = arr[i] as [number, number];
        out[o] = p[0] as number;
        out[o + 1] = p[1] as number;
      }
      return;
    }

    // Safe tuple path: mid-series nulls / rare object points / non-zero xOffset.
    for (let i = 0; i < actualPointCount; i++) {
      const srcIdx = srcPointOffset + i;
      const outIdx = outFloatOffset + i * 2;
      const p = arr[srcIdx];
      if (p == null || typeof p !== 'object') {
        out[outIdx] = NaN;
        out[outIdx + 1] = NaN;
        continue;
      }
      if (Array.isArray(p)) {
        out[outIdx] = (p[0] as number) - xOffset;
        out[outIdx + 1] = p[1] as number;
      } else {
        out[outIdx] = (p as { x: number }).x - xOffset;
        out[outIdx + 1] = (p as { y: number }).y;
      }
    }
    return;
  }

  // Object DataPoint path (or all-null series). Tuples mid-series still handled
  // via Array.isArray so mixed shapes pack correctly.
  for (let i = 0; i < actualPointCount; i++) {
    const srcIdx = srcPointOffset + i;
    const outIdx = outFloatOffset + i * 2;
    const p = arr[srcIdx];

    if (p === undefined || p === null || typeof p !== 'object') {
      out[outIdx] = NaN;
      out[outIdx + 1] = NaN;
      continue;
    }

    if (Array.isArray(p)) {
      out[outIdx] = (p[0] as number) - xOffset;
      out[outIdx + 1] = p[1] as number;
      continue;
    }

    const x = (p as { x: number }).x;
    const y = (p as { y: number }).y;
    out[outIdx] = x - xOffset;
    out[outIdx + 1] = y;
  }
}

/**
 * Computes xMin/xMax/yMin/yMax bounds from CartesianSeriesData.
 * Skips non-finite x or y values. Returns null if no finite points found.
 * Ensures xMin !== xMax and yMin !== yMax for scale derivation (expands max by +1 if needed).
 *
 * @param data - CartesianSeriesData in any supported format
 * @returns Bounds object or null if no finite points
 */
export function computeRawBoundsFromCartesianData(data: CartesianSeriesData): Bounds | null {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  // Hoist type detection outside loop to avoid per-point type checks
  if (isRingXYColumns(data)) {
    const n = data.count;
    const cap = data.capacity;
    let phys = data.start;
    for (let i = 0; i < n; i++) {
      const x = data.x[phys]!;
      const y = data.y[phys]!;
      phys++;
      if (phys >= cap) phys = 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  } else if (isStagingRingView(data)) {
    const n = data.count;
    const cap = data.capacity;
    const xo = data.xOffset;
    let phys = cap > 0 ? data.start : 0;
    for (let i = 0; i < n; i++) {
      const x = data.staging[phys * 2]! + xo;
      const y = data.staging[phys * 2 + 1]!;
      if (cap > 0) {
        phys++;
        if (phys >= cap) phys = 0;
      } else {
        phys++;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  } else if (isXYArraysData(data)) {
    // Fast path for XYArraysData
    const count = Math.min(data.x.length, data.y.length);
    for (let i = 0; i < count; i++) {
      const x = data.x[i]!;
      const y = data.y[i]!;

      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  } else if (isInterleavedXYData(data)) {
    // Fast path for InterleavedXYData
    if (data instanceof DataView) {
      throw new Error(
        'DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).'
      );
    }

    const arr = data as TypedArray;
    const count = Math.floor(arr.length / 2);

    for (let i = 0; i < count; i++) {
      const x = arr[i * 2]!;
      const y = arr[i * 2 + 1]!;

      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  } else {
    // Array<DataPoint> path: branch once per point on tuple vs object (hot rewrite path).
    const count = data.length;
    for (let i = 0; i < count; i++) {
      const p = data[i];
      if (p === undefined || p === null || typeof p !== 'object') continue;
      let x: number;
      let y: number;
      if (Array.isArray(p)) {
        x = p[0] as number;
        y = p[1] as number;
      } else {
        x = (p as { x: number }).x;
        y = (p as { y: number }).y;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return null;
  }

  // Preserve existing behavior: if min==max, expand max by +1 for usability
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;

  return { xMin, xMax, yMin, yMax };
}

/**
 * X-extent only (skips y). Used when all y-axis domains are explicit so full
 * rawBounds only needs data-driven xMin/xMax (index-sorted / y-axis-fixed shape).
 */
export function computeRawXExtentFromCartesianData(
  data: CartesianSeriesData
): { readonly xMin: number; readonly xMax: number } | null {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;

  if (isRingXYColumns(data)) {
    const n = data.count;
    const cap = data.capacity;
    let phys = data.start;
    for (let i = 0; i < n; i++) {
      const x = data.x[phys]!;
      phys++;
      if (phys >= cap) phys = 0;
      if (!Number.isFinite(x)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  } else if (isStagingRingView(data)) {
    const n = data.count;
    const cap = data.capacity;
    const xo = data.xOffset;
    let phys = cap > 0 ? data.start : 0;
    for (let i = 0; i < n; i++) {
      const x = data.staging[phys * 2]! + xo;
      if (cap > 0) {
        phys++;
        if (phys >= cap) phys = 0;
      } else {
        phys++;
      }
      if (!Number.isFinite(x)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  } else if (isXYArraysData(data)) {
    const count = data.x.length;
    for (let i = 0; i < count; i++) {
      const x = data.x[i]!;
      if (!Number.isFinite(x)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  } else if (isInterleavedXYData(data)) {
    if (data instanceof DataView) {
      throw new Error(
        'DataView is not supported for InterleavedXYData. Use typed arrays (Float32Array, Float64Array, etc.).'
      );
    }
    const arr = data as TypedArray;
    const count = Math.floor(arr.length / 2);
    for (let i = 0; i < count; i++) {
      const x = arr[i * 2]!;
      if (!Number.isFinite(x)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  } else {
    const count = data.length;
    for (let i = 0; i < count; i++) {
      const p = data[i];
      if (p === undefined || p === null || typeof p !== 'object') continue;
      const x = Array.isArray(p) ? (p[0] as number) : (p as { x: number }).x;
      if (!Number.isFinite(x)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return null;
  if (xMin === xMax) xMax = xMin + 1;
  return { xMin, xMax };
}

/**
 * Returns true if a CartesianSeriesData array contains any null entries (gap markers).
 * Only applies to ReadonlyArray<DataPoint | null> format — XYArraysData and
 * InterleavedXYData cannot contain null entries and always return false.
 */
export function hasNullGaps(data: CoordinatorCartesianData): boolean {
  if (isRingXYColumns(data)) return false;
  if (isStagingRingView(data)) return false;
  if (!Array.isArray(data)) return false;
  return data.includes(null);
}

/**
 * Drops the oldest `dropCount` points from mutable x/y (and optional size) columns
 * in place via `copyWithin` — used by FIFO / maxPoints streaming without reallocating
 * the backing arrays when possible.
 */
export function dropPrefixXY(x: number[], y: number[], dropCount: number, size?: (number | undefined)[]): void {
  if (dropCount <= 0) return;
  if (dropCount >= x.length) {
    x.length = 0;
    y.length = 0;
    if (size) size.length = 0;
    return;
  }
  x.copyWithin(0, dropCount);
  y.copyWithin(0, dropCount);
  x.length -= dropCount;
  y.length -= dropCount;
  if (size) {
    size.copyWithin(0, dropCount);
    size.length -= dropCount;
  }
}

/**
 * Removes null entries from a DataPoint array.
 * Used by connectNulls to strip gap markers before GPU upload,
 * so the line/area draws through gaps instead of breaking.
 */
export function filterNullGaps(data: ReadonlyArray<DataPoint | null>): ReadonlyArray<DataPoint> {
  return data.filter((p): p is DataPoint => p !== null);
}

/**
 * Removes gap entries (null or NaN) from any CartesianSeriesData format.
 *
 * Null entries in DataPoint[] arrays are a direct gap marker. NaN x/y values
 * in XYArraysData and InterleavedXYData arise when cartesianDataToMutableColumns
 * converts null DataPoint entries into NaN pairs for the columnar format.
 *
 * Used by connectNulls to strip all gap markers regardless of data format,
 * so the line/area draws through gaps instead of breaking.
 *
 * Returns a DataPointTuple[] with only finite-coordinate points.
 */
export function filterGaps(data: CartesianSeriesData): ReadonlyArray<DataPoint> {
  if (Array.isArray(data)) {
    // ReadonlyArray<DataPoint | null> — filter nulls and NaN entries
    return (data as ReadonlyArray<DataPoint | null>).filter((p): p is DataPoint => {
      if (p === null || p === undefined) return false;
      if (typeof p !== 'object') return false;
      const x = isTupleDataPoint(p) ? p[0] : p.x;
      const y = isTupleDataPoint(p) ? p[1] : p.y;
      return Number.isFinite(x) && Number.isFinite(y);
    });
  }

  // XYArraysData or InterleavedXYData — filter out indices where x or y is NaN
  const count = getPointCount(data);
  const result: DataPoint[] = [];
  for (let i = 0; i < count; i++) {
    const x = getX(data, i);
    const y = getY(data, i);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      result.push([x, y]);
    }
  }
  return result;
}
