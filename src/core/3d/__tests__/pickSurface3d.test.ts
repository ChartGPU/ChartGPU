import { describe, it, expect } from 'vitest';
import { createMat4, lookAt, multiplyMat4, orthographic } from '../mat4';
import { pickSurface3D } from '../pickSurface3d';

/** Ortho looking straight down +Y at grid center — reliable for tests. */
function viewProjTopDown(): Float32Array {
  const view = createMat4();
  // Eye above center of [0,2]x[0,2] XZ grid
  lookAt(view, [1, 5, 1], [1, 0, 1], [0, 0, -1]);
  const proj = createMat4();
  orthographic(proj, 2, 1, 0.1, 20);
  return multiplyMat4(createMat4(), proj, view);
}

describe('pickSurface3D', () => {
  it('hits a flat heightfield under center pixel', () => {
    const y = new Float32Array(3 * 3).fill(0);
    y[1 * 3 + 1] = 0.5;
    const grid = {
      xStart: 0,
      xStep: 1,
      zStart: 0,
      zStep: 1,
      columns: 3,
      rows: 3,
      y,
    };
    const vp = viewProjTopDown();
    // Center of viewport projects to ~ grid center (1, *, 1)
    const hit = pickSurface3D(grid, vp, 128, 128, 256, 256);
    expect(hit).not.toBeNull();
    expect(hit!.i).toBeGreaterThanOrEqual(0);
    expect(hit!.j).toBeGreaterThanOrEqual(0);
    expect(hit!.i).toBeLessThan(2);
    expect(hit!.j).toBeLessThan(2);
    expect(Number.isFinite(hit!.height)).toBe(true);
    expect(hit!.t).toBeGreaterThanOrEqual(0);
  });

  it('returns null for non-finite only grid', () => {
    const y = new Float32Array(4).fill(Number.NaN);
    const hit = pickSurface3D(
      { xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: 2, rows: 2, y },
      viewProjTopDown(),
      128,
      128,
      256,
      256
    );
    expect(hit).toBeNull();
  });

  it('rejects columns < 2', () => {
    const hit = pickSurface3D(
      { xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: 1, rows: 5, y: new Float32Array(5) },
      viewProjTopDown(),
      10,
      10,
      100,
      100
    );
    expect(hit).toBeNull();
  });
});
