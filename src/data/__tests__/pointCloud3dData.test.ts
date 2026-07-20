import { describe, it, expect, vi } from 'vitest';
import {
  packPointCloud3D,
  appendPackedPointCloud3D,
  pointCloud3dHasDrawableSample,
  POINT_CLOUD_GROW_MIN_CAPACITY,
  POINT_CLOUD_GROW_FACTOR,
} from '../pointCloud3dData';
import { packSurface3D, packSurface3DWireframeIndices, sanitizeSurface3DGrid } from '../surface3dData';

describe('packPointCloud3D', () => {
  it('packs split arrays and computes AABB', () => {
    const packed = packPointCloud3D({
      x: [0, 1, 2],
      y: [0, 1, 0],
      z: [0, 0, 1],
      value: [10, 20, 30],
    });
    expect(packed.count).toBe(3);
    expect(packed.packed.length).toBe(12);
    expect(packed.packed[0]).toBe(0);
    expect(packed.packed[3]).toBe(10);
    expect(packed.hasValue).toBe(true);
    expect(packed.valueMin).toBe(10);
    expect(packed.valueMax).toBe(30);
    expect(packed.aabb?.min[0]).toBe(0);
    expect(packed.aabb?.max[0]).toBe(2);
  });

  it('uses min length on mismatch and warns', () => {
    const warn = vi.fn();
    const packed = packPointCloud3D({ x: [1, 2, 3, 4], y: [0, 0], z: [0, 0, 0] }, { warn });
    expect(packed.count).toBe(2);
    expect(warn).toHaveBeenCalled();
  });

  it('skips leading nulls and non-finite without NaN in buffer', () => {
    const packed = packPointCloud3D([null, { x: Number.NaN, y: 0, z: 0 }, [1, 2, 3], { x: 4, y: 5, z: 6 }]);
    expect(packed.count).toBe(2);
    expect(packed.packed[0]).toBe(1);
    expect(packed.packed[4]).toBe(4);
    for (let i = 0; i < packed.packed.length; i++) {
      expect(Number.isFinite(packed.packed[i]!)).toBe(true);
    }
  });

  it('skips mid-array nulls and keeps later finite points', () => {
    const packed = packPointCloud3D([[0, 0, 0], null, [2, 2, 2]]);
    expect(packed.count).toBe(2);
    expect(packed.packed[0]).toBe(0);
    expect(packed.packed[4]).toBe(2);
  });

  it('skips mid-stream non-finite in split arrays', () => {
    const packed = packPointCloud3D({
      x: [1, Number.NaN, 3],
      y: [0, 0, 0],
      z: [0, 0, 0],
    });
    expect(packed.count).toBe(2);
    expect(packed.packed[0]).toBe(1);
    expect(packed.packed[4]).toBe(3);
  });

  it('packs interleaved Float32Array stride 3', () => {
    const src = new Float32Array([1, 2, 3, 4, 5, 6]);
    const packed = packPointCloud3D(src);
    expect(packed.count).toBe(2);
    expect(packed.packed[0]).toBe(1);
    expect(packed.packed[4]).toBe(4);
  });

  it('converts Float64Array element-wise (not bit-cast)', () => {
    const src = new Float64Array([1.5, 2.5, 3.5, 4.25, 5.25, 6.25]);
    const packed = packPointCloud3D(src);
    expect(packed.count).toBe(2);
    expect(packed.packed[0]).toBeCloseTo(1.5);
    expect(packed.packed[1]).toBeCloseTo(2.5);
    expect(packed.packed[2]).toBeCloseTo(3.5);
    expect(packed.packed[4]).toBeCloseTo(4.25);
  });

  it('skips non-finite in interleaved Float32Array', () => {
    const src = new Float32Array([1, 2, 3, Number.NaN, 0, 0, 7, 8, 9, Number.POSITIVE_INFINITY, 1, 1]);
    const packed = packPointCloud3D(src);
    expect(packed.count).toBe(2);
    expect(packed.packed[0]).toBe(1);
    expect(packed.packed[4]).toBe(7);
  });

  it('truncates interleaved length not multiple of 3', () => {
    const warn = vi.fn();
    const packed = packPointCloud3D(new Float32Array([1, 2, 3, 4, 5]), { warn });
    expect(packed.count).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it('DataView yields empty + warn', () => {
    const warn = vi.fn();
    const buf = new ArrayBuffer(24);
    const packed = packPointCloud3D(new DataView(buf), { warn });
    expect(packed.count).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DataView'));
  });

  it('short value channel warns and pads with 0', () => {
    const warn = vi.fn();
    const packed = packPointCloud3D({ x: [1, 2, 3], y: [0, 0, 0], z: [0, 0, 0], value: [9] }, { warn });
    expect(packed.count).toBe(3);
    expect(packed.packed[3]).toBe(9);
    expect(packed.packed[7]).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('value length'));
  });

  it('warns that data.size is ignored', () => {
    const warn = vi.fn();
    packPointCloud3D({ x: [0], y: [0], z: [0], size: [5] }, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('data.size'));
  });

  it('empty data is count 0', () => {
    const packed = packPointCloud3D({ x: [], y: [], z: [] });
    expect(packed.count).toBe(0);
    expect(packed.aabb).toBeNull();
  });

  it('all-null object array packs zero points', () => {
    const packed = packPointCloud3D([null, null, { x: Number.NaN, y: 1, z: 1 }]);
    expect(packed.count).toBe(0);
    expect(pointCloud3dHasDrawableSample([null, null])).toBe(false);
    expect(pointCloud3dHasDrawableSample([{ x: Number.NaN, y: 0, z: 0 }])).toBe(false);
    expect(pointCloud3dHasDrawableSample([{ x: 1, y: 2, z: 3 }])).toBe(true);
  });
});

describe('appendPackedPointCloud3D', () => {
  it('grows and preserves prefix', () => {
    const a = packPointCloud3D({ x: [0], y: [0], z: [0] });
    const b = appendPackedPointCloud3D(a.packed, a.count, { x: [1, 2], y: [1, 2], z: [1, 2] });
    expect(b.count).toBe(3);
    expect(b.packed[0]).toBe(0);
    expect(b.packed[4]).toBe(1);
    expect(b.packed[8]).toBe(2);
  });

  it('empty append preserves existing count and AABB', () => {
    const a = packPointCloud3D({ x: [1, 3], y: [0, 0], z: [0, 0] });
    const b = appendPackedPointCloud3D(a.packed, a.count, { x: [], y: [], z: [] });
    expect(b.count).toBe(2);
    expect(b.aabb?.min[0]).toBe(1);
    expect(b.aabb?.max[0]).toBe(3);
  });

  it('AABB expands with appended points', () => {
    const a = packPointCloud3D({ x: [0], y: [0], z: [0] });
    const b = appendPackedPointCloud3D(a.packed, a.count, { x: [10], y: [-5], z: [2] });
    expect(b.aabb?.min).toEqual([0, -5, 0]);
    expect(b.aabb?.max).toEqual([10, 0, 2]);
  });

  it('reuses buffer when capacity sufficient', () => {
    const cap = new Float32Array(64); // 16 points capacity
    cap[0] = 1;
    cap[1] = 2;
    cap[2] = 3;
    const next = appendPackedPointCloud3D(cap, 1, { x: [4], y: [5], z: [6] });
    expect(next.packed).toBe(cap);
    expect(next.count).toBe(2);
    expect(next.packed[4]).toBe(4);
  });

  it('reallocates with min capacity floor and 1.5× growth', () => {
    // existing length 0 → realloc path
    const empty = new Float32Array(0);
    const n = 20; // > POINT_CLOUD_GROW_MIN_CAPACITY
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    const zs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = i;
      ys[i] = 0;
      zs[i] = 0;
    }
    const next = appendPackedPointCloud3D(empty, 0, { x: xs, y: ys, z: zs });
    expect(next.count).toBe(n);
    // capacity in points >= max(min, grown)
    const capPoints = next.packed.length / 4;
    expect(capPoints).toBeGreaterThanOrEqual(POINT_CLOUD_GROW_MIN_CAPACITY);
    expect(capPoints).toBeGreaterThanOrEqual(n);
    // geometric: starting from MIN, grow by FACTOR until >= n
    let expected = POINT_CLOUD_GROW_MIN_CAPACITY;
    while (expected < n) expected = Math.ceil(expected * POINT_CLOUD_GROW_FACTOR);
    expect(capPoints).toBe(expected);
  });

  it('multi-append accumulates', () => {
    let p = packPointCloud3D({ x: [0], y: [0], z: [0] });
    p = appendPackedPointCloud3D(p.packed, p.count, { x: [1], y: [0], z: [0] });
    p = appendPackedPointCloud3D(p.packed, p.count, { x: [2], y: [0], z: [0] });
    expect(p.count).toBe(3);
  });

  it('value channel on append sets hasValue', () => {
    const a = packPointCloud3D({ x: [0], y: [0], z: [0], value: [1] });
    const b = appendPackedPointCloud3D(a.packed, a.count, { x: [1], y: [0], z: [0], value: [9] });
    expect(b.hasValue).toBe(true);
    expect(b.valueMax).toBeGreaterThanOrEqual(9);
  });

  // Durable seed / value-channel policy is unit-tested in cloudPackPolicy.test.ts
  // (production shouldInvalidateCloudPack used by createRenderCoordinator3D).

  it('maxPoints FIFO drops oldest on overflow', () => {
    let p = packPointCloud3D({ x: [0, 1, 2], y: [0, 0, 0], z: [0, 0, 0] });
    p = appendPackedPointCloud3D(p.packed, p.count, { x: [3, 4], y: [0, 0], z: [0, 0] }, { maxPoints: 4 });
    expect(p.count).toBe(4);
    // dropped 0; kept 1,2,3,4
    expect(p.packed[0]).toBe(1);
    expect(p.packed[4]).toBe(2);
    expect(p.packed[8]).toBe(3);
    expect(p.packed[12]).toBe(4);
  });

  it('maxPoints strict replace keeps batch tail', () => {
    const a = packPointCloud3D({ x: [0, 1], y: [0, 0], z: [0, 0] });
    const b = appendPackedPointCloud3D(
      a.packed,
      a.count,
      { x: [10, 11, 12, 13, 14], y: [0, 0, 0, 0, 0], z: [0, 0, 0, 0, 0] },
      { maxPoints: 3 }
    );
    expect(b.count).toBe(3);
    expect(b.packed[0]).toBe(12);
    expect(b.packed[4]).toBe(13);
    expect(b.packed[8]).toBe(14);
  });

  it('maxPoints empty append leaves count when under cap', () => {
    const a = packPointCloud3D({ x: [1, 2], y: [0, 0], z: [0, 0] });
    const b = appendPackedPointCloud3D(a.packed, a.count, { x: [], y: [], z: [] }, { maxPoints: 10 });
    expect(b.count).toBe(2);
  });

  it('maxPoints pure fill does not drop', () => {
    const a = packPointCloud3D({ x: [0], y: [0], z: [0] });
    const b = appendPackedPointCloud3D(a.packed, a.count, { x: [1], y: [0], z: [0] }, { maxPoints: 5 });
    expect(b.count).toBe(2);
    expect(b.packed[0]).toBe(0);
    expect(b.packed[4]).toBe(1);
  });

  it('equal-N strict-replace returns new buffer identity (forces GPU re-upload)', () => {
    const a = packPointCloud3D({ x: [0, 1, 2], y: [0, 0, 0], z: [0, 0, 0] });
    const b = appendPackedPointCloud3D(
      a.packed,
      a.count,
      { x: [10, 11, 12], y: [1, 1, 1], z: [2, 2, 2] },
      { maxPoints: 3 }
    );
    expect(b.count).toBe(3);
    expect(b.packed).not.toBe(a.packed);
    expect(b.packed[0]).toBe(10);
    expect(b.packed[4]).toBe(11);
    expect(b.packed[8]).toBe(12);
  });

  it('equal-N ring wrap returns new buffer identity', () => {
    const a = packPointCloud3D({ x: [0, 1, 2, 3], y: [0, 0, 0, 0], z: [0, 0, 0, 0] });
    const b = appendPackedPointCloud3D(a.packed, a.count, { x: [4, 5], y: [0, 0], z: [0, 0] }, { maxPoints: 4 });
    expect(b.count).toBe(4);
    expect(b.packed).not.toBe(a.packed);
    expect(b.packed[0]).toBe(2);
    expect(b.packed[12]).toBe(5);
  });
});

