/**
 * Sampling / baseline dirty predicates (P1-7).
 *
 * Separates "raw data / sampling config dirty" from "presentation dirty" so
 * theme/legend/tooltip-only option updates can patch series metadata without
 * re-running the multi-stage CPU sampling pipeline.
 *
 * @module samplingDirty
 */

import type {
  ResolvedChartGPUOptions,
  ResolvedPieSeriesConfig,
  ResolvedSeriesConfig,
} from '../../../config/OptionResolver';
import type { DataPoint } from '../../../config/types';

type WithContentHash = {
  readonly contentHash?: number;
  readonly rawData?: unknown;
  readonly data?: unknown;
  readonly sampling?: unknown;
  readonly samplingThreshold?: unknown;
  readonly connectNulls?: unknown;
  readonly type?: string;
  readonly areaStyle?: unknown;
};

/**
 * Cheap structural + content check: did series raw data change?
 *
 * Uses reference equality first. When the raw ref is stable, compares
 * `contentHash` when both sides present and differ. Note: normal
 * `resolveOptions` identity-reuses contentHash for a stable data reference, so
 * in-place value mutations under the same array are **not** detected on the
 * public setOption path (callers must pass a new data reference or use
 * `appendData`). A differing contentHash under the same ref is only meaningful
 * if a caller/test manually supplies hashes.
 */
export function didSeriesDataLikelyChange(
  prev: ResolvedChartGPUOptions['series'],
  next: ResolvedChartGPUOptions['series']
): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.type !== b.type) return true;

    if (a.type === 'pie') {
      const aPie = a as ResolvedPieSeriesConfig;
      const bPie = b as ResolvedPieSeriesConfig;
      if (aPie.data !== bPie.data) return true;
      if (aPie.data.length !== bPie.data.length) return true;
    } else if (a.type === 'heatmap') {
      const aHm = a as { data?: { z?: unknown; columns?: number; rows?: number } };
      const bHm = b as { data?: { z?: unknown; columns?: number; rows?: number } };
      if (aHm.data?.z !== bHm.data?.z) return true;
      if (aHm.data?.columns !== bHm.data?.columns || aHm.data?.rows !== bHm.data?.rows) return true;
      // New series config identity with same z ref still counts as a change for setOption streams.
      if (a !== b) return true;
    } else {
      const aAny = a as WithContentHash;
      const bAny = b as WithContentHash;
      const aRaw = (aAny.rawData ?? aAny.data) as ReadonlyArray<DataPoint>;
      const bRaw = (bAny.rawData ?? bAny.data) as ReadonlyArray<DataPoint>;
      if (aRaw !== bRaw) return true;
      // Same ref: prefer contentHash when both present (in-place mutation).
      if (
        typeof aAny.contentHash === 'number' &&
        typeof bAny.contentHash === 'number' &&
        aAny.contentHash !== bAny.contentHash
      ) {
        return true;
      }
      // Fallback length check for arrays without hash (defensive).
      if (Array.isArray(aRaw) && Array.isArray(bRaw) && aRaw.length !== bRaw.length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when line series has a truthy `areaStyle` (forces CPU sampling path;
 * see `isGpuDecimationEligible`).
 */
function lineHasAreaStyle(series: unknown): boolean {
  if (!series || typeof series !== 'object') return false;
  const s = series as { readonly type?: string; readonly areaStyle?: unknown };
  return s.type === 'line' && s.areaStyle != null;
}

/**
 * True when sampling algorithm, threshold, connectNulls, or GPU-eligibility
 * inputs (line `areaStyle` presence) changed for any series.
 * These force baseline re-sample even when the raw data reference is stable.
 */
function didSamplingConfigChange(
  prev: ResolvedChartGPUOptions['series'],
  next: ResolvedChartGPUOptions['series']
): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]! as WithContentHash;
    const b = next[i]! as WithContentHash;
    if (a.sampling !== b.sampling) return true;
    if (a.samplingThreshold !== b.samplingThreshold) return true;
    if ((a.connectNulls ?? false) !== (b.connectNulls ?? false)) return true;
    // areaStyle presence flips GPU vs CPU decimation eligibility (P0-2 / P1-3/4).
    if (lineHasAreaStyle(a) !== lineHasAreaStyle(b)) return true;
  }
  return false;
}

/**
 * Baseline recompute is needed when raw data or sampling-related series config changes.
 * Presentation-only updates (theme, colors, names, legend, tooltip) return false.
 */
