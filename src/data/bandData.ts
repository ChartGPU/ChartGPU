/**
 * Band / range series data adapters (Xyy).
 *
 * Supports:
 * - ReadonlyArray<BandDataPoint | null> (tuple [x,y,y1] or {x,y,y1})
 * - BandXYYArraysData ({ x, y, y1 })
 * - InterleavedXYYData (ArrayBufferView, stride 3)
 *
 * Layout for GPU pack: Float32 stride 4 (x, y, y1, pad) for 16-byte alignment.
 *
 * @module bandData
 * @internal
 */

import type {
  BandDataPoint,
  BandDataPointObject,
  BandDataPointTuple,
  BandSeriesData,
  BandXYYArraysData,
  InterleavedXYYData,
  SeriesSampling,
} from '../config/types';
import type { Bounds } from './cartesianData';

export type BandPoint = Readonly<{ x: number; y: number; y1: number }>;

const warnedLengthMismatch = new Set<string>();

function warnLengthMismatchOnce(key: string, message: string): void {
  if (warnedLengthMismatch.has(key)) return;
  warnedLengthMismatch.add(key);
  console.warn(message);
}

/** Reset length-mismatch warn cache (tests). */
export function resetBandLengthMismatchWarnings(): void {
  warnedLengthMismatch.clear();
}

export function isBandXYYArraysData(data: unknown): data is BandXYYArraysData {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    !ArrayBuffer.isView(data) &&
    'x' in data &&
    'y' in data &&
    'y1' in data &&
    typeof (data as BandXYYArraysData).x === 'object' &&
    typeof (data as BandXYYArraysData).y === 'object' &&
    typeof (data as BandXYYArraysData).y1 === 'object' &&
    'length' in (data as BandXYYArraysData).x &&
    'length' in (data as BandXYYArraysData).y &&
    'length' in (data as BandXYYArraysData).y1
  );
}

export function isInterleavedXYYData(data: unknown): data is InterleavedXYYData {
  return typeof data === 'object' && data !== null && !Array.isArray(data) && ArrayBuffer.isView(data);
}

function isTupleBandPoint(p: BandDataPoint): p is BandDataPointTuple {
  return Array.isArray(p);
}

function isObjectBandPoint(p: BandDataPoint): p is BandDataPointObject {
  // Use !!p (not !== null) so CodeQL does not flag object-vs-null comparison after typeof.
  return typeof p === 'object' && !!p && !Array.isArray(p) && 'x' in p && 'y' in p && 'y1' in p;
}

/**
 * Number of logical samples. Array forms use min(x,y,y1) length.
 * Interleaved: floor(view.length / 3); non-multiple of 3 truncates the tail.
 */
export function getBandLength(data: BandSeriesData): number {
  if (Array.isArray(data)) {
    return data.length;
  }
  if (isBandXYYArraysData(data)) {
    const nx = data.x.length | 0;
    const ny = data.y.length | 0;
    const ny1 = data.y1.length | 0;
    const n = Math.min(nx, ny, ny1);
    if (nx !== ny || ny !== ny1) {
      warnLengthMismatchOnce(
        'xyy-len',
        `ChartGPU band series: x/y/y1 length mismatch (x=${nx}, y=${ny}, y1=${ny1}); using min length ${n}.`
      );
    }
    return Math.max(0, n);
  }
  if (isInterleavedXYYData(data)) {
    const view = data as unknown as ArrayLike<number>;
    const len = view.length | 0;
    if (len % 3 !== 0) {
      warnLengthMismatchOnce(
        'interleaved-stride',
        `ChartGPU band series: interleaved Xyy length ${len} is not a multiple of 3; truncating to ${Math.floor(len / 3)} points.`
      );
    }
    return Math.max(0, Math.floor(len / 3));
  }
  return 0;
}

/**
 * Read one sample. Null array slots and non-finite x/y/y1 yield null
 * (or a point with NaN components when only some channels are invalid — pack uses NaN).
 */
