/**
 * Shared axis label styling utilities.
 */

/**
 * Theme configuration for axis labels.
 */
export interface AxisLabelThemeConfig {
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly textColor: string;
}

/**
 * Calculates the font size for axis titles (larger than regular tick labels).
 */
export function getAxisTitleFontSize(baseFontSize: number): number {
  return Math.max(baseFontSize + 1, Math.round(baseFontSize * 1.15));
}

/** Title weight for axis name labels. */
export const AXIS_TITLE_FONT_WEIGHT = '600';

/**
 * Applies consistent styling to an axis label span element.
 */
export function styleAxisLabelSpan(span: HTMLSpanElement, isTitle: boolean, theme: AxisLabelThemeConfig): void {
  span.dir = 'auto';
  span.style.fontFamily = theme.fontFamily;
  span.style.fontWeight = isTitle ? AXIS_TITLE_FONT_WEIGHT : '400';
  span.style.userSelect = 'none';
  span.style.pointerEvents = 'none';
}
