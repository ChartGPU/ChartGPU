# Mobile Touch Gesture Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add pinch-to-zoom, single-finger pan, and a zoom reset button for touch devices when `dataZoom: [{ type: 'inside' }]` is configured.

**Architecture:** Extend `createInsideZoom.ts` with a `Map<number, {x,y}>` pointer tracker. Touch pointers (`pointerType === 'touch'`) are tracked on `pointerdown`/`pointermove`/`pointerup`/`pointercancel`. 1 pointer = pan, 2 pointers = pinch-zoom. A new `createZoomResetButton.ts` DOM component appears when zoomed on touch devices.

**Tech Stack:** TypeScript, Pointer Events API, DOM overlays, Vitest for unit tests.

**Design doc:** `docs/plans/2026-02-25-mobile-touch-gestures-design.md`

---

### Task 1: Add touch pointer tracking to `createInsideZoom`

**Files:**
- Modify: `src/interaction/createInsideZoom.ts`
- Create: `src/interaction/__tests__/createInsideZoom.test.ts`

**Step 1: Write the failing test**

Create `src/interaction/__tests__/createInsideZoom.test.ts`. Test that the module tracks touch pointers and exposes active pointer count. We need a minimal mock of `EventManager` and `ZoomState`.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInsideZoom } from '../createInsideZoom';
import type { EventManager, ChartGPUEventPayload } from '../createEventManager';
import type { ZoomState, ZoomRange } from '../createZoomState';

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

  // Track canvas listeners added via addEventListener
  const canvasListeners: Record<string, EventListener[]> = {};

  const canvas = {
    addEventListener: vi.fn((type: string, listener: EventListener, _opts?: any) => {
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

// --- tests -------------------------------------------------------------

describe('createInsideZoom – touch pointer tracking', () => {
  let em: ReturnType<typeof createMockEventManager>;
  let zs: ReturnType<typeof createMockZoomState>;

  beforeEach(() => {
    em = createMockEventManager();
    zs = createMockZoomState({ start: 20, end: 80 });
    // Stub maxTouchPoints to simulate a touch device
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 2, configurable: true });
  });

  it('does not track mouse pointers in activePointers', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();

    em.simulatePointerDown({ pointerType: 'mouse', pointerId: 1, clientX: 400, clientY: 300, button: 0, buttons: 1, isPrimary: true, preventDefault: vi.fn() });

    // Mouse events should not trigger touch pan
    em.simulatePointerMove({ pointerType: 'mouse', pointerId: 1, clientX: 420, clientY: 300, button: 0, buttons: 1, isPrimary: true, preventDefault: vi.fn() });

    // Pan should not have been called from touch path (mouse pan requires shift or middle button)
    expect(zs.panCalls).toHaveLength(0);

    iz.dispose();
  });

  it('tracks touch pointerdown and cleans up on pointerup', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();

    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 420, clientY: 300 }));
    expect(zs.panCalls.length).toBeGreaterThan(0);

    em.simulatePointerUp(makeTouchPointerEvent({ pointerId: 1, clientX: 420, clientY: 300 }));
    zs.panCalls.length = 0;

    // After pointerup, moving should not pan
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 440, clientY: 300 }));
    expect(zs.panCalls).toHaveLength(0);

    iz.dispose();
  });

  it('cleans up on pointercancel', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();

    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerCancel(makeTouchPointerEvent({ pointerId: 1 }));

    zs.panCalls.length = 0;
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 440, clientY: 300 }));
    expect(zs.panCalls).toHaveLength(0);

    iz.dispose();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/interaction/__tests__/createInsideZoom.test.ts`
Expected: FAIL — touch pointer tracking does not exist yet

**Step 3: Implement touch pointer tracking**

In `src/interaction/createInsideZoom.ts`, add:

1. An `activePointers: Map<number, { x: number; y: number }>` map after the existing state vars (~line 74)
2. A `isTouchDevice` check: `const isTouchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0`
3. A `previousTouchState` variable to store last frame's pointer positions for delta computation
4. Canvas `pointerdown` listener that tracks touch pointers (`e.pointerType === 'touch'`) and calls `e.preventDefault()`. Must check `isInGrid` using canvas `getBoundingClientRect()` + the grid area from `lastPointer` (already tracked by `onMouseMove`)
5. Canvas `pointermove` listener for touch that updates `activePointers` positions
6. Canvas `pointerup` and `pointercancel` listeners that remove from `activePointers`
7. Wire listeners in `enable()` (with `{ passive: false }` for `pointerdown`), remove in `disable()`
8. Set `canvas.style.touchAction = 'none'` in `enable()` when `isTouchDevice`, restore in `disable()`

The `createInsideZoom` function signature stays the same — `eventManager.canvas` provides the canvas reference.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/interaction/__tests__/createInsideZoom.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interaction/createInsideZoom.ts src/interaction/__tests__/createInsideZoom.test.ts
git commit -m "feat(touch): add touch pointer tracking to createInsideZoom"
```

