/**
 * Per-chart stacked mountain geometry cache (prepare-time baselines).
 *
 * Owned by the render coordinator instance — **not** process-global — so
 * multi-chart dashboards do not share stale peer baselines.
 *
 * Cache key includes data ref, point count, stack id, yAxis, membership,
 * connectNulls, and visibility so setOption regroup / append growth / legend
 * toggle recompute correctly. Call {@link invalidateStackedMountainCache} on
 * every site that clears `lastSetSeriesCache` and after append flush.
 *
 * @module stackedMountainCache
 * @internal
 */

import type { ResolvedSeriesConfig } from '../../../config/OptionResolver';
import type { CartesianSeriesData } from '../../../config/types';
import { getPointCount, getX } from '../../../data/cartesianData';
import {
  computeStackedAreaBaselines,
  groupStackedMountainLayers,
  isStackedMountainSeries,
  normalizeStackId,
  selectStackedMountainSourceData,
  type StackLayerGeometry,
} from '../../../data/stackedArea';

type StackGeomEntry = StackLayerGeometry & {
  /** Owned stroke columns with y = yTop (line draws at layer ceiling). */
  strokeData: CartesianSeriesData;
  /** Data view used for geometry (may be filterGaps output when connectNulls). */
  packData: CartesianSeriesData;
};

type StackedMountainGeometryMap = Map<number, StackGeomEntry>;

export type StackedMountainCache = {
  /** Fingerprint of last successful build. */
  fingerprint: string | null;
  byIndex: StackedMountainGeometryMap | null;
  /**
   * Persistent object→ordinal map so data ref identity is stable across builds
   * (recreating a per-build WeakMap would re-number objects in index order and
   * miss peer data swaps).
   */
  refIds: WeakMap<object, number>;
  nextRefId: number;
};

export function createStackedMountainCache(): StackedMountainCache {
  return { fingerprint: null, byIndex: null, refIds: new WeakMap(), nextRefId: 1 };
}

export function invalidateStackedMountainCache(cache: StackedMountainCache): void {
  cache.fingerprint = null;
  cache.byIndex = null;
  // Keep refIds so identities remain stable after explicit invalidate.
}

/**
 * Stable fingerprint: series count + per-index
 * (stacked? | stackId | yAxis | dataRefId | pointCount | connectNulls | visible).
 * Data refs use identity via cache-owned WeakMap ordinals.
 */
function buildFingerprint(
  seriesForRender: ReadonlyArray<ResolvedSeriesConfig>,
  dataViews: ReadonlyArray<CartesianSeriesData | null>,
  cache: StackedMountainCache
): string {
  const parts: string[] = [String(seriesForRender.length)];
  for (let i = 0; i < seriesForRender.length; i++) {
    const s = seriesForRender[i]!;
    const stacked = isStackedMountainSeries(s);
    if (!stacked) {
      parts.push(`${i}:-`);
      continue;
    }
    const stackId = normalizeStackId((s as { stack?: unknown }).stack);
    const yAxis = (s as { yAxis?: string }).yAxis ?? 'y';
    const connectNulls = !!(s as { connectNulls?: boolean }).connectNulls;
    const visible = (s as { visible?: boolean }).visible !== false;
    const view = dataViews[i];
    let refKey = '0';
    if (view != null && typeof view === 'object') {
      let id = cache.refIds.get(view as object);
      if (id == null) {
        id = cache.nextRefId++;
        cache.refIds.set(view as object, id);
      }
      refKey = String(id);
    }
    const n = view != null ? getPointCount(view) : 0;
    parts.push(`${i}:${stackId}|${yAxis}|${refKey}|${n}|${connectNulls ? 1 : 0}|${visible ? 1 : 0}`);
  }
  return parts.join(';');
}

/**
 * Resolve the data view used for stack math for one series.
 * Must match pack / hit-test: connectNulls → filtered gaps; sampling none prefers raw.
 * Uses the caller's filterGaps (cached) for identity-stable refs under connectNulls.
 */
function resolveStackDataView(
  series: ResolvedSeriesConfig,
  seriesIndex: number,
  filterGaps: (seriesIndex: number, data: CartesianSeriesData) => CartesianSeriesData
): CartesianSeriesData {
  const s = series as {
    sampling?: string;
    connectNulls?: boolean;
    data?: CartesianSeriesData;
    rawData?: CartesianSeriesData;
  };
  const source = selectStackedMountainSourceData(s);
  if (s.connectNulls) {
    return filterGaps(seriesIndex, source);
  }
  return source;
}

/**
 * Build (or reuse) stack geometries for all **visible** stacked mountain groups.
 */
export function getStackedMountainGeometryMap(
  seriesForRender: ReadonlyArray<ResolvedSeriesConfig>,
  cache: StackedMountainCache,
  filterGaps: (seriesIndex: number, data: CartesianSeriesData) => CartesianSeriesData
): StackedMountainGeometryMap {
  // Visible-only composition (issue 9): hidden layers do not lift stack / hit / bounds.
  const groups = groupStackedMountainLayers(seriesForRender, { includeHidden: false });
  if (groups.size === 0) {
    invalidateStackedMountainCache(cache);
    return new Map();
  }

  const dataViews: Array<CartesianSeriesData | null> = new Array(seriesForRender.length).fill(null);
  for (let i = 0; i < seriesForRender.length; i++) {
    const s = seriesForRender[i]!;
    if (!isStackedMountainSeries(s) || (s as { visible?: boolean }).visible === false) continue;
    dataViews[i] = resolveStackDataView(s, i, filterGaps);
  }

  const fingerprint = buildFingerprint(seriesForRender, dataViews, cache);
  if (cache.byIndex && cache.fingerprint === fingerprint) {
    return cache.byIndex;
  }

  const byIndex = new Map<number, StackGeomEntry>();
  for (const members of groups.values()) {
    const layers = members.map((m) => ({
      seriesIndex: m.seriesIndex,
      data: dataViews[m.seriesIndex] ?? (m.series as { data?: CartesianSeriesData }).data ?? [],
    }));
    const geos = computeStackedAreaBaselines(layers);
    for (let g = 0; g < geos.length; g++) {
      const geo = geos[g]!;
      const data = layers[g]!.data;
      const n = getPointCount(data);
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        x[i] = getX(data, i);
        y[i] = geo.yTop[i]!;
      }
      byIndex.set(geo.seriesIndex, {
        ...geo,
        strokeData: { x, y },
        packData: data,
      });
    }
  }
  cache.fingerprint = fingerprint;
  cache.byIndex = byIndex;
  return byIndex;
}
