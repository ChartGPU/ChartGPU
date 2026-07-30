/**
 * Shared "nice number" tick generation for 2D and 3D value axes.
 *
 * Classic Graphics Gems / d3-array style 1–2–5 × 10ⁿ ladder.
 * Single implementation — 3D re-exports via {@link generateNiceAxisTicks3D}.
 *
 * @module niceAxisTicks
 */

/**
 * Classic "nice number" for axis domains (Graphics Gems / d3-array style).
 *
 * @param range - Positive span to round/ceil
 * @param round - When true, round to nearest ladder step; when false, ceil
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

export type GenerateNiceAxisTicksOptions = {
  /**
   * When true (default for 2D presentation via {@link generateValueAxisTicks}),
   * drop majors strictly outside [min, max] so labels/grid stay in-plot.
   * When false (3D default), include nice endpoints slightly outside the raw domain.
   */
  readonly clampToDomain?: boolean;
};

/**
 * Generate ascending nice tick values covering [min, max] with ~tickCountHint majors.
 *
 * Always returns at least 2 values when domain is finite.
 * Degenerate (equal / non-finite) domains fall back to a padded pair or [0, 1].
 *
 * @param min - Domain minimum (data space)
 * @param max - Domain maximum (data space)
 * @param tickCountHint - Preferred major count (clamped 2–20; default 5)
 * @param options.clampToDomain - Filter to [min,max] (2D); false keeps slightly-outside nice ends (3D)
 */
export function generateNiceAxisTicks(
  min: number,
  max: number,
  tickCountHint = 5,
  options?: GenerateNiceAxisTicksOptions
): number[] {
  const clampToDomain = options?.clampToDomain !== false;
  const count = Math.max(2, Math.min(20, Math.floor(tickCountHint) || 5));
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return [0, 1];
  }
  const rawLo = lo;
  const rawHi = hi;
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

  // Step selection:
  // - clampToDomain (2D presentation): derive step from the *raw* span.
  //   The classic Graphics Gems path first ceils the span (`niceNum(span, false)`),
  //   which cliffs under continuous auto-range — e.g. domain [0, 2] → step 0.5
  //   (labels 0, 0.5, 1, 1.5, 2) but [0, 2.1] → expanded range 5 → step 1
  //   (labels 0, 1, 2 only) so mid-majors like 0.5 vanish on the tiniest grow.
  // - unclamped (3D): keep the classic expand-then-step so nice endpoints can sit
  //   slightly outside the raw domain.
  const span = hi - lo;
  const step = clampToDomain
    ? niceNum(span / (count - 1), true)
    : niceNum(niceNum(span, false) / (count - 1), true);
  if (!(step > 0) || !Number.isFinite(step)) {
    return [lo, hi];
  }
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  // Guard against infinite loops on pathological float steps
  const maxIter = 64;
  let v = niceMin;
  const eps = step * 1e-9;
  // Filter window: equal-domain path uses expanded lo/hi; otherwise raw request domain.
  const filterLo = rawLo === rawHi ? lo : Math.min(rawLo, rawHi);
  const filterHi = rawLo === rawHi ? hi : Math.max(rawLo, rawHi);

  for (let i = 0; i < maxIter && v <= niceMax + step * 0.5; i++) {
    // Snap tiny float noise
    const snapped = Math.abs(v) < step * 1e-12 ? 0 : v;
    if (clampToDomain) {
      if (snapped >= filterLo - eps && snapped <= filterHi + eps) {
        ticks.push(snapped);
      }
    } else if (snapped >= lo - eps && snapped <= hi + eps) {
      ticks.push(snapped);
    } else if (snapped >= niceMin - eps && snapped <= niceMax + eps) {
      // Include nice endpoints slightly outside raw domain (3D / expanded grids)
      ticks.push(snapped);
    }
    v += step;
  }
  if (ticks.length < 2) {
    // Sparse window: domain endpoints so labels/grid stay useful inside the plot.
    if (clampToDomain && filterLo !== filterHi) {
      return [filterLo, filterHi];
    }
    return [lo, hi];
  }
  // Dedupe
  const out: number[] = [];
  for (const t of ticks) {
    if (out.length === 0 || Math.abs(out[out.length - 1]! - t) > eps) {
      out.push(t);
    }
  }
  return out.length >= 2 ? out : clampToDomain && filterLo !== filterHi ? [filterLo, filterHi] : [lo, hi];
}
