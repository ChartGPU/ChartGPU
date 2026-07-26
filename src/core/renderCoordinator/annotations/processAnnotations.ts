/**
 * Annotation processing for the RenderCoordinator.
 *
 * Processes annotation configurations into GPU-renderable instances (reference lines,
 * markers) and DOM label data. Supports layering (above/below series) and multiple
 * annotation types (lineX, lineY, point, text).
 *
 * @module processAnnotations
 */

import type { AnnotationConfig } from '../../../config/types';
import type { LinearScale } from '../../../utils/scales';
import type { ThemeConfig } from '../../../themes/types';
import type { ReferenceLineInstance } from '../../../renderers/createReferenceLineRenderer';
import type { AnnotationMarkerInstance } from '../../../renderers/createAnnotationMarkerRenderer';
import { parseCssColorToRgba01 } from '../../../utils/colors';
import { clipXToCanvasCssPx, clipYToCanvasCssPx, clamp01 } from '../utils/axisUtils';
import { assertUnreachable } from '../utils/dataPointUtils';
import {
  mapAnnotationAnchor as mapAnchor,
  renderAnnotationTemplate as renderTemplate,
  toCssRgba,
} from './annotationLabelHelpers';

/**
 * Internal type for annotation label data (DOM overlay).
 */
interface AnnotationLabelData {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly color?: string;
  readonly fontSize?: number;
  readonly background?: Readonly<{
    readonly backgroundColor: string;
    readonly padding?: readonly [number, number, number, number];
    readonly borderRadius?: number;
  }>;
}

/**
 * Plot bounds in CSS pixels.
 */
interface PlotBounds {
  readonly leftCss: number;
  readonly rightCss: number;
  readonly topCss: number;
  readonly bottomCss: number;
  readonly widthCss: number;
  readonly heightCss: number;
}

/**
 * Context for annotation processing.
 */
interface AnnotationContext {
  readonly annotations: ReadonlyArray<AnnotationConfig>;
  readonly xScale: LinearScale;
  readonly yScales: Map<string, LinearScale>;
  readonly plotBounds: PlotBounds;
  readonly canvasCssWidth: number;
  readonly canvasCssHeight: number;
  readonly theme: ThemeConfig;
  readonly offsetX?: number;
  readonly offsetY?: number;
}

/**
 * Result of annotation processing.
 */
interface AnnotationResult {
  readonly linesBelow: ReferenceLineInstance[];
  readonly linesAbove: ReferenceLineInstance[];
  readonly markersBelow: AnnotationMarkerInstance[];
  readonly markersAbove: AnnotationMarkerInstance[];
  readonly labels: AnnotationLabelData[];
}

/**
 * Resolves annotation RGBA color with opacity.
 *
 * @param color - CSS color string or undefined
 * @param opacity - Opacity value [0, 1] or undefined
 * @param defaultColor - Default color (typically theme text color)
 * @returns RGBA tuple [r, g, b, a] in range [0, 1]
 */
function resolveAnnotationRgba(
  color: string | undefined,
  opacity: number | undefined,
  defaultColor: string
): readonly [number, number, number, number] {
  const base =
    parseCssColorToRgba01(color ?? defaultColor) ?? parseCssColorToRgba01(defaultColor) ?? ([1, 1, 1, 1] as const);
  const o = opacity == null ? 1 : clamp01(opacity);
  return [clamp01(base[0]), clamp01(base[1]), clamp01(base[2]), clamp01(base[3] * o)] as const;
}

/**
 * Processes annotations into GPU-renderable instances and DOM labels.
 *
 * **Annotation Types:**
 * - `lineX`: Vertical reference line at x coordinate
 * - `lineY`: Horizontal reference line at y coordinate
 * - `point`: Marker at (x, y) coordinate
 * - `text`: Text annotation with flexible positioning
 *
 * **Layering:**
 * - `belowSeries`: Rendered before series (occluded by data)
 * - `aboveSeries`: Rendered after series (always visible, default)
 *
 * **Labels:**
 * - Optional text labels for all annotation types
 * - Template support with {x}, {y}, {value}, {name} placeholders
 * - Background styling with padding and border radius
 *
 * @param context - Annotation processing context
 * @returns Annotation result with lines, markers, and labels
 */
