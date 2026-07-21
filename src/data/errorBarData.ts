/**
 * Error-bar (HLC) series data adapters.
 *
 * Supports absolute HLC, relative errors, tuples, and objects.
 * Relative forms resolve to owned absolute high/low arrays (never mutates caller).
 *
 * @module errorBarData
 * @internal
 */

import type {
  ErrorBarDirection,
  ErrorBarHlcArraysData,
  ErrorBarMode,
  ErrorBarPointObject,
  ErrorBarPointTuple,
  ErrorBarRelativeArraysData,
  ErrorBarSeriesData,
} from '../config/types';
import type { Bounds } from './cartesianData';

export type ErrorBarPoint = Readonly<{
  readonly x: number;
  readonly y: number;
  readonly high: number;
  readonly low: number;
}>;

/** Owned columnar HLC used after resolve / append. */
export type MutableErrorBarHlcColumns = {
  x: number[];
  y: number[];
  high: number[];
  low: number[];
};

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

/** Reset one-shot warn cache (tests). */
export function resetErrorBarWarnings(): void {
  warnedKeys.clear();
}

export function isErrorBarHlcArraysData(data: unknown): data is ErrorBarHlcArraysData {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    !ArrayBuffer.isView(data) &&
    'x' in data &&
    'y' in data &&
    'high' in data &&
    'low' in data &&
    typeof (data as ErrorBarHlcArraysData).x === 'object' &&
    typeof (data as ErrorBarHlcArraysData).y === 'object' &&
    typeof (data as ErrorBarHlcArraysData).high === 'object' &&
    typeof (data as ErrorBarHlcArraysData).low === 'object' &&
    'length' in (data as ErrorBarHlcArraysData).x &&
    'length' in (data as ErrorBarHlcArraysData).y &&
    'length' in (data as ErrorBarHlcArraysData).high &&
    'length' in (data as ErrorBarHlcArraysData).low
  );
}

export function isErrorBarRelativeSymmetric(
  data: unknown
): data is Extract<ErrorBarRelativeArraysData, { yError: ArrayLike<number> | number }> {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    !ArrayBuffer.isView(data) &&
    'x' in data &&
    'y' in data &&
    'yError' in data &&
    !('high' in data) &&
    !('low' in data)
  );
}

export function isErrorBarRelativeAsymmetric(
  data: unknown
): data is Extract<
  ErrorBarRelativeArraysData,
  { yErrorHigh: ArrayLike<number> | number; yErrorLow: ArrayLike<number> | number }
> {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    !ArrayBuffer.isView(data) &&
    'x' in data &&
    'y' in data &&
    'yErrorHigh' in data &&
    'yErrorLow' in data &&
    !('high' in data) &&
    !('low' in data)
  );
}

export function isErrorBarRelativeData(data: unknown): data is ErrorBarRelativeArraysData {
  return isErrorBarRelativeSymmetric(data) || isErrorBarRelativeAsymmetric(data);
}

/**
 * True when payload looks like error-bar data (HLC or relative), not plain XY / band.
 * Used to validate appendData.
 */
export function isErrorBarShapedPayload(data: unknown): boolean {
  if (data == null) return false;
  if (Array.isArray(data)) {
    if (data.length === 0) return true;
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      if (p == null) continue;
      if (Array.isArray(p)) return p.length >= 4;
      if (typeof p === 'object') {
        return ('high' in p && 'low' in p) || 'yError' in p || ('yErrorHigh' in p && 'yErrorLow' in p);
      }
      return false;
    }
    return true;
  }
  if (isErrorBarHlcArraysData(data) || isErrorBarRelativeData(data)) return true;
  return false;
}

function isTuplePoint(p: unknown): p is ErrorBarPointTuple {
  return Array.isArray(p);
}

function isObjectPoint(p: unknown): p is ErrorBarPointObject {
  return typeof p === 'object' && !!p && !Array.isArray(p) && 'x' in p && 'y' in p && 'high' in p && 'low' in p;
}

/** Relative object sample in an array payload: `{x,y,yError}` or `{x,y,yErrorHigh,yErrorLow}`. */
function isRelativeObjectPoint(p: unknown): p is {
  readonly x: number;
  readonly y: number;
  readonly yError?: number;
  readonly yErrorHigh?: number;
  readonly yErrorLow?: number;
} {
  if (typeof p !== 'object' || !p || Array.isArray(p)) return false;
  if (!('x' in p) || !('y' in p)) return false;
  if ('high' in p || 'low' in p) return false;
  return 'yError' in p || ('yErrorHigh' in p && 'yErrorLow' in p);
}

