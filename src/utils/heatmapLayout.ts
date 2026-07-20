/**
 * Pure layout / hit-test / z-range helpers for uniform heatmap series.
 *
 * Cell index mapping (shared by CPU hit-test and GPU UV→texel):
 *   origin (x0,y0) = cell (0,0) min-corner after cellAnchor
 *   i = floor((x - x0) / xStep),  j = floor((y - y0) / yStep)
 * Signed steps are supported; UV u=0 always maps to column 0 (not sorted axis min).
 */

import type { HeatmapData, HeatmapNullHandling } from '../config/types';

export type HeatmapCellAnchor = 'corner' | 'center';

export type HeatmapGridBounds = Readonly<{
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}>;

/** Signed grid placement for VS/FS: origin + UV * extent (extent may be negative). */
export type HeatmapGridPlacement = Readonly<{
  readonly x0: number;
  readonly y0: number;
  /** columns * xStep (signed). */
  readonly xExtent: number;
  /** rows * yStep (signed). */
  readonly yExtent: number;
  readonly columns: number;
  readonly rows: number;
  readonly xStep: number;
  readonly yStep: number;
}>;

export type HeatmapHitResult = Readonly<{
  readonly i: number;
  readonly j: number;
  readonly z: number;
  /** Cell center in data space. */
  readonly x: number;
  readonly y: number;
  /** Row-major index into z. */
  readonly dataIndex: number;
}>;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Origin of cell (0,0) min-corner and signed extents covering the full grid.
 * UV (0,0) → origin; UV (1,1) → origin + extent. Matches GPU vsMain placement.
 */
export function heatmapGridPlacement(
  data: Pick<HeatmapData, 'xStart' | 'xStep' | 'yStart' | 'yStep' | 'columns' | 'rows'>,
  cellAnchor: HeatmapCellAnchor = 'corner'
): HeatmapGridPlacement {
  const columns = Math.max(1, Math.floor(data.columns) || 1);
  const rows = Math.max(1, Math.floor(data.rows) || 1);
  const xStep = data.xStep;
  const yStep = data.yStep;
  let x0 = data.xStart;
  let y0 = data.yStart;
  if (cellAnchor === 'center') {
    x0 = data.xStart - xStep * 0.5;
    y0 = data.yStart - yStep * 0.5;
  }
  return {
    x0,
    y0,
    xExtent: columns * xStep,
    yExtent: rows * yStep,
    columns,
    rows,
    xStep,
    yStep,
  };
}

/**
 * Data-space axis-aligned bounds of the heatmap grid (including cell extents).
 * Always returns min ≤ max (normalizes negative steps). Used for axis auto-domain only.
 */
export function heatmapGridBounds(
  data: Pick<HeatmapData, 'xStart' | 'xStep' | 'yStart' | 'yStep' | 'columns' | 'rows'>,
  cellAnchor: HeatmapCellAnchor = 'corner'
): HeatmapGridBounds {
  const p = heatmapGridPlacement(data, cellAnchor);
  const x1 = p.x0 + p.xExtent;
  const y1 = p.y0 + p.yExtent;
  return {
    xMin: Math.min(p.x0, x1),
    xMax: Math.max(p.x0, x1),
    yMin: Math.min(p.y0, y1),
    yMax: Math.max(p.y0, y1),
  };
}

/**
 * Map data-space (x, y) to integer cell indices using the same formula as GPU FS.
 * Returns null when outside [0, columns) × [0, rows).
 */
export function heatmapCellIndex(
  data: Pick<HeatmapData, 'xStart' | 'xStep' | 'yStart' | 'yStep' | 'columns' | 'rows'>,
  x: number,
  y: number,
  cellAnchor: HeatmapCellAnchor = 'corner'
): { readonly i: number; readonly j: number } | null {
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isFiniteNumber(data.xStep) || data.xStep === 0) return null;
  if (!isFiniteNumber(data.yStep) || data.yStep === 0) return null;

  const columns = Math.floor(data.columns);
  const rows = Math.floor(data.rows);
  if (!(columns >= 1) || !(rows >= 1)) return null;

  const p = heatmapGridPlacement(data, cellAnchor);
  const fi = (x - p.x0) / p.xStep;
  const fj = (y - p.y0) / p.yStep;
  if (!Number.isFinite(fi) || !Number.isFinite(fj)) return null;

  const i = Math.floor(fi);
  const j = Math.floor(fj);
  if (i < 0 || i >= columns || j < 0 || j >= rows) return null;
  return { i, j };
}

/**
 * Map data-space (x, y) to a cell. Returns null when outside the grid.
 * Half-open cell intervals along the step direction (signed steps supported).
 */
export function heatmapHitTest(
  data: HeatmapData,
  x: number,
  y: number,
  cellAnchor: HeatmapCellAnchor = 'corner'
): HeatmapHitResult | null {
  const idx = heatmapCellIndex(data, x, y, cellAnchor);
  if (!idx) return null;

  const p = heatmapGridPlacement(data, cellAnchor);
  const { i, j } = idx;
  const dataIndex = j * p.columns + i;
  const zArr = data.z;
  const z = dataIndex < zArr.length ? Number(zArr[dataIndex]) : Number.NaN;

  const cx = p.x0 + (i + 0.5) * p.xStep;
  const cy = p.y0 + (j + 0.5) * p.yStep;

  return { i, j, z, x: cx, y: cy, dataIndex };
}

