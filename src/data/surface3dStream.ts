/**
 * Surface3D streaming helpers: replaceY + appendColumns (column-major strips) scroll.
 *
 * Full field layout (replaceY / stored grid): row-major y[j * columns + i]
 * appendColumns payload: column-major strips y[c * rows + r] for each new column.
 *
 * Non-finite heights are preserved as NaN (holes); match packSurface3D / pick policy.
 */

import type { Surface3DGridData, Surface3DUpdate } from '../config/types';
import { sanitizeSurface3DGrid } from './surface3dData';

export type { Surface3DUpdate };

export type Surface3DStreamResult = Readonly<{
  readonly data: Surface3DGridData;
  /** True when dimensions or xStart/zStart changed (index topology may stay same if dims fixed). */
  readonly dimsChanged: boolean;
  readonly scrolled: boolean;
  /** Explicit colormap domain from replaceY; undefined → recompute auto from field. */
  readonly yMin?: number;
  readonly yMax?: number;
  /** True when domain should be recomputed from the height field. */
  readonly recomputeDomain: boolean;
}>;

/**
 * Whether `updateSurface3D` stream override should be cleared on setOption.
 *
 * Policy (single source of truth for coordinator + tests):
 * - Keep stream while user reuses the **same** `data` object identity (style-only setOption).
 * - Clear when user supplies a **new** data identity (even after scrollX changed xStart).
 * - Do not clear on first seed (`prevUser == null`).
 */
export function shouldClearSurfaceStream(
  prevUserData: Surface3DGridData | null | undefined,
  nextUserData: Surface3DGridData | null | undefined
): boolean {
  if (prevUserData == null || nextUserData == null) return false;
  return nextUserData !== prevUserData;
}

/** Preserve NaN holes; never coerce non-finite → 0. Missing → NaN. */
const heightOrNaN = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** Copy existing height preserving NaN (unlike `|| 0`). */
const copyHeight = (y: ArrayLike<number>, idx: number): number => {
  if (idx < 0 || idx >= y.length) return Number.NaN;
  return heightOrNaN(y[idx]);
};

/**
 * Auto y extent from field (finite samples only). Fallback [0, 1] if empty/flat NaN.
 */
export function computeSurface3DDomain(y: ArrayLike<number>, length: number): { yMin: number; yMax: number } {
  let lo = Infinity;
  let hi = -Infinity;
  const n = Math.min(y.length, length);
  for (let i = 0; i < n; i++) {
    const v = Number(y[i]);
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { yMin: 0, yMax: 1 };
  if (!(hi > lo)) return { yMin: lo, yMax: lo + 1 };
  return { yMin: lo, yMax: hi };
}

/**
 * Apply replaceY: new full field, same grid meta.
 * Missing cells → NaN. Optional yMin/yMax pass through for colormap domain.
 */
export function applySurface3DReplaceY(
  data: Surface3DGridData,
  update: Extract<Surface3DUpdate, { mode: 'replaceY' }>
): Surface3DStreamResult {
  const grid = sanitizeSurface3DGrid(data);
  if (!grid) {
    return { data, dimsChanged: false, scrolled: false, recomputeDomain: true };
  }
  const n = grid.columns * grid.rows;
  const nextY = new Float32Array(n);
  const src = update.y;
  for (let i = 0; i < n; i++) {
    nextY[i] = i < src.length ? heightOrNaN(src[i]) : Number.NaN;
  }
  const explicitMin = typeof update.yMin === 'number' && Number.isFinite(update.yMin) ? update.yMin : undefined;
  const explicitMax = typeof update.yMax === 'number' && Number.isFinite(update.yMax) ? update.yMax : undefined;
  return {
    data: {
      xStart: grid.xStart,
      xStep: grid.xStep,
      zStart: grid.zStart,
      zStep: grid.zStep,
      columns: grid.columns,
      rows: grid.rows,
      y: nextY,
    },
    dimsChanged: false,
    scrolled: false,
    yMin: explicitMin,
    yMax: explicitMax,
    recomputeDomain: explicitMin == null || explicitMax == null,
  };
}

/**
 * Append columns on +X side. Payload is column-major: for each new column c, heights for r=0..rows-1
 * at y[c * rows + r]. When scrollX (default true), drop oldest `columns` columns and
 * xStart += columns * xStep so window width stays constant.
 */
export function applySurface3DAppendColumns(
  data: Surface3DGridData,
  update: Extract<Surface3DUpdate, { mode: 'appendColumns' }>
): Surface3DStreamResult {
  const grid = sanitizeSurface3DGrid(data);
  if (!grid) {
    return { data, dimsChanged: false, scrolled: false, recomputeDomain: true };
  }
  const addCols = Math.max(0, Math.floor(update.columns));
  if (addCols === 0) {
    return { data: grid, dimsChanged: false, scrolled: false, recomputeDomain: false };
  }
  const rows = grid.rows;
  const oldCols = grid.columns;
  const scrollX = update.scrollX !== false;
  const src = update.y;

  if (scrollX) {
    const keep = Math.max(0, oldCols - addCols);
    const drop = oldCols - keep;
    const nextY = new Float32Array(oldCols * rows);
    const srcY = grid.y;

    // Fast path: shift one column (common spectrogram scroll).
    // Always allocate a fresh y buffer — must not mutate caller-owned height arrays.
    if (addCols === 1 && keep === oldCols - 1 && oldCols >= 2) {
      for (let r = 0; r < rows; r++) {
        const row = r * oldCols;
        // Row-major: copy columns [1..oldCols) → [0..oldCols-1)
        if (srcY instanceof Float32Array) {
          nextY.set(srcY.subarray(row + 1, row + oldCols), row);
        } else {
          for (let i = 0; i < keep; i++) {
            nextY[row + i] = copyHeight(srcY, row + i + 1);
          }
        }
        nextY[row + keep] = heightOrNaN(src[r]);
      }
    } else if (addCols >= oldCols) {
      for (let i = 0; i < oldCols; i++) {
        const cSrc = addCols - oldCols + i;
        for (let r = 0; r < rows; r++) {
          nextY[r * oldCols + i] = heightOrNaN(src[cSrc * rows + r]);
        }
      }
    } else {
      for (let i = 0; i < keep; i++) {
        const srcCol = i + (oldCols - keep);
        for (let r = 0; r < rows; r++) {
          nextY[r * oldCols + i] = copyHeight(srcY, r * oldCols + srcCol);
        }
      }
      const newStart = keep;
      for (let c = 0; c < addCols; c++) {
        const destCol = newStart + c;
        if (destCol >= oldCols) break;
        for (let r = 0; r < rows; r++) {
          nextY[r * oldCols + destCol] = heightOrNaN(src[c * rows + r]);
        }
      }
    }
    return {
      data: {
        xStart: grid.xStart + drop * grid.xStep,
        xStep: grid.xStep,
        zStart: grid.zStart,
        zStep: grid.zStep,
        columns: oldCols,
        rows,
        y: nextY,
      },
      dimsChanged: false,
      scrolled: drop > 0 || addCols > 0,
      // Domain expands from new column in coordinator for cheap strip path
      recomputeDomain: addCols !== 1,
    };
  }

  const newCols = oldCols + addCols;
  const nextY = new Float32Array(newCols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < oldCols; i++) {
      nextY[j * newCols + i] = copyHeight(grid.y, j * oldCols + i);
    }
  }
  for (let c = 0; c < addCols; c++) {
    const destCol = oldCols + c;
    for (let r = 0; r < rows; r++) {
      nextY[r * newCols + destCol] = heightOrNaN(src[c * rows + r]);
    }
  }
  return {
    data: {
      xStart: grid.xStart,
      xStep: grid.xStep,
      zStart: grid.zStart,
      zStep: grid.zStep,
      columns: newCols,
      rows,
      y: nextY,
    },
    dimsChanged: true,
    scrolled: false,
    recomputeDomain: true,
  };
}

