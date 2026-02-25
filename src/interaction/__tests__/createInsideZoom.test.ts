import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInsideZoom } from '../createInsideZoom';
import type { EventManager, ChartGPUEventPayload } from '../createEventManager';
import type { ZoomState } from '../createZoomState';
import type { ZoomRange } from '../createZoomState';

// --- helpers -----------------------------------------------------------

function createMockEventManager(): EventManager & {
  canvas: HTMLCanvasElement;
  simulatePointerDown(e: Partial<PointerEvent>): void;
  simulatePointerMove(e: Partial<PointerEvent>): void;
  simulatePointerUp(e: Partial<PointerEvent>): void;
  simulatePointerCancel(e: Partial<PointerEvent>): void;
  fireMouseMove(payload: ChartGPUEventPayload): void;
  fireMouseLeave(payload: ChartGPUEventPayload): void;
} {
  const cbs: Record<string, Set<(p: ChartGPUEventPayload) => void>> = {
    mousemove: new Set(),
    click: new Set(),
    mouseleave: new Set(),
  };

  const canvasListeners: Record<string, EventListener[]> = {};

  const canvas = {
    addEventListener: vi.fn((type: string, listener: EventListener, _opts?: unknown) => {
      (canvasListeners[type] ??= []).push(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      const list = canvasListeners[type];
      if (list) {
        const idx = list.indexOf(listener);
        if (idx >= 0) list.splice(idx, 1);
      }
    }),
    getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 800, height: 600 })),
    style: {} as CSSStyleDeclaration,
  } as unknown as HTMLCanvasElement;

  const fireCanvasEvent = (type: string, e: Partial<PointerEvent>) => {
    const listeners = canvasListeners[type] ?? [];
    for (const l of listeners) l(e as Event);
  };

  return {
    canvas,
    on: vi.fn((event: string, cb: (p: ChartGPUEventPayload) => void) => {
      cbs[event]?.add(cb);
    }),
    off: vi.fn((event: string, cb: (p: ChartGPUEventPayload) => void) => {
      cbs[event]?.delete(cb);
    }),
    updateGridArea: vi.fn(),
    dispose: vi.fn(),
    simulatePointerDown: (e) => fireCanvasEvent('pointerdown', e),
    simulatePointerMove: (e) => fireCanvasEvent('pointermove', e),
    simulatePointerUp: (e) => fireCanvasEvent('pointerup', e),
    simulatePointerCancel: (e) => fireCanvasEvent('pointercancel', e),
    fireMouseMove: (p) => { for (const cb of cbs.mousemove) cb(p); },
    fireMouseLeave: (p) => { for (const cb of cbs.mouseleave) cb(p); },
  };
}

function createMockZoomState(initial: ZoomRange = { start: 0, end: 100 }): ZoomState & {
  range: ZoomRange;
  panCalls: number[];
  zoomInCalls: Array<{ center: number; factor: number }>;
  zoomOutCalls: Array<{ center: number; factor: number }>;
} {
  let range = { ...initial };
  const panCalls: number[] = [];
  const zoomInCalls: Array<{ center: number; factor: number }> = [];
  const zoomOutCalls: Array<{ center: number; factor: number }> = [];
  const subs = new Set<(r: ZoomRange) => void>();

  return {
    get range() { return range; },
    panCalls,
    zoomInCalls,
    zoomOutCalls,
    getRange: () => range,
    setRange: (s, e) => { range = { start: s, end: e }; subs.forEach(cb => cb(range)); },
    zoomIn: (center, factor) => { zoomInCalls.push({ center, factor }); },
    zoomOut: (center, factor) => { zoomOutCalls.push({ center, factor }); },
    pan: (delta) => { panCalls.push(delta); },
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
  };
}

function makePayload(overrides: Partial<ChartGPUEventPayload> = {}): ChartGPUEventPayload {
  return {
    x: 400, y: 300, gridX: 340, gridY: 260,
    plotWidthCss: 720, plotHeightCss: 520,
    isInGrid: true,
    originalEvent: { pointerType: 'mouse', shiftKey: false, buttons: 0 } as unknown as PointerEvent,
    ...overrides,
  };
}

