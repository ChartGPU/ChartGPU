/**
 * Axis and grid utilities for the RenderCoordinator.
 *
 * These pure functions handle coordinate transformations between different spaces:
 * - CSS pixels (DOM layout)
 * - Device pixels (canvas.width/height)
 * - Normalized device coordinates / clip space (WebGPU [-1, 1])
 *
 * @module axisUtils
 */

import type { GPUContextLike } from "../../createRenderCoordinator";
import type { ResolvedChartGPUOptions } from "../../../config/OptionResolver";
import type { GridArea } from "../../../renderers/createGridRenderer";
import { parseCssColorToRgba01 } from "../../../utils/colors";
import { normalizeDomain } from "./boundsComputation";
import { clampInt } from "./canvasUtils";

/**
 * Computes grid area with margins and canvas dimensions for rendering layout.
 * GridArea uses:
 * - Margins (left, right, top, bottom) in CSS pixels
 * - Canvas dimensions (canvasWidth, canvasHeight) in DEVICE pixels
 * - devicePixelRatio for CSS-to-device conversion
 *
 * @param gpuContext - GPU context with canvas and device pixel ratio
 * @param options - Resolved chart options with grid margins
 * @returns GridArea object with margins, canvas dimensions, and DPR
 * @throws If canvas is null or has invalid dimensions
 */
export const computeGridArea = (
  gpuContext: GPUContextLike,
  options: ResolvedChartGPUOptions,
): GridArea => {
  const canvas = gpuContext.canvas;
  if (!canvas)
    throw new Error("RenderCoordinator: gpuContext.canvas is required.");

  const dpr = gpuContext.devicePixelRatio ?? 1;
  const devicePixelRatio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  // Validate and sanitize canvas dimensions (device pixels)
  const rawCanvasWidth = canvas.width;
  const rawCanvasHeight = canvas.height;

  if (!Number.isFinite(rawCanvasWidth) || !Number.isFinite(rawCanvasHeight)) {
    throw new Error(
      `RenderCoordinator: Invalid canvas dimensions: width=${rawCanvasWidth}, height=${rawCanvasHeight}. ` +
        `Canvas must be initialized with finite dimensions before rendering.`,
    );
  }

  // Be resilient: charts may be mounted into 0-sized containers (e.g. display:none during init).
  // Renderers guard internally; clamping avoids hard crashes and allows future resize to recover.
  const canvasWidth = Math.max(1, Math.floor(rawCanvasWidth));
  const canvasHeight = Math.max(1, Math.floor(rawCanvasHeight));

  // Validate and sanitize grid margins (CSS pixels)
  const left = Number.isFinite(options.grid.left) ? options.grid.left : 0;
  const right = Number.isFinite(options.grid.right) ? options.grid.right : 0;
  const top = Number.isFinite(options.grid.top) ? options.grid.top : 0;
  const bottom = Number.isFinite(options.grid.bottom) ? options.grid.bottom : 0;

  // Ensure margins are non-negative (negative margins could cause rendering issues)
  const sanitizedLeft = Math.max(0, left);
  const sanitizedRight = Math.max(0, right);
  const sanitizedTop = Math.max(0, top);
  const sanitizedBottom = Math.max(0, bottom);

  return {
    left: sanitizedLeft,
    right: sanitizedRight,
    top: sanitizedTop,
    bottom: sanitizedBottom,
    canvasWidth, // Device pixels (clamped above)
    canvasHeight, // Device pixels (clamped above)
    devicePixelRatio, // Explicit DPR (validated above)
  };
};

/**
 * Converts RGBA normalized [0-1] values to CSS rgba() string.
 *
 * @param rgba - Array of [r, g, b, a] in range [0, 1]
 * @returns CSS rgba() string
 */
export const rgba01ToCssRgba = (
  rgba: readonly [number, number, number, number],
): string => {
  const r = Math.max(0, Math.min(255, Math.round(rgba[0] * 255)));
  const g = Math.max(0, Math.min(255, Math.round(rgba[1] * 255)));
  const b = Math.max(0, Math.min(255, Math.round(rgba[2] * 255)));
  const a = Math.max(0, Math.min(1, rgba[3]));
  return `rgba(${r},${g},${b},${a})`;
};

/**
 * Applies alpha multiplier to CSS color.
 * Parses color, multiplies alpha channel, and returns new CSS rgba() string.
 *
 * @param cssColor - CSS color string
 * @param alphaMultiplier - Alpha multiplier in range [0, 1]
 * @returns CSS rgba() string with modified alpha, or original color if parse fails
 */
export const withAlpha = (
  cssColor: string,
  alphaMultiplier: number,
): string => {
  const parsed = parseCssColorToRgba01(cssColor);
  if (!parsed) return cssColor;
  const a = Math.max(0, Math.min(1, parsed[3] * alphaMultiplier));
  return rgba01ToCssRgba([parsed[0], parsed[1], parsed[2], a]);
};

