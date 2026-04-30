/**
 * Axis label positioning and layout helpers.
 *
 * Provides pure functions for calculating axis label positions, anchor points,
 * and title placements without DOM manipulation. These helpers are used by the
 * render coordinator to position axis labels and titles correctly.
 *
 * @module axisLabelHelpers
 */

import type { TextOverlayAnchor } from "../../../components/createTextOverlay";

/**
 * Default label padding in CSS pixels.
 */
export const LABEL_PADDING_CSS_PX = 4;

/**
 * Calculates the anchor point for an x-axis tick label.
 *
 * - Single tick: centered
 * - First tick: left-aligned (start)
 * - Last tick: right-aligned (end)
 * - Middle ticks: centered (middle)
 *
 * @param tickIndex - Index of the current tick
 * @param totalTicks - Total number of ticks
 * @returns Text anchor for label positioning
 */
export function getXAxisTickLabelAnchor(
  tickIndex: number,
  totalTicks: number,
): TextOverlayAnchor {
  if (totalTicks === 1) return "middle";
  if (tickIndex === 0) return "start";
  if (tickIndex === totalTicks - 1) return "end";
  return "middle";
}

/**
 * Calculates the Y position for x-axis labels.
 *
 * X-axis labels are positioned below the plot area, with spacing for tick marks.
 *
 * @param plotBottomCss - Bottom edge of plot area in CSS pixels
 * @param tickLengthCssPx - Length of tick marks
 * @param fontSize - Font size for labels
 * @returns Y position in CSS pixels (canvas-local)
 */
export function getXAxisLabelY(
  plotBottomCss: number,
  tickLengthCssPx: number,
  fontSize: number,
): number {
  return (
    plotBottomCss + tickLengthCssPx + LABEL_PADDING_CSS_PX + fontSize * 0.5
  );
}

/**
 * Calculates the X position for y-axis labels.
 *
 * Y-axis labels are positioned to the left of the plot area, with spacing for tick marks.
 *
 * @param plotLeftCss - Left edge of plot area in CSS pixels
 * @param tickLengthCssPx - Length of tick marks
 * @returns X position in CSS pixels (canvas-local)
 */
export function getYAxisLabelX(
  plotLeftCss: number,
  tickLengthCssPx: number,
): number {
  return plotLeftCss - tickLengthCssPx - LABEL_PADDING_CSS_PX;
}

/**
 * Calculates the X position for right y-axis labels.
 *
 * @param plotRightCss - Right edge of plot area in CSS pixels
 * @param tickLengthCssPx - Length of tick marks
 * @returns X position in CSS pixels (canvas-local)
 */
export function getRightYAxisLabelX(
  plotRightCss: number,
  tickLengthCssPx: number,
): number {
  return plotRightCss + tickLengthCssPx + LABEL_PADDING_CSS_PX;
}

/**
 * Calculates the Y position for the x-axis title.
 *
 * The title is centered vertically between the tick labels and the bottom edge
 * (or zoom slider if present).
 *
 * @param xLabelY - Y position of x-axis tick labels
 * @param fontSize - Font size for tick labels
 * @param canvasCssHeight - Canvas height in CSS pixels
 * @param hasSliderZoom - Whether a slider zoom control is present
 * @param sliderHeightCssPx - Height of slider zoom control (default: 32)
 * @returns Y position for x-axis title in CSS pixels
 */
export function getXAxisTitleY(
  xLabelY: number,
  fontSize: number,
  canvasCssHeight: number,
  hasSliderZoom: boolean,
  sliderHeightCssPx: number = 32,
): number {
  // xLabelY is the vertical center of the tick labels; add half font size to
  // approximate the tick-label "bottom edge"
  const xTickLabelsBottom = xLabelY + fontSize * 0.5;

  // Bottom limit is either canvas height or canvas height minus slider
  const bottomLimitCss = hasSliderZoom
    ? canvasCssHeight - sliderHeightCssPx
    : canvasCssHeight;

  // Center title between tick labels and bottom limit
  return (xTickLabelsBottom + bottomLimitCss) / 2;
}

/**
 * Calculates the X position for the y-axis title.
 *
 * The title is positioned to the left of the tick labels, accounting for their width.
 *
 * @param yLabelX - X position of y-axis tick labels
 * @param maxTickLabelWidth - Maximum width of tick labels in CSS pixels
 * @param titleFontSize - Font size for axis title
 * @returns X position for y-axis title in CSS pixels
 */
export function getYAxisTitleX(
  yLabelX: number,
  maxTickLabelWidth: number,
  titleFontSize: number,
): number {
  const yTickLabelLeft = yLabelX - maxTickLabelWidth;
  return yTickLabelLeft - LABEL_PADDING_CSS_PX - titleFontSize * 0.5;
}

/**
 * Calculates the X position for the right y-axis title.
 *
 * The title is positioned to the right of the tick labels, accounting for their width.
 *
 * @param yLabelX - X position of right y-axis tick labels
 * @param maxTickLabelWidth - Maximum width of tick labels in CSS pixels
 * @param titleFontSize - Font size for axis title
 * @returns X position for y-axis title in CSS pixels
 */
export function getRightYAxisTitleX(
  yLabelX: number,
  maxTickLabelWidth: number,
  titleFontSize: number,
): number {
  const yTickLabelRight = yLabelX + maxTickLabelWidth;
  return yTickLabelRight + LABEL_PADDING_CSS_PX + titleFontSize * 0.5;
}

/**
 * Measures the maximum width of a set of rendered labels.
 *
 * @param labelSpans - Array of HTMLSpanElement labels
 * @returns Maximum width in CSS pixels, or 0 if no labels
 */
export function measureMaxLabelWidth(
  labelSpans: readonly HTMLSpanElement[],
): number {
  if (labelSpans.length === 0) return 0;
  return labelSpans.reduce(
    (max, span) => Math.max(max, span.getBoundingClientRect().width),
    0,
  );
}

/**
 * Calculates the center position between two coordinates.
 *
 * Utility for centering axis titles within plot area.
 *
 * @param a - First coordinate
 * @param b - Second coordinate
 * @returns Midpoint between a and b
 */
export function getCenterPosition(a: number, b: number): number {
  return (a + b) / 2;
}