function relativeObjectToHlc(p: {
  readonly x: number;
  readonly y: number;
  readonly yError?: number;
  readonly yErrorHigh?: number;
  readonly yErrorLow?: number;
}): ErrorBarPoint {
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(y)) {
    return { x, y, high: Number.NaN, low: Number.NaN };
  }
  if (typeof p.yError === 'number') {
    const e = Math.abs(p.yError);
    if (!Number.isFinite(e)) return { x, y, high: Number.NaN, low: Number.NaN };
    return { x, y, high: y + e, low: y - e };
  }
  const eHi = Math.abs(Number(p.yErrorHigh));
  const eLo = Math.abs(Number(p.yErrorLow));
  if (!Number.isFinite(eHi) || !Number.isFinite(eLo)) {
    return { x, y, high: Number.NaN, low: Number.NaN };
  }
  return { x, y, high: y + eHi, low: y - eLo };
}

/**
 * Swap low/high when low > high. Returns ordered pair (does not mutate).
 * One-shot warn when swap occurs.
 */
export function normalizeErrorBarHighLow(
  high: number,
  low: number
): { readonly high: number; readonly low: number; readonly swapped: boolean } {
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return { high, low, swapped: false };
  }
  if (low > high) {
    warnOnce('low-gt-high', 'ChartGPU errorBar: low > high for at least one sample; swapping endpoints.');
    return { high: low, low: high, swapped: true };
  }
  return { high, low, swapped: false };
}

function readRelativeOffset(channel: ArrayLike<number> | number, i: number): number {
  if (typeof channel === 'number') return channel;
  return Number(channel[i]);
}

/**
 * Convert relative error forms to absolute HLC columns (owned arrays).
 * Symmetric: high = y + |e|, low = y - |e|.
 * Asymmetric: high = y + |yErrorHigh|, low = y - |yErrorLow| (offsets use abs).
 */
export function relativeToAbsoluteHlc(data: ErrorBarRelativeArraysData): ErrorBarHlcArraysData {
  const nx = data.x.length | 0;
  const ny = data.y.length | 0;
  let n = Math.min(nx, ny);

  if (isErrorBarRelativeSymmetric(data)) {
    if (typeof data.yError !== 'number') {
      const ne = data.yError.length | 0;
      if (ne !== nx || nx !== ny) {
        warnOnce(
          'rel-sym-len',
          `ChartGPU errorBar: x/y/yError length mismatch (x=${nx}, y=${ny}, yError=${ne}); using min length.`
        );
      }
      n = Math.min(n, ne);
    } else if (nx !== ny) {
      warnOnce('rel-sym-xy', `ChartGPU errorBar: x/y length mismatch (x=${nx}, y=${ny}); using min length ${n}.`);
    }
    const x = new Array<number>(n);
    const y = new Array<number>(n);
    const high = new Array<number>(n);
    const low = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const xi = Number(data.x[i]);
      const yi = Number(data.y[i]);
      const e = Math.abs(readRelativeOffset(data.yError, i));
      x[i] = xi;
      y[i] = yi;
      if (Number.isFinite(yi) && Number.isFinite(e)) {
        high[i] = yi + e;
        low[i] = yi - e;
      } else {
        high[i] = Number.NaN;
        low[i] = Number.NaN;
      }
    }
    return { x, y, high, low };
  }

  // Asymmetric
  const eh = data.yErrorHigh;
  const el = data.yErrorLow;
  if (typeof eh !== 'number') {
    n = Math.min(n, eh.length | 0);
  }
  if (typeof el !== 'number') {
    n = Math.min(n, el.length | 0);
  }
  if (nx !== ny || typeof eh !== 'number' || typeof el !== 'number') {
    const neh = typeof eh === 'number' ? n : eh.length | 0;
    const nel = typeof el === 'number' ? n : el.length | 0;
    if (nx !== ny || neh !== nx || nel !== nx) {
      warnOnce(
        'rel-asym-len',
        `ChartGPU errorBar: relative channel length mismatch (x=${nx}, y=${ny}, yErrorHigh=${neh}, yErrorLow=${nel}); using min length ${n}.`
      );
    }
  }
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  const high = new Array<number>(n);
  const low = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const xi = Number(data.x[i]);
    const yi = Number(data.y[i]);
    const eHi = Math.abs(readRelativeOffset(eh, i));
    const eLo = Math.abs(readRelativeOffset(el, i));
    x[i] = xi;
    y[i] = yi;
    if (Number.isFinite(yi) && Number.isFinite(eHi) && Number.isFinite(eLo)) {
      high[i] = yi + eHi;
      low[i] = yi - eLo;
    } else {
      high[i] = Number.NaN;
      low[i] = Number.NaN;
    }
  }
  return { x, y, high, low };
}

