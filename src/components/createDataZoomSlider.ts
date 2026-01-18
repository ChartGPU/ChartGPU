import type { ZoomRange, ZoomState } from '../interaction/createZoomState';
import type { ThemeConfig } from '../themes/types';

export interface DataZoomSlider {
  update(theme: ThemeConfig): void;
  dispose(): void;
}

export interface DataZoomSliderOptions {
  readonly height?: number;
  readonly marginTop?: number;
  readonly zIndex?: number;
  readonly showPreview?: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const normalizeRange = (range: ZoomRange): ZoomRange => {
  let { start, end } = range;
  if (start > end) {
    const t = start;
    start = end;
    end = t;
  }
  return { start: clamp(start, 0, 100), end: clamp(end, 0, 100) };
};

type DragMode = 'left-handle' | 'right-handle' | 'pan-window';

export function createDataZoomSlider(
  container: HTMLElement,
  zoomState: ZoomState,
  options?: DataZoomSliderOptions
): DataZoomSlider {
  const height = options?.height ?? 32;
  const marginTop = options?.marginTop ?? 8;
  const zIndex = options?.zIndex ?? 4;
  const showPreview = options?.showPreview ?? false;

  const root = document.createElement('div');
  root.style.display = 'block';
  root.style.width = '100%';
  root.style.height = `${height}px`;
  root.style.marginTop = `${marginTop}px`;
  root.style.boxSizing = 'border-box';
  root.style.position = 'relative';
  root.style.zIndex = `${zIndex}`;
  root.style.userSelect = 'none';
  root.style.touchAction = 'none';

  // track: full-width bar that hosts preview + window selection.
  const track = document.createElement('div');
  track.style.position = 'relative';
  track.style.height = '100%';
  track.style.width = '100%';
  track.style.boxSizing = 'border-box';
  track.style.borderRadius = '8px';
  track.style.borderStyle = 'solid';
  track.style.borderWidth = '1px';
  track.style.overflow = 'hidden';
  root.appendChild(track);

  // preview: miniature context under the selection (optional; can be a solid bar for now).
  const preview = document.createElement('div');
  preview.style.position = 'absolute';
  preview.style.inset = '0';
  preview.style.pointerEvents = 'none';
  preview.style.opacity = '0.4';
  preview.style.display = showPreview ? 'block' : 'none';
  track.appendChild(preview);

  // window: the selected range.
  const windowEl = document.createElement('div');
  windowEl.style.position = 'absolute';
  windowEl.style.top = '0';
  windowEl.style.bottom = '0';
  windowEl.style.left = '0%';
  windowEl.style.width = '100%';
  windowEl.style.boxSizing = 'border-box';
  windowEl.style.cursor = 'grab';
  track.appendChild(windowEl);

  // left/right handles.
  const leftHandle = document.createElement('div');
  leftHandle.style.position = 'absolute';
  leftHandle.style.left = '0';
  leftHandle.style.top = '0';
  leftHandle.style.bottom = '0';
  leftHandle.style.width = '10px';
  leftHandle.style.cursor = 'ew-resize';
  windowEl.appendChild(leftHandle);

  const rightHandle = document.createElement('div');
  rightHandle.style.position = 'absolute';
  rightHandle.style.right = '0';
  rightHandle.style.top = '0';
  rightHandle.style.bottom = '0';
  rightHandle.style.width = '10px';
  rightHandle.style.cursor = 'ew-resize';
  windowEl.appendChild(rightHandle);

  // center grip (hit target for panning).
  const centerGrip = document.createElement('div');
  centerGrip.style.position = 'absolute';
  centerGrip.style.left = '10px';
  centerGrip.style.right = '10px';
  centerGrip.style.top = '0';
  centerGrip.style.bottom = '0';
  centerGrip.style.cursor = 'grab';
  windowEl.appendChild(centerGrip);

  container.appendChild(root);

  let disposed = false;
  let activeDragCleanup: (() => void) | null = null;

  const applyRangeToDom = (range: ZoomRange): void => {
    const r = normalizeRange(range);
    const span = clamp(r.end - r.start, 0, 100);
    windowEl.style.left = `${r.start}%`;
    windowEl.style.width = `${span}%`;
  };

  const getTrackWidthPx = (): number | null => {
    // getBoundingClientRect() is robust even if the container is scaled.
    const w = track.getBoundingClientRect().width;
    return Number.isFinite(w) && w > 0 ? w : null;
  };

  const pxToPercent = (dxPx: number): number | null => {
    const w = getTrackWidthPx();
    if (w === null) return null;
    const p = (dxPx / w) * 100;
    return Number.isFinite(p) ? p : null;
  };

  const setPointerCaptureBestEffort = (el: Element, pointerId: number): void => {
    try {
      (el as HTMLElement).setPointerCapture(pointerId);
    } catch {
      // Ignore (best-effort).
    }
  };

  const releasePointerCaptureBestEffort = (el: Element, pointerId: number): void => {
    try {
      (el as HTMLElement).releasePointerCapture(pointerId);
    } catch {
      // Ignore (best-effort).
    }
  };

  const startDrag = (e: PointerEvent, mode: DragMode): void => {
    if (disposed) return;
    if (e.button !== 0) return;

    e.preventDefault();

    // If we somehow start a new drag while another is in-flight, clean up first.
    activeDragCleanup?.();
    activeDragCleanup = null;

    const dragStartX = e.clientX;
    const startRange = zoomState.getRange();

    const target = e.currentTarget instanceof Element ? e.currentTarget : windowEl;
    setPointerCaptureBestEffort(target, e.pointerId);

    if (mode === 'pan-window') {
      windowEl.style.cursor = 'grabbing';
      centerGrip.style.cursor = 'grabbing';
    }

    const onMove = (ev: PointerEvent): void => {
      if (disposed) return;
      if (ev.pointerId !== e.pointerId) return;

      ev.preventDefault();

      const dxPercent = pxToPercent(ev.clientX - dragStartX);
      if (dxPercent === null) return;

      switch (mode) {
        case 'left-handle': {
          // UX: don't allow handle crossing; clamp left <= current end.
          const nextStart = Math.min(startRange.end, startRange.start + dxPercent);
          zoomState.setRange(nextStart, startRange.end);
          return;
        }
        case 'right-handle': {
          // UX: don't allow handle crossing; clamp right >= current start.
          const nextEnd = Math.max(startRange.start, startRange.end + dxPercent);
          zoomState.setRange(startRange.start, nextEnd);
          return;
        }
        case 'pan-window': {
          zoomState.pan(dxPercent);
          return;
        }
      }
    };

    let finished = false;
    const finish = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      if (finished) return;
      finished = true;
      activeDragCleanup?.();
      activeDragCleanup = null;
    };

    const cleanup = (): void => {
      if (finished) return;
      finished = true;

      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);

      if (mode === 'pan-window') {
        windowEl.style.cursor = 'grab';
        centerGrip.style.cursor = 'grab';
      }

      releasePointerCaptureBestEffort(target, e.pointerId);
    };

