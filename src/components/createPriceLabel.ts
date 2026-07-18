/**
 * Exchange-style last-price badge DOM overlay.
 *
 * Mirrors createTooltip / createLegend: absolute-positioned root inside the
 * chart overlay container, pointer-events none, dispose() removes DOM.
 *
 * K14: natural content width, no ellipsis, no grid auto-expand.
 * K15: public package export for advanced hosts / React bindings.
 */

export interface PriceLabelUpdateState {
  readonly visible: boolean;
  /** Container-local CSS px — horizontal anchor (see side). */
  readonly x: number;
  /** Container-local CSS px — vertical center of the badge. */
  readonly y: number;
  readonly priceText: string;
  /** Secondary countdown line; null hides the line. */
  readonly countdownText: string | null;
  /** Direction color (green/red). Always solid badge background. */
  readonly background: string;
  /** Badge text color (default typically `#ffffff`). */
  readonly color: string;
  /**
   * `'right'` — badge left edge at `x` (right price rail).
   * `'left'` — badge right edge at `x` (left price rail).
   */
  readonly side: 'left' | 'right';
  /** Opacity (e.g. 0.85 when out-of-domain clamp). Default 1. */
  readonly opacity?: number;
}

export interface PriceLabel {
  update(state: PriceLabelUpdateState): void;
  /** Countdown-only DOM text update (no full layout if height stable). */
  setCountdown(text: string | null): void;
  dispose(): void;
}

export function createPriceLabel(container: HTMLElement): PriceLabel {
  const computedPosition = getComputedStyle(container).position;
  // Treat empty/static as needing a positioning context (jsdom may report '').
  const didSetRelative = computedPosition === 'static' || computedPosition === '';
  const previousInlinePosition = didSetRelative ? container.style.position : null;

  if (didSetRelative) {
    container.style.position = 'relative';
  }

  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  root.style.pointerEvents = 'none';
  root.style.userSelect = 'none';
  root.style.boxSizing = 'border-box';
  // Above axis TextOverlay (10), below legend (15) / tooltip (20).
  root.style.zIndex = '12';
  root.style.padding = '2px 6px';
  root.style.borderRadius = '2px';
  root.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  root.style.fontSize = '11px';
  root.style.lineHeight = '1.25';
  root.style.fontVariantNumeric = 'tabular-nums';
  // K14: natural width; overflow OK; no ellipsis / text-overflow.
  root.style.whiteSpace = 'nowrap';
  root.style.overflow = 'visible';
  root.style.textOverflow = 'clip';
  root.style.display = 'none';
  root.style.visibility = 'hidden';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const priceEl = document.createElement('div');
  priceEl.style.fontWeight = '600';
  priceEl.style.whiteSpace = 'nowrap';

  const countdownEl = document.createElement('div');
  countdownEl.style.fontWeight = '400';
  countdownEl.style.fontSize = '10px';
  countdownEl.style.opacity = '0.95';
  countdownEl.style.whiteSpace = 'nowrap';
  countdownEl.style.display = 'none';

  root.appendChild(priceEl);
  root.appendChild(countdownEl);
  container.appendChild(root);

  let disposed = false;
  let lastCountdown: string | null = null;
  let lastVisible = false;
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let lastPriceText = '';
  let lastBackground = '';
  let lastColor = '';
  let lastSide: 'left' | 'right' | null = null;
  let lastOpacity = Number.NaN;

  /** Normalize empty string → null so identity skip compares one canonical form. */
  const normalizeCountdown = (text: string | null | undefined): string | null =>
    text == null || text.length === 0 ? null : text;

  const applyCountdown = (text: string | null): void => {
    // Caller must pass already-normalized `null | non-empty string`.
    if (text == null) {
      countdownEl.textContent = '';
      countdownEl.style.display = 'none';
      lastCountdown = null;
      return;
    }
    countdownEl.textContent = text;
    countdownEl.style.display = 'block';
    lastCountdown = text;
  };

  const applyTransform = (side: 'left' | 'right'): void => {
    // y is vertical center → always translateY(-50%).
    // left side: right edge at x → translate(-100%, -50%).
    root.style.transform = side === 'left' ? 'translate(-100%, -50%)' : 'translateY(-50%)';
  };

  const update: PriceLabel['update'] = (state) => {
    if (disposed) return;

    if (!state.visible) {
      if (lastVisible) {
        root.style.display = 'none';
        root.style.visibility = 'hidden';
        lastVisible = false;
      }
      return;
    }

    const opacity = state.opacity ?? 1;
    const countdown = normalizeCountdown(state.countdownText);
    const sameLayout =
      lastVisible &&
      lastX === state.x &&
      lastY === state.y &&
      lastPriceText === state.priceText &&
      lastBackground === state.background &&
      lastColor === state.color &&
      lastSide === state.side &&
      lastOpacity === opacity &&
      lastCountdown === countdown;

    if (sameLayout) return;

    root.style.display = 'block';
    root.style.visibility = 'visible';
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
    root.style.background = state.background;
    root.style.color = state.color;
    root.style.opacity = String(opacity);
    applyTransform(state.side);

    // textContent only — never innerHTML (XSS / formatTooltip isolation).
    if (lastPriceText !== state.priceText) {
      priceEl.textContent = state.priceText;
      lastPriceText = state.priceText;
    }

    if (lastCountdown !== countdown) {
      applyCountdown(countdown);
    }

    lastVisible = true;
    lastX = state.x;
    lastY = state.y;
    lastBackground = state.background;
    lastColor = state.color;
    lastSide = state.side;
    lastOpacity = opacity;
  };

  const setCountdown: PriceLabel['setCountdown'] = (text) => {
    if (disposed) return;
    const countdown = normalizeCountdown(text);
    if (countdown === lastCountdown) return;
    // Hide-only when not visible is still fine; next update() will re-apply.
    applyCountdown(countdown);
  };

  const dispose: PriceLabel['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    try {
      root.remove();
    } finally {
      if (previousInlinePosition !== null) {
        container.style.position = previousInlinePosition;
      }
    }
  };

  return { update, setCountdown, dispose };
}
