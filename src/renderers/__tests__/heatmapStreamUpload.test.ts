/**
 * Heatmap strip / ring GPU upload path (strategy C).
 * Asserts O(rows) strip traffic vs full-grid upload on single-column scroll.
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

import { createHeatmapRenderer, packColumnStripStaging, paddedFloatColumns } from '../createHeatmapRenderer';
import { applyHeatmapAppendColumns } from '../../data/heatmapStream';
import { heatmapHitTest } from '../../utils/heatmapLayout';
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
  columns: number,
  rows: number,
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

describe('packColumnStripStaging alignment', () => {
  it('bytesPerRow is multiple of 256 for single-column strip', () => {
    const { bytesPerRow, paddedColumns, data } = packColumnStripStaging(new Float32Array([1, 2, 3]), 0, 3);
    expect(bytesPerRow % 256).toBe(0);
    expect(paddedColumns).toBe(paddedFloatColumns(1));
    expect(data[0]).toBe(1);
    expect(data[paddedColumns]).toBe(2);
  });
});

describe('heatmap strip upload (strategy C ring)', () => {
  it('single-column strip increments strip counter not full z upload', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const columns = 8;
    const rows = 16;
    const z = new Float32Array(columns * rows).fill(0.1);
    const series = makeSeries(z, columns, rows);
    renderer.prepare(series, makeScale(0, columns), makeScale(0, rows), gridArea);
    expect(renderer.getZUploadCount()).toBe(1);
    expect(renderer.getZStripUploadCount()).toBe(0);
    expect(renderer.getRingStart()).toBe(0);

    const col = new Float32Array(rows).fill(0.9);
    const stream = applyHeatmapAppendColumns(series.data, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: true,
    });
    const ok = renderer.uploadColumnStrip(col, 1, rows, columns, stream.data.z);
    expect(ok).toBe(true);
    expect(renderer.getZStripUploadCount()).toBe(1);
    expect(renderer.getZStripUploadFloats()).toBe(rows);
    expect(renderer.getZUploadCount()).toBe(1); // full did not increment
    expect(renderer.getRingStart()).toBe(1);

    // prepare with new series identity but same logical z after strip → no full re-upload
    const nextSeries = makeSeries(stream.data.z as Float32Array, columns, rows, {
      data: stream.data,
      rawBounds: { xMin: stream.data.xStart, xMax: stream.data.xStart + columns, yMin: 0, yMax: rows },
    });
    renderer.prepare(nextSeries, makeScale(0, columns), makeScale(0, rows), gridArea);
    expect(renderer.getZUploadCount()).toBe(1);
    expect(renderer.getRingStart()).toBe(1);
    renderer.dispose();
  });

  it('zoom/pan after strip does not re-upload z', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const columns = 5;
    const rows = 10;
    const z = new Float32Array(columns * rows).fill(0.2);
    const series = makeSeries(z, columns, rows);
    renderer.prepare(series, makeScale(0, columns), makeScale(0, rows), gridArea);
    const col = new Float32Array(rows).fill(0.5);
    const stream = applyHeatmapAppendColumns(series.data, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: true,
    });
    renderer.uploadColumnStrip(col, 1, rows, columns, stream.data.z);
    const fullAfter = renderer.getZUploadCount();
    const stripAfter = renderer.getZStripUploadCount();
    const nextSeries = makeSeries(stream.data.z as Float32Array, columns, rows, { data: stream.data });
    renderer.prepare(nextSeries, makeScale(1, 4), makeScale(2, 8), gridArea);
    renderer.prepare(nextSeries, makeScale(0, 2), makeScale(0, 5), gridArea);
    expect(renderer.getZUploadCount()).toBe(fullAfter);
    expect(renderer.getZStripUploadCount()).toBe(stripAfter);
    renderer.dispose();
  });

  it('non-64-aligned columns (3, 100) still accept strip writeTexture', () => {
    for (const columns of [3, 100]) {
      const device = createMockDevice();
      const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
      const rows = 7;
      const z = new Float32Array(columns * rows).fill(0);
      const series = makeSeries(z, columns, rows);
      renderer.prepare(series, makeScale(0, columns), makeScale(0, rows), gridArea);
      const col = new Float32Array(rows).fill(1);
      const stream = applyHeatmapAppendColumns(series.data, {
        mode: 'appendColumns',
        columns: 1,
        z: col,
        scrollX: true,
      });
      const ok = renderer.uploadColumnStrip(col, 1, rows, columns, stream.data.z);
      expect(ok).toBe(true);
      // writeTexture origin.x must be valid
      const writeTexture = device.queue.writeTexture as ReturnType<typeof vi.fn>;
      const stripCalls = writeTexture.mock.calls.filter((c) => {
        const origin = (c[0] as { origin?: { x: number } }).origin;
        return origin != null;
      });
      expect(stripCalls.length).toBeGreaterThanOrEqual(1);
      const last = stripCalls[stripCalls.length - 1]!;
      const layout = last[2] as { bytesPerRow: number };
      expect(layout.bytesPerRow % 256).toBe(0);
      renderer.dispose();
    }
  });

  it('resetRing forces full re-upload on next prepare', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const columns = 4;
    const rows = 4;
    const z = new Float32Array(columns * rows).fill(0);
    const series = makeSeries(z, columns, rows);
    renderer.prepare(series, makeScale(0, columns), makeScale(0, rows), gridArea);
    const col = new Float32Array(rows).fill(1);
    const stream = applyHeatmapAppendColumns(series.data, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: true,
    });
    renderer.uploadColumnStrip(col, 1, rows, columns, stream.data.z);
    renderer.resetRing();
    expect(renderer.getRingStart()).toBe(0);
    const next = makeSeries(stream.data.z as Float32Array, columns, rows, { data: stream.data });
    renderer.prepare(next, makeScale(0, columns), makeScale(0, rows), gridArea);
    expect(renderer.getZUploadCount()).toBe(2);
    expect(renderer.getRingStart()).toBe(0);
    renderer.dispose();
  });

  it('strip traffic is O(rows) not O(columns*rows) for 256×128 window', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const columns = 256;
    const rows = 128;
    const z = new Float32Array(columns * rows).fill(-100);
    const series = makeSeries(z, columns, rows, { zMin: -100, zMax: 0 });
    renderer.prepare(series, makeScale(0, columns), makeScale(0, rows), gridArea);
    const fullCells = columns * rows;
    let data = series.data;
    for (let i = 0; i < 10; i++) {
      const col = new Float32Array(rows).fill(-40);
      const r = applyHeatmapAppendColumns(data, { mode: 'appendColumns', columns: 1, z: col, scrollX: true });
      data = r.data;
      renderer.uploadColumnStrip(col, 1, rows, columns, r.data.z);
    }
    expect(renderer.getZUploadCount()).toBe(1);
    expect(renderer.getZStripUploadCount()).toBe(10);
    expect(renderer.getZStripUploadFloats()).toBe(10 * rows);
    // Each strip is O(rows); total strip floats << full grid * frames
    expect(renderer.getZStripUploadFloats()).toBeLessThan(fullCells);
    renderer.dispose();
  });

  it('ring wrap: 6 strips on columns=4; origin.x modular + getRingStart % columns', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const columns = 4;
    const rows = 3;
    const series = makeSeries(new Float32Array(columns * rows).fill(0), columns, rows);
    renderer.prepare(series, makeScale(0, columns), makeScale(0, rows), gridArea);
    const writeTexture = device.queue.writeTexture as ReturnType<typeof vi.fn>;
    const stripOrigins: number[] = [];
    let data = series.data;
    for (let i = 0; i < 6; i++) {
      const preRing = renderer.getRingStart();
      const col = new Float32Array(rows).fill(i + 1);
      const r = applyHeatmapAppendColumns(data, { mode: 'appendColumns', columns: 1, z: col, scrollX: true });
      data = r.data;
      const callsBefore = writeTexture.mock.calls.length;
      renderer.uploadColumnStrip(col, 1, rows, columns, r.data.z);
      const stripCall = writeTexture.mock.calls[callsBefore]!;
      const origin = (stripCall[0] as { origin: { x: number; y: number } }).origin;
      const size = stripCall[3] as { width: number; height: number };
      expect(origin.x).toBe(preRing);
      expect(origin.y).toBe(0);
      expect(size.width).toBe(1);
      expect(size.height).toBe(rows);
      stripOrigins.push(origin.x);
    }
    expect(stripOrigins).toEqual([0, 1, 2, 3, 0, 1]);
    expect(renderer.getRingStart()).toBe(6 % columns);
    renderer.dispose();
  });

  it('prepare writes ringStart into FS uniform buffer (u32 index 7)', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const columns = 4;
    const rows = 2;
    const series = makeSeries(new Float32Array(columns * rows).fill(0.2), columns, rows);
    renderer.prepare(series, makeScale(0, columns), makeScale(0, rows), gridArea);
    const col = new Float32Array(rows).fill(0.9);
    const stream = applyHeatmapAppendColumns(series.data, {
      mode: 'appendColumns',
      columns: 1,
      z: col,
      scrollX: true,
    });
    renderer.uploadColumnStrip(col, 1, rows, columns, stream.data.z);
    expect(renderer.getRingStart()).toBe(1);
    const next = makeSeries(stream.data.z as Float32Array, columns, rows, { data: stream.data });
    const writeBuffer = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const callsBefore = writeBuffer.mock.calls.length;
    renderer.prepare(next, makeScale(0, columns), makeScale(0, rows), gridArea);
    // Last writeBuffer for fs uniforms should contain ringStart at u32[7]
    const fsWrites = writeBuffer.mock.calls.slice(callsBefore);
    expect(fsWrites.length).toBeGreaterThan(0);
    // Find a write with 48-byte (12 float) payload — fs uniforms
    let foundRing = false;
    for (const call of fsWrites) {
      const data = call[2] as ArrayBuffer | Float32Array | Uint32Array;
      let u32: Uint32Array;
      if (data instanceof ArrayBuffer) {
        u32 = new Uint32Array(data);
      } else if (ArrayBuffer.isView(data)) {
        u32 = new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4));
      } else {
        continue;
      }
      if (u32.length >= 8 && u32[5] === columns && u32[6] === rows) {
        expect(u32[7]).toBe(1); // ringStart
        foundRing = true;
      }
    }
    expect(foundRing).toBe(true);
    renderer.dispose();
  });

  it('joint CPU logical window + GPU strip dest after scroll', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const columns = 4;
    const rows = 2;
    let data = {
      xStart: 0,
      xStep: 1,
      yStart: 0,
      yStep: 1,
      columns,
      rows,
      z: new Float32Array(columns * rows).fill(0),
    };
    const series = makeSeries(data.z, columns, rows, { data });
    renderer.prepare(series, makeScale(0, columns), makeScale(0, rows), gridArea);
    const col = new Float32Array([100, 200]);
    const preRing = renderer.getRingStart();
    const r = applyHeatmapAppendColumns(data, { mode: 'appendColumns', columns: 1, z: col, scrollX: true });
    const writeTexture = device.queue.writeTexture as ReturnType<typeof vi.fn>;
    const callsBefore = writeTexture.mock.calls.length;
    renderer.uploadColumnStrip(col, 1, rows, columns, r.data.z);
    const stripCall = writeTexture.mock.calls[callsBefore]!;
    const origin = (stripCall[0] as { origin: { x: number } }).origin;
    expect(origin.x).toBe(preRing);
    // Logical newest column (index columns-1) holds appended values
    expect(r.data.z[0 * columns + (columns - 1)]).toBe(100);
    expect(r.data.z[1 * columns + (columns - 1)]).toBe(200);
    const hit = heatmapHitTest(r.data, r.data.xStart + (columns - 1) + 0.5, 0.5, 'corner');
    expect(hit).not.toBeNull();
    expect(hit!.z).toBe(100);
    renderer.dispose();
  });

  it('uploadColumnStrip returns false before prepare / dim mismatch', () => {
    const device = createMockDevice();
    const renderer = createHeatmapRenderer(device, { sampleCount: 1 });
    const col = new Float32Array(4).fill(1);
    expect(renderer.uploadColumnStrip(col, 1, 4, 4, col)).toBe(false); // no texture
    const series = makeSeries(new Float32Array(16), 4, 4);
    renderer.prepare(series, makeScale(0, 4), makeScale(0, 4), gridArea);
    expect(renderer.uploadColumnStrip(col, 1, 4, 8, col)).toBe(false); // wrong columns
    expect(renderer.uploadColumnStrip(col, 1, 3, 4, col)).toBe(false); // wrong rows
    expect(renderer.uploadColumnStrip(col, 1, 4, 4, col)).toBe(true);
    renderer.dispose();
  });
});
