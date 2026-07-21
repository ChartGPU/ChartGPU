/**
 * Heatmap dirty gate tests.
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

import { createHeatmapRenderer, packZTextureData, paddedFloatColumns } from '../createHeatmapRenderer';
import type { ResolvedHeatmapSeriesConfig } from '../../config/OptionResolver';
import type { ContinuousScale } from '../../utils/scales';
import type { GridArea } from '../createGridRenderer';

function createMockDevice(): GPUDevice {
  const writeTexture = vi.fn();
  return {
    label: 'mockDevice',
    limits: {
      maxUniformBufferBindingSize: 65536,
      maxStorageBufferBindingSize: 134217728,
      maxBufferSize: 268435456,
    },
    queue: {
      writeBuffer: vi.fn(),
      writeTexture,
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
    createTexture: vi.fn(() => ({
      destroy: vi.fn(),
      createView: vi.fn(() => ({})),
    })),
  } as unknown as GPUDevice;
}

function makeScale(min: number, max: number): ContinuousScale {
  const span = max - min || 1;
  return {
    kind: 'linear',
    scale: (v: number) => ((v - min) / span) * 2 - 1,
    invert: (p: number) => ((p + 1) / 2) * span + min,
    getDomain: () => ({ min, max }),
    getRange: () => ({ min: -1, max: 1 }),
  } as ContinuousScale;
}

const gridArea: GridArea = {
  left: 40,
  right: 20,
  top: 20,
  bottom: 40,
  canvasWidth: 800,
  canvasHeight: 600,
  devicePixelRatio: 1,
};

function makeSeries(
  z: Float32Array,
  columns = 4,
  rows = 3,
  extras: Partial<ResolvedHeatmapSeriesConfig> = {}
): ResolvedHeatmapSeriesConfig {
  return {
    type: 'heatmap',
    name: 'hm',
    data: {
      xStart: 0,
      xStep: 1,
      yStart: 0,
      yStep: 1,
      columns,
      rows,
      z,
    },
    colormap: 'viridis',
    zMin: 0,
    zMax: 1,
    zDomainExplicit: true,
    zScale: 'linear',
    opacity: 1,
    cellAnchor: 'corner',
    nullHandling: 'transparent',
    cellGapPx: 0,
    yAxis: 'y',
    color: '#888',
    rawBounds: { xMin: 0, xMax: columns, yMin: 0, yMax: rows },
    drawable: true,
    cellCount: columns * rows,
    visible: true,
    ...extras,
  };
}

describe('packZTextureData / bytesPerRow', () => {
  it('pads columns so bytesPerRow is multiple of 256', () => {
    for (const cols of [1, 3, 17, 65, 64]) {
      const padded = paddedFloatColumns(cols);
      expect((padded * 4) % 256).toBe(0);
      const packed = packZTextureData(new Float32Array(cols * 2), cols, 2, padded);
      expect(packed.length).toBe(padded * 2);
    }
  });
});

describe('heatmap dirty gate', () => {
  it('uploads z on first prepare and writeTexture is called', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const z = new Float32Array(12).fill(0.5);
    const series = makeSeries(z);
    const writesBefore = (device.queue.writeTexture as ReturnType<typeof vi.fn>).mock.calls.length;
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea);
    const writesAfter = (device.queue.writeTexture as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(renderer.getZUploadCount()).toBe(1);
    expect(writesAfter).toBeGreaterThan(writesBefore); // z + lut
    expect(renderer.hasZTexture()).toBe(true);
    renderer.dispose();
  });

  it('does not re-upload on pure zoom (same series config identity)', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const z = new Float32Array(12).fill(0.5);
    const series = makeSeries(z);
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea);
    const afterFirst = renderer.getZUploadCount();
    const writesAt = (device.queue.writeTexture as ReturnType<typeof vi.fn>).mock.calls.length;
    renderer.prepare(series, makeScale(1, 3), makeScale(0.5, 2.5), gridArea);
    renderer.prepare(series, makeScale(0, 2), makeScale(0, 1), gridArea);
    expect(renderer.getZUploadCount()).toBe(afterFirst);
    // uniforms only — no more writeTexture for z/lut
    expect((device.queue.writeTexture as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writesAt);
    renderer.dispose();
  });

  it('opacityOverride does not re-upload z (intro animation)', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const z = new Float32Array(12).fill(0.5);
    const series = makeSeries(z);
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea);
    const afterFirst = renderer.getZUploadCount();
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea, { opacityOverride: 0.5 });
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea, { opacityOverride: 1 });
    expect(renderer.getZUploadCount()).toBe(afterFirst);
    renderer.dispose();
  });

  it('opacity-only config identity change does not re-upload z', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const z = new Float32Array(12).fill(0.5);
    const s1 = makeSeries(z, 4, 3, { opacity: 1 });
    renderer.prepare(s1, makeScale(0, 4), makeScale(0, 3), gridArea);
    const afterFirst = renderer.getZUploadCount();
    const s2 = makeSeries(z, 4, 3, { opacity: 0.4 });
    renderer.prepare(s2, makeScale(0, 4), makeScale(0, 3), gridArea);
    expect(renderer.getZUploadCount()).toBe(afterFirst);
    renderer.dispose();
  });

  it('in-place z mutation under stable series identity does not re-upload (contract)', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const z = new Float32Array(12).fill(0.5);
    const series = makeSeries(z);
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea);
    const afterFirst = renderer.getZUploadCount();
    z[0] = 0.99;
    // Same series object — like in-place mutate without setOption
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea);
    expect(renderer.getZUploadCount()).toBe(afterFirst);
    renderer.dispose();
  });

  it('re-uploads when setOption series identity changes with mutated z', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const z = new Float32Array(12).fill(0.5);
    const s1 = makeSeries(z);
    renderer.prepare(s1, makeScale(0, 4), makeScale(0, 3), gridArea);
    const afterFirst = renderer.getZUploadCount();
    z[0] = 0.9;
    const s2 = makeSeries(z);
    renderer.prepare(s2, makeScale(0, 4), makeScale(0, 3), gridArea);
    expect(renderer.getZUploadCount()).toBe(afterFirst + 1);
    renderer.dispose();
  });

  it('re-uploads when z array reference changes', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const s1 = makeSeries(new Float32Array(12).fill(0.1));
    renderer.prepare(s1, makeScale(0, 4), makeScale(0, 3), gridArea);
    const afterFirst = renderer.getZUploadCount();
    const s2 = makeSeries(new Float32Array(12).fill(0.9));
    renderer.prepare(s2, makeScale(0, 4), makeScale(0, 3), gridArea);
    expect(renderer.getZUploadCount()).toBe(afterFirst + 1);
    renderer.dispose();
  });

  it('recreates texture on dimension change', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const s1 = makeSeries(new Float32Array(12), 4, 3);
    renderer.prepare(s1, makeScale(0, 4), makeScale(0, 3), gridArea);
    const createsAfterFirst = (device.createTexture as ReturnType<typeof vi.fn>).mock.calls.length;
    const s2 = makeSeries(new Float32Array(20), 5, 4);
    renderer.prepare(s2, makeScale(0, 5), makeScale(0, 4), gridArea);
    const createsAfterSecond = (device.createTexture as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(createsAfterSecond).toBeGreaterThan(createsAfterFirst);
    expect(renderer.getZUploadCount()).toBeGreaterThanOrEqual(2);
    renderer.dispose();
  });

  it('colormap change rewrites LUT without requiring z re-upload when z stable', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const z = new Float32Array(12).fill(0.5);
    const s1 = makeSeries(z, 4, 3, { colormap: 'viridis' });
    renderer.prepare(s1, makeScale(0, 4), makeScale(0, 3), gridArea);
    const zUploads = renderer.getZUploadCount();
    const lutUploads = renderer.getLutUploadCount();
    const s2 = makeSeries(z, 4, 3, { colormap: 'inferno' });
    renderer.prepare(s2, makeScale(0, 4), makeScale(0, 3), gridArea);
    expect(renderer.getLutUploadCount()).toBe(lutUploads + 1);
    expect(renderer.getZUploadCount()).toBe(zUploads); // same z content
    renderer.dispose();
  });

  it('non-drawable prepare does not upload z', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const z = new Float32Array(12);
    const series = makeSeries(z, 4, 3, { drawable: false });
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea);
    expect(renderer.getZUploadCount()).toBe(0);
    expect(renderer.hasZTexture()).toBe(false);
    renderer.dispose();
  });
});

it('re-uploads on cell swap with new series identity (position-sensitive stamp)', () => {
  const device = createMockDevice();
  const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
  const z = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const s1 = makeSeries(z);
  renderer.prepare(s1, makeScale(0, 4), makeScale(0, 3), gridArea);
  const afterFirst = renderer.getZUploadCount();
  // Swap two cells in place (order-blind stamp would miss this)
  const tmp = z[0]!;
  z[0] = z[1]!;
  z[1] = tmp;
  const s2 = makeSeries(z);
  renderer.prepare(s2, makeScale(0, 4), makeScale(0, 3), gridArea);
  expect(renderer.getZUploadCount()).toBe(afterFirst + 1);
  renderer.dispose();
});

it('re-uploads on column ring-shift with new series identity', () => {
  const device = createMockDevice();
  const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
  // 4×3
  const z = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const s1 = makeSeries(z, 4, 3);
  renderer.prepare(s1, makeScale(0, 4), makeScale(0, 3), gridArea);
  const afterFirst = renderer.getZUploadCount();
  // Shift each row left by 1 (spectrogram column advance)
  for (let j = 0; j < 3; j++) {
    const base = j * 4;
    const first = z[base]!;
    for (let i = 0; i < 3; i++) z[base + i] = z[base + i + 1]!;
    z[base + 3] = first;
  }
  const s2 = makeSeries(z, 4, 3);
  renderer.prepare(s2, makeScale(0, 4), makeScale(0, 3), gridArea);
  expect(renderer.getZUploadCount()).toBe(afterFirst + 1);
  renderer.dispose();
});

it('visible:false prepare does not upload z', () => {
  const device = createMockDevice();
  const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
  const z = new Float32Array(12);
  const series = makeSeries(z, 4, 3, { visible: false });
  renderer.prepare(series, makeScale(0, 4), makeScale(0, 3), gridArea);
  expect(renderer.getZUploadCount()).toBe(0);
  expect(renderer.hasZTexture()).toBe(false);
  renderer.dispose();
});
