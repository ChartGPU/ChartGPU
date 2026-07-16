// @vitest-environment jsdom
/**
 * Canvas text overlay — chart DPR backing store option and font options.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTextOverlay } from '../createTextOverlay';

describe('createTextOverlay', () => {
  let host: HTMLDivElement | null = null;
  let overlay: ReturnType<typeof createTextOverlay> | null = null;
  let mockCtx: {
    setTransform: ReturnType<typeof vi.fn>;
    clearRect: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    fillText: ReturnType<typeof vi.fn>;
    translate: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
    measureText: () => { width: number };
    font: string;
    fillStyle: string;
    textBaseline: string;
    textAlign: string;
  };

  beforeEach(() => {
    // jsdom has no real 2d context; provide a stub so flush/syncCanvasSize runs.
    mockCtx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      fillText: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      measureText: () => ({ width: 10 }),
      font: '',
      fillStyle: '',
      textBaseline: 'middle',
      textAlign: 'left',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    overlay?.dispose();
    overlay = null;
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  function mountHost(cssW: number, cssH: number): HTMLDivElement {
    const el = document.createElement('div');
    el.style.position = 'relative';
    el.style.width = `${cssW}px`;
    el.style.height = `${cssH}px`;
    document.body.appendChild(el);
    vi.spyOn(el, 'clientWidth', 'get').mockReturnValue(cssW);
    vi.spyOn(el, 'clientHeight', 'get').mockReturnValue(cssH);
    return el;
  }

  it('uses options.devicePixelRatio for canvas backing store (not window DPR alone)', async () => {
    host = mountHost(100, 50);
    overlay = createTextOverlay(host, { devicePixelRatio: 1 });
    overlay.addLabel('hi', 10, 10, { fontSize: 12, color: '#000' });
    await Promise.resolve();

    const canvas = host.querySelector('canvas');
    expect(canvas).toBeTruthy();
    // css 100×50 at chart DPR 1 → 100×50 backing store
    expect(canvas!.width).toBe(100);
    expect(canvas!.height).toBe(50);
  });

  it('scales backing store when devicePixelRatio is 2', async () => {
    host = mountHost(80, 40);
    overlay = createTextOverlay(host, { devicePixelRatio: 2 });
    overlay.addLabel('x', 0, 0);
    await Promise.resolve();

    const canvas = host.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect(canvas!.width).toBe(160);
    expect(canvas!.height).toBe(80);
  });

  it('applies fontWeight in the canvas font string', async () => {
    host = mountHost(100, 50);
    overlay = createTextOverlay(host, { devicePixelRatio: 1 });
    overlay.addLabel('Title', 10, 10, {
      fontSize: 14,
      fontFamily: 'sans-serif',
      fontWeight: '600',
      color: '#fff',
    });
    await Promise.resolve();

    expect(mockCtx.font).toBe('600 14px sans-serif');
    expect(mockCtx.fillText).toHaveBeenCalledWith('Title', 10, 10);
  });

  it('omits weight prefix when fontWeight is not set', async () => {
    host = mountHost(100, 50);
    overlay = createTextOverlay(host, { devicePixelRatio: 1 });
    overlay.addLabel('Tick', 0, 0, {
      fontSize: 12,
      fontFamily: 'monospace',
      color: '#000',
    });
    await Promise.resolve();

    expect(mockCtx.font).toBe('12px monospace');
  });
});
