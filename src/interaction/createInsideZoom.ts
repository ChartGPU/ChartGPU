import type { EventManager, ChartGPUEventPayload } from './createEventManager';
import type { ZoomState } from './createZoomState';

export type InsideZoom = Readonly<{
  enable(): void;
  disable(): void;
  dispose(): void;
}>;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const normalizeWheelDelta = (e: WheelEvent, basisCssPx: number): number => {
  const raw = e.deltaY;
  if (!Number.isFinite(raw) || raw === 0) return 0;

  // Normalize to CSS pixels-ish so sensitivity is stable across deltaMode.
  switch (e.deltaMode) {
    case WheelEvent.DOM_DELTA_PIXEL:
      return raw;
    case WheelEvent.DOM_DELTA_LINE:
      return raw * 16;
    case WheelEvent.DOM_DELTA_PAGE:
      return raw * (Number.isFinite(basisCssPx) && basisCssPx > 0 ? basisCssPx : 800);
    default:
      return raw;
  }
};

const normalizeWheelDeltaX = (e: WheelEvent, basisCssPx: number): number => {
  const raw = e.deltaX;
  if (!Number.isFinite(raw) || raw === 0) return 0;

  // Normalize to CSS pixels-ish so sensitivity is stable across deltaMode.
  switch (e.deltaMode) {
    case WheelEvent.DOM_DELTA_PIXEL:
      return raw;
    case WheelEvent.DOM_DELTA_LINE:
      return raw * 16;
    case WheelEvent.DOM_DELTA_PAGE:
      return raw * (Number.isFinite(basisCssPx) && basisCssPx > 0 ? basisCssPx : 800);
    default:
      return raw;
  }
};

const wheelDeltaToZoomFactor = (deltaCssPx: number): number => {
  // Positive delta = scroll down = zoom out; negative = zoom in.
  const abs = Math.abs(deltaCssPx);
  if (!Number.isFinite(abs) || abs === 0) return 1;

  // Cap extreme deltas (some devices can emit huge values).
  const capped = Math.min(abs, 200);
  const sensitivity = 0.002;
  return Math.exp(capped * sensitivity);
};

const isMiddleButtonDrag = (e: PointerEvent): boolean =>
  e.pointerType === 'mouse' && (e.buttons & 4) !== 0;

const isShiftLeftDrag = (e: PointerEvent): boolean =>
  e.pointerType === 'mouse' && e.shiftKey && (e.buttons & 1) !== 0;

/**
 * Internal “inside” zoom interaction:
 * - wheel zoom centered at cursor-x (only when inside grid)
 * - shift+left drag OR middle-mouse drag pans left/right (only when inside grid)
 */
export function createInsideZoom(eventManager: EventManager, zoomState: ZoomState): InsideZoom {
  let disposed = false;
  let enabled = false;

  let lastPointer: ChartGPUEventPayload | null = null;
  let isPanning = false;
  let lastPanGridX = 0;

  const clearPan = (): void => {
    isPanning = false;
    lastPanGridX = 0;
  };

  const onMouseMove = (payload: ChartGPUEventPayload): void => {
    lastPointer = payload;
    if (!enabled) return;

    // Pan only for mouse drags, only when inside grid.
    const e = payload.originalEvent;
    const shouldPan = payload.isInGrid && (isShiftLeftDrag(e) || isMiddleButtonDrag(e));

    if (!shouldPan) {
      clearPan();
      return;
    }

    const plotWidthCss = payload.plotWidthCss;
    if (!(plotWidthCss > 0) || !Number.isFinite(plotWidthCss)) {
      clearPan();
      return;
    }

    if (!isPanning) {
      isPanning = true;
      lastPanGridX = payload.gridX;
      return;
    }

    const dxCss = payload.gridX - lastPanGridX;
    lastPanGridX = payload.gridX;
    if (!Number.isFinite(dxCss) || dxCss === 0) return;

    const { start, end } = zoomState.getRange();
    const span = end - start;
    if (!Number.isFinite(span) || span === 0) return;

    // Convert grid-local px to percent points *within the current window*.
    // “Grab to pan” behavior: dragging right should move the window left (show earlier data).
    const deltaPct = -(dxCss / plotWidthCss) * span;
    if (!Number.isFinite(deltaPct) || deltaPct === 0) return;
    zoomState.pan(deltaPct);
  };

  const onMouseLeave = (_payload: ChartGPUEventPayload): void => {
    lastPointer = null;
    clearPan();
  };

  const onWheel = (e: WheelEvent): void => {
    if (!enabled || disposed) return;

    const p = lastPointer;
    if (!p || !p.isInGrid) return;

    const plotWidthCss = p.plotWidthCss;
    const plotHeightCss = p.plotHeightCss;
    if (!(plotWidthCss > 0) || !(plotHeightCss > 0)) return;

    const deltaYCss = normalizeWheelDelta(e, plotHeightCss);
    const deltaXCss = normalizeWheelDeltaX(e, plotWidthCss);

    // Check if horizontal scroll is dominant (pan operation).
    if (Math.abs(deltaXCss) > Math.abs(deltaYCss) && deltaXCss !== 0) {
      const { start, end } = zoomState.getRange();
      const span = end - start;
      if (!Number.isFinite(span) || span === 0) return;

      // Convert horizontal scroll delta to percent pan.
      // Positive deltaX = scroll right = pan right (show earlier data).
      const deltaPct = (deltaXCss / plotWidthCss) * span;
      if (!Number.isFinite(deltaPct) || deltaPct === 0) return;

      e.preventDefault();
      zoomState.pan(deltaPct);
      return;
    }

    // Otherwise, proceed with vertical scroll zoom logic.
    if (deltaYCss === 0) return;

    const factor = wheelDeltaToZoomFactor(deltaYCss);
    if (!(factor > 1)) return;

    const { start, end } = zoomState.getRange();
    const span = end - start;
    if (!Number.isFinite(span) || span === 0) return;
    const r = clamp(p.gridX / plotWidthCss, 0, 1);
    const centerPct = clamp(start + r * span, 0, 100);

    // Only prevent default when we are actually consuming the wheel to zoom.
    e.preventDefault();

    if (deltaYCss < 0) zoomState.zoomIn(centerPct, factor);
    else zoomState.zoomOut(centerPct, factor);
  };

  const enable: InsideZoom['enable'] = () => {
    if (disposed || enabled) return;
    enabled = true;
    eventManager.on('mousemove', onMouseMove);
    eventManager.on('mouseleave', onMouseLeave);
    eventManager.canvas.addEventListener('wheel', onWheel, { passive: false });
  };

  const disable: InsideZoom['disable'] = () => {
    if (disposed || !enabled) return;
    enabled = false;
    eventManager.off('mousemove', onMouseMove);
    eventManager.off('mouseleave', onMouseLeave);
    eventManager.canvas.removeEventListener('wheel', onWheel);
    lastPointer = null;
    clearPan();
  };

  const dispose: InsideZoom['dispose'] = () => {
    if (disposed) return;
    disable();
    disposed = true;
  };

  return { enable, disable, dispose };
}