/**
 * Scan finite z values for min/max. Empty/all-nonfinite → { zMin: 0, zMax: 1 }.
 * When `zScale === 'log'`, only positive finite values are considered.
 */
export function computeHeatmapZExtent(
  z: Float32Array | ReadonlyArray<number>,
  length: number,
  zScale: 'linear' | 'log' = 'linear'
): { readonly zMin: number; readonly zMax: number } {
  const n = Math.max(0, Math.min(length, z.length));
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < n; i++) {
    const v = Number(z[i]);
    if (!Number.isFinite(v)) continue;
    if (zScale === 'log' && !(v > 0)) continue;
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }

  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    return { zMin: 0, zMax: 1 };
  }
  if (zMin === zMax) {
    const eps = zMin === 0 ? 1e-6 : Math.abs(zMin) * 1e-6;
    return { zMin: zMin - eps, zMax: zMax + eps };
  }
  return { zMin, zMax };
}

/**
 * Normalize a single z sample to t ∈ [0, 1]. Non-finite / invalid log → NaN
 * (caller applies nullHandling).
 */
export function normalizeZ(z: number, zMin: number, zMax: number, zScale: 'linear' | 'log' = 'linear'): number {
  if (!Number.isFinite(z) || !Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    return Number.NaN;
  }
  if (zScale === 'log') {
    if (!(z > 0) || !(zMin > 0) || !(zMax > 0)) return Number.NaN;
    const lz = Math.log(z);
    const l0 = Math.log(zMin);
    const l1 = Math.log(zMax);
    if (l0 === l1) return 0;
    const t = (lz - l0) / (l1 - l0);
    if (!Number.isFinite(t)) return Number.NaN;
    return Math.min(1, Math.max(0, t));
  }
  if (zMin === zMax) return 0;
  const t = (z - zMin) / (zMax - zMin);
  if (!Number.isFinite(t)) return Number.NaN;
  return Math.min(1, Math.max(0, t));
}

/**
 * Map a non-finite or out-of-policy z sample through nullHandling.
 * Returns t ∈ [0,1] or null when transparent (skip draw / alpha 0).
 */
export function applyNullHandling(t: number, nullHandling: HeatmapNullHandling): number | null {
  if (Number.isFinite(t)) return Math.min(1, Math.max(0, t));
  if (nullHandling === 'lowest') return 0;
  if (nullHandling === 'highest') return 1;
  return null;
}

/**
 * Position-sensitive content stamp for equal-size z dirty detection
 * (O(n), only on setOption identity change).
 *
 * Uses FNV-1a over IEEE-754 bit patterns of each sample mixed with index so
 * cell swaps, column ring-shifts, and sub-quantum float edits change the stamp.
 * Order-blind sum/xor is intentionally avoided.
 */
export function heatmapZContentStamp(z: Float32Array | ReadonlyArray<number>, length: number): number {
  const n = Math.max(0, Math.min(length, z.length));
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  const scratch = new Float32Array(1);
  const bits = new Uint32Array(scratch.buffer);

  for (let i = 0; i < n; i++) {
    const v = Number(z[i]);
    let word: number;
    if (Number.isFinite(v)) {
      scratch[0] = v;
      word = bits[0]!;
    } else if (Number.isNaN(v)) {
      word = 0x7fc00000; // quiet NaN canonical
    } else {
      // ±Inf
      word = v > 0 ? 0x7f800000 : 0xff800000;
    }
    // Mix index so stamp([1,2,3]) !== stamp([3,2,1])
    word = (word ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    h ^= word;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Fold length
  h ^= n >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  return h >>> 0;
}

/**
 * Validate heatmap dimensions and steps. Returns a sanitized snapshot or null
 * when the series should be skipped (invalid geometry).
 */
export function sanitizeHeatmapGeometry(data: HeatmapData | null | undefined): {
  readonly columns: number;
  readonly rows: number;
  readonly xStart: number;
  readonly xStep: number;
  readonly yStart: number;
  readonly yStep: number;
  readonly zLength: number;
  readonly drawCells: number;
} | null {
  if (!data || typeof data !== 'object') return null;
  const columns = Math.floor(Number(data.columns));
  const rows = Math.floor(Number(data.rows));
  if (!(columns >= 1) || !(rows >= 1)) return null;
  if (!isFiniteNumber(data.xStart) || !isFiniteNumber(data.yStart)) return null;
  if (!isFiniteNumber(data.xStep) || data.xStep === 0) return null;
  if (!isFiniteNumber(data.yStep) || data.yStep === 0) return null;
  const z = data.z;
  const zLength = z && typeof (z as { length?: number }).length === 'number' ? z.length : 0;
  const expected = columns * rows;
  const drawCells = Math.min(zLength, expected);
  return {
    columns,
    rows,
    xStart: data.xStart,
    xStep: data.xStep,
    yStart: data.yStart,
    yStep: data.yStep,
    zLength,
    drawCells,
  };
}
