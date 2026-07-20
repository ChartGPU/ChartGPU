import { describe, it, expect } from 'vitest';
import { generateSurface3DContours, resolveContourLevels, contourVertexCount } from '../surface3dContours';

describe('surface3dContours', () => {
  it('resolveContourLevels count produces interior levels', () => {
    const levels = resolveContourLevels(3, 0, 10);
    expect(levels).toHaveLength(3);
    expect(levels[0]!).toBeGreaterThan(0);
    expect(levels[2]!).toBeLessThan(10);
  });

  it('resolveContourLevels explicit array filters non-finite', () => {
    expect(resolveContourLevels([1, Number.NaN, 3], 0, 10)).toEqual([1, 3]);
  });

  it('flat field yields no segments', () => {
    const y = new Float32Array(4 * 4).fill(1);
    const segs = generateSurface3DContours({ xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: 4, rows: 4, y }, [1]);
    // All corners equal to level → mask 15 or 0 depending on >= ; may be empty
    expect(contourVertexCount(segs)).toBe(0);
  });

  it('ramp field produces isoline segments', () => {
    const cols = 8;
    const rows = 8;
    const y = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        y[j * cols + i] = i; // ramp in X
      }
    }
    const levels = resolveContourLevels(4, 0, 7);
    const segs = generateSurface3DContours(
      { xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: cols, rows, y },
      levels
    );
    expect(contourVertexCount(segs)).toBeGreaterThan(0);
    expect(segs.length % 6).toBe(0); // pairs of xyz
  });

  it('empty levels → empty buffer', () => {
    const y = new Float32Array(4).fill(0);
    const segs = generateSurface3DContours({ xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: 2, rows: 2, y }, []);
    expect(segs.length).toBe(0);
  });
});
