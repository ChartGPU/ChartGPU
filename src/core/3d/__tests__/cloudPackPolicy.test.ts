import { describe, it, expect } from 'vitest';
import {
  resolveCloudValueChannelIdentity,
  shouldInvalidateCloudPack,
  shouldKeepCloudPack,
  type CloudPackSeed,
} from '../cloudPackPolicy';
import { appendPackedPointCloud3D, packPointCloud3D } from '../../../data/pointCloud3dData';

describe('cloudPackPolicy', () => {
  const dataA = { x: [0, 1], y: [0, 1], z: [0, 1], value: [1, 2] };
  const dataB = { x: [9], y: [9], z: [9] };
  const valuesA = new Float32Array([10, 20]);
  const valuesB = new Float32Array([30, 40]);

  it('keeps pack when data and value channel identities match', () => {
    const prev: CloudPackSeed = { data: dataA, valueChannel: valuesA };
    const next: CloudPackSeed = { data: dataA, valueChannel: valuesA };
    expect(shouldKeepCloudPack(prev, next)).toBe(true);
    expect(shouldInvalidateCloudPack(prev, next)).toBe(false);
  });

  it('invalidates when data identity changes', () => {
    const prev: CloudPackSeed = { data: dataA, valueChannel: null };
    const next: CloudPackSeed = { data: dataB, valueChannel: null };
    expect(shouldInvalidateCloudPack(prev, next)).toBe(true);
  });

  it('invalidates when colorBy.values identity changes under same data', () => {
    const prev: CloudPackSeed = { data: dataA, valueChannel: valuesA };
    const next: CloudPackSeed = { data: dataA, valueChannel: valuesB };
    expect(shouldInvalidateCloudPack(prev, next)).toBe(true);
  });

  it('invalidates when data.value identity changes under same data object', () => {
    const mutated: { x: number[]; y: number[]; z: number[]; value: ArrayLike<number> } = {
      x: [0],
      y: [0],
      z: [0],
      value: [1],
    };
    const p0: CloudPackSeed = {
      data: mutated,
      valueChannel: resolveCloudValueChannelIdentity(mutated),
    };
    const newVal = [2];
    mutated.value = newVal;
    const p1: CloudPackSeed = {
      data: mutated,
      valueChannel: resolveCloudValueChannelIdentity(mutated),
    };
    expect(shouldInvalidateCloudPack(p0, p1)).toBe(true);
  });

  it('null previous always invalidates', () => {
    expect(shouldInvalidateCloudPack(null, { data: dataA, valueChannel: null })).toBe(true);
  });

  it('resolveCloudValueChannelIdentity prefers colorBy.values', () => {
    const data = { x: [0], y: [0], z: [0], value: [1] };
    expect(resolveCloudValueChannelIdentity(data, valuesA)).toBe(valuesA);
    expect(resolveCloudValueChannelIdentity(data)).toBe(data.value);
    expect(resolveCloudValueChannelIdentity(new Float32Array([0, 0, 0]))).toBeNull();
  });

  it('same data + new colorBy.values re-packs w channel', () => {
    const data = { x: [0, 1], y: [0, 0], z: [0, 0] };
    const v1 = new Float32Array([1, 2]);
    const v2 = new Float32Array([7, 8]);
    let seed: CloudPackSeed = {
      data,
      valueChannel: resolveCloudValueChannelIdentity(data, v1),
    };
    let packed = packPointCloud3D(data, { valueOverride: v1 });
    expect(packed.packed[3]).toBe(1);

    const nextSeed: CloudPackSeed = {
      data,
      valueChannel: resolveCloudValueChannelIdentity(data, v2),
    };
    expect(shouldInvalidateCloudPack(seed, nextSeed)).toBe(true);
    packed = packPointCloud3D(data, { valueOverride: v2 });
    seed = nextSeed;
    expect(shouldKeepCloudPack(seed, nextSeed)).toBe(true);
    expect(packed.packed[3]).toBe(7);
    expect(packed.packed[7]).toBe(8);
  });

  it('durable append: keep when only theme changes (same data + value)', () => {
    const data = { x: [0], y: [0], z: [0] };
    let packed = packPointCloud3D(data);
    packed = appendPackedPointCloud3D(packed.packed, packed.count, { x: [1], y: [1], z: [1] });
    const seed: CloudPackSeed = { data, valueChannel: null };
    expect(shouldKeepCloudPack(seed, { data, valueChannel: null })).toBe(true);
    expect(packed.count).toBe(2);
  });
});
