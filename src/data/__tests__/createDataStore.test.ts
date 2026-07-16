/// <reference types="@webgpu/types" />

/**
 * Unit tests for DataStore — content hash (WG-P0-2 plumbing) and staging reuse (WG-P1-9).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
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
  // @ts-ignore
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
});

import { createDataStore } from '../createDataStore';

function createMockDevice() {
  const buffers: Array<{ size: number; destroy: ReturnType<typeof vi.fn>; label?: string }> = [];
  const device = {
    limits: {
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 134217728,
    },
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
    createCommandEncoder: vi.fn(() => {
      const pass = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      };
      const encoder = {
        copyBufferToBuffer: vi.fn(),
        beginComputePass: vi.fn(() => pass),
        finish: vi.fn(() => ({})),
        __pass: pass,
      };
      (device as any).__lastEncoder = encoder;
      return encoder;
    }),
    createBuffer: vi.fn((desc?: GPUBufferDescriptor) => {
      const b = {
        size: desc?.size ?? 0,
        label: desc?.label ?? '',
        usage: desc?.usage ?? 0,
        destroy: vi.fn(),
      };
      buffers.push(b);
      return b as unknown as GPUBuffer;
    }),
    createShaderModule: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
  } as unknown as GPUDevice & {
    __buffers: typeof buffers;
    __lastEncoder?: {
      copyBufferToBuffer: ReturnType<typeof vi.fn>;
      beginComputePass: ReturnType<typeof vi.fn>;
    };
  };
  (device as any).__buffers = buffers;
  return device;
}

describe('createDataStore', () => {
  let device: ReturnType<typeof createMockDevice>;

  beforeEach(() => {
    device = createMockDevice();
  });

  describe('getSeriesContentHash (WG-P0-2)', () => {
    it('changes when the same-N payload is rewritten into the same buffer', () => {
      const store = createDataStore(device);
      const dataA: Array<[number, number]> = [
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      store.setSeries(0, dataA, { xOffset: 0 });
      const hashA = store.getSeriesContentHash(0);
      const bufferA = store.getSeriesBuffer(0);

      // Equal length, different y values — capacity fits so buffer identity is retained.
      const dataB: Array<[number, number]> = [
        [0, 1],
        [1, 99],
        [2, 3],
      ];
      store.setSeries(0, dataB, { xOffset: 0 });
      const hashB = store.getSeriesContentHash(0);
      const bufferB = store.getSeriesBuffer(0);

      expect(bufferB).toBe(bufferA);
      expect(store.getSeriesPointCount(0)).toBe(3);
      expect(hashB).not.toBe(hashA);
    });

    it('stays stable when setSeries is called with identical content', () => {
      const store = createDataStore(device);
      const data: Array<[number, number]> = [
        [10, 1],
        [20, 2],
      ];
      store.setSeries(0, data);
      const hash1 = store.getSeriesContentHash(0);
      store.setSeries(0, [
        [10, 1],
        [20, 2],
      ]);
      expect(store.getSeriesContentHash(0)).toBe(hash1);
    });

    it('y-only rewrite reuses buffer and updates y floats (group 4)', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
        [2, 3],
      ]);
      const bufferA = store.getSeriesBuffer(0);
      const stagingA = store.getSeriesStagingBuffer(0);
      const hashA = store.getSeriesContentHash(0);

      store.setSeries(0, [
        [0, 10],
        [1, 20],
        [2, 30],
      ]);
      expect(store.getSeriesBuffer(0)).toBe(bufferA);
      expect(store.getSeriesStagingBuffer(0)).toBe(stagingA);
      expect(store.getSeriesContentHash(0)).not.toBe(hashA);
      // x unchanged, y updated
      expect(stagingA[0]).toBe(0);
      expect(stagingA[1]).toBe(10);
      expect(stagingA[2]).toBe(1);
      expect(stagingA[3]).toBe(20);
      expect(stagingA[4]).toBe(2);
      expect(stagingA[5]).toBe(30);
    });

    it('does not take y-only path when x also changes (group 2 Brownian)', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
        [2, 3],
      ]);
      const staging = store.getSeriesStagingBuffer(0);

      store.setSeries(0, [
        [0.5, 10],
        [1.2, 20],
        [2.1, 30],
      ]);
      // Full pack: both x and y updated
      expect(staging[0]).toBeCloseTo(0.5);
      expect(staging[1]).toBe(10);
      expect(staging[2]).toBeCloseTo(1.2);
      expect(staging[3]).toBe(20);
      expect(staging[4]).toBeCloseTo(2.1);
      expect(staging[5]).toBe(30);
    });
  });

  describe('staging buffer reuse (WG-P1-9)', () => {
    it('reuses the same staging Float32Array when capacity does not grow', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
      ]);
      const staging1 = store.getSeriesStagingBuffer(0);

      store.setSeries(0, [
        [0, 10],
        [1, 20],
        [2, 30],
        [3, 40],
      ]);
      const staging2 = store.getSeriesStagingBuffer(0);

      expect(staging2).toBe(staging1);
      // Packed contents must reflect the latest write (interleaved x,y).
      expect(staging2[0]).toBe(0);
      expect(staging2[1]).toBe(10);
      expect(staging2[6]).toBe(3);
      expect(staging2[7]).toBe(40);
    });

    it('allocates a larger staging buffer only when capacity grows', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
      ]);
      const stagingSmall = store.getSeriesStagingBuffer(0);
      const smallLen = stagingSmall.length;

      // Grow past current capacity (pow2 growth).
      const many: Array<[number, number]> = [];
      for (let i = 0; i < 10_000; i++) many.push([i, i * 0.5]);
      store.setSeries(0, many);
      const stagingLarge = store.getSeriesStagingBuffer(0);

      expect(stagingLarge).not.toBe(stagingSmall);
      expect(stagingLarge.length).toBeGreaterThan(smallLen);
    });

    it('clamps setSeries capacity to maxStorageBufferBindingSize (FIFO 10M bind-group fix)', () => {
      // Chrome/Metal often has maxBufferSize=256MiB but maxStorageBufferBindingSize=128MiB.
      // Unclamped 10M 2× headroom → 256MiB buffer → Invalid BindGroup on storage bind.
      const tight = createMockDevice();
      (tight.limits as { maxBufferSize: number; maxStorageBufferBindingSize: number }).maxBufferSize =
        256 * 1024 * 1024;
      (tight.limits as { maxBufferSize: number; maxStorageBufferBindingSize: number }).maxStorageBufferBindingSize =
        128 * 1024 * 1024;
      const store = createDataStore(tight);

      // 10M points = 80MiB required; 2× headroom wants 160MiB → pow2 256MiB without clamp.
      const n = 10_000_000;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        x[i] = i;
        y[i] = i * 0.001;
      }
      store.setSeries(0, { x, y });

      const buf = store.getSeriesBuffer(0) as unknown as { size: number };
      const required = n * 8;
      expect(buf.size).toBeGreaterThanOrEqual(required);
      expect(buf.size).toBeLessThanOrEqual(128 * 1024 * 1024);
      // Must not allocate the unclamped 256MiB headroom.
      expect(buf.size).toBeLessThan(256 * 1024 * 1024);
    });
  });

  describe('appendSeries with maxPoints (fixed-capacity ring FIFO)', () => {
    it('fill phase under capacity uses pure ranged append (linear layout)', () => {
      const store = createDataStore(device);
      // Pre-grow capacity so pure append does not realloc.
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      const bufferBefore = store.getSeriesBuffer(0);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();

      // 4 + 2 = 6 ≤ maxPoints=8 → pure ranged append, still linear.
      store.appendSeries(
        0,
        [
          [4, 4],
          [5, 5],
        ],
        { maxPoints: 8 }
      );

      expect(store.getSeriesPointCount(0)).toBe(6);
      expect(store.getSeriesBuffer(0)).toBe(bufferBefore);
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 0, capacity: 0 });
      const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
      expect(writes).toHaveBeenCalledTimes(1);
      // Appended range starts at point index 4 → byteOffset 32.
      expect(writes.mock.calls[0]![1]).toBe(32);
    });

    it('append content hash bumps without full FNV of new floats (FIFO O(1) version)', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 256; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      // Pure linear fill under capacity.
      const h0 = store.getSeriesContentHash(0);
      const big: Array<[number, number]> = [];
      for (let i = 0; i < 128; i++) big.push([1000 + i, i]);
      store.appendSeries(0, big, { maxPoints: 10_000 });
      const h1 = store.getSeriesContentHash(0);
      expect(h1).not.toBe(h0);
      // Second append must bump again (dirty gate for GPU decimation).
      store.appendSeries(0, [[2000, 1]], { maxPoints: 10_000 });
      expect(store.getSeriesContentHash(0)).not.toBe(h1);
    });

    it('modular wrap bumps content version (O(1) stamp, not FNV of floats)', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      const h0 = store.getSeriesContentHash(0);
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 });
      const h1 = store.getSeriesContentHash(0);
      expect(h1).not.toBe(h0);
      expect(store.getSeriesRingLayout(0).start).toBe(1);
      // Identical y payload still bumps — version is content-agnostic, not FNV(y).
      store.appendSeries(0, [[11, 10]], { maxPoints: 4 });
      expect(store.getSeriesContentHash(0)).not.toBe(h1);
    });

    it('identical y append still bumps content version (not float FNV equality)', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 32; i++) seed.push([i, 1]);
      store.setSeries(0, seed);
      const h0 = store.getSeriesContentHash(0);
      // Same y values, new x — stamp must change so decimation re-runs.
      store.appendSeries(0, [
        [100, 1],
        [101, 1],
      ]);
      const h1 = store.getSeriesContentHash(0);
      expect(h1).not.toBe(h0);
      store.appendSeries(0, [
        [102, 1],
        [103, 1],
      ]);
      expect(store.getSeriesContentHash(0)).not.toBe(h1);
    });

    it('linear append writeBuffer sources appendScratch, not full staging parent', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      const staging = store.getSeriesStagingBuffer(0);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();

      store.appendSeries(
        0,
        [
          [4, 4],
          [5, 5],
          [6, 6],
        ],
        { maxPoints: 64 }
      );

      const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
      expect(writes).toHaveBeenCalledTimes(1);
      const call = writes.mock.calls[0]!;
      // writeBuffer(buffer, byteOffset, data, dataOffset, size)
      const dataSrc = call[2] as ArrayBuffer;
      const byteLength = call[4] as number;
      expect(byteLength).toBe(3 * 2 * 4); // O(append) only
      // Must not source the full-capacity staging ArrayBuffer parent.
      expect(dataSrc).not.toBe(staging.buffer);
      expect((dataSrc as ArrayBuffer).byteLength).toBeLessThan(staging.buffer.byteLength);
    });

    it('modular dual-write wrap sources appendScratch (not staging parent)', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      // Wrap so ringStart=1, write head = 1.
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 });
      store.appendSeries(0, [[11, 11]], { maxPoints: 4 });
      // start=2, write head=2; append 3 → phys 2,3,0 (wrap)
      const staging = store.getSeriesStagingBuffer(0);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();

      store.appendSeries(
        0,
        [
          [20, 20],
          [21, 21],
          [22, 22],
        ],
        { maxPoints: 4 }
      );

      const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
      expect(writes.mock.calls.length).toBe(2); // dual modular write
      let totalBytes = 0;
      for (const call of writes.mock.calls) {
        const dataSrc = call[2] as ArrayBuffer;
        const byteLength = call[4] as number;
        totalBytes += byteLength;
        expect(dataSrc).not.toBe(staging.buffer);
        expect((dataSrc as ArrayBuffer).byteLength).toBeLessThan(staging.buffer.byteLength);
      }
      expect(totalBytes).toBe(3 * 2 * 4); // O(append) total
    });

    it('ring wrap overwrites oldest slots without full retained rewrite', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      // Fill to capacity=4.
      // Already at 4. Next append of 1 with maxPoints=4 wraps.
      const bufferBefore = store.getSeriesBuffer(0);
      const hashBefore = store.getSeriesContentHash(0);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();

      store.appendSeries(0, [[10, 10]], { maxPoints: 4 });

      expect(store.getSeriesPointCount(0)).toBe(4);
      expect(store.getSeriesBuffer(0)).toBe(bufferBefore);
      expect(store.getSeriesContentHash(0)).not.toBe(hashBefore);
      // Modular: oldest was at 0, overwritten; ringStart advances by 1.
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 1, capacity: 4 });

      const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
      // Only the new point range — not a full 4-point rewrite.
      expect(writes).toHaveBeenCalledTimes(1);
      expect(writes.mock.calls[0]![1]).toBe(0); // write head at physical 0
      expect(writes.mock.calls[0]![4]).toBe(8); // one point = 8 bytes

      const staging = store.getSeriesStagingBuffer(0);
      // Physical slot 0 now holds the new point [10,10].
      expect(staging[0]).toBe(10);
      expect(staging[1]).toBe(10);
      // Logical order: phys 1,2,3,0 → [1,2,3,10]
      expect(staging[2]).toBe(1);
      expect(staging[4]).toBe(2);
      expect(staging[6]).toBe(3);
    });

    it('ring wrap that straddles capacity end splits into two writeBuffer calls', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      // Wrap once so ringStart=1 (capacity full, write head at 1 after one unit append).
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 });
      expect(store.getSeriesRingLayout(0).start).toBe(1);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();

      // Append 3 points: write head = 1, wraps after 3 slots (1,2,3) — no wrap to 0.
      // Append 4 would fill 1,2,3,0 — still one contiguous if head=1 and count=3.
      // Force wrap: head at 2 after another single append.
      store.appendSeries(0, [[11, 11]], { maxPoints: 4 });
      expect(store.getSeriesRingLayout(0).start).toBe(2);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();

      // write head = 2, append 3 points → physical 2,3,0 (wraps)
      store.appendSeries(
        0,
        [
          [20, 20],
          [21, 21],
          [22, 22],
        ],
        { maxPoints: 4 }
      );
      expect(store.getSeriesPointCount(0)).toBe(4);
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 1, capacity: 4 });
      // drop=3, start was 2 → (2+3)%4 = 1
      const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
      expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('pure append without maxPoints still ranged-writes only new bytes', () => {
      const store = createDataStore(device);
      // Pre-grow capacity (setSeries does not shrink) so append fits without realloc.
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
      ]);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();

      store.appendSeries(0, [[2, 2]]);

      expect(store.getSeriesPointCount(0)).toBe(3);
      const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
      expect(writes).toHaveBeenCalledTimes(1);
      // byteOffset for the 3rd point (index 2) = 2 points * 8 bytes = 16
      expect(writes.mock.calls[0]![1]).toBe(16);
      // size of one point = 8 bytes
      expect(writes.mock.calls[0]![4]).toBe(8);
    });

    it('when newPoints alone exceed maxPoints, keeps only the tail', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
      ]);
      store.appendSeries(
        0,
        [
          [10, 10],
          [11, 11],
          [12, 12],
          [13, 13],
        ],
        { maxPoints: 3 }
      );
      expect(store.getSeriesPointCount(0)).toBe(3);
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 0, capacity: 0 });
      const staging = store.getSeriesStagingBuffer(0);
      expect(staging[0]).toBe(11);
      expect(staging[1]).toBe(11);
      expect(staging[2]).toBe(12);
      expect(staging[3]).toBe(12);
      expect(staging[4]).toBe(13);
      expect(staging[5]).toBe(13);
    });

    it('strict-replaces when newCount === maxPoints (FIFO 100/100 shape)', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      store.appendSeries(
        0,
        [
          [10, 10],
          [11, 11],
          [12, 12],
          [13, 13],
        ],
        { maxPoints: 4 }
      );
      expect(store.getSeriesPointCount(0)).toBe(4);
      const staging = store.getSeriesStagingBuffer(0);
      // Previous discarded; new batch kept in full (linear).
      expect(staging[0]).toBe(10);
      expect(staging[1]).toBe(10);
      expect(staging[6]).toBe(13);
      expect(staging[7]).toBe(13);
    });

    it('growth GPU-copies retained prefix and ranged-writes only new points (1.1 A)', () => {
      const store = createDataStore(device);
      // Tiny seed → buffer sized for 2 points only.
      store.setSeries(0, [
        [0, 0],
        [1, 1],
      ]);
      const oldBuffer = store.getSeriesBuffer(0) as unknown as {
        destroy: ReturnType<typeof vi.fn>;
      };
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      (device.queue.submit as ReturnType<typeof vi.fn>).mockClear();
      (device.createCommandEncoder as ReturnType<typeof vi.fn>).mockClear();

      // Append enough to force geometric growth.
      const batch: Array<[number, number]> = [];
      for (let i = 0; i < 100; i++) batch.push([i + 2, i + 2]);
      store.appendSeries(0, batch);

      expect(store.getSeriesPointCount(0)).toBe(102);
      expect(store.getSeriesBuffer(0)).not.toBe(oldBuffer);
      expect(oldBuffer.destroy).toHaveBeenCalled();

      // Option A: GPU copy of retained 2 points, not a full CPU re-upload of N.
      expect(device.createCommandEncoder).toHaveBeenCalled();
      const encoder = (device as any).__lastEncoder as {
        copyBufferToBuffer: ReturnType<typeof vi.fn>;
      };
      expect(encoder.copyBufferToBuffer).toHaveBeenCalled();
      const copyArgs = encoder.copyBufferToBuffer.mock.calls[0]!;
      // src, srcOffset, dst, dstOffset, size — retained prefix = 2 * 8 bytes
      expect(copyArgs[1]).toBe(0);
      expect(copyArgs[3]).toBe(0);
      expect(copyArgs[4]).toBe(2 * 8);
      expect(device.queue.submit).toHaveBeenCalled();

      const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
      // New points only: offset at retained*8, size = 100*8 (not full 102*8 at 0).
      const newOnly = writes.mock.calls.some((c) => c[1] === 2 * 8 && (c[4] as number) === 100 * 8);
      expect(newOnly).toBe(true);
      const fullRetainedReupload = writes.mock.calls.some((c) => c[1] === 0 && (c[4] as number) >= 102 * 8);
      expect(fullRetainedReupload).toBe(false);

      // Series buffer includes COPY_SRC for future growth.
      const lastBuf = (device as any).__buffers[(device as any).__buffers.length - 1];
      expect(lastBuf.usage & GPUBufferUsage.COPY_SRC).toBeTruthy();

      const staging = store.getSeriesStagingBuffer(0);
      expect(staging[0]).toBe(0);
      expect(staging[1]).toBe(0);
      expect(staging[202]).toBe(101); // last x
      expect(staging[203]).toBe(101);
    });

    it('growth after modular wrap dual-copies retained points (1.1 A)', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      // Wrap once → start=1, capacity=4, logical [1,2,3,10]
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 });
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 1, capacity: 4 });
      const oldBuffer = store.getSeriesBuffer(0) as unknown as {
        destroy: ReturnType<typeof vi.fn>;
      };

      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      (device.queue.submit as ReturnType<typeof vi.fn>).mockClear();
      (device.createCommandEncoder as ReturnType<typeof vi.fn>).mockClear();

      // Leave-ring + large append forces growth; pure unbounded → dual modular GPU copy.
      const batch: Array<[number, number]> = [];
      for (let i = 0; i < 100; i++) batch.push([20 + i, 20 + i]);
      store.appendSeries(0, batch); // no maxPoints → leave-ring

      expect(store.getSeriesPointCount(0)).toBe(104); // 4 retained + 100
      expect(oldBuffer.destroy).toHaveBeenCalled();
      const encoder = (device as any).__lastEncoder as {
        copyBufferToBuffer: ReturnType<typeof vi.fn>;
      };
      // Dual copy: first from ringStart, rest from 0.
      expect(encoder.copyBufferToBuffer.mock.calls.length).toBe(2);
      const c0 = encoder.copyBufferToBuffer.mock.calls[0]!;
      const c1 = encoder.copyBufferToBuffer.mock.calls[1]!;
      // first = min(4, 4-1) = 3 points from phys start 1
      expect(c0[1]).toBe(1 * 8); // src offset
      expect(c0[3]).toBe(0); // dst offset
      expect(c0[4]).toBe(3 * 8);
      // rest = 1 point from phys 0
      expect(c1[1]).toBe(0);
      expect(c1[3]).toBe(3 * 8);
      expect(c1[4]).toBe(1 * 8);
      expect(device.queue.submit).toHaveBeenCalled();
    });

    it('isSeriesRingMode true during pre-wrap fill while layout.capacity is 0', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
      ]);
      // First activation under maxPoints without wrap yet.
      store.appendSeries(0, [[2, 2]], { maxPoints: 8 });
      expect(store.getSeriesPointCount(0)).toBe(3);
      expect(store.isSeriesRingMode(0)).toBe(true);
      // Decimation layout still reports linear until wrap.
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 0, capacity: 0 });
    });

    it('skipContentHash stamps and writes without full FNV short-circuit (2.6)', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
      ]);
      const hashA = store.getSeriesContentHash(0);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      // x also changes so y-only early-return does not apply; skipContentHash
      // forces stamp (no FNV early-return) and full write.
      store.setSeries(
        0,
        [
          [5, 1],
          [6, 2],
        ],
        { skipContentHash: true }
      );
      expect(store.getSeriesContentHash(0)).not.toBe(hashA);
      expect(device.queue.writeBuffer).toHaveBeenCalled();
    });

    it('first ring activation with prevCount > maxPoints keeps planned tail', () => {
      const store = createDataStore(device);
      // Seed 10 points unbounded.
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 10; i++) seed.push([i, i * 10]);
      store.setSeries(0, seed);

      // Append 1 with maxPoints=4 → keep last 3 of prev + new = [7,8,9,100]
      store.appendSeries(0, [[100, 999]], { maxPoints: 4 });
      expect(store.getSeriesPointCount(0)).toBe(4);
      // Rebuild leaves linear layout at start=0.
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 0, capacity: 0 });
      const staging = store.getSeriesStagingBuffer(0);
      // Chronological: x=7,8,9,100
      expect(staging[0]).toBe(7);
      expect(staging[2]).toBe(8);
      expect(staging[4]).toBe(9);
      expect(staging[6]).toBe(100);
      expect(staging[7]).toBe(999);
    });

    it('leave-ring after wrap linearizes chronological order', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      // Wrap once → modular start=1, content logical [1,2,3,10]
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 });
      expect(store.getSeriesRingLayout(0).start).toBe(1);

      // Omit maxPoints → unbounded leave-ring + append
      store.appendSeries(0, [[20, 20]]);
      expect(store.getSeriesPointCount(0)).toBe(5);
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 0, capacity: 0 });
      const staging = store.getSeriesStagingBuffer(0);
      // Chronological [1,2,3,10,20]
      expect(staging[0]).toBe(1);
      expect(staging[2]).toBe(2);
      expect(staging[4]).toBe(3);
      expect(staging[6]).toBe(10);
      expect(staging[8]).toBe(20);
    });

    it('multi-wrap keeps chronological logical order in staging physical slots', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      // Wrap three times with unit appends
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 }); // [1,2,3,10] start=1
      store.appendSeries(0, [[11, 11]], { maxPoints: 4 }); // [2,3,10,11] start=2
      store.appendSeries(0, [[12, 12]], { maxPoints: 4 }); // [3,10,11,12] start=3
      expect(store.getSeriesPointCount(0)).toBe(4);
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 3, capacity: 4 });
      const st = store.getSeriesStagingBuffer(0);
      // Physical: start=3 → logical 0 at phys 3 = 3, phys 0 = 10, phys 1 = 11, phys 2 = 12
      expect(st[6]).toBe(3);
      expect(st[0]).toBe(10);
      expect(st[2]).toBe(11);
      expect(st[4]).toBe(12);
    });

    it('strict-after-wrap resets layout to linear start=0', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 });
      expect(store.getSeriesRingLayout(0).start).toBe(1);
      store.appendSeries(
        0,
        [
          [20, 20],
          [21, 21],
          [22, 22],
          [23, 23],
        ],
        { maxPoints: 4 }
      );
      expect(store.getSeriesPointCount(0)).toBe(4);
      expect(store.getSeriesRingLayout(0)).toEqual({ start: 0, capacity: 0 });
      const st = store.getSeriesStagingBuffer(0);
      expect(st[0]).toBe(20);
      expect(st[6]).toBe(23);
    });

    it('split writeBuffer uses phys*8 and 0 offsets with correct sizes', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 }); // start=1
      store.appendSeries(0, [[11, 11]], { maxPoints: 4 }); // start=2
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      // write head=2, append 3 → phys 2,3,0
      store.appendSeries(
        0,
        [
          [20, 20],
          [21, 21],
          [22, 22],
        ],
        { maxPoints: 4 }
      );
      const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
      expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2);
      // first segment at phys 2 → byteOffset 16, size 16 (2 pts)
      expect(writes.mock.calls[0]![1]).toBe(16);
      expect(writes.mock.calls[0]![4]).toBe(16);
      // rest at phys 0 → byteOffset 0, size 8 (1 pt)
      expect(writes.mock.calls[1]![1]).toBe(0);
      expect(writes.mock.calls[1]![4]).toBe(8);
    });

    it('maxPoints=1 keeps single point on DataStore', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
      ]);
      store.appendSeries(0, [[50, 25]], { maxPoints: 1 });
      store.appendSeries(0, [[100, 50]], { maxPoints: 1 });
      expect(store.getSeriesPointCount(0)).toBe(1);
      const st = store.getSeriesStagingBuffer(0);
      expect(st[0]).toBe(100);
      expect(st[1]).toBe(50);
    });
  });

  /** Sum of explicit size args on writeBuffer calls (5th parameter). */
  function totalWritePayloadBytes(writeBuffer: ReturnType<typeof vi.fn>): number {
    let total = 0;
    for (const call of writeBuffer.mock.calls) {
      const sizeArg = call[4] as number | undefined;
      if (typeof sizeArg === 'number') total += sizeArg;
    }
    return total;
  }

  describe('equal-N y-only GPU rewrite (Track C)', () => {
    it('y-only identical content does not writeBuffer and keeps hash (2.1)', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
        [2, 3],
      ]);
      const hash = store.getSeriesContentHash(0);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      store.setSeries(0, [
        [0, 1],
        [1, 2],
        [2, 3],
      ]);
      expect(store.getSeriesContentHash(0)).toBe(hash);
      expect(device.queue.writeBuffer).not.toHaveBeenCalled();
    });

    it('y-only changed content: GPU payload ≤ N×4+16 (not full N×8)', () => {
      const store = createDataStore(device);
      // Use N large enough that y+params overhead is still ≪ full interleaved.
      const n = 32;
      const prev = Array.from({ length: n }, (_, i) => [i, i] as [number, number]);
      const next = Array.from({ length: n }, (_, i) => [i, i + 1] as [number, number]);
      store.setSeries(0, prev);
      const hashA = store.getSeriesContentHash(0);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      store.setSeries(0, next);
      expect(store.getSeriesContentHash(0)).not.toBe(hashA);
      const payload = totalWritePayloadBytes(device.queue.writeBuffer as ReturnType<typeof vi.fn>);
      expect(payload).toBeLessThan(n * 8);
      expect(payload).toBeLessThanOrEqual(n * 4 + 16);
      expect(store.getSeriesStagingBuffer(0)[1]).toBe(1);
    });

    it('equal-N y-only large N writes ≪ N×8 (compute y-lanes)', () => {
      const store = createDataStore(device);
      const n = 1000;
      store.setSeries(
        0,
        Array.from({ length: n }, (_, i) => [i, i * 0.1] as [number, number])
      );
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      (device.queue.submit as ReturnType<typeof vi.fn>).mockClear();
      (device.createBindGroup as ReturnType<typeof vi.fn>).mockClear();

      store.setSeries(
        0,
        Array.from({ length: n }, (_, i) => [i, i * 0.1 + 1] as [number, number])
      );

      const payload = totalWritePayloadBytes(device.queue.writeBuffer as ReturnType<typeof vi.fn>);
      expect(payload).toBeLessThan(n * 8);
      expect(payload).toBeLessThanOrEqual(n * 4 + 16);
      expect(device.queue.submit).toHaveBeenCalled();
      expect(device.createComputePipeline).toHaveBeenCalled();

      // Second y-only frame reuses bind group (no new createBindGroup).
      (device.createBindGroup as ReturnType<typeof vi.fn>).mockClear();
      store.setSeries(
        0,
        Array.from({ length: n }, (_, i) => [i, i * 0.1 + 2] as [number, number])
      );
      expect(device.createBindGroup).not.toHaveBeenCalled();
    });

    it('false-positive miss: Brownian xy uses full interleaved writeBuffer', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0.1, 1],
        [1.2, 2],
        [1.9, 3],
      ]);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      (device.createComputePipeline as ReturnType<typeof vi.fn>).mockClear();
      store.setSeries(0, [
        [0.2, 1.1],
        [1.3, 2.1],
        [2.0, 3.1],
      ]);
      const sizes = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[4] as number | undefined)
        .filter((s): s is number => typeof s === 'number');
      expect(sizes.some((s) => s === 24)).toBe(true);
      expect(device.createComputePipeline).not.toHaveBeenCalled();
    });

    it('false-positive miss: length change uses full interleaved write (no y-only compute)', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
      ]);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      (device.createComputePipeline as ReturnType<typeof vi.fn>).mockClear();
      store.setSeries(0, [
        [0, 1],
        [1, 2],
        [2, 3],
      ]);
      const payload = totalWritePayloadBytes(device.queue.writeBuffer as ReturnType<typeof vi.fn>);
      // Full 3 points × 8 = 24 (may be exact size arg)
      expect(payload).toBeGreaterThanOrEqual(24);
      expect(device.createComputePipeline).not.toHaveBeenCalled();
    });

    it('false-positive miss: null-gap structure change takes full path', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
        [2, 3],
      ] as any);
      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      (device.createComputePipeline as ReturnType<typeof vi.fn>).mockClear();
      // Gap appears: x no longer matches staging (NaN x) → not y-only
      store.setSeries(0, [[0, 1], null, [2, 3]] as any);
      expect(device.createComputePipeline).not.toHaveBeenCalled();
      const payload = totalWritePayloadBytes(device.queue.writeBuffer as ReturnType<typeof vi.fn>);
      expect(payload).toBeGreaterThanOrEqual(24);
    });

    it('false-positive miss: after ring wrap setSeries does not take y-only compute', () => {
      const store = createDataStore(device);
      const seed: Array<[number, number]> = [];
      for (let i = 0; i < 64; i++) seed.push([i, i]);
      store.setSeries(0, seed);
      store.setSeries(0, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
      // Wrap → modular ring
      store.appendSeries(0, [[10, 10]], { maxPoints: 4 });
      expect(store.getSeriesRingLayout(0).start).not.toBe(0);
      expect(store.isSeriesRingMode(0)).toBe(true);

      (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mockClear();
      (device.createComputePipeline as ReturnType<typeof vi.fn>).mockClear();
      // Equal-N-looking xy rewrite while ring-tagged: y-only requires linear layout.
      store.setSeries(0, [
        [1, 100],
        [2, 101],
        [3, 102],
        [10, 103],
      ]);
      expect(device.createComputePipeline).not.toHaveBeenCalled();
      const payload = totalWritePayloadBytes(device.queue.writeBuffer as ReturnType<typeof vi.fn>);
      // Full interleaved of 4 points
      expect(payload).toBeGreaterThanOrEqual(32);
    });

    it('dispose destroys y-rewrite yChannel and params buffers after y-only path', () => {
      const store = createDataStore(device);
      store.setSeries(0, [
        [0, 1],
        [1, 2],
        [2, 3],
      ]);
      store.setSeries(0, [
        [0, 10],
        [1, 20],
        [2, 30],
      ]);
      // Collect labeled y-rewrite buffers created by the equal-N path.
      const buffers = (device as any).__buffers as Array<{ label?: string; destroy: ReturnType<typeof vi.fn> }>;
      const yChannel = buffers.find((b) => b.label === 'DataStore/yChannelUpload');
      const yParams = buffers.find((b) => b.label === 'DataStore/yRewriteParams');
      expect(yChannel).toBeDefined();
      expect(yParams).toBeDefined();
      yChannel!.destroy.mockClear();
      yParams!.destroy.mockClear();

      store.dispose();
      expect(yChannel!.destroy).toHaveBeenCalled();
      expect(yParams!.destroy).toHaveBeenCalled();
    });
  });

  describe('streaming headroom policy (setSeries modest vs append cap)', () => {
    it('setSeries ≥10k reserves ~1M-point headroom (not multi-M hard floor)', () => {
      const store = createDataStore(device);
      const n = 10_000;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        x[i] = i;
        y[i] = i;
      }
      store.setSeries(0, { x, y });
      const buf = store.getSeriesBuffer(0) as unknown as { size: number };
      // 1M points * 8 bytes = 8_388_608 (pow2). Exact target is 80_000; headroom >> target.
      expect(buf.size).toBeGreaterThanOrEqual(1_000_000 * 8);
      // Must not jump to the old 4M-point hard floor on setSeries.
      expect(buf.size).toBeLessThan(4_000_000 * 8);
    });

    it('unbounded append ≥100k grows with 2× pad but caps at 2M points', () => {
      const store = createDataStore(device);
      // Seed just under growth path; small capacity then force past 100k.
      const seedN = 1000;
      const x0 = new Float64Array(seedN);
      const y0 = new Float64Array(seedN);
      for (let i = 0; i < seedN; i++) {
        x0[i] = i;
        y0[i] = i;
      }
      store.setSeries(0, { x: x0, y: y0 });

      // Grow to 100k+ in one append (unbounded).
      const add = 120_000;
      const x1 = new Float64Array(add);
      const y1 = new Float64Array(add);
      for (let i = 0; i < add; i++) {
        x1[i] = seedN + i;
        y1[i] = i;
      }
      store.appendSeries(0, { x: x1, y: y1 });
      const nextCount = seedN + add;
      expect(store.getSeriesPointCount(0)).toBe(nextCount);
      const buf = store.getSeriesBuffer(0) as unknown as { size: number };
      const targetBytes = nextCount * 8;
      // Pure geometric nextPow2(target) for 121k pts = 1_048_576.
      // 2× stream pad nextPow2(target*2) = 2_097_152 — must use the larger pad.
      const pureGeometric = 2 ** Math.ceil(Math.log2(targetBytes));
      const streamPad = 2 ** Math.ceil(Math.log2(targetBytes * 2));
      expect(streamPad).toBeGreaterThan(pureGeometric);
      expect(buf.size).toBe(streamPad);
      expect(buf.size).toBeLessThanOrEqual(2_000_000 * 8);
    });
  });
});
