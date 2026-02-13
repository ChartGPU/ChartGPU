// TypeScript-only acceptance test for auto-scroll zoom isolation in sync groups.
// This file is excluded from the library build (tsconfig excludes `examples/`).
//
// Intent: validate that auto-scroll zoom changes do NOT propagate through sync groups,
// while programmatic setZoomRange() calls DO sync correctly.
//
// Bug being guarded:
// - Chart A has streaming data + autoScroll enabled; internal auto-scroll adjusts zoom.
// - When charts are connected with `connectCharts([A,B], { syncZoom: true })`,
//   Chart B must NOT receive A's auto-scroll zoom changes.
// - However, programmatic setZoomRange() calls from A should still sync to B.

import type {
  ChartGPU,
  ChartGPUEventName,
  ChartGPUEventCallback,
  ChartGPUCrosshairMoveCallback,
  ChartGPUZoomRangeChangePayload,
  ChartGPUZoomRangeChangeCallback,
} from '../../src/ChartGPU';
import { connectCharts } from '../../src/interaction/createChartSync';

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const assertRange = (
  label: string,
  actual: { start: number; end: number } | null,
  expectedStart: number,
  expectedEnd: number,
): void => {
  if (!actual || actual.start !== expectedStart || actual.end !== expectedEnd) {
    throw new Error(
      `${label}: expected { start: ${expectedStart}, end: ${expectedEnd} } but got ${
        actual ? `{ start: ${actual.start}, end: ${actual.end} }` : 'null'
      }`,
    );
  }
};

/**
 * Creates a minimal mock chart instance for testing sync behavior.
 */
type AnyChartGPUCallback = ChartGPUEventCallback | ChartGPUCrosshairMoveCallback | ChartGPUZoomRangeChangeCallback;

type MockChart = ChartGPU & {
  _simulateAutoScrollZoom(start: number, end: number): void;
};

function createMockChart(_name: string): MockChart {
  const listeners: Record<ChartGPUEventName, Set<AnyChartGPUCallback>> = {
    click: new Set(),
    mouseover: new Set(),
    mouseout: new Set(),
    crosshairMove: new Set(),
    zoomRangeChange: new Set(),
  };
  let currentZoomRange = { start: 0, end: 100 };
  let disposed = false;

  const emitZoomChange = (start: number, end: number, sourceKind?: 'user' | 'auto-scroll' | 'api', source?: unknown): void => {
    const payload: ChartGPUZoomRangeChangePayload = { start, end, sourceKind, source };
    for (const callback of listeners.zoomRangeChange) {
      (callback as ChartGPUZoomRangeChangeCallback)(payload);
    }
  };

  const on = ((eventName: ChartGPUEventName, callback: AnyChartGPUCallback): void => {
    listeners[eventName].add(callback);
  }) as ChartGPU['on'];

  const off = ((eventName: ChartGPUEventName, callback: AnyChartGPUCallback): void => {
    listeners[eventName].delete(callback);
  }) as ChartGPU['off'];

  return {
    get options() {
      return {} as any;
    },
    get disposed() {
      return disposed;
    },
    setOption: (_options: any) => {},
    appendData: (_seriesIndex: number, _newPoints: any) => {},
    resize: () => {},
    dispose: () => {
      disposed = true;
    },
    on,
    off,
    getInteractionX: () => null,
    setInteractionX: (_x: number | null, _source?: unknown) => {},
    setCrosshairX: (_x: number | null, _source?: unknown) => {},
    onInteractionXChange: (_callback: (x: number | null, source?: unknown) => void) => () => {},
    getZoomRange: () => currentZoomRange,
    setZoomRange: (start: number, end: number, source?: unknown): void => {
      if (disposed) return;
      const oldRange = currentZoomRange;
      currentZoomRange = { start, end };
      // Only emit if range actually changed
      if (oldRange.start !== start || oldRange.end !== end) {
        emitZoomChange(start, end, 'api', source);
      }
    },
    getPerformanceMetrics: () => null,
    getPerformanceCapabilities: () => null,
    onPerformanceUpdate: () => () => {},
    hitTest: (_e: PointerEvent | MouseEvent) => ({
      isInGrid: false,
      canvasX: 0,
      canvasY: 0,
      gridX: 0,
      gridY: 0,
      match: null,
    }),
    // Internal helper for simulating auto-scroll zoom changes
    _simulateAutoScrollZoom: (start: number, end: number): void => {
      const oldRange = currentZoomRange;
      currentZoomRange = { start, end };
      if (oldRange.start !== start || oldRange.end !== end) {
        emitZoomChange(start, end, 'auto-scroll');
      }
    },
  };
}

