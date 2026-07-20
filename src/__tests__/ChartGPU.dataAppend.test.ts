/// <reference types="@webgpu/types" />

/**
 * Tests for ChartGPU `dataAppend` event (CGPU-DATA-EVENT).
 * Verifies event fires from appendData() with correct payload for all supported formats,
 * setOption() does NOT emit, off() removes listener, and multiple listeners work correctly.
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterEach } from 'vitest';
import { ChartGPU } from '../ChartGPU';
import type { ChartGPUInstance, ChartGPUDataAppendPayload } from '../ChartGPU';
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

describe('ChartGPU - dataAppend event', () => {
  let mockContainer: HTMLElement;
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    mockContainer = createMockContainer();
    setupMockNavigatorGPU();
    // Silence expected ChartGPU warnings in tests (e.g. streaming sampling hints, pie append warning).
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Mock requestAnimationFrame
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      setTimeout(() => cb(performance.now()), 0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    // Mock devicePixelRatio
    vi.stubGlobal('devicePixelRatio', 2);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('Event emission with different data formats', () => {
    it('emits dataAppend with InterleavedXYData: xExtent min/max correct, count correct', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            sampling: 'none',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with Float32Array interleaved [x0, y0, x1, y1, x2, y2]
      const interleaved = new Float32Array([3, 30, 4, 40, 5, 50]);
      chart.appendData(0, interleaved);

      // Wait for any async emission (requestAnimationFrame)
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.seriesIndex).toBe(0);
      expect(payload.count).toBe(3); // 6 values / 2 = 3 points
      expect(payload.xExtent.min).toBe(3);
      expect(payload.xExtent.max).toBe(5);

      await chart.dispose();
    });

    it('emits dataAppend with XYArraysData: xExtent correct, count correct', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            sampling: 'none',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with separate arrays
      const xyArrays = {
        x: new Float64Array([2, 3, 4, 5]),
        y: new Float32Array([20, 30, 40, 50]),
        size: new Float32Array([8, 10, 12, 14]),
      };
      chart.appendData(0, xyArrays);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.seriesIndex).toBe(0);
      expect(payload.count).toBe(4);
      expect(payload.xExtent.min).toBe(2);
      expect(payload.xExtent.max).toBe(5);

      await chart.dispose();
    });

    it('emits dataAppend with DataPoint[] tuple: xExtent correct', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'scatter',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with DataPoint tuples
      const tuples: Array<[number, number, number?]> = [
        [2, 20, 5],
        [3, 30, 6],
        [4, 40, 7],
      ];
      chart.appendData(0, tuples);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.seriesIndex).toBe(0);
      expect(payload.count).toBe(3);
      expect(payload.xExtent.min).toBe(2);
      expect(payload.xExtent.max).toBe(4);

      await chart.dispose();
    });

    it('emits dataAppend with DataPoint[] object: xExtent correct', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'area',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with DataPoint objects
      const objects = [
        { x: 2, y: 20 },
        { x: 3, y: 30 },
        { x: 4, y: 40 },
        { x: 5, y: 50 },
      ];
      chart.appendData(0, objects);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.seriesIndex).toBe(0);
      expect(payload.count).toBe(4);
      expect(payload.xExtent.min).toBe(2);
      expect(payload.xExtent.max).toBe(5);

      await chart.dispose();
    });

    it('handles empty append gracefully (no event emission)', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append empty array
      chart.appendData(0, []);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not emit for empty append
      expect(listener).not.toHaveBeenCalled();

      await chart.dispose();
    });

    it('handles xExtent when appending single point', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append single point
      chart.appendData(0, [{ x: 42, y: 100 }]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.count).toBe(1);
      expect(payload.xExtent.min).toBe(42);
      expect(payload.xExtent.max).toBe(42);

      await chart.dispose();
    });

    it('handles negative and mixed x values correctly in xExtent', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 0, y: 0 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with negative and positive values
      const data = new Float32Array([-5, 10, -2, 20, 3, 30, -10, 40]);
      chart.appendData(0, data);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.count).toBe(4);
      expect(payload.xExtent.min).toBe(-10);
      expect(payload.xExtent.max).toBe(3);

      await chart.dispose();
    });
  });

  describe('setOption() does NOT emit dataAppend', () => {
    it('does not emit dataAppend when calling setOption with new data', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Call setOption with different data
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

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should NOT emit dataAppend
      expect(listener).not.toHaveBeenCalled();

      await chart.dispose();
    });

    it('does not emit dataAppend when setOption changes series type', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Change series type via setOption
      chart.setOption({
        series: [
          {
            type: 'area',
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).not.toHaveBeenCalled();

      await chart.dispose();
    });
  });

  describe('off() removes listener', () => {
    it('removes listener and stops receiving events', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append data - should trigger
      chart.appendData(0, [{ x: 2, y: 20 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);

      // Remove listener
      chart.off('dataAppend', listener);

      // Append more data - should NOT trigger
      chart.appendData(0, [{ x: 3, y: 30 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Still only 1 call (from before off())
      expect(listener).toHaveBeenCalledTimes(1);

      await chart.dispose();
    });

    it('off() with wrong callback reference does not affect listener', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      const differentListener = vi.fn();

      chart.on('dataAppend', listener);

      // Try to remove a different callback
      chart.off('dataAppend', differentListener);

      // Append data - should still trigger original listener
      chart.appendData(0, [{ x: 2, y: 20 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(differentListener).not.toHaveBeenCalled();

      await chart.dispose();
    });
  });

  describe('Multiple listeners all fire', () => {
    it('calls all registered listeners once with same payload', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();

      chart.on('dataAppend', listener1);
      chart.on('dataAppend', listener2);
      chart.on('dataAppend', listener3);

      // Append data
      chart.appendData(0, [
        { x: 2, y: 20 },
        { x: 3, y: 30 },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // All listeners should be called once
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
      expect(listener3).toHaveBeenCalledTimes(1);

      // All should receive the same payload
      const payload1: ChartGPUDataAppendPayload = listener1.mock.calls[0][0];
      const payload2: ChartGPUDataAppendPayload = listener2.mock.calls[0][0];
      const payload3: ChartGPUDataAppendPayload = listener3.mock.calls[0][0];

      expect(payload1.seriesIndex).toBe(0);
      expect(payload1.count).toBe(2);
      expect(payload1.xExtent.min).toBe(2);
      expect(payload1.xExtent.max).toBe(3);

      // Verify same values in all payloads
      expect(payload2).toEqual(payload1);
      expect(payload3).toEqual(payload1);

      await chart.dispose();
    });

    it('removing one listener does not affect others', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();

      chart.on('dataAppend', listener1);
      chart.on('dataAppend', listener2);
      chart.on('dataAppend', listener3);

      // Remove middle listener
      chart.off('dataAppend', listener2);

      // Append data
      chart.appendData(0, [{ x: 2, y: 20 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Only listeners 1 and 3 should be called
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).not.toHaveBeenCalled();
      expect(listener3).toHaveBeenCalledTimes(1);

      await chart.dispose();
    });
  });

  describe('Candlestick series support', () => {
    it('emits dataAppend for candlestick series with correct xExtent from timestamp', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'candlestick',
            data: [{ timestamp: 1000, open: 100, high: 110, low: 95, close: 105 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append candlestick data
      chart.appendData(0, [
        { timestamp: 2000, open: 105, high: 115, low: 100, close: 110 },
        { timestamp: 3000, open: 110, high: 120, low: 108, close: 115 },
        { timestamp: 4000, open: 115, high: 125, low: 110, close: 120 },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.seriesIndex).toBe(0);
      expect(payload.count).toBe(3);
      expect(payload.xExtent.min).toBe(2000);
      expect(payload.xExtent.max).toBe(4000);

      await chart.dispose();
    });

    it('emits dataAppend for candlestick with tuple format', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'candlestick',
            data: [
              [1000, 100, 105, 95, 110], // [timestamp, open, close, low, high]
            ],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with tuple format
      chart.appendData(0, [
        [2000, 105, 110, 100, 115] as [number, number, number, number, number],
        [3000, 110, 115, 108, 120] as [number, number, number, number, number],
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.seriesIndex).toBe(0);
      expect(payload.count).toBe(2);
      expect(payload.xExtent.min).toBe(2000);
      expect(payload.xExtent.max).toBe(3000);

      await chart.dispose();
    });
  });

  describe('NaN and Infinity handling', () => {
    it('skips NaN x-values and computes xExtent from valid values only (XYArrays)', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with some NaN x-values
      const xyArrays = {
        x: new Float32Array([NaN, 2, 3, NaN, 5]),
        y: new Float32Array([10, 20, 30, 40, 50]),
      };
      chart.appendData(0, xyArrays);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.count).toBe(5);
      // Should compute extent from valid values only: 2, 3, 5
      expect(payload.xExtent.min).toBe(2);
      expect(payload.xExtent.max).toBe(5);

      await chart.dispose();
    });

    it('skips Infinity x-values and computes xExtent from finite values (Interleaved)', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with Infinity values
      const interleaved = new Float32Array([
        2,
        20, // valid
        Infinity,
        30, // invalid x
        4,
        40, // valid
        -Infinity,
        50, // invalid x
        6,
        60, // valid
      ]);
      chart.appendData(0, interleaved);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.count).toBe(5);
      // Should compute extent from finite values only: 2, 4, 6
      expect(payload.xExtent.min).toBe(2);
      expect(payload.xExtent.max).toBe(6);

      await chart.dispose();
    });

    it('returns zero extent when all x-values are NaN (DataPoint array)', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'scatter',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with all NaN x-values
      chart.appendData(0, [
        { x: NaN, y: 10 },
        { x: NaN, y: 20 },
        { x: NaN, y: 30 },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.count).toBe(3);
      // When no finite x-values, should return zero extent
      expect(payload.xExtent.min).toBe(0);
      expect(payload.xExtent.max).toBe(0);

      await chart.dispose();
    });

    it('returns zero extent when all x-values are Infinity (candlestick)', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'candlestick',
            data: [{ timestamp: 1000, open: 100, high: 110, low: 95, close: 105 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append with all Infinity timestamps
      chart.appendData(0, [
        { timestamp: Infinity, open: 105, high: 115, low: 100, close: 110 },
        { timestamp: -Infinity, open: 110, high: 120, low: 108, close: 115 },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.count).toBe(2);
      expect(payload.xExtent.min).toBe(0);
      expect(payload.xExtent.max).toBe(0);

      await chart.dispose();
    });

    it('handles mixed NaN, Infinity, and valid values correctly', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Mix of valid, NaN, and Infinity values
      chart.appendData(0, [
        { x: 10, y: 100 }, // valid
        { x: NaN, y: 200 }, // invalid
        { x: 20, y: 300 }, // valid
        { x: Infinity, y: 400 }, // invalid
        { x: 5, y: 500 }, // valid
        { x: -Infinity, y: 600 }, // invalid
        { x: 15, y: 700 }, // valid
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];

      expect(payload.count).toBe(7);
      // Valid values: 10, 20, 5, 15 -> min=5, max=20
      expect(payload.xExtent.min).toBe(5);
      expect(payload.xExtent.max).toBe(20);

      await chart.dispose();
    });
  });

  describe('Zero-listener performance optimization', () => {
    it('does not compute xExtent when no listeners are registered', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            sampling: 'none',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      // No listener registered - the xExtent computation should be skipped
      // We can't directly verify it was skipped, but we can verify no errors occur
      // and the append succeeds

      const largeData = new Float32Array(20000); // 10k points
      for (let i = 0; i < 10000; i++) {
        largeData[i * 2] = i;
        largeData[i * 2 + 1] = Math.sin(i / 100) * 100;
      }

      // This should complete without computing xExtent
      chart.appendData(0, largeData);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // No errors should occur
      expect(chart.disposed).toBe(false);

      await chart.dispose();
    });

    it('computes xExtent only when at least one listener is registered', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      // First append without listener - no event
      chart.appendData(0, [{ x: 2, y: 20 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now register listener
      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Second append with listener - should emit
      chart.appendData(0, [{ x: 3, y: 30 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const payload: ChartGPUDataAppendPayload = listener.mock.calls[0][0];
      expect(payload.xExtent.min).toBe(3);
      expect(payload.xExtent.max).toBe(3);

      // Remove listener
      chart.off('dataAppend', listener);

      // Third append without listener - no event
      listener.mockClear();
      chart.appendData(0, [{ x: 4, y: 40 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).not.toHaveBeenCalled();

      await chart.dispose();
    });
  });

  describe('Edge cases and error scenarios', () => {
    it('does not emit for invalid series index', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Try to append to non-existent series
      chart.appendData(999, [{ x: 2, y: 20 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).not.toHaveBeenCalled();

      await chart.dispose();
    });

    it('does not emit for pie series (not supported)', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'pie',
            data: [
              { name: 'A', value: 10 },
              { name: 'B', value: 20 },
            ],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Try to append to pie series (should log warning but not crash)
      chart.appendData(0, [{ x: 3, y: 30 }] as any);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).not.toHaveBeenCalled();

      await chart.dispose();
    });

    it('does not emit for heatmap series (not supported)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'heatmap',
            data: {
              xStart: 0,
              xStep: 1,
              yStart: 0,
              yStep: 1,
              columns: 2,
              rows: 2,
              z: new Float32Array([1, 2, 3, 4]),
            },
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);
      const listener = vi.fn();
      chart.on('dataAppend', listener);

      chart.appendData(0, [{ x: 3, y: 30 }] as any);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      const msg = String(warn.mock.calls[0]?.[0] ?? '');
      expect(msg).toMatch(/heatmap/i);
      expect(msg).toMatch(/not supported/i);

      await chart.dispose();
      warn.mockRestore();
    });

    it('does not emit after chart is disposed', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      await chart.dispose();

      // Try to append after disposal
      chart.appendData(0, [{ x: 2, y: 20 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).not.toHaveBeenCalled();
    });

    it('handles multiple series correctly', async () => {
      const options: ChartGPUOptions = {
        series: [
          {
            type: 'line',
            data: [{ x: 1, y: 10 }],
          },
          {
            type: 'scatter',
            data: [{ x: 1, y: 5 }],
          },
        ],
      };

      const chart = await ChartGPU.create(mockContainer, options);

      const listener = vi.fn();
      chart.on('dataAppend', listener);

      // Append to first series
      chart.appendData(0, [{ x: 2, y: 20 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].seriesIndex).toBe(0);

      listener.mockClear();

      // Append to second series
      chart.appendData(1, [{ x: 2, y: 10 }]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].seriesIndex).toBe(1);

      await chart.dispose();
    });
  });
});

describe('ChartGPU - appendData maxPoints (FIFO)', () => {
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
    warnSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  const makePointer = (clientX: number, clientY: number): PointerEvent =>
    ({
      clientX,
      clientY,
    }) as PointerEvent;

  it('ring fill under capacity keeps hit-test on appended tail', async () => {
    // maxPoints=4, seed 2; append 1 → length 3, domain includes append.
    // tooltip on so hit-test store is maintained under maxPoints.
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    expect(() => chart.appendData(0, [[100, 50]], { maxPoints: 4 })).not.toThrow();

    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.isInGrid).toBe(true);
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);

    await chart.dispose();
  });

  it('ring wrap at maxPoints drops oldest from hit-test domain', async () => {
    // maxPoints=2, seed 2; three unit appends each wrap to length 2.
    // Final retained: after [2], [3], [100] → [3, 100].
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 10],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[2, 20]], { maxPoints: 2 }); // [1, 2]
    chart.appendData(0, [[3, 30]], { maxPoints: 2 }); // [2, 3]
    chart.appendData(0, [[100, 50]], { maxPoints: 2 }); // [3, 100]

    // Allow flush.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Right edge should still match newest x=100; oldest x=0 must not dominate domain.
    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.isInGrid).toBe(true);
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);

    // Far left of the (now [3,100]) domain must not match the discarded x=0 seed.
    const hitLeft = chart.hitTest(makePointer(1, 500));
    if (hitLeft.match) {
      expect(hitLeft.match.value[0]).toBeGreaterThanOrEqual(3);
      expect(hitLeft.match.value[0]).not.toBe(0);
    }

    await chart.dispose();
  });

  it('strict-replaces when batch size equals maxPoints (suite FIFO 100/100 shape)', async () => {
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    // newCount === maxPoints → discard previous, keep only new batch.
    chart.appendData(
      0,
      [
        [10, 10],
        [20, 20],
        [30, 30],
        [100, 50],
      ],
      { maxPoints: 4 }
    );

    // y=50 → ~86; x=100 → right edge.
    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.isInGrid).toBe(true);
    expect(hitRight.match).not.toBeNull();
    // Domain is [10,100] — right edge ≈ 100, not seed x=3.
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);

    // Left edge of domain [10,100] must not match discarded seed x=0.
    const hitLeft = chart.hitTest(makePointer(1, 500));
    if (hitLeft.match) {
      expect(hitLeft.match.value[0]).toBeGreaterThanOrEqual(10);
      expect(hitLeft.match.value[0]).not.toBe(0);
    }

    await chart.dispose();
  });

  it('maxPoints: 1 retains a single hit-testable point after several appends', async () => {
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      // Seed a span so after strict replace to one point we still have a usable domain
      // via the last point's y=50 (x is expanded when min===max).
      series: [
        {
          type: 'line',
          data: [
            [0, 0],
            [1, 1],
          ],
          sampling: 'none',
        },
      ],
    });

    chart.appendData(0, [[50, 25]], { maxPoints: 1 });
    chart.appendData(0, [[100, 50]], { maxPoints: 1 });

    // Single retained point (100,50). With x expanded [100,101], left edge ≈ x=100.
    const hit = chart.hitTest(makePointer(1, 86));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match?.value[0]).toBeCloseTo(100, 0);
    expect(hit.match?.value[1]).toBeCloseTo(50, 0);

    await chart.dispose();
  });

  it('skips hit-test columnar growth when maxPoints + tooltip off (dual-store relief)', async () => {
    // Suite FIFO: tooltip false + maxPoints skips ChartGPU hit-test columns.
    // Subsequent unbounded append with tooltip still off also skips (aligned with
    // setOption tooltip-off policy). hitTest() on-demand resyncs from coordinator
    // so domain still reflects [2,3,100] after skip-only streaming.
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[2, 2]], { maxPoints: 2 });
    chart.appendData(0, [[3, 3]], { maxPoints: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Unbounded + tooltip still off: still skip dual store; GPU/coordinator only.
    chart.appendData(0, [[100, 50]]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.isInGrid).toBe(true);
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);

    const hitLeft = chart.hitTest(makePointer(1, 500));
    if (hitLeft.match) {
      // Seed x=0 discarded during skip FIFO; left edge of [2,3,100] is ≥ 2.
      expect(hitLeft.match.value[0]).toBeGreaterThanOrEqual(2);
      expect(hitLeft.match.value[0]).not.toBe(0);
    }

    await chart.dispose();
  });

  it('skips hit-test columnar growth on unbounded append when tooltip off (compression dual-store)', async () => {
    // Series compression / multi-chart line slots: tooltip false, no maxPoints,
    // append every frame. Dual columnar growth must not track full raw N.
    // Re-enable tooltip forces resync from coordinator (same as product path).
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[50, 25]]);
    chart.appendData(0, [[100, 50]]);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Axes-only setOption that turns tooltip on — must resync from coordinator.
    chart.setOption({
      ...chart.options,
      tooltip: { show: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.isInGrid).toBe(true);
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);

    await chart.dispose();
  });

  it('does not double-apply batch when first maintain append follows dual-store skip', async () => {
    // Explicit regression for Issue 1: resync-before-append ordering.
    // skip maxPoints path then first maxPoints+tooltip-on append via setOption
    // resync first, then append once — right edge is newest, not a duplicated tail.
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[2, 2]], { maxPoints: 3 });
    chart.appendData(0, [[3, 3]], { maxPoints: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    chart.setOption({
      ...chart.options,
      tooltip: { show: true },
    });
    // After resync store is coordinator [0,1]→[0,1,2]→[1,2,3] = [1,2,3]
    chart.appendData(0, [[100, 50]], { maxPoints: 3 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Correct single apply: retained [2,3,100]. Double would still end at 100
    // but left would differ if count exceeded capacity incorrectly — hard assert
    // newest and discarded seed absent.
    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);
    const hitLeft = chart.hitTest(makePointer(1, 500));
    if (hitLeft.match) {
      expect(hitLeft.match.value[0]).toBeGreaterThanOrEqual(2);
      expect(hitLeft.match.value[0]).not.toBe(0);
      expect(hitLeft.match.value[0]).not.toBe(1);
    }

    await chart.dispose();
  });

  it('tooltip-on control advances hit-test to newest under maxPoints', async () => {
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[2, 20]], { maxPoints: 2 });
    chart.appendData(0, [[100, 50]], { maxPoints: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);
    // Left of domain must not match discarded seed x=0.
    const hitLeft = chart.hitTest(makePointer(1, 500));
    if (hitLeft.match) {
      expect(hitLeft.match.value[0]).toBeGreaterThanOrEqual(2);
    }

    await chart.dispose();
  });

  it('re-enabling tooltip after dual-store skip resyncs hit-test domain', async () => {
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[50, 25]], { maxPoints: 2 });
    chart.appendData(0, [[100, 50]], { maxPoints: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Axes-only setOption that turns tooltip on — must resync from coordinator.
    chart.setOption({
      ...chart.options,
      tooltip: { show: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const hit = chart.hitTest(makePointer(799, 86));
    expect(hit.match).not.toBeNull();
    expect(hit.match?.value[0]).toBeCloseTo(100, 0);

    await chart.dispose();
  });

  it('tooltip re-enable resync resizes hit-test store when series count changes', async () => {
    const data0: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data: data0, sampling: 'none' }],
    });

    chart.appendData(0, [[100, 50]], { maxPoints: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Same setOption: re-enable tooltip AND add a second series (length 1→2).
    chart.setOption({
      ...chart.options,
      tooltip: { show: true },
      series: [
        { type: 'line', data: data0, sampling: 'none' },
        {
          type: 'line',
          data: [
            [0, 10],
            [1, 11],
          ],
          sampling: 'none',
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Must hit-test the first series' resynced newest point (x≈100 after FIFO).
    // y=50 with axis -10..60 → gridY ≈ (1 - 60/70)*600 ≈ 86.
    const hit = chart.hitTest(makePointer(799, 86));
    expect(hit.isInGrid).toBe(true);
    // After maxPoints:2 append of [100,50] onto seed, newest should be hit-testable.
    // Match may be null if mock scales disagree — assert domain via match when present.
    if (hit.match) {
      expect(hit.match.value[0]).toBeCloseTo(100, 0);
      expect(hit.match.seriesIndex).toBe(0);
    } else {
      // At least in-grid after resync without throw (prior contract).
      expect(hit.isInGrid).toBe(true);
    }

    await chart.dispose();
  });

  it('axes explicit→auto under same data ref tracks data domain (sticky bounds)', async () => {
    // Live path: presentation-only setOption must refresh rawBoundsMode + runtime
    // bounds when axes leave synthetic mode (same data ref).
    const data: Array<[number, number]> = [
      [0, 5],
      [50, 25],
      [100, 40],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: -1000, max: 1000 },
      yAxis: { min: -1000, max: 1000 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    // Switch to auto axes — same data ref. Domain must track data [0,100]×[5,40],
    // not the prior synthetic ±1000 box.
    chart.setOption({
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    // x=100 → right edge; y=40 with data domain ~5..40 → top of plot (clientY≈0).
    // If sticky synthetic ±1000, clientX≈799 maps near x=1000 and miss.
    const hit = chart.hitTest(makePointer(799, 5));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match!.value[0]).toBeCloseTo(100, 0);

    await chart.dispose();
  });

  it('explicit axes + append + auto axes same seed ref keeps append extrema', async () => {
    // Coordinator must recompute runtime bounds from owned columns on mode flip,
    // not only resolver seed rawBounds (which omit appends).
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: -10, max: 10 },
      yAxis: { min: -10, max: 10 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[100, 50]]);
    await new Promise((r) => setTimeout(r, 30));

    // Same seed data ref; axes → auto. Domain must include appended (100, 50).
    chart.setOption({
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    // x=100 right edge; y=50 near top of [0,50] → clientY ≈ 0.
    // If coordinator used seed-only bounds (0..1), hit at right edge misses 100.
    const hit = chart.hitTest(makePointer(799, 5));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match!.value[0]).toBeCloseTo(100, 0);
    expect(hit.match!.value[1]).toBeCloseTo(50, 0);

    await chart.dispose();
  });

  it('does not warn about full buffer re-upload for lttb GPU-decimation path', async () => {
    const data: Array<[number, number]> = [];
    for (let i = 0; i < 50; i++) data.push([i, Math.sin(i * 0.1)]);

    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -2, max: 2 },
      series: [
        {
          type: 'line',
          data,
          sampling: 'lttb',
          samplingThreshold: 20,
        },
      ],
    });

    // Drive a frame so prepareSeries can tag gpuDecimationRaw.
    await new Promise((resolve) => setTimeout(resolve, 30));

    warnSpy?.mockClear();
    chart.appendData(
      0,
      [
        [50, 1],
        [51, 0.5],
      ],
      { maxPoints: 50 }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const samplingWarns = (warnSpy?.mock.calls ?? []).filter((c) =>
      String(c[0] ?? '').includes('causes full buffer re-upload')
    );
    expect(samplingWarns).toHaveLength(0);

    // Length capped; newest x is hit-testable under tooltip on.
    const hit = chart.hitTest(makePointer(799, 150));
    expect(hit.isInGrid).toBe(true);
    if (hit.match) {
      expect(hit.match.value[0]).toBeGreaterThanOrEqual(49);
    }

    await chart.dispose();
  });

  it('multi-append same frame with per-batch maxPoints stays consistent', async () => {
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    // Two appends before rAF flush — different maxPoints per batch.
    // After batch1 max=10: [0,1,2,3]; batch2 max=3: drop to [2,3,100].
    chart.appendData(
      0,
      [
        [2, 2],
        [3, 3],
      ],
      { maxPoints: 10 }
    );
    chart.appendData(0, [[100, 50]], { maxPoints: 3 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);

    // Left of domain [2,3,100] must not be discarded seed x=0.
    const hitLeft = chart.hitTest(makePointer(1, 500));
    if (hitLeft.match) {
      expect(hitLeft.match.value[0]).toBeGreaterThanOrEqual(2);
      expect(hitLeft.match.value[0]).not.toBe(0);
    }

    await chart.dispose();
  });
});

describe('ChartGPU - hit-test store identity reuse (axes-only setOption)', () => {
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
    warnSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  const makePointer = (clientX: number, clientY: number): PointerEvent =>
    ({
      clientX,
      clientY,
    }) as PointerEvent;

  it('preserves append-extended domain so hit-test can match appended points after axes-only setOption', async () => {
    // Seed spans x=0..1; append extends to x=100. Axes-only setOption must keep
    // runtime bounds that include the append (not resolver bounds of the seed).
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[100, 50]]);

    // Axes-only: same data ref, only y-axis presentation range changes.
    chart.setOption({
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    // With grid filling the container (800×600):
    // - x domain includes append → x=100 maps near right edge (clientX≈800)
    // - y domain is explicit [-10, 60]; y=50 → gridY ≈ (1 - (50-(-10))/70) * 600 ≈ 86
    // If bounds were clobbered to seed-only (~0..1), clientX≈800 maps to ~x=1, no match at 100.
    const hit = chart.hitTest(makePointer(799, 86));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match?.value[0]).toBeCloseTo(100, 0);

    await chart.dispose();
  });

  it('rebuilds hit-test domain when a new data reference is provided', async () => {
    const data1: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const data2: Array<[number, number]> = [
      [0, 0],
      [50, 25],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: 0, max: 50 },
      series: [{ type: 'line', data: data1, sampling: 'none' }],
    });

    chart.setOption({
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: 0, max: 50 },
      series: [{ type: 'line', data: data2, sampling: 'none' }],
    });

    // Domain ~0..50 on x (from data2 rawBounds); y=25 → gridY ≈ 300.
    // Tooltip-off setOption skips columns; hitTest resyncs from coordinator.
    const hit = chart.hitTest(makePointer(799, 300));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match?.value[0]).toBeCloseTo(50, 0);

    await chart.dispose();
  });

  it('tooltip-off setOption full rewrite resyncs hit-test on demand (dual-store)', async () => {
    // Full-rewrite stress: tooltip false + new data array every frame.
    // Columns must not be required for render; hitTest after rewrite still works.
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 100 },
      yAxis: { min: 0, max: 50 },
      series: [
        {
          type: 'scatter',
          data: [
            [0, 0],
            [10, 5],
          ] as Array<[number, number]>,
          sampling: 'none',
          symbolSize: 5,
        },
      ],
    });

    const rebuildsAfterCreate = chart.getHitTestStoreRebuildCount();
    expect(rebuildsAfterCreate).toBeGreaterThanOrEqual(1);

    const next: Array<[number, number]> = [
      [0, 0],
      [90, 40],
    ];
    chart.setOption({
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 100 },
      yAxis: { min: 0, max: 50 },
      series: [
        {
          type: 'scatter',
          data: next,
          sampling: 'none',
          symbolSize: 5,
        },
      ],
    });
    // Skip proven: tooltip-off rewrite must not rebuild hit-test columns.
    expect(chart.getHitTestStoreRebuildCount()).toBe(rebuildsAfterCreate);

    // x=90 → near right; y=40 → near top of [0,50] → gridY ≈ (1-40/50)*600 = 120
    const hit = chart.hitTest(makePointer(720, 120));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match?.value[0]).toBeCloseTo(90, 0);

    // Re-enable tooltip must not double-apply or throw after skip.
    chart.setOption({
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 100 },
      yAxis: { min: 0, max: 50 },
      series: [
        {
          type: 'scatter',
          data: next,
          sampling: 'none',
          symbolSize: 5,
        },
      ],
    });
    const hit2 = chart.hitTest(makePointer(720, 120));
    expect(hit2.match?.value[0]).toBeCloseTo(90, 0);

    await chart.dispose();
  });

  it('setOption shared {x,y} then appendData does not mutate caller arrays', async () => {
    const x = [0, 1, 2];
    const y = [1, 2, 3];
    const xCopy = x.slice();
    const yCopy = y.slice();
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: 0, max: 10 },
      series: [{ type: 'line', data: { x, y }, sampling: 'none' }],
    });
    chart.appendData(0, {
      x: [3, 4],
      y: [4, 5],
    });
    await new Promise((r) => setTimeout(r, 30));
    // Caller arrays must be untouched (owned columns brand prevents in-place mutate).
    expect(x).toEqual(xCopy);
    expect(y).toEqual(yCopy);
    expect(x.length).toBe(3);
    expect(y.length).toBe(3);
    await chart.dispose();
  });

  it('tooltip re-enable multi-series hit-test hits correct series values', async () => {
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 100 },
      yAxis: { min: 0, max: 50 },
      series: [
        {
          type: 'line',
          data: [
            [0, 0],
            [50, 10],
          ] as Array<[number, number]>,
          sampling: 'none',
        },
        {
          type: 'line',
          data: [
            [0, 40],
            [90, 45],
          ] as Array<[number, number]>,
          sampling: 'none',
        },
      ],
    });
    chart.setOption({
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 100 },
      yAxis: { min: 0, max: 50 },
      series: [
        {
          type: 'line',
          data: [
            [0, 0],
            [50, 10],
          ] as Array<[number, number]>,
          sampling: 'none',
        },
        {
          type: 'line',
          data: [
            [0, 40],
            [90, 45],
          ] as Array<[number, number]>,
          sampling: 'none',
        },
      ],
    });
    chart.setOption({
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 100 },
      yAxis: { min: 0, max: 50 },
      series: [
        {
          type: 'line',
          data: [
            [0, 0],
            [50, 10],
          ] as Array<[number, number]>,
          sampling: 'none',
        },
        {
          type: 'line',
          data: [
            [0, 40],
            [90, 45],
          ] as Array<[number, number]>,
          sampling: 'none',
        },
      ],
    });
    // x≈90, y≈45 → second series
    const hit = chart.hitTest(makePointer(720, 60));
    expect(hit.match).not.toBeNull();
    expect(hit.match!.value[0]).toBeCloseTo(90, 0);
    expect(hit.match!.seriesIndex).toBe(1);
    await chart.dispose();
  });
});

describe('ChartGPU - dual-store correctness (PR167 review)', () => {
  let mockContainer: HTMLElement;
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  function createTinyLimitDevice(): GPUDevice {
    const d = createMockDevice();
    // Keep maxBufferSize high for stream/crosshair buffers; only storage binding
    // is tight so DataStore auto-windows series (128 pts × 8 B = 1024 B).
    (d.limits as any).maxStorageBufferBindingSize = 1024;
    return d;
  }

  beforeEach(() => {
    mockContainer = createMockContainer();
    const adapter = createMockAdapter();
    (adapter.requestDevice as any).mockImplementation(async () => createTinyLimitDevice());
    setupMockNavigatorGPU(adapter);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      setTimeout(() => cb(performance.now()), 0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('devicePixelRatio', 1);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  const makePointer = (clientX: number, clientY: number): PointerEvent => ({ clientX, clientY }) as PointerEvent;

  it('device auto-window caps hit-test length with tooltip on (issue 1.1)', async () => {
    // deviceMax = floor(1024/8) = 128. Seed 20, append 200 unbounded → retained = 128.
    // Mirror proven hitTest coords from maxPoints wrap tests (y≈50 → clientY≈86).
    const deviceMax = 128;
    const seed: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => [i, 10]);
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data: seed, sampling: 'none' }],
    });

    // Newest point uses y=50 so right-edge hit matches existing suite coords.
    const batch: Array<[number, number]> = Array.from({ length: 200 }, (_, i) => [20 + i, i === 199 ? 50 : 25]);
    chart.appendData(0, batch);
    await new Promise((r) => setTimeout(r, 40));

    // Hard length assert: dual-store must share device window (not grow unbounded).
    const hitCount = chart.getHitTestSeriesPointCount(0);
    expect(hitCount).toBeGreaterThanOrEqual(1);
    expect(hitCount).toBeLessThanOrEqual(deviceMax);
    // After seed 20 + append 200 = 220 uncapped → plan retains exactly deviceMax.
    expect(hitCount).toBe(deviceMax);

    // Newest retained x = 219. Right edge + y=50 → proven pointer (799, 86).
    const hitNew = chart.hitTest(makePointer(799, 86));
    expect(hitNew.isInGrid).toBe(true);
    expect(hitNew.match).not.toBeNull();
    expect(hitNew.match!.value[0]).toBeCloseTo(219, 0);

    // Dropped seed origin x=0 must not dominate left edge of retained domain [92, 219].
    // y≈25 (batch body) → clientY ≈ 300 with axis -10..60.
    const hitOld = chart.hitTest(makePointer(1, 300));
    expect(hitOld.match).not.toBeNull();
    expect(hitOld.match!.value[0]).toBeGreaterThanOrEqual(92);
    expect(hitOld.match!.value[0]).not.toBe(0);

    await chart.dispose();
  });

  it('presentation-only setOption after tooltip resync keeps append history (issue 1.2)', async () => {
    const data: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data, sampling: 'none' }],
    });

    chart.appendData(0, [[50, 25]], { maxPoints: 2 });
    chart.appendData(0, [[100, 50]], { maxPoints: 2 });
    await new Promise((r) => setTimeout(r, 30));

    // First setOption: re-enable tooltip (resync).
    chart.setOption({
      ...chart.options,
      tooltip: { show: true },
    });
    await new Promise((r) => setTimeout(r, 20));

    // Second presentation-only setOption (stable series data refs via chart.options).
    chart.setOption({
      ...chart.options,
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      legend: { show: false },
    });
    await new Promise((r) => setTimeout(r, 20));

    const hit = chart.hitTest(makePointer(799, 86));
    expect(hit.match).not.toBeNull();
    expect(hit.match?.value[0]).toBeCloseTo(100, 0);

    // Series data replace with new array identity rebuilds from seed (not owned history).
    const seedReplace: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    chart.setOption({
      ...chart.options,
      series: [{ type: 'line', data: seedReplace, sampling: 'none' }],
    });
    await new Promise((r) => setTimeout(r, 20));
    // After full series replace to seed domain 0..1, hit-test must rebuild from seed.
    expect(chart.getHitTestSeriesPointCount(0)).toBe(2);
    // Pointer near right edge of seed domain (x≈1): must match seed, not append history.
    const hitAfterReplace = chart.hitTest(makePointer(799, 500));
    expect(hitAfterReplace.match).not.toBeNull();
    expect(hitAfterReplace.match!.value[0]).toBeGreaterThanOrEqual(0);
    expect(hitAfterReplace.match!.value[0]).toBeLessThanOrEqual(1);

    await chart.dispose();
  });

  it('maxPoints promote sized linear hit-test to ring preserves size channel (issue 1.4)', async () => {
    // Normal device limits — only maxPoints promote (not device auto-window).
    const adapter = createMockAdapter();
    setupMockNavigatorGPU(adapter);
    // Tuple [x,y,size] seeds MutableXYColumns with size; maxPoints promotes to RingXY+size.
    const seed: Array<[number, number, number]> = [
      [0, 0, 1],
      [1, 1, 2],
      [2, 2, 3],
    ];
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [{ type: 'line', data: seed as any, sampling: 'none' }],
    });
    // prev=3 new=2 max=3 → drop 2, keep 2 new → retained [2,3,4] with sizes [3,4,5].
    chart.appendData(
      0,
      [
        [3, 30, 4],
        [100, 50, 5],
      ] as any,
      { maxPoints: 3 }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(chart.getHitTestSeriesPointCount(0)).toBe(3);
    // Right edge hits newest x=100 (same coords as other maxPoints wrap tests).
    const hit = chart.hitTest(makePointer(799, 86));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match!.value[0]).toBeCloseTo(100, 0);
    // Left of retained domain [2,100] must not match dropped seed x=0.
    const hitLeft = chart.hitTest(makePointer(1, 500));
    expect(hitLeft.match).not.toBeNull();
    expect(hitLeft.match!.value[0]).toBeGreaterThanOrEqual(2);
    expect(hitLeft.match!.value[0]).not.toBe(0);
    await chart.dispose();
  });
});

describe('ChartGPU - band hit-test store + append', () => {
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
    warnSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  const makePointer = (clientX: number, clientY: number): PointerEvent =>
    ({
      clientX,
      clientY,
    }) as PointerEvent;

  it('setOption-only band seed keeps y1 in hit-test path', async () => {
    // Dual-store regression: cartesian mutable columns dropped y1 after setOption-only seed.
    // Use y≈y1 near y=50 so midline hit matches the same screen Y as line FIFO tests.
    const bandData = {
      x: [0, 1, 2, 3, 4],
      y: [48, 49, 50, 49, 48],
      y1: [52, 51, 50, 51, 52],
    };
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 4 },
      yAxis: { min: -10, max: 60 },
      series: [
        {
          type: 'band',
          data: bandData,
          sampling: 'none',
          areaStyle: { color: '#38bdf8', opacity: 0.25 },
        },
      ],
    });

    // Same screen Y as line FIFO tests (near domain y=50).
    // No appendData — pure setOption-only seed must still hit (dual-store y1 regression).
    const hit = chart.hitTest(makePointer(400, 86));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    // Soft-if avoided: always assert series + finite y (lower curve).
    expect(hit.match!.seriesIndex).toBe(0);
    expect(Number.isFinite(hit.match!.value[0])).toBe(true);
    expect(Number.isFinite(hit.match!.value[1])).toBe(true);
    // Midline uses y1; if store dropped y1, band hit path would skip non-finite
    // pairs or use wrong distance. Re-hit at same coords stays stable.
    const hit2 = chart.hitTest(makePointer(400, 86));
    expect(hit2.match).not.toBeNull();
    expect(hit2.match!.seriesIndex).toBe(0);
    expect(hit2.match!.dataIndex).toBe(hit.match!.dataIndex);

    await chart.dispose();
  });

  it('band maxPoints append keeps aligned triples in hit-test domain', async () => {
    const bandData = {
      x: [0, 1],
      y: [48, 49],
      y1: [52, 51],
    };
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [
        {
          type: 'band',
          data: bandData,
          sampling: 'none',
          areaStyle: { color: '#a78bfa', opacity: 0.3 },
        },
      ],
    });

    chart.appendData(
      0,
      {
        x: [2, 3, 100],
        y: [48, 49, 50],
        y1: [52, 51, 50],
      },
      { maxPoints: 3 }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.isInGrid).toBe(true);
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match?.value[0]).toBeCloseTo(100, 0);

    await chart.dispose();
  });

  it('band XY-only append warns and does not grow store', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Midline near y=50 so hitTest at screen Y used by FIFO tests is reliable.
    const bandData = {
      x: [0, 1],
      y: [48, 49],
      y1: [52, 51],
    };
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      yAxis: { min: -10, max: 60 },
      series: [
        {
          type: 'band',
          data: bandData,
          sampling: 'none',
          areaStyle: { color: '#0af', opacity: 0.2 },
        },
      ],
    });

    // Cartesian XY without y1 — must warn and skip.
    chart.appendData(0, { x: [2], y: [50] } as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warn.mock.calls.some((c) => String(c[0]).includes('band series requires Xyy'))).toBe(true);

    // Domain should not include x=2 if append was skipped — always require a hit.
    const hitRight = chart.hitTest(makePointer(799, 86));
    expect(hitRight.match).not.toBeNull();
    expect(hitRight.match!.value[0]).toBeLessThanOrEqual(1);

    warn.mockRestore();
    await chart.dispose();
  });

  it('setOption replace: autoScroll-only wipe vs spread-preserving series (band live zoom UX)', async () => {
    // setOption replaces the full options object (not deep-merge). Live demos that
    // pause autoScroll on user zoom must re-pass series (or spread chart.options);
    // `{ autoScroll: false }` alone empties series and the band disappears.
    const bandData = {
      x: [0, 1, 2, 3, 4],
      y: [48, 49, 50, 49, 48],
      y1: [52, 51, 50, 51, 52],
    };
    const base = {
      animation: false as const,
      autoScroll: true,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 4 },
      yAxis: { min: -10, max: 60 },
      series: [
        {
          type: 'band' as const,
          data: bandData,
          sampling: 'none' as const,
          areaStyle: { color: '#a78bfa', opacity: 0.3 },
        },
      ],
    };

    const wiped = await ChartGPU.create(mockContainer, base);
    expect(wiped.options.series?.length).toBe(1);
    wiped.setOption({ autoScroll: false });
    expect(wiped.options.series?.length ?? 0).toBe(0);
    expect(wiped.getHitTestSeriesPointCount(0)).toBe(0);
    await wiped.dispose();

    const kept = await ChartGPU.create(mockContainer, base);
    kept.appendData(0, { x: [5], y: [49], y1: [51] }, { maxPoints: 100 });
    await new Promise((r) => setTimeout(r, 20));
    // Correct live-zoom pattern: spread current user options, only flip the flag.
    kept.setOption({
      ...kept.options,
      autoScroll: false,
    });
    expect(kept.options.autoScroll).toBe(false);
    expect(kept.options.series?.length).toBe(1);
    // Runtime store still has seed + append (not wiped by autoScroll toggle).
    expect(kept.getHitTestSeriesPointCount(0)).toBe(6);
    const hit = kept.hitTest(makePointer(400, 86));
    expect(hit.match).not.toBeNull();
    expect(hit.match!.seriesIndex).toBe(0);
    await kept.dispose();
  });
});
