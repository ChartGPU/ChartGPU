/**
 * Shared hover hit-test dirty gate for highlight + tooltip.
 *
 * Recompute when:
 * - no cached match yet
 * - throttle window elapsed (~60 Hz default)
 *
 * **Always rate-limited** — pointer move does **not** bypass the throttle.
 * Bypassing caused multi‑M `findNearestPoint` every mousemove/frame and jammed
 * the main thread so the highlight only painted when the pointer “resettled”.
 * While rate-limited, consumers reuse the last match; the next allowed sample
 * always uses the **latest** pointer position (caller passes current gridX/Y).
 * Crosshair still tracks the pointer every frame (not gated here).
 *
 * @module hoverHitTestGate
 * @internal
 */

export type HoverHitTestGateState = {
  lastMs: number;
  lastGridX: number;
  lastGridY: number;
  /**
   * `undefined` = never computed / invalidated (must recompute).
   * `null` = last compute found no match.
   */
  cachedMatch: unknown;
};

export type HoverHitTestGateOptions = Readonly<{
  /**
   * Minimum time between recomputes (ms), whether the pointer is moving or
   * stationary. Caps findNearest rate so multi‑M hover stays interactive.
   */
  throttleMs: number;
  /**
   * @deprecated No longer used for recompute decisions (rate limit is time-only).
   * Kept optional for call-site compatibility; ignored when deciding recompute.
   */
  moveEpsPx?: number;
}>;

/**
 * Default ~60 Hz sample rate: snappy highlight tracking while moving, without
 * unbounded per-mousemove findNearest on multi‑M series.
 */
export const DEFAULT_HOVER_HIT_TEST_THROTTLE_MS = 16;
/**
 * Legacy default; ignored by shouldRecompute (time-only rate limit).
 * Retained so existing tests / call sites importing the constant keep compiling.
 */
export const DEFAULT_HOVER_HIT_TEST_MOVE_EPS_PX = 0.75;

/** Hoisted default options (avoid per-frame object allocation). */
export const DEFAULT_HOVER_HIT_TEST_GATE_OPTIONS: HoverHitTestGateOptions = {
  throttleMs: DEFAULT_HOVER_HIT_TEST_THROTTLE_MS,
  moveEpsPx: DEFAULT_HOVER_HIT_TEST_MOVE_EPS_PX,
};

export function createHoverHitTestGateState(): HoverHitTestGateState {
  return {
    lastMs: Number.NEGATIVE_INFINITY,
    lastGridX: Number.NaN,
    lastGridY: Number.NaN,
    cachedMatch: undefined,
  };
}

/**
 * Returns true when findNearestPoint (or equivalent) should run this frame.
 *
 * Time-only rate limit: after a successful commit, further calls within
 * `throttleMs` are suppressed even if the pointer moved. The next allowed
 * frame must pass the **current** gridX/Y into findNearest so the ring
 * tracks the cursor (does not wait for the pointer to stop).
 */
export function shouldRecomputeHoverHitTest(
  state: HoverHitTestGateState,
  nowMs: number,
  _gridX: number,
  _gridY: number,
  options: HoverHitTestGateOptions = DEFAULT_HOVER_HIT_TEST_GATE_OPTIONS
): boolean {
  if (state.cachedMatch === undefined) return true;
  if (!Number.isFinite(state.lastGridX) || !Number.isFinite(state.lastGridY)) return true;

  const throttleMs = options.throttleMs;
  if (nowMs - state.lastMs < throttleMs) return false;
  return true;
}

/**
 * Record a successful recompute (or explicit null miss) into gate state.
 */
export function commitHoverHitTest(
  state: HoverHitTestGateState,
  nowMs: number,
  gridX: number,
  gridY: number,
  match: unknown
): void {
  state.lastMs = nowMs;
  state.lastGridX = gridX;
  state.lastGridY = gridY;
  state.cachedMatch = match;
}

/**
 * Invalidate cache (pointer left grid / series context destroyed / setOptions data change).
 */
export function invalidateHoverHitTest(state: HoverHitTestGateState): void {
  state.cachedMatch = undefined;
  state.lastGridX = Number.NaN;
  state.lastGridY = Number.NaN;
  // Keep lastMs so a brief leave/re-enter still respects throttle if desired;
  // full invalidate forces recompute via cachedMatch === undefined.
}

export type ResolveHoverHitTestFrameResult<T> = {
  /** Match for this frame (fresh or reused). */
  match: T | null;
  /** True when findNearest ran this frame. */
  recomputed: boolean;
  /**
   * When non-null, caller should schedule a follow-up render after this many ms
   * so motion samples are not deferred until the pointer stops.
   * When null and recomputed, caller should cancel any pending follow-up.
   */
  scheduleFollowupMs: number | null;
};

/**
 * Pure one-frame hover hit-test resolution (mouse path).
 * Injectable `findNearest` enables hard call-count unit tests without a full coordinator.
 *
 * `findNearest` must close over the **current** pointer (caller's gridX/Y) so
 * each allowed sample tracks the cursor, not a stale position.
 */
export function resolveHoverHitTestFrame<T>(input: {
  readonly state: HoverHitTestGateState;
  readonly nowMs: number;
  readonly gridX: number;
  readonly gridY: number;
  readonly options?: HoverHitTestGateOptions;
  readonly findNearest: () => T | null;
}): ResolveHoverHitTestFrameResult<T> {
  const options = input.options ?? DEFAULT_HOVER_HIT_TEST_GATE_OPTIONS;
  if (shouldRecomputeHoverHitTest(input.state, input.nowMs, input.gridX, input.gridY, options)) {
    const match = input.findNearest();
    commitHoverHitTest(input.state, input.nowMs, input.gridX, input.gridY, match);
    return { match, recomputed: true, scheduleFollowupMs: null };
  }
  const match = (input.state.cachedMatch as T | null | undefined) ?? null;
  const elapsed = input.nowMs - input.state.lastMs;
  return {
    match,
    recomputed: false,
    // Always schedule a follow-up while suppressed so continuous motion is
    // sampled at the throttle rate even if no further mousemove arrives
    // exactly on the boundary (e.g. pointer stopped mid-window).
    scheduleFollowupMs: Math.max(0, options.throttleMs - elapsed),
  };
}

/**
 * Time-only throttle for sync tooltips (separate from mouse findNearest gate).
 * Returns whether the tooltip secondary hit path should run this frame.
 */
export function shouldAllowSyncTooltipHitTest(
  lastSyncMs: number,
  nowMs: number,
  throttleMs: number = DEFAULT_HOVER_HIT_TEST_THROTTLE_MS
): { allowed: boolean; nextLastSyncMs: number; scheduleFollowupMs: number | null } {
  const elapsed = nowMs - lastSyncMs;
  if (Number.isFinite(lastSyncMs) && elapsed < throttleMs) {
    return {
      allowed: false,
      nextLastSyncMs: lastSyncMs,
      scheduleFollowupMs: Math.max(0, throttleMs - elapsed),
    };
  }
  return { allowed: true, nextLastSyncMs: nowMs, scheduleFollowupMs: null };
}
