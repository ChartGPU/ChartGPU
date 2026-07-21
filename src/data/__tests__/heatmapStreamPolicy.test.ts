/**
 * Multi-layer stream + setOption policy (pure helpers + domain).
 * Coordinator uses shouldClearHeatmapStream — tests must call that function, not inline.
 */
import { describe, it, expect } from 'vitest';
import {
  applyHeatmapAppendColumns,
  applyHeatmapReplaceZ,
  computeHeatmapStreamDomain,
  resolveHeatmapStreamDomainOverride,
  shouldClearHeatmapStream,
} from '../heatmapStream';
import { heatmapGridBounds } from '../../utils/heatmapLayout';
import { heatmapHitTest } from '../../utils/heatmapLayout';

describe('heatmap stream domain after updates', () => {
  it('computeHeatmapStreamDomain ignores NaN and finds finite extent', () => {
    const z = new Float32Array([Number.NaN, 1, 4, Number.NaN, 2]);
    const d = computeHeatmapStreamDomain(z, 5);
    expect(d.zMin).toBe(1);
    expect(d.zMax).toBe(4);
  });

  it('after appendColumns scroll, auto domain tracks new heights', () => {
    const columns = 4;
    const rows = 2;
    const z = new Float32Array(columns * rows).fill(0);
    const data = {
      xStart: 0,
      xStep: 1,
      yStart: 0,
      yStep: 1,
      columns,
      rows,
      z,
    };
    const col = new Float32Array([10, 20]);
    const r = applyHeatmapAppendColumns(data, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: true,
    });
    expect(r.recomputeDomain).toBe(false);
    const domain = computeHeatmapStreamDomain(r.data.z, columns * rows);
    expect(domain.zMax).toBe(20);
    expect(domain.zMin).toBe(0);
  });

  it('replaceZ with explicit domain does not need recompute when both set', () => {
    const z = new Float32Array(4).fill(1);
    const data = {
      xStart: 0,
      xStep: 1,
      yStart: 0,
      yStep: 1,
      columns: 2,
      rows: 2,
      z,
    };
    const r = applyHeatmapReplaceZ(data, {
      mode: 'replaceZ',
      z: new Float32Array([0, 1, 2, 3]),
      zMin: 0,
      zMax: 10,
    });
    expect(r.recomputeDomain).toBe(false);
    expect(r.zMin).toBe(0);
    expect(r.zMax).toBe(10);
  });
});

describe('shouldClearHeatmapStream (setOption identity policy)', () => {
  const makeData = (zFill = 0) => ({
    xStart: 0,
    xStep: 1,
    yStart: 0,
    yStep: 1,
    columns: 2,
    rows: 2,
    z: new Float32Array(4).fill(zFill),
  });

  it('does not clear on first seed (prevUser null)', () => {
    const next = makeData();
    expect(shouldClearHeatmapStream(null, next)).toBe(false);
    expect(shouldClearHeatmapStream(undefined, next)).toBe(false);
  });

  it('does not clear when next data is null', () => {
    const prev = makeData();
    expect(shouldClearHeatmapStream(prev, null)).toBe(false);
    expect(shouldClearHeatmapStream(prev, undefined)).toBe(false);
  });

  it('keeps stream when style setOption reuses same data ref', () => {
    const userData = makeData();
    expect(shouldClearHeatmapStream(userData, userData)).toBe(false);
  });

  it('clears stream when user supplies new data identity (post-scroll)', () => {
    const userData = makeData(0);
    const fresh = makeData(0);
    expect(shouldClearHeatmapStream(userData, fresh)).toBe(true);
  });

  it('coordinator-style apply: keep then clear', () => {
    const userData = makeData();
    let stream: ReturnType<typeof makeData> | null = {
      ...userData,
      xStart: 3,
      z: new Float32Array([1, 2, 3, 4]),
    };
    let lastUser: ReturnType<typeof makeData> | null = userData;

    if (shouldClearHeatmapStream(lastUser, userData)) {
      stream = null;
    }
    lastUser = userData;
    expect(stream).not.toBeNull();
    expect(stream!.xStart).toBe(3);

    const fresh = makeData(9);
    if (shouldClearHeatmapStream(lastUser, fresh)) {
      stream = null;
    }
    lastUser = fresh;
    expect(stream).toBeNull();
    expect(lastUser.z[0]).toBe(9);
  });
});

