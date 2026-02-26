/// <reference types="@webgpu/types" />

/**
 * Tests for ChartGPU auto-dispose on page unload (CGPU-OOM-139).
 * Verifies instance registry, dispose idempotency, and that the registry/unload
 * code does not break normal chart creation and disposal.
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterEach } from 'vitest';
import { ChartGPU, _resetInstanceRegistryForTesting } from '../ChartGPU';
import type { ChartGPUOptions } from '../config/types';

// Mock WebGPU globals before importing the module
beforeAll(() => {
  // Mock window global for SSR-safe checks
  if (typeof window === 'undefined') {
    // @ts-ignore - Mock window global
    globalThis.window = globalThis;
  }

  // Mock document if not available
  if (typeof document === 'undefined') {
    // @ts-ignore - Mock document global
    globalThis.document = {
      createElement: (tagName: string) => {
        if (tagName === 'canvas') {
          return createMockCanvas();
        }
        return {
          style: {},
          appendChild: vi.fn(),
          removeChild: vi.fn(),
        };
      },
    };
  }

  // @ts-ignore - Mock WebGPU globals
  globalThis.GPUShaderStage = {
    VERTEX: 1,
    FRAGMENT: 2,
    COMPUTE: 4,
  };
  // @ts-ignore - Mock WebGPU texture usage flags
  globalThis.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
  // @ts-ignore - Mock WebGPU buffer usage flags
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

// Mock canvas element
function createMockCanvas(): HTMLCanvasElement {
  const canvas = {
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
      if (contextId === 'webgpu') {
        return {
          configure: vi.fn(),
          unconfigure: vi.fn(),
          getCurrentTexture: vi.fn(() => ({
            createView: vi.fn(() => ({})),
          })),
        };
      }
      return null;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
  } as any;
  return canvas;
}

// Mock GPUDevice
function createMockDevice(): GPUDevice {
  const mockDevice = {
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 268435456,
      maxBindGroups: 4,
    },
    destroy: vi.fn(),
    createBuffer: vi.fn(() => ({
      destroy: vi.fn(),
      unmap: vi.fn(),
      getMappedRange: vi.fn(() => new ArrayBuffer(0)),
    })),
    createTexture: vi.fn(() => ({
      destroy: vi.fn(),
      createView: vi.fn(() => ({})),
    })),
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
        setBlendConstant: vi.fn(),
        setStencilReference: vi.fn(),
        draw: vi.fn(),
        drawIndexed: vi.fn(),
        drawIndirect: vi.fn(),
        drawIndexedIndirect: vi.fn(),
      })),
      beginComputePass: vi.fn(() => ({
        end: vi.fn(),
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        dispatchWorkgroupsIndirect: vi.fn(),
      })),
      finish: vi.fn(() => ({})),
      copyBufferToBuffer: vi.fn(),
      copyTextureToTexture: vi.fn(),
      copyBufferToTexture: vi.fn(),
      copyTextureToBuffer: vi.fn(),
      clearBuffer: vi.fn(),
      writeTimestamp: vi.fn(),
      resolveQuerySet: vi.fn(),
    })),
    queue: {
      submit: vi.fn(),
      writeBuffer: vi.fn(),
    },
    addEventListener: vi.fn(),
    // Use a never-resolving promise to avoid auto-triggering device lost handlers
    lost: new Promise(() => {}),
  } as any;
  return mockDevice;
}

// Mock GPUAdapter
function createMockAdapter(): GPUAdapter {
  const mockAdapter = {
    requestDevice: vi.fn(async () => createMockDevice()),
    features: new Set<string>(),
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 268435456,
    },
  } as any;
  return mockAdapter;
}

// Mock navigator.gpu
function setupMockNavigatorGPU(adapter: GPUAdapter | null = createMockAdapter()): void {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    },
  });
}

// Mock container element
function createMockContainer(): HTMLElement {
  const container = {
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
  return container;
}

const minimalOptions: ChartGPUOptions = {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
};

describe('auto-dispose on page unload (CGPU-OOM-139)', () => {
  let mockContainer: HTMLElement;
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    mockContainer = createMockContainer();
    setupMockNavigatorGPU();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      setTimeout(() => cb(performance.now()), 0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('devicePixelRatio', 2);
  });

  afterEach(() => {
    _resetInstanceRegistryForTesting();
    warnSpy?.mockRestore();
    warnSpy = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('dispose() is idempotent — calling twice does not throw', async () => {
    const chart = await ChartGPU.create(mockContainer, minimalOptions);
    chart.dispose();
    expect(() => chart.dispose()).not.toThrow();
  });

  it('instance is marked disposed after dispose()', async () => {
    const chart = await ChartGPU.create(mockContainer, minimalOptions);
    expect(chart.disposed).toBe(false);
    chart.dispose();
    expect(chart.disposed).toBe(true);
  });

  it('creating and disposing a chart does not throw', async () => {
    const chart = await ChartGPU.create(mockContainer, minimalOptions);
    expect(chart.disposed).toBe(false);
    expect(() => chart.dispose()).not.toThrow();
    expect(chart.disposed).toBe(true);
  });

  it('multiple charts can be created and disposed independently', async () => {
    const container1 = createMockContainer();
    const container2 = createMockContainer();

    const chart1 = await ChartGPU.create(container1, minimalOptions);
    const chart2 = await ChartGPU.create(container2, minimalOptions);

    expect(chart1.disposed).toBe(false);
    expect(chart2.disposed).toBe(false);

    chart1.dispose();
    expect(chart1.disposed).toBe(true);
    expect(chart2.disposed).toBe(false);

    chart2.dispose();
    expect(chart2.disposed).toBe(true);
  });

  it('_resetInstanceRegistryForTesting clears the registry without errors', async () => {
    const chart = await ChartGPU.create(mockContainer, minimalOptions);
    expect(chart.disposed).toBe(false);

    // Reset registry — chart is still alive but no longer tracked
    _resetInstanceRegistryForTesting();

    // Chart should still be usable (not disposed by reset)
    expect(chart.disposed).toBe(false);

    // Manual dispose should still work
    chart.dispose();
    expect(chart.disposed).toBe(true);
  });

  it('operations on a disposed chart are safe (no-op)', async () => {
    const chart = await ChartGPU.create(mockContainer, minimalOptions);
    chart.dispose();

    // setOption on disposed chart should be a no-op (not throw)
    expect(() => chart.setOption(minimalOptions)).not.toThrow();

    // appendData on disposed chart should be a no-op
    expect(() => chart.appendData(0, [[3, 4]])).not.toThrow();
  });
});
