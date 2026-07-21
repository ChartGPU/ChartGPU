/**
 * Heatmap streaming helpers: replaceZ + appendColumns (column-major strips) + appendRows.
 *
 * Full field layout (replaceZ / stored grid): row-major z[j * columns + i]
 * appendColumns payload: column-major strips z[c * rows + r] for each new column.
 * appendRows payload: row-major blocks z[r * columns + i].
 *
 * Non-finite values are preserved as NaN (holes); match packZTextureData / hit-test policy.
 * Never mutates caller-owned z arrays — always allocates a fresh Float32Array for owned field.
 */

import type { HeatmapData, HeatmapUpdate } from '../config/types';
import { sanitizeHeatmapGeometry } from '../utils/heatmapLayout';

export type { HeatmapUpdate };

export type HeatmapStreamResult = Readonly<{
  readonly data: HeatmapData;
  /** True when dimensions changed (grow path). */
  readonly dimsChanged: boolean;
  readonly scrolled: boolean;
  /** Explicit colormap domain from replaceZ; undefined → recompute/expand. */
  readonly zMin?: number;
  readonly zMax?: number;
  /** True when domain should be recomputed from the full field. */
  readonly recomputeDomain: boolean;
  /**
   * GPU modular ring: advance oldest-column index by this many columns after a
   * scrollX append that preserves dimensions (0 when full re-upload needed).
   * Single-column spectrogram scroll → 1; multi-column batch → 0 (full upload).
   */
  readonly ringAdvanceCols: number;
}>;

/**
 * Whether `updateHeatmap` stream override should be cleared on setOption.
 *
 * Policy (single source of truth for coordinator + tests):
 * - Keep stream while user reuses the **same** `data` object identity (style-only setOption).
 * - Clear when user supplies a **new** data identity (even after scrollX changed xStart).
 * - Do not clear on first seed (`prevUser == null`).
 */
export function shouldClearHeatmapStream(
  prevUserData: HeatmapData | null | undefined,
  nextUserData: HeatmapData | null | undefined
): boolean {
  if (prevUserData == null || nextUserData == null) return false;
  return nextUserData !== prevUserData;
}

/** Preserve NaN holes; never coerce non-finite → 0. Missing → NaN. */
const valueOrNaN = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** One-shot short-payload warning (per process). */
let warnedShortHeatmapPayload = false;
const warnShortPayloadOnce = (mode: string, got: number, need: number): void => {
  if (warnedShortHeatmapPayload) return;
  if (!(got < need)) return;
  warnedShortHeatmapPayload = true;
  console.warn(
    `ChartGPU.updateHeatmap(${mode}): z.length (${got}) < required (${need}); missing cells filled with NaN.`
  );
};

/** @internal Test helper: reset short-payload warn gate. */
export function __resetHeatmapStreamWarnForTests(): void {
  warnedShortHeatmapPayload = false;
}

/** Copy existing cell preserving NaN (unlike `|| 0`). */
const copyZ = (z: ArrayLike<number>, idx: number): number => {
  if (idx < 0 || idx >= z.length) return Number.NaN;
  return valueOrNaN(z[idx]);
};

/**
 * Auto z extent from field (finite samples only). Fallback [0, 1] if empty/flat NaN.
 */
