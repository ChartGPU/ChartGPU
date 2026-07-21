import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyHeatmapReplaceZ,
  applyHeatmapAppendColumns,
  applyHeatmapAppendRows,
  applyHeatmapUpdate,
  __resetHeatmapStreamWarnForTests,
} from '../heatmapStream';

beforeEach(() => {
  __resetHeatmapStreamWarnForTests();
});

const baseGrid = () => {
  const columns = 4;
  const rows = 3;
  const z = new Float32Array(columns * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      z[j * columns + i] = i + j * 10;
    }
  }
  return {
    xStart: 0,
    xStep: 1,
    yStart: 0,
    yStep: 1,
    columns,
    rows,
    z,
  };
};

describe('heatmapStream', () => {
  it('replaceZ swaps full field row-major', () => {
    const g = baseGrid();
    const next = new Float32Array(12).fill(9);
    const r = applyHeatmapReplaceZ(g, { mode: 'replaceZ', z: next });
    expect(r.dimsChanged).toBe(false);
    expect(r.data.z[0]).toBe(9);
    expect(r.data.columns).toBe(4);
    expect(r.data.rows).toBe(3);
    expect(r.ringAdvanceCols).toBe(0);
  });

  it('appendColumns scrollX advances xStart and keeps columns', () => {
    const g = baseGrid();
    const col = new Float32Array([100, 101, 102]);
    const r = applyHeatmapAppendColumns(g, { mode: 'appendColumns', columns: 1, z: col, scrollX: true });
    expect(r.data.columns).toBe(4);
    expect(r.data.xStart).toBe(1);
    expect(r.scrolled).toBe(true);
    expect(r.ringAdvanceCols).toBe(1);
    // New column at end (column index 3)
    expect(r.data.z[0 * 4 + 3]).toBe(100);
    expect(r.data.z[1 * 4 + 3]).toBe(101);
    expect(r.data.z[2 * 4 + 3]).toBe(102);
    // Oldest column 0 dropped; former col1 is now col0
    expect(r.data.z[0 * 4 + 0]).toBe(1);
  });

  it('appendColumns with negative xStep still advances xStart by drop * xStep', () => {
    const g = { ...baseGrid(), xStart: 10, xStep: -1 };
    const col = new Float32Array([7, 8, 9]);
    const r = applyHeatmapAppendColumns(g, { mode: 'appendColumns', columns: 1, z: col, scrollX: true });
    expect(r.data.xStart).toBe(9); // 10 + 1 * (-1)
    expect(r.data.columns).toBe(4);
  });

  it('appendColumns without scroll grows width', () => {
    const g = baseGrid();
    const col = new Float32Array([7, 8, 9]);
    const r = applyHeatmapAppendColumns(g, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: false,
    });
    expect(r.data.columns).toBe(5);
    expect(r.dimsChanged).toBe(true);
    expect(r.data.xStart).toBe(0);
    expect(r.data.z[0 * 5 + 4]).toBe(7);
    expect(r.ringAdvanceCols).toBe(0);
  });

  it('appendColumns batch >= window replaces with tail', () => {
    const g = baseGrid();
    const z = new Float32Array(5 * 3);
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 3; r++) z[c * 3 + r] = c * 10 + r;
    }
    const r = applyHeatmapAppendColumns(g, {
      mode: 'appendColumns',
      columns: 5,
      z,
      scrollX: true,
    });
    expect(r.data.columns).toBe(4);
    expect(r.data.z[0 * 4 + 0]).toBe(10);
    expect(r.data.z[0 * 4 + 3]).toBe(40);
    expect(r.ringAdvanceCols).toBe(0); // multi-col → full upload
  });

  it('appendRows scrollY advances yStart', () => {
    const g = baseGrid();
    const row = new Float32Array([1, 2, 3, 4]);
    const r = applyHeatmapAppendRows(g, { mode: 'appendRows', rows: 1, z: row, scrollY: true });
    expect(r.data.rows).toBe(3);
    expect(r.data.yStart).toBe(1);
    expect(r.data.z[2 * 4 + 0]).toBe(1);
  });

  it('appendRows without scroll grows height', () => {
    const g = baseGrid();
    const row = new Float32Array([9, 8, 7, 6]);
    const r = applyHeatmapAppendRows(g, { mode: 'appendRows', rows: 1, z: row, scrollY: false });
    expect(r.data.rows).toBe(4);
    expect(r.dimsChanged).toBe(true);
    expect(r.data.z[3 * 4 + 0]).toBe(9);
  });

  it('applyHeatmapUpdate dispatches modes', () => {
    const g = baseGrid();
    const r = applyHeatmapUpdate(g, { mode: 'replaceZ', z: new Float32Array(12).fill(0) });
    expect(r.data.z[0]).toBe(0);
    const c = applyHeatmapUpdate(g, {
      mode: 'appendColumns',
      columns: 1,
      z: new Float32Array([1, 2, 3]),
      scrollX: true,
    });
    expect(c.data.xStart).toBe(1);
    const rows = applyHeatmapUpdate(g, {
      mode: 'appendRows',
      rows: 1,
      z: new Float32Array([9, 8, 7, 6]),
      scrollY: true,
    });
    expect(rows.data.yStart).toBe(1);
  });

  it('appendColumns mid-batch (1 < addCols < oldCols) keeps head and appends tail', () => {
    const g = baseGrid(); // 4×3
    // Two new columns, column-major: col0=[10,11,12], col1=[20,21,22]
    const z = new Float32Array([10, 11, 12, 20, 21, 22]);
    const r = applyHeatmapAppendColumns(g, {
      mode: 'appendColumns',
      columns: 2,
      z,
      scrollX: true,
    });
    expect(r.data.columns).toBe(4);
    expect(r.data.xStart).toBe(2);
    // keep old cols 2,3 → field 0,1; new cols at 2,3
    expect(r.data.z[0 * 4 + 0]).toBe(2); // old col2
    expect(r.data.z[0 * 4 + 1]).toBe(3); // old col3
    expect(r.data.z[0 * 4 + 2]).toBe(10);
    expect(r.data.z[0 * 4 + 3]).toBe(20);
    expect(r.data.z[2 * 4 + 2]).toBe(12);
    expect(r.ringAdvanceCols).toBe(0);
  });

  it('appendRows short payload fills NaN; negative yStep advances yStart; immutability', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = { ...baseGrid(), yStart: 10, yStep: -1 };
    const snapshot = Float32Array.from(g.z);
    const row = new Float32Array([7, 8]); // short (need 4)
    const r = applyHeatmapAppendRows(g, { mode: 'appendRows', rows: 1, z: row, scrollY: true });
    expect(r.data.yStart).toBe(9); // 10 + 1*(-1)
    expect(r.data.z[2 * 4 + 0]).toBe(7);
    expect(r.data.z[2 * 4 + 1]).toBe(8);
    expect(Number.isNaN(r.data.z[2 * 4 + 2])).toBe(true);
    expect(Number.isNaN(r.data.z[2 * 4 + 3])).toBe(true);
    expect(Array.from(g.z)).toEqual(Array.from(snapshot));
    warn.mockRestore();
  });

  it('appendRows batch >= window keeps tail', () => {
    const g = baseGrid(); // 3 rows
    const z = new Float32Array(4 * 4); // 4 rows × 4 cols
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) z[r * 4 + c] = r * 10 + c;
    }
    const r = applyHeatmapAppendRows(g, { mode: 'appendRows', rows: 4, z, scrollY: true });
    expect(r.data.rows).toBe(3);
    // Tail rows 1,2,3 of batch → field rows 0,1,2
    expect(r.data.z[0 * 4 + 0]).toBe(10);
    expect(r.data.z[2 * 4 + 0]).toBe(30);
  });

  it('preserves NaN holes (does not coerce to 0)', () => {
    const g = baseGrid();
    const next = new Float32Array(12);
    next[0] = Number.NaN;
    next[1] = 3;
    const r = applyHeatmapReplaceZ(g, { mode: 'replaceZ', z: next });
    expect(Number.isNaN(r.data.z[0])).toBe(true);
    expect(r.data.z[1]).toBe(3);
  });

  it('does not mutate input z on appendColumns', () => {
    const g = baseGrid();
    const snapshot = Float32Array.from(g.z);
    const col = new Float32Array([100, 101, 102]);
    applyHeatmapAppendColumns(g, { mode: 'appendColumns', columns: 1, z: col, scrollX: true });
    expect(Array.from(g.z)).toEqual(Array.from(snapshot));
    expect(col[0]).toBe(100);
  });

  it('replaceZ passes explicit zMin/zMax and sets recomputeDomain when missing', () => {
    const g = baseGrid();
    const r = applyHeatmapReplaceZ(g, {
      mode: 'replaceZ',
      z: new Float32Array(12).fill(2),
      zMin: -1,
      zMax: 5,
    });
    expect(r.zMin).toBe(-1);
    expect(r.zMax).toBe(5);
    expect(r.recomputeDomain).toBe(false);

    const r2 = applyHeatmapReplaceZ(g, { mode: 'replaceZ', z: new Float32Array(12).fill(2) });
    expect(r2.recomputeDomain).toBe(true);
  });

  it('appendColumns single-column scroll uses cheap domain expand path', () => {
    const g = baseGrid();
    const col = new Float32Array([100, 101, 102]);
    const r = applyHeatmapAppendColumns(g, { mode: 'appendColumns', columns: 1, z: col, scrollX: true });
    expect(r.recomputeDomain).toBe(false);
    expect(r.scrolled).toBe(true);

    const multi = applyHeatmapAppendColumns(g, {
      mode: 'appendColumns',
      columns: 2,
      z: new Float32Array(6).fill(3),
      scrollX: true,
    });
    expect(multi.recomputeDomain).toBe(true);
  });

  it('short appendColumns payload fills missing with NaN and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = baseGrid();
    const col = new Float32Array([50]); // only one value, need 3
    const r = applyHeatmapAppendColumns(g, { mode: 'appendColumns', columns: 1, z: col, scrollX: true });
    expect(r.data.z[0 * 4 + 3]).toBe(50);
    expect(Number.isNaN(r.data.z[1 * 4 + 3])).toBe(true);
    expect(Number.isNaN(r.data.z[2 * 4 + 3])).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/appendColumns/);
    // Second short payload does not re-warn
    applyHeatmapAppendColumns(g, { mode: 'appendColumns', columns: 1, z: new Float32Array([1]), scrollX: true });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('columns 0 is no-op', () => {
    const g = baseGrid();
    const r = applyHeatmapAppendColumns(g, { mode: 'appendColumns', columns: 0, z: new Float32Array(0) });
    expect(r.data.xStart).toBe(0);
    expect(r.scrolled).toBe(false);
  });
});
