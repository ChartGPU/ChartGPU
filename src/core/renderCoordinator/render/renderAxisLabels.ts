/**
 * Axis Label Rendering Utilities
 *
 * Generates DOM-based axis labels and titles for cartesian charts.
 * Labels are positioned using canvas-local CSS coordinates and rendered
 * into a text overlay element.
 *
 * @module renderAxisLabels
 */

import type { ResolvedChartGPUOptions } from "../../../config/OptionResolver";
import type { AxisConfig } from "../../../config/types";
import type { LinearScale } from "../../../utils/scales";
import type {
  TextOverlay,
  TextOverlayAnchor,
} from "../../../components/createTextOverlay";
import { getCanvasCssWidth, getCanvasCssHeight } from "../utils/canvasUtils";
import { formatTimeTickValue } from "../utils/timeAxisUtils";
import { formatTickValue, createTickFormatter } from "../axis/computeAxisTicks";
import { generateTicks, formatLogTick } from "../../../utils/tickHelpers";
import { finiteOrUndefined } from "../utils/dataPointUtils";
import { AxisType } from "../../../config/types";
import { getAxisTitleFontSize } from "../../../utils/axisLabelStyling";
import {
  getRightYAxisLabelX,
  getYAxisLabelX,
  getRightYAxisTitleX,
  getYAxisTitleX,
} from "../axis/axisLabelHelpers";

const DEFAULT_TICK_LENGTH_CSS_PX = 6;
const LABEL_PADDING_CSS_PX = 4;
const DEFAULT_TICK_COUNT = 5;

/** Context for rendering X-axis labels and titles. */
export interface AxisLabelRenderContext {
  readonly gpuContext: { readonly canvas: HTMLCanvasElement | null };
  readonly currentOptions: ResolvedChartGPUOptions;
  readonly xScale: LinearScale;
  readonly xTickValues: readonly number[];
  readonly plotClipRect: { left: number; right: number; top: number; bottom: number };
  readonly visibleXRangeMs: number;
}

/** Context for rendering a single Y-axis's tick labels and title. */
export interface YAxisLabelRenderContext {
  readonly axisLabelOverlay: TextOverlay | null;
  readonly overlayContainer: HTMLElement | null;
  readonly yAxisConfig: AxisConfig;
  readonly yScale: LinearScale;
  readonly plotClipRect: { left: number; right: number; top: number; bottom: number };
  readonly canvasCssWidth: number;
  readonly canvasCssHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly theme: ResolvedChartGPUOptions["theme"];
}

function clipXToCanvasCssPx(xClip: number, canvasCssWidth: number): number {
  return ((xClip + 1) / 2) * canvasCssWidth;
}

function clipYToCanvasCssPx(yClip: number, canvasCssHeight: number): number {
  return ((1 - yClip) / 2) * canvasCssHeight;
}

function styleAxisLabelSpan(
  span: HTMLSpanElement,
  isTitle: boolean,
  theme: ResolvedChartGPUOptions["theme"],
): void {
  span.style.fontFamily = theme.fontFamily;
  span.style.fontWeight = isTitle ? "500" : "400";
  span.style.userSelect = "none";
  span.style.pointerEvents = "none";
}

/**
 * Renders X-axis tick labels, titles and clears the overlay for re-use.
 * Y-axis labels are handled separately by renderYAxisLabels().
 */