/**
 * Normalize any accepted payload into owned absolute HLC columns.
 * Does not mutate caller-owned typed arrays / objects.
 */
export function resolveErrorBarToHlc(data: ErrorBarSeriesData): ErrorBarHlcArraysData {
  if (isErrorBarRelativeData(data)) {
    return relativeToAbsoluteHlc(data);
  }
  if (isErrorBarHlcArraysData(data)) {
    return errorBarDataToMutableHlc(data);
  }
  // Array of tuples / absolute objects / relative objects / null
  const arr = data as ReadonlyArray<unknown>;
  const n = arr.length;
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  const high = new Array<number>(n);
  const low = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const p = arr[i];
    if (p == null) {
      x[i] = Number.NaN;
      y[i] = Number.NaN;
      high[i] = Number.NaN;
      low[i] = Number.NaN;
      continue;
    }
    if (isTuplePoint(p)) {
      if (p.length < 4) {
        warnOnce(
          'tuple-short',
          'ChartGPU errorBar: array tuples must be [x, y, high, low] (length ≥ 4); short tuples become gaps.'
        );
        x[i] = Number.NaN;
        y[i] = Number.NaN;
        high[i] = Number.NaN;
        low[i] = Number.NaN;
        continue;
      }
      const hiLo = normalizeErrorBarHighLow(Number(p[2]), Number(p[3]));
      x[i] = Number(p[0]);
      y[i] = Number(p[1]);
      high[i] = hiLo.high;
      low[i] = hiLo.low;
      continue;
    }
    if (isObjectPoint(p)) {
      const hiLo = normalizeErrorBarHighLow(Number(p.high), Number(p.low));
      x[i] = Number(p.x);
      y[i] = Number(p.y);
      high[i] = hiLo.high;
      low[i] = hiLo.low;
      continue;
    }
    if (isRelativeObjectPoint(p)) {
      const abs = relativeObjectToHlc(p);
      x[i] = abs.x;
      y[i] = abs.y;
      high[i] = abs.high;
      low[i] = abs.low;
      continue;
    }
    warnOnce(
      'array-shape',
      'ChartGPU errorBar: unsupported array sample shape (need [x,y,high,low], {x,y,high,low}, or relative {x,y,yError*}); using NaN gap.'
    );
    x[i] = Number.NaN;
    y[i] = Number.NaN;
    high[i] = Number.NaN;
    low[i] = Number.NaN;
  }
  return { x, y, high, low };
}

/**
 * Number of logical samples. Array forms use min of channels.
 */
export function getErrorBarLength(data: ErrorBarSeriesData): number {
  if (Array.isArray(data)) {
    return data.length;
  }
  if (isErrorBarHlcArraysData(data)) {
    const nx = data.x.length | 0;
    const ny = data.y.length | 0;
    const nh = data.high.length | 0;
    const nl = data.low.length | 0;
    const n = Math.min(nx, ny, nh, nl);
    if (nx !== ny || ny !== nh || nh !== nl) {
      warnOnce(
        'hlc-len',
        `ChartGPU errorBar: x/y/high/low length mismatch (x=${nx}, y=${ny}, high=${nh}, low=${nl}); using min length ${n}.`
      );
    }
    return Math.max(0, n);
  }
  if (isErrorBarRelativeSymmetric(data)) {
    const nx = data.x.length | 0;
    const ny = data.y.length | 0;
    if (typeof data.yError === 'number') {
      if (nx !== ny) {
        warnOnce('rel-len-s', `ChartGPU errorBar: x/y length mismatch (x=${nx}, y=${ny}); using min.`);
      }
      return Math.max(0, Math.min(nx, ny));
    }
    const ne = data.yError.length | 0;
    const n = Math.min(nx, ny, ne);
    if (nx !== ny || ny !== ne) {
      warnOnce(
        'rel-len-s2',
        `ChartGPU errorBar: x/y/yError length mismatch (x=${nx}, y=${ny}, yError=${ne}); using min ${n}.`
      );
    }
    return Math.max(0, n);
  }
  if (isErrorBarRelativeAsymmetric(data)) {
    const nx = data.x.length | 0;
    const ny = data.y.length | 0;
    let n = Math.min(nx, ny);
    if (typeof data.yErrorHigh !== 'number') n = Math.min(n, data.yErrorHigh.length | 0);
    if (typeof data.yErrorLow !== 'number') n = Math.min(n, data.yErrorLow.length | 0);
    return Math.max(0, n);
  }
  return 0;
}

