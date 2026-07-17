/**
 * Shared fixed-capacity ring / FIFO policy for `appendData(..., { maxPoints })`.
 *
 * Single source of truth for DataStore, RenderCoordinator runtime columns, and
 * ChartGPU hit-test columns — all three layers must agree on retained length.
 *
 * Policy (in order):
 * 1. No / invalid `maxPoints` → keep all points (`prev + new`).
 * 2. **Strict batch replace:** if `newCount >= maxPoints`, discard all previous
 *    points and keep only the tail of the new batch (length `maxPoints`).
 *    Handles suite FIFO rows where `increment === points` every frame.
 * 3. **Ring fill:** if `prev + new <= maxPoints`, pure append.
 * 4. **Ring wrap:** if `prev + new > maxPoints`, drop the oldest
 *    `prev + new - maxPoints` points and keep length at `maxPoints`. Steady
 *    state is O(append) on the GPU (modular overwrite); no soft 2× growth and
 *    no full retained-window rewrite.
 *
 * Capacity is **opt-in per append call** (not sticky series construction state).
 * Peak retained length is **`maxPoints`** (not 2×).
 */

export type MaxPointsWindowPlan = Readonly<{
  /** Final series length after applying the window. */
  nextCount: number;
  /**
   * Points to drop from the start of the *previous* series before packing the
   * retained new points. When `isStrictReplace`, this equals `prevCount`
   * (all previous data is discarded).
   */
  dropPrevCount: number;
  /**
   * Offset into the new batch: first index to keep. Non-zero only for strict
   * replace when `newCount > maxPoints` (keep the tail).
   */
  newSrcOffset: number;
  /** How many points from the new batch are retained. */
  keepNewCount: number;
  /** True when any previous or new points were discarded. */
  didWindow: boolean;
  /**
   * True when the new batch alone meets/exceeds capacity — previous series is
   * discarded entirely and only the new batch’s tail is kept.
   */
  isStrictReplace: boolean;
  /**
   * Fixed ring capacity when `maxPoints` is active; `0` when unbounded.
   * DataStore uses this for modular GPU storage; CPU layers use `nextCount`.
   */
  ringCapacity: number;
  /**
   * True when this plan uses fixed-capacity ring semantics (`maxPoints` set).
   */
  isRing: boolean;
}>;

/**
 * Normalizes a caller-supplied `maxPoints` option to a positive integer, or
 * `undefined` when the option is absent / invalid.
 */
export function normalizeMaxPoints(maxPoints: number | undefined | null): number | undefined {
  if (maxPoints == null || !Number.isFinite(maxPoints) || maxPoints <= 0) {
    return undefined;
  }
  return Math.floor(maxPoints);
}

/**
 * Peak retained / reserved length for a given capacity (ring = `maxPoints`).
 */
export function maxPointsPeakRetention(maxPoints: number): number {
  return maxPoints;
}

/**
 * Device storage-binding cap in points (interleaved float32 x,y = 8 bytes/point).
 * Matches DataStore auto-window arithmetic.
 */
export function deviceMaxPointsFromLimits(
  limits: Readonly<{ maxBufferSize: number; maxStorageBufferBindingSize: number }>
): number {
  const hardCap = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  return Math.max(1, Math.floor(hardCap / (2 * 4)));
}

/**
 * Resolve the effective `maxPoints` for an append across DataStore + dual-store
 * (hit-test / coordinator columns).
 *
 * - Caller `maxPoints` wins when set and ≤ device cap.
 * - When unbounded, engages device auto-window once the uncapped next length
 *   would exceed the storage-binding budget (same gate as DataStore.appendSeries).
 * - Device always hard-clamps growth when tighter than the caller cap.
 */
export function resolveEffectiveMaxPointsForAppend(
  callerMaxPoints: number | undefined | null,
  prevCount: number,
  newCount: number,
  limits?: Readonly<{ maxBufferSize: number; maxStorageBufferBindingSize: number }> | null
): number | undefined {
  const caller = normalizeMaxPoints(callerMaxPoints);
  if (!limits) return caller;

  const deviceMax = deviceMaxPointsFromLimits(limits);
  const hardCap = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  const prev = Math.max(0, prevCount | 0);
  const neu = Math.max(0, newCount | 0);
  const uncappedNext = prev + neu;
  // Match DataStore: requiredBytes ≈ nextPointCount * 8 (roundUpToMultipleOf4).
  const requiredBytes = Math.max(4, uncappedNext * 2 * 4);

  if (caller == null) {
    if (requiredBytes > hardCap || uncappedNext > deviceMax) {
      return deviceMax;
    }
    return undefined;
  }
  // Explicit caller max still cannot exceed device storage budget.
  return caller <= deviceMax ? caller : deviceMax;
}

/**
 * Plans how many points to keep after appending `newCount` onto a series of
 * length `prevCount` under optional `maxPoints` (fixed-capacity ring).
 */
export function planMaxPointsWindow(
  prevCount: number,
  newCount: number,
  maxPoints: number | undefined
): MaxPointsWindowPlan {
  const prev = Math.max(0, prevCount | 0);
  const neu = Math.max(0, newCount | 0);

  if (neu === 0) {
    const cap = normalizeMaxPoints(maxPoints);
    return {
      nextCount: prev,
      dropPrevCount: 0,
      newSrcOffset: 0,
      keepNewCount: 0,
      didWindow: false,
      isStrictReplace: false,
      ringCapacity: cap ?? 0,
      isRing: cap != null,
    };
  }

  const cap = normalizeMaxPoints(maxPoints);
  if (cap == null) {
    return {
      nextCount: prev + neu,
      dropPrevCount: 0,
      newSrcOffset: 0,
      keepNewCount: neu,
      didWindow: false,
      isStrictReplace: false,
      ringCapacity: 0,
      isRing: false,
    };
  }

  // Strict: new batch alone fills/exceeds capacity → keep only its tail.
  if (neu >= cap) {
    return {
      nextCount: cap,
      dropPrevCount: prev,
      newSrcOffset: neu - cap,
      keepNewCount: cap,
      didWindow: true,
      isStrictReplace: true,
      ringCapacity: cap,
      isRing: true,
    };
  }

  const uncapped = prev + neu;
  // Ring wrap: drop oldest so retained length stays at capacity.
  if (uncapped > cap) {
    const dropPrevCount = uncapped - cap;
    return {
      nextCount: cap,
      dropPrevCount,
      newSrcOffset: 0,
      keepNewCount: neu,
      didWindow: true,
      isStrictReplace: false,
      ringCapacity: cap,
      isRing: true,
    };
  }

  // Pure append under ring capacity (fill phase).
  return {
    nextCount: uncapped,
    dropPrevCount: 0,
    newSrcOffset: 0,
    keepNewCount: neu,
    didWindow: false,
    isStrictReplace: false,
    ringCapacity: cap,
    isRing: true,
  };
}
