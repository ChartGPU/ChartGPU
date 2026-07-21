/**
 * Per-chart step (digital) expand cache (prepare-time stair geometry).
 *
 * Owned by the render coordinator instance — **not** process-global.
 * Identity-keyed on source data + mode + connectNulls (+ stack columns).
 *
 * **connectNulls contract:** expand always uses `connectNulls: false` in the pure
 * expander because callers pre-filter gaps. The field remains in the cache key so
 * toggles re-expand after the filtered source view changes.
 *
 * **Stable Cartesian refs:** each hit reuses the same `cartesian` / `stackedPack`
 * object so DataStore setSeries and area private-pack skip re-upload on idle frames.
 *
 * @module stepExpandCache
 * @internal
 */

import type { CartesianSeriesData } from '../../../config/types';
import {
  expandStepPolyline,
  expandStepStacked,
  stepPolylineAsCartesian,
  type StepMode,
  type StepPolyline,
  type StepStackedPolyline,
} from '../../../data/stepGeometry';

type StepExpandCacheEntry = {
  source: unknown;
  mode: StepMode;
  connectNulls: boolean;
  poly: StepPolyline;
  /** Stable XY columns view over `poly` — reuse while entry hits. */
  cartesian: CartesianSeriesData;
  stacked?: StepStackedPolyline;
  /** Stable pack view `{ x, y: yTop }` for stacked step area. */
  stackedPack?: CartesianSeriesData;
  stackYBottom?: ArrayLike<number>;
  stackYTop?: ArrayLike<number>;
};

export type StepExpandCache = {
  byIndex: Map<number, StepExpandCacheEntry>;
};

export function createStepExpandCache(): StepExpandCache {
  return { byIndex: new Map() };
}

export function invalidateStepExpandCache(cache: StepExpandCache): void {
  cache.byIndex.clear();
}

/**
 * Expand (or reuse) step polyline for a series. Returns stable `cartesian` identity
 * while source/mode/connectNulls hit — suitable for DataStore setSeries skip.
 */
export function getExpandedStepPolyline(
  cache: StepExpandCache | undefined,
  seriesIndex: number,
  source: CartesianSeriesData,
  mode: StepMode,
  connectNulls: boolean
): { readonly poly: StepPolyline; readonly cartesian: CartesianSeriesData } {
  const hit = cache?.byIndex.get(seriesIndex);
  if (
    hit &&
    hit.source === source &&
    hit.mode === mode &&
    hit.connectNulls === connectNulls &&
    hit.poly &&
    hit.cartesian
  ) {
    return { poly: hit.poly, cartesian: hit.cartesian };
  }
  // Pre-filter contract: expand without connectNulls bridging (caller already filtered).
  const poly = expandStepPolyline(source, mode, { connectNulls: false });
  const cartesian = stepPolylineAsCartesian(poly);
  if (cache) {
    // Drop stacked fields on poly-only rewrite so stale stack columns cannot linger.
    cache.byIndex.set(seriesIndex, {
      source,
      mode,
      connectNulls,
      poly,
      cartesian,
    });
  }
  return { poly, cartesian };
}

/**
 * Expand (or reuse) stacked step geometry. Returns stable `stackedPack` identity.
 */
export function getExpandedStepStacked(
  cache: StepExpandCache | undefined,
  seriesIndex: number,
  source: CartesianSeriesData,
  yBottom: ArrayLike<number>,
  yTop: ArrayLike<number>,
  mode: StepMode,
  connectNulls: boolean
): {
  readonly stacked: StepStackedPolyline;
  readonly stackedPack: CartesianSeriesData;
  readonly strokeData: CartesianSeriesData;
} {
  const hit = cache?.byIndex.get(seriesIndex);
  if (
    hit &&
    hit.source === source &&
    hit.mode === mode &&
    hit.connectNulls === connectNulls &&
    hit.stackYBottom === yBottom &&
    hit.stackYTop === yTop &&
    hit.stacked &&
    hit.stackedPack
  ) {
    return {
      stacked: hit.stacked,
      stackedPack: hit.stackedPack,
      strokeData: hit.stackedPack,
    };
  }
  const stacked = expandStepStacked(source, yBottom, yTop, mode, { connectNulls: false });
  const stackedPack = { x: stacked.x, y: stacked.yTop } as CartesianSeriesData;
  if (cache) {
    cache.byIndex.set(seriesIndex, {
      source,
      mode,
      connectNulls,
      poly: { x: stacked.x, y: stacked.yTop },
      cartesian: stackedPack,
      stacked,
      stackedPack,
      stackYBottom: yBottom,
      stackYTop: yTop,
    });
  }
  return { stacked, stackedPack, strokeData: stackedPack };
}