export function getBandPoint(data: BandSeriesData, i: number): BandPoint | null {
  if (i < 0) return null;
  if (Array.isArray(data)) {
    if (i >= data.length) return null;
    const p = data[i];
    if (p == null) return null;
    if (isTupleBandPoint(p)) {
      const x = p[0] as number;
      const y = p[1] as number;
      const y1 = p[2] as number;
      if (!Number.isFinite(x) && !Number.isFinite(y) && !Number.isFinite(y1)) return null;
      return { x, y, y1 };
    }
    if (isObjectBandPoint(p)) {
      return { x: p.x, y: p.y, y1: p.y1 };
    }
    return null;
  }
  if (isBandXYYArraysData(data)) {
    const n = getBandLength(data);
    if (i >= n) return null;
    return {
      x: Number(data.x[i]),
      y: Number(data.y[i]),
      y1: Number(data.y1[i]),
    };
  }
  if (isInterleavedXYYData(data)) {
    const view = data as unknown as ArrayLike<number>;
    const n = getBandLength(data);
    if (i >= n) return null;
    const base = i * 3;
    return {
      x: Number(view[base]),
      y: Number(view[base + 1]),
      y1: Number(view[base + 2]),
    };
  }
  return null;
}

export function getBandX(data: BandSeriesData, i: number): number {
  const p = getBandPoint(data, i);
  return p ? p.x : Number.NaN;
}

export function getBandY(data: BandSeriesData, i: number): number {
  const p = getBandPoint(data, i);
  return p ? p.y : Number.NaN;
}

export function getBandY1(data: BandSeriesData, i: number): number {
  const p = getBandPoint(data, i);
  return p ? p.y1 : Number.NaN;
}

/**
 * Bounds from all finite x and both y channels (y and y1).
 * Returns null when no finite contribution.
 */
export function bandBounds(data: BandSeriesData): Bounds | null {
  const n = getBandLength(data);
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < n; i++) {
    const p = getBandPoint(data, i);
    if (!p) continue;
    if (Number.isFinite(p.x)) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
    }
    if (Number.isFinite(p.y)) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    if (Number.isFinite(p.y1)) {
      if (p.y1 < yMin) yMin = p.y1;
      if (p.y1 > yMax) yMax = p.y1;
    }
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return null;
  }
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;
  return { xMin, xMax, yMin, yMax };
}

/**
 * Visible-window Y envelope (both y and y1). Optional x window.
 */
