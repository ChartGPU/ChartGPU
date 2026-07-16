export type TextOverlayAnchor = 'start' | 'middle' | 'end';

export interface TextOverlayLabelOptions {
  readonly fontSize?: number;
  readonly color?: string;
  readonly fontFamily?: string;
  /**
   * CSS/canvas font-weight (e.g. `'600'`, `bold`). Applied in the canvas
   * `ctx.font` string when set.
   */
  readonly fontWeight?: string | number;
  readonly anchor?: TextOverlayAnchor;
  /**
   * Rotation in degrees (CSS `rotate(<deg>deg)`).
   */
  readonly rotation?: number;
}

export interface TextOverlayOptions {
  /**
   * When true, clip labels to the overlay bounds (default: false).
   * Prevents labels from overflowing outside the container.
   */
  readonly clip?: boolean;
  /**
   * Canvas backing-store pixel ratio. Defaults to `window.devicePixelRatio`.
   * Pass the chart's resolved DPR (e.g. `options.devicePixelRatio ?? 1`) so
   * multi-chart dashboards at DPR 1 do not oversample labels vs the plot.
   */
  readonly devicePixelRatio?: number;
}

export interface TextOverlay {
  clear(): void;
  addLabel(text: string, x: number, y: number, options?: TextOverlayLabelOptions): HTMLSpanElement;
  dispose(): void;
}

/**
 * Canvas-backed text overlay for high-frequency axis label updates.
 *
 * Auto-ranging multi-chart / series compression rebuilds labels every frame.
 * DOM `createElement` + layout was a steady-state tax vs SciChart native text.
 * A single canvas `fillText` pass matches the TextOverlay API (addLabel still
 * returns a dummy span for callers that style it — styles are applied via
 * options on the next fill). Anchors use canvas `textAlign` (not CSS transforms).
 */
export function createTextOverlay(container: HTMLElement, options?: TextOverlayOptions): TextOverlay {
  const computedStyle = getComputedStyle(container);
  const computedPosition = computedStyle.position;
  const computedOverflow = computedStyle.overflow;

  const clip = options?.clip ?? false;
  const fixedDpr =
    options?.devicePixelRatio != null &&
    Number.isFinite(options.devicePixelRatio) &&
    options.devicePixelRatio > 0
      ? options.devicePixelRatio
      : null;

  const didSetRelative = computedPosition === 'static';
  const didSetOverflowVisible =
    !clip && (computedOverflow === 'hidden' || computedOverflow === 'scroll' || computedOverflow === 'auto');

  const previousInlinePosition = didSetRelative ? container.style.position : null;
  const previousInlineOverflow = didSetOverflowVisible ? container.style.overflow : null;

  if (didSetRelative) {
    container.style.position = 'relative';
  }

  if (didSetOverflowVisible) {
    container.style.overflow = 'visible';
  }

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '10';
  if (clip) {
    canvas.style.overflow = 'hidden';
  }
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let disposed = false;
  let dpr =
    fixedDpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

  type PendingLabel = {
    text: string;
    x: number;
    y: number;
    fontSize: number;
    color: string;
    fontFamily: string;
    fontWeight: string | number | undefined;
    anchor: TextOverlayAnchor;
    rotation: number;
  };
  const pending: PendingLabel[] = [];
  // Dummy span returned for API compat (callers may style it; canvas path ignores span).
  const dummySpan = typeof document !== 'undefined' ? document.createElement('span') : ({} as HTMLSpanElement);
  const defaultFontFamily =
    typeof window !== 'undefined'
      ? getComputedStyle(container).fontFamily || 'system-ui, sans-serif'
      : 'system-ui, sans-serif';

  const syncCanvasSize = (): void => {
    if (!ctx) return;
    const cssW = container.clientWidth || 0;
    const cssH = container.clientHeight || 0;
    dpr =
      fixedDpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const flush = (): void => {
    if (disposed || !ctx) return;
    syncCanvasSize();
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    ctx.clearRect(0, 0, cssW, cssH);
    for (let i = 0; i < pending.length; i++) {
      const lab = pending[i]!;
      ctx.save();
      const weightPrefix =
        lab.fontWeight !== undefined && lab.fontWeight !== '' ? `${lab.fontWeight} ` : '';
      ctx.font = `${weightPrefix}${lab.fontSize}px ${lab.fontFamily}`;
      ctx.fillStyle = lab.color;
      ctx.textBaseline = 'middle';
      if (lab.anchor === 'middle') ctx.textAlign = 'center';
      else if (lab.anchor === 'end') ctx.textAlign = 'right';
      else ctx.textAlign = 'left';

      if (lab.rotation !== 0) {
        ctx.translate(lab.x, lab.y);
        ctx.rotate((lab.rotation * Math.PI) / 180);
        ctx.fillText(lab.text, 0, 0);
      } else {
        ctx.fillText(lab.text, lab.x, lab.y);
      }
      ctx.restore();
    }
  };

  let flushScheduled = false;
  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    // Microtask: axis labels call clear + many addLabel then finish; flush once.
    queueMicrotask(() => {
      flushScheduled = false;
      if (!disposed) flush();
    });
  };

  const clear = (): void => {
    if (disposed) return;
    pending.length = 0;
    scheduleFlush();
  };

  const addLabel: TextOverlay['addLabel'] = (text, x, y, options) => {
    if (disposed) {
      return dummySpan;
    }
    pending.push({
      text,
      x,
      y,
      fontSize: options?.fontSize ?? 12,
      color: options?.color ?? '#000',
      fontFamily: options?.fontFamily ?? defaultFontFamily,
      fontWeight: options?.fontWeight,
      anchor: options?.anchor ?? 'start',
      rotation: options?.rotation ?? 0,
    });
    scheduleFlush();
    return dummySpan;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    pending.length = 0;

    try {
      canvas.remove();
    } finally {
      if (previousInlinePosition !== null) {
        container.style.position = previousInlinePosition;
      }
      if (previousInlineOverflow !== null) {
        container.style.overflow = previousInlineOverflow;
      }
    }
  };

  return { clear, addLabel, dispose };
}
