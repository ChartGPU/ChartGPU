/**
 * syncCandlestickOwnedFromUserSeries — forming-bar / length resync for setOption.
 */

import { describe, it, expect } from 'vitest';
import type { OHLCDataPoint } from '../../../../config/types';
import { extendBoundsWithOHLCDataPoints } from '../../utils/boundsComputation';
import { syncCandlestickOwnedFromUserSeries } from '../syncCandlestickRuntime';

const candle = (t: number, o: number, c: number, l: number, h: number): OHLCDataPoint => [t, o, c, l, h];

function seriesWithData(data: OHLCDataPoint[]) {
  return [{ type: 'candlestick' as const, data, rawData: data }] as any;
}

describe('syncCandlestickOwnedFromUserSeries', () => {
  it('no-ops when owned is the same array as user data', () => {
    const data = [candle(0, 1, 2, 0.5, 2.5)];
    const runtimeRawDataByIndex: unknown[] = [data];
    const runtimeRawBoundsByIndex: any[] = [null];
    const result = syncCandlestickOwnedFromUserSeries({
      series: seriesWithData(data),
      runtimeRawDataByIndex,
      runtimeRawBoundsByIndex,
      extendBounds: extendBoundsWithOHLCDataPoints,
    });
    expect(result.didMutate).toBe(false);
    expect(runtimeRawDataByIndex[0]).toBe(data);
  });

  it('copies last candle into owned when consumer mutates forming bar (same length)', () => {
    const user = [candle(0, 10, 11, 9, 12), candle(1, 11, 11, 11, 11)];
    const owned = [candle(0, 10, 11, 9, 12), candle(1, 11, 11, 11, 11)];
    const runtimeRawDataByIndex: unknown[] = [owned];
    const runtimeRawBoundsByIndex: any[] = [null];

    // Forming bar: close/high moved on consumer array only.
    user[1] = candle(1, 11, 16, 10, 17);

    const result = syncCandlestickOwnedFromUserSeries({
      series: seriesWithData(user),
      runtimeRawDataByIndex,
      runtimeRawBoundsByIndex,
      extendBounds: extendBoundsWithOHLCDataPoints,
    });

    expect(result.didMutate).toBe(true);
    expect(result.didReplaceRef).toBe(false);
    expect(runtimeRawDataByIndex[0]).toBe(owned); // same owned ref
    expect(owned[1]).toEqual(candle(1, 11, 16, 10, 17));
    expect(owned[0]).toEqual(candle(0, 10, 11, 9, 12));
  });

  it('appends onto owned when consumer array grew (stable owned ref)', () => {
    const user = [candle(0, 10, 11, 9, 12), candle(1, 11, 12, 10, 13)];
    const owned = [candle(0, 10, 11, 9, 12)];
    const runtimeRawDataByIndex: unknown[] = [owned];
    const runtimeRawBoundsByIndex: any[] = [null];

    const result = syncCandlestickOwnedFromUserSeries({
      series: seriesWithData(user),
      runtimeRawDataByIndex,
      runtimeRawBoundsByIndex,
      extendBounds: extendBoundsWithOHLCDataPoints,
    });

    expect(result.didMutate).toBe(true);
    expect(runtimeRawDataByIndex[0]).toBe(owned);
    expect(owned).toHaveLength(2);
    expect(owned[1]).toEqual(candle(1, 11, 12, 10, 13));
  });

  it('truncates owned when consumer array shrank', () => {
    const user = [candle(0, 10, 11, 9, 12)];
    const owned = [candle(0, 10, 11, 9, 12), candle(1, 11, 12, 10, 13)];
    const runtimeRawDataByIndex: unknown[] = [owned];
    const runtimeRawBoundsByIndex: any[] = [null];

    const result = syncCandlestickOwnedFromUserSeries({
      series: seriesWithData(user),
      runtimeRawDataByIndex,
      runtimeRawBoundsByIndex,
      extendBounds: extendBoundsWithOHLCDataPoints,
    });

    expect(result.didMutate).toBe(true);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toEqual(candle(0, 10, 11, 9, 12));
  });

  it('seeds owned with a slice when slot is empty', () => {
    const user = [candle(0, 1, 2, 0.5, 2.5)];
    const runtimeRawDataByIndex: unknown[] = [null];
    const runtimeRawBoundsByIndex: any[] = [null];

    const result = syncCandlestickOwnedFromUserSeries({
      series: seriesWithData(user),
      runtimeRawDataByIndex,
      runtimeRawBoundsByIndex,
      extendBounds: extendBoundsWithOHLCDataPoints,
    });

    expect(result.didMutate).toBe(true);
    expect(result.didReplaceRef).toBe(true);
    expect(runtimeRawDataByIndex[0]).not.toBe(user);
    expect(runtimeRawDataByIndex[0]).toEqual(user);
  });

  it('skips non-candlestick series', () => {
    const runtimeRawDataByIndex: unknown[] = [null];
    const runtimeRawBoundsByIndex: any[] = [null];
    const result = syncCandlestickOwnedFromUserSeries({
      series: [{ type: 'line', data: [[0, 1]] }] as any,
      runtimeRawDataByIndex,
      runtimeRawBoundsByIndex,
      extendBounds: extendBoundsWithOHLCDataPoints,
    });
    expect(result.didMutate).toBe(false);
    expect(runtimeRawDataByIndex[0]).toBeNull();
  });
});