export function scanBandVisibleYBounds(
  data: BandSeriesData,
  xWindow?: { readonly min: number; readonly max: number } | null
): { yMin: number; yMax: number } | null {
  const n = getBandLength(data);
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const filterX = xWindow != null && Number.isFinite(xWindow.min) && Number.isFinite(xWindow.max);
  const xMinW = filterX ? xWindow!.min : 0;
  const xMaxW = filterX ? xWindow!.max : 0;

  for (let i = 0; i < n; i++) {
    const p = getBandPoint(data, i);
    if (!p) continue;
    if (filterX) {
      if (!Number.isFinite(p.x) || p.x < xMinW || p.x > xMaxW) continue;
    }
    if (Number.isFinite(p.y)) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    if (Number.isFinite(p.y1)) {
      if (p.y1 < yMin) yMin = p.y1;
      if (p.y1 > yMax) yMax = p.y1;
    }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  if (yMin === yMax) yMax = yMin + 1;
  return { yMin, yMax };
}

/**
 * Strictly positive finite y/y1 envelope (log-axis auto domain).
 * Both channels contribute independently when positive.
 */
export function scanBandPositiveYBounds(
  data: BandSeriesData,
  xWindow?: { readonly min: number; readonly max: number } | null
): { yMin: number; yMax: number } | null {
  const n = getBandLength(data);
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const filterX = xWindow != null && Number.isFinite(xWindow.min) && Number.isFinite(xWindow.max);
  const xMinW = filterX ? xWindow!.min : 0;
  const xMaxW = filterX ? xWindow!.max : 0;

  for (let i = 0; i < n; i++) {
    const p = getBandPoint(data, i);
    if (!p) continue;
    if (filterX) {
      if (!Number.isFinite(p.x) || p.x < xMinW || p.x > xMaxW) continue;
    }
    if (Number.isFinite(p.y) && p.y > 0) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    if (Number.isFinite(p.y1) && p.y1 > 0) {
      if (p.y1 < yMin) yMin = p.y1;
      if (p.y1 > yMax) yMax = p.y1;
    }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || !(yMin > 0) || !(yMax > 0)) {
    return null;
  }
  return { yMin, yMax };
}

/**
 * Seed mutable Xyy columns from any BandSeriesData (hit-test / append store).
 */
export function bandDataToMutableXYY(data: BandSeriesData): {
  x: number[];
  y: number[];
  y1: number[];
} {
  const n = getBandLength(data);
  const x: number[] = new Array(n);
  const y: number[] = new Array(n);
  const y1: number[] = new Array(n);
  for (let j = 0; j < n; j++) {
    const p = getBandPoint(data, j);
    x[j] = p ? p.x : Number.NaN;
    y[j] = p ? p.y : Number.NaN;
    y1[j] = p ? p.y1 : Number.NaN;
  }
  return { x, y, y1 };
}

/**
 * True when a payload looks like band data (has y1 channel) rather than plain XY.
 * Used to warn on cartesian-only append to band series.
 */
export function isBandShapedPayload(data: unknown): boolean {
  if (data == null) return false;
  if (Array.isArray(data)) {
    if (data.length === 0) return true; // empty ok
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      if (p == null) continue;
      if (Array.isArray(p)) return p.length >= 3;
      // p is non-nullish after `if (p == null) continue` above.
      if (typeof p === 'object') return 'y1' in p;
      return false;
    }
    return true;
  }
  if (ArrayBuffer.isView(data)) {
    // Interleaved Xyy only (stride 3). Stride-2 XY typed arrays are not band-shaped.
    const view = data as unknown as ArrayLike<number>;
    const len = view.length | 0;
    return len === 0 || len % 3 === 0;
  }
  // Outer `data == null` already returned false; no second null compare for CodeQL.
  if (typeof data === 'object' && 'y1' in data && 'x' in data && 'y' in data) {
    return true;
  }
  return false;
}

/**
 * Pack into Float32 stride-4: [x, y, y1, 0] per point (16-byte BandPoint).
 * Null / non-finite any of x/y/y1 → NaN for that channel (segment discard uses dual-endpoint).
 * Returns logical point count written.
 */
export function packBandPoints(data: BandSeriesData, out: Float32Array, pointCount?: number): number {
  const n = pointCount ?? getBandLength(data);
  const need = n * 4;
  if (out.length < need) {
    throw new Error(`packBandPoints: out length ${out.length} < required ${need}`);
  }
  for (let i = 0; i < n; i++) {
    const p = getBandPoint(data, i);
    const base = i * 4;
    if (!p) {
      out[base] = Number.NaN;
      out[base + 1] = Number.NaN;
      out[base + 2] = Number.NaN;
      out[base + 3] = 0;
      continue;
    }
    // Pack finite or NaN; incomplete finite points still encode so VS can discard.
    out[base] = Number.isFinite(p.x) ? p.x : Number.NaN;
    out[base + 1] = Number.isFinite(p.y) ? p.y : Number.NaN;
    out[base + 2] = Number.isFinite(p.y1) ? p.y1 : Number.NaN;
    out[base + 3] = 0;
  }
  return n;
}

/**
 * Pack y-curve (or y1-curve) as interleaved XY Float32 for stroke LineRenderer buffers.
 * `channel`: 0 = y, 1 = y1.
 */
export function packBandStrokeXY(data: BandSeriesData, out: Float32Array, channel: 0 | 1, pointCount?: number): number {
  const n = pointCount ?? getBandLength(data);
  const need = n * 2;
  if (out.length < need) {
    throw new Error(`packBandStrokeXY: out length ${out.length} < required ${need}`);
  }
  for (let i = 0; i < n; i++) {
    const p = getBandPoint(data, i);
    const base = i * 2;
    if (!p) {
      out[base] = Number.NaN;
      out[base + 1] = Number.NaN;
      continue;
    }
    const yv = channel === 0 ? p.y : p.y1;
    if (!Number.isFinite(p.x) || !Number.isFinite(yv)) {
      out[base] = Number.NaN;
      out[base + 1] = Number.NaN;
    } else {
      out[base] = p.x;
      out[base + 1] = yv;
    }
  }
  return n;
}

