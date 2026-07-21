/**
 * Pure hit-test for impulse / stem series (vertical stem + optional marker).
 */

import type { ResolvedImpulseSeriesConfig } from '../config/OptionResolver';
import type { CartesianSeriesData } from '../config/types';
import { getPointCount, getX, getY } from '../data/cartesianData';
import {
  expandImpulseRect,
  impulseMarkerRect,
  impulseStemForSample,
  impulseStemRect,
  pointInImpulseRect,
} from '../data/impulseGeometry';
import type { ContinuousScale } from '../utils/scales';

export type ImpulseHitMatch = Readonly<{
  readonly seriesIndex: number;
  readonly dataIndex: number;
  readonly x: number;
  readonly y: number;
  readonly baseline: number;
  readonly series: ResolvedImpulseSeriesConfig;
}>;

const DEFAULT_HIT_PAD_CSS_PX = 5;

function cssToDomainX(cssPx: number, xScale: ContinuousScale, plotWidthCss: number): number {
  if (!(plotWidthCss > 0) || !(cssPx > 0)) return 0;
  const { min, max } = xScale.getDomain();
  const span = Math.abs(max - min);
  if (!(span > 0)) return 0;
  return (span / plotWidthCss) * cssPx;
}

function cssToDomainY(cssPx: number, yScale: ContinuousScale, plotHeightCss: number): number {
  if (!(plotHeightCss > 0) || !(cssPx > 0)) return 0;
  const { min, max } = yScale.getDomain();
  const span = Math.abs(max - min);
  if (!(span > 0)) return 0;
  return (span / plotHeightCss) * cssPx;
}

function invertCss(scale: ContinuousScale, cssPx: number): number {
  if (typeof scale.invert === 'function') {
    return scale.invert(cssPx);
  }
  return cssPx;
}

/**
 * Hit-test impulse stems under a pointer in plot CSS coordinates.
 * Prefer later series indices when multiple series are provided.
 */
export function findImpulseAtPointer(
  seriesList: ReadonlyArray<{
    readonly seriesIndex: number;
    readonly series: ResolvedImpulseSeriesConfig;
  }>,
  plotXCss: number,
  plotYCss: number,
  xScale: ContinuousScale,
  yScale: ContinuousScale,
  plotSizeCss: { readonly width: number; readonly height: number },
  options?: { readonly padCssPx?: number }
): ImpulseHitMatch | null {
  const padCss = options?.padCssPx ?? DEFAULT_HIT_PAD_CSS_PX;
  const domainX = invertCss(xScale, plotXCss);
  const domainY = invertCss(yScale, plotYCss);
  if (!Number.isFinite(domainX) || !Number.isFinite(domainY)) return null;

  for (let si = seriesList.length - 1; si >= 0; si--) {
    const entry = seriesList[si]!;
    const series = entry.series;
    if (series.visible === false) continue;

    const data = series.data as CartesianSeriesData;
    const n = getPointCount(data);
    if (n === 0) continue;

    const borderW =
      typeof series.lineStyle.width === 'number' && Number.isFinite(series.lineStyle.width)
        ? Math.max(1, series.lineStyle.width)
        : 2;
    const stemHalfDomain = cssToDomainX(borderW, xScale, plotSizeCss.width) * 0.5;
    const padX = cssToDomainX(padCss, xScale, plotSizeCss.width);
    const padY = cssToDomainY(padCss, yScale, plotSizeCss.height);

    const symbolCss =
      typeof series.symbolSize === 'number' && Number.isFinite(series.symbolSize) && series.symbolSize > 0
        ? series.symbolSize
        : 6;
    const markerHalf =
      Math.max(
        cssToDomainX(symbolCss, xScale, plotSizeCss.width),
        cssToDomainY(symbolCss, yScale, plotSizeCss.height)
      ) * 0.5;

    const baseline = Number.isFinite(series.baseline) ? series.baseline : 0;
    const showMarker = series.showMarker !== false;

    // Prefer later data indices when overlapping.
    for (let i = n - 1; i >= 0; i--) {
      const x = getX(data, i);
      const y = getY(data, i);
      const stem = impulseStemForSample(x, y, baseline);
      if (!stem) continue;

      let hit = false;
      const body = impulseStemRect(stem, stemHalfDomain);
      if (body) {
        const padded = expandImpulseRect(body, padX, padY);
        if (pointInImpulseRect(domainX, domainY, padded)) hit = true;
      }
      if (!hit && showMarker) {
        // Marker at tip (also covers zero-length stems when markers are enabled).
        const m = expandImpulseRect(impulseMarkerRect(stem.x, stem.y, markerHalf), padX, padY);
        if (pointInImpulseRect(domainX, domainY, m)) hit = true;
      }
      // Zero-length + showMarker false: no stem body, no marker → miss (D4).

      if (hit) {
        return {
          seriesIndex: entry.seriesIndex,
          dataIndex: i,
          x: stem.x,
          y: stem.y,
          baseline: stem.baseline,
          series,
        };
      }
    }
  }

  return null;
}
