import { describe, it, expect } from 'vitest';
import {
  applySurface3DReplaceY,
  applySurface3DAppendColumns,
  applySurface3DAppendRows,
  applySurface3DUpdate,
} from '../surface3dStream';

const baseGrid = () => {
  const columns = 4;
  const rows = 3;
  const y = new Float32Array(columns * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      y[j * columns + i] = i + j * 10;
    }
  }
  return {
    xStart: 0,
    xStep: 1,
    zStart: 0,
    zStep: 1,
    columns,
    rows,
    y,
  };
};

describe('surface3dStream', () => {
  it('replaceY swaps full field row-major', () => {
    const g = baseGrid();
    const next = new Float32Array(12).fill(9);
    const r = applySurface3DReplaceY(g, { mode: 'replaceY', y: next });
    expect(r.dimsChanged).toBe(false);
    expect(r.data.y[0]).toBe(9);
    expect(r.data.columns).toBe(4);
    expect(r.data.rows).toBe(3);
  });

  it('appendColumns scrollX advances xStart and keeps columns', () => {
    const g = baseGrid();
    // One new column, column-major strip of length rows=3
    const col = new Float32Array([100, 101, 102]);
    const r = applySurface3DAppendColumns(g, { mode: 'appendColumns', columns: 1, y: col, scrollX: true });
    expect(r.data.columns).toBe(4);
    expect(r.data.xStart).toBe(1);
    expect(r.scrolled).toBe(true);
    // New column at end (column index 3): heights 100,101,102
    expect(r.data.y[0 * 4 + 3]).toBe(100);
    expect(r.data.y[1 * 4 + 3]).toBe(101);
    expect(r.data.y[2 * 4 + 3]).toBe(102);
    // Oldest column 0 dropped; former col1 is now col0
    expect(r.data.y[0 * 4 + 0]).toBe(1);
  });

  it('appendColumns without scroll grows width', () => {
    const g = baseGrid();
    const col = new Float32Array([7, 8, 9]);
    const r = applySurface3DAppendColumns(g, {
      mode: 'appendColumns',
      columns: 1,
      y: col,
      scrollX: false,
    });
    expect(r.data.columns).toBe(5);
    expect(r.dimsChanged).toBe(true);
    expect(r.data.xStart).toBe(0);
    expect(r.data.y[0 * 5 + 4]).toBe(7);
  });

  it('appendColumns batch >= window replaces with tail', () => {
    const g = baseGrid();
    // 5 columns of new data, window is 4 → keep last 4
    const y = new Float32Array(5 * 3);
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 3; r++) y[c * 3 + r] = c * 10 + r;
    }
    const r = applySurface3DAppendColumns(g, {
      mode: 'appendColumns',
      columns: 5,
      y,
      scrollX: true,
    });
    expect(r.data.columns).toBe(4);
    // Tail columns c=1..4 of batch → field cols 0..3
    expect(r.data.y[0 * 4 + 0]).toBe(10);
    expect(r.data.y[0 * 4 + 3]).toBe(40);
  });

  it('appendRows scrollZ advances zStart', () => {
    const g = baseGrid();
    const row = new Float32Array([1, 2, 3, 4]); // one row, length columns
    const r = applySurface3DAppendRows(g, { mode: 'appendRows', rows: 1, y: row, scrollZ: true });
    expect(r.data.rows).toBe(3);
    expect(r.data.zStart).toBe(1);
    expect(r.data.y[2 * 4 + 0]).toBe(1);
  });

  it('applySurface3DUpdate dispatches modes', () => {
    const g = baseGrid();
    const r = applySurface3DUpdate(g, { mode: 'replaceY', y: new Float32Array(12).fill(0) });
    expect(r.data.y[0]).toBe(0);
  });

  it('preserves NaN holes (does not coerce to 0)', () => {
    const g = baseGrid();
    const next = new Float32Array(12);
    next[0] = Number.NaN;
    next[1] = 3;
    const r = applySurface3DReplaceY(g, { mode: 'replaceY', y: next });
    expect(Number.isNaN(r.data.y[0])).toBe(true);
    expect(r.data.y[1]).toBe(3);
  });

  it('replaceY passes explicit yMin/yMax and sets recomputeDomain when missing', () => {
    const g = baseGrid();
    const r = applySurface3DReplaceY(g, {
      mode: 'replaceY',
      y: new Float32Array(12).fill(2),
      yMin: -1,
      yMax: 5,
    });
    expect(r.yMin).toBe(-1);
    expect(r.yMax).toBe(5);
    expect(r.recomputeDomain).toBe(false);

    const r2 = applySurface3DReplaceY(g, { mode: 'replaceY', y: new Float32Array(12).fill(2) });
    expect(r2.recomputeDomain).toBe(true);
  });

  it('replaceY zero-copies full Float32Array identity (no allocate/copy)', () => {
    const g = baseGrid();
    const next = new Float32Array(12);
    for (let i = 0; i < 12; i++) next[i] = i * 0.5;
    const r = applySurface3DReplaceY(g, { mode: 'replaceY', y: next });
    expect(r.data.y).toBe(next);
    // Always a new data shell so renderer identity gates fire even when y is stable.
    expect(r.data).not.toBe(g);
    // In-place mutation of the retained buffer is visible on the stream result.
    next[0] = 99;
    expect(r.data.y[0]).toBe(99);
  });

  it('replaceY zero-copies via subarray when Float32Array is longer than n', () => {
    const g = baseGrid();
    const next = new Float32Array(20);
    next[0] = 7;
    next[11] = 8;
    const r = applySurface3DReplaceY(g, { mode: 'replaceY', y: next });
    expect(r.data.y).toBeInstanceOf(Float32Array);
    expect(r.data.y.length).toBe(12);
    expect(r.data.y[0]).toBe(7);
    expect(r.data.y[11]).toBe(8);
    // View shares the underlying buffer
    expect((r.data.y as Float32Array).buffer).toBe(next.buffer);
  });

  it('replaceY coerces non-Float32 into targetY scratch without allocating when large enough', () => {
    const g = baseGrid();
    const scratch = new Float32Array(12);
    const r = applySurface3DReplaceY(
      g,
      { mode: 'replaceY', y: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
      { targetY: scratch }
    );
    expect(r.data.y).toBe(scratch);
    expect(r.data.y[0]).toBe(1);
    expect(r.data.y[11]).toBe(12);
  });

  it('replaceY short payload pads with NaN and does not retain caller short array', () => {
    const g = baseGrid();
    const short = new Float32Array([1, 2, 3]); // length < 12 — cannot zero-copy
    const r = applySurface3DReplaceY(g, { mode: 'replaceY', y: short });
    expect(r.data.y).not.toBe(short);
    expect(r.data.y.length).toBe(12);
    expect(r.data.y[0]).toBe(1);
    expect(Number.isNaN(r.data.y[3])).toBe(true);
  });

  it('replaceY Float64Array is not zero-copy (coerce path)', () => {
    const g = baseGrid();
    const f64 = new Float64Array(12);
    f64[0] = 3.5;
    const r = applySurface3DReplaceY(g, { mode: 'replaceY', y: f64 as unknown as ArrayLike<number> });
    expect(r.data.y).not.toBe(f64 as unknown as Float32Array);
    expect(r.data.y).toBeInstanceOf(Float32Array);
    expect(r.data.y[0]).toBe(3.5);
  });

  it('replaceY targetY longer than n uses subarray view of scratch', () => {
    const g = baseGrid();
    const scratch = new Float32Array(20);
    const r = applySurface3DReplaceY(
      g,
      { mode: 'replaceY', y: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
      { targetY: scratch }
    );
    expect(r.data.y.length).toBe(12);
    expect((r.data.y as Float32Array).buffer).toBe(scratch.buffer);
    expect(r.data.y[0]).toBe(1);
  });

  it('replaceY targetY shorter than n allocates a fresh buffer', () => {
    const g = baseGrid();
    const tiny = new Float32Array(4);
    const r = applySurface3DReplaceY(
      g,
      { mode: 'replaceY', y: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
      { targetY: tiny }
    );
    expect(r.data.y).not.toBe(tiny);
    expect(r.data.y.length).toBe(12);
    expect(r.data.y[11]).toBe(12);
  });

  it('replaceY zero-copy ignores targetY scratch', () => {
    const g = baseGrid();
    const next = new Float32Array(12).fill(4);
    const scratch = new Float32Array(12).fill(-1);
    const r = applySurface3DReplaceY(g, { mode: 'replaceY', y: next }, { targetY: scratch });
    expect(r.data.y).toBe(next);
    expect(r.data.y).not.toBe(scratch);
  });

  it('applySurface3DUpdate passes replaceY options through', () => {
    const g = baseGrid();
    const scratch = new Float32Array(12);
    const r = applySurface3DUpdate(
      g,
      { mode: 'replaceY', y: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
      { targetY: scratch }
    );
    expect(r.data.y).toBe(scratch);
    expect(r.data.y[5]).toBe(5);
  });

  it('coerce path turns Infinity into NaN; zero-copy keeps Infinity', () => {
    const g = baseGrid();
    const arr = new Array(12).fill(0);
    arr[0] = Number.POSITIVE_INFINITY;
    const coerced = applySurface3DReplaceY(g, { mode: 'replaceY', y: arr });
    expect(Number.isNaN(coerced.data.y[0])).toBe(true);

    const f32 = new Float32Array(12);
    f32[0] = Number.POSITIVE_INFINITY;
    const zc = applySurface3DReplaceY(g, { mode: 'replaceY', y: f32 });
    expect(zc.data.y).toBe(f32);
    expect(zc.data.y[0]).toBe(Number.POSITIVE_INFINITY);
  });

  it('coerce path maps non-finite Number values to NaN holes', () => {
    const g = baseGrid();
    const r = applySurface3DReplaceY(g, {
      mode: 'replaceY',
      y: [1, Number.NaN, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    });
    expect(r.data.y[0]).toBe(1);
    expect(Number.isNaN(r.data.y[1])).toBe(true);
  });

  it('appendColumns single-column scroll uses cheap domain expand path', () => {
    const g = baseGrid();
    const col = new Float32Array([100, 101, 102]);
    // Single-column spectrogram scroll: coordinator expands domain from the new strip
    // (recomputeDomain false). Multi-column still requests full recompute.
    const r = applySurface3DAppendColumns(g, { mode: 'appendColumns', columns: 1, y: col, scrollX: true });
    expect(r.recomputeDomain).toBe(false);
    expect(r.scrolled).toBe(true);

    const multi = applySurface3DAppendColumns(g, {
      mode: 'appendColumns',
      columns: 2,
      y: new Float32Array(6).fill(3),
      scrollX: true,
    });
    expect(multi.recomputeDomain).toBe(true);
  });
});
