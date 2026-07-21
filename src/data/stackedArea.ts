/**
 * Pure stacked mountain / area composition math.
 *
 * Multi-series layers sharing a non-empty `stack` id compose fills between
 * cumulative yBottom and yTop (positive up / negative down — bar parity).
 * Never mutates caller-owned data.
 *
 * @module stackedArea
 * @internal
 */

import type { CartesianSeriesData } from '../config/types';
import { filterGaps, getPointCount, getX, getY, type Bounds } from './cartesianData';

/**
 * Normalize a stack group id (shared semantics with bar `stack`).
 * Empty / non-string → unstacked (`''`).
 */
export function normalizeStackId(stack: unknown): string {
  if (typeof stack !== 'string') return '';
  const trimmed = stack.trim();
  return trimmed.length > 0 ? trimmed : '';
}

/**
 * True when a series participates in mountain/area stack composition:
 * non-empty stack id + (type area, or type line with areaStyle).
 */
export function isStackedMountainSeries(series: {
  readonly type?: string;
  readonly stack?: unknown;
  readonly areaStyle?: unknown;
}): boolean {
  if (normalizeStackId(series.stack) === '') return false;
  if (series.type === 'area') return true;
  if (series.type === 'line' && series.areaStyle != null) return true;
  return false;
}

/**
 * Source series data for stack geometry / pack / hit-test.
 * `sampling === 'none'` prefers rawData (matches prepare path).
 */
export function selectStackedMountainSourceData(series: {
  readonly sampling?: string;
  readonly data?: CartesianSeriesData;
  readonly rawData?: CartesianSeriesData;
}): CartesianSeriesData {
  return series.sampling === 'none'
    ? ((series.rawData ?? series.data ?? []) as CartesianSeriesData)
    : ((series.data ?? series.rawData ?? []) as CartesianSeriesData);
}

/**
 * Data view used for stack baselines, pack, and hit-test.
 * When `connectNulls` is true, gaps are stripped via {@link filterGaps} so
 * composition matches the drawn fill (prepare uses the same filtered view).
 *
 * Pure equivalent of prepare's `resolveStackDataView` without a filterGaps cache.
 */
export function resolveStackedMountainDataView(series: {
  readonly sampling?: string;
  readonly connectNulls?: boolean;
  readonly data?: CartesianSeriesData;
  readonly rawData?: CartesianSeriesData;
}): CartesianSeriesData {
  const source = selectStackedMountainSourceData(series);
  if (series.connectNulls) {
    return filterGaps(source) as CartesianSeriesData;
  }
  return source;
}

export type StackLayerSpec = Readonly<{
  seriesIndex: number;
  data: CartesianSeriesData;
}>;

export type StackLayerGeometry = Readonly<{
  seriesIndex: number;
  /** Per-point floor (baseline). Length = point count. NaN where sample invalid. */
  yBottom: Float64Array;
  /** Per-point ceiling = yBottom + contribution (pos/neg rules). */
  yTop: Float64Array;
}>;

/**
 * True when all layers share equal length and equal finite x[i] at every index
 * (or matching non-finite x). Enables O(n×layers) index-aligned stacking.
 */
export function canAlignStackedAreaByIndex(layers: ReadonlyArray<StackLayerSpec>): boolean {
  if (layers.length <= 1) return true;
  const n0 = getPointCount(layers[0]!.data);
  for (let L = 1; L < layers.length; L++) {
    if (getPointCount(layers[L]!.data) !== n0) return false;
  }
  for (let i = 0; i < n0; i++) {
    const x0 = getX(layers[0]!.data, i);
    const x0Fin = Number.isFinite(x0);
    for (let L = 1; L < layers.length; L++) {
      const x = getX(layers[L]!.data, i);
      const xFin = Number.isFinite(x);
      if (x0Fin !== xFin) return false;
      if (x0Fin && x !== x0) return false;
    }
  }
  return true;
}

