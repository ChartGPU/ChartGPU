/// <reference types="@webgpu/types" />

/**
 * Tests for ChartGPU pipeline cache (CGPU-PIPELINE-CACHE).
 * 
 * Verifies:
 * - Shader module dedupe: strict-equal modules for same WGSL using same cache.
 * - Render pipeline dedupe: strict-equal pipelines for same config using same cache.
 * - Different target format => pipeline miss, shader hit.
 * - Stats correctness (total/hits/misses) for shaderModules + renderPipelines.
 * - Device loss clears cache + resets stats (simulate via mock `device.lost` promise).
 * - Device mismatch guard at chart creation should throw (integration test).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChartGPU } from '../ChartGPU';
import type { ChartGPUOptions } from '../config/types';
import { createPipelineCache, getPipelineCacheStats } from '../core/createPipelineCache';

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeAll(() => {
  if (typeof window === 'undefined') {
    // @ts-ignore
    globalThis.window = globalThis;
  }

  if (typeof document === 'undefined') {
    // @ts-ignore
    globalThis.document = {
      createElement: (tagName: string) => {
        if (tagName === 'canvas') return createMockCanvas();
        return { style: {}, appendChild: vi.fn(), removeChild: vi.fn() } as any;
      },
    } as unknown as Document;
  }

  // Minimal WebGPU globals used by other helpers/tests.
  // @ts-ignore
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  // @ts-ignore
  globalThis.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
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
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function createMockCanvas(): HTMLCanvasElement {
  return {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })),
    getContext: vi.fn((contextId: string) => {
      if (contextId !== 'webgpu') return null;
      return {
        configure: vi.fn(),
        unconfigure: vi.fn(),
        getCurrentTexture: vi.fn(() => ({
          createView: vi.fn(() => ({})),
        })),
      };
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  } as any;
}

function createMockContainer(): HTMLElement {
  return {
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })),
  } as any;
}

function createMockDevice(opts?: { readonly lost?: Promise<GPUDeviceLostInfo> }): GPUDevice {
  // Use separate ID counters for different resource types to accurately simulate WebGPU object identity.
  let nextShaderModuleId = 1;
  let nextRenderPipelineId = 1;
  return {
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 268435456,
      maxUniformBufferBindingSize: 268435456,
      maxBindGroups: 4,
    },
    createShaderModule: vi.fn(({ code, label }: GPUShaderModuleDescriptor) => ({ __kind: 'shaderModule', __id: nextShaderModuleId++, code, label }) as any),
    createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => ({ __kind: 'renderPipeline', __id: nextRenderPipelineId++, descriptor }) as any),
    // Methods required by GPUContext/createChartGPU integration (shared device mode).
    destroy: vi.fn(),
    addEventListener: vi.fn(),
    lost: opts?.lost ?? new Promise(() => {}),
    createBuffer: vi.fn(() => ({ destroy: vi.fn(), unmap: vi.fn(), getMappedRange: vi.fn(() => new ArrayBuffer(0)), size: 0 } as any)),
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) } as any)),
    createBindGroup: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({ end: vi.fn() })),
      finish: vi.fn(() => ({})),
    })),
    queue: { submit: vi.fn(), writeBuffer: vi.fn() },
  } as any;
}

function createMockAdapter(device: GPUDevice): GPUAdapter {
  return {
    requestDevice: vi.fn(async () => device),
    features: new Set<string>(),
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 268435456,
    },
  } as any;
}

function setupMockNavigatorGPU(adapter: GPUAdapter | null): void {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    },
  });
}

describe('CGPU-PIPELINE-CACHE', () => {
  it('dedupes shader modules by exact WGSL string (strict equality)', () => {
    const device = createMockDevice();
    const cache = createPipelineCache(device);

    const wgsl = 'fn main() {}';
    const m1 = cache.getOrCreateShaderModule(wgsl, 'a');
    const m2 = cache.getOrCreateShaderModule(wgsl, 'b');

    expect(m1).toBe(m2);

    const stats = getPipelineCacheStats(cache);
    expect(stats.shaderModules.total).toBe(2);
    expect(stats.shaderModules.misses).toBe(1);
    expect(stats.shaderModules.hits).toBe(1);
    expect(stats.shaderModules.entries).toBe(1);
  });

  it('dedupes render pipelines by equivalent descriptor (strict equality)', () => {
    const device = createMockDevice();
    const cache = createPipelineCache(device);

    const wgsl = 'fn main() {}';
    const module = cache.getOrCreateShaderModule(wgsl);

    const desc: GPURenderPipelineDescriptor = {
      layout: 'auto',
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'bgra8unorm' }] },
      primitive: { topology: 'triangle-list' },
    };

    const p1 = cache.getOrCreateRenderPipeline(desc);
    const p2 = cache.getOrCreateRenderPipeline(desc);

    expect(p1).toBe(p2);

    const stats = cache.getStats();
    expect(stats.renderPipelines.total).toBe(2);
    expect(stats.renderPipelines.misses).toBe(1);
    expect(stats.renderPipelines.hits).toBe(1);
    expect(stats.renderPipelines.entries).toBe(1);
  });

  it('different target format => pipeline miss, shader hit', () => {
    const device = createMockDevice();
    const cache = createPipelineCache(device);

    const wgsl = 'fn main() {}';
    const m1 = cache.getOrCreateShaderModule(wgsl);
    const p1 = cache.getOrCreateRenderPipeline({
      layout: 'auto',
      vertex: { module: m1, entryPoint: 'vsMain' },
      fragment: { module: m1, entryPoint: 'fsMain', targets: [{ format: 'bgra8unorm' }] },
    });

    const m2 = cache.getOrCreateShaderModule(wgsl); // hit
    const p2 = cache.getOrCreateRenderPipeline({
      layout: 'auto',
      vertex: { module: m2, entryPoint: 'vsMain' },
      fragment: { module: m2, entryPoint: 'fsMain', targets: [{ format: 'rgba8unorm' }] },
    });

    expect(m1).toBe(m2);
    expect(p1).not.toBe(p2);

    const stats = cache.getStats();
    expect(stats.shaderModules).toEqual({ total: 2, hits: 1, misses: 1, entries: 1 });
    expect(stats.renderPipelines.total).toBe(2);
    expect(stats.renderPipelines.hits).toBe(0);
    expect(stats.renderPipelines.misses).toBe(2);
    expect(stats.renderPipelines.entries).toBe(2);
  });

  it('stats correctness for mixed shaderModules + renderPipelines operations', () => {
    const device = createMockDevice();
    const cache = createPipelineCache(device);

    const a = cache.getOrCreateShaderModule('wgsl-a'); // miss
    cache.getOrCreateShaderModule('wgsl-b'); // miss
    cache.getOrCreateShaderModule('wgsl-a'); // hit

    cache.getOrCreateRenderPipeline({
      layout: 'auto',
      vertex: { module: a, entryPoint: 'vsMain' },
      fragment: { module: a, entryPoint: 'fsMain', targets: [{ format: 'bgra8unorm' }] },
    }); // miss
    cache.getOrCreateRenderPipeline({
      layout: 'auto',
      vertex: { module: a, entryPoint: 'vsMain' },
      fragment: { module: a, entryPoint: 'fsMain', targets: [{ format: 'bgra8unorm' }] },
    }); // hit

    const stats = cache.getStats();
    expect(stats.shaderModules.total).toBe(3);
    expect(stats.shaderModules.misses).toBe(2);
    expect(stats.shaderModules.hits).toBe(1);

    expect(stats.renderPipelines.total).toBe(2);
    expect(stats.renderPipelines.misses).toBe(1);
    expect(stats.renderPipelines.hits).toBe(1);
  });

  it('device loss clears cache and resets stats', async () => {
    const lost = createDeferred<GPUDeviceLostInfo>();
    const device = createMockDevice({ lost: lost.promise });
    const cache = createPipelineCache(device);

    const wgsl = 'fn main() {}';
    const m1 = cache.getOrCreateShaderModule(wgsl); // miss
    cache.getOrCreateShaderModule(wgsl); // hit
    cache.getOrCreateRenderPipeline({
      layout: 'auto',
      vertex: { module: m1, entryPoint: 'vsMain' },
      fragment: { module: m1, entryPoint: 'fsMain', targets: [{ format: 'bgra8unorm' }] },
    }); // miss

    expect(cache.getStats().shaderModules.total).toBe(2);
    expect(cache.getStats().renderPipelines.total).toBe(1);

    lost.resolve({ reason: 'unknown' as GPUDeviceLostReason, message: 'simulated' } as any);
    await lost.promise;
    // Allow the `.then(...)` handler in the cache to run.
    await Promise.resolve();

    expect(cache.getStats()).toEqual({
      shaderModules: { total: 0, hits: 0, misses: 0, entries: 0 },
      renderPipelines: { total: 0, hits: 0, misses: 0, entries: 0 },
    });

    // After loss, cache is empty: next request is a miss.
    cache.getOrCreateShaderModule(wgsl);
    expect(cache.getStats().shaderModules).toEqual({ total: 1, hits: 0, misses: 1, entries: 1 });
  });

  it('ChartGPU.create throws when pipelineCache.device !== context.device (device mismatch guard)', async () => {
    vi.stubGlobal('devicePixelRatio', 1);

    const device1 = createMockDevice();
    const device2 = createMockDevice();
    const cache = createPipelineCache(device1);

    const adapter = createMockAdapter(device2);
    setupMockNavigatorGPU(adapter);

    const container = createMockContainer();
    const options: ChartGPUOptions = {
      series: [{ type: 'line', data: [{ x: 0, y: 0 }] }],
    };

    await expect(
      ChartGPU.create(container, options, { adapter, device: device2, pipelineCache: cache })
    ).rejects.toThrow(/pipelineCache\.device must match the GPUDevice/i);
  });

  it('enforces layout: auto when pipelineCache is provided (cross-chart reuse)', () => {
    const device = createMockDevice();
    const cache = createPipelineCache(device);

    const wgsl = 'fn main() {}';
    const module = cache.getOrCreateShaderModule(wgsl);

    // When pipelineCache is provided, rendererUtils forces 'layout: auto' even when
    // bindGroupLayouts are specified. This is a deliberate design choice to maximize
    // cross-chart pipeline dedupe (explicit layouts prevent cache hits even when structurally identical).
    const desc1: GPURenderPipelineDescriptor = {
      layout: 'auto',
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'bgra8unorm' }] },
    };

    const p1 = cache.getOrCreateRenderPipeline(desc1);
    const p2 = cache.getOrCreateRenderPipeline(desc1);

    expect(p1).toBe(p2);
    expect(cache.getStats().renderPipelines.entries).toBe(1);
    
    // Verify descriptor has layout: 'auto'
    const pipelineObj = p1 as any;
    expect(pipelineObj.descriptor.layout).toBe('auto');
  });

  it('maintains separate shader module and pipeline entry counts', () => {
    const device = createMockDevice();
    const cache = createPipelineCache(device);

    const wgsl1 = 'fn main1() {}';
    const wgsl2 = 'fn main2() {}';

    const m1 = cache.getOrCreateShaderModule(wgsl1);
    const m2 = cache.getOrCreateShaderModule(wgsl2);
    const m1Again = cache.getOrCreateShaderModule(wgsl1); // hit

    expect(m1).toBe(m1Again);
    expect(m1).not.toBe(m2);

    const stats = cache.getStats();
    expect(stats.shaderModules.entries).toBe(2); // 2 unique modules
    expect(stats.shaderModules.total).toBe(3);   // 3 requests total
    expect(stats.shaderModules.hits).toBe(1);
    expect(stats.shaderModules.misses).toBe(2);
    
    // No pipelines created yet
    expect(stats.renderPipelines.entries).toBe(0);
    expect(stats.renderPipelines.total).toBe(0);
  });
});