export function processAnnotations(context: AnnotationContext): AnnotationResult {
  const {
    annotations,
    xScale,
    yScales,
    plotBounds,
    canvasCssWidth,
    canvasCssHeight,
    theme,
    offsetX = 0,
    offsetY = 0,
  } = context;

  // Use the primary y-axis scale (first entry) for annotation positioning.
  // Future work: support per-annotation yAxis binding.
  const yScale = yScales.values().next().value ?? xScale;

  const { leftCss: plotLeftCss, topCss: plotTopCss, widthCss: plotWidthCss, heightCss: plotHeightCss } = plotBounds;

  // Output arrays (reused across calls for performance)
  const linesBelow: ReferenceLineInstance[] = [];
  const linesAbove: ReferenceLineInstance[] = [];
  const markersBelow: AnnotationMarkerInstance[] = [];
  const markersAbove: AnnotationMarkerInstance[] = [];
  const labels: AnnotationLabelData[] = [];

  // PERFORMANCE: Early exit if no annotations or invalid canvas dimensions
  if (
    annotations.length === 0 ||
    canvasCssWidth <= 0 ||
    canvasCssHeight <= 0 ||
    plotWidthCss <= 0 ||
    plotHeightCss <= 0
  ) {
    return { linesBelow, linesAbove, markersBelow, markersAbove, labels };
  }

  // Process each annotation
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i]!;
    const layer = a.layer ?? 'aboveSeries';
    const targetLines = layer === 'belowSeries' ? linesBelow : linesAbove;
    const targetMarkers = layer === 'belowSeries' ? markersBelow : markersAbove;

    // Resolve annotation styling
    const styleColor = a.style?.color;
    const styleOpacity = a.style?.opacity;
    const lineWidth =
      typeof a.style?.lineWidth === 'number' && Number.isFinite(a.style.lineWidth) ? Math.max(0, a.style.lineWidth) : 1;
    const lineDash = a.style?.lineDash;
    const rgba = resolveAnnotationRgba(styleColor, styleOpacity, theme.textColor);

    // Process annotation by type (GPU rendering)
    switch (a.type) {
      case 'lineX': {
        const xClip = xScale.scale(a.x);
        const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);
        if (!Number.isFinite(xCss)) break;
        targetLines.push({
          axis: 'vertical',
          positionCssPx: xCss,
          lineWidth,
          lineDash,
          rgba,
        });
        break;
      }
      case 'lineY': {
        const yClip = yScale.scale(a.y);
        const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);
        if (!Number.isFinite(yCss)) break;
        targetLines.push({
          axis: 'horizontal',
          positionCssPx: yCss,
          lineWidth,
          lineDash,
          rgba,
        });
        break;
      }
      case 'point': {
        const xClip = xScale.scale(a.x);
        const yClip = yScale.scale(a.y);
        const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);
        const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);
        if (!Number.isFinite(xCss) || !Number.isFinite(yCss)) break;

        const markerSize =
          typeof a.marker?.size === 'number' && Number.isFinite(a.marker.size) ? Math.max(1, a.marker.size) : 6;
        const markerColor = a.marker?.style?.color ?? a.style?.color;
        const markerOpacity = a.marker?.style?.opacity ?? a.style?.opacity;
        const fillRgba = resolveAnnotationRgba(markerColor, markerOpacity, theme.textColor);

        targetMarkers.push({
          xCssPx: xCss,
          yCssPx: yCss,
          sizeCssPx: markerSize,
          fillRgba,
        });
        break;
      }
      case 'text': {
        // Text annotations are handled via DOM overlays (labels), not GPU
        break;
      }
      case 'bandX': {
        // Filled full-height vertical region between two x-domain values, drawn
        // by reusing the vertical reference-line quad: center it and set its
        // width to the pixel span. Meant for `belowSeries` regime highlights.
        const x0 = clipXToCanvasCssPx(xScale.scale(a.from), canvasCssWidth);
        const x1 = clipXToCanvasCssPx(xScale.scale(a.to), canvasCssWidth);
        if (!Number.isFinite(x0) || !Number.isFinite(x1)) break;
        const width = Math.abs(x1 - x0);
        if (!(width > 0)) break;
        targetLines.push({
          axis: 'vertical',
          positionCssPx: (x0 + x1) / 2,
          lineWidth: width,
          lineDash: undefined,
          rgba,
        });
        break;
      }
      default:
        assertUnreachable(a);
    }

    // bandX carries no label and isn't part of the label switch below.
    if (a.type === 'bandX') continue;

    // Process annotation label (DOM overlay)
    const labelCfg = a.label;
    const wantsLabel = labelCfg != null || a.type === 'text';
    if (!wantsLabel) continue;

    // Compute anchor point (canvas-local CSS px)
    let anchorXCss: number | null = null;
    let anchorYCss: number | null = null;
    let values: { x?: number; y?: number; value?: number; name?: string } = {
      name: a.id ?? '',
    };

    switch (a.type) {
      case 'lineX': {
        const xClip = xScale.scale(a.x);
        const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);
        anchorXCss = xCss;
        anchorYCss = plotTopCss;
        values = { ...values, x: a.x, value: a.x };
        break;
      }
      case 'lineY': {
        const yClip = yScale.scale(a.y);
        const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);
        anchorXCss = plotLeftCss;
        // Offset label 8px above the horizontal line (negative Y = upward)
        anchorYCss = yCss - 8;
        values = { ...values, y: a.y, value: a.y };
        break;
      }
      case 'point': {
        const xClip = xScale.scale(a.x);
        const yClip = yScale.scale(a.y);
        const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);
        const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);
        anchorXCss = xCss;
        anchorYCss = yCss;
        values = { ...values, x: a.x, y: a.y, value: a.y };
        break;
      }
      case 'text': {
        if (a.position.space === 'data') {
          const xClip = xScale.scale(a.position.x);
          const yClip = yScale.scale(a.position.y);
          const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);
          const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);
          anchorXCss = xCss;
          anchorYCss = yCss;
          values = {
            ...values,
            x: a.position.x,
            y: a.position.y,
            value: a.position.y,
          };
        } else {
          const xCss = plotLeftCss + a.position.x * plotWidthCss;
          const yCss = plotTopCss + a.position.y * plotHeightCss;
          anchorXCss = xCss;
          anchorYCss = yCss;
          values = {
            ...values,
            x: a.position.x,
            y: a.position.y,
            value: a.position.y,
          };
        }
        break;
      }
      default:
        assertUnreachable(a);
    }

    if (anchorXCss == null || anchorYCss == null || !Number.isFinite(anchorXCss) || !Number.isFinite(anchorYCss)) {
      continue;
    }

    // Cull labels that are far outside the visible plot area
    const cullMargin = 200;
    if (
      anchorXCss < plotBounds.leftCss - cullMargin ||
      anchorXCss > plotBounds.leftCss + plotBounds.widthCss + cullMargin ||
      anchorYCss < plotBounds.topCss - cullMargin ||
      anchorYCss > plotBounds.topCss + plotBounds.heightCss + cullMargin
    ) {
      continue;
    }

    // Apply label offset
    const dx = labelCfg?.offset?.[0] ?? 0;
    const dy = labelCfg?.offset?.[1] ?? 0;
    const x = anchorXCss + dx;
    const y = anchorYCss + dy;

    // Label text selection (explicit > template > defaults)
    const text =
      labelCfg?.text ??
      (labelCfg?.template
        ? renderTemplate(labelCfg.template, values, labelCfg.decimals)
        : labelCfg
          ? (() => {
              const defaultTemplate =
                a.type === 'lineX'
                  ? 'x={x}'
                  : a.type === 'lineY'
                    ? 'y={y}'
                    : a.type === 'point'
                      ? '({x}, {y})'
                      : a.type === 'text'
                        ? a.text
                        : '';
              return defaultTemplate.includes('{')
                ? renderTemplate(defaultTemplate, values, labelCfg.decimals)
                : defaultTemplate;
            })()
          : a.type === 'text'
            ? a.text
            : '');

    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed.length === 0) continue;

    // Label styling
    const anchor = mapAnchor(labelCfg?.anchor);
    const color = a.style?.color ?? theme.textColor;
    const fontSize = theme.fontSize;

    // Background styling
    const bg = labelCfg?.background;
    const bgColor = bg?.color != null ? toCssRgba(bg.color, bg.opacity ?? 1) : undefined;
    const padding = (() => {
      const p = bg?.padding;
      if (typeof p === 'number' && Number.isFinite(p)) return [p, p, p, p] as const;
      if (Array.isArray(p) && p.length === 4 && p.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return [p[0], p[1], p[2], p[3]] as const;
      }
      return bg ? ([2, 4, 2, 4] as const) : undefined;
    })();
    const borderRadius =
      typeof bg?.borderRadius === 'number' && Number.isFinite(bg.borderRadius) ? bg.borderRadius : undefined;

    // Create label data
    const labelData: AnnotationLabelData = {
      text: trimmed,
      x: offsetX + x,
      y: offsetY + y,
      anchor,
      color,
      fontSize,
      ...(bgColor
        ? {
            background: {
              backgroundColor: bgColor,
              ...(padding ? { padding } : {}),
              ...(borderRadius != null ? { borderRadius } : {}),
            },
          }
        : {}),
    };

    labels.push(labelData);
  }

  return {
    linesBelow,
    linesAbove,
    markersBelow,
    markersAbove,
    labels,
  };
}
