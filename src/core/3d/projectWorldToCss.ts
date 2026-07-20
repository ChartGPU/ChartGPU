/**
 * Project world XYZ through a view-projection matrix to CSS pixel coordinates.
 * Shared by 3D pick, axis labels, and hit-test.
 */

import { transformPoint, type Mat4 } from './mat4';

export type CssProjection = Readonly<{
  readonly x: number;
  readonly y: number;
  /** True when clip.w is usable and NDC is roughly in front of the camera. */
  readonly visible: boolean;
  readonly ndcX: number;
  readonly ndcY: number;
  readonly ndcZ: number;
  readonly clipW: number;
}>;

/**
 * World → CSS px (origin top-left of the canvas CSS box).
 * `visible` is false when behind camera or clip.w is degenerate.
 */
export function projectWorldToCss(
  viewProj: Mat4,
  worldX: number,
  worldY: number,
  worldZ: number,
  viewportCssW: number,
  viewportCssH: number
): CssProjection {
  const clip = transformPoint(viewProj, worldX, worldY, worldZ);
  const w = clip[3];
  if (!(Math.abs(w) > 1e-8)) {
    return { x: 0, y: 0, visible: false, ndcX: 0, ndcY: 0, ndcZ: 0, clipW: w };
  }
  const ndcX = clip[0] / w;
  const ndcY = clip[1] / w;
  const ndcZ = clip[2] / w;
  const x = (ndcX * 0.5 + 0.5) * viewportCssW;
  const y = (1 - (ndcY * 0.5 + 0.5)) * viewportCssH;
  // Soft frustum: slightly padded NDC so edge labels still project
  const visible =
    w > 0 && ndcX >= -1.25 && ndcX <= 1.25 && ndcY >= -1.25 && ndcY <= 1.25 && ndcZ >= -0.05 && ndcZ <= 1.05;
  return { x, y, visible, ndcX, ndcY, ndcZ, clipW: w };
}

/**
 * Unproject a CSS pixel to a world-space ray (origin + unit direction).
 * Uses inverse(viewProj) with NDC z = 0 (near) and z = 1 (far).
 */
export function unprojectCssRay(
  invViewProj: Mat4,
  cssX: number,
  cssY: number,
  viewportCssW: number,
  viewportCssH: number
): { readonly origin: readonly [number, number, number]; readonly dir: readonly [number, number, number] } | null {
  if (!(viewportCssW > 0) || !(viewportCssH > 0)) return null;
  const ndcX = (cssX / viewportCssW) * 2 - 1;
  const ndcY = 1 - (cssY / viewportCssH) * 2;

  const near = transformPoint(invViewProj, ndcX, ndcY, 0);
  const far = transformPoint(invViewProj, ndcX, ndcY, 1);
  if (!(Math.abs(near[3]) > 1e-8) || !(Math.abs(far[3]) > 1e-8)) return null;
  const ox = near[0] / near[3];
  const oy = near[1] / near[3];
  const oz = near[2] / near[3];
  const fx = far[0] / far[3];
  const fy = far[1] / far[3];
  const fz = far[2] / far[3];
  let dx = fx - ox;
  let dy = fy - oy;
  let dz = fz - oz;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-12)) return null;
  dx /= len;
  dy /= len;
  dz /= len;
  return { origin: [ox, oy, oz], dir: [dx, dy, dz] };
}
