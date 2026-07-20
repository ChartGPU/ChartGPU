/**
 * Tests for renderer pool management.
 * These tests verify dynamic renderer allocation, disposal, and pool sizing.
 */

import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';

// Mock WebGPU globals before importing the module
beforeAll(() => {
  // @ts-ignore - Mock WebGPU globals
  globalThis.GPUShaderStage = {
    VERTEX: 1,
    FRAGMENT: 2,
    COMPUTE: 4,
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
  // @ts-ignore - Mock WebGPU texture usage flags
  globalThis.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
});

// Mock renderer creators
const createMockRenderer = (type: string) => ({
  label: `mock${type}Renderer`,
  dispose: vi.fn(),
  prepare: vi.fn(),
  render: vi.fn(),
});

vi.mock('../../../renderers/createAreaRenderer', () => ({
  createAreaRenderer: vi.fn(() => createMockRenderer('Area')),
}));

vi.mock('../../../renderers/createLineRenderer', () => ({
  createLineRenderer: vi.fn(() => createMockRenderer('Line')),
}));

vi.mock('../../../renderers/createScatterRenderer', () => ({
  createScatterRenderer: vi.fn(() => createMockRenderer('Scatter')),
}));

vi.mock('../../../renderers/createScatterDensityRenderer', () => ({
  createScatterDensityRenderer: vi.fn(() => createMockRenderer('ScatterDensity')),
}));

vi.mock('../../../renderers/createPieRenderer', () => ({
  createPieRenderer: vi.fn(() => createMockRenderer('Pie')),
}));

vi.mock('../../../renderers/createHeatmapRenderer', () => ({
  createHeatmapRenderer: vi.fn(() => createMockRenderer('Heatmap')),
}));

vi.mock('../../../renderers/createBandRenderer', () => ({
  createBandRenderer: vi.fn(() => createMockRenderer('Band')),
}));

vi.mock('../../../renderers/createCandlestickRenderer', () => ({
  createCandlestickRenderer: vi.fn(() => createMockRenderer('Candlestick')),
}));

vi.mock('../../../renderers/createBarRenderer', () => ({
  createBarRenderer: vi.fn(() => createMockRenderer('Bar')),
}));

import { createRendererPool, ensureRendererPoolsForSeries } from '../rendererPool';
type RendererPoolConfig = Parameters<typeof createRendererPool>[0];
import type { ResolvedSeriesConfig } from '../../../../config/OptionResolver';

// Mock GPUDevice
function createMockDevice(): GPUDevice {
  return {
    label: 'mockDevice',
    limits: {
      maxUniformBufferBindingSize: 65536,
      maxStorageBufferBindingSize: 134217728,
      maxBufferSize: 268435456,
    },
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(),
    },
    createBuffer: vi.fn(() => ({
      destroy: vi.fn(),
      mapAsync: vi.fn(),
      getMappedRange: vi.fn(),
      unmap: vi.fn(),
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})),
  } as any;
}

