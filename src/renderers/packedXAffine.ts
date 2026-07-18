import type { ContinuousScale, LinearScale } from '../utils/scales';
import { DEFAULT_LOG_BASE, normalizeLogBase } from '../utils/scales';

/**
 * Clip affine for buffers packed as `x' = x - xOffset` (time-axis Float32 safety).
 *
 * Must sample near `xOffset` — `computeClipAffineFromScale(0,1)` then `bx + ax*xOffset`
 * loses digits when domain is ~1e12 epoch-ms (catastrophic cancellation). Same contract as
 * candlestick packing-origin affine.
 *
 * clipX = ax * x' + b  with  b = scale(xOffset), ax = scale(xOffset+δ) - scale(xOffset) for δ=1.
 *
 * **Log X:** packing is invalid under log projection (log of offset-relative x is wrong).
 * Callers must pass `xOffset === 0` for log X; this helper falls back to
 * {@link computeClipAffineFromContinuousScale} when `scale.kind === 'log'`.
 */
export function computePackedXAffineFromScale(
  scale: LinearScale,
  xOffset: number
): { readonly a: number; readonly b: number } {
  if (scale.kind === 'log') {
    // Log projection is applied in the VS to raw data-space x; affine is in log space.
    return computeClipAffineFromContinuousScale(scale);
  }
  const origin = Number.isFinite(xOffset) ? xOffset : 0;
  const p0 = scale.scale(origin);
  // Unit probe: for linear scales equals (rangeSpan/domainSpan); stays exact near origin.
  const p1 = scale.scale(origin + 1);
  if (!Number.isFinite(p0)) {
    return { a: 0, b: 0 };
  }
  if (!Number.isFinite(p1)) {
    return { a: 0, b: p0 };
  }
  const a = p1 - p0;
  return { a: Number.isFinite(a) ? a : 0, b: p0 };
}

/**
 * Linear (or raw-sample) clip affine: `clip = a * v + b` solved from two domain samples.
 *
 * For linear axes sampling `(0, 1)` recovers the exact domain→range affine regardless of
 * domain endpoints. **Do not** use raw `(0, 1)` for log axes (0 is outside domain).
 */
export function computeClipAffineFromScale(
  scale: ContinuousScale,
  v0: number,
  v1: number
): { readonly a: number; readonly b: number } {
  const p0 = scale.scale(v0);
  const p1 = scale.scale(v1);

  if (!Number.isFinite(v0) || !Number.isFinite(v1) || v0 === v1 || !Number.isFinite(p0) || !Number.isFinite(p1)) {
    return { a: 0, b: Number.isFinite(p0) ? p0 : 0 };
  }

  const a = (p1 - p0) / (v1 - v0);
  const b = p0 - a * v0;
  return { a: Number.isFinite(a) ? a : 0, b: Number.isFinite(b) ? b : 0 };
}

/**
 * Domain→clip affine consistent with vertex-shader log projection.
 *
 * - **Linear:** samples domain 0 and 1 (same as historical line/scatter Y path).
 * - **Log:** solves `clip = a * log_b(v) + b` from domain endpoints so the VS can
 *   `log(v)/log(base)` then multiply by the mat4.
 */
export function computeClipAffineFromContinuousScale(scale: ContinuousScale): {
  readonly a: number;
  readonly b: number;
} {
  if (scale.kind !== 'log') {
    return computeClipAffineFromScale(scale, 0, 1);
  }

  const base = normalizeLogBase(scale.base ?? DEFAULT_LOG_BASE);
  const { min: d0raw, max: d1raw } = scale.getDomain();
  let d0 = d0raw;
  let d1 = d1raw;
  if (!(d0 > 0) || !(d1 > 0) || !Number.isFinite(d0) || !Number.isFinite(d1)) {
    d0 = 1;
    d1 = base > 1 ? base : 10;
  }
  if (d0 === d1) {
    d1 = d0 * base;
  } else if (d0 > d1) {
    const t = d0;
    d0 = d1;
    d1 = t;
  }

  const lnB = Math.log(base);
  const log0 = Math.log(d0) / lnB;
  const log1 = Math.log(d1) / lnB;
  const p0 = scale.scale(d0);
  const p1 = scale.scale(d1);

  if (
    !Number.isFinite(log0) ||
    !Number.isFinite(log1) ||
    log0 === log1 ||
    !Number.isFinite(p0) ||
    !Number.isFinite(p1)
  ) {
    return { a: 0, b: Number.isFinite(p0) ? p0 : 0 };
  }

  const a = (p1 - p0) / (log1 - log0);
  const b = p0 - a * log0;
  return { a: Number.isFinite(a) ? a : 0, b: Number.isFinite(b) ? b : 0 };
}

/**
 * Packed flags for series VS uniforms: bit0 = log X, bit1 = log Y.
 */
export function packLogAxisFlags(logX: boolean, logY: boolean): number {
  return (logX ? 1 : 0) | (logY ? 2 : 0);
}

/**
 * Resolve log projection params for a pair of continuous scales.
 * When both axes are linear, flags are 0 and bases are unused (still written as 10).
 * X and Y bases are independent so dual-log charts with mismatched bases project
 * correctly (affine helpers already solve with each scale’s own base).
 */
export function resolveLogProjection(
  xScale: ContinuousScale,
  yScale: ContinuousScale
): { readonly logFlags: number; readonly logBaseX: number; readonly logBaseY: number } {
  const logX = xScale.kind === 'log';
  const logY = yScale.kind === 'log';
  const logBaseX = logX && xScale.base != null ? normalizeLogBase(xScale.base) : DEFAULT_LOG_BASE;
  const logBaseY = logY && yScale.base != null ? normalizeLogBase(yScale.base) : DEFAULT_LOG_BASE;
  return { logFlags: packLogAxisFlags(logX, logY), logBaseX, logBaseY };
}