/**
 * Converts grid margins to normalized device clip coordinates for WebGPU.
 * Output is in WebGPU clip space: [-1, 1] for both x and y.
 * Y-axis is flipped (top is positive, bottom is negative).
 *
 * @param gridArea - Grid area with margins and canvas dimensions
 * @returns Clip rect with left, right, top, bottom in range [-1, 1]
 */
export const computePlotClipRect = (
  gridArea: GridArea,
): {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
} => {
  const {
    left,
    right,
    top,
    bottom,
    canvasWidth,
    canvasHeight,
    devicePixelRatio,
  } = gridArea;

  const plotLeft = left * devicePixelRatio;
  const plotRight = canvasWidth - right * devicePixelRatio;
  const plotTop = top * devicePixelRatio;
  const plotBottom = canvasHeight - bottom * devicePixelRatio;

  const plotLeftClip = (plotLeft / canvasWidth) * 2.0 - 1.0;
  const plotRightClip = (plotRight / canvasWidth) * 2.0 - 1.0;
  const plotTopClip = 1.0 - (plotTop / canvasHeight) * 2.0; // flip Y
  const plotBottomClip = 1.0 - (plotBottom / canvasHeight) * 2.0; // flip Y

  return {
    left: plotLeftClip,
    right: plotRightClip,
    top: plotTopClip,
    bottom: plotBottomClip,
  };
};

/**
 * Clamps value to [0, 1] range.
 *
 * @param v - Value to clamp
 * @returns Clamped value
 */
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Linear interpolation between two values with clamped t.
 *
 * @param a - Start value
 * @param b - End value
 * @param t01 - Interpolation parameter in range [0, 1]
 * @returns Interpolated value
 */
export const lerp = (a: number, b: number, t01: number): number =>
  a + (b - a) * clamp01(t01);

/**
 * Interpolates between two domains (min/max pairs).
 * Ensures result is a valid domain (min ≤ max, both finite).
 *
 * @param from - Start domain
 * @param to - End domain
 * @param t01 - Interpolation parameter in range [0, 1]
 * @returns Interpolated domain
 */
export const lerpDomain = (
  from: { readonly min: number; readonly max: number },
  to: { readonly min: number; readonly max: number },
  t01: number,
): { readonly min: number; readonly max: number } => {
  return normalizeDomain(
    lerp(from.min, to.min, t01),
    lerp(from.max, to.max, t01),
  );
};

/**
 * Computes scissor rect in device pixels from grid margins.
 * Used for WebGPU scissor testing to clip rendering to plot area.
 *
 * @param gridArea - Grid area with margins and canvas dimensions
 * @returns Scissor rect with x, y, w, h in device pixels
 */
export const computePlotScissorDevicePx = (
  gridArea: GridArea,
): {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
} => {
  const { canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeftDevice = gridArea.left * devicePixelRatio;
  const plotRightDevice = canvasWidth - gridArea.right * devicePixelRatio;
  const plotTopDevice = gridArea.top * devicePixelRatio;
  const plotBottomDevice = canvasHeight - gridArea.bottom * devicePixelRatio;

  const scissorX = clampInt(
    Math.floor(plotLeftDevice),
    0,
    Math.max(0, canvasWidth),
  );
  const scissorY = clampInt(
    Math.floor(plotTopDevice),
    0,
    Math.max(0, canvasHeight),
  );
  const scissorR = clampInt(
    Math.ceil(plotRightDevice),
    0,
    Math.max(0, canvasWidth),
  );
  const scissorB = clampInt(
    Math.ceil(plotBottomDevice),
    0,
    Math.max(0, canvasHeight),
  );
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
};

/**
 * Converts clip-space X to canvas CSS pixels (from normalized [-1, 1]).
 *
 * @param xClip - X coordinate in clip space [-1, 1]
 * @param canvasCssWidth - Canvas width in CSS pixels
 * @returns X coordinate in canvas CSS pixels
 */
export const clipXToCanvasCssPx = (
  xClip: number,
  canvasCssWidth: number,
): number => ((xClip + 1) / 2) * canvasCssWidth;

/**
 * Converts clip-space Y to canvas CSS pixels (from normalized [-1, 1]).
 * Y-axis is flipped (1 is top, -1 is bottom).
 *
 * @param yClip - Y coordinate in clip space [-1, 1]
 * @param canvasCssHeight - Canvas height in CSS pixels
 * @returns Y coordinate in canvas CSS pixels
 */
export const clipYToCanvasCssPx = (
  yClip: number,
  canvasCssHeight: number,
): number => ((1 - yClip) / 2) * canvasCssHeight;
