/// <reference types="@webgpu/types" />

/**
 * Public ChartGPU.hitTest must return kind: 'errorBar' for stem hits.
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { ChartGPU } from '../ChartGPU';

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
        return { style: {}, appendChild: vi.fn(), removeChild: vi.fn() };
      },
    };
  }
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
      if (contextId === 'webgpu') {
        return {
          configure: vi.fn(),
          unconfigure: vi.fn(),
          getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
        };
      }
      return null;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
  } as any;
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
    queue: { submit: vi.fn(), writeBuffer: vi.fn() },
    addEventListener: vi.fn(),
    lost: new Promise(() => {}),
  } as any;
}

function setupMockNavigatorGPU(): void {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: vi.fn(async () => ({
        requestDevice: vi.fn(async () => createMockDevice()),
        features: new Set<string>(),
        limits: { maxTextureDimension2D: 8192, maxBufferSize: 268435456, maxStorageBufferBindingSize: 268435456 },
      })),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    },
  });
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

describe('ChartGPU.hitTest — errorBar', () => {
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
    vi.stubGlobal('devicePixelRatio', 1);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  const makePointer = (clientX: number, clientY: number): PointerEvent => ({ clientX, clientY }) as PointerEvent;

  it('returns kind: errorBar on stem hit for pure error-bar chart', async () => {
    // Full-bleed plot: domain x 0..2, y 0..20.
    // Sample at x=1, y=10, high=15, low=5 → stem through plot center.
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 2 },
      yAxis: { min: 0, max: 20 },
      series: [
        {
          type: 'errorBar',
          data: {
            x: [0, 1, 2],
            y: [10, 10, 10],
            high: [15, 15, 15],
            low: [5, 5, 5],
          },
          itemStyle: { color: '#38bdf8', borderWidth: 4 },
          capWidth: '50%',
          errorMode: 'both',
          drawWhiskers: true,
          drawConnector: true,
        },
      ],
    });

    // Center of 800×600 canvas → domain (1, 10) on stem of middle bar.
    const hit = chart.hitTest(makePointer(400, 300));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match!.kind).toBe('errorBar');
    expect(hit.match!.seriesIndex).toBe(0);
    expect(hit.match!.dataIndex).toBe(1);
    expect(hit.match!.value[0]).toBeCloseTo(1, 5);
    expect(hit.match!.value[1]).toBeCloseTo(10, 5);

    await chart.dispose();
  });

  it('hits secondary-axis errorBar using shared axis domain (union of series on that axis)', async () => {
    // Secondary axis "rhs": wide envelope from companion series + error bar.
    // Primary has a line so multi-axis is non-trivial.
    const chart = await ChartGPU.create(mockContainer, {
      animation: false,
      tooltip: { show: true },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { min: 0, max: 2 },
      yAxes: [
        { id: 'y', type: 'value', min: 0, max: 100 },
        { id: 'rhs', type: 'value' }, // auto from series on rhs
      ],
      series: [
        {
          type: 'line',
          yAxis: 'y',
          sampling: 'none',
          data: [
            [0, 50],
            [1, 50],
            [2, 50],
          ],
        },
        {
          type: 'errorBar',
          yAxis: 'rhs',
          data: {
            x: [0, 1, 2],
            y: [10, 10, 10],
            high: [12, 12, 12],
            low: [8, 8, 8],
          },
          itemStyle: { color: '#f80', borderWidth: 4 },
          capWidth: '50%',
        },
        // Companion on same secondary axis expands shared domain (Issue 2).
        {
          type: 'line',
          yAxis: 'rhs',
          sampling: 'none',
          data: [
            [0, 0],
            [1, 20],
            [2, 0],
          ],
        },
      ],
    });

    // Center x=1 → domain 1; y=10 on rhs domain ~0..20 → half plot height.
    const hit = chart.hitTest(makePointer(400, 300));
    expect(hit.isInGrid).toBe(true);
    expect(hit.match).not.toBeNull();
    expect(hit.match!.kind).toBe('errorBar');
    expect(hit.match!.seriesIndex).toBe(1);
    expect(hit.match!.value[1]).toBeCloseTo(10, 5);

    await chart.dispose();
  });
});