    activeDragCleanup = cleanup;

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', finish, { passive: true });
    window.addEventListener('pointercancel', finish, { passive: true });
  };

  const onLeftDown = (e: PointerEvent): void => startDrag(e, 'left-handle');
  const onRightDown = (e: PointerEvent): void => startDrag(e, 'right-handle');
  const onPanDown = (e: PointerEvent): void => startDrag(e, 'pan-window');

  leftHandle.addEventListener('pointerdown', onLeftDown, { passive: false });
  rightHandle.addEventListener('pointerdown', onRightDown, { passive: false });
  centerGrip.addEventListener('pointerdown', onPanDown, { passive: false });

  // Keep DOM in sync with state.
  const unsubscribe = zoomState.onChange((range) => {
    if (disposed) return;
    applyRangeToDom(range);
  });

  // Initialize UI.
  applyRangeToDom(zoomState.getRange());

  const update: DataZoomSlider['update'] = (theme) => {
    if (disposed) return;

    // Baseline track styling.
    track.style.background = theme.backgroundColor;
    track.style.borderColor = theme.axisLineColor;

    // Preview styling (placeholder).
    preview.style.background = theme.gridLineColor;

    // Window styling.
    windowEl.style.background = theme.gridLineColor;
    windowEl.style.border = `1px solid ${theme.axisTickColor}`;
    windowEl.style.borderRadius = '8px';
    windowEl.style.boxSizing = 'border-box';

    // Handles styling.
    const handleBorder = `1px solid ${theme.axisLineColor}`;
    leftHandle.style.background = theme.axisTickColor;
    leftHandle.style.borderRight = handleBorder;
    rightHandle.style.background = theme.axisTickColor;
    rightHandle.style.borderLeft = handleBorder;

    // Center grip styling: subtle stripes.
    centerGrip.style.background = 'transparent';
    centerGrip.style.backgroundImage =
      'linear-gradient(90deg, rgba(255,255,255,0.0) 0, rgba(255,255,255,0.0) 42%, rgba(255,255,255,0.18) 42%, rgba(255,255,255,0.18) 46%, rgba(255,255,255,0.0) 46%, rgba(255,255,255,0.0) 54%, rgba(255,255,255,0.18) 54%, rgba(255,255,255,0.18) 58%, rgba(255,255,255,0.0) 58%, rgba(255,255,255,0.0) 100%)';
    centerGrip.style.mixBlendMode = 'normal';
  };

  const dispose: DataZoomSlider['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    // If dispose happens during an active drag, ensure we remove all window listeners.
    activeDragCleanup?.();
    activeDragCleanup = null;

    try {
      unsubscribe();
    } catch {
      // Best-effort.
    }

    leftHandle.removeEventListener('pointerdown', onLeftDown);
    rightHandle.removeEventListener('pointerdown', onRightDown);
    centerGrip.removeEventListener('pointerdown', onPanDown);

    root.remove();
  };

  return { update, dispose };
}

