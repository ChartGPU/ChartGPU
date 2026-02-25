# Mobile Touch Gesture Support — Design

**Issue:** [#114 — Better Mobile Support, Gesture Handling for Zoom](https://github.com/ChartGPU/ChartGPU/issues/114)
**Date:** 2026-02-25
**Approach:** Extend `createInsideZoom.ts` directly (Approach A)

## Scope

Add touch gesture support (pinch-to-zoom, single-finger pan, zoom reset button) to ChartGPU when `dataZoom: [{ type: 'inside' }]` is configured. Touch gestures are only active on touch-capable devices.

## Decisions

- **Activation:** Touch gestures only when `dataZoom` includes `{ type: 'inside' }` (matches desktop opt-in behavior)
- **Pinch center:** Zoom anchors on the midpoint between the two fingers (like maps)
- **Pan activation:** Immediate on horizontal drag, no dead zone (inside zoom is already opt-in)
- **Reset button:** Subtle DOM button appears when zoomed in on touch devices
- **Device detection:** `navigator.maxTouchPoints > 0` at `enable()` time

## Touch Gesture Mechanics

**Pointer tracking:** `createInsideZoom` gains an `activePointers: Map<number, { x: number, y: number }>` tracking all active touch pointers via `pointerdown`/`pointermove`/`pointerup`/`pointercancel`. Only `pointerType === 'touch'` events enter the map.

**Single-finger pan (1 active pointer):**
- On `pointermove` with exactly 1 active touch pointer, compute `dxCss` from previous position
- Convert to percent: `deltaPct = -(dxCss / plotWidthCss) * span`
- Call `zoomState.pan(deltaPct)`
- Requires `isInGrid` on initial `pointerdown` to activate

**Pinch-to-zoom (2 active pointers):**
- Track distance: `currentDist = hypot(p1.x - p2.x, p1.y - p2.y)`
- Compute `factor = previousDist / currentDist`
- Compute `centerPct` from midpoint of two fingers mapped into zoom window
- Call `zoomState.zoomIn(centerPct, factor)` or `zoomState.zoomOut(centerPct, 1/factor)`
- Simultaneous pan: track midpoint shift between frames, call `zoomState.pan()` for delta

**3+ pointers:** Ignored — only first two tracked pointers participate.

## Canvas CSS & Browser Gesture Prevention

- Set `canvas.style.touchAction = 'none'` only when `maxTouchPoints > 0` AND inside zoom is enabled
- Call `e.preventDefault()` on `pointerdown` when a touch gesture begins inside the grid
- Restore previous `touchAction` value on disable/dispose
- No change when inside zoom is not configured — page scrolling unaffected

**Hybrid devices** (touch laptops): Report `maxTouchPoints > 0`, get `touch-action: none`, both mouse and touch paths work correctly.

## Zoom Reset Button

- **Position:** Top-right corner of plot grid, DOM overlay
- **Visibility:** Shown when inside zoom active AND zoom range !== full range AND `maxTouchPoints > 0`
- **Behavior:** Tap calls `zoomState.setRange(0, 100)`
- **Styling:** Semi-transparent theme `backgroundColor` with alpha, theme `textColor`, 32x32 CSS px minimum tap target
- **Implementation:** New `createZoomResetButton.ts` in `src/components/`, subscribes to `zoomState.onChange`

## Integration & Event Flow

**New listeners in `createInsideZoom.ts`:**
- `pointerdown` on canvas (`{ passive: false }`)
- `pointermove` on canvas (direct, for all pointer IDs)
- `pointerup` and `pointercancel` on canvas (cleanup `activePointers`)
- Existing `wheel` listener unchanged

**Coexistence with `createEventManager`:**
- Event manager continues hover/crosshair/tooltip/click via primary pointer — no changes
- `isPrimary` filter naturally ignores second finger during pinch
- Tooltip/crosshair update during pan is desirable

**Coordinator wiring:**
- `createInsideZoom` already receives necessary params — no new inputs for touch
- New `createZoomResetButton` instantiated alongside slider, receives `zoomState`, `container`, `gridArea`, `resolvedOptions`
- Both disposed in coordinator `dispose()`

## Files Changed

| File | Change |
|---|---|
| `src/interaction/createInsideZoom.ts` | Add pointer tracking, single-finger pan, pinch-to-zoom |
| `src/components/createZoomResetButton.ts` | New — zoom reset button DOM overlay |
| `src/core/createRenderCoordinator.ts` | Wire zoom reset button |
| `src/ChartGPU.ts` | No changes expected (canvas touch-action handled by createInsideZoom) |

## Files Unchanged

- `src/interaction/createZoomState.ts` — existing API sufficient
- `src/interaction/createEventManager.ts` — no changes needed
- `src/components/createDataZoomSlider.ts` — already touch-capable
- All renderers and shaders
