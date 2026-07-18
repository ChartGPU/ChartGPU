/// <reference types="@webgpu/types" />

/**
 * Tests for ChartGPU resize / backing-store sizing (issue #155).
 *
 * Under CSS zoom / parent scale, getBoundingClientRect returns visual size while
 * clientWidth/Height stay at layout size. Buffer must size from layout CSS × DPR.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartGPU } from '../ChartGPU';
import { GPUContext } from '../core/GPUContext';
import type { ChartGPUOptions } from '../config/types';

type MutableCanvas = {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  style: Record<string, string>;
  parentElement: HTMLElement | null;
  getBoundingClientRect: ReturnType<typeof vi.fn>;
  getContext: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  setPointerCapture: ReturnType<typeof vi.fn>;
  releasePointerCapture: ReturnType<typeof vi.fn>;
  hasPointerCapture: ReturnType<typeof vi.fn>;
};

let lastCreatedCanvas: MutableCanvas | null = null;

/** Factory options applied by document.createElement('canvas') (set per test). */
let nextCanvasOpts: {
  clientWidth?: number;
  clientHeight?: number;
  rectWidth?: number;
  rectHeight?: number;
} = {};

beforeAll(() => {
  if (typeof window === 'undefined') {
    // @ts-ignore
    globalThis.window = globalThis;
  }

  // Node vitest has no document; always install a minimal mock ChartGPU can use.
  // @ts-ignore
  globalThis.document = {
    createElement: (tagName: string) => {
      if (tagName === 'canvas') {
        return createMockCanvas(nextCanvasOpts);
      }
      return {
        style: {},
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      };
    },
  };

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

function createMockCanvas(opts?: {
  clientWidth?: number;
  clientHeight?: number;
  rectWidth?: number;
  rectHeight?: number;
}): MutableCanvas {
  const clientWidth = opts?.clientWidth ?? 1057;
  const clientHeight = opts?.clientHeight ?? 600;
  // Default: rect matches client (no CSS zoom). Tests may diverge them.
  const rectWidth = opts?.rectWidth ?? clientWidth;
  const rectHeight = opts?.rectHeight ?? clientHeight;

  const canvas: MutableCanvas = {
    width: 0,
    height: 0,
    clientWidth,
    clientHeight,
    style: {},
    parentElement: null,
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      width: rectWidth,
      height: rectHeight,
      right: rectWidth,
      bottom: rectHeight,
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
  };
  lastCreatedCanvas = canvas;
  return canvas;
}

function createMockDevice(): GPUDevice {
  return {
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
    lost: new Promise(() => {}),
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

function setupMockNavigatorGPU(adapter: GPUAdapter): void {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    },
  });
}

/** Chart main canvas captured via container.appendChild (authoritative for assertions). */
let chartCanvasFromContainer: MutableCanvas | null = null;

function createMockContainer(): HTMLElement {
  return {
    style: {},
    clientWidth: 1057,
    clientHeight: 600,
    appendChild: vi.fn((child: MutableCanvas) => {
      // ChartGPU appends the main WebGPU canvas first.
      if (chartCanvasFromContainer == null && child && typeof child === 'object' && 'getContext' in child) {
        chartCanvasFromContainer = child;
      }
      // Do not set parentElement to a new container (avoids overlay DOM side-effects).
      child.parentElement = null;
      return child;
    }),
    removeChild: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      width: 1057,
      height: 600,
      right: 1057,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })),
  } as any;
}