function makeTouchPointerEvent(overrides: Partial<PointerEvent> = {}): Partial<PointerEvent> {
  return {
    pointerType: 'touch',
    pointerId: 1,
    clientX: 400,
    clientY: 300,
    button: 0,
    buttons: 1,
    isPrimary: true,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

// --- Task 1: Touch pointer tracking -----------------------------------

describe('createInsideZoom - touch pointer tracking', () => {
  let em: ReturnType<typeof createMockEventManager>;
  let zs: ReturnType<typeof createMockZoomState>;

  beforeEach(() => {
    em = createMockEventManager();
    zs = createMockZoomState();
  });

  it('does not track mouse pointers in activePointers', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    // Simulate a mouse pointerdown -- should not trigger touch tracking.
    em.simulatePointerDown({
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 400,
      clientY: 300,
      button: 0,
      buttons: 1,
      isPrimary: true,
      preventDefault: vi.fn(),
    });

    // Simulate a mouse pointermove -- should not result in any touch pan.
    em.simulatePointerMove({
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 450,
      clientY: 300,
      button: 0,
      buttons: 1,
      isPrimary: true,
      preventDefault: vi.fn(),
    });

    // No pan calls should be made from mouse pointer events on the touch path.
    expect(zs.panCalls).toHaveLength(0);

    zoom.dispose();
  });

  it('tracks touch pointerdown and cleans up on pointerup', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    // Provide lastPointer via fireMouseMove so isInGrid is set.
    em.fireMouseMove(makePayload({ isInGrid: true }));

    const downEvt = makeTouchPointerEvent({ pointerId: 5, clientX: 200, clientY: 300 });
    em.simulatePointerDown(downEvt);
    expect(downEvt.preventDefault).toHaveBeenCalled();

    // Move to confirm tracking is active (single finger should pan).
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 5, clientX: 250, clientY: 300 }));
    expect(zs.panCalls.length).toBeGreaterThan(0);

    // Lift the finger.
    em.simulatePointerUp(makeTouchPointerEvent({ pointerId: 5, clientX: 250, clientY: 300 }));

    // Reset panCalls and move again -- should NOT pan because pointer was cleaned up.
    zs.panCalls.length = 0;
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 5, clientX: 300, clientY: 300 }));
    expect(zs.panCalls).toHaveLength(0);

    zoom.dispose();
  });

  it('cleans up on pointercancel', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    em.fireMouseMove(makePayload({ isInGrid: true }));

    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 7, clientX: 200, clientY: 300 }));

    // Move to confirm tracking is active.
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 7, clientX: 250, clientY: 300 }));
    expect(zs.panCalls.length).toBeGreaterThan(0);

    // Cancel the pointer.
    em.simulatePointerCancel(makeTouchPointerEvent({ pointerId: 7, clientX: 250, clientY: 300 }));

    // Reset panCalls and move again -- should NOT pan.
    zs.panCalls.length = 0;
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 7, clientX: 300, clientY: 300 }));
    expect(zs.panCalls).toHaveLength(0);

    zoom.dispose();
  });
});

// --- Task 2: Single-finger touch pan ----------------------------------

describe('createInsideZoom - single-finger touch pan', () => {
  let em: ReturnType<typeof createMockEventManager>;
  let zs: ReturnType<typeof createMockZoomState>;

  beforeEach(() => {
    em = createMockEventManager();
    zs = createMockZoomState({ start: 20, end: 80 });
  });

  it('pans on single-finger horizontal drag', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    // Provide lastPointer for plotWidthCss and isInGrid.
    em.fireMouseMove(makePayload({ isInGrid: true, plotWidthCss: 720 }));

    // Touch down at x=400, then move right to x=472 (72px rightward drag).
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 472, clientY: 300 }));

    // Rightward drag => negative delta (pan left to show earlier data).
    // dxCss = 72, span = 60, plotWidthCss = 720
    // deltaPct = -(72 / 720) * 60 = -6
    expect(zs.panCalls).toHaveLength(1);
    expect(zs.panCalls[0]).toBeCloseTo(-6, 1);

    zoom.dispose();
  });

  it('does not pan when pointerdown is outside grid', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    // Mark cursor as outside grid.
    em.fireMouseMove(makePayload({ isInGrid: false }));

    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 472, clientY: 300 }));

    expect(zs.panCalls).toHaveLength(0);

    zoom.dispose();
  });

  it('stops panning when finger lifts', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    em.fireMouseMove(makePayload({ isInGrid: true, plotWidthCss: 720 }));

    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 450, clientY: 300 }));
    expect(zs.panCalls.length).toBeGreaterThan(0);

    // Lift finger.
    em.simulatePointerUp(makeTouchPointerEvent({ pointerId: 1, clientX: 450, clientY: 300 }));

    // Reset and move again.
    zs.panCalls.length = 0;
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 500, clientY: 300 }));
    expect(zs.panCalls).toHaveLength(0);

    zoom.dispose();
  });
});

