/**
 * Axis label layout helpers used by renderAxisLabels.
 * @module axisLabelHelpers
 */

import type { TextOverlayAnchor } from '../../../components/createTextOverlay';

const LABEL_PADDING_CSS_PX = 4;

/**
 * CSS px slack from the plot left/right rails within which an X tick is treated
 * as an edge tick for text anchoring. Outside this band, labels are centered on
 * the tick (required for nice majors that sit inset from the domain ends).
 */
export const X_TICK_EDGE_ANCHOR_SLACK_CSS_PX = 12;

export function getYAxisLabelX(plotLeftCss: number, tickLengthCssPx: number): number {
  return plotLeftCss - tickLengthCssPx - LABEL_PADDING_CSS_PX;
}

export function getRightYAxisLabelX(plotRightCss: number, tickLengthCssPx: number): number {
  return plotRightCss + tickLengthCssPx + LABEL_PADDING_CSS_PX;
}

export function getYAxisTitleX(yLabelX: number, maxTickLabelWidth: number, titleFontSize: number): number {
  const yTickLabelLeft = yLabelX - maxTickLabelWidth;
  return yTickLabelLeft - LABEL_PADDING_CSS_PX - titleFontSize * 0.5;
}

export function getRightYAxisTitleX(yLabelX: number, maxTickLabelWidth: number, titleFontSize: number): number {
  const yTickLabelRight = yLabelX + maxTickLabelWidth;
  return yTickLabelRight + LABEL_PADDING_CSS_PX + titleFontSize * 0.5;
}

/**
 * Horizontal text anchor for an X tick label so the glyph sits under the mark.
 *
 * Index-based start/end (first/last tick) misaligns labels when majors are a
 * nice ladder *inset* from the domain ends (streaming value X). Only hug the
 * plot rail when the tick is actually near that edge; otherwise center.
 *
 * @param xCss - Tick position in canvas CSS px
 * @param plotLeftCss - Plot left edge in canvas CSS px
 * @param plotRightCss - Plot right edge in canvas CSS px
 * @param edgeSlackCssPx - Proximity band for rail hugging (default {@link X_TICK_EDGE_ANCHOR_SLACK_CSS_PX})
 */
export function resolveXTickLabelAnchor(
  xCss: number,
  plotLeftCss: number,
  plotRightCss: number,
  edgeSlackCssPx: number = X_TICK_EDGE_ANCHOR_SLACK_CSS_PX
): TextOverlayAnchor {
  if (!Number.isFinite(xCss) || !Number.isFinite(plotLeftCss) || !Number.isFinite(plotRightCss)) {
    return 'middle';
  }
  const left = Math.min(plotLeftCss, plotRightCss);
  const right = Math.max(plotLeftCss, plotRightCss);
  const slack = Number.isFinite(edgeSlackCssPx) ? Math.max(0, edgeSlackCssPx) : X_TICK_EDGE_ANCHOR_SLACK_CSS_PX;
  if (xCss <= left + slack) return 'start';
  if (xCss >= right - slack) return 'end';
  return 'middle';
}
