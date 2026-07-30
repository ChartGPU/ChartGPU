/**
 * Axis Label Rendering Utilities
 *
 * Generates DOM-based axis labels and titles for cartesian charts.
 * Labels are positioned using canvas-local CSS coordinates and rendered
 * into a text overlay element.
 *
 * @module renderAxisLabels
 */

import type { ResolvedChartGPUOptions } from '../../../config/OptionResolver';
import type { AxisConfig } from '../../../config/types';
import type { ContinuousScale, LinearScale } from '../../../utils/scales';
import type { TextOverlay, TextOverlayAnchor } from '../../../components/createTextOverlay';
import { getCanvasCssWidth, getCanvasCssHeight } from '../utils/canvasUtils';
import { formatTimeTickValue } from '../utils/timeAxisUtils';
import {
  formatTickValue,
  createTickFormatter,
  formatLogTickValue,
  generateLogTicksForVisibleDomain,
  generateValueAxisTicks,
} from '../axis/computeAxisTicks';
import { AXIS_TITLE_FONT_WEIGHT, getAxisTitleFontSize, styleAxisLabelSpan } from '../../../utils/axisLabelStyling';
import {
  getRightYAxisLabelX,
  getYAxisLabelX,
  getRightYAxisTitleX,
  getYAxisTitleX,
  resolveXTickLabelAnchor,
} from '../axis/axisLabelHelpers';

const DEFAULT_TICK_LENGTH_CSS_PX = 6;
const LABEL_PADDING_CSS_PX = 4;
const DEFAULT_TICK_COUNT = 5;

/** Cached 2d measure context — avoid createElement('canvas') on every Y label pass. */
let sharedMeasureCanvas: HTMLCanvasElement | null = null;
let sharedMeasureCtx: CanvasRenderingContext2D | null = null;
let sharedMeasureFontKey = '';

function getSharedMeasureCtx(fontSize: number, fontFamily: string): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  try {
    if (!sharedMeasureCanvas) {
      sharedMeasureCanvas = document.createElement('canvas');
      sharedMeasureCtx = sharedMeasureCanvas.getContext('2d');
    }
    if (!sharedMeasureCtx) return null;
    const key = `${fontSize}|${fontFamily}`;
    if (key !== sharedMeasureFontKey) {
      sharedMeasureCtx.font = `${fontSize}px ${fontFamily}`;
      sharedMeasureFontKey = key;
    }
    return sharedMeasureCtx;
  } catch {
    return null;
  }
}

/** Context for rendering X-axis labels and titles. */
interface AxisLabelRenderContext {
  readonly gpuContext: { readonly canvas: HTMLCanvasElement | null };
  readonly currentOptions: ResolvedChartGPUOptions;
  readonly xScale: ContinuousScale | LinearScale;
  readonly xTickValues: readonly number[];
  readonly plotClipRect: { left: number; right: number; top: number; bottom: number };
  readonly visibleXRangeMs: number;
}

/** Context for rendering a single Y-axis's tick labels, title, and optional header. */
interface YAxisLabelRenderContext {
  readonly axisLabelOverlay: TextOverlay | null;
  readonly overlayContainer: HTMLElement | null;
  readonly yAxisConfig: AxisConfig;
  readonly yScale: ContinuousScale | LinearScale;
  readonly plotClipRect: { left: number; right: number; top: number; bottom: number };
  readonly canvasCssWidth: number;
  readonly canvasCssHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly theme: ResolvedChartGPUOptions['theme'];
  /** Optional precomputed tick domain values (log majors). */
  readonly yTickValues?: readonly number[];
}

function clipXToCanvasCssPx(xClip: number, canvasCssWidth: number): number {
  return ((xClip + 1) / 2) * canvasCssWidth;
}

function clipYToCanvasCssPx(yClip: number, canvasCssHeight: number): number {
  return ((1 - yClip) / 2) * canvasCssHeight;
}

/**
 * Renders X-axis tick labels, titles and clears the overlay for re-use.
 * Y-axis labels are handled separately by renderYAxisLabels().
 */
