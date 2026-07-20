import { describe, it, expect } from 'vitest';
import { resolveHeatmapTooltipParams } from '../heatmapTooltip';
import type { HeatmapTooltipSeries } from '../heatmapTooltip';

function series(overrides: Partial<HeatmapTooltipSeries> = {}): HeatmapTooltipSeries {
  return {
    name: 'H',
    data: {
      xStart: 0,
      xStep: 1,
      yStart: 0,
      yStep: 1,
      columns: 2,
      rows: 2,
      z: new Float32Array([1, 2, Number.NaN, 4]),
    },
    cellAnchor: 'corner',
    nullHandling: 'transparent',
    zMin: 0,
    zMax: 4,
    zScale: 'linear',
    colormap: 'viridis',
    drawable: true,
    visible: true,
    ...overrides,
  };
}

describe('resolveHeatmapTooltipParams', () => {
  it('returns hit for finite cell with hard fields', () => {
    const p = resolveHeatmapTooltipParams(series(), 0, 0.5, 0.5);
    expect(p).not.toBeNull();
    expect(p!.dataIndex).toBe(0);
    expect(p!.z).toBe(1);
    expect(p!.value[0]).toBeCloseTo(0.5, 6);
    expect(p!.value[1]).toBeCloseTo(0.5, 6);
    expect(p!.seriesIndex).toBe(0);
  });

  it('transparent + NaN cell → null (miss)', () => {
    // cell (0,1) has NaN
    const p = resolveHeatmapTooltipParams(series({ nullHandling: 'transparent' }), 0, 0.5, 1.5);
    expect(p).toBeNull();
  });

  it('lowest + NaN cell still returns params (visible via null policy)', () => {
    const p = resolveHeatmapTooltipParams(series({ nullHandling: 'lowest' }), 0, 0.5, 1.5);
    expect(p).not.toBeNull();
    expect(Number.isNaN(p!.z)).toBe(true);
    expect(p!.dataIndex).toBe(2);
  });

  it('out of grid → null', () => {
    expect(resolveHeatmapTooltipParams(series(), 0, -1, 0.5)).toBeNull();
  });

  it('visible false → null', () => {
    expect(resolveHeatmapTooltipParams(series({ visible: false }), 0, 0.5, 0.5)).toBeNull();
  });
});
