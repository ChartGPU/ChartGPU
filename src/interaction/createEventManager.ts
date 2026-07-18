import type { GridArea } from '../renderers/createGridRenderer';
import { pointerClientToLayoutCss } from '../core/renderCoordinator/utils/canvasUtils';

export type ChartGPUEventName = 'mousemove' | 'click' | 'mouseleave';

export type ChartGPUEventPayload = {
  /** Canvas-local X in **layout** CSS pixels (`clientWidth` space). */
  readonly x: number;
  /** Canvas-local Y in **layout** CSS pixels (`clientHeight` space). */
  readonly y: number;
  readonly gridX: number;
  readonly gridY: number;
  /** Plot (grid) width in layout CSS pixels. */
  readonly plotWidthCss: number;
  /** Plot (grid) height in layout CSS pixels. */
  readonly plotHeightCss: number;
  readonly isInGrid: boolean;
  readonly originalEvent: PointerEvent;
};

export type ChartGPUEventCallback = (payload: ChartGPUEventPayload) => void;

export interface EventManager {
  readonly canvas: HTMLCanvasElement;
  on(event: ChartGPUEventName, callback: ChartGPUEventCallback): void;
  off(event: ChartGPUEventName, callback: ChartGPUEventCallback): void;
  updateGridArea(gridArea: GridArea): void;
  dispose(): void;
}

type ListenerRegistry = Readonly<Record<ChartGPUEventName, Set<ChartGPUEventCallback>>>;

type TapCandidate = {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startTimeMs: number;
};

const DEFAULT_TAP_MAX_DISTANCE_CSS_PX = 6;
const DEFAULT_TAP_MAX_TIME_MS = 500;

export function createEventManager(canvas: HTMLCanvasElement, initialGridArea: GridArea): EventManager {
  let disposed = false;
  let gridArea = initialGridArea;

  const listeners: ListenerRegistry = {
    mousemove: new Set<ChartGPUEventCallback>(),
    click: new Set<ChartGPUEventCallback>(),
    mouseleave: new Set<ChartGPUEventCallback>(),
  };

  let tapCandidate: TapCandidate | null = null;
  let suppressNextLostPointerCaptureId: number | null = null;

  const toPayload = (e: PointerEvent): ChartGPUEventPayload | null => {
    // Layout CSS (clientWidth) — must match getPlotSizeCssPx / lastInteractionScales under CSS zoom.
    // Visual getBoundingClientRect alone under-sizes plotWidth and desyncs invert(gridX).
    const layout = pointerClientToLayoutCss(canvas, e.clientX, e.clientY);
    if (!layout) return null;

    const x = layout.x;
    const y = layout.y;

    const plotLeftCss = gridArea.left;
    const plotTopCss = gridArea.top;
    const plotWidthCss = layout.layoutWidth - gridArea.left - gridArea.right;
    const plotHeightCss = layout.layoutHeight - gridArea.top - gridArea.bottom;

    const gridX = x - plotLeftCss;
    const gridY = y - plotTopCss;

    const isInGrid = gridX >= 0 && gridX <= plotWidthCss && gridY >= 0 && gridY <= plotHeightCss;

    return {
      x,
      y,
      gridX,
      gridY,
      plotWidthCss,
      plotHeightCss,
      isInGrid,
      originalEvent: e,
    };
  };

  const emit = (eventName: ChartGPUEventName, e: PointerEvent): void => {
    const payload = toPayload(e);
    if (!payload) return;

    for (const cb of listeners[eventName]) cb(payload);
  };

  const clearTapCandidateIfMatches = (e: PointerEvent): void => {
    if (!tapCandidate) return;
    if (!e.isPrimary) return;
    if (e.pointerId !== tapCandidate.pointerId) return;
    tapCandidate = null;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (disposed) return;
    emit('mousemove', e);
  };

  const onPointerLeave = (e: PointerEvent): void => {
    if (disposed) return;
    clearTapCandidateIfMatches(e);
    emit('mouseleave', e);
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (disposed) return;
    clearTapCandidateIfMatches(e);
    emit('mouseleave', e);
  };

  const onLostPointerCapture = (e: PointerEvent): void => {
    if (disposed) return;
    if (suppressNextLostPointerCaptureId === e.pointerId) {
      suppressNextLostPointerCaptureId = null;
      return;
    }
    clearTapCandidateIfMatches(e);
    emit('mouseleave', e);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (disposed) return;
    if (!e.isPrimary) return;

    // For mouse, only allow left button.
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // If canvas has no size, treat as non-interactive (and avoid tap tracking).
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    tapCandidate = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTimeMs: e.timeStamp,
    };

    // Optional pointer capture improves reliability for touch/pen.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // best-effort
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (disposed) return;
    if (!e.isPrimary) return;
    if (!tapCandidate || e.pointerId !== tapCandidate.pointerId) return;

    const dt = e.timeStamp - tapCandidate.startTimeMs;
    const dx = e.clientX - tapCandidate.startClientX;
    const dy = e.clientY - tapCandidate.startClientY;
    const distSq = dx * dx + dy * dy;

    tapCandidate = null;

    // Release capture if we have it; suppress the resulting lostpointercapture.
    try {
      if (canvas.hasPointerCapture(e.pointerId)) {
        suppressNextLostPointerCaptureId = e.pointerId;
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // best-effort
    }

    const maxDist = DEFAULT_TAP_MAX_DISTANCE_CSS_PX;
    const isTap = dt <= DEFAULT_TAP_MAX_TIME_MS && distSq <= maxDist * maxDist;

    if (isTap) emit('click', e);
  };

  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerleave', onPointerLeave, { passive: true });
  canvas.addEventListener('pointercancel', onPointerCancel, { passive: true });
  canvas.addEventListener('lostpointercapture', onLostPointerCapture, {
    passive: true,
  });
  canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
  canvas.addEventListener('pointerup', onPointerUp, { passive: true });

  const on: EventManager['on'] = (event, callback) => {
    if (disposed) return;
    listeners[event].add(callback);
  };

  const off: EventManager['off'] = (event, callback) => {
    listeners[event].delete(callback);
  };

  const updateGridArea: EventManager['updateGridArea'] = (nextGridArea) => {
    gridArea = nextGridArea;
  };

  const dispose: EventManager['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    tapCandidate = null;
    suppressNextLostPointerCaptureId = null;

    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('lostpointercapture', onLostPointerCapture);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);

    listeners.mousemove.clear();
    listeners.click.clear();
    listeners.mouseleave.clear();
  };

  return { canvas, on, off, updateGridArea, dispose };
}