export function renderAxisLabels(
  axisLabelOverlay: TextOverlay | null,
  overlayContainer: HTMLElement | null,
  context: AxisLabelRenderContext,
): void {
  const {
    gpuContext,
    currentOptions,
    xScale,
    xTickValues,
    plotClipRect,
    visibleXRangeMs,
  } = context;

  const hasCartesianSeries = currentOptions.series.some(
    (s) => s.type !== "pie",
  );
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
  const xTickLengthCssPx =
    currentOptions.xAxis.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
  const xLabelY =
    plotBottomCss +
    xTickLengthCssPx +
    LABEL_PADDING_CSS_PX +
    currentOptions.theme.fontSize * 0.5;
  const isTimeXAxis = currentOptions.xAxis.type === "time";
  const xFormatter = (() => {
    if (isTimeXAxis) return null;
    const xDomainMin =
      finiteOrUndefined(currentOptions.xAxis.min) ??
      xScale.invert(plotClipRect.left);
    const xDomainMax =
      finiteOrUndefined(currentOptions.xAxis.max) ??
      xScale.invert(plotClipRect.right);
    const xTickCount = xTickValues.length;
    const xTickStep =
      xTickCount === 1 ? 0 : (xDomainMax - xDomainMin) / (xTickCount - 1);
    return createTickFormatter(xTickStep);
  })();

  const xTickFormatter = currentOptions.xAxis.tickFormatter;
  for (let i = 0; i < xTickValues.length; i++) {
    const v = xTickValues[i]!;
    const xClip = xScale.scale(v);
    const xCss = clipXToCanvasCssPx(xClip, canvasCssWidth);

    const anchor: TextOverlayAnchor =
      xTickValues.length === 1
        ? "middle"
        : i === 0
          ? "start"
          : i === xTickValues.length - 1
            ? "end"
            : "middle";
    const label = xTickFormatter
      ? xTickFormatter(v)
      : isTimeXAxis
        ? formatTimeTickValue(v, visibleXRangeMs)
        : formatTickValue(xFormatter!, v);
    if (label == null) continue;

    const span = axisLabelOverlay.addLabel(
      label,
      offsetX + xCss,
      offsetY + xLabelY,
      {
        fontSize: currentOptions.theme.fontSize,
        color: currentOptions.theme.textColor,
        anchor,
      },
    );
    styleAxisLabelSpan(span, false, currentOptions.theme);
  }


  // X-axis title
  const axisNameFontSize = getAxisTitleFontSize(currentOptions.theme.fontSize);
  const xAxisName = currentOptions.xAxis.name?.trim() ?? "";
  if (xAxisName.length > 0) {
    const xCenter = (plotLeftCss + plotRightCss) / 2;
    const xTickLabelsBottom = xLabelY + currentOptions.theme.fontSize * 0.5;
    const hasSliderZoom =
      currentOptions.dataZoom?.some((z) => z?.type === "slider") ?? false;
    const sliderTrackHeightCssPx = 32;
    const bottomLimitCss = hasSliderZoom
      ? canvasCssHeight - sliderTrackHeightCssPx
      : canvasCssHeight;
    const xTitleY = (xTickLabelsBottom + bottomLimitCss) / 2;

    const span = axisLabelOverlay.addLabel(
      xAxisName,
      offsetX + xCenter,
      offsetY + xTitleY,
      {
        fontSize: axisNameFontSize,
        color: currentOptions.theme.textColor,
        anchor: "middle",
      },
    );
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
  } = ctx;
  if (!axisLabelOverlay || !overlayContainer) return;
  if (canvasCssWidth <= 0 || canvasCssHeight <= 0) return;

  const plotLeftCss = clipXToCanvasCssPx(plotClipRect.left, canvasCssWidth);
  const plotRightCss = clipXToCanvasCssPx(plotClipRect.right, canvasCssWidth);
  const plotTopCss = clipYToCanvasCssPx(plotClipRect.top, canvasCssHeight);
  const plotBottomCss = clipYToCanvasCssPx(plotClipRect.bottom, canvasCssHeight);

  const isRight = yAxisConfig.position === "right";
  const yTickLengthCssPx = yAxisConfig.tickLength ?? DEFAULT_TICK_LENGTH_CSS_PX;
  const yTickCount = (yAxisConfig as any).tickCount ?? DEFAULT_TICK_COUNT;
  const yDomainMin =
    finiteOrUndefined(yAxisConfig.min) ??
    yScale.invert(plotClipRect.bottom);
  const yDomainMax =
    finiteOrUndefined(yAxisConfig.max) ??
    yScale.invert(plotClipRect.top);
  const yTickStep =
    yTickCount <= 1 ? 0 : (yDomainMax - yDomainMin) / (yTickCount - 1);
  const yFormatter = createTickFormatter(yTickStep);

  const yLabelX = isRight
    ? getRightYAxisLabelX(plotRightCss, yTickLengthCssPx)
    : getYAxisLabelX(plotLeftCss, yTickLengthCssPx);

  const ySpans: HTMLSpanElement[] = [];
  const yTickFormatter = yAxisConfig.tickFormatter;
  const isLog = yAxisConfig.type === "log";
  const yTicks = generateTicks(yAxisConfig.type as AxisType, yDomainMin, yDomainMax, yTickCount, yAxisConfig.logBase);

  for (const v of yTicks) {
    const yClip = yScale.scale(v);
    const yCss = clipYToCanvasCssPx(yClip, canvasCssHeight);

    let label: string | null = null;
    if (yTickFormatter) {
      label = yTickFormatter(v);
    } else if (isLog) {
      label = formatLogTick(v, yAxisConfig.logBase);
    } else {
      label = formatTickValue(yFormatter, v);
    }
    
    if (label == null) continue;

    const span = axisLabelOverlay.addLabel(
      label,
      offsetX + yLabelX,
      offsetY + yCss,
      {
        fontSize: theme.fontSize,
        color: theme.textColor,
        anchor: isRight ? "start" : "end",
      },
    );
    styleAxisLabelSpan(span, false, theme);
    ySpans.push(span);
  }

  const axisNameFontSize = getAxisTitleFontSize(theme.fontSize);
  const yAxisName = yAxisConfig.name?.trim() ?? "";
  if (yAxisName.length > 0) {
    const maxTickLabelWidth =
      ySpans.length === 0
        ? 0
        : ySpans.reduce(
            (max, s) => Math.max(max, s.getBoundingClientRect().width),
            0,
          );

    const yCenter = (plotTopCss + plotBottomCss) / 2;

    const yTitleX = isRight
      ? getRightYAxisTitleX(yLabelX, maxTickLabelWidth, axisNameFontSize)
      : getYAxisTitleX(yLabelX, maxTickLabelWidth, axisNameFontSize);

    const span = axisLabelOverlay.addLabel(
      yAxisName,
      offsetX + yTitleX,
      offsetY + yCenter,
      {
        fontSize: axisNameFontSize,
        color: theme.textColor,
        anchor: "middle",
        rotation: isRight ? 90 : -90,
      },
    );
    styleAxisLabelSpan(span, true, theme);
  }
}
