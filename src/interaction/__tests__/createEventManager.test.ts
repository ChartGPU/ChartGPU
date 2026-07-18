/// <reference types="@webgpu/types" />
/**
 * EventManager pointer → layout CSS mapping (issue #155 / CSS zoom).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEventManager } from '../createEventManager';
import type { GridArea } from '../../renderers/createGridRenderer';

function createMockCanvas(opts: {
  clientWidth: number;
  clientHeight: number;
  rectWidth: number;
  rectHeight: number;
}): HTMLCanvasElement {
  return {
    clientWidth: opts.clientWidth,
    clientHeight: opts.clientHeight,
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      width: opts.rectWidth,
      height: opts.rectHeight,
      right: opts.rectWidth,
      bottom: opts.rectHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  } as any;
}

const gridArea: GridArea = {
  left: 40,
  right: 20,
  top: 10,
  bottom: 30,
  canvasWidth: 2000,
  canvasHeight: 1000,
  devicePixelRatio: 2,
};

describe('createEventManager layout CSS (CSS zoom)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps visual pointer to layout coords and plot size (client ≠ rect)', () => {
    // Layout 1000×500, visual 300×150 (CSS zoom 0.3); margins layout 40/20/10/30
    const canvas = createMockCanvas({
      clientWidth: 1000,
      clientHeight: 500,
      rectWidth: 300,
      rectHeight: 150,
    });
    const em = createEventManager(canvas, gridArea);
    const payloads: Array<
      ReturnType<NonNullable<ReturnType<typeof createEventManager>['on']>> extends never ? never : any
    > = [];

    const seen: any[] = [];
    em.on('mousemove', (p) => {
      seen.push(p);
    });

    // Fire pointermove at visual center (150, 75) → layout center (500, 250)
    const listeners = (canvas.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === 'pointermove')
      .map((c) => c[1] as (e: PointerEvent) => void);
    expect(listeners.length).toBeGreaterThan(0);

    listeners[0]!({
      clientX: 150,
      clientY: 75,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      timeStamp: 0,
    } as PointerEvent);

    expect(seen).toHaveLength(1);
    const p = seen[0]!;
    expect(p.x).toBeCloseTo(500);
    expect(p.y).toBeCloseTo(250);
    // plot size from layout, not visual: 1000-40-20=940, 500-10-30=460
    expect(p.plotWidthCss).toBe(940);
    expect(p.plotHeightCss).toBe(460);
    expect(p.gridX).toBeCloseTo(500 - 40);
    expect(p.gridY).toBeCloseTo(250 - 10);
    expect(p.isInGrid).toBe(true);

    em.dispose();
  });

  it('does not under-size plotWidth from visual rect under CSS zoom', () => {
    const canvas = createMockCanvas({
      clientWidth: 1000,
      clientHeight: 500,
      rectWidth: 300,
      rectHeight: 150,
    });
    const em = createEventManager(canvas, gridArea);
    const seen: any[] = [];
    em.on('mousemove', (p) => seen.push(p));

    const move = (canvas.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'pointermove'
    )![1] as (e: PointerEvent) => void;

    move({ clientX: 10, clientY: 10 } as PointerEvent);

    // Bug before fix: plotWidth = 300 - 40 - 20 = 240 (visual)
    expect(seen[0].plotWidthCss).not.toBe(300 - 40 - 20);
    expect(seen[0].plotWidthCss).toBe(1000 - 40 - 20);

    em.dispose();
  });
});
