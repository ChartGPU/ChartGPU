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
import { getPointXY } from "../utils/dataPointUtils";
import { computePlotScissorDevicePx } from "../utils/axisUtils";

const DEFAULT_TICK_COUNT = 5;
const DEFAULT_CROSSHAIR_LINE_WIDTH_CSS_PX = 1;
const DEFAULT_HIGHLIGHT_SIZE_CSS_PX = 4;

/**
 * Phase 4a: per-coordinator memoization state for grid/axis prepare calls.
 *
 * Render bundles cached inside grid/axis renderers are only reused across frames when
 * their `prepare()` is NOT re-invoked. This memo short-circuits prepare when inputs
 * match the previous frame — geometry/uniform uploads and bundle rebuild are skipped.
 *
 * Signatures are compact strings (cheap to compare) derived from the exact inputs
 * each renderer would consume. Any input drift — gridArea, colors, domain, ticks —
 * produces a new signature and forces a rebuild.
 */
export interface OverlayPrepareMemo {
  grid: string | null;
  xAxis: string | null;
  yAxis: string | null;
}

export function createOverlayPrepareMemo(): OverlayPrepareMemo {
  return { grid: null, xAxis: null, yAxis: null };
}

/** Forces grid+axis bundles to be rebuilt on the next frame (e.g. after theme changes). */
export function invalidateOverlayPrepareMemo(memo: OverlayPrepareMemo): void {
  memo.grid = null;
  memo.xAxis = null;
  memo.yAxis = null;
}

const gridSignature = (
  gridArea: GridArea,
  horizontalCount: number,
  verticalCount: number,
  horizontalColor: string,
  verticalColor: string,
): string =>
  `${gridArea.left},${gridArea.right},${gridArea.top},${gridArea.bottom},` +
  `${gridArea.canvasWidth},${gridArea.canvasHeight},${gridArea.devicePixelRatio},` +
  `h=${horizontalCount}@${horizontalColor},v=${verticalCount}@${verticalColor}`;

/**
 * A linear scale is fully identified by its affine transform; two samples recover both
 * coefficients. Paired with axisConfig and grid dimensions it produces a complete cache
 * key for `AxisRenderer.prepare()` without snooping internals.
 */
const axisSignature = (
  orientation: "x" | "y",
  axisConfigMin: number | undefined,
  axisConfigMax: number | undefined,
  axisConfigTickLength: number | undefined,
  scale: LinearScale,
  gridArea: GridArea,
  axisLineColor: string | undefined,
  axisTickColor: string | undefined,
  tickCount: number,
): string => {
  const s0 = scale.scale(0);
  const s1 = scale.scale(1);
  return (
    `${orientation}|` +
    `min=${axisConfigMin ?? "_"},max=${axisConfigMax ?? "_"},tl=${axisConfigTickLength ?? "_"}|` +
    `s0=${s0},s1=${s1}|` +
    `${gridArea.left},${gridArea.right},${gridArea.top},${gridArea.bottom},` +
    `${gridArea.canvasWidth},${gridArea.canvasHeight},${gridArea.devicePixelRatio}|` +
    `line=${axisLineColor ?? "_"},tick=${axisTickColor ?? "_"}|tc=${tickCount}`
  );
};

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
  /**
   * The annotation overlay pass (MSAA). Axes, crosshair, highlight, and above-series
   * annotations all render into this pass post Phase 4b (it replaced the separate
   * single-sample top overlay pass).
   */
  overlayPass: GPURenderPassEncoder;
  hasCartesianSeries: boolean;
}

/**
 * Prepares all overlay renderers with current frame data.
 *
 * This includes grid lines, axes, crosshair, and point highlights.
 *
 * @param renderers - Overlay renderer instances
 * @param context - Rendering context with scales, options, and pointer state
 * @param memo - Optional Phase 4a memo; when provided, grid/axis prepare calls are
 *   skipped on frames where their inputs are unchanged, letting the renderers' cached
 *   render bundles survive across frames.
 */
export function prepareOverlays(
  renderers: OverlayRenderers,
  context: OverlayPrepareContext,
  memo?: OverlayPrepareMemo,
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
  const horizontalCount =
    gridLinesConfig.show && gridLinesConfig.horizontal.show
      ? gridLinesConfig.horizontal.count
      : 0;
  const verticalCount =
    gridLinesConfig.show && gridLinesConfig.vertical.show
      ? gridLinesConfig.vertical.count
      : 0;

  const gridSig = gridSignature(
    gridArea,
    horizontalCount,
    verticalCount,
    gridLinesConfig.horizontal.color,
    gridLinesConfig.vertical.color,
  );
  if (!memo || memo.grid !== gridSig) {
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
      const color =
        horizontalCount > 0
          ? gridLinesConfig.horizontal.color
          : gridLinesConfig.vertical.color;
      renderers.gridRenderer.prepare(gridArea, {
        lineCount: { horizontal: horizontalCount, vertical: verticalCount },
        color,
      });
    }
    if (memo) memo.grid = gridSig;
  }

  // Axes preparation (cartesian only)
  if (hasCartesianSeries) {
    const xSig = axisSignature(
      "x",
      currentOptions.xAxis.min,
      currentOptions.xAxis.max,
      currentOptions.xAxis.tickLength,
      xScale,
      gridArea,
      currentOptions.theme.axisLineColor,
      currentOptions.theme.axisTickColor,
      xTickCount,
    );
    if (!memo || memo.xAxis !== xSig) {
      renderers.xAxisRenderer.prepare(
        currentOptions.xAxis,
        xScale,
        "x",
        gridArea,
        currentOptions.theme.axisLineColor,
        currentOptions.theme.axisTickColor,
        xTickCount,
      );
      if (memo) memo.xAxis = xSig;
    }

    const ySig = axisSignature(
      "y",
      currentOptions.yAxis.min,
      currentOptions.yAxis.max,
      currentOptions.yAxis.tickLength,
      yScale,
      gridArea,
      currentOptions.theme.axisLineColor,
      currentOptions.theme.axisTickColor,
      DEFAULT_TICK_COUNT,
    );
    if (!memo || memo.yAxis !== ySig) {
      renderers.yAxisRenderer.prepare(
        currentOptions.yAxis,
        yScale,
        "y",
        gridArea,
        currentOptions.theme.axisLineColor,
        currentOptions.theme.axisTickColor,
        DEFAULT_TICK_COUNT,
      );
      if (memo) memo.yAxis = ySig;
    }
  } else if (memo) {
    // Non-cartesian frames (e.g. pie-only) leave axes unchanged, but a future cartesian
    // frame must rebuild them from scratch since the axis vertex buffer was untouched.
    memo.xAxis = null;
    memo.yAxis = null;
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
 * Highlight, axes, and crosshair are rendered in the annotation overlay pass
 * (foreground, MSAA) — combined with above-series annotations post Phase 4b.
 *
 * @param renderers - Overlay renderer instances
 * @param context - Render pass context
 */
export function renderOverlays(
  renderers: OverlayRenderers,
  context: OverlayRenderContext,
): void {
  const { mainPass, overlayPass, hasCartesianSeries } = context;

  if (renderers.gridRenderer) {
    renderers.gridRenderer.render(mainPass);
  }

  renderers.highlightRenderer.render(overlayPass);
  if (hasCartesianSeries) {
    renderers.xAxisRenderer.render(overlayPass);
    renderers.yAxisRenderer.render(overlayPass);
  }
  renderers.crosshairRenderer.render(overlayPass);
}