/** True when any sample is a null array slot or has a non-finite x/y/y1. */
export function hasBandNullGaps(data: BandSeriesData): boolean {
  const n = getBandLength(data);
  for (let i = 0; i < n; i++) {
    if (Array.isArray(data) && data[i] == null) return true;
    const p = getBandPoint(data, i);
    if (!p) return true;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.y1)) return true;
  }
  return false;
}

/**
 * Drop null / non-finite gap samples (connectNulls path). Returns dense XYY arrays.
 */
export function filterBandGaps(data: BandSeriesData): BandXYYArraysData {
  const n = getBandLength(data);
  const xs: number[] = [];
  const ys: number[] = [];
  const y1s: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = getBandPoint(data, i);
    if (!p) continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.y1)) continue;
    xs.push(p.x);
    ys.push(p.y);
    y1s.push(p.y1);
  }
  return { x: xs, y: ys, y1: y1s };
}

function clampTarget(targetPoints: number): number {
  const t = Math.floor(targetPoints);
  return Number.isFinite(t) ? t : 0;
}

/**
 * LTTB on midline m=(y+y1)/2; carry both y and y1 from chosen indices.
 * Returns BandDataPointTuple[].
 */
function sampleBandLttb(data: BandSeriesData, targetPoints: number): BandDataPointTuple[] {
  const n = getBandLength(data);
  const threshold = clampTarget(targetPoints);
  if (threshold <= 0 || n === 0) return [];
  if (threshold === 1) {
    const p = getBandPoint(data, 0);
    return p ? [[p.x, p.y, p.y1]] : [];
  }
  if (n <= threshold) {
    const out: BandDataPointTuple[] = [];
    for (let i = 0; i < n; i++) {
      const p = getBandPoint(data, i);
      if (p) out.push([p.x, p.y, p.y1]);
      else out.push([Number.NaN, Number.NaN, Number.NaN]);
    }
    return out;
  }

  const lastIndex = n - 1;
  const indices = new Int32Array(threshold);
  indices[0] = 0;
  indices[threshold - 1] = lastIndex;

  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0;

  const mid = (i: number): { x: number; m: number } => {
    const p = getBandPoint(data, i);
    if (!p || !Number.isFinite(p.x)) return { x: Number.NaN, m: Number.NaN };
    const y = Number.isFinite(p.y) ? p.y : 0;
    const y1 = Number.isFinite(p.y1) ? p.y1 : y;
    return { x: p.x, m: (y + y1) / 2 };
  };

  const last = mid(lastIndex);

  for (let bucket = 0; bucket < threshold - 2; bucket++) {
    let rangeStart = Math.floor(bucketSize * bucket) + 1;
    let rangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 1)) + 1, lastIndex);
    if (rangeStart >= rangeEndExclusive) {
      rangeStart = Math.min(rangeStart, lastIndex - 1);
      rangeEndExclusive = Math.min(rangeStart + 1, lastIndex);
    }

    const nextRangeStart = Math.floor(bucketSize * (bucket + 1)) + 1;
    const nextRangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 2)) + 1, lastIndex);

    let avgX = last.x;
    let avgM = last.m;
    if (nextRangeStart < nextRangeEndExclusive) {
      let sumX = 0;
      let sumM = 0;
      let avgCount = 0;
      for (let i = nextRangeStart; i < nextRangeEndExclusive; i++) {
        const q = mid(i);
        if (!Number.isFinite(q.x) || !Number.isFinite(q.m)) continue;
        sumX += q.x;
        sumM += q.m;
        avgCount++;
      }
      if (avgCount > 0) {
        avgX = sumX / avgCount;
        avgM = sumM / avgCount;
      }
    }

    const aPt = mid(a);
    let maxArea = -1;
    let maxIndex = rangeStart;
    for (let i = rangeStart; i < rangeEndExclusive; i++) {
      const bPt = mid(i);
      const area2 = (aPt.x - avgX) * (bPt.m - aPt.m) - (aPt.x - bPt.x) * (avgM - aPt.m);
      const absArea2 = area2 < 0 ? -area2 : area2;
      if (absArea2 > maxArea) {
        maxArea = absArea2;
        maxIndex = i;
      }
    }
    indices[bucket + 1] = maxIndex;
    a = maxIndex;
  }

  const out: BandDataPointTuple[] = new Array(threshold);
  for (let i = 0; i < threshold; i++) {
    const p = getBandPoint(data, indices[i]!);
    out[i] = p ? [p.x, p.y, p.y1] : [Number.NaN, Number.NaN, Number.NaN];
  }
  return out;
}

