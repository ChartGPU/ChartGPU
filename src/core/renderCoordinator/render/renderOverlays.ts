/**
 * Overlay Rendering Utilities
 *
 * Prepares and renders GPU-based chart overlays (grid, axes, crosshair, highlight).
 * These overlays are rendered on top of the main chart series.
 *
 * @module renderOverlays
 */

import type { ResolvedChartGPUOptions } from "../../../config/OptionResolver";
import type { LinearScale } from "../../../utils/scales";
import type { GridRenderer } from "../../../renderers/createGridRenderer";
import type { AxisRenderer } from "../../../renderers/createAxisRenderer";
import type {
  CrosshairRenderer,
  CrosshairRenderOptions,
} from "../../../renderers/createCrosshairRenderer";
import type {
  HighlightRenderer,
  HighlightPoint,
} from "../../../renderers/createHighlightRenderer";
import type { GridArea } from "../../../renderers/createGridRenderer";
import { findNearestPoint } from "../../../interaction/findNearestPoint";
import { getPointXY, finiteOrUndefined } from "../utils/dataPointUtils";
import { computePlotScissorDevicePx } from "../utils/axisUtils";
import { generateTicks } from "../../../utils/tickHelpers";

const DEFAULT_TICK_COUNT = 5;
const DEFAULT_CROSSHAIR_LINE_WIDTH_CSS_PX = 1;
const DEFAULT_HIGHLIGHT_SIZE_CSS_PX = 4;

export interface OverlayRenderers {
  gridRenderer: GridRenderer;
  xAxisRenderer: AxisRenderer;
  yAxisRenderer: AxisRenderer;
  crosshairRenderer: CrosshairRenderer;
  highlightRenderer: HighlightRenderer;
}

export interface OverlayPrepareContext {
  currentOptions: ResolvedChartGPUOptions;
  xScale: LinearScale;
  yScale: LinearScale;
  gridArea: GridArea;
  xTickCount: number;
  hasCartesianSeries: boolean;
  effectivePointer: {
    hasPointer: boolean;
    isInGrid: boolean;
    source: "mouse" | "sync";
    x: number;
    y: number;
    gridX: number;
    gridY: number;
  };
  interactionScales: {
    xScale: LinearScale;
    yScale: LinearScale;
  } | null;
  seriesForRender: ReadonlyArray<any>;
  withAlpha: (color: string, alpha: number) => string;
}

export interface OverlayRenderContext {
  mainPass: GPURenderPassEncoder;
  topOverlayPass: GPURenderPassEncoder;
  hasCartesianSeries: boolean;
}

/**
 * Prepares all overlay renderers with current frame data.
 *
 * This includes grid lines, axes, crosshair, and point highlights.
 *
 * @param renderers - Overlay renderer instances
 * @param context - Rendering context with scales, options, and pointer state
 */
