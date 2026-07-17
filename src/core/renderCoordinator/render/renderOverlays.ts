/**
 * Overlay Rendering Utilities
 *
 * Prepares and renders GPU-based chart overlays (grid, axes, crosshair, highlight).
 * These overlays are rendered on top of the main chart series.
 *
 * @module renderOverlays
 */

import type { ResolvedChartGPUOptions } from '../../../config/OptionResolver';
import type { LinearScale } from '../../../utils/scales';
import type { GridRenderer } from '../../../renderers/createGridRenderer';
import type { AxisRenderer } from '../../../renderers/createAxisRenderer';
import type { CrosshairRenderer, CrosshairRenderOptions } from '../../../renderers/createCrosshairRenderer';
import type { HighlightRenderer, HighlightPoint } from '../../../renderers/createHighlightRenderer';
import type { GridArea } from '../../../renderers/createGridRenderer';
import { findNearestPoint, type NearestPointMatch } from '../../../interaction/findNearestPoint';
import { getPointXY } from '../utils/dataPointUtils';
import { computePlotScissorDevicePx } from '../utils/axisUtils';
import {
  type OverlayPrepareMemo,
  buildGridPrepareSignature,
  gridPrepareSignaturesEqual,
  buildAxisPrepareSignature,
  axisPrepareSignaturesEqual,
} from './overlayPrepareMemo';

const DEFAULT_TICK_COUNT = 5;
const DEFAULT_CROSSHAIR_LINE_WIDTH_CSS_PX = 1;
const DEFAULT_HIGHLIGHT_SIZE_CSS_PX = 4;

interface OverlayRenderers {
  gridRenderer: GridRenderer;
  xAxisRenderer: AxisRenderer;
  yAxisRenderers: Map<string, AxisRenderer>;
  crosshairRenderer: CrosshairRenderer;
  highlightRenderer: HighlightRenderer;
}

/**
 * Shared nearest-point hit result for tooltip + highlight (P0-5).
 * Computed once per hover frame in the coordinator and reused by both consumers.
 */
type SharedNearestMatch = NearestPointMatch | null;

interface OverlayPrepareContext {
  currentOptions: ResolvedChartGPUOptions;
  xScale: LinearScale;
  yScales: Map<string, LinearScale>;
  gridArea: GridArea;
  xTickCount: number;
  /**
   * Explicit x-axis tick domain values (nice time ticks or linear).
   * When non-empty, GPU axis marks use these values so they align with DOM labels.
   */
  xTickValues?: readonly number[];
  hasCartesianSeries: boolean;
  effectivePointer: {
    hasPointer: boolean;
    isInGrid: boolean;
    source: 'mouse' | 'sync';
    x: number;
    y: number;
    gridX: number;
    gridY: number;
  };
  interactionScales: {
    xScale: LinearScale;
    yScales: Map<string, LinearScale>;
  } | null;
  seriesForRender: ReadonlyArray<any>;
  withAlpha: (color: string, alpha: number) => string;
  /**
   * Optional precomputed nearest-point match for the current pointer.
   * When provided (including explicit `null`), highlight skips its own
   * `findNearestPoint` call and uses this result. When omitted, falls back
   * to an independent hit-test for backward compatibility.
   */
  nearestMatch?: SharedNearestMatch | undefined;
  /**
   * Optional persistent memo (P1-6). When provided, grid/axis prepare is skipped
   * when the signature matches the previous frame. Caller owns the object.
   */
  overlayPrepareMemo?: OverlayPrepareMemo | undefined;
}

/**
 * Prepares all overlay renderers with current frame data.
 *
 * This includes grid lines, axes, crosshair, and point highlights.
 * Grid/axis prepares are memoized when `context.overlayPrepareMemo` is set (P1-6).
 *
 * @param renderers - Overlay renderer instances
 * @param context - Rendering context with scales, options, and pointer state
 */