type BucketMode = 'average' | 'max' | 'min';

/**
 * Bucket sample: average averages y and y1 separately;
 * min/max use envelope extrema (min of min(y,y1), max of max(y,y1)) with bucket mid x.
 */
function sampleBandBuckets(data: BandSeriesData, targetPoints: number, mode: BucketMode): BandDataPointTuple[] {
  const n = getBandLength(data);
  const threshold = clampTarget(targetPoints);
  if (threshold <= 0 || n === 0) return [];
  if (n <= threshold) {
    const out: BandDataPointTuple[] = [];
    for (let i = 0; i < n; i++) {
      const p = getBandPoint(data, i);
      out.push(p ? [p.x, p.y, p.y1] : [Number.NaN, Number.NaN, Number.NaN]);
    }
    return out;
  }

  const out: BandDataPointTuple[] = [];
  const bucketSize = n / threshold;
  for (let b = 0; b < threshold; b++) {
    const start = Math.floor(b * bucketSize);
    const end = Math.min(n, Math.floor((b + 1) * bucketSize));
    if (start >= end) continue;

    if (mode === 'average') {
      // Average each channel only over samples where that channel is finite.
      let sumX = 0;
      let sumY = 0;
      let sumY1 = 0;
      let countX = 0;
      let countY = 0;
      let countY1 = 0;
      for (let i = start; i < end; i++) {
        const p = getBandPoint(data, i);
        if (!p) continue;
        if (Number.isFinite(p.x)) {
          sumX += p.x;
          countX++;
        }
        if (Number.isFinite(p.y)) {
          sumY += p.y;
          countY++;
        }
        if (Number.isFinite(p.y1)) {
          sumY1 += p.y1;
          countY1++;
        }
      }
      if (countX === 0 && countY === 0 && countY1 === 0) {
        out.push([Number.NaN, Number.NaN, Number.NaN]);
      } else {
        out.push([
          countX > 0 ? sumX / countX : Number.NaN,
          countY > 0 ? sumY / countY : Number.NaN,
          countY1 > 0 ? sumY1 / countY1 : Number.NaN,
        ]);
      }
    } else {
      // Envelope (v1): min and max modes are aliases — both keep full
      // [envMin, envMax] so axis bounds retain the dual-Y envelope under downsample.
      let envMin = Number.POSITIVE_INFINITY;
      let envMax = Number.NEGATIVE_INFINITY;
      const midIdx = (start + end - 1) >>> 1;
      for (let i = start; i < end; i++) {
        const p = getBandPoint(data, i);
        if (!p) continue;
        const lo = Math.min(
          Number.isFinite(p.y) ? p.y : Number.POSITIVE_INFINITY,
          Number.isFinite(p.y1) ? p.y1 : Number.POSITIVE_INFINITY
        );
        const hi = Math.max(
          Number.isFinite(p.y) ? p.y : Number.NEGATIVE_INFINITY,
          Number.isFinite(p.y1) ? p.y1 : Number.NEGATIVE_INFINITY
        );
        if (Number.isFinite(lo) && lo < envMin) envMin = lo;
        if (Number.isFinite(hi) && hi > envMax) envMax = hi;
      }
      const midP = getBandPoint(data, midIdx);
      const x = midP && Number.isFinite(midP.x) ? midP.x : Number.NaN;
      if (!Number.isFinite(envMin) || !Number.isFinite(envMax)) {
        out.push([x, Number.NaN, Number.NaN]);
      } else {
        out.push([x, envMin, envMax]);
      }
    }
  }
  return out;
}