describe('resolveHeatmapStreamDomainOverride (D5 + style setOption)', () => {
  const base = {
    xStart: 0,
    xStep: 1,
    yStart: 0,
    yStep: 1,
    columns: 4,
    rows: 2,
    z: new Float32Array(8).fill(0),
  };

  it('keeps user-explicit domain (no expand-from-strip)', () => {
    const col = new Float32Array([500, 600]);
    const result = applyHeatmapAppendColumns(base, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: true,
    });
    const domain = resolveHeatmapStreamDomainOverride({
      zDomainExplicit: true,
      seriesZMin: -100,
      seriesZMax: 0,
      prevOverride: null,
      result,
      update: { mode: 'appendColumns', columns: 1, z: col, scrollX: true },
    });
    expect(domain).toBeNull(); // series zMin/zMax apply
  });

  it('auto domain expands from strip', () => {
    const col = new Float32Array([10, 20]);
    const result = applyHeatmapAppendColumns(base, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: true,
    });
    const domain = resolveHeatmapStreamDomainOverride({
      zDomainExplicit: false,
      seriesZMin: 0,
      seriesZMax: 1,
      prevOverride: { zMin: 0, zMax: 1 },
      result,
      update: { mode: 'appendColumns', columns: 1, z: col, scrollX: true },
    });
    expect(domain).toEqual({ zMin: 0, zMax: 20 });
  });

  it('replaceZ explicit locks domain', () => {
    const result = applyHeatmapReplaceZ(base, {
      mode: 'replaceZ',
      z: new Float32Array(8).fill(1),
      zMin: -50,
      zMax: 50,
    });
    const domain = resolveHeatmapStreamDomainOverride({
      zDomainExplicit: false,
      seriesZMin: 0,
      seriesZMax: 1,
      prevOverride: null,
      result,
      update: { mode: 'replaceZ', z: new Float32Array(8), zMin: -50, zMax: 50 },
    });
    expect(domain).toEqual({ zMin: -50, zMax: 50 });
  });

  it('coordinator-style: stream keep + style zDomainExplicit clears override', () => {
    // Auto expand establishes a prior domain override, then style setOption with
    // zDomainExplicit re-resolves domain via production helper while stream field is kept.
    const col = new Float32Array([10, 20]);
    const scrolled = applyHeatmapAppendColumns(base, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: true,
    });
    const autoOverride = resolveHeatmapStreamDomainOverride({
      zDomainExplicit: false,
      seriesZMin: 0,
      seriesZMax: 1,
      prevOverride: { zMin: 0, zMax: 1 },
      result: scrolled,
      update: { mode: 'appendColumns', columns: 1, z: col, scrollX: true },
    });
    expect(autoOverride).toEqual({ zMin: 0, zMax: 20 });

    const userData = base;
    // Style setOption reuses the same data identity → stream not cleared
    expect(shouldClearHeatmapStream(userData, userData)).toBe(false);
    expect(scrolled.data.xStart).toBe(1);

    // Style supplies explicit domain: production override resolves to null
    // (coordinator clears heatmapDomainByIndex so series zMin/zMax apply).
    const afterStyle = resolveHeatmapStreamDomainOverride({
      zDomainExplicit: true,
      seriesZMin: -100,
      seriesZMax: 0,
      prevOverride: autoOverride,
      result: scrolled,
      update: { mode: 'appendColumns', columns: 1, z: col, scrollX: true },
    });
    expect(afterStyle).toBeNull();
    // Stream field still holds scrolled window
    expect(scrolled.data.xStart).toBe(1);
    expect(scrolled.data.z[0 * 4 + 3]).toBe(10);
  });
});

describe('hit-test multi-layer consistency after scroll', () => {
  it('logical CPU z after N scrolls matches hit-test cell values', () => {
    const columns = 4;
    const rows = 2;
    let data = {
      xStart: 0,
      xStep: 1,
      yStart: 0,
      yStep: 1,
      columns,
      rows,
      z: new Float32Array(columns * rows).fill(0),
    };
    // Append three columns with distinctive values
    for (let n = 0; n < 3; n++) {
      const col = new Float32Array([100 + n, 200 + n]);
      const r = applyHeatmapAppendColumns(data, {
        mode: 'appendColumns',
        columns: 1,
        z: col,
        scrollX: true,
      });
      data = {
        xStart: r.data.xStart,
        xStep: r.data.xStep,
        yStart: r.data.yStart,
        yStep: r.data.yStep,
        columns: r.data.columns,
        rows: r.data.rows,
        z: r.data.z as Float32Array,
      };
    }
    // After 3 scrolls, xStart = 3; newest column logical index 3 has values 102, 202
    expect(data.xStart).toBe(3);
    expect(data.z[0 * 4 + 3]).toBe(102);
    expect(data.z[1 * 4 + 3]).toBe(202);

    const bounds = heatmapGridBounds(data, 'corner');
    expect(bounds.xMin).toBe(3);
    expect(bounds.xMax).toBe(7);

    // Hit newest cell center (logical col 3): x = xStart + 3.5 = 6.5, y = 0.5
    const hit = heatmapHitTest(data, 6.5, 0.5, 'corner');
    expect(hit).not.toBeNull();
    expect(hit!.i).toBe(3);
    expect(hit!.j).toBe(0);
    expect(hit!.z).toBe(102);
  });
});
