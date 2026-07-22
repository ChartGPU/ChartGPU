/**
 * Unit tests for shared hover hit-test dirty gate (highlight + tooltip).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  commitHoverHitTest,
  createHoverHitTestGateState,
  DEFAULT_HOVER_HIT_TEST_GATE_OPTIONS,
  DEFAULT_HOVER_HIT_TEST_THROTTLE_MS,
  invalidateHoverHitTest,
  resolveHoverHitTestFrame,
  shouldAllowSyncTooltipHitTest,
  shouldRecomputeHoverHitTest,
} from '../hoverHitTestGate';

describe('hoverHitTestGate', () => {
  const opts = DEFAULT_HOVER_HIT_TEST_GATE_OPTIONS;

  it('requires recompute when cache is empty', () => {
    const state = createHoverHitTestGateState();
    expect(shouldRecomputeHoverHitTest(state, 1000, 10, 20, opts)).toBe(true);
  });

  it('suppresses recompute within throttle when pointer is stationary', () => {
    const state = createHoverHitTestGateState();
    const match = { seriesIndex: 0, dataIndex: 1, point: [1, 2], distance: 0 };
    commitHoverHitTest(state, 1000, 10, 20, match);

    expect(shouldRecomputeHoverHitTest(state, 1000 + 5, 10, 20, opts)).toBe(false);
    expect(shouldRecomputeHoverHitTest(state, 1000 + DEFAULT_HOVER_HIT_TEST_THROTTLE_MS - 1, 10, 20, opts)).toBe(false);
    expect(state.cachedMatch).toBe(match);
  });

  it('recomputes after throttle window elapses (stationary pointer)', () => {
    const state = createHoverHitTestGateState();
    commitHoverHitTest(state, 1000, 10, 20, { id: 'a' });
    expect(shouldRecomputeHoverHitTest(state, 1000 + DEFAULT_HOVER_HIT_TEST_THROTTLE_MS, 10, 20, opts)).toBe(true);
  });

  it('rate-limits even when pointer moves (does not bypass throttle)', () => {
    const state = createHoverHitTestGateState();
    commitHoverHitTest(state, 1000, 10, 20, { id: 'a' });
    // Large move inside throttle window — must still suppress so multi-M findNearest
    // cannot run every mousemove and jam the main thread until the pointer stops.
    expect(shouldRecomputeHoverHitTest(state, 1000 + 5, 500, 400, opts)).toBe(false);
  });

  it('after throttle elapses, recompute is allowed at the new pointer position', () => {
    const state = createHoverHitTestGateState();
    commitHoverHitTest(state, 1000, 10, 20, { id: 'a' });
    expect(shouldRecomputeHoverHitTest(state, 1000 + DEFAULT_HOVER_HIT_TEST_THROTTLE_MS, 500, 400, opts)).toBe(true);
  });

  it('invalidate forces next recompute; null match is a valid cache', () => {
    const state = createHoverHitTestGateState();
    commitHoverHitTest(state, 1000, 10, 20, null);
    expect(state.cachedMatch).toBeNull();
    expect(shouldRecomputeHoverHitTest(state, 1000 + 5, 10, 20, opts)).toBe(false);

    invalidateHoverHitTest(state);
    expect(state.cachedMatch).toBeUndefined();
    expect(shouldRecomputeHoverHitTest(state, 1000 + 5, 10, 20, opts)).toBe(true);
  });

  it('shared consumers reuse one committed match (highlight + tooltip contract)', () => {
    const state = createHoverHitTestGateState();
    const match = { seriesIndex: 0, dataIndex: 3, point: [3, 4], distance: 1 };
    expect(shouldRecomputeHoverHitTest(state, 0, 5, 5, opts)).toBe(true);
    commitHoverHitTest(state, 0, 5, 5, match);
    expect(shouldRecomputeHoverHitTest(state, 5, 5, 5, opts)).toBe(false);
    expect(state.cachedMatch).toBe(match);
    expect(state.cachedMatch).toBe(match);
  });
});

describe('resolveHoverHitTestFrame (coordinator gate integration)', () => {
  it('calls findNearest once on first frame and reuses on suppress', () => {
    const state = createHoverHitTestGateState();
    const findNearest = vi.fn(() => ({ seriesIndex: 0, dataIndex: 2, point: [2, 3], distance: 0 }));

    const f1 = resolveHoverHitTestFrame({
      state,
      nowMs: 0,
      gridX: 10,
      gridY: 20,
      findNearest,
    });
    expect(f1.recomputed).toBe(true);
    expect(f1.match).toEqual({ seriesIndex: 0, dataIndex: 2, point: [2, 3], distance: 0 });
    expect(f1.scheduleFollowupMs).toBeNull();
    expect(findNearest).toHaveBeenCalledTimes(1);

    const f2 = resolveHoverHitTestFrame({
      state,
      nowMs: 5,
      gridX: 10,
      gridY: 20,
      findNearest,
    });
    expect(f2.recomputed).toBe(false);
    expect(f2.match).toBe(f1.match);
    expect(f2.scheduleFollowupMs).not.toBeNull();
    expect(findNearest).toHaveBeenCalledTimes(1);

    const f3 = resolveHoverHitTestFrame({
      state,
      nowMs: DEFAULT_HOVER_HIT_TEST_THROTTLE_MS,
      gridX: 10,
      gridY: 20,
      findNearest,
    });
    expect(f3.recomputed).toBe(true);
    expect(findNearest).toHaveBeenCalledTimes(2);
  });

  it('motion samples use latest pointer after throttle (tracks cursor, not settle-only)', () => {
    const state = createHoverHitTestGateState();
    let call = 0;
    const positions: Array<{ x: number; y: number }> = [];
    const findNearest = vi.fn(() => {
      call += 1;
      // Caller closes over current grid — simulate by reading last requested via mock impl below
      return { seriesIndex: 0, dataIndex: call, point: [call, 0], distance: 0 };
    });

    // Frame 1 at (0,0)
    const f1 = resolveHoverHitTestFrame({
      state,
      nowMs: 0,
      gridX: 0,
      gridY: 0,
      findNearest: () => {
        positions.push({ x: 0, y: 0 });
        return findNearest();
      },
    });
    expect(f1.recomputed).toBe(true);
    expect(f1.match).toEqual({ seriesIndex: 0, dataIndex: 1, point: [1, 0], distance: 0 });

    // Mid-window: pointer moved far — still suppressed (rate limit)
    const f2 = resolveHoverHitTestFrame({
      state,
      nowMs: 8,
      gridX: 200,
      gridY: 100,
      findNearest: () => {
        positions.push({ x: 200, y: 100 });
        return findNearest();
      },
    });
    expect(f2.recomputed).toBe(false);
    expect(f2.match).toBe(f1.match); // stale ring for ≤ throttleMs
    expect(f2.scheduleFollowupMs).toBeGreaterThan(0);
    expect(findNearest).toHaveBeenCalledTimes(1);

    // After throttle: must sample at the *new* cursor, not wait for settle
    const f3 = resolveHoverHitTestFrame({
      state,
      nowMs: DEFAULT_HOVER_HIT_TEST_THROTTLE_MS,
      gridX: 200,
      gridY: 100,
      findNearest: () => {
        positions.push({ x: 200, y: 100 });
        return findNearest();
      },
    });
    expect(f3.recomputed).toBe(true);
    expect(f3.match).toEqual({ seriesIndex: 0, dataIndex: 2, point: [2, 0], distance: 0 });
    expect(positions[positions.length - 1]).toEqual({ x: 200, y: 100 });
    expect(findNearest).toHaveBeenCalledTimes(2);
  });

  it('invalidate then frame forces findNearest again', () => {
    const state = createHoverHitTestGateState();
    const findNearest = vi.fn(() => null);
    resolveHoverHitTestFrame({ state, nowMs: 0, gridX: 1, gridY: 1, findNearest });
    expect(findNearest).toHaveBeenCalledTimes(1);
    invalidateHoverHitTest(state);
    resolveHoverHitTestFrame({ state, nowMs: 5, gridX: 1, gridY: 1, findNearest });
    expect(findNearest).toHaveBeenCalledTimes(2);
  });
});

describe('shouldAllowSyncTooltipHitTest', () => {
  it('allows first call and throttles subsequent within window', () => {
    const a = shouldAllowSyncTooltipHitTest(Number.NEGATIVE_INFINITY, 1000, 33);
    expect(a.allowed).toBe(true);
    expect(a.nextLastSyncMs).toBe(1000);
    expect(a.scheduleFollowupMs).toBeNull();

    const b = shouldAllowSyncTooltipHitTest(a.nextLastSyncMs, 1010, 33);
    expect(b.allowed).toBe(false);
    expect(b.nextLastSyncMs).toBe(1000);
    expect(b.scheduleFollowupMs).toBe(23);

    const c = shouldAllowSyncTooltipHitTest(a.nextLastSyncMs, 1033, 33);
    expect(c.allowed).toBe(true);
    expect(c.nextLastSyncMs).toBe(1033);
  });

  it('does not share state with mouse gate (independent lastMs)', () => {
    const mouse = createHoverHitTestGateState();
    commitHoverHitTest(mouse, 5000, 0, 0, { id: 'mouse' });
    const sync = shouldAllowSyncTooltipHitTest(Number.NEGATIVE_INFINITY, 5001, 33);
    expect(sync.allowed).toBe(true);
    expect(shouldRecomputeHoverHitTest(mouse, 5001, 0, 0, DEFAULT_HOVER_HIT_TEST_GATE_OPTIONS)).toBe(false);
  });
});