---

### Task 2: Implement single-finger touch pan

**Files:**
- Modify: `src/interaction/createInsideZoom.ts`
- Modify: `src/interaction/__tests__/createInsideZoom.test.ts`

**Step 1: Write the failing test**

Add to the existing test file:

```typescript
describe('createInsideZoom – single-finger touch pan', () => {
  let em: ReturnType<typeof createMockEventManager>;
  let zs: ReturnType<typeof createMockZoomState>;

  beforeEach(() => {
    em = createMockEventManager();
    zs = createMockZoomState({ start: 20, end: 80 });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 2, configurable: true });
  });

  it('pans on single-finger horizontal drag', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();

    // Need a mousemove first so lastPointer is set (for isInGrid check)
    em.fireMouseMove(makePayload());

    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 430, clientY: 300 }));

    expect(zs.panCalls.length).toBeGreaterThan(0);

    // Pan direction: dragging right (positive dx) should move window left (negative delta)
    expect(zs.panCalls[0]).toBeLessThan(0);

    iz.dispose();
  });

  it('does not pan when pointerdown is outside grid', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();

    // Set lastPointer with isInGrid = false
    em.fireMouseMove(makePayload({ isInGrid: false }));

    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 10, clientY: 10 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 40, clientY: 10 }));

    expect(zs.panCalls).toHaveLength(0);

    iz.dispose();
  });

  it('stops panning when finger lifts', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();

    em.fireMouseMove(makePayload());

    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 430, clientY: 300 }));

    const callsBefore = zs.panCalls.length;
    em.simulatePointerUp(makeTouchPointerEvent({ pointerId: 1, clientX: 430, clientY: 300 }));

    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 460, clientY: 300 }));
    expect(zs.panCalls.length).toBe(callsBefore);

    iz.dispose();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/interaction/__tests__/createInsideZoom.test.ts`
Expected: FAIL — pan logic not implemented yet

**Step 3: Implement single-finger pan**

In the touch `pointermove` handler in `createInsideZoom.ts`, add logic for `activePointers.size === 1`:

```typescript
// Single-finger pan
if (activePointers.size === 1) {
  const prev = activePointers.get(e.pointerId);
  if (!prev) return;

  const dxCss = e.clientX - prev.x;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (!Number.isFinite(dxCss) || dxCss === 0) return;

  const plotWidthCss = lastPointer?.plotWidthCss ?? 0;
  if (!(plotWidthCss > 0)) return;

  const { start, end } = zoomState.getRange();
  const span = end - start;
  if (!Number.isFinite(span) || span === 0) return;

  const deltaPct = -(dxCss / plotWidthCss) * span;
  if (!Number.isFinite(deltaPct) || deltaPct === 0) return;
  zoomState.pan(deltaPct);
  return;
}
```

