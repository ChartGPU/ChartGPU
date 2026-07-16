/**
 * Sticky auto-range domain with headroom (SciChart-style growBy amortization).
 *
 * Streaming appends that expand data bounds every frame would otherwise force
 * grid/axis prepare + label rebuild every frame. Holding ~10% headroom and only
 * expanding when data breaches the sticky domain stabilizes overlay signatures
 * for many frames without changing the sampling contract.
 *
 * @module stickyAutoDomain
 * @internal
 */

export const DEFAULT_STICKY_DOMAIN_HEADROOM = 0.1;

export type StickyDomain = { min: number; max: number };

/**
 * Sticky auto-domain applies only when **both** axis ends are auto.
 * Any one-sided explicit min/max must not receive growBy headroom past that edge.
 */
export function shouldApplyStickyAutoDomain(
  explicitMin: number | undefined,
  explicitMax: number | undefined
): boolean {
  return explicitMin === undefined && explicitMax === undefined;
}

/**
 * Coordinator gate for **X** sticky domain: skip when FIFO auto-scroll is on
 * (domain must track the sliding window) or when either X end is explicit.
 */
export function shouldSkipStickyAutoXDomain(
  autoScroll: boolean | undefined,
  explicitMin: number | undefined,
  explicitMax: number | undefined
): boolean {
  return autoScroll === true || !shouldApplyStickyAutoDomain(explicitMin, explicitMax);
}

/**
 * Read-only sticky vs data domain for zoom→visible window, sampling, and slice.
 *
 * Must match paint's sticky / autoScroll / explicit-end gates so decimation
 * windows agree with GPU scales when sticky headroom is active. Does **not**
 * mutate sticky state — paint path uses {@link applyStickyAutoDomain} for that.
 *
 * @param dataDomain - Raw data (or explicit-axis) domain from computeBaseXDomain
 * @param sticky - Current sticky domain, or null when not established
 * @param opts.skipSticky - When true (autoScroll / explicit ends), always return dataDomain
 */
export function resolveStickyOrDataDomain(
  dataDomain: { readonly min: number; readonly max: number },
  sticky: StickyDomain | null,
  opts: { readonly skipSticky: boolean }
): { min: number; max: number } {
  if (opts.skipSticky) {
    return { min: dataDomain.min, max: dataDomain.max };
  }
  if (sticky != null && Number.isFinite(sticky.min) && Number.isFinite(sticky.max)) {
    return sticky;
  }
  return { min: dataDomain.min, max: dataDomain.max };
}

/**
 * Expand sticky domain with headroom when data breaches; otherwise reuse sticky.
 *
 * **First establish:** exact data domain (no pad). Static suite charts (column /
 * mountain ascending X) must fill the plot like SciChart — padding max by 10% on
 * establish left a permanent empty band on the right (100k pts → axis to ~110k).
 *
 * **Later breaches:** pad only the edge that moved (~10% growBy) so streaming
 * compression amortizes overlay rebuilds while data creeps within headroom.
 *
 * **Sliding windows (FIFO / maxPoints):** when the data min moves *up* (oldest
 * points dropped), do **not** freeze the historical min — re-establish from the
 * current data domain. Freezing min at the series origin while max scrolls
 * compresses the entire waveform into a thin strip on the right edge of the
 * plot (FIFO/ECG visual regression). Unbounded compression keeps min stable at
 * 0, so the reuse path still amortizes overlay prepare.
 */
export function applyStickyAutoDomain(
  dataDomain: { readonly min: number; readonly max: number },
  sticky: StickyDomain | null,
  headroom: number = DEFAULT_STICKY_DOMAIN_HEADROOM
): StickyDomain {
  const { min: dMin, max: dMax } = dataDomain;
  if (!Number.isFinite(dMin) || !Number.isFinite(dMax)) {
    return { min: dMin, max: dMax };
  }

  const span = Math.max(dMax - dMin, Number.EPSILON);
  const pad = span * headroom;
  const minSlidEps = Math.max(span * 1e-9, Number.EPSILON);

  const normalize = (nextMin: number, nextMax: number): StickyDomain => {
    if (nextMin === nextMax) {
      nextMax = nextMin + 1;
    } else if (nextMin > nextMax) {
      const t = nextMin;
      nextMin = nextMax;
      nextMax = t;
    }
    return { min: nextMin, max: nextMax };
  };

  // Cold start: exact data domain so static charts fill the viewport.
  if (!sticky || !Number.isFinite(sticky.min) || !Number.isFinite(sticky.max)) {
    return normalize(dMin, dMax);
  }

  if (dMin >= sticky.min && dMax <= sticky.max) {
    // Data min slid forward inside sticky max (FIFO drop-oldest): follow window.
    const minSlid = dMin > sticky.min + minSlidEps;
    if (!minSlid) {
      return sticky;
    }
    // Exact re-establish (no pad) — same as cold start for the new window.
    return normalize(dMin, dMax);
  }

  let nextMin: number;
  let nextMax: number;
  if (dMin > sticky.min + minSlidEps && dMax > sticky.max) {
    // Both edges moved (window slide + growth): exact re-establish, then pad max
    // only if we want growth headroom — pad max for streaming growth after slide.
    nextMin = dMin;
    nextMax = dMax + pad;
  } else {
    nextMin = dMin < sticky.min ? dMin - pad : sticky.min;
    // If min slid forward but max also needs expand, don't keep historical min.
    if (dMin > sticky.min + minSlidEps) {
      nextMin = dMin;
    }
    // GrowBy pad only on breach expand — not on cold establish.
    nextMax = dMax > sticky.max ? dMax + pad : sticky.max;
  }

  return normalize(nextMin, nextMax);
}
