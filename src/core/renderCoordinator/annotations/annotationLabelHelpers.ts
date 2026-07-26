/**
 * Shared annotation label formatting helpers.
 * Used by processAnnotations (GPU + label build) and renderAnnotationLabels (DOM).
 *
 * @module annotationLabelHelpers
 * @internal
 */

import type { TextOverlayAnchor } from '../../../components/createTextOverlay';
import { parseCssColorToRgba01 } from '../../../utils/colors';
import { clamp01 } from '../utils/axisUtils';

/**
 * Converts color and opacity to CSS rgba() string.
 */
export function toCssRgba(color: string, opacity01: number): string {
  const base = parseCssColorToRgba01(color) ?? ([0, 0, 0, 1] as const);
  const a = clamp01(base[3] * clamp01(opacity01));
  const r = Math.round(clamp01(base[0]) * 255);
  const g = Math.round(clamp01(base[1]) * 255);
  const b = Math.round(clamp01(base[2]) * 255);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Formats number with optional decimal precision.
 */
function formatAnnotationNumber(n: number, decimals?: number): string {
  if (!Number.isFinite(n)) return '';
  if (decimals == null) return String(n);
  const d = Math.min(20, Math.max(0, Math.floor(decimals)));
  return n.toFixed(d);
}

// PERFORMANCE: Cache regex pattern (compiled once, lastIndex reset per call)
const templateRegex = /\{(x|y|value|name)\}/g;

/**
 * Renders template string with value substitution.
 * Supports {x}, {y}, {value}, and {name} placeholders.
 */
export function renderAnnotationTemplate(
  template: string,
  values: Readonly<{ x?: number; y?: number; value?: number; name?: string }>,
  decimals?: number
): string {
  templateRegex.lastIndex = 0;
  return template.replace(templateRegex, (_m, key) => {
    if (key === 'name') return values.name ?? '';
    const v = (values as Record<string, number | string | undefined>)[key as string] as number | undefined;
    return v == null ? '' : formatAnnotationNumber(v, decimals);
  });
}

/**
 * Maps annotation anchor to text overlay anchor.
 */
export function mapAnnotationAnchor(anchor: 'start' | 'center' | 'end' | undefined): TextOverlayAnchor {
  switch (anchor) {
    case 'center':
      return 'middle';
    case 'end':
      return 'end';
    case 'start':
    default:
      return 'start';
  }
}
