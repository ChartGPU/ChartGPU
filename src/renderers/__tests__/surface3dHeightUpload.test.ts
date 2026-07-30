/**
 * surface3d height-only GPU upload path.
 * Asserts 4 B/cell writeBuffer, STORAGE usage, index retain, wire toggle without re-upload.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

beforeAll(() => {
  // @ts-ignore
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  // @ts-ignore
  globalThis.GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
  };
  // @ts-ignore
  globalThis.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
});

import { createSurface3DRenderer } from '../createSurface3DRenderer';
import type { ResolvedSurface3DSeriesConfig } from '../../config/OptionResolver';
import { createMat4 } from '../../core/3d/mat4';

function createMockDevice(limits?: { maxStorageBufferBindingSize?: number; maxBufferSize?: number }): GPUDevice {
  const writeBuffer = vi.fn();
  const buffers: Array<{ size: number; usage: number; destroy: ReturnType<typeof vi.fn> }> = [];
  return {
    label: 'mockDevice',
    limits: {
      maxUniformBufferBindingSize: 65536,
      maxStorageBufferBindingSize: limits?.maxStorageBufferBindingSize ?? 134217728,
      maxBufferSize: limits?.maxBufferSize ?? 268435456,
    },
    queue: {
      writeBuffer,
      writeTexture: vi.fn(),
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(),
    },
    createBuffer: vi.fn((desc: GPUBufferDescriptor) => {
      const buf = {
        size: desc.size ?? 0,
        usage: desc.usage ?? 0,
        destroy: vi.fn(),
        mapAsync: vi.fn(),
        getMappedRange: vi.fn(),
        unmap: vi.fn(),
      };
      buffers.push(buf);
      return buf;
    }),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({
      destroy: vi.fn(),
      createView: vi.fn(() => ({})),
    })),
    __buffers: buffers,
    __writeBuffer: writeBuffer,
  } as unknown as GPUDevice & {
    __buffers: typeof buffers;
    __writeBuffer: ReturnType<typeof vi.fn>;
  };
}

function makeSeries(
  y: Float32Array,
  columns: number,
  rows: number,
  extras: Partial<ResolvedSurface3DSeriesConfig> = {}
): ResolvedSurface3DSeriesConfig {
  return {
    type: 'surface3d',
    name: 's',
    visible: true,
    data: {
      xStart: 0,
      xStep: 1,
      zStart: 0,
      zStep: 1,
      columns,
      rows,
      y,
    },
    colormap: 'viridis',
    yMin: -0.4,
    yMax: 0.4,
    yDomainExplicit: true,
    wireframe: false,
    opacity: 1,
    lighting: 0.65,
    color: '#fff',
    drawable: true,
    contours: {
      show: false,
      levels: 12,
      color: '#e2e8f0',
      width: 1.5,
      opacity: 0.85,
    },
    ...extras,
  };
}

describe('surface3d height-only upload', () => {
  it('uploads n*4 height bytes with STORAGE|COPY_DST buffer (not 32 B/vertex interleave)', () => {
    const device = createMockDevice() as GPUDevice & {
      __buffers: Array<{ size: number; usage: number }>;
      __writeBuffer: ReturnType<typeof vi.fn>;
    };
    const renderer = createSurface3DRenderer(device);
    const columns = 4;
    const rows = 3;
    const n = columns * rows;
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = i * 0.1;

    renderer.prepare(makeSeries(y, columns, rows), { viewProj: createMat4() });

    expect(renderer.getUploadCount()).toBe(1);
    expect(renderer.hasGeometry()).toBe(true);

    // Height storage buffer
    const heightBufs = device.__buffers.filter((b) => (b.usage & GPUBufferUsage.STORAGE) !== 0);
    expect(heightBufs.length).toBeGreaterThanOrEqual(1);
    expect(heightBufs[0]!.size).toBeGreaterThanOrEqual(n * 4);

    // At least one writeBuffer of exactly n*4 for heights
    const heightWrites = device.__writeBuffer.mock.calls.filter((c) => c[4] === n * 4);
    expect(heightWrites.length).toBeGreaterThanOrEqual(1);

    // Must not upload 32 B/vertex interleave as the primary height path
    const fullInterleave = n * 32;
    const hugeVertexWrites = device.__writeBuffer.mock.calls.filter((c) => c[4] === fullInterleave);
    expect(hugeVertexWrites.length).toBe(0);

    renderer.dispose();
  });

  it('new data wrapper + same y identity still re-uploads heights', () => {
    const device = createMockDevice() as GPUDevice & { __writeBuffer: ReturnType<typeof vi.fn> };
    const renderer = createSurface3DRenderer(device);
    const columns = 3;
    const rows = 3;
    const y = new Float32Array(9).fill(1);
    const s1 = makeSeries(y, columns, rows);
    const s2 = makeSeries(y, columns, rows); // new data object, same y ref
    expect(s1.data).not.toBe(s2.data);
    expect(s1.data.y).toBe(s2.data.y);

    const vp = { viewProj: createMat4() };
    renderer.prepare(s1, vp);
    expect(renderer.getUploadCount()).toBe(1);
    renderer.prepare(s2, vp);
    expect(renderer.getUploadCount()).toBe(2);

    renderer.dispose();
  });

  it('second prepare with same refs does not re-upload heights', () => {
    const device = createMockDevice();
    const renderer = createSurface3DRenderer(device);
    const y = new Float32Array(9).fill(0.5);
    const series = makeSeries(y, 3, 3);
    const vp = { viewProj: createMat4() };
    renderer.prepare(series, vp);
    expect(renderer.getUploadCount()).toBe(1);
    renderer.prepare(series, vp);
    expect(renderer.getUploadCount()).toBe(1);
    renderer.dispose();
  });

  it('wireframe toggle does not re-upload heights', () => {
    const device = createMockDevice();
    const renderer = createSurface3DRenderer(device);
    const y = new Float32Array(9).fill(0.2);
    const solid = makeSeries(y, 3, 3, { wireframe: false });
    // Same data identity for wire toggle (style-only)
    const wire = { ...solid, wireframe: true };
    const vp = { viewProj: createMat4() };
    renderer.prepare(solid, vp);
    expect(renderer.getUploadCount()).toBe(1);
    renderer.prepare(wire, vp);
    expect(renderer.getUploadCount()).toBe(1); // heights unchanged
    renderer.dispose();
  });

  it('soft-fails when height field exceeds maxStorageBufferBindingSize', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 2x2 grid = 16 bytes; limit 8 bytes → fail
    const device = createMockDevice({ maxStorageBufferBindingSize: 8, maxBufferSize: 8 });
    const renderer = createSurface3DRenderer(device);
    const y = new Float32Array(4).fill(1);
    renderer.prepare(makeSeries(y, 2, 2), { viewProj: createMat4() });
    expect(renderer.hasGeometry()).toBe(false);
    expect(renderer.getUploadCount()).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    renderer.dispose();
  });
});