/**
 * Sample band series per dual-Y policy (D5).
 * `'ohlc'` is not supported — falls back to full data.
 */
export function sampleBandSeries(
  data: BandSeriesData,
  mode: SeriesSampling | Exclude<SeriesSampling, 'ohlc'>,
  threshold: number
): BandSeriesData {
  const n = getBandLength(data);
  if (mode === 'none' || mode === 'ohlc' || n <= threshold || threshold <= 0) {
    return data;
  }
  if (mode === 'lttb') {
    return sampleBandLttb(data, threshold);
  }
  if (mode === 'average' || mode === 'max' || mode === 'min') {
    return sampleBandBuckets(data, threshold, mode);
  }
  return data;
}

/**
 * Slice band points by x window (inclusive). Returns dense tuple array.
 */
export function sliceBandByX(data: BandSeriesData, xMin: number, xMax: number): BandDataPointTuple[] {
  const n = getBandLength(data);
  const out: BandDataPointTuple[] = [];
  const lo = Math.min(xMin, xMax);
  const hi = Math.max(xMin, xMax);
  for (let i = 0; i < n; i++) {
    const p = getBandPoint(data, i);
    if (!p || !Number.isFinite(p.x)) continue;
    if (p.x < lo || p.x > hi) continue;
    out.push([p.x, p.y, p.y1]);
  }
  return out;
}

/**
 * O(1) content stamp when band data reference changes.
 */
export function cheapBandContentStamp(data: BandSeriesData): number {
  const FNV_OFFSET = 2166136261;
  const FNV_PRIME = 16777619;
  let h = FNV_OFFSET >>> 0;
  h = Math.imul(h ^ (getBandLength(data) >>> 0), FNV_PRIME) >>> 0;
  h = Math.imul(h ^ 0xba11d, FNV_PRIME) >>> 0;
  // Mix a generation-like constant from length + type tag so stamps differ from cartesian.
  h = Math.imul(h ^ 0xb0a1d, FNV_PRIME) >>> 0;
  return h >>> 0;
}

/**
 * Append band points onto mutable XYY columns (in-place growth).
 * Accepts any BandSeriesData payload; returns new length.
 */
export function appendBandIntoXYYColumns(
  columns: { x: number[]; y: number[]; y1: number[] },
  append: BandSeriesData,
  plan?: { readonly newSrcOffset?: number; readonly keepNewCount?: number }
): number {
  const n = getBandLength(append);
  const start = plan?.newSrcOffset ?? 0;
  const keep = plan?.keepNewCount ?? n - start;
  const end = Math.min(n, start + Math.max(0, keep));
  for (let i = start; i < end; i++) {
    const p = getBandPoint(append, i);
    if (!p) {
      columns.x.push(Number.NaN);
      columns.y.push(Number.NaN);
      columns.y1.push(Number.NaN);
      continue;
    }
    columns.x.push(p.x);
    columns.y.push(p.y);
    columns.y1.push(p.y1);
  }
  return columns.x.length;
}

/**
 * Extend bounds with band samples (both y channels).
 */
export function extendBoundsWithBandData(prev: Bounds | null | undefined, data: BandSeriesData): Bounds | null {
  const next = bandBounds(data);
  if (!prev) return next;
  if (!next) return prev;
  return {
    xMin: Math.min(prev.xMin, next.xMin),
    xMax: Math.max(prev.xMax, next.xMax),
    yMin: Math.min(prev.yMin, next.yMin),
    yMax: Math.max(prev.yMax, next.yMax),
  };
}

/**
 * Convert owned mutable XYY columns to BandXYYArraysData view.
 */
export function asBandXYYArrays(columns: {
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly y1: ArrayLike<number>;
}): BandXYYArraysData {
  return { x: columns.x, y: columns.y, y1: columns.y1 };
}
