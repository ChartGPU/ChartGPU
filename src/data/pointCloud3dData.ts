/**
 * Pack and bounds for 3D point cloud series.
 *
 * Storage layout per point (16 bytes, 4 floats):
 *   [x, y, z, value]
 * value is 0 when no value channel; used for colormap.
 *
 * Non-finite XYZ are skipped for all input shapes (no NaN written to GPU).
 * Interleaved Float32Array is zero-copy; Float64Array is converted element-wise.
 */

import type { PointCloud3DArraysData, PointCloud3DData } from '../config/types';
import { emptyAABB, expandAABBPoint, type AABB } from '../core/3d/aabb';
import { normalizeMaxPoints, planMaxPointsWindow } from './maxPointsWindow';

export type PackedPointCloud3D = Readonly<{
  /** Interleaved xyzv Float32Array; capacity may exceed count * 4 (append growth). */
  readonly packed: Float32Array;
  readonly count: number;
  readonly aabb: AABB | null;
  readonly valueMin: number;
  readonly valueMax: number;
  readonly hasValue: boolean;
}>;

/** Minimum point capacity when geometric growth reallocates. */
export const POINT_CLOUD_GROW_MIN_CAPACITY = 16;
/** Growth factor for append reallocation. */
export const POINT_CLOUD_GROW_FACTOR = 1.5;

const isArraysData = (data: PointCloud3DData): data is PointCloud3DArraysData => {
  if (data == null || typeof data !== 'object' || Array.isArray(data) || ArrayBuffer.isView(data)) {
    return false;
  }
  const rec = data as Record<string, unknown>;
  return 'x' in rec && 'y' in rec && 'z' in rec;
};

const isInterleaved = (data: PointCloud3DData): data is ArrayBufferView => ArrayBuffer.isView(data);

const readArrayLike = (a: ArrayLike<number>, i: number): number => {
  const v = a[i];
  return typeof v === 'number' ? v : Number.NaN;
};

const emptyPacked = (): PackedPointCloud3D => ({
  packed: new Float32Array(0),
  count: 0,
  aabb: null,
  valueMin: 0,
  valueMax: 1,
  hasValue: false,
});

/**
 * Convert interleaved typed array to float triples for packing.
 * Float32: use as-is. Float64: convert element-wise. Other views: unsupported.
 */
function interleavedFloats(
  data: ArrayBufferView,
  warn: (msg: string) => void
): { readonly floats: ArrayLike<number>; readonly floatCount: number } | null {
  if (data instanceof DataView) {
    warn('ChartGPU pointCloud3d: DataView interleaved data is not supported.');
    return null;
  }
  if (data instanceof Float32Array) {
    return { floats: data, floatCount: data.length };
  }
  if (data instanceof Float64Array) {
    // Element-wise convert — do not bit-cast f64 as f32
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i]!;
    return { floats: out, floatCount: out.length };
  }
  warn(
    `ChartGPU pointCloud3d: interleaved typed array ${data.constructor?.name ?? 'unknown'} is not supported (use Float32Array or Float64Array).`
  );
  return null;
}

/**
 * Pack point cloud data into GPU-friendly xyzv float32.
 * Length mismatch (arrays): uses min length and may warn.
 * Interleaved: length must be a multiple of 3 (remainder truncated with warn).
 */