function computeIndexAligned(layers: ReadonlyArray<StackLayerSpec>): StackLayerGeometry[] {
  const n = layers.length === 0 ? 0 : getPointCount(layers[0]!.data);
  const posSum = new Float64Array(n);
  const negSum = new Float64Array(n);
  const out: StackLayerGeometry[] = [];

  for (let L = 0; L < layers.length; L++) {
    const layer = layers[L]!;
    const data = layer.data;
    const yBottom = new Float64Array(n);
    const yTop = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      const y = getY(data, i);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        yBottom[i] = Number.NaN;
        yTop[i] = Number.NaN;
        continue;
      }
      if (y >= 0) {
        const base = posSum[i]!;
        yBottom[i] = base;
        yTop[i] = base + y;
        posSum[i] = yTop[i]!;
      } else {
        const base = negSum[i]!;
        yBottom[i] = base;
        yTop[i] = base + y;
        negSum[i] = yTop[i]!;
      }
    }
    out.push({ seriesIndex: layer.seriesIndex, yBottom, yTop });
  }
  return out;
}

function computeXKeyAligned(layers: ReadonlyArray<StackLayerSpec>): StackLayerGeometry[] {
  const posSum = new Map<number, number>();
  const negSum = new Map<number, number>();
  const out: StackLayerGeometry[] = [];

  for (let L = 0; L < layers.length; L++) {
    const layer = layers[L]!;
    const data = layer.data;
    const n = getPointCount(data);
    const yBottom = new Float64Array(n);
    const yTop = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      const y = getY(data, i);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        yBottom[i] = Number.NaN;
        yTop[i] = Number.NaN;
        continue;
      }
      if (y >= 0) {
        const base = posSum.get(x) ?? 0;
        yBottom[i] = base;
        yTop[i] = base + y;
        posSum.set(x, yTop[i]!);
      } else {
        const base = negSum.get(x) ?? 0;
        yBottom[i] = base;
        yTop[i] = base + y;
        negSum.set(x, yTop[i]!);
      }
    }
    out.push({ seriesIndex: layer.seriesIndex, yBottom, yTop });
  }
  return out;
}

/**
 * Compute per-layer yBottom / yTop for one stack group (series already ordered
 * bottom → top). Positive and negative contributions stack independently from 0.
 *
 * X alignment (D3): equal-x by index when possible; otherwise x-value keys with
 * missing peers contributing 0.
 */
export function computeStackedAreaBaselines(layers: ReadonlyArray<StackLayerSpec>): StackLayerGeometry[] {
  if (layers.length === 0) return [];
  if (canAlignStackedAreaByIndex(layers)) {
    return computeIndexAligned(layers);
  }
  return computeXKeyAligned(layers);
}

/**
 * Y extent across stacked tops/bottoms for auto domain (includes composition totals).
 */
export function computeStackedYExtents(geometries: ReadonlyArray<StackLayerGeometry>): {
  yMin: number;
  yMax: number;
} | null {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let g = 0; g < geometries.length; g++) {
    const { yBottom, yTop } = geometries[g]!;
    const n = Math.min(yBottom.length, yTop.length);
    for (let i = 0; i < n; i++) {
      const b = yBottom[i]!;
      const t = yTop[i]!;
      if (Number.isFinite(b)) {
        if (b < yMin) yMin = b;
        if (b > yMax) yMax = b;
      }
      if (Number.isFinite(t)) {
        if (t < yMin) yMin = t;
        if (t > yMax) yMax = t;
      }
    }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  if (yMin === yMax) yMax = yMin + 1;
  return { yMin, yMax };
}

/**
 * Expand cartesian bounds with stacked layer y extents (x from data bounds).
 */
export function expandBoundsWithStackedExtents(
  bounds: Bounds | null | undefined,
  geometries: ReadonlyArray<StackLayerGeometry>
): Bounds | null {
  const ext = computeStackedYExtents(geometries);
  if (!ext) return bounds ?? null;
  if (!bounds) {
    return { xMin: 0, xMax: 1, yMin: ext.yMin, yMax: ext.yMax };
  }
  return {
    xMin: bounds.xMin,
    xMax: bounds.xMax,
    yMin: Math.min(bounds.yMin, ext.yMin),
    yMax: Math.max(bounds.yMax, ext.yMax),
  };
}

