/**
 * Stacked mountain prepare cache: fingerprint, peer invalidation, multi-chart isolation.
 */
import { describe, it, expect } from 'vitest';
import type { ResolvedSeriesConfig } from '../../../../config/OptionResolver';
import type { DataPoint } from '../../../../config/types';
import {
  createStackedMountainCache,
  getStackedMountainGeometryMap,
  invalidateStackedMountainCache,
} from '../stackedMountainCache';

const layer = (data: DataPoint[], stack = 's', yAxis = 'y'): ResolvedSeriesConfig =>
  ({
    type: 'line',
    name: 'm',
    data,
    rawData: data,
    color: '#0af',
    visible: true,
    connectNulls: false,
    sampling: 'none',
    samplingThreshold: 5000,
    yAxis,
    stack,
    areaStyle: { color: '#0af', opacity: 0.85 },
    lineStyle: { width: 1, opacity: 1, color: '#0af' },
  }) as any;

const passthroughFilter = (_i: number, data: any) => data;

describe('stackedMountainCache', () => {
  it('reuses geometry when fingerprint stable', () => {
    const dataA: DataPoint[] = [
      [0, 1],
      [1, 1],
    ];
    const dataB: DataPoint[] = [
      [0, 2],
      [1, 2],
    ];
    const series = [layer(dataA), layer(dataB)];
    const cache = createStackedMountainCache();
    const first = getStackedMountainGeometryMap(series, cache, passthroughFilter);
    const second = getStackedMountainGeometryMap(series, cache, passthroughFilter);
    expect(second).toBe(first);
    expect(first.get(1)!.yTop[0]).toBe(3);
  });

  it('invalidates when peer data ref changes', () => {
    const dataA: DataPoint[] = [
      [0, 1],
      [1, 1],
    ];
    const dataB1: DataPoint[] = [
      [0, 2],
      [1, 2],
    ];
    const dataB2: DataPoint[] = [
      [0, 5],
      [1, 5],
    ];
    const cache = createStackedMountainCache();
    const g1 = getStackedMountainGeometryMap([layer(dataA), layer(dataB1)], cache, passthroughFilter);
    expect(g1.get(1)!.yTop[0]).toBe(3);
    const g2 = getStackedMountainGeometryMap([layer(dataA), layer(dataB2)], cache, passthroughFilter);
    expect(g2).not.toBe(g1);
    expect(g2.get(1)!.yTop[0]).toBe(6);
  });

  it('invalidates when stack id / membership changes under same data refs', () => {
    const dataA: DataPoint[] = [
      [0, 1],
      [1, 1],
    ];
    const dataB: DataPoint[] = [
      [0, 2],
      [1, 2],
    ];
    const cache = createStackedMountainCache();
    const sameStack = getStackedMountainGeometryMap([layer(dataA, 's1'), layer(dataB, 's1')], cache, passthroughFilter);
    expect(sameStack.get(1)!.yTop[0]).toBe(3);
    // Regroup to independent stacks → each bottom at 0
    const split = getStackedMountainGeometryMap([layer(dataA, 'a'), layer(dataB, 'b')], cache, passthroughFilter);
    expect(split).not.toBe(sameStack);
    expect(split.get(0)!.yTop[0]).toBe(1);
    expect(split.get(1)!.yBottom[0]).toBe(0);
    expect(split.get(1)!.yTop[0]).toBe(2);
  });

  it('invalidates when point count grows under same data object (append growth)', () => {
    const x = [0, 1];
    const y = [1, 1];
    const data: any = { x, y };
    const peer: DataPoint[] = [
      [0, 2],
      [1, 2],
    ];
    const cache = createStackedMountainCache();
    const g1 = getStackedMountainGeometryMap([layer(data), layer(peer)], cache, passthroughFilter);
    expect(g1.get(0)!.yTop.length).toBe(2);
    // Simulate in-place column growth (append)
    data.x = [0, 1, 2];
    data.y = [1, 1, 1];
    const g2 = getStackedMountainGeometryMap([layer(data), layer(peer)], cache, passthroughFilter);
    expect(g2).not.toBe(g1);
    expect(g2.get(0)!.yTop.length).toBe(3);
  });

  it('explicit invalidate forces recompute', () => {
    const dataA: DataPoint[] = [[0, 1]];
    const dataB: DataPoint[] = [[0, 2]];
    const cache = createStackedMountainCache();
    const g1 = getStackedMountainGeometryMap([layer(dataA), layer(dataB)], cache, passthroughFilter);
    invalidateStackedMountainCache(cache);
    const g2 = getStackedMountainGeometryMap([layer(dataA), layer(dataB)], cache, passthroughFilter);
    expect(g2).not.toBe(g1);
    expect(g2.get(1)!.yTop[0]).toBe(3);
  });

  it('isolates multi-chart caches (not process-global)', () => {
    const dataA: DataPoint[] = [[0, 1]];
    const dataB: DataPoint[] = [[0, 2]];
    const c1 = createStackedMountainCache();
    const c2 = createStackedMountainCache();
    const g1 = getStackedMountainGeometryMap([layer(dataA), layer(dataB)], c1, passthroughFilter);
    const g2 = getStackedMountainGeometryMap([layer(dataA), layer(dataB)], c2, passthroughFilter);
    expect(g1).not.toBe(g2);
    invalidateStackedMountainCache(c1);
    const g1b = getStackedMountainGeometryMap([layer(dataA), layer(dataB)], c1, passthroughFilter);
    const g2b = getStackedMountainGeometryMap([layer(dataA), layer(dataB)], c2, passthroughFilter);
    expect(g2b).toBe(g2); // chart 2 untouched
    expect(g1b).not.toBe(g1);
  });

  it('skips visible:false layers in composition', () => {
    const dataA: DataPoint[] = [[0, 1]];
    const dataB: DataPoint[] = [[0, 2]];
    const hidden = layer(dataA);
    (hidden as any).visible = false;
    const cache = createStackedMountainCache();
    const g = getStackedMountainGeometryMap([hidden, layer(dataB)], cache, passthroughFilter);
    expect(g.has(0)).toBe(false);
    expect(g.get(1)!.yBottom[0]).toBe(0);
    expect(g.get(1)!.yTop[0]).toBe(2);
  });
});
