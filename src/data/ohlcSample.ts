import type { OHLCDataPoint, OHLCDataPointTuple } from '../config/types';

function isTupleOHLCDataPoint(point: OHLCDataPoint): point is OHLCDataPointTuple {
  return Array.isArray(point);
}

/**
 * Downsamples OHLC (candlestick) data to a target number of points using bucket aggregation.
 *
 * Each bucket aggregates candles preserving OHLC semantics:
 * - timestamp and open from the first candle in the bucket
 * - close from the last candle in the bucket
 * - high as the maximum of all highs in the bucket
 * - low as the minimum of all lows in the bucket
 *
 * @param data - Array of OHLC data points (tuples or objects)
 * @param targetPoints - Desired number of output points
 * @returns Downsampled array; same reference if no sampling needed
 *
 * Edge cases:
 * - If `data.length <= targetPoints` or `targetPoints < 2`, returns the original array (same reference)
 * - First and last candles are always preserved exactly (same element references)
 * - Output shape matches input shape (tuples → tuples, objects → objects)
 */
export function ohlcSample(
  data: ReadonlyArray<OHLCDataPoint>,
  targetPoints: number,
): ReadonlyArray<OHLCDataPoint> {
  const threshold = Math.floor(targetPoints);
  const n = data.length;

  // Return original if already under target or insufficient target.
  if (threshold < 2 || n <= threshold) return data;

  const out = new Array<OHLCDataPoint>(threshold);

  // Preserve first and last candles exactly.
  out[0] = data[0]!;
  out[threshold - 1] = data[n - 1]!;

  if (threshold === 2) return out;

  // Hoist tuple-vs-object detection once (assume homogeneous arrays).
  const isTuple = isTupleOHLCDataPoint(data[0]!);

  // Bucket size for interior points: (n - 2) interior input points → (threshold - 2) interior output points.
  const bucketSize = (n - 2) / (threshold - 2);

  if (isTuple) {
    // Tuple format path: [timestamp, open, close, low, high]
    const dataAsTuples = data as ReadonlyArray<OHLCDataPointTuple>;

    for (let bucket = 0; bucket < threshold - 2; bucket++) {
      // Bucket range: [rangeStart, rangeEndExclusive)
      let rangeStart = Math.floor(bucketSize * bucket) + 1;
      let rangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 1)) + 1, n - 1);

      // Defensive: ensure at least one candidate point.
      if (rangeStart >= rangeEndExclusive) {
        rangeStart = Math.min(rangeStart, n - 2);
        rangeEndExclusive = Math.min(rangeStart + 1, n - 1);
      }

      // Extract first and last candles in bucket.
      const firstCandle = dataAsTuples[rangeStart]!;
      const lastCandle = dataAsTuples[rangeEndExclusive - 1]!;

      const timestamp = firstCandle[0];
      const open = firstCandle[1];
      const close = lastCandle[2];

      // Aggregate high and low across the bucket.
      let high = -Infinity;
      let low = Infinity;
      for (let i = rangeStart; i < rangeEndExclusive; i++) {
        const candle = dataAsTuples[i]!;
        const candleLow = candle[3];
        const candleHigh = candle[4];
        if (candleHigh > high) high = candleHigh;
        if (candleLow < low) low = candleLow;
      }

      out[bucket + 1] = [timestamp, open, close, low, high];
    }
  } else {
    // Object format path: { timestamp, open, close, low, high }
    const dataAsObjects = data as ReadonlyArray<Exclude<OHLCDataPoint, OHLCDataPointTuple>>;

    for (let bucket = 0; bucket < threshold - 2; bucket++) {
      // Bucket range: [rangeStart, rangeEndExclusive)
      let rangeStart = Math.floor(bucketSize * bucket) + 1;
      let rangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 1)) + 1, n - 1);

      // Defensive: ensure at least one candidate point.
      if (rangeStart >= rangeEndExclusive) {
        rangeStart = Math.min(rangeStart, n - 2);
        rangeEndExclusive = Math.min(rangeStart + 1, n - 1);
      }

      // Extract first and last candles in bucket.
      const firstCandle = dataAsObjects[rangeStart]!;
      const lastCandle = dataAsObjects[rangeEndExclusive - 1]!;

      const timestamp = firstCandle.timestamp;
      const open = firstCandle.open;
      const close = lastCandle.close;

      // Aggregate high and low across the bucket.
      let high = -Infinity;
      let low = Infinity;
      for (let i = rangeStart; i < rangeEndExclusive; i++) {
        const candle = dataAsObjects[i]!;
        const candleHigh = candle.high;
        const candleLow = candle.low;
        if (candleHigh > high) high = candleHigh;
        if (candleLow < low) low = candleLow;
      }

      out[bucket + 1] = { timestamp, open, close, low, high };
    }
  }

  return out;
}
