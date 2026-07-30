/**
 * Multi-layer surface stream policy truth tables (domain / AABB / contours / setOption).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveReplaceYAABBYextent,
  resolveSurfaceDomainAction,
  reuseReplaceYAABB,
  shouldClearSurfaceDomainOnSetOption,
  shouldExpandStripDomain,
  shouldInvalidateSurfaceContoursOnReplaceY,
  shouldWalkSurfaceDomain,
} from '../surface3dStreamPolicy';
import { applySurface3DReplaceY, applySurface3DAppendColumns } from '../surface3dStream';

const grid2x2 = (y: Float32Array) => ({
  xStart: 0,
  xStep: 1,
  zStart: 0,
  zStep: 1,
  columns: 2,
  rows: 2,
  y,
});

describe('shouldWalkSurfaceDomain', () => {
  it.each([
    { recomputeDomain: true, yDomainExplicit: false, walk: true },
    { recomputeDomain: true, yDomainExplicit: true, walk: false },
    { recomputeDomain: false, yDomainExplicit: false, walk: false },
    { recomputeDomain: false, yDomainExplicit: true, walk: false },
  ])('recompute=$recomputeDomain explicit=$yDomainExplicit → walk=$walk', (c) => {
    expect(shouldWalkSurfaceDomain(c)).toBe(c.walk);
  });
});

describe('shouldExpandStripDomain', () => {
  it('allows single-column scroll when domain not explicit', () => {
    expect(
      shouldExpandStripDomain({
        mode: 'appendColumns',
        scrollX: true,
        columns: 1,
        recomputeDomain: false,
        yDomainExplicit: false,
      })
    ).toBe(true);
  });

  it('blocks strip expand when yDomainExplicit', () => {
    expect(
      shouldExpandStripDomain({
        mode: 'appendColumns',
        scrollX: true,
        columns: 1,
        recomputeDomain: false,
        yDomainExplicit: true,
      })
    ).toBe(false);
  });

  it('blocks multi-column / recompute / replaceY', () => {
    expect(
      shouldExpandStripDomain({
        mode: 'appendColumns',
        columns: 2,
        recomputeDomain: false,
        yDomainExplicit: false,
      })
    ).toBe(false);
    expect(
      shouldExpandStripDomain({
        mode: 'replaceY',
        recomputeDomain: false,
        yDomainExplicit: false,
      })
    ).toBe(false);
  });
});

describe('shouldInvalidateSurfaceContoursOnReplaceY', () => {
  it.each([
    { mode: 'replaceY' as const, contoursShow: true, inv: true },
    { mode: 'replaceY' as const, contoursShow: false, inv: false },
    { mode: 'appendColumns' as const, contoursShow: true, inv: false },
    { mode: 'appendRows' as const, contoursShow: true, inv: false },
  ])('mode=$mode show=$contoursShow → $inv', (c) => {
    expect(shouldInvalidateSurfaceContoursOnReplaceY(c)).toBe(c.inv);
  });
});

describe('resolveReplaceYAABBYextent + reuseReplaceYAABB', () => {
  it('prefers update domain, then stream domain, then series explicit', () => {
    expect(
      resolveReplaceYAABBYextent({
        resultYMin: -1,
        resultYMax: 1,
        streamDomain: { yMin: 0, yMax: 2 },
        yDomainExplicit: true,
        seriesYMin: -0.4,
        seriesYMax: 0.4,
      })
    ).toEqual({ yMin: -1, yMax: 1 });

    expect(
      resolveReplaceYAABBYextent({
        streamDomain: { yMin: 0, yMax: 2 },
        yDomainExplicit: false,
        seriesYMin: -0.4,
        seriesYMax: 0.4,
      })
    ).toEqual({ yMin: 0, yMax: 2 });

    expect(
      resolveReplaceYAABBYextent({
        streamDomain: null,
        yDomainExplicit: true,
        seriesYMin: -0.4,
        seriesYMax: 0.4,
      })
    ).toEqual({ yMin: -0.4, yMax: 0.4 });

    expect(
      resolveReplaceYAABBYextent({
        streamDomain: null,
        yDomainExplicit: false,
        seriesYMin: 0,
        seriesYMax: 1,
      })
    ).toBeNull();
  });

  it('reuseReplaceYAABB keeps prior XZ and applies domain Y', () => {
    const prev = {
      min: [0, -10, 2] as [number, number, number],
      max: [10, 10, 12] as [number, number, number],
    };
    const data = { tag: 'd' };
    const y = new Float32Array(4);
    const next = reuseReplaceYAABB(prev, { yMin: -0.4, yMax: 0.4 }, data, y);
    expect(next).not.toBeNull();
    expect(next!.data).toBe(data);
    expect(next!.y).toBe(y);
    expect(next!.aabb.min).toEqual([0, -0.4, 2]);
    expect(next!.aabb.max).toEqual([10, 0.4, 12]);
  });

  it('reuseReplaceYAABB returns null without prev or Y extent', () => {
    expect(reuseReplaceYAABB(null, { yMin: 0, yMax: 1 }, {}, null)).toBeNull();
    expect(reuseReplaceYAABB({ min: [0, 0, 0], max: [1, 1, 1] }, null, {}, null)).toBeNull();
  });
});

describe('shouldClearSurfaceDomainOnSetOption', () => {
  const prevAuto = { yDomainExplicit: false, yMin: 0, yMax: 1 };
  const prevExplicit = { yDomainExplicit: true, yMin: -0.4, yMax: 0.4 };

  it.each([
    {
      label: 'stream teardown always clears',
      streamCleared: true,
      yDomainExplicit: true,
      seriesYMin: -0.4,
      seriesYMax: 0.4,
      prev: prevExplicit,
      clear: true,
    },
    {
      label: 'stream teardown clears even when auto',
      streamCleared: true,
      yDomainExplicit: false,
      seriesYMin: 0,
      seriesYMax: 1,
      prev: prevAuto,
      clear: true,
    },
    {
      label: 'auto→explicit clears stale auto stream override',
      streamCleared: false,
      yDomainExplicit: true,
      seriesYMin: -0.4,
      seriesYMax: 0.4,
      prev: prevAuto,
      clear: true,
    },
    {
      label: 'already explicit style-only keeps update-level domain',
      streamCleared: false,
      yDomainExplicit: true,
      seriesYMin: -0.4,
      seriesYMax: 0.4,
      prev: prevExplicit,
      clear: false,
    },
    {
      label: 'explicit yMin/yMax retune clears stream domain',
      streamCleared: false,
      yDomainExplicit: true,
      seriesYMin: -1,
      seriesYMax: 1,
      prev: prevExplicit,
      clear: true,
    },
    {
      label: 'auto style-only same domain keeps stream',
      streamCleared: false,
      yDomainExplicit: false,
      seriesYMin: 0,
      seriesYMax: 1,
      prev: prevAuto,
      clear: false,
    },
    {
      label: 'first seed (prev null) does not clear solely for explicit',
      streamCleared: false,
      yDomainExplicit: true,
      seriesYMin: -0.4,
      seriesYMax: 0.4,
      prev: null,
      clear: false,
    },
    {
      label: 'auto domain value shift clears',
      streamCleared: false,
      yDomainExplicit: false,
      seriesYMin: 0,
      seriesYMax: 2,
      prev: prevAuto,
      clear: true,
    },
  ])('$label → clear=$clear', (c) => {
    expect(
      shouldClearSurfaceDomainOnSetOption({
        streamCleared: c.streamCleared,
        yDomainExplicit: c.yDomainExplicit,
        seriesYMin: c.seriesYMin,
        seriesYMax: c.seriesYMax,
        prev: c.prev,
      })
    ).toBe(c.clear);
  });
});

describe('resolveSurfaceDomainAction integration with apply*', () => {
  it('replaceY without update domain + yDomainExplicit → clearToSeriesExplicit', () => {
    const y = new Float32Array(4).fill(1);
    const r = applySurface3DReplaceY(grid2x2(y), { mode: 'replaceY', y: new Float32Array(4).fill(2) });
    expect(r.recomputeDomain).toBe(true);
    expect(resolveSurfaceDomainAction({ mode: 'replaceY', y: r.data.y }, r, true)).toEqual({
      kind: 'clearToSeriesExplicit',
    });
    expect(resolveSurfaceDomainAction({ mode: 'replaceY', y: r.data.y }, r, false).kind).toBe('autoFull');
  });

  it('replaceY with update yMin/yMax → setFromUpdate', () => {
    const y = new Float32Array(4);
    const r = applySurface3DReplaceY(grid2x2(y), {
      mode: 'replaceY',
      y: new Float32Array(4),
      yMin: -1,
      yMax: 5,
    });
    expect(resolveSurfaceDomainAction({ mode: 'replaceY', y: r.data.y, yMin: -1, yMax: 5 }, r, false)).toEqual({
      kind: 'setFromUpdate',
      yMin: -1,
      yMax: 5,
    });
  });

  it('single-column append + explicit domain does not expandStrip', () => {
    const y = new Float32Array(8).fill(0);
    const data = {
      xStart: 0,
      xStep: 1,
      zStart: 0,
      zStep: 1,
      columns: 4,
      rows: 2,
      y,
    };
    const r = applySurface3DAppendColumns(data, {
      mode: 'appendColumns',
      columns: 1,
      y: new Float32Array([9, 10]),
      scrollX: true,
    });
    expect(r.recomputeDomain).toBe(false);
    const update = {
      mode: 'appendColumns' as const,
      columns: 1,
      y: new Float32Array([9, 10]),
      scrollX: true,
    };
    expect(resolveSurfaceDomainAction(update, r, false).kind).toBe('expandStrip');
    expect(resolveSurfaceDomainAction(update, r, true).kind).toBe('noop');
  });
});
