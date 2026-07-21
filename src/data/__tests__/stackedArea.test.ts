/**
 * Pure stacked mountain / area composition math.
 */
import { describe, it, expect } from 'vitest';
import type { CartesianSeriesData, DataPoint } from '../../config/types';
import {
  canAlignStackedAreaByIndex,
  computeStackedAreaBaselines,
  computeStackedMountainYExtentsForAxis,
  computeStackedYExtents,
  findStackedMountainHit,
  groupStackedMountainLayers,
  isStackedMountainSeries,
  normalizeStackId,
  resolveStackedMountainDataView,
  stackTotalAtX,
} from '../stackedArea';
import { filterGaps } from '../cartesianData';

const pts = (ys: number[], x0 = 0): DataPoint[] => ys.map((y, i) => [x0 + i, y] as const);

describe('normalizeStackId', () => {
  it('trims and drops empty', () => {
    expect(normalizeStackId('  traffic  ')).toBe('traffic');
    expect(normalizeStackId('')).toBe('');
    expect(normalizeStackId('   ')).toBe('');
    expect(normalizeStackId(null)).toBe('');
    expect(normalizeStackId(undefined)).toBe('');
    expect(normalizeStackId(1)).toBe('');
  });
});

describe('isStackedMountainSeries', () => {
  it('requires non-empty stack + area or line+areaStyle', () => {
    expect(isStackedMountainSeries({ type: 'area', stack: 'a' })).toBe(true);
    expect(isStackedMountainSeries({ type: 'line', stack: 'a', areaStyle: {} })).toBe(true);
    expect(isStackedMountainSeries({ type: 'line', stack: 'a' })).toBe(false);
    expect(isStackedMountainSeries({ type: 'area', stack: '' })).toBe(false);
    expect(isStackedMountainSeries({ type: 'bar', stack: 'a' })).toBe(false);
  });
});

describe('computeStackedAreaBaselines — equal-x index path', () => {
  it('3-layer positive stack: tops [1],[3],[6] for y=[1,1,1],[2,2,2],[3,3,3]', () => {
    const layers = [
      { seriesIndex: 0, data: pts([1, 1, 1]) as CartesianSeriesData },
      { seriesIndex: 1, data: pts([2, 2, 2]) as CartesianSeriesData },
      { seriesIndex: 2, data: pts([3, 3, 3]) as CartesianSeriesData },
    ];
    expect(canAlignStackedAreaByIndex(layers)).toBe(true);
    const geos = computeStackedAreaBaselines(layers);
    expect(geos).toHaveLength(3);
    // S0
    expect(Array.from(geos[0]!.yBottom)).toEqual([0, 0, 0]);
    expect(Array.from(geos[0]!.yTop)).toEqual([1, 1, 1]);
    // S1
    expect(Array.from(geos[1]!.yBottom)).toEqual([1, 1, 1]);
    expect(Array.from(geos[1]!.yTop)).toEqual([3, 3, 3]);
    // S2
    expect(Array.from(geos[2]!.yBottom)).toEqual([3, 3, 3]);
    expect(Array.from(geos[2]!.yTop)).toEqual([6, 6, 6]);

    const ext = computeStackedYExtents(geos);
    expect(ext).toEqual({ yMin: 0, yMax: 6 });
  });

  it('closed-form [1,1,1]+[2,2,2] → tops [1] then [3]; domain max 3 not 2', () => {
    const layers = [
      { seriesIndex: 0, data: pts([1, 1, 1]) as CartesianSeriesData },
      { seriesIndex: 1, data: pts([2, 2, 2]) as CartesianSeriesData },
    ];
    const geos = computeStackedAreaBaselines(layers);
    expect(Array.from(geos[1]!.yTop)).toEqual([3, 3, 3]);
    expect(computeStackedYExtents(geos)?.yMax).toBe(3);
  });

  it('positive / negative independent stack sums (bar parity)', () => {
    const layers = [
      { seriesIndex: 0, data: pts([2, -1]) as CartesianSeriesData },
      { seriesIndex: 1, data: pts([3, -2]) as CartesianSeriesData },
    ];
    const geos = computeStackedAreaBaselines(layers);
    // x0: pos 0→2 then 2→5
    expect(geos[0]!.yBottom[0]).toBe(0);
    expect(geos[0]!.yTop[0]).toBe(2);
    expect(geos[1]!.yBottom[0]).toBe(2);
    expect(geos[1]!.yTop[0]).toBe(5);
    // x1: neg 0→-1 then -1→-3
    expect(geos[0]!.yBottom[1]).toBe(0);
    expect(geos[0]!.yTop[1]).toBe(-1);
    expect(geos[1]!.yBottom[1]).toBe(-1);
    expect(geos[1]!.yTop[1]).toBe(-3);

    const ext = computeStackedYExtents(geos);
    expect(ext?.yMin).toBe(-3);
    expect(ext?.yMax).toBe(5);
  });

  it('does not mutate caller-owned arrays', () => {
    const y = new Float64Array([1, 2, 3]);
    const data: CartesianSeriesData = { x: new Float64Array([0, 1, 2]), y };
    const layers = [
      { seriesIndex: 0, data },
      { seriesIndex: 1, data: { x: new Float64Array([0, 1, 2]), y: new Float64Array([1, 1, 1]) } },
    ];
    computeStackedAreaBaselines(layers);
    expect(Array.from(y)).toEqual([1, 2, 3]);
  });
});

