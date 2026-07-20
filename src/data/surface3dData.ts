/**
 * Uniform grid surface pack: XZ grid, height Y.
 * Mesh: two triangles per cell; positions + normals + height for colormap.
 */

import type { Surface3DGridData } from '../config/types';
import type { AABB } from '../core/3d/aabb';

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
 * Cheap AABB from grid meta + heights (no normals / indices). Used for scene bounds
 * so streaming strip updates do not pay a full mesh pack twice per frame.
 */
export function computeSurface3DAABB(data: Surface3DGridData): AABB | null {
  const grid = sanitizeSurface3DGrid(data);
  if (!grid) return null;
  const { columns, rows, xStart, xStep, zStart, zStep, y } = grid;
  // X/Z extents are analytic from grid meta; only heights need a walk.
  const x0 = xStart;
  const x1 = xStart + (columns - 1) * xStep;
  const z0 = zStart;
  const z1 = zStart + (rows - 1) * zStep;
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  let minY = Infinity;
  let maxY = -Infinity;
  let any = false;
  const n = columns * rows;
  const yArr = y;
  for (let i = 0; i < n; i++) {
    const h = Number(yArr[i]);
    const hv = Number.isFinite(h) ? h : 0;
    if (hv < minY) minY = hv;
    if (hv > maxY) maxY = hv;
    any = true;
  }
  if (!any || !Number.isFinite(minY)) return null;
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

/**
 * Shift a previous surface AABB by one column scroll (+dx on X) and expand Y from the
 * newly appended column heights. Avoids a full height walk on the spectrogram path.
 * Y only expands (matches colormap domain policy); stale tall peaks that scrolled off
 * keep the box tall until a full recompute — acceptable for stream framing.
 */
export function shiftSurface3DAABBColumnScroll(
  prev: AABB,
  dx: number,
  newColumnY: ArrayLike<number>,
  rows: number
): AABB {
  let yMin = prev.min[1];
  let yMax = prev.max[1];
  const n = Math.min(rows, newColumnY.length);
  for (let r = 0; r < n; r++) {
    const v = Number(newColumnY[r]);
    if (!Number.isFinite(v)) continue;
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  return {
    min: [prev.min[0] + dx, yMin, prev.min[2]],
    max: [prev.max[0] + dx, yMax, prev.max[2]],
  };
}

export type PackSurface3DOptions = Readonly<{
  readonly yMin?: number;
  readonly yMax?: number;
  /** When true (dims unchanged stream path), omit index build — renderer retains prior index buffer. */
  readonly skipIndices?: boolean;
  /**
   * Optional preallocated vertex buffer (length >= columns*rows*8). Avoids per-frame
   * Float32Array alloc on high-rate strip scroll. When too small, a new buffer is allocated.
   */
  readonly targetVertices?: Float32Array;
  /** Skip AABB assembly (coordinator uses computeSurface3DAABB / stream expand). */
  readonly skipAabb?: boolean;
}>;

/**
 * Pack uniform surface mesh. Normals from central differences on the height field.
 */
export function packSurface3D(data: Surface3DGridData, options?: PackSurface3DOptions): PackedSurface3D | null {
  const grid = sanitizeSurface3DGrid(data);
  if (!grid) {
    return null;
  }

  const { columns, rows, xStart, xStep, zStart, zStep, y } = grid;
  const vertexCount = columns * rows;
  const floats = vertexCount * STRIDE;
  const vertices =
    options?.targetVertices && options.targetVertices.length >= floats
      ? options.targetVertices.length === floats
        ? options.targetVertices
        : options.targetVertices.subarray(0, floats)
      : new Float32Array(floats);

  let yMin = Infinity;
  let yMax = -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const wantAabb = !options?.skipAabb;

  // Single pass: positions + normals + y extent (heights read from field for normals).
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const x = xStart + i * xStep;
      const z = zStart + j * zStep;
      const h = heightAt(y, columns, i, j);
      if (h < yMin) yMin = h;
      if (h > yMax) yMax = h;

      const iL = i > 0 ? i - 1 : 0;
      const iR = i < columns - 1 ? i + 1 : columns - 1;
      const jD = j > 0 ? j - 1 : 0;
      const jU = j < rows - 1 ? j + 1 : rows - 1;
      const hL = heightAt(y, columns, iL, j);
      const hR = heightAt(y, columns, iR, j);
      const hD = heightAt(y, columns, i, jD);
      const hU = heightAt(y, columns, i, jU);
      const dx = (iR - iL) * xStep || xStep;
      const dz = (jU - jD) * zStep || zStep;
      let nx = -(hR - hL) / dx;
      let ny = 1;
      let nz = -(hU - hD) / dz;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const vi = (j * columns + i) * STRIDE;
      vertices[vi] = x;
      vertices[vi + 1] = h;
      vertices[vi + 2] = z;
      vertices[vi + 3] = nx;
      vertices[vi + 4] = ny;
      vertices[vi + 5] = nz;
      vertices[vi + 6] = h;
      vertices[vi + 7] = 0;

      if (wantAabb) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (h < minY) minY = h;
        if (h > maxY) maxY = h;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
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

  let indices = new Uint32Array(0);
  let indexCount = 0;
  if (!options?.skipIndices) {
    // Indices: two tris per cell
    const cellCount = (columns - 1) * (rows - 1);
    indices = new Uint32Array(cellCount * 6);
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
    indexCount = indices.length;
  }

  const aabb: AABB | null =
    wantAabb && Number.isFinite(minX) ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null;

  return {
    vertices,
    indices,
    vertexCount,
    indexCount,
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