/**
 * Append rows on +Z side. Payload is row-major block of length columns * rows_new.
 */
export function applySurface3DAppendRows(
  data: Surface3DGridData,
  update: Extract<Surface3DUpdate, { mode: 'appendRows' }>
): Surface3DStreamResult {
  const grid = sanitizeSurface3DGrid(data);
  if (!grid) {
    return { data, dimsChanged: false, scrolled: false, recomputeDomain: true };
  }
  const addRows = Math.max(0, Math.floor(update.rows));
  if (addRows === 0) {
    return { data: grid, dimsChanged: false, scrolled: false, recomputeDomain: false };
  }
  const cols = grid.columns;
  const oldRows = grid.rows;
  const scrollZ = update.scrollZ !== false;
  const src = update.y;

  if (scrollZ) {
    const keep = Math.max(0, oldRows - addRows);
    const nextY = new Float32Array(cols * oldRows);
    for (let j = 0; j < keep; j++) {
      const srcRow = j + (oldRows - keep);
      for (let i = 0; i < cols; i++) {
        nextY[j * cols + i] = copyHeight(grid.y, srcRow * cols + i);
      }
    }
    if (addRows >= oldRows) {
      for (let j = 0; j < oldRows; j++) {
        const srcRow = addRows - oldRows + j;
        for (let i = 0; i < cols; i++) {
          nextY[j * cols + i] = heightOrNaN(src[srcRow * cols + i]);
        }
      }
    } else {
      for (let r = 0; r < addRows; r++) {
        const destRow = keep + r;
        for (let i = 0; i < cols; i++) {
          nextY[destRow * cols + i] = heightOrNaN(src[r * cols + i]);
        }
      }
    }
    const drop = oldRows - keep;
    return {
      data: {
        xStart: grid.xStart,
        xStep: grid.xStep,
        zStart: grid.zStart + drop * grid.zStep,
        zStep: grid.zStep,
        columns: cols,
        rows: oldRows,
        y: nextY,
      },
      dimsChanged: false,
      scrolled: drop > 0 || addRows > 0,
      recomputeDomain: true,
    };
  }

  const newRows = oldRows + addRows;
  const nextY = new Float32Array(cols * newRows);
  for (let j = 0; j < oldRows; j++) {
    for (let i = 0; i < cols; i++) {
      nextY[j * cols + i] = copyHeight(grid.y, j * cols + i);
    }
  }
  for (let r = 0; r < addRows; r++) {
    const destRow = oldRows + r;
    for (let i = 0; i < cols; i++) {
      nextY[destRow * cols + i] = heightOrNaN(src[r * cols + i]);
    }
  }
  return {
    data: {
      xStart: grid.xStart,
      xStep: grid.xStep,
      zStart: grid.zStart,
      zStep: grid.zStep,
      columns: cols,
      rows: newRows,
      y: nextY,
    },
    dimsChanged: true,
    scrolled: false,
    recomputeDomain: true,
  };
}

export function applySurface3DUpdate(data: Surface3DGridData, update: Surface3DUpdate): Surface3DStreamResult {
  if (update.mode === 'replaceY') return applySurface3DReplaceY(data, update);
  if (update.mode === 'appendColumns') return applySurface3DAppendColumns(data, update);
  return applySurface3DAppendRows(data, update);
}