/**
 * Stack total at a domain x for a completed geometry set (pos tops + |neg bottoms|).
 * Uses the last layer that has a sample at x (or nearest index for equal-length peers).
 *
 * Returns `posCumulative + negCumulative` where pos is the highest pos top and
 * neg is the lowest (most negative) neg bottom at that x — i.e. net stack span origin at 0.
 * For all-positive stacks this equals the top layer's yTop.
 */
export function stackTotalAtX(
  layers: ReadonlyArray<StackLayerSpec>,
  geometries: ReadonlyArray<StackLayerGeometry>,
  xTarget: number
): number | null {
  if (!Number.isFinite(xTarget) || layers.length === 0) return null;
  let posTop = 0;
  let negBottom = 0;
  let found = false;
  for (let L = 0; L < layers.length; L++) {
    const data = layers[L]!.data;
    const geo = geometries[L];
    if (!geo) continue;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      if (!Number.isFinite(x) || x !== xTarget) continue;
      const t = geo.yTop[i]!;
      const b = geo.yBottom[i]!;
      if (!Number.isFinite(t) || !Number.isFinite(b)) continue;
      found = true;
      if (t > posTop) posTop = t;
      if (b < negBottom) negBottom = b;
      if (t < negBottom) negBottom = t;
      if (b > posTop) posTop = b;
    }
  }
  if (!found) return null;
  // Net composition: max top − min bottom when spanning both sides, else the extreme.
  if (posTop > 0 && negBottom < 0) return posTop + negBottom; // e.g. 5 + (-2) = 3 net
  if (posTop > 0) return posTop;
  if (negBottom < 0) return negBottom;
  return 0;
}

/**
 * Prefer topmost layer under cursor y in domain space at the nearest sample x.
 * Returns seriesIndex + dataIndex + contribution y + stackTotal.
 */
export function findStackedMountainHit(args: {
  readonly layers: ReadonlyArray<StackLayerSpec>;
  readonly geometries: ReadonlyArray<StackLayerGeometry>;
  readonly xTarget: number;
  readonly yTarget: number;
  /** Max |x - xTarget| in domain units to accept a sample (caller maps from px). */
  readonly xTolerance: number;
}): {
  seriesIndex: number;
  dataIndex: number;
  contributionY: number;
  yBottom: number;
  yTop: number;
  stackTotal: number;
  x: number;
} | null {
  const { layers, geometries, xTarget, yTarget, xTolerance } = args;
  if (!Number.isFinite(xTarget) || !Number.isFinite(yTarget)) return null;
  const tol = Number.isFinite(xTolerance) && xTolerance >= 0 ? xTolerance : 0;

  type Cand = {
    seriesIndex: number;
    dataIndex: number;
    contributionY: number;
    yBottom: number;
    yTop: number;
    x: number;
    layerOrder: number;
    dx: number;
  };
  let best: Cand | null = null;

  for (let L = 0; L < layers.length; L++) {
    const data = layers[L]!.data;
    const geo = geometries[L];
    if (!geo) continue;
    const n = getPointCount(data);
    for (let i = 0; i < n; i++) {
      const x = getX(data, i);
      const y = getY(data, i);
      const b = geo.yBottom[i]!;
      const t = geo.yTop[i]!;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(b) || !Number.isFinite(t)) continue;
      const dx = Math.abs(x - xTarget);
      if (dx > tol) continue;
      const lo = Math.min(b, t);
      const hi = Math.max(b, t);
      // Inclusive band; zero-height segments (y≈0) still count if yTarget equals.
      if (yTarget < lo || yTarget > hi) continue;
      const cand: Cand = {
        seriesIndex: layers[L]!.seriesIndex,
        dataIndex: i,
        contributionY: y,
        yBottom: b,
        yTop: t,
        x,
        layerOrder: L,
        dx,
      };
      // Prefer closer x, then higher layer order (topmost).
      if (best === null || cand.dx < best.dx || (cand.dx === best.dx && cand.layerOrder > best.layerOrder)) {
        best = cand;
      }
    }
  }

  if (!best) return null;
  const total = stackTotalAtX(layers, geometries, best.x);
  return {
    seriesIndex: best.seriesIndex,
    dataIndex: best.dataIndex,
    contributionY: best.contributionY,
    yBottom: best.yBottom,
    yTop: best.yTop,
    stackTotal: total ?? best.yTop,
    x: best.x,
  };
}