export function computeHeatmapStreamDomain(z: ArrayLike<number>, length: number): { zMin: number; zMax: number } {
  let lo = Infinity;
  let hi = -Infinity;
  const n = Math.min(z.length, length);
  for (let i = 0; i < n; i++) {
    const v = Number(z[i]);
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { zMin: 0, zMax: 1 };
  if (!(hi > lo)) return { zMin: lo, zMax: lo + 1 };
  return { zMin: lo, zMax: hi };
}

/**
 * Apply replaceZ: new full field, same grid meta.
 * Missing cells → NaN. Optional zMin/zMax pass through for colormap domain.
 */
export function applyHeatmapReplaceZ(
  data: HeatmapData,
  update: Extract<HeatmapUpdate, { mode: 'replaceZ' }>
): HeatmapStreamResult {
  const geom = sanitizeHeatmapGeometry(data);
  if (!geom) {
    return {
      data,
      dimsChanged: false,
      scrolled: false,
      recomputeDomain: true,
      ringAdvanceCols: 0,
    };
  }
  const n = geom.columns * geom.rows;
  const nextZ = new Float32Array(n);
  const src = update.z;
  warnShortPayloadOnce('replaceZ', src.length, n);
  for (let i = 0; i < n; i++) {
    nextZ[i] = i < src.length ? valueOrNaN(src[i]) : Number.NaN;
  }
  const explicitMin = typeof update.zMin === 'number' && Number.isFinite(update.zMin) ? update.zMin : undefined;
  const explicitMax = typeof update.zMax === 'number' && Number.isFinite(update.zMax) ? update.zMax : undefined;
  return {
    data: {
      xStart: geom.xStart,
      xStep: geom.xStep,
      yStart: geom.yStart,
      yStep: geom.yStep,
      columns: geom.columns,
      rows: geom.rows,
      z: nextZ,
    },
    dimsChanged: false,
    scrolled: false,
    zMin: explicitMin,
    zMax: explicitMax,
    recomputeDomain: explicitMin == null || explicitMax == null,
    ringAdvanceCols: 0,
  };
}

/**
 * Append columns on +X side. Payload is column-major: for each new column c, values for r=0..rows-1
 * at z[c * rows + r]. When scrollX (default true), drop oldest columns and
 * xStart += drop * xStep so window width stays constant.
 */
export function applyHeatmapAppendColumns(
  data: HeatmapData,
  update: Extract<HeatmapUpdate, { mode: 'appendColumns' }>
): HeatmapStreamResult {
  const geom = sanitizeHeatmapGeometry(data);
  if (!geom) {
    return {
      data,
      dimsChanged: false,
      scrolled: false,
      recomputeDomain: true,
      ringAdvanceCols: 0,
    };
  }
  const addCols = Math.max(0, Math.floor(update.columns));
  if (addCols === 0) {
    return {
      data: {
        xStart: geom.xStart,
        xStep: geom.xStep,
        yStart: geom.yStart,
        yStep: geom.yStep,
        columns: geom.columns,
        rows: geom.rows,
        z: data.z,
      },
      dimsChanged: false,
      scrolled: false,
      recomputeDomain: false,
      ringAdvanceCols: 0,
    };
  }
  const rows = geom.rows;
  const oldCols = geom.columns;
  const scrollX = update.scrollX !== false;
  const src = update.z;
  const srcZ = data.z;
  warnShortPayloadOnce('appendColumns', src.length, addCols * rows);

  if (scrollX) {
    const keep = Math.max(0, oldCols - addCols);
    const drop = oldCols - keep;
    const nextZ = new Float32Array(oldCols * rows);

    // Fast path: shift one column (common spectrogram scroll).
    // Always allocate a fresh z buffer — must not mutate caller-owned arrays.
    if (addCols === 1 && keep === oldCols - 1 && oldCols >= 2) {
      for (let r = 0; r < rows; r++) {
        const row = r * oldCols;
        if (srcZ instanceof Float32Array) {
          nextZ.set(srcZ.subarray(row + 1, row + oldCols), row);
        } else {
          for (let i = 0; i < keep; i++) {
            nextZ[row + i] = copyZ(srcZ, row + i + 1);
          }
        }
        nextZ[row + keep] = valueOrNaN(src[r]);
      }
    } else if (addCols >= oldCols) {
      for (let i = 0; i < oldCols; i++) {
        const cSrc = addCols - oldCols + i;
        for (let r = 0; r < rows; r++) {
          nextZ[r * oldCols + i] = valueOrNaN(src[cSrc * rows + r]);
        }
      }
    } else {
      for (let i = 0; i < keep; i++) {
        const srcCol = i + (oldCols - keep);
        for (let r = 0; r < rows; r++) {
          nextZ[r * oldCols + i] = copyZ(srcZ, r * oldCols + srcCol);
        }
      }
      const newStart = keep;
      for (let c = 0; c < addCols; c++) {
        const destCol = newStart + c;
        if (destCol >= oldCols) break;
        for (let r = 0; r < rows; r++) {
          nextZ[r * oldCols + destCol] = valueOrNaN(src[c * rows + r]);
        }
      }
    }
    return {
      data: {
        xStart: geom.xStart + drop * geom.xStep,
        xStep: geom.xStep,
        yStart: geom.yStart,
        yStep: geom.yStep,
        columns: oldCols,
        rows,
        z: nextZ,
      },
      dimsChanged: false,
      scrolled: drop > 0 || addCols > 0,
      // Domain expands from new column in coordinator for cheap strip path
      recomputeDomain: addCols !== 1,
      // GPU ring: single-column scroll advances by 1; multi-column batch → full upload
      ringAdvanceCols: addCols === 1 && oldCols >= 1 ? 1 : 0,
    };
  }

  // Grow: columns' = columns + addCols
  const newCols = oldCols + addCols;
  const nextZ = new Float32Array(newCols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < oldCols; i++) {
      nextZ[j * newCols + i] = copyZ(srcZ, j * oldCols + i);
    }
  }
  for (let c = 0; c < addCols; c++) {
    const destCol = oldCols + c;
    for (let r = 0; r < rows; r++) {
      nextZ[r * newCols + destCol] = valueOrNaN(src[c * rows + r]);
    }
  }
  return {
    data: {
      xStart: geom.xStart,
      xStep: geom.xStep,
      yStart: geom.yStart,
      yStep: geom.yStep,
      columns: newCols,
      rows,
      z: nextZ,
    },
    dimsChanged: true,
    scrolled: false,
    recomputeDomain: true,
    ringAdvanceCols: 0,
  };
}

