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
  generateLinearTicks,
} from '../axis/computeAxisTicks';
import { getAxisTitleFontSize } from '../../../utils/axisLabelStyling';
import { getRightYAxisLabelX, getYAxisLabelX, getRightYAxisTitleX, getYAxisTitleX } from '../axis/axisLabelHelpers';

const DEFAULT_TICK_LENGTH_CSS_PX = 6;
const LABEL_PADDING_CSS_PX = 4;
const DEFAULT_TICK_COUNT = 5;

/** Context for rendering X-axis labels and titles. */
interface AxisLabelRenderContext {
  readonly gpuContext: { readonly canvas: HTMLCanvasElement | null };
  readonly currentOptions: ResolvedChartGPUOptions;
  readonly xScale: ContinuousScale | LinearScale;
  readonly xTickValues: readonly number[];
  readonly plotClipRect: { left: number; right: number; top: number; bottom: number };
  readonly visibleXRangeMs: number;
}

/** Context for rendering a single Y-axis's tick labels and title. */
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

/** Title weight matches `styleAxisLabelSpan` in axisLabelStyling (600). */
const AXIS_TITLE_FONT_WEIGHT = '600';

function styleAxisLabelSpan(span: HTMLSpanElement, isTitle: boolean, theme: ResolvedChartGPUOptions['theme']): void {
  span.style.fontFamily = theme.fontFamily;
  span.style.fontWeight = isTitle ? AXIS_TITLE_FONT_WEIGHT : '400';
  span.style.userSelect = 'none';
  span.style.pointerEvents = 'none';
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
  const xLabelY = plotBottomCss + xTickLengthCssPx + LABEL_PADDING_CSS_PX + currentOptions.theme.fontSize * 0.5;
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

    const anchor: TextOverlayAnchor =
      xTickValues.length === 1 ? 'middle' : i === 0 ? 'start' : i === xTickValues.length - 1 ? 'end' : 'middle';
    const label = xTickFormatter
      ? xTickFormatter(v)
      : isTimeXAxis
        ? formatTimeTickValue(v, visibleXRangeMs)
        : isLogXAxis
          ? formatLogTickValue(v, xLogBase)
          : formatTickValue(xFormatter!, v);
    if (label == null) continue;

    const span = axisLabelOverlay.addLabel(label, offsetX + xCss, offsetY + xLabelY, {
      fontSize: currentOptions.theme.fontSize,
      color: currentOptions.theme.textColor,
      fontFamily: currentOptions.theme.fontFamily,
      anchor,
    });
    styleAxisLabelSpan(span, false, currentOptions.theme);
  }

  // X-axis title
  const axisNameFontSize = getAxisTitleFontSize(currentOptions.theme.fontSize);
  const xAxisName = currentOptions.xAxis.name?.trim() ?? '';
  if (xAxisName.length > 0) {
    const xCenter = (plotLeftCss + plotRightCss) / 2;
    const xTickLabelsBottom = xLabelY + currentOptions.theme.fontSize * 0.5;
    const hasSliderZoom = currentOptions.dataZoom?.some((z) => z?.type === 'slider') ?? false;
    const sliderTrackHeightCssPx = 32;
    const bottomLimitCss = hasSliderZoom ? canvasCssHeight - sliderTrackHeightCssPx : canvasCssHeight;
    const xTitleY = (xTickLabelsBottom + bottomLimitCss) / 2;

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
        : generateLinearTicks(
            yDomainMin,
            yDomainMax,
            (yAxisConfig as { tickCount?: number }).tickCount ?? DEFAULT_TICK_COUNT
          );
  const yTickCount = yTickValues.length;
  const yTickStep = yTickCount <= 1 ? 0 : (yDomainMax - yDomainMin) / (yTickCount - 1);
  const yFormatter = isLogY ? null : createTickFormatter(yTickStep);

  const yLabelX = isRight
    ? getRightYAxisLabelX(plotRightCss, yTickLengthCssPx)
    : getYAxisLabelX(plotLeftCss, yTickLengthCssPx);

  const yTickFormatter = yAxisConfig.tickFormatter;
  // Canvas text overlay returns a dummy span — measure tick widths via 2d context
  // (getBoundingClientRect on pooled/dummy spans is 0).
  let measureCtx: CanvasRenderingContext2D | null = null;
  try {
    const c = document.createElement('canvas');
    measureCtx = c.getContext('2d');
    if (measureCtx) {
      measureCtx.font = `${theme.fontSize}px ${theme.fontFamily}`;
    }
  } catch {
    measureCtx = null;
  }
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

  // Y-axis title
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