export function prepareOverlays(
  renderers: OverlayRenderers,
  context: OverlayPrepareContext,
): void {
  const {
    currentOptions,
    xScale,
    yScale,
    gridArea,
    xTickCount,
    hasCartesianSeries,
    effectivePointer,
    interactionScales,
    seriesForRender,
    withAlpha,
  } = context;

  // Grid preparation - always prepare so hidden grids don't render stale geometry.
  const gridLinesConfig = currentOptions.gridLines;
  
  let horizontalCount: number | number[] = 0;
  if (gridLinesConfig.show && gridLinesConfig.horizontal.show) {
    if (currentOptions.yAxis.type === "log") {
      const plotClipRect = {
        left: gridArea.left,
        right: gridArea.canvasWidth - gridArea.right,
        top: gridArea.top,
        bottom: gridArea.canvasHeight - gridArea.bottom,
      };
      const yDomainMin = finiteOrUndefined(currentOptions.yAxis.min) ?? yScale.invert(plotClipRect.bottom);
      const yDomainMax = finiteOrUndefined(currentOptions.yAxis.max) ?? yScale.invert(plotClipRect.top);
      const yTicks = generateTicks("log", yDomainMin, yDomainMax, gridLinesConfig.horizontal.count);
      horizontalCount = yTicks.map(v => (Math.log10(v) - Math.log10(yDomainMin)) / (Math.log10(yDomainMax) - Math.log10(yDomainMin)));
    } else {
      horizontalCount = gridLinesConfig.horizontal.count;
    }
  }

  const verticalCount =
    gridLinesConfig.show && gridLinesConfig.vertical.show
      ? gridLinesConfig.vertical.count
      : 0;

  const hasHorizontal = Array.isArray(horizontalCount) ? horizontalCount.length > 0 : horizontalCount > 0;
  const hasVertical = Array.isArray(verticalCount) ? verticalCount.length > 0 : verticalCount > 0;

  // Clear grid when hidden (or when both counts are zero).
  if (!hasHorizontal && !hasVertical) {
    renderers.gridRenderer.prepare(gridArea, {
      lineCount: { horizontal: 0, vertical: 0 },
    });
  } else if (
    hasHorizontal &&
    hasVertical &&
    gridLinesConfig.horizontal.color !== gridLinesConfig.vertical.color
  ) {
    // Per-direction colors: render two batches (horizontal then vertical).
    renderers.gridRenderer.prepare(gridArea, {
      lineCount: { horizontal: horizontalCount, vertical: 0 },
      color: gridLinesConfig.horizontal.color,
    });
    renderers.gridRenderer.prepare(gridArea, {
      lineCount: { horizontal: 0, vertical: verticalCount },
      color: gridLinesConfig.vertical.color,
      append: true,
    });
  } else {
    // Single color (either both directions share a color, or only one direction is enabled).
    const color =
      hasHorizontal
        ? gridLinesConfig.horizontal.color
        : gridLinesConfig.vertical.color;
    renderers.gridRenderer.prepare(gridArea, {
      lineCount: { horizontal: horizontalCount, vertical: verticalCount },
      color,
    });
  }

  // Axes preparation (cartesian only)
  if (hasCartesianSeries) {
    renderers.xAxisRenderer.prepare(
      currentOptions.xAxis,
      xScale,
      "x",
      gridArea,
      currentOptions.theme.axisLineColor,
      currentOptions.theme.axisTickColor,
      xTickCount,
    );
    renderers.yAxisRenderer.prepare(
      currentOptions.yAxis,
      yScale,
      "y",
      gridArea,
      currentOptions.theme.axisLineColor,
      currentOptions.theme.axisTickColor,
      DEFAULT_TICK_COUNT,
    );
  }

  // Crosshair preparation (when pointer is in grid)
  if (effectivePointer.hasPointer && effectivePointer.isInGrid) {
    const crosshairOptions: CrosshairRenderOptions = {
      showX: true,
      // Sync has no meaningful y, so avoid horizontal line.
      showY: effectivePointer.source !== "sync",
      color: withAlpha(currentOptions.theme.axisLineColor, 0.6),
      lineWidth: DEFAULT_CROSSHAIR_LINE_WIDTH_CSS_PX,
    };
    renderers.crosshairRenderer.prepare(
      effectivePointer.x,
      effectivePointer.y,
      gridArea,
      crosshairOptions,
    );
    renderers.crosshairRenderer.setVisible(true);
  } else {
    renderers.crosshairRenderer.setVisible(false);
  }

  // Highlight preparation (on hover, find nearest point)
  if (
    effectivePointer.source === "mouse" &&
    effectivePointer.hasPointer &&
    effectivePointer.isInGrid
  ) {
    if (interactionScales) {
      // findNearestPoint handles visibility filtering internally
      const match = findNearestPoint(
        seriesForRender,
        effectivePointer.gridX,
        effectivePointer.gridY,
        interactionScales.xScale,
        interactionScales.yScale,
      );

      if (match) {
        const { x, y } = getPointXY(match.point);
        const xGridCss = interactionScales.xScale.scale(x);
        const yGridCss = interactionScales.yScale.scale(y);

        if (Number.isFinite(xGridCss) && Number.isFinite(yGridCss)) {
          const centerCssX = gridArea.left + xGridCss;
          const centerCssY = gridArea.top + yGridCss;

          const plotScissor = computePlotScissorDevicePx(gridArea);
          const point: HighlightPoint = {
            centerDeviceX: centerCssX * gridArea.devicePixelRatio,
            centerDeviceY: centerCssY * gridArea.devicePixelRatio,
            devicePixelRatio: gridArea.devicePixelRatio,
            canvasWidth: gridArea.canvasWidth,
            canvasHeight: gridArea.canvasHeight,
            scissor: plotScissor,
          };

          const seriesColor =
            currentOptions.series[match.seriesIndex]?.color ?? "#888";
          renderers.highlightRenderer.prepare(
            point,
            seriesColor,
            DEFAULT_HIGHLIGHT_SIZE_CSS_PX,
          );
          renderers.highlightRenderer.setVisible(true);
        } else {
          renderers.highlightRenderer.setVisible(false);
        }
      } else {
        renderers.highlightRenderer.setVisible(false);
      }
    } else {
      renderers.highlightRenderer.setVisible(false);
    }
  } else {
    renderers.highlightRenderer.setVisible(false);
  }
}

/**
 * Renders all overlay elements to the appropriate render passes.
 *
 * Grid is rendered in the main pass (background).
 * Highlight, axes, and crosshair are rendered in the top overlay pass (foreground).
 *
 * @param renderers - Overlay renderer instances
 * @param context - Render pass context
 */
export function renderOverlays(
  renderers: OverlayRenderers,
  context: OverlayRenderContext,
): void {
  const { mainPass, topOverlayPass, hasCartesianSeries } = context;

  // Grid renders in main pass (background)
  if (renderers.gridRenderer) {
    renderers.gridRenderer.render(mainPass);
  }

  // Highlight, axes, crosshair render in top overlay pass (foreground)
  renderers.highlightRenderer.render(topOverlayPass);
  if (hasCartesianSeries) {
    renderers.xAxisRenderer.render(topOverlayPass);
    renderers.yAxisRenderer.render(topOverlayPass);
  }
  renderers.crosshairRenderer.render(topOverlayPass);
}