describe('computeStackedAreaBaselines — sparse x-key path', () => {
  it('missing peer at x contributes 0', () => {
    const a: DataPoint[] = [
      [0, 1],
      [2, 1],
    ];
    const b: DataPoint[] = [
      [0, 2],
      [1, 5],
      [2, 2],
    ];
    const layers = [
      { seriesIndex: 0, data: a as CartesianSeriesData },
      { seriesIndex: 1, data: b as CartesianSeriesData },
    ];
    expect(canAlignStackedAreaByIndex(layers)).toBe(false);
    const geos = computeStackedAreaBaselines(layers);
    // B at x=0 sits on A (1): bottom=1 top=3
    expect(geos[1]!.yBottom[0]).toBe(1);
    expect(geos[1]!.yTop[0]).toBe(3);
    // B at x=1: A missing → bottom=0 top=5
    expect(geos[1]!.yBottom[1]).toBe(0);
    expect(geos[1]!.yTop[1]).toBe(5);
    // B at x=2 sits on A (1)
    expect(geos[1]!.yBottom[2]).toBe(1);
    expect(geos[1]!.yTop[2]).toBe(3);
  });
});

describe('groupStackedMountainLayers', () => {
  it('isolates by yAxis + stack id; preserves array order', () => {
    const series = [
      { type: 'line' as const, stack: 'a', areaStyle: {}, yAxis: 'y', data: pts([1]), visible: true },
      { type: 'line' as const, stack: 'a', areaStyle: {}, yAxis: 'y2', data: pts([9]), visible: true },
      { type: 'line' as const, stack: 'a', areaStyle: {}, yAxis: 'y', data: pts([2]), visible: true },
      { type: 'line' as const, stack: 'b', areaStyle: {}, yAxis: 'y', data: pts([3]), visible: true },
      { type: 'line' as const, data: pts([4]), visible: true },
    ];
    const groups = groupStackedMountainLayers(series);
    expect(groups.size).toBe(3);
    const left = groups.get('y\0a')!;
    expect(left.map((m) => m.seriesIndex)).toEqual([0, 2]);
    const right = groups.get('y2\0a')!;
    expect(right.map((m) => m.seriesIndex)).toEqual([1]);
  });

  it('empty stack id is not grouped', () => {
    const series = [{ type: 'area' as const, stack: '  ', data: pts([1]), visible: true }];
    expect(groupStackedMountainLayers(series).size).toBe(0);
  });
});

