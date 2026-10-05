/// <reference types="@webgpu/types" />

/** Tests for performance metrics memory reporting (issue #227): no hardcoded zeros. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { ChartGPU } from '../ChartGPU';
import type { ChartGPUOptions } from '../config/types';

beforeAll(() => {
  if (typeof window === 'undefined') globalThis.window = globalThis as any;
  if (typeof document === 'undefined') {
    (globalThis as any).document = {
      createElement: ((tagName: string) =>
        tagName === 'canvas' ? createMockCanvas() : createMockElement()) as Document['createElement'],
    };
  }
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  globalThis.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
    TRANSIENT_ATTACHMENT: 0x20,
  };
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
    getContext: vi.fn((contextId: string) =>
      contextId === 'webgpu'
        ? {
            configure: vi.fn(),
            unconfigure: vi.fn(),
            getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
          }
        : null
    ),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  } as any;
}

function createMockElement(): HTMLElement {
  return { style: {}, appendChild: vi.fn(), removeChild: vi.fn() } as any;
}

/** Mock GPUDevice whose `createBuffer` records the descriptor size (`GPUBuffer.size`). */
function createMockDevice(): GPUDevice {
  return {
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 268435456,
      maxUniformBufferBindingSize: 268435456,
      maxBindGroups: 4,
    },
    destroy: vi.fn(),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({
      destroy: vi.fn(),
      unmap: vi.fn(),
      getMappedRange: vi.fn(() => new ArrayBuffer(0)),
      size: descriptor.size,
    })),
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    createBindGroup: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({
        end: vi.fn(),
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        setScissorRect: vi.fn(),
        setViewport: vi.fn(),
        draw: vi.fn(),
        drawIndexed: vi.fn(),
      })),
      beginComputePass: vi.fn(() => ({
        end: vi.fn(),
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
      })),
      finish: vi.fn(() => ({})),
      copyBufferToBuffer: vi.fn(),
      clearBuffer: vi.fn(),
    })),
    queue: { submit: vi.fn(), writeBuffer: vi.fn() },
    addEventListener: vi.fn(),
    lost: new Promise(() => {}), // never resolves; avoids device-lost handlers firing
  } as any;
}

function createMockAdapter(): GPUAdapter {
  return {
    requestDevice: vi.fn(async () => createMockDevice()),
    features: new Set<string>(),
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 268435456, maxStorageBufferBindingSize: 268435456 },
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

describe('ChartGPU - Performance Metrics Memory', () => {
  let mockContainer: HTMLElement;
  let mockAdapter: GPUAdapter;
  let mockDevice: GPUDevice;

  beforeEach(() => {
    mockContainer = createMockContainer();
    mockAdapter = createMockAdapter();
    mockDevice = createMockDevice();
    (mockAdapter.requestDevice as any).mockResolvedValue(mockDevice);
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: vi.fn(async () => mockAdapter), getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm') },
    });
    vi.stubGlobal('devicePixelRatio', 2);
    // Auto mode drives a RAF loop; keep it deterministic.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => (setTimeout(() => cb(performance.now()), 0), 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(async () => {
    // Let scheduled RAF callbacks settle before unstubbing, so dispose does not hit torn-down mocks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reports nonzero GPU buffer memory after creating a chart with data', async () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ x: i, y: Math.sin(i / 10) }));
    const options: ChartGPUOptions = { series: [{ type: 'line', data }] };

    const chart = await ChartGPU.create(mockContainer, options, { adapter: mockAdapter, device: mockDevice });
    try {
      const metrics = chart.getPerformanceMetrics();
      expect(metrics).not.toBeNull();
      expect(metrics!.memory.allocated).toBeGreaterThan(0);
      expect(metrics!.memory.used).toBeGreaterThan(0);
      expect(metrics!.memory.peak).toBeGreaterThanOrEqual(metrics!.memory.used);
      expect(metrics!.memory.used).toBeLessThanOrEqual(metrics!.memory.allocated);
    } finally {
      await chart.dispose();
    }
  });

  it('gpuTiming stays explicitly not implemented and capabilities report it', async () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i }));
    const options: ChartGPUOptions = { renderMode: 'external', series: [{ type: 'line', data }] };

    const chart = await ChartGPU.create(mockContainer, options, { adapter: mockAdapter, device: mockDevice });
    try {
      chart.renderFrame();

      expect(chart.getPerformanceCapabilities()!.gpuTimingSupported).toBe(false);

      const metrics = chart.getPerformanceMetrics();
      expect(metrics!.gpuTiming.enabled).toBe(false);
      expect(metrics!.gpuTiming.gpuTime).toBe(0);
      expect(metrics!.gpuTiming.cpuTime).toBeDefined();
    } finally {
      await chart.dispose();
    }
  });

  it('getPerformanceMetrics returns null after dispose', async () => {
    const options: ChartGPUOptions = { renderMode: 'external', series: [{ type: 'line', data: [{ x: 0, y: 0 }] }] };

    const chart = await ChartGPU.create(mockContainer, options, { adapter: mockAdapter, device: mockDevice });
    await chart.dispose();

    expect(chart.getPerformanceMetrics()).toBeNull();
    expect(chart.getPerformanceCapabilities()).toBeNull();
  });
});
