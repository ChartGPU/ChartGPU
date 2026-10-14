// @vitest-environment jsdom
/// <reference types="@webgpu/types" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartGPU } from '../ChartGPU';

const mockCommandEncoder = () => ({
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
});

function createMockDevice(): GPUDevice {
  return {
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 268435456,
      maxBindGroups: 4,
    },
    destroy: vi.fn(),
    createBuffer: vi.fn(() => ({ destroy: vi.fn(), unmap: vi.fn(), getMappedRange: vi.fn(() => new ArrayBuffer(0)) })),
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    createBindGroup: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(mockCommandEncoder),
    queue: { submit: vi.fn(), writeBuffer: vi.fn() },
    addEventListener: vi.fn(),
    lost: new Promise(() => {}),
  } as unknown as GPUDevice;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('item tooltip frame submission', () => {
  it('still acquires a canvas texture when a streamed line point is hovered', async () => {
    const getCurrentTexture = vi.fn(() => ({ createView: vi.fn(() => ({})) }));
    const canvasContext = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) =>
      kind === 'webgpu' ? (canvasContext as unknown as GPUCanvasContext) : null) as typeof HTMLCanvasElement.prototype.getContext);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, 800, 600)
    );
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });

    const device = createMockDevice();
    const adapter = {
      requestDevice: vi.fn(async () => device),
      features: new Set<string>(),
      limits: { maxTextureDimension2D: 8192, maxBufferSize: 268435456, maxStorageBufferBindingSize: 268435456 },
    } as unknown as GPUAdapter;
    vi.stubGlobal('navigator', {
      gpu: { getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'), requestAdapter: vi.fn(async () => adapter) },
    });
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
    vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 });

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    document.body.appendChild(container);

    const chart = await ChartGPU.create(
      container,
      {
        renderMode: 'external',
        animation: false,
        grid: { left: 0, right: 0, top: 0, bottom: 0 },
        xAxis: { min: 0, max: 3 },
        yAxis: { min: 0, max: 20 },
        tooltip: { show: true, trigger: 'item' },
        series: [{ type: 'line', sampling: 'none', data: [[0, 10], [1, 10], [2, 10]] }],
      },
      { adapter, device }
    );

    try {
      for (let i = 0; i < 10 && chart.needsRender(); i++) chart.renderFrame();
      chart.appendData(0, [[3, 10]]);
      for (let i = 0; i < 10 && chart.needsRender(); i++) chart.renderFrame();
      getCurrentTexture.mockClear();

      const canvas = container.querySelector('canvas');
      expect(canvas).not.toBeNull();
      canvas!.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, clientY: 300 }));
      expect(chart.renderFrame()).toBe(true);
      expect(getCurrentTexture).toHaveBeenCalledTimes(1);
    } finally {
      await chart.dispose();
    }
  });
});