/**
 * Group resolved mountain series by `${yAxis}\\0${stackId}` preserving array order.
 * Only series that pass {@link isStackedMountainSeries} are included.
 *
 * Default: **visible series only** (legend-hidden layers do not participate in
 * composition, bounds, or hit). Pass `includeHidden: true` only for tooling.
 */
export function groupStackedMountainLayers<
  T extends {
    readonly type?: string;
    readonly stack?: unknown;
    readonly areaStyle?: unknown;
    readonly yAxis?: string;
    readonly data?: unknown;
    readonly visible?: boolean;
  },
>(
  series: ReadonlyArray<T>,
  options?: Readonly<{ includeHidden?: boolean }>
): Map<string, Array<{ seriesIndex: number; series: T }>> {
  const includeHidden = options?.includeHidden === true;
  const groups = new Map<string, Array<{ seriesIndex: number; series: T }>>();
  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    if (!includeHidden && s.visible === false) continue;
    if (!isStackedMountainSeries(s)) continue;
    const stackId = normalizeStackId(s.stack);
    const yAxis = s.yAxis ?? 'y';
    const key = `${yAxis}\0${stackId}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push({ seriesIndex: i, series: s });
  }
  return groups;
}

/**
 * Stacked composition Y extents for one axis (visible peers only by default).
 * Used by OptionResolver and runtime auto-Y so contribution-only rawBounds
 * cannot clip stacked peaks after append / stream.
 *
 * When `xWindow` is set, only samples with x in [min,max] contribute (visible zoom).
 */
export function computeStackedMountainYExtentsForAxis<
  T extends {
    readonly type?: string;
    readonly stack?: unknown;
    readonly areaStyle?: unknown;
    readonly yAxis?: string;
    readonly data?: unknown;
    readonly rawData?: unknown;
    readonly visible?: boolean;
  },
>(
  series: ReadonlyArray<T>,
  axisId: string,
  options?: Readonly<{
    includeHidden?: boolean;
    xWindow?: { readonly min: number; readonly max: number } | null;
    /** Prefer rawData over data when both present (runtime seed). */
    preferRawData?: boolean;
  }>
): { yMin: number; yMax: number } | null {
  const groups = groupStackedMountainLayers(series, { includeHidden: options?.includeHidden === true });
  if (groups.size === 0) return null;

  const filterX =
    options?.xWindow != null && Number.isFinite(options.xWindow.min) && Number.isFinite(options.xWindow.max);
  const xMinW = filterX ? options!.xWindow!.min : 0;
  const xMaxW = filterX ? options!.xWindow!.max : 0;

  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  let any = false;

  for (const [key, members] of groups) {
    // Key is `${yAxis}\0${stackId}`
    const yAxis = key.split('\0')[0] ?? 'y';
    if (yAxis !== axisId) continue;

    const layers = members.map((m) => {
      const s = m.series as { data?: unknown; rawData?: unknown };
      const data =
        options?.preferRawData === true
          ? ((s.rawData ?? s.data ?? []) as CartesianSeriesData)
          : ((s.data ?? s.rawData ?? []) as CartesianSeriesData);
      return { seriesIndex: m.seriesIndex, data };
    });
    const geos = computeStackedAreaBaselines(layers);
    for (let g = 0; g < geos.length; g++) {
      const geo = geos[g]!;
      const data = layers[g]!.data;
      const n = Math.min(geo.yBottom.length, geo.yTop.length, getPointCount(data));
      for (let i = 0; i < n; i++) {
        if (filterX) {
          const x = getX(data, i);
          if (!Number.isFinite(x) || x < xMinW || x > xMaxW) continue;
        }
        const b = geo.yBottom[i]!;
        const t = geo.yTop[i]!;
        if (Number.isFinite(b)) {
          any = true;
          if (b < yMin) yMin = b;
          if (b > yMax) yMax = b;
        }
        if (Number.isFinite(t)) {
          any = true;
          if (t < yMin) yMin = t;
          if (t > yMax) yMax = t;
        }
      }
    }
  }

  if (!any || !Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  if (yMin === yMax) yMax = yMin + 1;
  return { yMin, yMax };
}
