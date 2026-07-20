/**
 * Axis-aligned bounding box helpers for 3D series world bounds.
 */

import type { Vec3 } from './mat4';

export type AABB = Readonly<{
  readonly min: Vec3;
  readonly max: Vec3;
}>;

export const emptyAABB = (): { min: [number, number, number]; max: [number, number, number] } => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});

export const isValidAABB = (b: AABB): boolean =>
  Number.isFinite(b.min[0]) &&
  Number.isFinite(b.min[1]) &&
  Number.isFinite(b.min[2]) &&
  Number.isFinite(b.max[0]) &&
  Number.isFinite(b.max[1]) &&
  Number.isFinite(b.max[2]) &&
  b.min[0] <= b.max[0] &&
  b.min[1] <= b.max[1] &&
  b.min[2] <= b.max[2];

export const expandAABBPoint = (
  b: { min: [number, number, number]; max: [number, number, number] },
  x: number,
  y: number,
  z: number
): void => {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (x < b.min[0]) b.min[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x;
  if (y > b.max[1]) b.max[1] = y;
  if (z > b.max[2]) b.max[2] = z;
};

export const expandAABB = (b: { min: [number, number, number]; max: [number, number, number] }, other: AABB): void => {
  expandAABBPoint(b, other.min[0], other.min[1], other.min[2]);
  expandAABBPoint(b, other.max[0], other.max[1], other.max[2]);
};

export const aabbCenter = (b: AABB): Vec3 => [
  (b.min[0] + b.max[0]) * 0.5,
  (b.min[1] + b.max[1]) * 0.5,
  (b.min[2] + b.max[2]) * 0.5,
];

export const aabbSize = (b: AABB): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

/** Longest half-diagonal of the AABB (for camera distance fit). */
export const aabbHalfDiagonal = (b: AABB): number => {
  const s = aabbSize(b);
  const dx = Math.max(s[0], 1e-6);
  const dy = Math.max(s[1], 1e-6);
  const dz = Math.max(s[2], 1e-6);
  return 0.5 * Math.hypot(dx, dy, dz);
};

/** Degenerate / empty → unit box at origin. */
export const sanitizeAABB = (b: AABB | null | undefined): AABB => {
  if (b && isValidAABB(b)) {
    // Expand zero-thickness axes so camera has something to frame.
    const min: [number, number, number] = [b.min[0], b.min[1], b.min[2]];
    const max: [number, number, number] = [b.max[0], b.max[1], b.max[2]];
    for (let i = 0; i < 3; i++) {
      if (max[i]! - min[i]! < 1e-9) {
        min[i] = min[i]! - 0.5;
        max[i] = max[i]! + 0.5;
      }
    }
    return { min, max };
  }
  return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
};
