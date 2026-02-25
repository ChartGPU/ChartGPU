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
import type { LinearScale } from '../../../utils/scales';
import type { TextOverlay, TextOverlayAnchor } from '../../../components/createTextOverlay';
import { getCanvasCssWidth, getCanvasCssHeight } from '../utils/canvasUtils';
import { formatTimeTickValue } from '../utils/timeAxisUtils';
import { formatTickValue, createTickFormatter } from '../axis/computeAxisTicks';
import { finiteOrUndefined } from '../utils/dataPointUtils';
import { getAxisTitleFontSize } from '../../../utils/axisLabelStyling';

const DEFAULT_TICK_LENGTH_CSS_PX = 6;
const LABEL_PADDING_CSS_PX = 4;
const DEFAULT_TICK_COUNT = 5;

export interface AxisLabelRenderContext {
  gpuContext: {
    canvas: HTMLCanvasElement | null;
  };
  currentOptions: ResolvedChartGPUOptions;
  xScale: LinearScale;
  yScale: LinearScale;
  xTickValues: ReadonlyArray<number>;
  plotClipRect: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  visibleXRangeMs: number;
}

function clipXToCanvasCssPx(xClip: number, canvasCssWidth: number): number {
  return ((xClip + 1) / 2) * canvasCssWidth;
}

function clipYToCanvasCssPx(yClip: number, canvasCssHeight: number): number {
  return ((1 - yClip) / 2) * canvasCssHeight;
}

function styleAxisLabelSpan(span: HTMLSpanElement, isTitle: boolean, theme: ResolvedChartGPUOptions['theme']): void {
  span.style.fontFamily = theme.fontFamily;
  span.style.fontWeight = isTitle ? '500' : '400';
  span.style.userSelect = 'none';
  span.style.pointerEvents = 'none';
}

/**
 * Renders axis labels and titles to the text overlay.
 *
 * Generates X and Y axis tick labels with appropriate formatting,
 * and renders axis titles if configured.
 *
 * @param axisLabelOverlay - Text overlay for rendering labels
 * @param overlayContainer - DOM container for overlay positioning
 * @param context - Rendering context with scales, options, and layout
 */
export function renderAxisLabels(
  axisLabelOverlay: TextOverlay | null,
  overlayContainer: HTMLElement | null,
  context: AxisLabelRenderContext
): void {
  const { gpuContext, currentOptions, xScale, yScale, xTickValues, plotClipRect, visibleXRangeMs } = context;

  const hasCartesianSeries = currentOptions.series.some((s) => s.type !== 'pie');
  if (!hasCartesianSeries || !axisLabelOverlay || !overlayContainer) {
    return;
  }

  const canvas = gpuContext.canvas;
  if (!canvas) return;

  // Get canvas dimensions
  const canvasCssWidth = getCanvasCssWidth(canvas as HTMLCanvasElement);
  const canvasCssHeight = getCanvasCssHeight(canvas as HTMLCanvasElement);
  if (canvasCssWidth <= 0 || canvasCssHeight <= 0) return;

  // Calculate offsets (only for HTMLCanvasElement with DOM)
  const offsetX = (canvas as HTMLCanvasElement).offsetLeft || 0;
  const offsetY = (canvas as HTMLCanvasElement).offsetTop || 0;

  const plotLeftCss = clipXToCanvasCssPx(plotClipRect.left, canvasCssWidth);
  const plotRightCss = clipXToCanvasCssPx(plotClipRect.right, canvasCssWidth);
  const plotTopCss = clipYToCanvasCssPx(plotClipRect.top, canvasCssHeight);
  const plotBottomCss = clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeight);

  // Clear axis label overlay
  axisLabelOverlay.clear();

  // X-axis tick labels
  const xTickLengthCssPx = currentOptions.xAxis.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
  const xLabelY = plotBottomCss + xTickLengthCssPx + LABEL_PADDING_CSS_PX + currentOptions.theme.fontSize * 0.5;
  const isTimeXAxis = currentOptions.xAxis.type === 'time';
  const xFormatter = (() => {
    if (isTimeXAxis) return null;
    const xDomainMin = finiteOrUndefined(currentOptions.xAxis.min) ?? xScale.invert(plotClipRect.left);
    const xDomainMax = finiteOrUndefined(currentOptions.xAxis.max) ?? xScale.invert(plotClipRect.right);
    const xTickCount = xTickValues.length;
    const xTickStep = xTickCount === 1 ? 0 : (xDomainMax - xDomainMin) / (xTickCount - 1);
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
        : formatTickValue(xFormatter!, v);
    if (label == null) continue;

    const span = axisLabelOverlay.addLabel(label, offsetX + xCss, offsetY + xLabelY, {
      fontSize: currentOptions.theme.fontSize,
      color: currentOptions.theme.textColor,
      anchor,
    });
    styleAxisLabelSpan(span, false, currentOptions.theme);
  }

  // Y-axis tick labels
  const yTickCount = DEFAULT_TICK_COUNT;
  const yTickLengthCssPx = currentOptions.yAxis.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
  const yDomainMin = finiteOrUndefined(currentOptions.yAxis.min) ?? yScale.invert(plotClipRect.bottom);
  const yDomainMax = finiteOrUndefined(currentOptions.yAxis.max) ?? yScale.invert(plotClipRect.top);
  const yTickStep = yTickCount <= 1 ? 0 : (yDomainMax - yDomainMin) / (yTickCount - 1);
  const yFormatter = createTickFormatter(yTickStep);
  const yLabelX = plotLeftCss - yTickLengthCssPx - LABEL_PADDING_CSS_PX;
  const ySpans: HTMLSpanElement[] = [];

  const yTickFormatter = currentOptions.yAxis.tickFormatter;
  for (let i = 0; i < yTickCount; i++) {
    const t = yTickCount <= 1 ? 0.5 : i / (yTickCount - 1);
    const v = yDomainMin + t * (yDomainMax - yDomainMin);
    const yClip = yScale.scale(v);
    const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);

    const label = yTickFormatter ? yTickFormatter(v) : formatTickValue(yFormatter, v);
    if (label == null) continue;

    const span = axisLabelOverlay.addLabel(label, offsetX + yLabelX, offsetY + yCss, {
      fontSize: currentOptions.theme.fontSize,
      color: currentOptions.theme.textColor,
      anchor: 'end',
    });
    styleAxisLabelSpan(span, false, currentOptions.theme);
    ySpans.push(span);
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
      anchor: 'middle',
    });
    styleAxisLabelSpan(span, true, currentOptions.theme);
  }

  // Y-axis title
  const yAxisName = currentOptions.yAxis.name?.trim() ?? '';
  if (yAxisName.length > 0) {
    // Measure actual rendered label widths from DOM
    const maxTickLabelWidth =
      ySpans.length === 0 ? 0 : ySpans.reduce((max, s) => Math.max(max, s.getBoundingClientRect().width), 0);

    const yCenter = (plotTopCss + plotBottomCss) / 2;
    const yTickLabelLeft = yLabelX - maxTickLabelWidth;
    const yTitleX = yTickLabelLeft - LABEL_PADDING_CSS_PX - axisNameFontSize * 0.5;

    const span = axisLabelOverlay.addLabel(yAxisName, offsetX + yTitleX, offsetY + yCenter, {
      fontSize: axisNameFontSize,
      color: currentOptions.theme.textColor,
      anchor: 'middle',
      rotation: -90,
    });
    styleAxisLabelSpan(span, true, currentOptions.theme);
  }
}
