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
  return Math.max(
    baseFontSize + 1,
    Math.round(baseFontSize * 1.15)
  );
}

/**
 * Applies consistent styling to an axis label span element.
 */
export function styleAxisLabelSpan(
  span: HTMLSpanElement,
  isTitle: boolean,
  theme: AxisLabelThemeConfig
): void {
  // Set inline styles
  span.dir = 'auto';
  span.style.fontFamily = theme.fontFamily;

  // Axis titles are bold
  if (isTitle) {
    span.style.fontWeight = '600';
  }
}

