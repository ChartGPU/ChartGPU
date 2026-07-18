/**
 * Resync coordinator-owned OHLC from consumer series data on setOption.
 *
 * Streaming examples (e.g. candlestick-streaming) keep a stable OHLC array,
 * mutate the forming bar in place, and call setOption. The coordinator stores a
 * **sliced owned copy** for appendData, so presentation-only setOption (same
 * data ref → didSeriesDataLikelyChange false) would never update what the
 * candlestick renderer packs unless we copy user edits into the owned store.
 *
 * Prefers in-place mutation of the owned array so geometry identity can keep
 * the same data ref while length / last-candle fingerprints force re-upload.
 *
 * @module syncCandlestickRuntime
 * @internal
 */

import type { ResolvedSeriesConfig } from '../../../config/OptionResolver';
import type { OHLCDataPoint } from '../../../config/types';
import { isTupleOHLCDataPoint } from '../utils/dataPointUtils';

export type OhlcBounds = Readonly<{
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}>;

export type SyncCandlestickRuntimeResult = {
  /** True when any owned OHLC slot was written. */
  readonly didMutate: boolean;
  /** True when an owned array was replaced (new ref) — caller should recompute baseline. */
  readonly didReplaceRef: boolean;
  /** Series indices that were mutated. */
  readonly indices: readonly number[];
};

const ohlcEqual = (a: OHLCDataPoint, b: OHLCDataPoint): boolean => {
  if (a === b) return true;
  if (isTupleOHLCDataPoint(a) && isTupleOHLCDataPoint(b)) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
  }
  if (!isTupleOHLCDataPoint(a) && !isTupleOHLCDataPoint(b)) {
    return (
      a.timestamp === b.timestamp && a.open === b.open && a.close === b.close && a.low === b.low && a.high === b.high
    );
  }
  // Mixed shapes: normalize via tuple fields.
  const at = isTupleOHLCDataPoint(a) ? a : ([a.timestamp, a.open, a.close, a.low, a.high] as const);
  const bt = isTupleOHLCDataPoint(b) ? b : ([b.timestamp, b.open, b.close, b.low, b.high] as const);
  return at[0] === bt[0] && at[1] === bt[1] && at[2] === bt[2] && at[3] === bt[3] && at[4] === bt[4];
};

/**
 * Copy consumer candlestick OHLC into coordinator-owned runtime slots.
 *
 * @param extendBounds - Bounds helper (injected for testability)
 */
export function syncCandlestickOwnedFromUserSeries(input: {
  readonly series: ReadonlyArray<ResolvedSeriesConfig>;
  readonly runtimeRawDataByIndex: unknown[];
  readonly runtimeRawBoundsByIndex: Array<OhlcBounds | null>;
  readonly extendBounds: (bounds: OhlcBounds | null, points: ReadonlyArray<OHLCDataPoint>) => OhlcBounds | null;
}): SyncCandlestickRuntimeResult {
  const { series, runtimeRawDataByIndex, runtimeRawBoundsByIndex, extendBounds } = input;
  const indices: number[] = [];
  let didMutate = false;
  let didReplaceRef = false;

  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    if (s.type !== 'candlestick') continue;

    const user = ((s as { rawData?: unknown; data?: unknown }).rawData ?? (s as { data?: unknown }).data) as
      | ReadonlyArray<OHLCDataPoint>
      | null
      | undefined;
    if (user == null || !Array.isArray(user)) continue;

    const existing = runtimeRawDataByIndex[i];

    // Same array identity as the consumer: already shared; mutations are visible.
    if (existing === user) {
      continue;
    }

    // No owned slot yet — take a copy (matches initRuntimeSeriesFromOptions).
    if (existing == null || !Array.isArray(existing)) {
      runtimeRawDataByIndex[i] = user.slice();
      runtimeRawBoundsByIndex[i] = extendBounds(null, user);
      didMutate = true;
      didReplaceRef = true;
      indices.push(i);
      continue;
    }

    const owned = existing as OHLCDataPoint[];

    if (owned.length !== user.length) {
      // Length mismatch: rewrite owned contents in place when possible to keep
      // the array ref stable for geometry identity (length fingerprint re-packs).
      if (user.length > owned.length) {
        for (let j = 0; j < owned.length; j++) {
          if (!ohlcEqual(owned[j]!, user[j]!)) {
            owned[j] = user[j]!;
          }
        }
        for (let j = owned.length; j < user.length; j++) {
          owned.push(user[j]!);
        }
      } else {
        // Truncate then copy.
        owned.length = user.length;
        for (let j = 0; j < user.length; j++) {
          owned[j] = user[j]!;
        }
      }
      runtimeRawBoundsByIndex[i] = extendBounds(null, owned);
      didMutate = true;
      indices.push(i);
      continue;
    }

    // Same length, different refs (owned slice vs consumer array): streaming
    // forming-bar path mutates only the last candle under a stable consumer ref.
    // O(1) last-candle sync; mid-series in-place edits should pass a new array ref.
    if (user.length === 0) continue;

    const lastIdx = user.length - 1;
    const userLast = user[lastIdx]!;
    const ownedLast = owned[lastIdx]!;
    if (!ohlcEqual(ownedLast, userLast)) {
      owned[lastIdx] = userLast;
      runtimeRawBoundsByIndex[i] = extendBounds(runtimeRawBoundsByIndex[i], [userLast]);
      didMutate = true;
      indices.push(i);
    }
  }

  return { didMutate, didReplaceRef, indices };
}
