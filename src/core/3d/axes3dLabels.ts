/**
 * DOM-projected 3D axis tick labels + titles (`labelMode: 'dom'`, and fallback).
 * Host must be (or becomes) `position: relative|absolute|fixed` so absolute labels lay out correctly.
 * If we set `relative` on a previously static host, dispose restores the prior inline position.
 * GPU path: see createAxes3DGpuLabelsRenderer — exclusive with this overlay.
 */

import type { Mat4 } from './mat4';
import type { AABB } from './aabb';
import { projectWorldToCss } from './projectWorldToCss';
import { buildAxes3DLabelItems } from './axes3dLabelItems';
import type { Axes3DTickPlan } from '../../renderers/createAxisBox3DRenderer';
import type { ResolvedAxes3D } from '../../config/OptionResolver';

export interface Axes3DLabels {
  update(
    host: HTMLElement,
    aabb: AABB,
    plan: Axes3DTickPlan,
    axes: ResolvedAxes3D,
    viewProj: Mat4,
    viewportCssW: number,
    viewportCssH: number,
    textColor: string
  ): void;
  clear(): void;
  dispose(): void;
}

const labelStyle = (el: HTMLElement, color: string, isTitle: boolean): void => {
  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.top = '0';
  el.style.pointerEvents = 'none';
  el.style.userSelect = 'none';
  el.style.whiteSpace = 'nowrap';
  el.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  el.style.fontSize = isTitle ? '12px' : '10px';
  el.style.fontWeight = isTitle ? '600' : '400';
  el.style.color = color;
  el.style.textShadow = '0 1px 2px rgba(0,0,0,0.85)';
  el.style.transform = 'translate(-50%, -50%)';
  el.style.zIndex = '8';
  el.style.opacity = '0.92';
};

export function createAxes3DLabels(): Axes3DLabels {
  let root: HTMLDivElement | null = null;
  let disposed = false;
  let hostEl: HTMLElement | null = null;
  let didSetRelative = false;
  let previousInlinePosition: string | null = null;
  /** Reused spans so orbit / strip stream do not thrash DOM every frame. */
  let spanPool: HTMLSpanElement[] = [];

  const ensureRoot = (host: HTMLElement): HTMLDivElement => {
    if (root && root.parentElement === host) return root;
    if (root?.parentElement) root.parentElement.removeChild(root);
    // Restore previous host if we moved
    if (hostEl && hostEl !== host && didSetRelative) {
      hostEl.style.position = previousInlinePosition ?? '';
    }
    hostEl = host;
    root = document.createElement('div');
    root.setAttribute('data-chartgpu-axes3d-labels', 'true');
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    root.style.right = '0';
    root.style.bottom = '0';
    root.style.pointerEvents = 'none';
    root.style.overflow = 'hidden';
    root.style.zIndex = '8';
    spanPool = [];
    const pos = getComputedStyle(host).position;
    if (pos === 'static') {
      previousInlinePosition = host.style.position;
      host.style.position = 'relative';
      didSetRelative = true;
    } else {
      didSetRelative = false;
      previousInlinePosition = null;
    }
    host.appendChild(root);
    return root;
  };

  return {
    update(host, aabb, plan, axes, viewProj, viewportCssW, viewportCssH, textColor) {
      if (disposed) return;
      const el = ensureRoot(host);
      const items = buildAxes3DLabelItems(aabb, plan, axes);

      const placed: { x: number; y: number }[] = [];
      let used = 0;
      for (const it of items) {
        const p = projectWorldToCss(viewProj, it.x, it.y, it.z, viewportCssW, viewportCssH);
        if (!p.visible) continue;
        if (p.x < -20 || p.y < -20 || p.x > viewportCssW + 20 || p.y > viewportCssH + 20) continue;
        let overlap = false;
        for (const q of placed) {
          if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < (it.title ? 400 : 196)) {
            overlap = true;
            break;
          }
        }
        if (overlap && !it.title) continue;
        placed.push({ x: p.x, y: p.y });

        let span = spanPool[used];
        if (!span) {
          span = document.createElement('span');
          el.appendChild(span);
          spanPool[used] = span;
        }
        labelStyle(span, textColor, it.title);
        if (span.textContent !== it.text) span.textContent = it.text;
        span.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
        span.style.display = '';
        used++;
      }
      for (let i = used; i < spanPool.length; i++) {
        const spare = spanPool[i];
        if (spare) spare.style.display = 'none';
      }
    },
    /**
     * Hide labels and detach the overlay root (e.g. when switching to GPU mode).
     * Restores host `position` if we had forced `relative`. Safe to call every frame
     * but coordinator should call once on transition into GPU mode.
     */
    clear() {
      if (root?.parentElement) root.parentElement.removeChild(root);
      root = null;
      spanPool = [];
      if (hostEl && didSetRelative) {
        hostEl.style.position = previousInlinePosition ?? '';
      }
      hostEl = null;
      didSetRelative = false;
      previousInlinePosition = null;
    },
    dispose() {
      disposed = true;
      // Detach root + restore host (same as clear).
      if (root?.parentElement) root.parentElement.removeChild(root);
      root = null;
      spanPool = [];
      if (hostEl && didSetRelative) {
        hostEl.style.position = previousInlinePosition ?? '';
      }
      hostEl = null;
      didSetRelative = false;
      previousInlinePosition = null;
    },
  };
}
