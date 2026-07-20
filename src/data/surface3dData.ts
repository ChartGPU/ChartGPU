/**
 * Uniform grid surface pack: XZ grid, height Y.
 * Mesh: two triangles per cell; positions + normals + height for colormap.
 */

import type { Surface3DGridData } from '../config/types';
import { emptyAABB, expandAABBPoint, type AABB } from '../core/3d/aabb';

export type PackedSurface3D = Readonly<{
  /** Vertex: x,y,z,nx,ny,nz,height,pad — 8 floats (32 bytes) each. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly aabb: AABB | null;
  readonly yMin: number;
  readonly yMax: number;
  readonly columns: number;
  readonly rows: number;
}>;

const STRIDE = 8;

/**
 * Sanitize grid geometry. Returns null if invalid (caller should skip draw).
 */
export function sanitizeSurface3DGrid(data: Surface3DGridData | null | undefined): Surface3DGridData | null {
  if (!data || typeof data !== 'object') return null;
  const columns = Math.floor(Number(data.columns));
  const rows = Math.floor(Number(data.rows));
  if (!(columns >= 2) || !(rows >= 2)) return null;
  if (!Number.isFinite(data.xStart) || !Number.isFinite(data.zStart)) return null;
  if (!Number.isFinite(data.xStep) || data.xStep === 0) return null;
  if (!Number.isFinite(data.zStep) || data.zStep === 0) return null;
  if (!data.y || typeof data.y.length !== 'number') return null;
  if (data.y.length < columns * rows) {
    console.warn(
      `ChartGPU surface3d: y length (${data.y.length}) < columns*rows (${columns * rows}); missing cells use 0.`
    );
  }
  return {
    xStart: data.xStart,
    xStep: data.xStep,
    zStart: data.zStart,
    zStep: data.zStep,
    columns,
    rows,
    y: data.y,
  };
}

const heightAt = (y: ArrayLike<number>, columns: number, i: number, j: number): number => {
  const idx = j * columns + i;
  if (idx < 0 || idx >= y.length) return 0;
  const v = Number(y[idx]);
  return Number.isFinite(v) ? v : 0;
};

/**
 * Pack uniform surface mesh. Normals from central differences on the height field.
 */
export function packSurface3D(
  data: Surface3DGridData,
  options?: Readonly<{ readonly yMin?: number; readonly yMax?: number }>
): PackedSurface3D | null {
  const grid = sanitizeSurface3DGrid(data);
  if (!grid) {
    return null;
  }

  const { columns, rows, xStart, xStep, zStart, zStep, y } = grid;
  const vertexCount = columns * rows;
  const vertices = new Float32Array(vertexCount * STRIDE);
  const bounds = emptyAABB();
  let yMin = Infinity;
  let yMax = -Infinity;

  // First pass: positions + y extent
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const x = xStart + i * xStep;
      const z = zStart + j * zStep;
      const h = heightAt(y, columns, i, j);
      if (h < yMin) yMin = h;
      if (h > yMax) yMax = h;
      const vi = (j * columns + i) * STRIDE;
      vertices[vi] = x;
      vertices[vi + 1] = h;
      vertices[vi + 2] = z;
      // normals filled below
      vertices[vi + 3] = 0;
      vertices[vi + 4] = 1;
      vertices[vi + 5] = 0;
      vertices[vi + 6] = h;
      vertices[vi + 7] = 0;
      expandAABBPoint(bounds, x, h, z);
    }
  }

  if (!Number.isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }
  if (yMax - yMin < 1e-12) {
    yMax = yMin + 1;
  }

  // Explicit colormap domain override for metadata only (geometry uses heights)
  const domainMin = typeof options?.yMin === 'number' && Number.isFinite(options.yMin) ? options.yMin : yMin;
  const domainMax = typeof options?.yMax === 'number' && Number.isFinite(options.yMax) ? options.yMax : yMax;

  // Normals via central differences in XZ (analytic approx)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const iL = Math.max(0, i - 1);
      const iR = Math.min(columns - 1, i + 1);
      const jD = Math.max(0, j - 1);
      const jU = Math.min(rows - 1, j + 1);
      const hL = heightAt(y, columns, iL, j);
      const hR = heightAt(y, columns, iR, j);
      const hD = heightAt(y, columns, i, jD);
      const hU = heightAt(y, columns, i, jU);
      const dx = (iR - iL) * xStep || xStep;
      const dz = (jU - jD) * zStep || zStep;
      // Gradient of height: n ~ (-dh/dx, 1, -dh/dz)
      let nx = -(hR - hL) / dx;
      let ny = 1;
      let nz = -(hU - hD) / dz;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const vi = (j * columns + i) * STRIDE;
      vertices[vi + 3] = nx;
      vertices[vi + 4] = ny;
      vertices[vi + 5] = nz;
    }
  }

  // Indices: two tris per cell
  const cellCount = (columns - 1) * (rows - 1);
  const indices = new Uint32Array(cellCount * 6);
  let ii = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < columns - 1; i++) {
      const a = j * columns + i;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      // Winding CCW when viewed from +Y for right-handed XZ
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }

  const aabb: AABB | null = Number.isFinite(bounds.min[0])
    ? { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [bounds.max[0], bounds.max[1], bounds.max[2]] }
    : null;

  return {
    vertices,
    indices,
    vertexCount,
    indexCount: indices.length,
    aabb,
    yMin: domainMin,
    yMax: domainMax > domainMin ? domainMax : domainMin + 1,
    columns,
    rows,
  };
}

/** Wireframe line-list indices (cell edges, no diagonals). */
export function packSurface3DWireframeIndices(columns: number, rows: number): Uint32Array {
  const hEdges = rows * (columns - 1);
  const vEdges = columns * (rows - 1);
  const out = new Uint32Array((hEdges + vEdges) * 2);
  let o = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns - 1; i++) {
      const a = j * columns + i;
      out[o++] = a;
      out[o++] = a + 1;
    }
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < columns; i++) {
      const a = j * columns + i;
      out[o++] = a;
      out[o++] = a + columns;
    }
  }
  return out;
}