/**
 * Append rows on +Y side. Payload is row-major block of length columns * rows_new.
 */
export function applyHeatmapAppendRows(
  data: HeatmapData,
  update: Extract<HeatmapUpdate, { mode: 'appendRows' }>
): HeatmapStreamResult {
  const geom = sanitizeHeatmapGeometry(data);
  if (!geom) {
    return {
      data,
      dimsChanged: false,
      scrolled: false,
      recomputeDomain: true,
      ringAdvanceCols: 0,
    };
  }
  const addRows = Math.max(0, Math.floor(update.rows));
  if (addRows === 0) {
    return {
      data: {
        xStart: geom.xStart,
        xStep: geom.xStep,
        yStart: geom.yStart,
        yStep: geom.yStep,
        columns: geom.columns,
        rows: geom.rows,
        z: data.z,
      },
      dimsChanged: false,
      scrolled: false,
      recomputeDomain: false,
      ringAdvanceCols: 0,
    };
  }
  const cols = geom.columns;
  const oldRows = geom.rows;
  const scrollY = update.scrollY !== false;
  const src = update.z;
  const srcZ = data.z;
  warnShortPayloadOnce('appendRows', src.length, addRows * cols);

  if (scrollY) {
    const keep = Math.max(0, oldRows - addRows);
    const nextZ = new Float32Array(cols * oldRows);
    for (let j = 0; j < keep; j++) {
      const srcRow = j + (oldRows - keep);
      for (let i = 0; i < cols; i++) {
        nextZ[j * cols + i] = copyZ(srcZ, srcRow * cols + i);
      }
    }
    if (addRows >= oldRows) {
      for (let j = 0; j < oldRows; j++) {
        const srcRow = addRows - oldRows + j;
        for (let i = 0; i < cols; i++) {
          nextZ[j * cols + i] = valueOrNaN(src[srcRow * cols + i]);
        }
      }
    } else {
      for (let r = 0; r < addRows; r++) {
        const destRow = keep + r;
        for (let i = 0; i < cols; i++) {
          nextZ[destRow * cols + i] = valueOrNaN(src[r * cols + i]);
        }
      }
    }
    const drop = oldRows - keep;
    return {
      data: {
        xStart: geom.xStart,
        xStep: geom.xStep,
        yStart: geom.yStart + drop * geom.yStep,
        yStep: geom.yStep,
        columns: cols,
        rows: oldRows,
        z: nextZ,
      },
      dimsChanged: false,
      scrolled: drop > 0 || addRows > 0,
      recomputeDomain: true,
      ringAdvanceCols: 0,
    };
  }

  const newRows = oldRows + addRows;
  const nextZ = new Float32Array(cols * newRows);
  for (let j = 0; j < oldRows; j++) {
    for (let i = 0; i < cols; i++) {
      nextZ[j * cols + i] = copyZ(srcZ, j * cols + i);
    }
  }
  for (let r = 0; r < addRows; r++) {
    const destRow = oldRows + r;
    for (let i = 0; i < cols; i++) {
      nextZ[destRow * cols + i] = valueOrNaN(src[r * cols + i]);
    }
  }
  return {
    data: {
      xStart: geom.xStart,
      xStep: geom.xStep,
      yStart: geom.yStart,
      yStep: geom.yStep,
      columns: cols,
      rows: newRows,
      z: nextZ,
    },
    dimsChanged: true,
    scrolled: false,
    recomputeDomain: true,
    ringAdvanceCols: 0,
  };
}