export function renderAxisLabels(
  axisLabelOverlay: TextOverlay | null,
  overlayContainer: HTMLElement | null,
  context: AxisLabelRenderContext
): void {
  const { gpuContext, currentOptions, xScale, xTickValues, plotClipRect, visibleXRangeMs } = context;

  const hasCartesianSeries = currentOptions.series.some((s) => s.type !== 'pie');
  if (!hasCartesianSeries || !axisLabelOverlay || !overlayContainer) {
    return;
  }

  const canvas = gpuContext.canvas;
  if (!canvas) return;

  const canvasCssWidth = getCanvasCssWidth(canvas as HTMLCanvasElement);
  const canvasCssHeight = getCanvasCssHeight(canvas as HTMLCanvasElement);
  if (canvasCssWidth <= 0 || canvasCssHeight <= 0) return;

  const offsetX = (canvas as HTMLCanvasElement).offsetLeft || 0;
  const offsetY = (canvas as HTMLCanvasElement).offsetTop || 0;

  const plotLeftCss = clipXToCanvasCssPx(plotClipRect.left, canvasCssWidth);
  const plotRightCss = clipXToCanvasCssPx(plotClipRect.right, canvasCssWidth);
  const plotBottomCss = clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeight);

  // Clear axis label overlay (Y-axis labels will be re-added by renderYAxisLabels)
  axisLabelOverlay.clear();

  // X-axis tick labels
  const xTickLengthCssPx = currentOptions.xAxis.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
  const xFontSize = currentOptions.theme.fontSize;
  // textBaseline middle: keep full glyph inside canvas (overflow:hidden shells clip flush bottoms).
  const maxXLabelCenterY = canvasCssHeight - xFontSize * 0.5 - 1;
  const xLabelY = Math.min(plotBottomCss + xTickLengthCssPx + LABEL_PADDING_CSS_PX + xFontSize * 0.5, maxXLabelCenterY);
  const isTimeXAxis = currentOptions.xAxis.type === 'time';
  const isLogXAxis = currentOptions.xAxis.type === 'log';
  const xLogBase = currentOptions.xAxis.logBase ?? 10;
  const xFormatter = (() => {
    if (isTimeXAxis || isLogXAxis) return null;
    // Step from visible ticks / scale domain so decimal precision tracks zoom.
    const xTickCount = xTickValues.length;
    let xTickStep = 0;
    if (xTickCount >= 2) {
      xTickStep = Math.abs(xTickValues[1]! - xTickValues[0]!);
    } else {
      const xd = xScale.getDomain();
      xTickStep = Math.abs(xd.max - xd.min);
    }
    return createTickFormatter(xTickStep);
  })();

  const xTickFormatter = currentOptions.xAxis.tickFormatter;
  for (let i = 0; i < xTickValues.length; i++) {
    const v = xTickValues[i]!;
    const xClip = xScale.scale(v);
    const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);

    // Anchor by proximity to the plot rails — not by first/last index. Nice
    // majors (streaming value X) sit inset from domain ends; index-based
    // start/end shifted those labels off the GPU tick / grid line.
    const anchor: TextOverlayAnchor =
      xTickValues.length === 1 ? 'middle' : resolveXTickLabelAnchor(xCss, plotLeftCss, plotRightCss);
    const label = xTickFormatter
      ? xTickFormatter(v)
      : isTimeXAxis
        ? formatTimeTickValue(v, visibleXRangeMs)
        : isLogXAxis
          ? formatLogTickValue(v, xLogBase)
          : formatTickValue(xFormatter!, v);
    if (label == null) continue;

    const span = axisLabelOverlay.addLabel(label, offsetX + xCss, offsetY + xLabelY, {
      fontSize: xFontSize,
      color: currentOptions.theme.textColor,
      fontFamily: currentOptions.theme.fontFamily,
      anchor,
    });
    styleAxisLabelSpan(span, false, currentOptions.theme);
  }

  // X-axis title
  const axisNameFontSize = getAxisTitleFontSize(xFontSize);
  const xAxisName = currentOptions.xAxis.name?.trim() ?? '';
  if (xAxisName.length > 0) {
    const xCenter = (plotLeftCss + plotRightCss) / 2;
    const xTickLabelsBottom = xLabelY + xFontSize * 0.5;
    const hasSliderZoom = currentOptions.dataZoom?.some((z) => z?.type === 'slider') ?? false;
    const sliderTrackHeightCssPx = 32;
    const bottomLimitCss = hasSliderZoom ? canvasCssHeight - sliderTrackHeightCssPx : canvasCssHeight;
    const maxXTitleCenterY = bottomLimitCss - axisNameFontSize * 0.5 - 1;
    const xTitleY = Math.min(
      Math.max(
        xTickLabelsBottom + LABEL_PADDING_CSS_PX + axisNameFontSize * 0.5,
        (xTickLabelsBottom + bottomLimitCss) / 2
      ),
      maxXTitleCenterY
    );

    const span = axisLabelOverlay.addLabel(xAxisName, offsetX + xCenter, offsetY + xTitleY, {
      fontSize: axisNameFontSize,
      color: currentOptions.theme.textColor,
      fontFamily: currentOptions.theme.fontFamily,
      fontWeight: AXIS_TITLE_FONT_WEIGHT,
      anchor: 'middle',
    });
    styleAxisLabelSpan(span, true, currentOptions.theme);
  }
}

/**
 * Renders tick labels and a title for a single Y-axis into the shared overlay.
 * Called once per Y-axis after renderAxisLabels() has cleared the overlay.
 */