export function packPointCloud3D(
  data: PointCloud3DData,
  options?: Readonly<{
    readonly valueOverride?: ArrayLike<number>;
    readonly warn?: (msg: string) => void;
  }>
): PackedPointCloud3D {
  const warn = options?.warn ?? ((msg: string) => console.warn(msg));
  const valueOverride = options?.valueOverride;

  if (data == null) return emptyPacked();

  // Interleaved XYZ
  if (isInterleaved(data)) {
    const conv = interleavedFloats(data, warn);
    if (!conv) return emptyPacked();
    const { floats, floatCount } = conv;
    if (floatCount < 3 || floatCount % 3 !== 0) {
      if (floatCount > 0) {
        warn(`ChartGPU pointCloud3d: interleaved XYZ length (${floatCount}) must be a multiple of 3; truncating.`);
      }
    }
    const maxTriples = Math.floor(floatCount / 3);
    const packed = new Float32Array(maxTriples * 4);
    const bounds = emptyAABB();
    let vMin = Infinity;
    let vMax = -Infinity;
    let hasValue = false;
    let written = 0;
    for (let i = 0; i < maxTriples; i++) {
      const x = Number(floats[i * 3]);
      const y = Number(floats[i * 3 + 1]);
      const z = Number(floats[i * 3 + 2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }
      let val = 0;
      if (valueOverride && i < valueOverride.length) {
        const vv = readArrayLike(valueOverride, i);
        if (Number.isFinite(vv)) {
          val = vv;
          hasValue = true;
          if (val < vMin) vMin = val;
          if (val > vMax) vMax = val;
        }
      }
      const o = written * 4;
      packed[o] = x;
      packed[o + 1] = y;
      packed[o + 2] = z;
      packed[o + 3] = val;
      expandAABBPoint(bounds, x, y, z);
      written++;
    }
    const outPacked = written === maxTriples ? packed : packed.subarray(0, written * 4);
    const aabb: AABB | null =
      written > 0 && Number.isFinite(bounds.min[0])
        ? { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [bounds.max[0], bounds.max[1], bounds.max[2]] }
        : null;
    return {
      packed: outPacked as Float32Array,
      count: written,
      aabb,
      valueMin: hasValue ? vMin : 0,
      valueMax: hasValue ? vMax : 1,
      hasValue,
    };
  }

  // Split arrays
  if (isArraysData(data)) {
    if (data.size != null) {
      warn(
        'ChartGPU pointCloud3d: data.size is reserved and ignored in v1; use pointStyle.size for billboard diameter (CSS px).'
      );
    }
    const nX = data.x.length;
    const nY = data.y.length;
    const nZ = data.z.length;
    const count = Math.min(nX, nY, nZ);
    if (nX !== nY || nY !== nZ) {
      warn(`ChartGPU pointCloud3d: x/y/z length mismatch (${nX},${nY},${nZ}); using min length ${count}.`);
    }
    const values = valueOverride ?? data.value;
    if (values && values.length < count) {
      warn(
        `ChartGPU pointCloud3d: value length (${values.length}) < point count (${count}); trailing values treated as 0.`
      );
    }
    const packed = new Float32Array(count * 4);
    const bounds = emptyAABB();
    let vMin = Infinity;
    let vMax = -Infinity;
    let hasValue = false;
    let written = 0;
    for (let i = 0; i < count; i++) {
      const x = readArrayLike(data.x, i);
      const y = readArrayLike(data.y, i);
      const z = readArrayLike(data.z, i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }
      let val = 0;
      if (values && i < values.length) {
        const vv = readArrayLike(values, i);
        if (Number.isFinite(vv)) {
          val = vv;
          hasValue = true;
          if (val < vMin) vMin = val;
          if (val > vMax) vMax = val;
        }
      }
      const o = written * 4;
      packed[o] = x;
      packed[o + 1] = y;
      packed[o + 2] = z;
      packed[o + 3] = val;
      expandAABBPoint(bounds, x, y, z);
      written++;
    }
    const outPacked = written === count ? packed : packed.subarray(0, written * 4);
    const aabb: AABB | null =
      written > 0 && Number.isFinite(bounds.min[0])
        ? { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [bounds.max[0], bounds.max[1], bounds.max[2]] }
        : null;
    return {
      packed: outPacked as Float32Array,
      count: written,
      aabb,
      valueMin: hasValue ? vMin : 0,
      valueMax: hasValue ? vMax : 1,
      hasValue,
    };
  }

  // Array of tuples / objects / null
  if (Array.isArray(data)) {
    const n = data.length;
    const packed = new Float32Array(n * 4);
    const bounds = emptyAABB();
    let vMin = Infinity;
    let vMax = -Infinity;
    let hasValue = false;
    let written = 0;
    for (let i = 0; i < n; i++) {
      const p = data[i];
      if (p == null) continue;
      let x: number;
      let y: number;
      let z: number;
      if (Array.isArray(p)) {
        x = Number(p[0]);
        y = Number(p[1]);
        z = Number(p[2]);
      } else if (typeof p === 'object') {
        const o = p as { x?: unknown; y?: unknown; z?: unknown };
        x = Number(o.x);
        y = Number(o.y);
        z = Number(o.z);
      } else {
        continue;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      let val = 0;
      if (valueOverride && i < valueOverride.length) {
        const vv = readArrayLike(valueOverride, i);
        if (Number.isFinite(vv)) {
          val = vv;
          hasValue = true;
          if (val < vMin) vMin = val;
          if (val > vMax) vMax = val;
        }
      }
      const o = written * 4;
      packed[o] = x;
      packed[o + 1] = y;
      packed[o + 2] = z;
      packed[o + 3] = val;
      expandAABBPoint(bounds, x, y, z);
      written++;
    }
    const outPacked = written === n ? packed : packed.subarray(0, written * 4);
    const aabb: AABB | null =
      written > 0 && Number.isFinite(bounds.min[0])
        ? { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [bounds.max[0], bounds.max[1], bounds.max[2]] }
        : null;
    return {
      packed: outPacked as Float32Array,
      count: written,
      aabb,
      valueMin: hasValue ? vMin : 0,
      valueMax: hasValue ? vMax : 1,
      hasValue,
    };
  }

  warn('ChartGPU pointCloud3d: unrecognized data format.');
  return emptyPacked();
}

const recomputeExtents = (
  dest: Float32Array,
  count: number,
  fallbackValueMin: number,
  fallbackValueMax: number,
  preferHasValue: boolean
): Pick<PackedPointCloud3D, 'aabb' | 'valueMin' | 'valueMax' | 'hasValue'> => {
  const bounds = emptyAABB();
  let vMin = Infinity;
  let vMax = -Infinity;
  let hasValue = false;
  for (let i = 0; i < count; i++) {
    const x = dest[i * 4]!;
    const y = dest[i * 4 + 1]!;
    const z = dest[i * 4 + 2]!;
    const v = dest[i * 4 + 3]!;
    expandAABBPoint(bounds, x, y, z);
    if (Number.isFinite(v)) {
      if (v !== 0 || preferHasValue) {
        hasValue = hasValue || preferHasValue || v !== 0;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
      }
    }
  }
  const aabb: AABB | null =
    count > 0 && Number.isFinite(bounds.min[0])
      ? { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [bounds.max[0], bounds.max[1], bounds.max[2]] }
      : null;
  return {
    aabb,
    valueMin: hasValue && Number.isFinite(vMin) ? vMin : fallbackValueMin,
    valueMax: hasValue && Number.isFinite(vMax) ? vMax : fallbackValueMax,
    hasValue: hasValue || preferHasValue,
  };
};

/**
 * Append XYZ points into a growable packed buffer (geometric capacity).
 * Growth: min capacity {@link POINT_CLOUD_GROW_MIN_CAPACITY}, factor {@link POINT_CLOUD_GROW_FACTOR}.
 * When `maxPoints` is set, applies {@link planMaxPointsWindow} (FIFO / strict tail) via pack rewrite.
 * Returns new packed buffer + count (may reallocate).
 */
export function appendPackedPointCloud3D(
  existing: Float32Array,
  existingCount: number,
  newData: PointCloud3DData,
  options?: Readonly<{
    readonly valueOverride?: ArrayLike<number>;
    readonly warn?: (msg: string) => void;
    /** Peak retained points (FIFO). Same semantics as 2D `appendData(..., { maxPoints })`. */
    readonly maxPoints?: number;
  }>
): PackedPointCloud3D {
  const packedNew = packPointCloud3D(newData, options);
  const maxPoints = normalizeMaxPoints(options?.maxPoints);

  if (packedNew.count === 0) {
    // Empty append: still enforce maxPoints window on existing if over capacity
    if (maxPoints != null && existingCount > maxPoints) {
      const drop = existingCount - maxPoints;
      const dest = new Float32Array(maxPoints * 4);
      dest.set(existing.subarray(drop * 4, existingCount * 4));
      const ext = recomputeExtents(dest, maxPoints, 0, 1, false);
      return { packed: dest, count: maxPoints, ...ext };
    }
    const ext = recomputeExtents(existing, existingCount, 0, 1, false);
    return {
      packed: existing,
      count: existingCount,
      ...ext,
    };
  }

  const plan = planMaxPointsWindow(existingCount, packedNew.count, maxPoints);

  // Strict replace: keep only tail of new batch.
  // Always allocate a fresh buffer so renderer identity caches (equal-N rewrite) re-upload GPU.
  if (plan.isStrictReplace) {
    const keep = plan.keepNewCount;
    const srcOff = plan.newSrcOffset;
    const cap = Math.max(keep, maxPoints ?? keep);
    const dest = new Float32Array(cap * 4);
    dest.set(packedNew.packed.subarray(srcOff * 4, (srcOff + keep) * 4), 0);
    const ext = recomputeExtents(dest, keep, packedNew.valueMin, packedNew.valueMax, packedNew.hasValue);
    return { packed: dest, count: keep, ...ext };
  }

  // Drop prefix of previous then append kept new points (ring wrap or pure append).
  // Window rewrite (dropPrev > 0) always uses a new array identity so equal-N FIFO
  // forces GPU re-upload in PointCloud3DRenderer (identity + count cache).
  // Pure fill/append may reuse capacity when the buffer is large enough (count grows).
  const keepPrev = existingCount - plan.dropPrevCount;
  const total = plan.nextCount;

  let dest: Float32Array;
  if (plan.dropPrevCount === 0 && existing.length >= total * 4) {
    dest = existing;
    dest.set(packedNew.packed.subarray(0, packedNew.count * 4), existingCount * 4);
  } else {
    let cap: number;
    if (maxPoints != null) {
      cap = Math.max(maxPoints, total, POINT_CLOUD_GROW_MIN_CAPACITY);
    } else {
      // Unbounded geometric growth from min capacity (or existing capacity in points)
      cap = Math.max(POINT_CLOUD_GROW_MIN_CAPACITY, existing.length / 4);
      while (cap < total) cap = Math.ceil(cap * POINT_CLOUD_GROW_FACTOR);
    }
    dest = new Float32Array(cap * 4);
    if (keepPrev > 0) {
      dest.set(existing.subarray(plan.dropPrevCount * 4, existingCount * 4), 0);
    }
    dest.set(
      packedNew.packed.subarray(plan.newSrcOffset * 4, (plan.newSrcOffset + plan.keepNewCount) * 4),
      keepPrev * 4
    );
  }

  const ext = recomputeExtents(dest, total, packedNew.valueMin, packedNew.valueMax, packedNew.hasValue);
  return {
    packed: dest,
    count: total,
    ...ext,
  };
}

/**
 * Cheap drawable probe (no full pack). True if at least one finite XYZ sample is present.
 */
export function pointCloud3dHasDrawableSample(data: PointCloud3DData | null | undefined): boolean {
  if (data == null) return false;
  if (ArrayBuffer.isView(data)) {
    if (data instanceof DataView) return false;
    if (data instanceof Float32Array || data instanceof Float64Array) {
      const n = Math.floor(data.length / 3);
      for (let i = 0; i < n; i++) {
        const x = data[i * 3]!;
        const y = data[i * 3 + 1]!;
        const z = data[i * 3 + 2]!;
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return true;
      }
      return false;
    }
    return Math.floor(data.byteLength / 4 / 3) > 0;
  }
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      if (p == null) continue;
      let x: number;
      let y: number;
      let z: number;
      if (Array.isArray(p)) {
        x = Number(p[0]);
        y = Number(p[1]);
        z = Number(p[2]);
      } else if (typeof p === 'object') {
        const o = p as { x?: unknown; y?: unknown; z?: unknown };
        x = Number(o.x);
        y = Number(o.y);
        z = Number(o.z);
      } else {
        continue;
      }
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return true;
    }
    return false;
  }
  if (typeof data === 'object' && 'x' in data && 'y' in data && 'z' in data) {
    const a = data as PointCloud3DArraysData;
    const n = Math.min(a.x.length, a.y.length, a.z.length);
    for (let i = 0; i < n; i++) {
      const x = readArrayLike(a.x, i);
      const y = readArrayLike(a.y, i);
      const z = readArrayLike(a.z, i);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return true;
    }
    return false;
  }
  return false;
}