describe('ChartGPU resize backing store (issue #155)', () => {
  let mockContainer: HTMLElement;
  let mockAdapter: GPUAdapter;
  let mockDevice: GPUDevice;

  beforeEach(() => {
    lastCreatedCanvas = null;
    chartCanvasFromContainer = null;
    nextCanvasOpts = {
      clientWidth: 1057,
      clientHeight: 600,
      // CSS zoom 0.3 simulation: visual rect ~0.3× layout
      rectWidth: 317,
      rectHeight: 180,
    };
    mockContainer = createMockContainer();
    mockDevice = createMockDevice();
    mockAdapter = createMockAdapter(mockDevice);
    setupMockNavigatorGPU(mockAdapter);
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      setTimeout(() => cb(performance.now()), 0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    lastCreatedCanvas = null;
    chartCanvasFromContainer = null;
    nextCanvasOpts = {};
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function createChart(options: ChartGPUOptions = {}) {
    return ChartGPU.create(
      mockContainer,
      {
        series: [{ type: 'line', data: [{ x: 1, y: 10 }] }],
        ...options,
      },
      { adapter: mockAdapter, device: mockDevice }
    );
  }

  it('sizes buffer from clientWidth×dpr at create under CSS zoom (no post-create resize)', async () => {
    // nextCanvasOpts already: client 1057×600, rect 317×180, dpr stubbed 2
    const setDprSpy = vi.spyOn(GPUContext.prototype, 'setDevicePixelRatio');
    const chart = await createChart();
    const canvas = chartCanvasFromContainer;
    expect(canvas).toBeTruthy();

    // Create runs resizeInternal before/after GPU init — must use layout, not visual.
    expect(canvas!.width).toBe(Math.round(1057 * 2));
    expect(canvas!.height).toBe(Math.round(600 * 2));
    expect(canvas!.width).not.toBe(Math.round(317 * 2));
    expect(setDprSpy).toHaveBeenCalledWith(2);

    await chart.dispose();
    setDprSpy.mockRestore();
  });

  it('sizes buffer from clientWidth×dpr when getBoundingClientRect diverges (CSS zoom)', async () => {
    const setDprSpy = vi.spyOn(GPUContext.prototype, 'setDevicePixelRatio');
    const chart = await createChart();
    const canvas = chartCanvasFromContainer;
    expect(canvas).toBeTruthy();

    // Simulate CSS zoom: layout 1057×600, visual 317×180, dpr=2
    canvas!.clientWidth = 1057;
    canvas!.clientHeight = 600;
    canvas!.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 317,
      height: 180,
      right: 317,
      bottom: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    setDprSpy.mockClear();
    chart.resize();

    // Must NOT use rect×dpr (317*2=634); must use client×dpr (1057*2=2114)
    expect(canvas!.width).toBe(Math.round(1057 * 2));
    expect(canvas!.height).toBe(Math.round(600 * 2));
    expect(canvas!.width).not.toBe(Math.round(317 * 2));
    // Multi-layer: GPUContext DPR matches buffer math
    expect(setDprSpy).toHaveBeenCalledWith(2);

    await chart.dispose();
    setDprSpy.mockRestore();
  });

  it('honors explicit devicePixelRatio over window and keeps it sticky after window DPR change', async () => {
    vi.stubGlobal('devicePixelRatio', 3);

    const chart = await createChart({ devicePixelRatio: 1 });
    const canvas = chartCanvasFromContainer!;

    canvas.clientWidth = 800;
    canvas.clientHeight = 400;
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 800,
      height: 400,
      right: 800,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    chart.resize();
    expect(canvas.width).toBe(800); // 800 * 1, not 800 * 3
    expect(canvas.height).toBe(400);

    // Window DPR changes (page zoom) must not override create-time explicit DPR.
    vi.stubGlobal('devicePixelRatio', 4);
    chart.resize();
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(400);

    await chart.dispose();
  });

  it('ignores setOption devicePixelRatio for buffer sizing (create-time policy)', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const chart = await createChart(); // omitted → live
    const canvas = chartCanvasFromContainer!;
    canvas.clientWidth = 100;
    canvas.clientHeight = 50;
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      right: 100,
      bottom: 50,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    // setOption tries to force DPR 1 — must not affect buffer (create-time live policy).
    chart.setOption({ devicePixelRatio: 1 } as ChartGPUOptions);
    chart.resize();
    expect(canvas.width).toBe(200); // still live window 2
    expect(canvas.height).toBe(100);

    await chart.dispose();
  });

  it('ignores setOption raising devicePixelRatio after create with explicit 1', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const chart = await createChart({ devicePixelRatio: 1 });
    const canvas = chartCanvasFromContainer!;
    canvas.clientWidth = 200;
    canvas.clientHeight = 100;
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    chart.setOption({ devicePixelRatio: 2 } as ChartGPUOptions);
    chart.resize();
    // Still create-time explicit 1, not setOption 2 or window 3
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);

    await chart.dispose();
  });

  it('hitTest maps visual pointer into layout coords under CSS zoom', async () => {
    vi.stubGlobal('devicePixelRatio', 1);
    nextCanvasOpts = {
      clientWidth: 1000,
      clientHeight: 500,
      rectWidth: 300,
      rectHeight: 150,
    };
    const chart = await createChart({
      grid: { left: 40, right: 20, top: 10, bottom: 30 },
    });
    const canvas = chartCanvasFromContainer!;
    canvas.clientWidth = 1000;
    canvas.clientHeight = 500;
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 300,
      height: 150,
      right: 300,
      bottom: 150,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    // Visual center (150, 75) → layout (500, 250)
    const result = chart.hitTest({
      clientX: 150,
      clientY: 75,
    } as PointerEvent);

    expect(result.canvasX).toBeCloseTo(500);
    expect(result.canvasY).toBeCloseTo(250);
    // In plot: grid 40..980 x 10..470 → center is inside
    expect(result.isInGrid).toBe(true);
    expect(result.gridX).toBeCloseTo(460);
    expect(result.gridY).toBeCloseTo(240);

    await chart.dispose();
  });

  it('uses live window.devicePixelRatio when option is not set (not create-time freeze)', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const setDprSpy = vi.spyOn(GPUContext.prototype, 'setDevicePixelRatio');

    const chart = await createChart(); // no explicit devicePixelRatio
    const canvas = chartCanvasFromContainer!;

    canvas.clientWidth = 500;
    canvas.clientHeight = 250;
    // Keep rect in sync so only DPR is under test
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 500,
      height: 250,
      right: 500,
      bottom: 250,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    setDprSpy.mockClear();
    chart.resize();
    // Live window DPR 2 → buffer 1000×500
    expect(canvas.width).toBe(Math.round(500 * 2));
    expect(canvas.height).toBe(Math.round(250 * 2));
    expect(setDprSpy).toHaveBeenCalledWith(2);

    // Page zoom changes window.devicePixelRatio (e.g. browser zoom-in)
    vi.stubGlobal('devicePixelRatio', 1.5);
    setDprSpy.mockClear();
    chart.resize();

    expect(canvas.width).toBe(Math.round(500 * 1.5));
    expect(canvas.height).toBe(Math.round(250 * 1.5));
    expect(setDprSpy).toHaveBeenCalledWith(1.5);

    await chart.dispose();
    setDprSpy.mockRestore();
  });

  it('does not leave buffer at stale create-time dpr after live window.devicePixelRatio changes', async () => {
    vi.stubGlobal('devicePixelRatio', 1);

    const chart = await createChart();
    const canvas = chartCanvasFromContainer!;
    canvas.clientWidth = 400;
    canvas.clientHeight = 300;
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 120, // CSS zoom visual size — must be ignored
      height: 90,
      right: 120,
      bottom: 90,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    vi.stubGlobal('devicePixelRatio', 2);
    chart.resize();

    // Layout × live dpr, not visual rect × create-time dpr
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(canvas.width).not.toBe(120); // rect×createDpr=120
    expect(canvas.width).not.toBe(240); // rect×liveDpr

    await chart.dispose();
  });

  it('zero clientWidth/Height clamps to 1 device pixel (not visual rect × dpr)', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const chart = await createChart();
    const canvas = chartCanvasFromContainer!;

    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    // Non-zero visual rect must not drive buffer size
    canvas.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      right: 400,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    expect(() => chart.resize()).not.toThrow();
    // max(1, round(0 * 2)) = 1 — not rect×dpr (800×600) and not invent 1 CSS × dpr (=2)
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);

    await chart.dispose();
  });

  it.each([0, NaN, -1] as const)(
    'invalid create devicePixelRatio (%s) falls back to live window DPR',
    async (badDpr) => {
      vi.stubGlobal('devicePixelRatio', 2);
      const chart = await createChart({ devicePixelRatio: badDpr as number });
      const canvas = chartCanvasFromContainer!;
      canvas.clientWidth = 200;
      canvas.clientHeight = 100;
      canvas.getBoundingClientRect = vi.fn(() => ({
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        right: 200,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }));

      chart.resize();
      expect(canvas.width).toBe(400); // client × window 2
      expect(canvas.height).toBe(200);

      await chart.dispose();
    }
  );
});