describe('findStackedMountainHit + stackTotalAtX', () => {
  it('prefers topmost layer under cursor; reports contribution y + stackTotal', () => {
    const layers = [
      { seriesIndex: 0, data: pts([1, 1, 1]) as CartesianSeriesData },
      { seriesIndex: 1, data: pts([2, 2, 2]) as CartesianSeriesData },
      { seriesIndex: 2, data: pts([3, 3, 3]) as CartesianSeriesData },
    ];
    const geos = computeStackedAreaBaselines(layers);
    // At x=1, y=4 is inside S2 band [3,6]
    const hit = findStackedMountainHit({
      layers,
      geometries: geos,
      xTarget: 1,
      yTarget: 4,
      xTolerance: 0,
    });
    expect(hit).not.toBeNull();
    expect(hit!.seriesIndex).toBe(2);
    expect(hit!.contributionY).toBe(3);
    expect(hit!.stackTotal).toBe(6);
    expect(hit!.yBottom).toBe(3);
    expect(hit!.yTop).toBe(6);

    // y=1.5 is inside S1 [1,3] not S0
    const mid = findStackedMountainHit({
      layers,
      geometries: geos,
      xTarget: 1,
      yTarget: 1.5,
      xTolerance: 0,
    });
    expect(mid!.seriesIndex).toBe(1);
    expect(mid!.contributionY).toBe(2);
    expect(mid!.stackTotal).toBe(6);

    expect(stackTotalAtX(layers, geos, 1)).toBe(6);
  });

  it('returns null when y is outside all layers', () => {
    const layers = [{ seriesIndex: 0, data: pts([1]) as CartesianSeriesData }];
    const geos = computeStackedAreaBaselines(layers);
    expect(
      findStackedMountainHit({
        layers,
        geometries: geos,
        xTarget: 0,
        yTarget: 5,
        xTolerance: 0,
      })
    ).toBeNull();
  });
});

describe('computeStackedAreaBaselines — edge cases', () => {
  it('same length unequal x falls back to x-key path', () => {
    const layers = [
      {
        seriesIndex: 0,
        data: [
          [0, 1],
          [2, 1],
        ] as CartesianSeriesData,
      },
      {
        seriesIndex: 1,
        data: [
          [1, 2],
          [2, 2],
        ] as CartesianSeriesData,
      },
    ];
    expect(canAlignStackedAreaByIndex(layers)).toBe(false);
    const geos = computeStackedAreaBaselines(layers);
    // B at x=1: A missing → bottom 0 top 2
    expect(geos[1]!.yBottom[0]).toBe(0);
    expect(geos[1]!.yTop[0]).toBe(2);
    // B at x=2 sits on A
    expect(geos[1]!.yBottom[1]).toBe(1);
    expect(geos[1]!.yTop[1]).toBe(3);
  });

  it('multi-group baselines are independent', () => {
    // Two separate calls simulate two stack groups
    const g1 = computeStackedAreaBaselines([
      { seriesIndex: 0, data: pts([1]) as CartesianSeriesData },
      { seriesIndex: 1, data: pts([2]) as CartesianSeriesData },
    ]);
    const g2 = computeStackedAreaBaselines([
      { seriesIndex: 2, data: pts([10]) as CartesianSeriesData },
      { seriesIndex: 3, data: pts([20]) as CartesianSeriesData },
    ]);
    expect(g1[1]!.yTop[0]).toBe(3);
    expect(g2[1]!.yTop[0]).toBe(30);
  });

  it('non-finite y produces NaN floors and skips contribution', () => {
    const layers = [
      {
        seriesIndex: 0,
        data: [
          [0, 1],
          [1, Number.NaN],
          [2, 1],
        ] as CartesianSeriesData,
      },
      {
        seriesIndex: 1,
        data: [
          [0, 2],
          [1, 2],
          [2, 2],
        ] as CartesianSeriesData,
      },
    ];
    const geos = computeStackedAreaBaselines(layers);
    expect(Number.isNaN(geos[0]!.yTop[1]!)).toBe(true);
    // At x=1, A non-finite → B baseline 0
    expect(geos[1]!.yBottom[1]).toBe(0);
    expect(geos[1]!.yTop[1]).toBe(2);
  });

  it('stackTotalAtX for pos+neg returns net composition', () => {
    const layers = [
      { seriesIndex: 0, data: pts([2, -1]) as CartesianSeriesData },
      { seriesIndex: 1, data: pts([3, -2]) as CartesianSeriesData },
    ];
    const geos = computeStackedAreaBaselines(layers);
    expect(stackTotalAtX(layers, geos, 0)).toBe(5);
    expect(stackTotalAtX(layers, geos, 1)).toBe(-3);
  });

  it('empty layers returns empty geometry', () => {
    expect(computeStackedAreaBaselines([])).toEqual([]);
    expect(computeStackedYExtents([])).toBeNull();
  });

  it('groupStackedMountainLayers skips visible:false by default', () => {
    const series = [
      { type: 'line' as const, stack: 'a', areaStyle: {}, data: pts([1]), visible: false },
      { type: 'line' as const, stack: 'a', areaStyle: {}, data: pts([2]), visible: true },
    ];
    const groups = groupStackedMountainLayers(series);
    expect(groups.get('y\0a')!.map((m) => m.seriesIndex)).toEqual([1]);
  });
});

