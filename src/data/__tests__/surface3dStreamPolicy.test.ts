/**
 * Multi-layer stream + setOption policy (pure helpers + domain).
 * Coordinator uses shouldClearSurfaceStream — tests must call that function, not inline.
 */
import { describe, it, expect } from 'vitest';
import {
  applySurface3DAppendColumns,
  applySurface3DReplaceY,
  computeSurface3DDomain,
  shouldClearSurfaceStream,
} from '../surface3dStream';

describe('surface stream domain after updates', () => {
  it('computeSurface3DDomain ignores NaN and finds finite extent', () => {
    const y = new Float32Array([Number.NaN, 1, 4, Number.NaN, 2]);
    const d = computeSurface3DDomain(y, 5);
    expect(d.yMin).toBe(1);
    expect(d.yMax).toBe(4);
  });

  it('after appendColumns scroll, auto domain tracks new heights', () => {
    const columns = 4;
    const rows = 2;
    const y = new Float32Array(columns * rows).fill(0);
    const data = {
      xStart: 0,
      xStep: 1,
      zStart: 0,
      zStep: 1,
      columns,
      rows,
      y,
    };
    const col = new Float32Array([10, 20]);
    const r = applySurface3DAppendColumns(data, {
      mode: 'appendColumns',
      columns: 1,
      y: col,
      scrollX: true,
    });
    expect(r.recomputeDomain).toBe(true);
    const domain = computeSurface3DDomain(r.data.y, columns * rows);
    expect(domain.yMax).toBe(20);
    expect(domain.yMin).toBe(0);
  });

  it('replaceY with explicit domain does not need recompute when both set', () => {
    const y = new Float32Array(4).fill(1);
    const data = {
      xStart: 0,
      xStep: 1,
      zStart: 0,
      zStep: 1,
      columns: 2,
      rows: 2,
      y,
    };
    const r = applySurface3DReplaceY(data, {
      mode: 'replaceY',
      y: new Float32Array([0, 1, 2, 3]),
      yMin: 0,
      yMax: 10,
    });
    expect(r.recomputeDomain).toBe(false);
    expect(r.yMin).toBe(0);
    expect(r.yMax).toBe(10);
  });
});

describe('shouldClearSurfaceStream (setOption identity policy)', () => {
  const makeData = (yFill = 0) => ({
    xStart: 0,
    xStep: 1,
    zStart: 0,
    zStep: 1,
    columns: 2,
    rows: 2,
    y: new Float32Array(4).fill(yFill),
  });

  it('does not clear on first seed (prevUser null)', () => {
    const next = makeData();
    expect(shouldClearSurfaceStream(null, next)).toBe(false);
    expect(shouldClearSurfaceStream(undefined, next)).toBe(false);
  });

  it('does not clear when next data is null', () => {
    const prev = makeData();
    expect(shouldClearSurfaceStream(prev, null)).toBe(false);
    expect(shouldClearSurfaceStream(prev, undefined)).toBe(false);
  });

  it('keeps stream when style setOption reuses same data ref', () => {
    const userData = makeData();
    // Stream may have scrolled xStart — identity policy is only about user data ref.
    expect(shouldClearSurfaceStream(userData, userData)).toBe(false);
  });

  it('clears stream when user supplies new data identity (post-scroll)', () => {
    const userData = makeData(0);
    const fresh = makeData(0);
    expect(shouldClearSurfaceStream(userData, fresh)).toBe(true);
  });

  it('coordinator-style apply: keep then clear', () => {
    const userData = makeData();
    let stream: ReturnType<typeof makeData> | null = {
      ...userData,
      xStart: 3,
      y: new Float32Array([1, 2, 3, 4]),
    };
    let lastUser: ReturnType<typeof makeData> | null = userData;

    // Style-only setOption reuses userData
    if (shouldClearSurfaceStream(lastUser, userData)) {
      stream = null;
    }
    lastUser = userData;
    expect(stream).not.toBeNull();
    expect(stream!.xStart).toBe(3);

    // New data identity after scroll
    const fresh = makeData(9);
    if (shouldClearSurfaceStream(lastUser, fresh)) {
      stream = null;
    }
    lastUser = fresh;
    expect(stream).toBeNull();
    expect(lastUser.y[0]).toBe(9);
  });
});
