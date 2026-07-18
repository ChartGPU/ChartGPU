/**
 * Canvas sizing and measurement utilities for the RenderCoordinator.
 *
 * These pure functions handle canvas dimension retrieval with special handling
 * for device pixel ratio and GPU overlay coordinate conversions.
 *
 * @module canvasUtils
 */

/**
 * Gets canvas CSS width - clientWidth for HTMLCanvasElement.
 *
 * @param canvas - The canvas element to measure, or null
 * @returns CSS width in pixels, or 0 if canvas is null
 */
export function getCanvasCssWidth(canvas: HTMLCanvasElement | null): number {
  if (!canvas) {
    return 0;
  }

  return canvas.clientWidth;
}

/**
 * Layout CSS canvas size (`clientWidth`/`clientHeight`). Falls back to visual
 * `getBoundingClientRect` when layout is 0 (display:none / pre-layout).
 * Use with grid margins; never size the WebGPU buffer from the visual rect alone.
 */
export function getCanvasLayoutSizeCss(canvas: HTMLCanvasElement): {
  readonly width: number;
  readonly height: number;
} {
  const layoutWidth = canvas.clientWidth;
  const layoutHeight = canvas.clientHeight;
  if (layoutWidth > 0 && layoutHeight > 0) {
    return { width: layoutWidth, height: layoutHeight };
  }
  const rect = canvas.getBoundingClientRect();
  return { width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
}

/**
 * Maps pointer `clientX`/`clientY` into **layout** CSS pixels relative to the canvas.
 *
 * `getBoundingClientRect()` is visual (shrinks under CSS zoom / parent scale); grid margins
 * and plot layout use layout CSS (`clientWidth`/`clientHeight`). Multiply visual offsets by
 * `clientWidth/rect.width` so hit-tests stay aligned under CSS zoom. Backing-store sizing
 * must still use layout size only — never size the buffer from the visual rect.
 *
 * @returns Layout-local x/y and layout canvas size, or null if the visual rect is empty
 */
export function pointerClientToLayoutCss(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number
): { readonly x: number; readonly y: number; readonly layoutWidth: number; readonly layoutHeight: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;

  const layoutWidth = canvas.clientWidth;
  const layoutHeight = canvas.clientHeight;
  // display:none / pre-layout: fall back to visual so callers still get finite coords.
  if (!(layoutWidth > 0) || !(layoutHeight > 0)) {
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
      layoutWidth: rect.width,
      layoutHeight: rect.height,
    };
  }

  const scaleX = layoutWidth / rect.width;
  const scaleY = layoutHeight / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
    layoutWidth,
    layoutHeight,
  };
}

/**
 * Gets canvas CSS height - clientHeight for HTMLCanvasElement.
 *
 * @param canvas - The canvas element to measure, or null
 * @returns CSS height in pixels, or 0 if canvas is null
 */
export function getCanvasCssHeight(canvas: HTMLCanvasElement | null): number {
  if (!canvas) {
    return 0;
  }

  return canvas.clientHeight;
}

/**
 * Gets canvas CSS size derived strictly from device-pixel dimensions and DPR.
 *
 * This is intentionally different from `getCanvasCssWidth/Height(...)`:
 * - HTMLCanvasElement: `clientWidth/clientHeight` reflect DOM layout and can diverge (rounding, zoom, async resize)
 *   from the WebGPU render target size (`canvas.width/height` in device pixels).
 * - For GPU overlays that round-trip CSS↔device pixels in-shader, we must derive CSS size from
 *   `canvas.width/height` + DPR to keep transforms consistent with the render target.
 *
 * NOTE: Use this for GPU overlay coordinate conversion only (reference lines, markers).
 * Keep DOM overlays (labels/tooltips) using `clientWidth/clientHeight` for layout correctness.
 *
 * @param canvas - The canvas element to measure, or null
 * @param devicePixelRatio - The device pixel ratio (defaults to window.devicePixelRatio or 1)
 * @returns Object with width and height in CSS pixels derived from device pixels
 */
export function getCanvasCssSizeFromDevicePixels(
  canvas: HTMLCanvasElement | null,
  devicePixelRatio: number = typeof window !== 'undefined' ? window.devicePixelRatio : 1
): Readonly<{ width: number; height: number }> {
  if (!canvas) return { width: 0, height: 0 };
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // HTMLCanvasElement exposes `.width/.height` in device pixels.
  return { width: canvas.width / dpr, height: canvas.height / dpr };
}

/**
 * Clamps a value to an integer within [lo, hi] range.
 *
 * @param v - Value to clamp
 * @param lo - Lower bound (inclusive)
 * @param hi - Upper bound (inclusive)
 * @returns Clamped integer value
 */
export function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v | 0));
}
