/**
 * Nice ticks for 3D axis domains (AABB or fixed min/max).
 *
 * Tick math is shared with 2D via {@link ../utils/niceAxisTicks} — re-exported
 * here so existing 3D call sites keep stable import paths.
 */

import { niceNum, generateNiceAxisTicks } from '../../utils/niceAxisTicks';

export { niceNum };

/**
 * 3D nice ticks — may include slightly-outside nice endpoints for readable axis boxes
 * (historical 3D behavior; 2D presentation clamps via {@link generateValueAxisTicks}).
 */
export function generateNiceAxisTicks3D(min: number, max: number, tickCount = 5): number[] {
  return generateNiceAxisTicks(min, max, tickCount, { clampToDomain: false });
}

/** Compact tick label for 3D overlays. */
export function formatAxisTick3D(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2);
  if (Number.isInteger(v) || Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  const s = v.toPrecision(4);
  return s.replace(/\.?0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export type Axis3DDomain = Readonly<{ readonly min: number; readonly max: number }>;

/**
 * Resolve axis domain from optional fixed min/max and scene AABB component.
 */
export function resolveAxisDomain3D(
  fixedMin: number | undefined,
  fixedMax: number | undefined,
  aabbMin: number,
  aabbMax: number
): Axis3DDomain {
  const lo = typeof fixedMin === 'number' && Number.isFinite(fixedMin) ? fixedMin : aabbMin;
  const hi = typeof fixedMax === 'number' && Number.isFinite(fixedMax) ? fixedMax : aabbMax;
  if (lo === hi) {
    return { min: lo - 0.5, max: hi + 0.5 };
  }
  return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo };
}