export function renderYAxisLabels(ctx: YAxisLabelRenderContext): void {
  const {
    axisLabelOverlay,
    overlayContainer,
    yAxisConfig,
    yScale,
    plotClipRect,
    canvasCssWidth,
    canvasCssHeight,
    offsetX,
    offsetY,
    theme,
    yTickValues: yTickValuesOpt,
  } = ctx;
  if (!axisLabelOverlay || !overlayContainer) return;
  if (canvasCssWidth <= 0 || canvasCssHeight <= 0) return;

  const plotLeftCss = clipXToCanvasCssPx(plotClipRect.left, canvasCssWidth);
  const plotRightCss = clipXToCanvasCssPx(plotClipRect.right, canvasCssWidth);
  const plotTopCss = clipYToCanvasCssPx(plotClipRect.top, canvasCssHeight);
  const plotBottomCss = clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeight);

  const isRight = yAxisConfig.position === 'right';
  const yTickLengthCssPx = yAxisConfig.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;

  // Prefer the live scale domain so ticks track any visible window (same as X zoom path).
  // Explicit axis min/max still feed the scale via base-domain computation upstream.
  const scaleDomain = yScale.getDomain();
  const yDomainMin = scaleDomain.min;
  const yDomainMax = scaleDomain.max;
  const isLogY = yAxisConfig.type === 'log';
  const logBase = yAxisConfig.logBase ?? 10;
  const yTickValues =
    yTickValuesOpt != null && yTickValuesOpt.length > 0
      ? yTickValuesOpt
      : isLogY
        ? generateLogTicksForVisibleDomain(yDomainMin, yDomainMax, logBase)
        : generateValueAxisTicks(yDomainMin, yDomainMax, yAxisConfig.tickCount ?? DEFAULT_TICK_COUNT);
  const yTickCount = yTickValues.length;
  // Prefer actual nice step between majors for decimal precision (not domain / (n-1)).
  const yTickStep = yTickCount <= 1 ? 0 : Math.abs(yTickValues[Math.min(1, yTickCount - 1)]! - yTickValues[0]!);
  const yFormatter = isLogY ? null : createTickFormatter(yTickStep);

  const yLabelX = isRight
    ? getRightYAxisLabelX(plotRightCss, yTickLengthCssPx)
    : getYAxisLabelX(plotLeftCss, yTickLengthCssPx);

  const yTickFormatter = yAxisConfig.tickFormatter;
  // Canvas text overlay returns a dummy span — measure tick widths via cached 2d context
  // (getBoundingClientRect on pooled/dummy spans is 0). Avoid per-call createElement.
  const measureCtx = getSharedMeasureCtx(theme.fontSize, theme.fontFamily);
  let maxTickLabelWidth = 0;

  for (let i = 0; i < yTickCount; i++) {
    const v = yTickValues[i]!;
    const yClip = yScale.scale(v);
    const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);

    const label = yTickFormatter
      ? yTickFormatter(v)
      : isLogY
        ? formatLogTickValue(v, logBase)
        : formatTickValue(yFormatter!, v);
    if (label == null) continue;

    if (measureCtx) {
      maxTickLabelWidth = Math.max(maxTickLabelWidth, measureCtx.measureText(label).width);
    } else {
      maxTickLabelWidth = Math.max(maxTickLabelWidth, label.length * theme.fontSize * 0.6);
    }

    const span = axisLabelOverlay.addLabel(label, offsetX + yLabelX, offsetY + yCss, {
      fontSize: theme.fontSize,
      color: theme.textColor,
      fontFamily: theme.fontFamily,
      anchor: isRight ? 'start' : 'end',
    });
    styleAxisLabelSpan(span, false, theme);
  }

  // Y-axis unit header (non-rotated, top of axis rail) — independent of rotated `name`.
  const yAxisHeader = yAxisConfig.header?.trim() ?? '';
  if (yAxisHeader.length > 0) {
    // Center sits a full fontSize + padding above plot top so the header em-box clears
    // the top domain tick (textBaseline middle places tick center at plotTopCss).
    // AABB gap to top tick ≈ LABEL_PADDING + fontSize/2 (grows with theme.fontSize).
    const headerY = plotTopCss - LABEL_PADDING_CSS_PX - theme.fontSize;
    const span = axisLabelOverlay.addLabel(yAxisHeader, offsetX + yLabelX, offsetY + headerY, {
      fontSize: theme.fontSize,
      color: theme.textColor,
      fontFamily: theme.fontFamily,
      fontWeight: AXIS_TITLE_FONT_WEIGHT,
      anchor: isRight ? 'start' : 'end',
    });
    styleAxisLabelSpan(span, true, theme);
  }

  // Y-axis title (rotated side label)
  const axisNameFontSize = getAxisTitleFontSize(theme.fontSize);
  const yAxisName = yAxisConfig.name?.trim() ?? '';
  if (yAxisName.length > 0) {
    const yCenter = (plotTopCss + plotBottomCss) / 2;

    const yTitleX = isRight
      ? getRightYAxisTitleX(yLabelX, maxTickLabelWidth, axisNameFontSize)
      : getYAxisTitleX(yLabelX, maxTickLabelWidth, axisNameFontSize);

    const span = axisLabelOverlay.addLabel(yAxisName, offsetX + yTitleX, offsetY + yCenter, {
      fontSize: axisNameFontSize,
      color: theme.textColor,
      fontFamily: theme.fontFamily,
      fontWeight: AXIS_TITLE_FONT_WEIGHT,
      anchor: 'middle',
      rotation: isRight ? 90 : -90,
    });
    styleAxisLabelSpan(span, true, theme);
  }
}