describe('computeStackedMountainYExtentsForAxis', () => {
  it('returns composition totals for axis only', () => {
    const series = [
      {
        type: 'line' as const,
        stack: 'a',
        areaStyle: {},
        yAxis: 'y',
        data: pts([1, 1]),
        visible: true,
      },
      {
        type: 'line' as const,
        stack: 'a',
        areaStyle: {},
        yAxis: 'y',
        data: pts([2, 2]),
        visible: true,
      },
      {
        type: 'line' as const,
        stack: 'a',
        areaStyle: {},
        yAxis: 'y2',
        data: pts([10, 10]),
        visible: true,
      },
    ];
    const left = computeStackedMountainYExtentsForAxis(series, 'y');
    expect(left).toEqual({ yMin: 0, yMax: 3 });
    const right = computeStackedMountainYExtentsForAxis(series, 'y2');
    expect(right).toEqual({ yMin: 0, yMax: 10 });
  });

  it('xWindow excludes out-of-range samples from composition extents', () => {
    // x=0: stack 1+2=3; x=1: stack 10+20=30; x=2: stack 1+2=3
    const series = [
      {
        type: 'line' as const,
        stack: 'a',
        areaStyle: {},
        yAxis: 'y',
        data: [
          [0, 1],
          [1, 10],
          [2, 1],
        ] as DataPoint[],
        visible: true,
      },
      {
        type: 'line' as const,
        stack: 'a',
        areaStyle: {},
        yAxis: 'y',
        data: [
          [0, 2],
          [1, 20],
          [2, 2],
        ] as DataPoint[],
        visible: true,
      },
    ];
    // Full span sees peak 30
    expect(computeStackedMountainYExtentsForAxis(series, 'y')).toEqual({ yMin: 0, yMax: 30 });
    // Zoom to x∈[0,0] only → composition tops at 3
    expect(computeStackedMountainYExtentsForAxis(series, 'y', { xWindow: { min: 0, max: 0 } })).toEqual({
      yMin: 0,
      yMax: 3,
    });
    // Zoom that excludes x=1 → still only tops at 3
    expect(computeStackedMountainYExtentsForAxis(series, 'y', { xWindow: { min: 1.5, max: 2.5 } })).toEqual({
      yMin: 0,
      yMax: 3,
    });
    // Zoom that includes only the tall sample
    expect(computeStackedMountainYExtentsForAxis(series, 'y', { xWindow: { min: 0.5, max: 1.5 } })).toEqual({
      yMin: 0,
      yMax: 30,
    });
  });
});

describe('resolveStackedMountainDataView', () => {
  it('filters gaps when connectNulls so baselines match pack/hit view', () => {
    const withGaps = [[0, 1], null, [2, 3], null, [4, 5]] as unknown as DataPoint[];
    const series = {
      type: 'line' as const,
      sampling: 'none' as const,
      connectNulls: true,
      data: withGaps,
      rawData: withGaps,
    };
    const view = resolveStackedMountainDataView(series);
    const expected = filterGaps(withGaps);
    expect(view).toEqual(expected);
    expect(view).toHaveLength(3);

    // Stack composition on filtered view is dense index-aligned
    const withGaps1 = [[0, 2], null, [2, 4], null, [4, 6]] as unknown as DataPoint[];
    const layers = [
      { seriesIndex: 0, data: resolveStackedMountainDataView(series) },
      {
        seriesIndex: 1,
        data: resolveStackedMountainDataView({
          ...series,
          data: withGaps1,
          rawData: withGaps1,
        }),
      },
    ];
    const geos = computeStackedAreaBaselines(layers);
    expect(geos[0]!.yTop[0]).toBe(1);
    expect(geos[1]!.yTop[0]).toBe(3); // 1+2
    expect(geos[1]!.yTop[1]).toBe(7); // 3+4 at filtered index 1 (x=2)
    expect(geos[1]!.yTop[2]).toBe(11); // 5+6 at filtered index 2 (x=4)
  });
});