describe('packSurface3D', () => {
  it('builds mesh with correct vertex/index counts', () => {
    const columns = 4;
    const rows = 3;
    const y = new Float32Array(columns * rows);
    for (let i = 0; i < y.length; i++) y[i] = i;
    const packed = packSurface3D({
      xStart: 0,
      xStep: 1,
      zStart: 0,
      zStep: 1,
      columns,
      rows,
      y,
    });
    expect(packed).not.toBeNull();
    expect(packed!.vertexCount).toBe(columns * rows);
    expect(packed!.indexCount).toBe((columns - 1) * (rows - 1) * 6);
    expect(packed!.vertices[1]).toBe(0);
    expect(packed!.yMin).toBe(0);
    expect(packed!.yMax).toBe(y.length - 1);
    expect(packed!.aabb?.min[1]).toBe(0);
    expect(packed!.aabb?.max[1]).toBe(y.length - 1);
  });

  it('sanitize rejects columns < 2, rows < 2, and zero steps', () => {
    expect(
      sanitizeSurface3DGrid({
        xStart: 0,
        xStep: 1,
        zStart: 0,
        zStep: 1,
        columns: 1,
        rows: 5,
        y: new Float32Array(5),
      })
    ).toBeNull();
    expect(
      sanitizeSurface3DGrid({
        xStart: 0,
        xStep: 1,
        zStart: 0,
        zStep: 1,
        columns: 5,
        rows: 1,
        y: new Float32Array(5),
      })
    ).toBeNull();
    expect(
      sanitizeSurface3DGrid({
        xStart: 0,
        xStep: 0,
        zStart: 0,
        zStep: 1,
        columns: 3,
        rows: 3,
        y: new Float32Array(9),
      })
    ).toBeNull();
    expect(
      sanitizeSurface3DGrid({
        xStart: 0,
        xStep: 1,
        zStart: 0,
        zStep: 0,
        columns: 3,
        rows: 3,
        y: new Float32Array(9),
      })
    ).toBeNull();
  });

  it('wireframe indices count edges without diagonals', () => {
    const columns = 3;
    const rows = 2;
    const idx = packSurface3DWireframeIndices(columns, rows);
    // hEdges = rows*(columns-1)=4; vEdges = columns*(rows-1)=3; *2 indices
    expect(idx.length).toBe((4 + 3) * 2);
  });

  it('normals are unit-ish for a ramp', () => {
    const columns = 3;
    const rows = 3;
    const y = new Float32Array(columns * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) y[j * columns + i] = i; // ramp in X
    }
    const packed = packSurface3D({
      xStart: 0,
      xStep: 1,
      zStart: 0,
      zStep: 1,
      columns,
      rows,
      y,
    });
    expect(packed).not.toBeNull();
    // center vertex normal
    const vi = (1 * columns + 1) * 8;
    const nx = packed!.vertices[vi + 3]!;
    const ny = packed!.vertices[vi + 4]!;
    const nz = packed!.vertices[vi + 5]!;
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
    expect(nx).toBeLessThan(0); // slope +X → normal tips toward -X
  });

  it('short-y surface warns with length message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const packed = packSurface3D({
      xStart: 0,
      xStep: 1,
      zStart: 0,
      zStep: 1,
      columns: 3,
      rows: 3,
      y: [1, 2, 3],
    });
    expect(packed).not.toBeNull();
    expect(packed!.vertexCount).toBe(9);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('y length'));
    warn.mockRestore();
  });
});