export function getErrorBarPoint(data: ErrorBarSeriesData, i: number): ErrorBarPoint | null {
  if (i < 0) return null;
  // Prefer pre-resolved HLC for hot paths. Relative columnar forms resolve once per call
  // here (O(n) for a single index) — callers that iterate should use resolveErrorBarToHlc first.
  if (isErrorBarRelativeData(data)) {
    const hlc = relativeToAbsoluteHlc(data);
    return getErrorBarPoint(hlc, i);
  }
  if (Array.isArray(data)) {
    if (i >= data.length) return null;
    const p = data[i];
    if (p == null) return null;
    if (isTuplePoint(p)) {
      if (p.length < 4) return null;
      const hiLo = normalizeErrorBarHighLow(Number(p[2]), Number(p[3]));
      return { x: Number(p[0]), y: Number(p[1]), high: hiLo.high, low: hiLo.low };
    }
    if (isObjectPoint(p)) {
      const hiLo = normalizeErrorBarHighLow(Number(p.high), Number(p.low));
      return { x: Number(p.x), y: Number(p.y), high: hiLo.high, low: hiLo.low };
    }
    if (isRelativeObjectPoint(p)) {
      return relativeObjectToHlc(p);
    }
    return null;
  }
  if (isErrorBarHlcArraysData(data)) {
    const n = getErrorBarLength(data);
    if (i >= n) return null;
    const hiLo = normalizeErrorBarHighLow(Number(data.high[i]), Number(data.low[i]));
    return {
      x: Number(data.x[i]),
      y: Number(data.y[i]),
      high: hiLo.high,
      low: hiLo.low,
    };
  }
  return null;
}

/**
 * Whether a sample is drawable for the given errorMode (D6).
 * Skip when y non-finite or required ends non-finite for active mode.
 */
export function isErrorBarSampleDrawable(
  point: ErrorBarPoint | null,
  errorMode: ErrorBarMode = 'both'
): point is ErrorBarPoint {
  if (!point) return false;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (errorMode === 'both') {
    return Number.isFinite(point.high) && Number.isFinite(point.low);
  }
  if (errorMode === 'high') {
    return Number.isFinite(point.high);
  }
  // low
  return Number.isFinite(point.low);
}

/**
 * Bounds from centers and high/low (or left/right for horizontal).
 * Vertical: X = all finite x; Y = y, high, low.
 * Horizontal: X = x, high, low; Y = all finite y.
 *
 * Relative / mixed array payloads are resolved once to HLC (O(n)), not per-index.
 */
export function errorBarBounds(data: ErrorBarSeriesData, direction: ErrorBarDirection = 'vertical'): Bounds | null {
  // Resolve once so relative forms and array relative objects are not O(n²).
  const hlc = isErrorBarHlcArraysData(data) && !isErrorBarRelativeData(data) ? data : resolveErrorBarToHlc(data);
  const n = getErrorBarLength(hlc);
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < n; i++) {
    const p = getErrorBarPoint(hlc, i);
    if (!p) continue;
    if (direction === 'horizontal') {
      // high/low are X extents; center is (x,y) but SciChart uses high/low as left/right absolute X.
      // ChartGPU: x is still the "anchor" sample x often equal to midpoint; include x + high + low in X.
      if (Number.isFinite(p.x)) {
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
      }
      if (Number.isFinite(p.high)) {
        if (p.high < xMin) xMin = p.high;
        if (p.high > xMax) xMax = p.high;
      }
      if (Number.isFinite(p.low)) {
        if (p.low < xMin) xMin = p.low;
        if (p.low > xMax) xMax = p.low;
      }
      if (Number.isFinite(p.y)) {
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    } else {
      if (Number.isFinite(p.x)) {
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
      }
      if (Number.isFinite(p.y)) {
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
      if (Number.isFinite(p.high)) {
        if (p.high < yMin) yMin = p.high;
        if (p.high > yMax) yMax = p.high;
      }
      if (Number.isFinite(p.low)) {
        if (p.low < yMin) yMin = p.low;
        if (p.low > yMax) yMax = p.low;
      }
    }
  }

  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return null;
  }
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;
  return { xMin, xMax, yMin, yMax };
}

export function extendBoundsWithErrorBarData(
  prev: Bounds | null | undefined,
  data: ErrorBarSeriesData,
  direction: ErrorBarDirection = 'vertical'
): Bounds | null {
  const next = errorBarBounds(data, direction);
  if (!prev) return next;
  if (!next) return prev;
  return {
    xMin: Math.min(prev.xMin, next.xMin),
    xMax: Math.max(prev.xMax, next.xMax),
    yMin: Math.min(prev.yMin, next.yMin),
    yMax: Math.max(prev.yMax, next.yMax),
  };
}

