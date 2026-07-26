/**
 * Shared plot-space metrics and CSS→domain converters for series renderers.
 *
 * Canonical home for helpers previously copy-pasted across errorBar, impulse,
 * ohlc, candlestick, etc. Coordinator-side clip/scissor also live in
 * `renderCoordinator/utils/axisUtils.ts` (same math; width/height variants here).
 *
 * **Consumers (wired):** createErrorBarRenderer, createImpulseRenderer,
 * createOhlcRenderer, createCandlestickRenderer.
 *
 * **Residual private copies (deferred U4):** createBarRenderer, createScatterRenderer,
 * createScatterDensityRenderer, createHeatmapRenderer, createAreaRenderer,
 * createLineRenderer, createPieRenderer, createAnnotationMarkerRenderer,
 * createDecimationCompute — migrate opportunistically when those files are touched;
 * not a single bulk rewrite to limit review risk.
 *
 * @module plotMetrics
 * @internal
 */

import type { ContinuousScale } from '../utils/scales';
import type { GridArea } from './createGridRenderer';

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

export const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

export const nearEqual = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export type PlotSizeCssPx = {
  readonly plotWidthCss: number;
  readonly plotHeightCss: number;
};

export function computePlotSizeCssPx(gridArea: GridArea): PlotSizeCssPx | null {
  const dpr = gridArea.devicePixelRatio;
  if (!(dpr > 0)) return null;
  const canvasCssWidth = gridArea.canvasWidth / dpr;
  const canvasCssHeight = gridArea.canvasHeight / dpr;
  const plotWidthCss = canvasCssWidth - gridArea.left - gridArea.right;
  const plotHeightCss = canvasCssHeight - gridArea.top - gridArea.bottom;
  if (!(plotWidthCss > 0) || !(plotHeightCss > 0)) return null;
  return { plotWidthCss, plotHeightCss };
}

export type PlotClipRect = {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

export function computePlotClipRect(gridArea: GridArea): PlotClipRect {
  const { left, right, top, bottom, canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeft = left * devicePixelRatio;
  const plotRight = canvasWidth - right * devicePixelRatio;
  const plotTop = top * devicePixelRatio;
  const plotBottom = canvasHeight - bottom * devicePixelRatio;

  const plotLeftClip = (plotLeft / canvasWidth) * 2.0 - 1.0;
  const plotRightClip = (plotRight / canvasWidth) * 2.0 - 1.0;
  const plotTopClip = 1.0 - (plotTop / canvasHeight) * 2.0;
  const plotBottomClip = 1.0 - (plotBottom / canvasHeight) * 2.0;

  return {
    left: plotLeftClip,
    right: plotRightClip,
    top: plotTopClip,
    bottom: plotBottomClip,
    width: plotRightClip - plotLeftClip,
    height: plotTopClip - plotBottomClip,
  };
}

export type PlotScissorDevicePx = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export function computePlotScissorDevicePx(gridArea: GridArea): PlotScissorDevicePx {
  const { canvasWidth, canvasHeight, devicePixelRatio } = gridArea;

  const plotLeftDevice = gridArea.left * devicePixelRatio;
  const plotRightDevice = canvasWidth - gridArea.right * devicePixelRatio;
  const plotTopDevice = gridArea.top * devicePixelRatio;
  const plotBottomDevice = canvasHeight - gridArea.bottom * devicePixelRatio;

  const scissorX = clampInt(Math.floor(plotLeftDevice), 0, Math.max(0, canvasWidth));
  const scissorY = clampInt(Math.floor(plotTopDevice), 0, Math.max(0, canvasHeight));
  const scissorR = clampInt(Math.ceil(plotRightDevice), 0, Math.max(0, canvasWidth));
  const scissorB = clampInt(Math.ceil(plotBottomDevice), 0, Math.max(0, canvasHeight));
  const scissorW = Math.max(0, scissorR - scissorX);
  const scissorH = Math.max(0, scissorB - scissorY);

  return { x: scissorX, y: scissorY, w: scissorW, h: scissorH };
}

/** Write a 2D affine transform into a column-major mat4 (clip = a*domain + b). */
export function writeTransformMat4F32(out: Float32Array, ax: number, bx: number, ay: number, by: number): void {
  out[0] = ax;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = ay;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;
  out[12] = bx;
  out[13] = by;
  out[14] = 0;
  out[15] = 1;
}

export type CssToDomainConverters = {
  readonly cssWidthToDomainX: (cssPx: number) => number;
  readonly cssHeightToDomainY: (cssPx: number) => number;
};

/**
 * Build CSS-px → domain converters for the current plot + scales.
 * Log axes use geometric mid of the domain for a local width estimate.
 */
export function createCssToDomainConverters(args: {
  readonly xScale: ContinuousScale;
  readonly yScale: ContinuousScale;
  readonly ax: number;
  readonly ay: number;
  readonly clipPerCssX: number;
  readonly clipPerCssY: number;
}): CssToDomainConverters {
  const { xScale, yScale, ax, ay, clipPerCssX, clipPerCssY } = args;

  const cssWidthToDomainX = (cssPx: number): number => {
    const widthClip = Math.max(0, cssPx) * clipPerCssX;
    if (!(widthClip > 0)) return 0;
    if (xScale.kind === 'log') {
      const { min, max } = xScale.getDomain();
      const mid = Math.sqrt(Math.max(min, Number.MIN_VALUE) * Math.max(max, Number.MIN_VALUE));
      const midClip = xScale.scale(mid);
      const lo = xScale.invert(midClip - widthClip * 0.5);
      const hi = xScale.invert(midClip + widthClip * 0.5);
      return Number.isFinite(lo) && Number.isFinite(hi) ? Math.abs(hi - lo) : 0;
    }
    const absAx = Math.abs(ax);
    return absAx > 1e-20 ? widthClip / absAx : 0;
  };

  const cssHeightToDomainY = (cssPx: number): number => {
    const heightClip = Math.max(0, cssPx) * Math.abs(clipPerCssY);
    if (!(heightClip > 0)) return 0;
    if (yScale.kind === 'log') {
      const { min, max } = yScale.getDomain();
      const mid = Math.sqrt(Math.max(min, Number.MIN_VALUE) * Math.max(max, Number.MIN_VALUE));
      const midClip = yScale.scale(mid);
      const lo = yScale.invert(midClip - heightClip * 0.5);
      const hi = yScale.invert(midClip + heightClip * 0.5);
      return Number.isFinite(lo) && Number.isFinite(hi) ? Math.abs(hi - lo) : 0;
    }
    const absAy = Math.abs(ay);
    return absAy > 1e-20 ? heightClip / absAy : 0;
  };

  return { cssWidthToDomainX, cssHeightToDomainY };
}
