/**
 * Nice ticks for 3D axis domains (AABB or fixed min/max).
 */

/**
 * Classic "nice number" for axis domains (Graphics Gems / d3-array style).
 */
export function niceNum(range: number, round: boolean): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const exp = Math.floor(Math.log10(range));
  const f = range / 10 ** exp;
  let nf: number;
  if (round) {
    if (f < 1.5) nf = 1;
    else if (f < 3) nf = 2;
    else if (f < 7) nf = 5;
    else nf = 10;
  } else {
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 5) nf = 5;
    else nf = 10;
  }
  return nf * 10 ** exp;
}

/**
 * Generate ascending nice tick values covering [min, max] with ~tickCount majors.
 * Always returns at least 2 values when domain is finite (endpoints may be nice-expanded).
 */
export function generateNiceAxisTicks3D(min: number, max: number, tickCount = 5): number[] {
  const count = Math.max(2, Math.min(20, Math.floor(tickCount) || 5));
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return [0, 1];
  }
  if (lo === hi) {
    const pad = Math.abs(lo) > 1e-6 ? Math.abs(lo) * 0.1 : 0.5;
    lo -= pad;
    hi += pad;
  }
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }

  const range = niceNum(hi - lo, false);
  const step = niceNum(range / (count - 1), true);
  if (!(step > 0) || !Number.isFinite(step)) {
    return [lo, hi];
  }
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  // Guard against infinite loops on pathological float steps
  const maxIter = 64;
  let v = niceMin;
  for (let i = 0; i < maxIter && v <= niceMax + step * 0.5; i++) {
    // Snap tiny float noise
    const snapped = Math.abs(v) < step * 1e-12 ? 0 : v;
    if (snapped >= lo - step * 1e-9 && snapped <= hi + step * 1e-9) {
      ticks.push(snapped);
    } else if (snapped >= niceMin - step * 1e-9 && snapped <= niceMax + step * 1e-9) {
      // Include nice endpoints slightly outside raw domain for readable grids
      ticks.push(snapped);
    }
    v += step;
  }
  if (ticks.length < 2) {
    return [lo, hi];
  }
  // Dedupe
  const out: number[] = [];
  for (const t of ticks) {
    if (out.length === 0 || Math.abs(out[out.length - 1]! - t) > step * 1e-9) {
      out.push(t);
    }
  }
  return out.length >= 2 ? out : [lo, hi];
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