/** Seed mutable HLC columns from any ErrorBarSeriesData. */
export function errorBarDataToMutableHlc(data: ErrorBarSeriesData): MutableErrorBarHlcColumns {
  const hlc = isErrorBarHlcArraysData(data) ? data : resolveErrorBarToHlc(data);
  const n = getErrorBarLength(hlc);
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  const high = new Array<number>(n);
  const low = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const p = getErrorBarPoint(hlc, i);
    if (!p) {
      x[i] = Number.NaN;
      y[i] = Number.NaN;
      high[i] = Number.NaN;
      low[i] = Number.NaN;
    } else {
      x[i] = p.x;
      y[i] = p.y;
      high[i] = p.high;
      low[i] = p.low;
    }
  }
  return { x, y, high, low };
}

export function asErrorBarHlcArrays(cols: MutableErrorBarHlcColumns): ErrorBarHlcArraysData {
  return cols;
}

/**
 * Append HLC / relative / tuple payload into mutable columns.
 * Relative batches are resolved first (owned intermediate).
 */
export function appendErrorBarIntoHlcColumns(
  cols: MutableErrorBarHlcColumns,
  batch: ErrorBarSeriesData,
  options?: { readonly newSrcOffset?: number; readonly keepNewCount?: number }
): void {
  const resolved = resolveErrorBarToHlc(batch);
  const n = getErrorBarLength(resolved);
  const srcOff = options?.newSrcOffset ?? 0;
  const keep = options?.keepNewCount ?? n - srcOff;
  const end = Math.min(n, srcOff + Math.max(0, keep));
  for (let i = srcOff; i < end; i++) {
    const p = getErrorBarPoint(resolved, i);
    if (!p) {
      cols.x.push(Number.NaN);
      cols.y.push(Number.NaN);
      cols.high.push(Number.NaN);
      cols.low.push(Number.NaN);
    } else {
      cols.x.push(p.x);
      cols.y.push(p.y);
      cols.high.push(p.high);
      cols.low.push(p.low);
    }
  }
}

/**
 * Cheap content stamp for OptionResolver reuse.
 *
 * Samples length + first / mid / last points (O(1)). **In-place mutation of
 * middle samples under a stable data reference may not change the stamp** —
 * pass a new data reference (or use appendData) when content changes.
 * Matches the library-wide data-identity contract used for OHLC/cartesian stamps.
 */
export function cheapErrorBarContentStamp(data: ErrorBarSeriesData): number {
  const n = getErrorBarLength(data);
  if (n === 0) return 0;
  // Resolve once for relative/array forms so getErrorBarPoint is O(1) per index.
  const hlc = isErrorBarRelativeData(data) || Array.isArray(data) ? resolveErrorBarToHlc(data) : data;
  const first = getErrorBarPoint(hlc, 0);
  const mid = getErrorBarPoint(hlc, n >> 1);
  const last = getErrorBarPoint(hlc, n - 1);
  let h = n * 2654435761;
  const mix = (pt: ErrorBarPoint | null): void => {
    if (!pt) return;
    h ^= Math.floor(pt.x) | 0;
    h = (h * 1664525 + Math.floor(pt.y)) | 0;
    h = (h * 1664525 + Math.floor(pt.high)) | 0;
    h = (h * 1664525 + Math.floor(pt.low)) | 0;
  };
  mix(first);
  mix(mid);
  mix(last);
  return h >>> 0;
}

/**
 * Category spacing for capWidth percent resolution.
 * - Vertical bars: min positive Δx (category along X)
 * - Horizontal bars: min positive Δy (category along Y)
 */
export function computeErrorBarCategoryStep(
  data: ErrorBarSeriesData,
  direction: ErrorBarDirection = 'vertical'
): number {
  const hlc = isErrorBarHlcArraysData(data) && !isErrorBarRelativeData(data) ? data : resolveErrorBarToHlc(data);
  const n = getErrorBarLength(hlc);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = getErrorBarPoint(hlc, i);
    if (!p) continue;
    const v = direction === 'horizontal' ? p.y : p.x;
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < 2) return 1;
  vals.sort((a, b) => a - b);
  let minStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i]! - vals[i - 1]!;
    if (d > 0 && d < minStep) minStep = d;
  }
  return Number.isFinite(minStep) && minStep > 0 ? minStep : 1;
}