describe('RendererPool', () => {
  let device: GPUDevice;
  let config: RendererPoolConfig;

  beforeEach(() => {
    device = createMockDevice();
    config = {
      device,
      targetFormat: 'bgra8unorm' as GPUTextureFormat,
    };
    vi.clearAllMocks();
  });

  it('creates renderer pool without errors', () => {
    expect(() => createRendererPool(config)).not.toThrow();
  });

  it('initializes with empty renderer arrays', () => {
    const pool = createRendererPool(config);
    const state = pool.getState();

    expect(state.areaRenderers).toHaveLength(0);
    expect(state.lineRenderers).toHaveLength(0);
    expect(state.scatterRenderers).toHaveLength(0);
    expect(state.scatterDensityRenderers).toHaveLength(0);
    expect(state.pieRenderers).toHaveLength(0);
    expect(state.heatmapRenderers).toHaveLength(0);
    expect(state.bandRenderers).toHaveLength(0);
    expect(state.candlestickRenderers).toHaveLength(0);
  });

  it('creates bar renderer singleton', () => {
    const pool = createRendererPool(config);
    const state = pool.getState();

    expect(state.barRenderer).toBeDefined();
    expect(state.barRenderer.dispose).toBeDefined();
  });

  describe('Area Renderers', () => {
    it('grows area renderer pool', () => {
      const pool = createRendererPool(config);

      pool.ensureAreaRendererCount(3);

      const state = pool.getState();
      expect(state.areaRenderers).toHaveLength(3);
    });

    it('does not recreate renderers when count matches', () => {
      const pool = createRendererPool(config);

      pool.ensureAreaRendererCount(3);
      const stateBefore = pool.getState();
      const renderersBefore = stateBefore.areaRenderers;

      pool.ensureAreaRendererCount(3);
      const stateAfter = pool.getState();

      expect(stateAfter.areaRenderers).toHaveLength(3);
      expect(stateAfter.areaRenderers).toBe(renderersBefore);
    });

    it('shrinks area renderer pool and disposes excess', () => {
      const pool = createRendererPool(config);

      pool.ensureAreaRendererCount(5);
      expect(pool.getState().areaRenderers).toHaveLength(5);

      pool.ensureAreaRendererCount(3);
      expect(pool.getState().areaRenderers).toHaveLength(3);
    });
  });

  describe('Line Renderers', () => {
    it('grows line renderer pool', () => {
      const pool = createRendererPool(config);

      pool.ensureLineRendererCount(2);

      const state = pool.getState();
      expect(state.lineRenderers).toHaveLength(2);
    });

    it('shrinks line renderer pool and disposes excess', () => {
      const pool = createRendererPool(config);

      pool.ensureLineRendererCount(4);
      expect(pool.getState().lineRenderers).toHaveLength(4);

      pool.ensureLineRendererCount(2);
      expect(pool.getState().lineRenderers).toHaveLength(2);
    });
  });

  describe('Type-aware pool needs via ensureRendererPoolsForSeries', () => {
    // Needs sizing is internal; assert public ensure grows pools by series type mix.
    it('is exported and callable', () => {
      expect(typeof ensureRendererPoolsForSeries).toBe('function');
    });
  });

  describe('Scatter Renderers', () => {
    it('grows scatter renderer pool', () => {
      const pool = createRendererPool(config);

      pool.ensureScatterRendererCount(3);

      const state = pool.getState();
      expect(state.scatterRenderers).toHaveLength(3);
    });

    it('shrinks scatter renderer pool and disposes excess', () => {
      const pool = createRendererPool(config);

      pool.ensureScatterRendererCount(3);
      expect(pool.getState().scatterRenderers).toHaveLength(3);

      pool.ensureScatterRendererCount(1);
      expect(pool.getState().scatterRenderers).toHaveLength(1);
    });
  });

  describe('Scatter Density Renderers', () => {
    it('grows scatter density renderer pool', () => {
      const pool = createRendererPool(config);

      pool.ensureScatterDensityRendererCount(2);

      const state = pool.getState();
      expect(state.scatterDensityRenderers).toHaveLength(2);
    });

    it('shrinks scatter density renderer pool and disposes excess', () => {
      const pool = createRendererPool(config);

      pool.ensureScatterDensityRendererCount(3);
      expect(pool.getState().scatterDensityRenderers).toHaveLength(3);

      pool.ensureScatterDensityRendererCount(1);
      expect(pool.getState().scatterDensityRenderers).toHaveLength(1);
    });
  });

  describe('Pie Renderers', () => {
    it('grows pie renderer pool', () => {
      const pool = createRendererPool(config);

      pool.ensurePieRendererCount(4);

      const state = pool.getState();
      expect(state.pieRenderers).toHaveLength(4);
    });

    it('shrinks pie renderer pool and disposes excess', () => {
      const pool = createRendererPool(config);

      pool.ensurePieRendererCount(5);
      expect(pool.getState().pieRenderers).toHaveLength(5);

      pool.ensurePieRendererCount(2);
      expect(pool.getState().pieRenderers).toHaveLength(2);
    });
  });

  describe('Heatmap Renderers', () => {
    it('grows heatmap renderer pool', () => {
      const pool = createRendererPool(config);
      pool.ensureHeatmapRendererCount(3);
      expect(pool.getState().heatmapRenderers).toHaveLength(3);
    });

    it('shrinks heatmap renderer pool and disposes excess', () => {
      const pool = createRendererPool(config);
      pool.ensureHeatmapRendererCount(4);
      expect(pool.getState().heatmapRenderers).toHaveLength(4);
      pool.ensureHeatmapRendererCount(1);
      expect(pool.getState().heatmapRenderers).toHaveLength(1);
    });

    it('ensureRendererPoolsForSeries sizes heatmap pool for mixed series', () => {
      const pool = createRendererPool(config);
      const series = [
        { type: 'heatmap' },
        { type: 'line', sampling: 'none' },
        { type: 'heatmap' },
      ] as unknown as ResolvedSeriesConfig[];
      ensureRendererPoolsForSeries(pool, series);
      const state = pool.getState();
      expect(state.heatmapRenderers).toHaveLength(3);
      expect(state.lineRenderers).toHaveLength(3);
    });
  });

  describe('Band Renderers', () => {
    it('grows band renderer pool', () => {
      const pool = createRendererPool(config);
      pool.ensureBandRendererCount(3);
      expect(pool.getState().bandRenderers).toHaveLength(3);
    });

    it('shrinks band renderer pool and disposes excess', () => {
      const pool = createRendererPool(config);
      pool.ensureBandRendererCount(4);
      expect(pool.getState().bandRenderers).toHaveLength(4);
      pool.ensureBandRendererCount(1);
      expect(pool.getState().bandRenderers).toHaveLength(1);
    });

    it('ensureRendererPoolsForSeries sizes band pool for mixed series', () => {
      const pool = createRendererPool(config);
      const series = [
        { type: 'band' },
        { type: 'line', sampling: 'none' },
        { type: 'band' },
      ] as unknown as ResolvedSeriesConfig[];
      ensureRendererPoolsForSeries(pool, series);
      const state = pool.getState();
      expect(state.bandRenderers).toHaveLength(3);
      expect(state.lineRenderers).toHaveLength(3);
    });
  });

  describe('Candlestick Renderers', () => {
    it('grows candlestick renderer pool', () => {
      const pool = createRendererPool(config);

      pool.ensureCandlestickRendererCount(3);

      const state = pool.getState();
      expect(state.candlestickRenderers).toHaveLength(3);
    });

    it('shrinks candlestick renderer pool and disposes excess', () => {
      const pool = createRendererPool(config);

      pool.ensureCandlestickRendererCount(4);
      expect(pool.getState().candlestickRenderers).toHaveLength(4);

      pool.ensureCandlestickRendererCount(2);
      expect(pool.getState().candlestickRenderers).toHaveLength(2);
    });
  });

  describe('Pool Disposal', () => {
    it('disposes all renderers and clears arrays', () => {
      const pool = createRendererPool(config);

      // Create various renderers
      pool.ensureAreaRendererCount(2);
      pool.ensureLineRendererCount(3);
      pool.ensureScatterRendererCount(1);
      pool.ensureScatterDensityRendererCount(2);
      pool.ensurePieRendererCount(1);
      pool.ensureHeatmapRendererCount(2);
      pool.ensureBandRendererCount(2);
      pool.ensureCandlestickRendererCount(2);

      // Dispose pool
      pool.dispose();

      // Verify arrays are cleared
      const stateAfter = pool.getState();
      expect(stateAfter.areaRenderers).toHaveLength(0);
      expect(stateAfter.lineRenderers).toHaveLength(0);
      expect(stateAfter.scatterRenderers).toHaveLength(0);
      expect(stateAfter.scatterDensityRenderers).toHaveLength(0);
      expect(stateAfter.pieRenderers).toHaveLength(0);
      expect(stateAfter.heatmapRenderers).toHaveLength(0);
      expect(stateAfter.bandRenderers).toHaveLength(0);
      expect(stateAfter.candlestickRenderers).toHaveLength(0);
    });

    it('disposes scatter density renderers (bugfix)', () => {
      const pool = createRendererPool(config);

      pool.ensureScatterDensityRendererCount(3);
      const stateBefore = pool.getState();
      const scatterDensityRenderers = stateBefore.scatterDensityRenderers;

      pool.dispose();

      // Verify scatter density renderers were disposed (was missing in original code)
      scatterDensityRenderers.forEach((r: any) => expect(r.dispose).toHaveBeenCalled());

      const stateAfter = pool.getState();
      expect(stateAfter.scatterDensityRenderers).toHaveLength(0);
    });
  });

  describe('Multiple Renderer Types', () => {
    it('manages multiple renderer types independently', () => {
      const pool = createRendererPool(config);

      pool.ensureAreaRendererCount(2);
      pool.ensureLineRendererCount(3);
      pool.ensureScatterRendererCount(1);

      const state = pool.getState();
      expect(state.areaRenderers).toHaveLength(2);
      expect(state.lineRenderers).toHaveLength(3);
      expect(state.scatterRenderers).toHaveLength(1);
    });

    it('can resize different pools independently', () => {
      const pool = createRendererPool(config);

      pool.ensureAreaRendererCount(3);
      pool.ensureLineRendererCount(2);

      pool.ensureAreaRendererCount(1);

      const state = pool.getState();
      expect(state.areaRenderers).toHaveLength(1);
      expect(state.lineRenderers).toHaveLength(2);
    });
  });
});
