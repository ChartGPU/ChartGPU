/**
 * Analytic ray–heightfield pick for uniform surface3d grids (Y-up, XZ base).
 */

import type { Mat4 } from './mat4';
import { invertMat4 } from './mat4';
import { unprojectCssRay } from './projectWorldToCss';

export type Surface3DPickHit = Readonly<{
  readonly i: number;
  readonly j: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Same as y under Y-up heightfield convention. */
  readonly height: number;
  /** Ray parameter t (distance along ray). */
  readonly t: number;
}>;

export type Surface3DPickGrid = Readonly<{
  readonly xStart: number;
  readonly xStep: number;
  readonly zStart: number;
  readonly zStep: number;
  readonly columns: number;
  readonly rows: number;
  /** Row-major heights y[j * columns + i]. */
  readonly y: ArrayLike<number>;
}>;

const heightAt = (grid: Surface3DPickGrid, i: number, j: number): number | null => {
  if (i < 0 || j < 0 || i >= grid.columns || j >= grid.rows) return null;
  const idx = j * grid.columns + i;
  if (idx < 0 || idx >= grid.y.length) return null;
  const v = Number(grid.y[idx]);
  return Number.isFinite(v) ? v : null;
};

/**
 * Bilinear sample height at fractional cell coords (u,v) in [0,1] within cell (i,j).
 * Returns null if any corner is non-finite.
 */
const bilinearHeight = (grid: Surface3DPickGrid, i: number, j: number, u: number, v: number): number | null => {
  const h00 = heightAt(grid, i, j);
  const h10 = heightAt(grid, i + 1, j);
  const h01 = heightAt(grid, i, j + 1);
  const h11 = heightAt(grid, i + 1, j + 1);
  if (h00 == null || h10 == null || h01 == null || h11 == null) return null;
  const a = h00 * (1 - u) + h10 * u;
  const b = h01 * (1 - u) + h11 * u;
  return a * (1 - v) + b * v;
};

/**
 * Pick surface cell under CSS cursor via ray + heightfield walk.
 * Hit position is the ray intersection with the bilinear height patch (not cell center).
 * NaN / non-finite heights are non-pickable.
 */