// --- Task 3: Pinch-to-zoom -------------------------------------------

describe('createInsideZoom - pinch-to-zoom', () => {
  let em: ReturnType<typeof createMockEventManager>;
  let zs: ReturnType<typeof createMockZoomState>;

  beforeEach(() => {
    em = createMockEventManager();
    zs = createMockZoomState({ start: 20, end: 80 });
  });

  it('zooms in when fingers spread apart', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    em.fireMouseMove(makePayload({ isInGrid: true, plotWidthCss: 720 }));

    // Two fingers down, 100px apart horizontally.
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300 }));
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300 }));

    // Spread to 200px apart.
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 300, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300 }));

    expect(zs.zoomInCalls.length).toBeGreaterThan(0);
    expect(zs.zoomOutCalls).toHaveLength(0);

    zoom.dispose();
  });

  it('zooms out when fingers pinch together', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    em.fireMouseMove(makePayload({ isInGrid: true, plotWidthCss: 720 }));

    // Two fingers down, 200px apart.
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 300, clientY: 300 }));
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300 }));

    // Pinch to 100px apart.
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300 }));

    expect(zs.zoomOutCalls.length).toBeGreaterThan(0);
    expect(zs.zoomInCalls).toHaveLength(0);

    zoom.dispose();
  });

  it('centers zoom on finger midpoint', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    em.fireMouseMove(makePayload({ isInGrid: true, plotWidthCss: 720, gridX: 340 }));

    // Two fingers at clientX 350 and 450; midpoint = 400.
    // Canvas bounding rect left = 0, so midpoint in canvas CSS = 400.
    // The grid area starts at gridX offset. We use lastPointer grid info.
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300 }));
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300 }));

    // Spread apart (zoom in).
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 300, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300 }));

    expect(zs.zoomInCalls.length).toBeGreaterThan(0);
    const call = zs.zoomInCalls[0];
    // Center should be between start(20) and end(80).
    expect(call.center).toBeGreaterThanOrEqual(20);
    expect(call.center).toBeLessThanOrEqual(80);

    zoom.dispose();
  });

  it('transitions from pan to pinch when second finger arrives', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    em.fireMouseMove(makePayload({ isInGrid: true, plotWidthCss: 720 }));

    // Single finger down and drag (pan).
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 420, clientY: 300 }));
    expect(zs.panCalls.length).toBeGreaterThan(0);

    // Second finger arrives -- should transition to pinch mode.
    const panCountBefore = zs.panCalls.length;
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300 }));

    // Now move fingers apart (zoom in).
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 380, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 540, clientY: 300 }));

    // Should zoom, not pan.
    expect(zs.zoomInCalls.length).toBeGreaterThan(0);
    // Pan count should not have increased from the pinch movements.
    expect(zs.panCalls.length).toBe(panCountBefore);

    zoom.dispose();
  });

  it('reverts to single-finger pan when second finger lifts', () => {
    const zoom = createInsideZoom(em, zs);
    zoom.enable();

    em.fireMouseMove(makePayload({ isInGrid: true, plotWidthCss: 720 }));

    // Two fingers down.
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300 }));
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300 }));

    // Pinch to verify zoom works.
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 300, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300 }));
    expect(zs.zoomInCalls.length).toBeGreaterThan(0);

    // Lift second finger.
    em.simulatePointerUp(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300 }));

    // Reset tracking.
    const panCountBefore = zs.panCalls.length;

    // Now move the remaining finger -- should pan.
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300 }));
    expect(zs.panCalls.length).toBeGreaterThan(panCountBefore);

    zoom.dispose();
  });
});