export function prepareOverlays(renderers: OverlayRenderers, context: OverlayPrepareContext): void {
  const {
    currentOptions,
    xScale,
    yScales,
    gridArea,
    xTickCount,
    xTickValues,
    hasCartesianSeries,
    effectivePointer,
    interactionScales,
    seriesForRender,
    withAlpha,
    overlayPrepareMemo: memo,
  } = context;

  // Grid preparation - always prepare so hidden grids don't render stale geometry,
  // unless the memo signature matches (geometry/colors unchanged).
  const gridLinesConfig = currentOptions.gridLines;
  const horizontalCount =
    gridLinesConfig.show && gridLinesConfig.horizontal.show ? gridLinesConfig.horizontal.count : 0;
  const verticalCount = gridLinesConfig.show && gridLinesConfig.vertical.show ? gridLinesConfig.vertical.count : 0;

  const gridSig = buildGridPrepareSignature({
    gridArea,
    show: gridLinesConfig.show,
    horizontalCount,
    verticalCount,
    horizontalColor: gridLinesConfig.horizontal.color,
    verticalColor: gridLinesConfig.vertical.color,
  });

  const gridUnchanged = memo != null && gridPrepareSignaturesEqual(memo.grid, gridSig);

  if (!gridUnchanged) {
    // Clear grid when hidden (or when both counts are zero).
    if (horizontalCount === 0 && verticalCount === 0) {
      renderers.gridRenderer.prepare(gridArea, {
        lineCount: { horizontal: 0, vertical: 0 },
      });
    } else if (
      horizontalCount > 0 &&
      verticalCount > 0 &&
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
      const color = horizontalCount > 0 ? gridLinesConfig.horizontal.color : gridLinesConfig.vertical.color;
      renderers.gridRenderer.prepare(gridArea, {
        lineCount: { horizontal: horizontalCount, vertical: verticalCount },
        color,
      });
    }
    if (memo) memo.grid = gridSig;
  }

  // Axes preparation (cartesian only) — also memoized per axis (P1-6).
  if (hasCartesianSeries) {
    const axisLineColor = currentOptions.theme.axisLineColor;
    const axisTickColor = currentOptions.theme.axisTickColor;

    const xSig = buildAxisPrepareSignature({
      axisConfig: currentOptions.xAxis,
      scale: xScale,
      orientation: 'x',
      axisId: 'x',
      gridArea,
      axisLineColor,
      axisTickColor,
      tickCount: xTickCount,
      tickValues: xTickValues,
    });
    const xUnchanged = memo != null && axisPrepareSignaturesEqual(memo.xAxis, xSig);
    if (!xUnchanged) {
      renderers.xAxisRenderer.prepare(
        currentOptions.xAxis,
        xScale,
        'x',
        gridArea,
        axisLineColor,
        axisTickColor,
        xTickCount,
        xTickValues
      );
      if (memo) memo.xAxis = xSig;
    }

    const seenYIds = new Set<string>();
    for (const yAxisConfig of currentOptions.yAxes) {
      const axisId = yAxisConfig.id!;
      seenYIds.add(axisId);
      const yAxisRenderer = renderers.yAxisRenderers.get(axisId);
      if (!yAxisRenderer) continue;
      const axisYScale = yScales.get(axisId) ?? yScales.values().next().value!;
      const yTickCount = (yAxisConfig as { tickCount?: number }).tickCount ?? DEFAULT_TICK_COUNT;
      const ySig = buildAxisPrepareSignature({
        axisConfig: yAxisConfig,
        scale: axisYScale,
        orientation: 'y',
        axisId,
        gridArea,
        axisLineColor,
        axisTickColor,
        tickCount: yTickCount,
      });
      const yUnchanged = memo != null && axisPrepareSignaturesEqual(memo.yAxes.get(axisId), ySig);
      if (!yUnchanged) {
        yAxisRenderer.prepare(yAxisConfig, axisYScale, 'y', gridArea, axisLineColor, axisTickColor, yTickCount);
        if (memo) memo.yAxes.set(axisId, ySig);
      }
    }
    // Drop memo entries for removed y-axes.
    if (memo) {
      for (const id of [...memo.yAxes.keys()]) {
        if (!seenYIds.has(id)) memo.yAxes.delete(id);
      }
    }
  }

  // Crosshair preparation (when pointer is in grid) — always (pointer-driven).
  if (effectivePointer.hasPointer && effectivePointer.isInGrid) {
    const crosshairOptions: CrosshairRenderOptions = {
      showX: true,
      // Sync has no meaningful y, so avoid horizontal line.
      showY: effectivePointer.source !== 'sync',
      color: withAlpha(currentOptions.theme.axisLineColor, 0.6),
      lineWidth: DEFAULT_CROSSHAIR_LINE_WIDTH_CSS_PX,
    };
    renderers.crosshairRenderer.prepare(effectivePointer.x, effectivePointer.y, gridArea, crosshairOptions);
    renderers.crosshairRenderer.setVisible(true);
  } else {
    renderers.crosshairRenderer.setVisible(false);
  }

  // Highlight preparation (on hover, find nearest point).
  // Prefer a shared match from the coordinator (P0-5) so tooltip + highlight
  // do not each run findNearestPoint on the same frame.
  if (effectivePointer.source === 'mouse' && effectivePointer.hasPointer && effectivePointer.isInGrid) {
    if (interactionScales) {
      const match =
        context.nearestMatch !== undefined
          ? context.nearestMatch
          : findNearestPoint(
              seriesForRender,
              effectivePointer.gridX,
              effectivePointer.gridY,
              interactionScales.xScale,
              interactionScales.yScales.values().next().value!
            );

      if (match) {
        const { x, y } = getPointXY(match.point);
        const xGridCss = interactionScales.xScale.scale(x);
        const matchedSeriesCfg = seriesForRender[match.seriesIndex] as any;
        const matchedAxisId = matchedSeriesCfg?.yAxis || 'y';
        const matchedYScale =
          interactionScales.yScales.get(matchedAxisId) ?? interactionScales.yScales.values().next().value!;
        const yGridCss = matchedYScale.scale(y);

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

          const seriesColor = currentOptions.series[match.seriesIndex]?.color ?? '#888';
          renderers.highlightRenderer.prepare(point, seriesColor, DEFAULT_HIGHLIGHT_SIZE_CSS_PX);
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