export function shouldRecomputeBaselineSampling(
  prev: ResolvedChartGPUOptions['series'],
  next: ResolvedChartGPUOptions['series']
): boolean {
  return didSeriesDataLikelyChange(prev, next) || didSamplingConfigChange(prev, next);
}

type WithRawBoundsMeta = {
  rawData?: unknown;
  rawBounds?: unknown;
  rawBoundsMode?: string;
  data?: unknown;
  contentHash?: number;
};

/**
 * Patch presentation fields from `nextSeries` onto previous baseline/render series
 * while retaining already-sampled `data`, `rawData`, and `contentHash`.
 *
 * **rawBounds:** Prefer `next.rawBounds` when `rawBoundsMode` changes (axes
 * explicit ↔ auto under a stable data ref). Otherwise keep prior bounds so we
 * do not thrash object identity on pure theme/color updates.
 *
 * Used when setOptions is presentation-only so series colors/styles update without LTTB.
 */
export function patchSeriesPresentationKeepingSampledData(
  nextSeries: ResolvedChartGPUOptions['series'],
  previousSampled: ReadonlyArray<ResolvedSeriesConfig>
): ResolvedSeriesConfig[] {
  // Identity short-circuit: full series-array reuse from OptionResolver (same
  // user series ref) means every entry is === previous — return prior array
  // without allocating N patched objects (group 1 multi-series axes-only).
  if (nextSeries.length === previousSampled.length && nextSeries.length > 0 && nextSeries[0] === previousSampled[0]) {
    let allSame = true;
    for (let i = 1; i < nextSeries.length; i++) {
      if (nextSeries[i] !== previousSampled[i]) {
        allSame = false;
        break;
      }
    }
    if (allSame) {
      return previousSampled as ResolvedSeriesConfig[];
    }
  }

  const out: ResolvedSeriesConfig[] = new Array(nextSeries.length);
  for (let i = 0; i < nextSeries.length; i++) {
    const next = nextSeries[i]!;
    const prev = previousSampled[i];
    if (!prev || prev.type !== next.type || next.type === 'pie' || next.type === 'heatmap') {
      out[i] = next;
      continue;
    }
    // Same resolved object identity (per-series reuse) — keep as-is.
    if (next === prev) {
      out[i] = prev;
      continue;
    }
    const prevAny = prev as ResolvedSeriesConfig & WithRawBoundsMeta;
    const nextAny = next as WithRawBoundsMeta;
    const modeChanged = nextAny.rawBoundsMode != null && nextAny.rawBoundsMode !== prevAny.rawBoundsMode;
    // When axes explicitness changes, OptionResolver recomputed data-driven or
    // synthetic bounds — must not keep sticky prev.rawBounds (synthetic→auto).
    const rawBounds = modeChanged ? (nextAny.rawBounds ?? prevAny.rawBounds) : (prevAny.rawBounds ?? nextAny.rawBounds);
    const rawBoundsMode = modeChanged
      ? (nextAny.rawBoundsMode ?? prevAny.rawBoundsMode)
      : (prevAny.rawBoundsMode ?? nextAny.rawBoundsMode);
    out[i] = {
      ...next,
      rawData: prevAny.rawData ?? nextAny.rawData,
      rawBounds,
      ...(rawBoundsMode != null ? { rawBoundsMode } : {}),
      data: prevAny.data ?? nextAny.data,
      // Keep prior hash so later dirty checks stay consistent with retained content.
      ...(typeof prevAny.contentHash === 'number'
        ? { contentHash: prevAny.contentHash }
        : typeof nextAny.contentHash === 'number'
          ? { contentHash: nextAny.contentHash }
          : {}),
    } as ResolvedSeriesConfig;
  }
  return out;
}

/**
 * True when any series' `rawBoundsMode` changed between prev and next resolve
 * (axes explicitness flip under stable data). Callers should refresh runtime
 * bounds stores that may still hold synthetic extents.
 */
export function didRawBoundsModeChange(
  prev: ResolvedChartGPUOptions['series'],
  next: ResolvedChartGPUOptions['series']
): boolean {
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    const aSeries = prev[i];
    const bSeries = next[i];
    if (!aSeries || !bSeries) continue;
    if (aSeries.type === 'pie' || bSeries.type === 'pie') continue;
    if (aSeries.type === 'heatmap' || bSeries.type === 'heatmap') continue;
    const a = aSeries as WithRawBoundsMeta;
    const b = bSeries as WithRawBoundsMeta;
    if (b.rawBoundsMode != null && a.rawBoundsMode != null && b.rawBoundsMode !== a.rawBoundsMode) {
      return true;
    }
  }
  return false;
}
