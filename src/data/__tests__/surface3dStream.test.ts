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