Key detail: use `clientX` difference (not gridX) since touch `pointermove` fires directly on the canvas, not through the event manager. The `plotWidthCss` comes from `lastPointer` which is updated by the event manager's `mousemove` (which fires for primary touch pointers too).

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/interaction/__tests__/createInsideZoom.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interaction/createInsideZoom.ts src/interaction/__tests__/createInsideZoom.test.ts
git commit -m "feat(touch): implement single-finger touch pan"
```

---

### Task 3: Implement pinch-to-zoom

**Files:**
- Modify: `src/interaction/createInsideZoom.ts`
- Modify: `src/interaction/__tests__/createInsideZoom.test.ts`

**Step 1: Write the failing test**

Add to the existing test file:

```typescript
describe('createInsideZoom – pinch-to-zoom', () => {
  let em: ReturnType<typeof createMockEventManager>;
  let zs: ReturnType<typeof createMockZoomState>;

  beforeEach(() => {
    em = createMockEventManager();
    zs = createMockZoomState({ start: 20, end: 80 });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 2, configurable: true });
  });

  it('zooms in when fingers spread apart', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();
    em.fireMouseMove(makePayload());

    // Two fingers down, 100px apart
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300, isPrimary: true }));
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300, isPrimary: false }));

    // Spread to 200px apart (zoom in)
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 300, clientY: 300, isPrimary: true }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300, isPrimary: false }));

    expect(zs.zoomInCalls.length).toBeGreaterThan(0);
    expect(zs.zoomOutCalls).toHaveLength(0);

    iz.dispose();
  });

  it('zooms out when fingers pinch together', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();
    em.fireMouseMove(makePayload());

    // Two fingers down, 200px apart
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 300, clientY: 300, isPrimary: true }));
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300, isPrimary: false }));

    // Pinch to 100px apart (zoom out)
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300, isPrimary: true }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300, isPrimary: false }));

    expect(zs.zoomOutCalls.length).toBeGreaterThan(0);
    expect(zs.zoomInCalls).toHaveLength(0);

    iz.dispose();
  });

  it('centers zoom on finger midpoint', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();
    em.fireMouseMove(makePayload());

    // Fingers centered at x=400 (on an 800px-wide canvas with grid at left=40, width=720)
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300, isPrimary: true }));
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300, isPrimary: false }));

    // Spread apart
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 300, clientY: 300, isPrimary: true }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300, isPrimary: false }));

    expect(zs.zoomInCalls.length).toBeGreaterThan(0);
    // centerPct should be somewhere in the middle of the zoom range, not at the edges
    const center = zs.zoomInCalls[0]!.center;
    expect(center).toBeGreaterThan(20);
    expect(center).toBeLessThan(80);

    iz.dispose();
  });

  it('transitions from pan to pinch when second finger arrives', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();
    em.fireMouseMove(makePayload());

    // Start with one finger (pan)
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 400, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 420, clientY: 300 }));
    expect(zs.panCalls.length).toBeGreaterThan(0);

    // Add second finger (switch to pinch)
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 500, clientY: 300, isPrimary: false }));
    const panCountBefore = zs.panCalls.length;

    // Move both fingers apart (zoom, not pan)
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 380, clientY: 300 }));
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 2, clientX: 540, clientY: 300, isPrimary: false }));

    expect(zs.zoomInCalls.length).toBeGreaterThan(0);

    iz.dispose();
  });

  it('reverts to single-finger pan when second finger lifts', () => {
    const iz = createInsideZoom(em, zs);
    iz.enable();
    em.fireMouseMove(makePayload());

    // Two fingers down
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 1, clientX: 350, clientY: 300 }));
    em.simulatePointerDown(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300, isPrimary: false }));

    // Lift second finger
    em.simulatePointerUp(makeTouchPointerEvent({ pointerId: 2, clientX: 450, clientY: 300, isPrimary: false }));

    zs.panCalls.length = 0;
    // Move remaining finger — should pan
    em.simulatePointerMove(makeTouchPointerEvent({ pointerId: 1, clientX: 380, clientY: 300 }));
    expect(zs.panCalls.length).toBeGreaterThan(0);

    iz.dispose();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/interaction/__tests__/createInsideZoom.test.ts`
Expected: FAIL — pinch logic not implemented

**Step 3: Implement pinch-to-zoom**

In the touch `pointermove` handler, add logic for `activePointers.size === 2`:

```typescript
// Pinch-to-zoom (2 fingers)
if (activePointers.size === 2) {
  // Update position for the moving pointer
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  const [p1, p2] = [...activePointers.values()];
  const currentDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);

  if (previousPinchDist > 0 && currentDist > 0) {
    const factor = previousPinchDist / currentDist;

    // Compute center as midpoint mapped into percent space
    const midX = (p1.x + p2.x) / 2;
    const rect = eventManager.canvas.getBoundingClientRect();
    const gridLeft = lastPointer?.gridX !== undefined
      ? lastPointer.x - lastPointer.gridX
      : 0;
    const plotWidthCss = lastPointer?.plotWidthCss ?? rect.width;
    const r = clamp((midX - rect.left - gridLeft) / plotWidthCss, 0, 1);
    const { start, end } = zoomState.getRange();
    const span = end - start;
    const centerPct = clamp(start + r * span, 0, 100);

    if (factor > 1) zoomState.zoomOut(centerPct, factor);
    else if (factor < 1) zoomState.zoomIn(centerPct, 1 / factor);

    // Simultaneous pan from midpoint shift
    if (plotWidthCss > 0) {
      const prevMidX = previousPinchMidX;
      const currMidX = midX;
      if (Number.isFinite(prevMidX)) {
        const dxCss = currMidX - prevMidX;
        if (Number.isFinite(dxCss) && dxCss !== 0 && Number.isFinite(span) && span > 0) {
          const panDelta = -(dxCss / plotWidthCss) * span;
          if (Number.isFinite(panDelta) && panDelta !== 0) zoomState.pan(panDelta);
        }
      }
    }
  }

  previousPinchDist = currentDist;
  previousPinchMidX = (p1.x + p2.x) / 2;
  return;
}
```

Add state vars near top of function body:

```typescript
let previousPinchDist = 0;
let previousPinchMidX = NaN;
```

Reset `previousPinchDist` and `previousPinchMidX` when:
- A pointer is added to or removed from `activePointers` (so the first frame of any pinch gesture is a reference frame, not a jump)
- On `disable()` / `dispose()`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/interaction/__tests__/createInsideZoom.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interaction/createInsideZoom.ts src/interaction/__tests__/createInsideZoom.test.ts
git commit -m "feat(touch): implement pinch-to-zoom with midpoint center"
```

