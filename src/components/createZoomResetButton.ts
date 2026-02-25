import type { ZoomState } from '../interaction/createZoomState';
import type { ThemeConfig } from '../themes/types';

export interface ZoomResetButton {
  update(theme: ThemeConfig): void;
  dispose(): void;
}

/** Tolerance for considering zoom at full range (avoids float imprecision flicker). */
const FULL_RANGE_EPSILON = 0.01;
const isFullRange = (start: number, end: number): boolean =>
  start <= FULL_RANGE_EPSILON && end >= 100 - FULL_RANGE_EPSILON;

const isTouchDevice = (): boolean =>
  typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

export function createZoomResetButton(
  container: HTMLElement,
  zoomState: ZoomState,
  theme: ThemeConfig,
): ZoomResetButton {
  let disposed = false;
  const touchCapable = isTouchDevice();

  const el = document.createElement('button');
  el.setAttribute('data-chartgpu-zoom-reset', '');
  el.setAttribute('aria-label', 'Reset zoom');
  el.type = 'button';

  // Styling
  el.style.position = 'absolute';
  el.style.top = '8px';
  el.style.right = '8px';
  el.style.zIndex = '10';
  el.style.width = '32px';
  el.style.height = '32px';
  el.style.border = 'none';
  el.style.borderRadius = '6px';
  el.style.cursor = 'pointer';
  el.style.display = 'none';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.fontSize = '16px';
  el.style.lineHeight = '1';
  el.style.padding = '0';
  el.style.touchAction = 'manipulation';
  el.textContent = '\u21BA'; // reset arrow

  const applyTheme = (t: ThemeConfig): void => {
    // Use the theme background with reduced opacity. Setting opacity on the element
    // keeps the approach format-agnostic (works with hex, rgb, hsl, etc.).
    el.style.backgroundColor = t.backgroundColor;
    el.style.opacity = '0.8';
    el.style.color = t.textColor;
  };
  applyTheme(theme);

  const updateVisibility = (): void => {
    if (!touchCapable) {
      el.style.display = 'none';
      return;
    }
    const { start, end } = zoomState.getRange();
    el.style.display = isFullRange(start, end) ? 'none' : 'flex';
  };
  updateVisibility();

  const onClick = (): void => {
    if (disposed) return;
    zoomState.setRange(0, 100);
  };

  el.addEventListener('click', onClick);

  const unsubscribe = zoomState.onChange(() => {
    if (disposed) return;
    updateVisibility();
  });

  container.appendChild(el);

  return {
    update(t: ThemeConfig): void {
      if (disposed) return;
      applyTheme(t);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      el.removeEventListener('click', onClick);
      try { unsubscribe(); } catch { /* best-effort */ }
      el.remove();
    },
  };
}
