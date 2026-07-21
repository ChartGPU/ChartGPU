/**
 * Pure hit-test for error-bar series (stem + caps in domain space, pad in CSS px).
 */

import type { ResolvedErrorBarSeriesConfig } from '../config/OptionResolver';
import {
  computeErrorBarCategoryStep,
  getErrorBarLength,
  getErrorBarPoint,
  isErrorBarSampleDrawable,
  type ErrorBarPoint,
} from '../data/errorBarData';
import {
  errorBarInstanceQuads,
  expandDomainRect,
  pointInDomainRect,
  resolveErrorBarCapLengthDomain,
  resolveErrorBarStemHalfWidthDomain,
  type DomainRect,
} from '../renderers/errorBarGeometry';
import type { ContinuousScale } from '../utils/scales';

export type ErrorBarHitMatch = Readonly<{
  readonly seriesIndex: number;
  readonly dataIndex: number;
  readonly point: ErrorBarPoint;
  readonly series: ResolvedErrorBarSeriesConfig;
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

/**
 * Invert continuous scale: CSS plot pixel → domain.
 */
function invertCss(scale: ContinuousScale, cssPx: number): number {
  if (typeof scale.invert === 'function') {
    return scale.invert(cssPx);
  }
  return cssPx;
}

/**
 * Hit-test error bars under a pointer in plot CSS coordinates.
 * Prefer later series indices when multiple series are provided (caller orders).
 */
export function findErrorBarAtPointer(
  seriesList: ReadonlyArray<{
    readonly seriesIndex: number;
    readonly series: ResolvedErrorBarSeriesConfig;
  }>,
  plotXCss: number,
  plotYCss: number,
  xScale: ContinuousScale,
  yScale: ContinuousScale,
  plotSizeCss: { readonly width: number; readonly height: number },
  options?: { readonly padCssPx?: number }
): ErrorBarHitMatch | null {
  const padCss = options?.padCssPx ?? DEFAULT_HIT_PAD_CSS_PX;
  const domainX = invertCss(xScale, plotXCss);
  const domainY = invertCss(yScale, plotYCss);
  if (!Number.isFinite(domainX) || !Number.isFinite(domainY)) return null;

  for (let si = seriesList.length - 1; si >= 0; si--) {
    const entry = seriesList[si]!;
    const series = entry.series;
    if (series.visible === false) continue;

    const data = series.data;
    const n = getErrorBarLength(data);
    if (n === 0) continue;

    const horizontal = series.direction === 'horizontal';
    // Category step for % capWidth: Δx vertical, Δy horizontal (Issue 6).
    const categoryStep = computeErrorBarCategoryStep(data, series.direction);
    const borderW =
      typeof series.itemStyle.borderWidth === 'number' && Number.isFinite(series.itemStyle.borderWidth)
        ? Math.max(1, series.itemStyle.borderWidth)
        : 1.5;

    const stemWidthDomain = horizontal
      ? cssToDomainY(borderW, yScale, plotSizeCss.height)
      : cssToDomainX(borderW, xScale, plotSizeCss.width);
    const stemHalf = resolveErrorBarStemHalfWidthDomain(stemWidthDomain);
    const capThickDomain = horizontal
      ? cssToDomainX(borderW, xScale, plotSizeCss.width)
      : cssToDomainY(borderW, yScale, plotSizeCss.height);
    const capHalfThick = capThickDomain * 0.5;

    let capWidthAsDomain: number | undefined;
    if (typeof series.capWidth === 'number' && Number.isFinite(series.capWidth)) {
      capWidthAsDomain = horizontal
        ? cssToDomainY(series.capWidth, yScale, plotSizeCss.height)
        : cssToDomainX(series.capWidth, xScale, plotSizeCss.width);
    }
    const capFull = resolveErrorBarCapLengthDomain({
      capWidth: series.capWidth,
      categoryStep,
      capWidthAsDomain,
    });
    const capHalf = capFull * 0.5;

    const padX = cssToDomainX(padCss, xScale, plotSizeCss.width);
    const padY = cssToDomainY(padCss, yScale, plotSizeCss.height);

    // Stem thickness pad uses the stem cross-axis; cap thickness pad uses the stem axis.
    // Horizontal: stem is horizontal → padY for stem thickness, padX for cap thickness (Issue 12).
    const stemPadCross = horizontal ? padY : padX;
    const capPadThick = horizontal ? padX : padY;

    let best: ErrorBarHitMatch | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let i = 0; i < n; i++) {
      const p = getErrorBarPoint(data, i);
      if (!isErrorBarSampleDrawable(p, series.errorMode)) continue;

      const quads = errorBarInstanceQuads({
        x: p.x,
        y: p.y,
        high: p.high,
        low: p.low,
        stemHalf: Math.max(stemHalf, stemPadCross * 0.25),
        capHalf,
        capHalfThick: Math.max(capHalfThick, capPadThick * 0.25),
        errorMode: series.errorMode,
        drawWhiskers: series.drawWhiskers,
        drawConnector: series.drawConnector,
        direction: series.direction,
      });

      const parts: DomainRect[] = [];
      if (quads.stem) parts.push(expandDomainRect(quads.stem, padX, padY));
      if (quads.highCap) parts.push(expandDomainRect(quads.highCap, padX, padY));
      if (quads.lowCap) parts.push(expandDomainRect(quads.lowCap, padX, padY));

      let hit = false;
      for (let k = 0; k < parts.length; k++) {
        if (pointInDomainRect(domainX, domainY, parts[k]!)) {
          hit = true;
          break;
        }
      }
      if (!hit && series.showCenter) {
        const halfSymX = cssToDomainX(series.symbolSize * 0.5 + padCss, xScale, plotSizeCss.width);
        const halfSymY = cssToDomainY(series.symbolSize * 0.5 + padCss, yScale, plotSizeCss.height);
        if (Math.abs(domainX - p.x) <= halfSymX && Math.abs(domainY - p.y) <= halfSymY) {
          hit = true;
        }
      }
      if (!hit) continue;

      const dx = domainX - p.x;
      const dy = domainY - p.y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = {
          seriesIndex: entry.seriesIndex,
          dataIndex: i,
          point: p,
          series,
        };
      }
    }
    if (best) return best;
  }
  return null;
}