export function applyHeatmapUpdate(data: HeatmapData, update: HeatmapUpdate): HeatmapStreamResult {
  if (update.mode === 'replaceZ') return applyHeatmapReplaceZ(data, update);
  if (update.mode === 'appendColumns') return applyHeatmapAppendColumns(data, update);
  return applyHeatmapAppendRows(data, update);
}

/**
 * Resolve colormap domain override after a stream update (D5 single source of truth).
 *
 * - replaceZ with both zMin/zMax → lock override
 * - series zDomainExplicit → null override (use series zMin/zMax; no strip expand)
 * - auto + single-col scroll → expand from strip
 * - auto + recompute → full field
 * - otherwise leave prior override unchanged
 */
export function resolveHeatmapStreamDomainOverride(args: {
  readonly zDomainExplicit: boolean;
  readonly seriesZMin: number;
  readonly seriesZMax: number;
  readonly prevOverride: { zMin: number; zMax: number } | null;
  readonly result: HeatmapStreamResult;
  readonly update: HeatmapUpdate;
}): { zMin: number; zMax: number } | null {
  const { zDomainExplicit, seriesZMin, seriesZMax, prevOverride, result, update } = args;

  if (result.zMin != null && result.zMax != null && !result.recomputeDomain) {
    return { zMin: result.zMin, zMax: result.zMax };
  }
  if (zDomainExplicit) {
    return null;
  }
  if (
    update.mode === 'appendColumns' &&
    update.scrollX !== false &&
    Math.floor(update.columns) === 1 &&
    !result.recomputeDomain
  ) {
    const prev = prevOverride ?? { zMin: seriesZMin, zMax: seriesZMax };
    const col = update.z;
    let lo = prev.zMin;
    let hi = prev.zMax;
    const n = Math.min(col.length, result.data.rows);
    for (let r = 0; r < n; r++) {
      const v = Number(col[r]);
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) {
      const auto = computeHeatmapStreamDomain(result.data.z, result.data.columns * result.data.rows);
      lo = auto.zMin;
      hi = auto.zMax;
    }
    return { zMin: lo, zMax: hi > lo ? hi : lo + 1 };
  }
  if (result.recomputeDomain) {
    const auto = computeHeatmapStreamDomain(result.data.z, result.data.columns * result.data.rows);
    const zMin = result.zMin ?? auto.zMin;
    const zMax = result.zMax ?? auto.zMax;
    return { zMin, zMax: zMax > zMin ? zMax : zMin + 1 };
  }
  return prevOverride;
}