// Test 1: Auto-scroll zoom changes should NOT propagate through sync groups
{
  const chartA = createMockChart('A');
  const chartB = createMockChart('B');

  // Set Chart B to a non-default zoom window
  chartB.setZoomRange(10, 30);
  assertRange('Chart B initial zoom', chartB.getZoomRange(), 10, 30);

  // Connect with syncZoom enabled
  const disconnect = connectCharts([chartA, chartB], { syncZoom: true });

  // Simulate auto-scroll zoom adjustment in Chart A
  chartA._simulateAutoScrollZoom(85, 100);
  assertRange('Chart A after auto-scroll', chartA.getZoomRange(), 85, 100);

  // Chart B should NOT have changed (auto-scroll is filtered)
  assertRange('Chart B unchanged after Chart A auto-scroll', chartB.getZoomRange(), 10, 30);

  // Simulate multiple auto-scroll adjustments
  chartA._simulateAutoScrollZoom(90, 100);
  chartA._simulateAutoScrollZoom(95, 100);
  assertRange('Chart B still unchanged after multiple auto-scrolls', chartB.getZoomRange(), 10, 30);

  disconnect();
}

// Test 2: Programmatic setZoomRange() should STILL sync correctly
{
  const chartA = createMockChart('A');
  const chartB = createMockChart('B');

  // Set Chart B to a different zoom window
  chartB.setZoomRange(20, 40);
  assertRange('Chart B initial zoom', chartB.getZoomRange(), 20, 40);

  // Connect with syncZoom enabled
  const disconnect = connectCharts([chartA, chartB], { syncZoom: true });

  // Programmatic zoom change in Chart A should sync to Chart B
  chartA.setZoomRange(50, 80);
  assertRange('Chart A after setZoomRange', chartA.getZoomRange(), 50, 80);
  assertRange('Chart B synced from Chart A setZoomRange', chartB.getZoomRange(), 50, 80);

  // Bidirectional sync: Chart B zoom change should sync to Chart A
  chartB.setZoomRange(10, 30);
  assertRange('Chart B after setZoomRange', chartB.getZoomRange(), 10, 30);
  assertRange('Chart A synced from Chart B setZoomRange', chartA.getZoomRange(), 10, 30);

  disconnect();
}

// Test 3: Auto-scroll in Chart A, then programmatic zoom in Chart B
{
  const chartA = createMockChart('A');
  const chartB = createMockChart('B');

  chartB.setZoomRange(15, 35);

  const disconnect = connectCharts([chartA, chartB], { syncZoom: true });

  // Auto-scroll in Chart A (should NOT sync)
  chartA._simulateAutoScrollZoom(90, 100);
  assertRange('Chart B unaffected by Chart A auto-scroll', chartB.getZoomRange(), 15, 35);

  // Programmatic zoom in Chart B (should sync to Chart A)
  chartB.setZoomRange(25, 45);
  assertRange('Chart A synced from Chart B programmatic zoom', chartA.getZoomRange(), 25, 45);

  // Another auto-scroll in Chart A (should NOT sync)
  chartA._simulateAutoScrollZoom(92, 100);
  assertRange('Chart B still has its zoom after another auto-scroll', chartB.getZoomRange(), 25, 45);

  disconnect();
}

