// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createZoomResetButton } from '../createZoomResetButton';
import type { ZoomState, ZoomRange } from '../../interaction/createZoomState';
import type { ThemeConfig } from '../../themes/types';

function createMockZoomState(initial: ZoomRange = { start: 0, end: 100 }): ZoomState & {
  triggerChange(range: ZoomRange): void;
  lastSetRange: ZoomRange | null;
} {
  let range = { ...initial };
  let lastSetRange: ZoomRange | null = null;
  const subs = new Set<(r: ZoomRange) => void>();

  return {
    get lastSetRange() { return lastSetRange; },
    triggerChange(r: ZoomRange) { range = r; subs.forEach(cb => cb(r)); },
    getRange: () => range,
    setRange: (s, e) => { range = { start: s, end: e }; lastSetRange = range; subs.forEach(cb => cb(range)); },
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    pan: vi.fn(),
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
  };
}

function createMockTheme(): ThemeConfig {
  return {
    backgroundColor: '#1a1a2e',
    textColor: '#e0e0e0',
    axisLineColor: '#444',
    axisTickColor: '#666',
    gridLineColor: 'rgba(255,255,255,0.1)',
    fontFamily: 'sans-serif',
    colorPalette: ['#5470c6'],
    fontSize: 12,
  };
}

describe('createZoomResetButton', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 2, configurable: true });
  });

  afterEach(() => {
    container.remove();
  });

  it('is hidden when zoom is at full range', () => {
    const zs = createMockZoomState({ start: 0, end: 100 });
    const btn = createZoomResetButton(container, zs, createMockTheme());
    const el = container.querySelector('[data-chartgpu-zoom-reset]');
    expect(el).toBeTruthy();
    expect((el as HTMLElement).style.display).toBe('none');
    btn.dispose();
  });

  it('is visible when zoomed in', () => {
    const zs = createMockZoomState({ start: 20, end: 80 });
    const btn = createZoomResetButton(container, zs, createMockTheme());
    const el = container.querySelector('[data-chartgpu-zoom-reset]') as HTMLElement;
    expect(el.style.display).not.toBe('none');
    btn.dispose();
  });

  it('becomes visible when zoom state changes to zoomed', () => {
    const zs = createMockZoomState({ start: 0, end: 100 });
    const btn = createZoomResetButton(container, zs, createMockTheme());
    const el = container.querySelector('[data-chartgpu-zoom-reset]') as HTMLElement;
    expect(el.style.display).toBe('none');
    zs.triggerChange({ start: 10, end: 90 });
    expect(el.style.display).not.toBe('none');
    btn.dispose();
  });

  it('resets zoom to full range on click', () => {
    const zs = createMockZoomState({ start: 20, end: 80 });
    const btn = createZoomResetButton(container, zs, createMockTheme());
    const el = container.querySelector('[data-chartgpu-zoom-reset]') as HTMLElement;
    el.click();
    expect(zs.lastSetRange).toEqual({ start: 0, end: 100 });
    btn.dispose();
  });

  it('removes DOM element on dispose', () => {
    const zs = createMockZoomState({ start: 20, end: 80 });
    const btn = createZoomResetButton(container, zs, createMockTheme());
    expect(container.querySelector('[data-chartgpu-zoom-reset]')).toBeTruthy();
    btn.dispose();
    expect(container.querySelector('[data-chartgpu-zoom-reset]')).toBeNull();
  });

  it('is hidden on non-touch devices', () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    const zs = createMockZoomState({ start: 20, end: 80 });
    const btn = createZoomResetButton(container, zs, createMockTheme());
    const el = container.querySelector('[data-chartgpu-zoom-reset]') as HTMLElement;
    expect(el.style.display).toBe('none');
    btn.dispose();
  });
});
