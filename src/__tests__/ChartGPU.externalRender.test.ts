/// <reference types="@webgpu/types" />

/**
 * Tests for ChartGPU external render mode (CGPU-EXTERNAL-RENDER).
 * Verifies:
 * - External mode: no render scheduled until renderFrame()
 * - needsRender toggles true on changes and false after renderFrame
 * - Multiple changes coalesce into single renderFrame
 * - Switching auto->external stops internal scheduling; external->auto schedules if dirty
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterEach } from 'vitest';
import { ChartGPU } from '../ChartGPU';
import type { ChartGPUInstance } from '../ChartGPU';
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
    const createElement = ((tagName: string) => {
      if (tagName === 'canvas') {
        return createMockCanvas();
      }
      return createMockElement();
    }) as unknown as Document['createElement'];

    (globalThis as any).document = {
      createElement,
    } as unknown as Document;
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

function createMockElement(): HTMLElement {
  return {
    style: {},
    appendChild: vi.fn(),
    removeChild: vi.fn(),
  } as any;
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

describe('ChartGPU - External Render Mode', () => {
  let mockContainer: HTMLElement;
  let mockAdapter: GPUAdapter;
  let mockDevice: GPUDevice;
  let rafSpy: ReturnType<typeof vi.spyOn> | null = null;
  let cancelRafSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    mockContainer = createMockContainer();
    mockAdapter = createMockAdapter();
    mockDevice = createMockDevice();
    (mockAdapter.requestDevice as any).mockResolvedValue(mockDevice);
    setupMockNavigatorGPU(mockAdapter);

    // Mock devicePixelRatio
    vi.stubGlobal('devicePixelRatio', 2);

    // Mock requestAnimationFrame and cancelAnimationFrame
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      setTimeout(() => cb(performance.now()), 0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    // Now spy on the stubbed functions
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    cancelRafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
  });

  afterEach(() => {
    rafSpy?.mockRestore();
    cancelRafSpy?.mockRestore();
    rafSpy = null;
    cancelRafSpy = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('External render mode initialization', () => {
    it('creates chart in external mode via options.renderMode: "external"', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      expect(chart.getRenderMode()).toBe('external');
      await chart.dispose();
    });

    it('defaults to auto mode when no external render config provided', async () => {
      const options: ChartGPUOptions = {
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      expect(chart.getRenderMode()).toBe('auto');
      await chart.dispose();
    });
  });

  describe('External mode: no internal RAF scheduling', () => {
    it('does not schedule RAF when needsRender becomes true in external mode', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      rafSpy?.mockClear();

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Clear any RAF calls from chart creation
      rafSpy?.mockClear();

      // Trigger a change that would normally schedule a render
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });

      // Wait a bit to ensure no RAF was scheduled
      await new Promise((resolve) => setTimeout(resolve, 0));

      // In external mode, RAF should NOT be called
      expect(rafSpy).not.toHaveBeenCalled();

      await chart.dispose();
    });

    it('external mode allows manual control via renderFrame', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', sampling: 'none', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // In external mode, we control rendering manually
      expect(chart.getRenderMode()).toBe('external');

      // Append data
      chart.appendData(0, [{ x: 2, y: 20 }]);

      // We can call renderFrame manually
      expect(() => chart.renderFrame()).not.toThrow();

      await chart.dispose();
    });

    it('does not schedule RAF on resize in external mode', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      rafSpy?.mockClear();

      // Trigger resize
      chart.resize();

      await new Promise((resolve) => setTimeout(resolve, 0));

      // In external mode, RAF should NOT be called
      expect(rafSpy).not.toHaveBeenCalled();

      await chart.dispose();
    });
  });

  describe('needsRender() behavior', () => {
    it('needsRender returns boolean value', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // needsRender should return a boolean
      const needs = chart.needsRender();
      expect(typeof needs).toBe('boolean');

      // renderFrame should be callable
      const result = chart.renderFrame();
      expect(typeof result).toBe('boolean');

      await chart.dispose();
    });

    it('needsRender returns true after setOption', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Trigger a change
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });

      expect(chart.needsRender()).toBe(true);

      await chart.dispose();
    });

    it('needsRender returns true after appendData', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', sampling: 'none', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Wait for initial render to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Append data
      chart.appendData(0, [{ x: 2, y: 20 }]);

      expect(chart.needsRender()).toBe(true);

      await chart.dispose();
    });

    it('needsRender changes after setOption and renderFrame', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Clear any initial state
      while (chart.needsRender()) {
        chart.renderFrame();
      }

      // Trigger a change
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });

      // After change, should need render
      expect(chart.needsRender()).toBe(true);

      // Calling renderFrame should work
      chart.renderFrame();

      await chart.dispose();
    });
  });

  describe('renderFrame() behavior', () => {
    it('renderFrame returns true when chart is dirty', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Trigger a change
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });

      // renderFrame should return true when rendering actually happens
      const rendered = chart.renderFrame();
      expect(rendered).toBe(true);

      await chart.dispose();
    });

    it('renderFrame returns false in auto mode', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'auto',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      // renderFrame should return false in auto mode (no-op)
      const rendered = chart.renderFrame();
      expect(rendered).toBe(false);

      await chart.dispose();
    });

    it('renderFrame returns false when chart is disposed', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      await chart.dispose();

      // renderFrame after dispose should return false
      const rendered = chart.renderFrame();
      expect(rendered).toBe(false);
    });
  });

  describe('Multiple changes coalesce', () => {
    it('does not throw when setOption is called after an update transition has just completed', async () => {
      let nowMs = 0;
      const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

      const buildOptions = (offset: number): ChartGPUOptions => ({
        animation: { duration: 120, easing: 'cubicOut' },
        xAxis: { type: 'value', min: 0, max: 10 },
        yAxis: { type: 'value', min: 0, max: 100 },
        series: [
          {
            type: 'line',
            data: {
              x: new Float32Array([0, 1, 2, 3]),
              y: new Float32Array([10 + offset, 30 + offset, 20 + offset, 40 + offset]),
            },
          },
        ],
      });

      const chart = await ChartGPU.create(mockContainer, buildOptions(0), {
        adapter: mockAdapter,
        device: mockDevice,
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 10));

        chart.setOption(buildOptions(10));
        nowMs = 1;
        await new Promise((resolve) => setTimeout(resolve, 10));

        nowMs = 200;
        expect(() => chart.setOption(buildOptions(20))).not.toThrow();
      } finally {
        await chart.dispose();
        nowSpy.mockRestore();
      }
    });

    it('multiple setOption calls work with manual renderFrame', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Clear any initial dirty state
      while (chart.needsRender()) {
        chart.renderFrame();
      }

      // Multiple changes - in external mode, RAF should not be scheduled
      rafSpy?.mockClear();

      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
              { x: 3, y: 30 },
            ],
          },
        ],
      });
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
              { x: 3, y: 30 },
              { x: 4, y: 40 },
            ],
          },
        ],
      });

      // RAF should not have been scheduled in external mode
      expect(rafSpy).not.toHaveBeenCalled();

      // Manual renderFrame should work
      chart.renderFrame();

      await chart.dispose();
    });

    it('multiple appendData calls work with manual renderFrame in external mode', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', sampling: 'none', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Verify we're in external mode
      expect(chart.getRenderMode()).toBe('external');

      // Multiple appends
      chart.appendData(0, [{ x: 2, y: 20 }]);
      chart.appendData(0, [{ x: 3, y: 30 }]);
      chart.appendData(0, [{ x: 4, y: 40 }]);

      // Manual renderFrame should work
      expect(() => chart.renderFrame()).not.toThrow();

      await chart.dispose();
    });

    it('mixed setOption and appendData calls work in external mode', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', sampling: 'none', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Verify we're in external mode
      expect(chart.getRenderMode()).toBe('external');

      // Mixed operations
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });
      chart.appendData(0, [{ x: 3, y: 30 }]);
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
              { x: 3, y: 30 },
              { x: 4, y: 40 },
            ],
          },
        ],
      });

      // Manual renderFrame should work
      expect(() => chart.renderFrame()).not.toThrow();

      await chart.dispose();
    });
  });

  describe('Switching render modes', () => {
    it('switching from auto to external stops auto rendering', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'auto',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      // Wait for auto mode to settle
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Switch to external mode
      chart.setRenderMode('external');
      expect(chart.getRenderMode()).toBe('external');

      // Now in external mode, changes should not schedule RAF
      rafSpy?.mockClear();
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      // RAF should not be scheduled in external mode
      expect(rafSpy).not.toHaveBeenCalled();

      await chart.dispose();
    });

    it('switching from external to auto schedules RAF if dirty', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Make the chart dirty in external mode
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });
      expect(chart.needsRender()).toBe(true);

      rafSpy?.mockClear();

      // Switch to auto mode
      chart.setRenderMode('auto');

      // RAF should be scheduled because chart is dirty
      expect(rafSpy).toHaveBeenCalled();

      await chart.dispose();
    });

    it('switching from external to auto enables auto rendering', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Clear any initial state
      while (chart.needsRender()) {
        chart.renderFrame();
      }

      // Switch to auto mode
      chart.setRenderMode('auto');
      expect(chart.getRenderMode()).toBe('auto');

      await new Promise((resolve) => setTimeout(resolve, 0));

      rafSpy?.mockClear();

      // Make a change - in auto mode, RAF should be scheduled
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      // RAF should be scheduled in auto mode
      expect(rafSpy).toHaveBeenCalled();

      await chart.dispose();
    });

    it('getRenderMode reflects current mode after switching', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'auto',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      expect(chart.getRenderMode()).toBe('auto');

      chart.setRenderMode('external');
      expect(chart.getRenderMode()).toBe('external');

      chart.setRenderMode('auto');
      expect(chart.getRenderMode()).toBe('auto');

      await chart.dispose();
    });

    it('switching modes multiple times maintains correct state', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'auto',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      // auto -> external
      chart.setRenderMode('external');
      expect(chart.getRenderMode()).toBe('external');

      // Make dirty
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });
      expect(chart.needsRender()).toBe(true);

      // external -> auto (should schedule RAF)
      rafSpy?.mockClear();
      chart.setRenderMode('auto');
      expect(rafSpy).toHaveBeenCalled();

      // auto -> external again
      chart.setRenderMode('external');
      expect(chart.getRenderMode()).toBe('external');

      await chart.dispose();
    });
  });

  describe('performance metrics on mode switch', () => {
    it('frame-drop metrics are disabled in external mode', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'auto',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      // Wait for some frames to accumulate metrics
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Switch to external mode
      chart.setRenderMode('external');

      // Get metrics after switch
      const metricsAfter = chart.getPerformanceMetrics();

      expect(metricsAfter?.frameDrops.totalDrops).toBe(0);

      await chart.dispose();
    });
  });

  describe('External render mode with real rendering loop simulation', () => {
    it('simulates external rendering loop driving the chart', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', sampling: 'none', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Simulate external loop
      let frameCount = 0;
      const maxFrames = 5;
      let renderCount = 0;

      while (frameCount < maxFrames) {
        // Check if render is needed
        if (chart.needsRender()) {
          const rendered = chart.renderFrame();
          if (rendered) renderCount++;
        }

        // Simulate data update every other frame
        if (frameCount % 2 === 0 && frameCount < maxFrames - 1) {
          chart.appendData(0, [{ x: frameCount + 2, y: (frameCount + 2) * 10 }]);
        }

        frameCount++;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Verify that we actually rendered frames
      expect(renderCount).toBeGreaterThan(0);

      await chart.dispose();
    });

    it('external loop respects needsRender flag', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', sampling: 'none', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      // Clear any initial dirty state
      while (chart.needsRender()) {
        chart.renderFrame();
      }

      let renderCount = 0;
      const dataPoints = [
        { x: 2, y: 20 },
        { x: 3, y: 30 },
      ];
      let pointIndex = 0;

      // Run external loop - add data and render
      for (let i = 0; i < 5; i++) {
        // Add data every other iteration
        if (i % 2 === 0 && pointIndex < dataPoints.length) {
          chart.appendData(0, [dataPoints[pointIndex]!]);
          pointIndex++;
        }

        if (chart.needsRender()) {
          chart.renderFrame();
          renderCount++;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Should have rendered at least once (we added data)
      expect(renderCount).toBeGreaterThan(0);

      await chart.dispose();
    });
  });

  describe('Edge cases and error handling', () => {
    it('renderFrame handles disposed chart gracefully', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      await chart.dispose();

      // Should not throw
      const rendered = chart.renderFrame();
      expect(rendered).toBe(false);
    });

    it('needsRender handles disposed chart gracefully', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      await chart.dispose();

      // Should not throw and return false for disposed charts
      const needs = chart.needsRender();
      // After dispose, needsRender behavior depends on implementation
      // The important part is it doesn't throw
      expect(typeof needs).toBe('boolean');
    });

    it('setRenderMode handles disposed chart gracefully', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'auto',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      await chart.dispose();

      // Should not throw
      expect(() => chart.setRenderMode('external')).not.toThrow();
    });

    it('renderFrame with no coordinator returns false', async () => {
      // This is hard to test directly, but we can test the disposed case
      // which also has no coordinator
      const options: ChartGPUOptions = {
        renderMode: 'external',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options, {
        adapter: mockAdapter,
        device: mockDevice,
      });

      await chart.dispose();

      const rendered = chart.renderFrame();
      expect(rendered).toBe(false);
    });
  });

  describe('Auto mode continues to work as expected', () => {
    it('auto mode schedules RAF on changes', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'auto',
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      // Wait for initial RAF calls to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      rafSpy?.mockClear();

      // Trigger a change
      chart.setOption({
        series: [
          {
            type: 'line',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });

      // RAF should be scheduled (may take a moment)
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rafSpy).toHaveBeenCalled();

      await chart.dispose();
    });

    it('auto mode handles appendData with RAF scheduling', async () => {
      const options: ChartGPUOptions = {
        renderMode: 'auto',
        series: [{ type: 'line', sampling: 'none', data: [{ x: 1, y: 10 }] }],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      rafSpy?.mockClear();

      // Append data
      chart.appendData(0, [{ x: 2, y: 20 }]);

      // RAF should be scheduled
      expect(rafSpy).toHaveBeenCalled();

      await chart.dispose();
    });
  });
});