// Test 4: Multiple charts in sync group
{
  const chartA = createMockChart('A');
  const chartB = createMockChart('B');
  const chartC = createMockChart('C');

  chartB.setZoomRange(10, 30);
  chartC.setZoomRange(20, 40);

  const disconnect = connectCharts([chartA, chartB, chartC], { syncZoom: true });

  // Auto-scroll in Chart A (should NOT sync to B or C)
  chartA._simulateAutoScrollZoom(85, 100);
  assertRange('Chart B unchanged', chartB.getZoomRange(), 10, 30);
  assertRange('Chart C unchanged', chartC.getZoomRange(), 20, 40);

  // Programmatic zoom in Chart A (should sync to B and C)
  chartA.setZoomRange(50, 70);
  assertRange('Chart B synced from A', chartB.getZoomRange(), 50, 70);
  assertRange('Chart C synced from A', chartC.getZoomRange(), 50, 70);

  disconnect();
}

// Test 5: Source token loop prevention still works
{
  const chartA = createMockChart('A');
  const chartB = createMockChart('B');

  let aChanges = 0;
  let bChanges = 0;

  chartA.on('zoomRangeChange', () => {
    aChanges++;
  });

  chartB.on('zoomRangeChange', () => {
    bChanges++;
  });

  const disconnect = connectCharts([chartA, chartB], { syncZoom: true });

  // Reset counters (connectCharts might trigger initial syncs)
  aChanges = 0;
  bChanges = 0;

  // Set zoom on Chart A
  chartA.setZoomRange(30, 50);

  // Chart A should emit once (its own change)
  // Chart B should emit once (synced from A)
  assert(aChanges === 1, `Expected Chart A to emit 1 change, got ${aChanges}`);
  assert(bChanges === 1, `Expected Chart B to emit 1 change, got ${bChanges}`);

  // No infinite loop: total changes should be exactly 2
  assert(aChanges + bChanges === 2, `Expected total 2 changes, got ${aChanges + bChanges}`);

  disconnect();
}

// Test 6: Disconnect cleanup
{
  const chartA = createMockChart('A');
  const chartB = createMockChart('B');

  chartB.setZoomRange(10, 30);

  const disconnect = connectCharts([chartA, chartB], { syncZoom: true });

  // Verify sync works before disconnect
  chartA.setZoomRange(50, 70);
  assertRange('Chart B synced before disconnect', chartB.getZoomRange(), 50, 70);

  // Disconnect
  disconnect();

  // After disconnect, changes should NOT sync
  chartA.setZoomRange(80, 90);
  assertRange('Chart A changed after disconnect', chartA.getZoomRange(), 80, 90);
  assertRange('Chart B unchanged after disconnect', chartB.getZoomRange(), 50, 70);

  // Auto-scroll after disconnect also should not sync (sanity check)
  chartA._simulateAutoScrollZoom(95, 100);
  assertRange('Chart B still unchanged after disconnect', chartB.getZoomRange(), 50, 70);
}

// Test 7: Only auto-scroll is filtered; explicit 'user' or 'api' sourceKind syncs
{
  const chartA = createMockChart('A');
  const chartB = createMockChart('B');

  chartB.setZoomRange(10, 30);

  const disconnect = connectCharts([chartA, chartB], { syncZoom: true });

  // setZoomRange emits sourceKind: 'api' (should sync)
  chartA.setZoomRange(40, 60);
  assertRange('Chart B synced from api sourceKind', chartB.getZoomRange(), 40, 60);

  disconnect();
}

// Test 8: syncCrosshair=true (default), syncZoom=false should not sync zoom
{
  const chartA = createMockChart('A');
  const chartB = createMockChart('B');

  chartB.setZoomRange(10, 30);

  // Only sync crosshair, not zoom
  const disconnect = connectCharts([chartA, chartB], { syncCrosshair: true, syncZoom: false });

  // Programmatic zoom should NOT sync (syncZoom is disabled)
  chartA.setZoomRange(50, 70);
  assertRange('Chart A changed', chartA.getZoomRange(), 50, 70);
  assertRange('Chart B unchanged (syncZoom disabled)', chartB.getZoomRange(), 10, 30);

  // Auto-scroll should also NOT sync (syncZoom is disabled)
  chartA._simulateAutoScrollZoom(85, 100);
  assertRange('Chart B still unchanged', chartB.getZoomRange(), 10, 30);

  disconnect();
}

console.log('[acceptance:auto-scroll-zoom-sync] OK');
