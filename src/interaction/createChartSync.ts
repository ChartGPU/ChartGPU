import type { ChartGPU, ChartGPUCrosshairMovePayload, ChartGPUZoomRangeChangePayload } from '../ChartGPU';

export type DisconnectCharts = () => void;

export type ChartSyncOptions = Readonly<{
  /**
   * Sync crosshair + tooltip (interaction-x) across charts.
   *x
   * @default true
   */
  readonly syncCrosshair?: boolean;
  /**
   * Sync zoom/pan across charts (percent-space zoom range).
   *
   * @default false
   */
  readonly syncZoom?: boolean;
}>;

/**
 * Connects multiple charts so pointer movement in one chart drives crosshair/tooltip x
 * in the other charts (domain x sync). Returns a `disconnect()` function.
 *
 * Notes:
 * - By default, syncs interaction only (crosshair + tooltip x), not zoom/options.
 * - Enable zoom sync via `{ syncZoom: true }`.
 * - Uses a per-connection loop guard to prevent feedback.
 */
export function connectCharts(charts: ChartGPU[], options?: ChartSyncOptions): DisconnectCharts {
  const syncCrosshair = options?.syncCrosshair ?? true;
  const syncZoom = options?.syncZoom ?? false;

  const connectionToken = Symbol('ChartGPU.connectCharts');

  let disconnected = false;
  const unsubscribeFns: Array<() => void> = [];

  // Cache last broadcast values to avoid redundant broadcasts when values unchanged.
  // Use explicit "uninitialized" sentinels so the first broadcast always propagates
  // (important if peers are already in a non-default state and the first sync event is a reset).
  let hasLastCrosshair = false;
  let lastCrosshairX: number | null = null;
  let hasLastZoom = false;
  let lastZoomStart = 0;
  let lastZoomEnd = 100;

  const broadcastCrosshair = (sourceChart: ChartGPU, x: number | null): void => {
    // Early-exit: avoid iteration if value unchanged (reduces work on repeated pointer moves at same x).
    if (hasLastCrosshair && x === lastCrosshairX) return;
    hasLastCrosshair = true;
    lastCrosshairX = x;

    for (const chart of charts) {
      if (chart === sourceChart) continue;
      if (chart.disposed) continue;
      chart.setCrosshairX(x, connectionToken);
    }
  };

  const broadcastZoom = (sourceChart: ChartGPU, start: number, end: number): void => {
    // Early-exit: avoid iteration if range unchanged (reduces work on redundant zoom events).
    if (hasLastZoom && start === lastZoomStart && end === lastZoomEnd) return;
    hasLastZoom = true;
    lastZoomStart = start;
    lastZoomEnd = end;

    for (const chart of charts) {
      if (chart === sourceChart) continue;
      if (chart.disposed) continue;
      chart.setZoomRange(start, end, connectionToken);
    }
  };

  for (const chart of charts) {
    if (chart.disposed) continue;

    if (syncCrosshair) {
      const onCrosshairMove = (payload: ChartGPUCrosshairMovePayload): void => {
        if (disconnected) return;
        if (payload.source === connectionToken) return;
        if (chart.disposed) return;
        broadcastCrosshair(chart, payload.x);
      };

      chart.on('crosshairMove', onCrosshairMove);
      const unsub = (): void => chart.off('crosshairMove', onCrosshairMove);
      unsubscribeFns.push(unsub);
    }

    if (syncZoom) {
      const onZoomRangeChange = (payload: ChartGPUZoomRangeChangePayload): void => {
        if (disconnected) return;
        if (payload.source === connectionToken) return;
        // Ignore auto-scroll zoom changes to prevent syncing streaming-induced zoom adjustments
        if (payload.sourceKind === 'auto-scroll') return;
        if (chart.disposed) return;
        broadcastZoom(chart, payload.start, payload.end);
      };

      chart.on('zoomRangeChange', onZoomRangeChange);
      const unsub = (): void => chart.off('zoomRangeChange', onZoomRangeChange);
      unsubscribeFns.push(unsub);
    }
  }

  return () => {
    if (disconnected) return;
    disconnected = true;

    for (const unsub of unsubscribeFns) unsub();
    unsubscribeFns.length = 0;

    // Clear any “stuck” remote interactions.
    for (const chart of charts) {
      if (chart.disposed) continue;
      if (syncCrosshair) chart.setCrosshairX(null, connectionToken);
    }
  };
}

