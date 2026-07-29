/**
 * Pure policy helpers for surface3d stream + setOption multi-layer state.
 * Single source of truth for coordinator domain / AABB / contour decisions —
 * unit-test truth tables without spinning up WebGPU.
 */

import type { AABB } from '../core/3d/aabb';
import type { Surface3DStreamResult } from './surface3dStream';
import type { Surface3DUpdate } from '../config/types';

/**
 * Whether a full-field height walk is required to refresh colormap domain.
 * False when update carries both yMin/yMax, or series config has explicit domain.
 */
export function shouldWalkSurfaceDomain(opts: {
  readonly recomputeDomain: boolean;
  readonly yDomainExplicit: boolean;
}): boolean {
  return opts.recomputeDomain && !opts.yDomainExplicit;
}

/**
 * Single-column spectrogram scroll may expand domain from the new strip only.
 * Skipped when series has a user-fixed colormap domain.
 */
export function shouldExpandStripDomain(opts: {
  readonly mode: Surface3DUpdate['mode'];
  readonly scrollX?: boolean;
  readonly columns?: number;
  readonly recomputeDomain: boolean;
  readonly yDomainExplicit: boolean;
}): boolean {
  return (
    opts.mode === 'appendColumns' &&
    opts.scrollX !== false &&
    opts.columns === 1 &&
    !opts.recomputeDomain &&
    !opts.yDomainExplicit
  );
}

/**
 * Contour geometry invalidate on full-field replace — only when isolines are shown.
 */
export function shouldInvalidateSurfaceContoursOnReplaceY(opts: {
  readonly mode: Surface3DUpdate['mode'];
  readonly contoursShow: boolean;
}): boolean {
  return opts.mode === 'replaceY' && opts.contoursShow === true;
}

/**
 * Resolve Y extent for replaceY AABB reuse (XZ retained from prior box).
 * Prefers update-level domain, then stream domain override, then series explicit domain.
 * Returns null when Y is unknown → coordinator invalidates AABB cache (full recompute later).
 */
export function resolveReplaceYAABBYextent(opts: {
  readonly resultYMin?: number;
  readonly resultYMax?: number;
  readonly streamDomain: { readonly yMin: number; readonly yMax: number } | null | undefined;
  readonly yDomainExplicit: boolean;
  readonly seriesYMin: number;
  readonly seriesYMax: number;
}): { yMin: number; yMax: number } | null {
  if (
    typeof opts.resultYMin === 'number' &&
    Number.isFinite(opts.resultYMin) &&
    typeof opts.resultYMax === 'number' &&
    Number.isFinite(opts.resultYMax)
  ) {
    return { yMin: opts.resultYMin, yMax: opts.resultYMax };
  }
  if (opts.streamDomain && Number.isFinite(opts.streamDomain.yMin) && Number.isFinite(opts.streamDomain.yMax)) {
    return { yMin: opts.streamDomain.yMin, yMax: opts.streamDomain.yMax };
  }
  if (opts.yDomainExplicit && Number.isFinite(opts.seriesYMin) && Number.isFinite(opts.seriesYMax)) {
    return { yMin: opts.seriesYMin, yMax: opts.seriesYMax };
  }
  return null;
}

/**
 * Build replaceY AABB by reusing prior XZ and applying resolved Y (colormap/domain framing).
 * Returns null when prev AABB or Y extent is missing → invalidate cache.
 */
export function reuseReplaceYAABB(
  prev: AABB | null | undefined,
  yExtent: { readonly yMin: number; readonly yMax: number } | null,
  data: unknown,
  y: unknown
): { data: unknown; y: unknown; aabb: AABB } | null {
  if (!prev || !yExtent || !Number.isFinite(yExtent.yMin) || !Number.isFinite(yExtent.yMax)) {
    return null;
  }
  const yLo = Math.min(yExtent.yMin, yExtent.yMax);
  const yHi = Math.max(yExtent.yMin, yExtent.yMax);
  return {
    data,
    y,
    aabb: {
      min: [prev.min[0], yLo, prev.min[2]],
      max: [prev.max[0], yHi, prev.max[2]],
    },
  };
}

/**
 * Clear stream colormap domain override on setOption.
 *
 * Product rule:
 * - Always clear when user data identity changes (stream teardown).
 * - Clear when series **transitions** into explicit domain (auto→explicit), so a prior
 *   auto stream override cannot sit over the new fixed series domain.
 * - Clear when series yMin/yMax values change (user retuned the fixed domain).
 * - Do **not** clear solely because `yDomainExplicit` is already true — style-only
 *   setOption (colormap/lighting/contours, same data) must preserve intentional
 *   update-level `replaceY` domain (`setFromUpdate`).
 */
export function shouldClearSurfaceDomainOnSetOption(opts: {
  readonly streamCleared: boolean;
  readonly yDomainExplicit: boolean;
  readonly seriesYMin: number;
  readonly seriesYMax: number;
  /** Previous resolved series domain from last setOption; null on first seed. */
  readonly prev:
    | {
        readonly yDomainExplicit: boolean;
        readonly yMin: number;
        readonly yMax: number;
      }
    | null
    | undefined;
}): boolean {
  if (opts.streamCleared) return true;
  const prev = opts.prev;
  if (prev == null) {
    // First seed of this slot — no prior series domain to compare; keep any stream
    // override (usually null until updateSurface3D).
    return false;
  }
  // auto → explicit: drop stale auto stream override
  if (opts.yDomainExplicit && !prev.yDomainExplicit) return true;
  // Series colormap domain values changed (explicit retune or auto re-resolve shift)
  if (opts.seriesYMin !== prev.yMin || opts.seriesYMax !== prev.yMax) return true;
  return false;
}

/**
 * High-level domain action after applySurface3DUpdate (for tests / coordinator branching).
 */
export type SurfaceDomainAction =
  | { readonly kind: 'setFromUpdate'; readonly yMin: number; readonly yMax: number }
  | { readonly kind: 'expandStrip' }
  | { readonly kind: 'clearToSeriesExplicit' }
  | { readonly kind: 'autoFull' }
  | { readonly kind: 'noop' };

export function resolveSurfaceDomainAction(
  update: Surface3DUpdate,
  result: Surface3DStreamResult,
  yDomainExplicit: boolean
): SurfaceDomainAction {
  if (result.yMin != null && result.yMax != null && !result.recomputeDomain) {
    return { kind: 'setFromUpdate', yMin: result.yMin, yMax: result.yMax };
  }
  if (
    shouldExpandStripDomain({
      mode: update.mode,
      scrollX: update.mode === 'appendColumns' ? update.scrollX : undefined,
      columns: update.mode === 'appendColumns' ? update.columns : undefined,
      recomputeDomain: result.recomputeDomain,
      yDomainExplicit,
    })
  ) {
    return { kind: 'expandStrip' };
  }
  if (result.recomputeDomain) {
    if (yDomainExplicit) return { kind: 'clearToSeriesExplicit' };
    return { kind: 'autoFull' };
  }
  return { kind: 'noop' };
}