export function pickSurface3D(
  grid: Surface3DPickGrid,
  viewProj: Mat4,
  cssX: number,
  cssY: number,
  viewportCssW: number,
  viewportCssH: number
): Surface3DPickHit | null {
  const cols = Math.floor(grid.columns);
  const rows = Math.floor(grid.rows);
  if (cols < 2 || rows < 2) return null;
  if (!(Number.isFinite(grid.xStep) && grid.xStep !== 0)) return null;
  if (!(Number.isFinite(grid.zStep) && grid.zStep !== 0)) return null;

  const inv = invertMat4(viewProj);
  if (!inv) return null;
  const ray = unprojectCssRay(inv, cssX, cssY, viewportCssW, viewportCssH);
  if (!ray) return null;

  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;

  // Grid XZ bounds
  const x0 = grid.xStart;
  const z0 = grid.zStart;
  const x1 = grid.xStart + (cols - 1) * grid.xStep;
  const z1 = grid.zStart + (rows - 1) * grid.zStep;
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);

  // If ray is nearly parallel to XZ plane, fall back to denser t samples
  const absDy = Math.abs(dy);

  let best: Surface3DPickHit | null = null;
  let bestT = Number.POSITIVE_INFINITY;

  // Sample along ray: project XZ hits onto grid by walking t range that covers AABB
  // Find t range where ray XZ is near the grid rect (slab on X and Z)
  const tCandidates: number[] = [];
  if (Math.abs(dx) > 1e-12) {
    tCandidates.push((minX - ox) / dx, (maxX - ox) / dx);
  }
  if (Math.abs(dz) > 1e-12) {
    tCandidates.push((minZ - oz) / dz, (maxZ - oz) / dz);
  }
  // Also sample y = mid height planes loosely
  tCandidates.push(0.01, 1, 10, 100);

  let tMin = Infinity;
  let tMax = -Infinity;
  for (const t of tCandidates) {
    if (!Number.isFinite(t) || t < 0) continue;
    const px = ox + dx * t;
    const pz = oz + dz * t;
    // Expand slightly
    if (
      px >= minX - Math.abs(grid.xStep) &&
      px <= maxX + Math.abs(grid.xStep) &&
      pz >= minZ - Math.abs(grid.zStep) &&
      pz <= maxZ + Math.abs(grid.zStep)
    ) {
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) {
    // Ray may start inside grid footprint
    tMin = 0;
    tMax = Math.hypot(maxX - minX, maxZ - minZ) * 4 + Math.abs(oy) * 4 + 10;
  }
  if (tMax < tMin) {
    const tmp = tMin;
    tMin = tMax;
    tMax = tmp;
  }
  tMin = Math.max(0, tMin - 1);
  tMax = Math.max(tMin + 1e-3, tMax + 1);

  // March along ray; for each sample find cell and refine height intersection
  const steps = Math.min(512, Math.max(64, (cols + rows) * 2));
  const dt = (tMax - tMin) / steps;

  for (let s = 0; s <= steps; s++) {
    const t = tMin + s * dt;
    const px = ox + dx * t;
    const py = oy + dy * t;
    const pz = oz + dz * t;
    if (px < minX || px > maxX || pz < minZ || pz > maxZ) continue;

    // Map to continuous cell coords
    const fi = (px - grid.xStart) / grid.xStep;
    const fj = (pz - grid.zStart) / grid.zStep;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    if (i < 0 || j < 0 || i >= cols - 1 || j >= rows - 1) continue;
    const u = fi - i;
    const v = fj - j;
    const h = bilinearHeight(grid, i, j, u, v);
    if (h == null) continue;

    // Vertical distance ray.y vs surface height
    const err = py - h;
    // Look for zero-crossing with next sample (or accept close hit)
    if (Math.abs(err) < Math.max(1e-4, Math.abs(h) * 1e-4 + Math.abs(dy) * dt * 2)) {
      if (t < bestT) {
        bestT = t;
        best = { i, j, x: px, y: h, z: pz, height: h, t };
      }
      continue;
    }

    if (s < steps) {
      const t2 = t + dt;
      const py2 = oy + dy * t2;
      const px2 = ox + dx * t2;
      const pz2 = oz + dz * t2;
      const fi2 = (px2 - grid.xStart) / grid.xStep;
      const fj2 = (pz2 - grid.zStart) / grid.zStep;
      const i2 = Math.floor(fi2);
      const j2 = Math.floor(fj2);
      if (i2 < 0 || j2 < 0 || i2 >= cols - 1 || j2 >= rows - 1) continue;
      const h2 = bilinearHeight(grid, i2, j2, fi2 - i2, fj2 - j2);
      if (h2 == null) continue;
      const err2 = py2 - h2;
      if (err * err2 > 0) continue; // no sign change
      // Linear interpolate zero crossing
      const denom = err - err2;
      const alpha = Math.abs(denom) > 1e-12 ? err / denom : 0.5;
      const tc = t + alpha * dt;
      const xc = ox + dx * tc;
      const zc = oz + dz * tc;
      const fic = (xc - grid.xStart) / grid.xStep;
      const fjc = (zc - grid.zStart) / grid.zStep;
      const ic = Math.max(0, Math.min(cols - 2, Math.floor(fic)));
      const jc = Math.max(0, Math.min(rows - 2, Math.floor(fjc)));
      const hc = bilinearHeight(grid, ic, jc, fic - ic, fjc - jc);
      if (hc == null) continue;
      if (tc >= 0 && tc < bestT) {
        bestT = tc;
        best = { i: ic, j: jc, x: xc, y: hc, z: zc, height: hc, t: tc };
      }
    }
  }

  // Orthographic-friendly path: when ray is nearly vertical, pick by XZ only
  if (!best && absDy > 0.85) {
    // Intersect y = 0 plane-ish: use XZ at t where ray is over grid mid
    const tMid = Math.abs(dy) > 1e-8 ? -oy / dy : tMin;
    const tUse = Number.isFinite(tMid) && tMid > 0 ? tMid : (tMin + tMax) * 0.5;
    const px = ox + dx * tUse;
    const pz = oz + dz * tUse;
    if (px >= minX && px <= maxX && pz >= minZ && pz <= maxZ) {
      const fi = (px - grid.xStart) / grid.xStep;
      const fj = (pz - grid.zStart) / grid.zStep;
      const i = Math.max(0, Math.min(cols - 2, Math.floor(fi)));
      const j = Math.max(0, Math.min(rows - 2, Math.floor(fj)));
      const h = bilinearHeight(grid, i, j, fi - i, fj - j);
      if (h != null) {
        // Move along ray to height
        const tH = Math.abs(dy) > 1e-8 ? (h - oy) / dy : tUse;
        if (tH >= 0) {
          best = {
            i,
            j,
            x: ox + dx * tH,
            y: h,
            z: oz + dz * tH,
            height: h,
            t: tH,
          };
        }
      }
    }
  }

  return best;
}
