export interface Tooltip {
  /**
   * Show tooltip at container-local CSS pixel coordinates.
   *
   * `content` is treated as HTML (assigned via `innerHTML`).
   */
  show(x: number, y: number, content: string): void;
  hide(): void;
  dispose(): void;
}

const clamp = (value: number, min: number, max: number): number => {
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

export function createTooltip(container: HTMLElement): Tooltip {
  const computedPosition = getComputedStyle(container).position;
  const didSetRelative = computedPosition === 'static';
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

  // Theme-friendly default visuals with CSS variable override points.
  root.style.zIndex = 'var(--chartgpu-tooltip-z, 10)';
  root.style.padding = 'var(--chartgpu-tooltip-padding, 6px 8px)';
  root.style.borderRadius = 'var(--chartgpu-tooltip-radius, 8px)';
  root.style.borderStyle = 'solid';
  root.style.borderWidth = 'var(--chartgpu-tooltip-border-width, 1px)';
  root.style.borderColor =
    'var(--chartgpu-tooltip-border, rgba(224,224,224,0.35))';
  root.style.boxShadow =
    'var(--chartgpu-tooltip-shadow, 0 6px 18px rgba(0,0,0,0.35))';
  root.style.maxWidth = 'var(--chartgpu-tooltip-max-width, min(320px, 100%))';
  root.style.overflow = 'hidden';
  root.style.fontFamily =
    'var(--chartgpu-tooltip-font-family, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji")';
  root.style.fontSize = 'var(--chartgpu-tooltip-font-size, 12px)';
  root.style.lineHeight = 'var(--chartgpu-tooltip-line-height, 1.2)';
  root.style.color = 'var(--chartgpu-tooltip-color, #e0e0e0)';
  root.style.background = 'var(--chartgpu-tooltip-bg, rgba(26,26,46,0.95))';
  root.style.whiteSpace = 'normal';

  // Transition-ready baseline; keep fade-out visible until completion.
  root.style.opacity = '0';
  root.style.transitionProperty = 'opacity';
  const fadeMs = 140;
  root.style.transitionDuration = `${fadeMs}ms`;
  root.style.transitionTimingFunction = 'ease';
  root.style.willChange = 'opacity';

  // Keep it out of layout/paint when hidden.
  root.style.display = 'none';
  root.style.visibility = 'hidden';

  root.setAttribute('role', 'tooltip');
  container.appendChild(root);

  let disposed = false;
  let transitionToken = 0;
  let hideTimeoutId: number | null = null;
  let rafId: number | null = null;

  const clearPendingTransitions = (): void => {
    if (hideTimeoutId != null) {
      window.clearTimeout(hideTimeoutId);
      hideTimeoutId = null;
    }
    if (rafId != null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const isCurrentlyHidden = (): boolean =>
    root.style.display === 'none' || root.style.visibility === 'hidden';

  const measureSize = (): Readonly<{ width: number; height: number }> => {
    // Measure without touching opacity to avoid restarting fades.
    // If the tooltip is currently visible, this temporarily hides it from paint
    // within the same call (no flicker between frames).
    const prevVisibility = root.style.visibility;
    root.style.visibility = 'hidden';

    // offsetWidth/offsetHeight are rounded but stable for layout decisions here.
    const width = root.offsetWidth;
    const height = root.offsetHeight;

    root.style.visibility = prevVisibility;
    return { width, height };
  };

  const show: Tooltip['show'] = (x, y, content) => {
    if (disposed) return;

    transitionToken += 1;
    clearPendingTransitions();

    const wasHidden = isCurrentlyHidden();

    root.innerHTML = content;

    const dx = 12;
    const dy = 12;
    const pad = 8;

    // Ensure it participates in layout for measurement & positioning.
    // Keep it hidden from paint until we finish placing it.
    root.style.display = 'block';
    root.style.visibility = 'hidden';

    const { width: w, height: h } = measureSize();

    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    let left = x + dx;
    let top = y + dy;

    if (left + w > containerW - pad) left = x - dx - w;
    if (top + h > containerH - pad) top = y - dy - h;

    left = clamp(left, pad, containerW - pad - w);
    top = clamp(top, pad, containerH - pad - h);

    root.style.left = `${left}px`;
    root.style.top = `${top}px`;

    root.style.visibility = 'visible';

    if (wasHidden) {
      // Only fade in on hidden -> visible transition.
      root.style.opacity = '0';
      const myToken = transitionToken;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (disposed) return;
        if (myToken !== transitionToken) return;
        root.style.opacity = '1';
      });
    } else {
      // Frequent updates while visible should not restart the fade.
      // Also cancels an in-progress hide fade-out by restoring opacity.
      root.style.opacity = '1';
    }
  };

  const hide: Tooltip['hide'] = () => {
    if (disposed) return;

    transitionToken += 1;
    clearPendingTransitions();

    // If it's already hidden, keep idempotent and avoid extra work.
    if (root.style.display === 'none' || root.style.visibility === 'hidden') {
      root.style.opacity = '0';
      root.style.visibility = 'hidden';
      root.style.display = 'none';
      return;
    }

    root.style.opacity = '0';

    const myToken = transitionToken;
    hideTimeoutId = window.setTimeout(() => {
      hideTimeoutId = null;
      if (disposed) return;
      if (myToken !== transitionToken) return;
      root.style.visibility = 'hidden';
      root.style.display = 'none';
    }, fadeMs + 50);
  };

  const dispose: Tooltip['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    try {
      clearPendingTransitions();
      root.remove();
    } finally {
      if (previousInlinePosition !== null) {
        container.style.position = previousInlinePosition;
      }
    }
  };

  return { show, hide, dispose };
}