---

### Task 4: Create zoom reset button component

**Files:**
- Create: `src/components/createZoomResetButton.ts`
- Create: `src/components/__tests__/createZoomResetButton.test.ts`

**Step 1: Write the failing test**

```typescript
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
    tooltipBackgroundColor: '#333',
    tooltipBorderColor: '#555',
    tooltipTextColor: '#eee',
  } as ThemeConfig;
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/createZoomResetButton.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement the component**

Create `src/components/createZoomResetButton.ts`:

```typescript
import type { ZoomState } from '../interaction/createZoomState';
import type { ThemeConfig } from '../themes/types';

export interface ZoomResetButton {
  update(theme: ThemeConfig): void;
  dispose(): void;
}

const isFullRange = (start: number, end: number): boolean =>
  start <= 0.01 && end >= 99.99;

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
  el.textContent = '\u21BA'; // ↺ reset arrow

  const applyTheme = (t: ThemeConfig): void => {
    el.style.background = t.backgroundColor + 'cc'; // semi-transparent
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/createZoomResetButton.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/createZoomResetButton.ts src/components/__tests__/createZoomResetButton.test.ts
git commit -m "feat(touch): add zoom reset button component"
```

---

### Task 5: Wire zoom reset button into the coordinator

**Files:**
- Modify: `src/core/createRenderCoordinator.ts` (~lines 2067-2228 for zoom setup, ~lines 3526-3530 for dispose)

**Step 1: Write the failing test**

This is an integration-level wiring task. The unit tests from Task 4 already verify component behavior. Here we verify wiring by confirming the button appears in the container when a chart has inside zoom configured and is zoomed in on a touch device.

Since `createRenderCoordinator` is a large module tested via integration, verify by reading the code after modification.

**Step 2: Import and wire the component**

In `src/core/createRenderCoordinator.ts`:

1. Add import at the top (near the existing slider import):
```typescript
import { createZoomResetButton } from '../components/createZoomResetButton';
import type { ZoomResetButton } from '../components/createZoomResetButton';
```

2. Add state variable near the existing `insideZoom` variable (~line 2070):
```typescript
let zoomResetButton: ZoomResetButton | null = null;
```

3. In the `updateZoom()` function, after the `insideZoom` enable block (~line 2224), add:
```typescript
// Zoom reset button for touch devices (only when inside zoom is active).
if (cfg.hasInside && callbacks?.container) {
  if (!zoomResetButton) {
    zoomResetButton = createZoomResetButton(
      callbacks.container,
      zoomState,
      currentOptions.theme,
    );
  } else {
    zoomResetButton.update(currentOptions.theme);
  }
} else {
  zoomResetButton?.dispose();
  zoomResetButton = null;
}
```

Note: `callbacks?.container` — check how the coordinator receives the container reference. Look at the `callbacks` parameter passed to `createRenderCoordinator`. If `container` isn't available through `callbacks`, the zoom reset button will need to be wired from `ChartGPU.ts` instead (similar to how `createDataZoomSlider` is wired there). In that case, modify this step to wire from `ChartGPU.ts` following the `dataZoomSlider` pattern at lines 1069-1076.

4. In the `dispose()` block (~line 3530, after `insideZoom?.dispose()`):
```typescript
zoomResetButton?.dispose();
zoomResetButton = null;
```

5. In the zoom-disabled cleanup path (~line 2170, where `insideZoom?.dispose()` is called):
```typescript
zoomResetButton?.dispose();
zoomResetButton = null;
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests pass, no regressions

**Step 4: Commit**

```bash
git add src/core/createRenderCoordinator.ts
git commit -m "feat(touch): wire zoom reset button into render coordinator"
```

---

### Task 6: Manual integration testing

**Files:**
- No code changes — manual verification

**Step 1: Start the dev server**

Run: `npm run dev`

**Step 2: Test in Chrome DevTools mobile emulation**

Open any example with `dataZoom: [{ type: 'inside' }]` (e.g., `examples/interactive/` or `examples/live-streaming/`). Use Chrome DevTools device toolbar to simulate a touch device.

Verify:
- [ ] Single-finger drag pans the chart horizontally
- [ ] Two-finger pinch zooms in/out centered on finger midpoint
- [ ] Pinch + drag simultaneously pans while zooming
- [ ] Zoom reset button appears in top-right when zoomed in
- [ ] Tapping zoom reset button returns to full view
- [ ] Desktop mouse interactions (wheel, shift+drag, middle-drag) still work unchanged
- [ ] Page scroll is not intercepted when inside zoom is NOT configured
- [ ] Slider still works with touch

**Step 3: Test edge cases**

- [ ] Third finger is ignored during pinch
- [ ] Lifting one finger during pinch reverts to single-finger pan
- [ ] Rapid finger add/remove doesn't cause jumps
- [ ] Charts WITHOUT `dataZoom: [{ type: 'inside' }]` have no touch-action changes

**Step 4: Run full test suite one more time**

Run: `npx vitest run`
Expected: All tests pass

**Step 5: Commit any fixes from testing**

Only if fixes were needed during manual testing.

---

### Summary of all files changed

| File | Action | Description |
|---|---|---|
| `src/interaction/createInsideZoom.ts` | Modify | Touch pointer tracking, single-finger pan, pinch-to-zoom |
| `src/interaction/__tests__/createInsideZoom.test.ts` | Create | Unit tests for touch gestures |
| `src/components/createZoomResetButton.ts` | Create | Zoom reset button DOM component |
| `src/components/__tests__/createZoomResetButton.test.ts` | Create | Unit tests for zoom reset button |
| `src/core/createRenderCoordinator.ts` | Modify | Wire zoom reset button |
