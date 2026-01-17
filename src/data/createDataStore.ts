import type { DataPoint } from '../config/types';

export interface DataStore {
  setSeries(index: number, data: ReadonlyArray<DataPoint>): void;
  removeSeries(index: number): void;
  getSeriesBuffer(index: number): GPUBuffer;
  dispose(): void;
}

type SeriesEntry = {
  readonly buffer: GPUBuffer;
  readonly capacityBytes: number;
  readonly pointCount: number;
  readonly hash32: number;
  readonly data: ReadonlyArray<DataPoint>;
};

const MIN_BUFFER_BYTES = 4;

function roundUpToMultipleOf4(bytes: number): number {
  return (bytes + 3) & ~3;
}

function isTupleDataPoint(point: DataPoint): point is readonly [x: number, y: number] {
  // `DataPoint` uses a readonly tuple; `Array.isArray` doesn't narrow it well without a predicate.
  return Array.isArray(point);
}

function packDataPoints(
  data: ReadonlyArray<DataPoint>
): { readonly buffer: ArrayBuffer; readonly f32: Float32Array } {
  // Allocate with an explicit ArrayBuffer so we can upload that buffer directly
  // (typed as `ArrayBuffer`) to satisfy `@webgpu/types` without unsafe casts.
  const buffer = new ArrayBuffer(data.length * 2 * 4);
  const f32 = new Float32Array(buffer);

  for (let i = 0; i < data.length; i++) {
    const point = data[i];
    const x = isTupleDataPoint(point) ? point[0] : point.x;
    const y = isTupleDataPoint(point) ? point[1] : point.y;
    f32[i * 2 + 0] = x;
    f32[i * 2 + 1] = y;
  }

  return { buffer, f32 };
}

/**
 * Computes a stable 32-bit hash of the Float32 contents using their IEEE-754
 * bit patterns (not numeric equality), to cheaply detect changes.
 */
function hashFloat32ArrayBits(data: Float32Array): number {
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < u32.length; i++) {
    hash ^= u32[i];
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}

export function createDataStore(device: GPUDevice): DataStore {
  const series = new Map<number, SeriesEntry>();
  let disposed = false;

  const assertNotDisposed = (): void => {
    if (disposed) {
      throw new Error('DataStore is disposed.');
    }
  };

  const setSeries = (index: number, data: ReadonlyArray<DataPoint>): void => {
    assertNotDisposed();

    const packed = packDataPoints(data);
    const pointCount = data.length;
    const hash32 = hashFloat32ArrayBits(packed.f32);

    const requiredBytes = roundUpToMultipleOf4(packed.f32.byteLength);
    const targetBytes = Math.max(MIN_BUFFER_BYTES, requiredBytes);

    const existing = series.get(index);
    const unchanged = existing && existing.pointCount === pointCount && existing.hash32 === hash32;
    if (unchanged) return;

    let buffer = existing?.buffer ?? null;
    let capacityBytes = existing?.capacityBytes ?? 0;

    if (!buffer || targetBytes > capacityBytes) {
      if (buffer) {
        try {
          buffer.destroy();
        } catch {
          // Ignore destroy errors; we are replacing the buffer anyway.
        }
      }

      buffer = device.createBuffer({
        size: targetBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      capacityBytes = targetBytes;
    }

    // Avoid 0-byte writes (empty series). The buffer is still valid for binding.
    if (packed.f32.byteLength > 0) {
      device.queue.writeBuffer(buffer, 0, packed.buffer);
    }

    series.set(index, {
      buffer,
      capacityBytes,
      pointCount,
      hash32,
      data,
    });
  };

  const removeSeries = (index: number): void => {
    assertNotDisposed();

    const entry = series.get(index);
    if (!entry) return;

    try {
      entry.buffer.destroy();
    } catch {
      // Ignore destroy errors; removal should be best-effort.
    }
    series.delete(index);
  };

  const getSeriesBuffer = (index: number): GPUBuffer => {
    assertNotDisposed();

    const entry = series.get(index);
    if (!entry) {
      throw new Error(`Series ${index} has no data. Call setSeries(${index}, data) first.`);
    }
    return entry.buffer;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    for (const entry of series.values()) {
      try {
        entry.buffer.destroy();
      } catch {
        // Ignore destroy errors; disposal should be best-effort.
      }
    }
    series.clear();
  };

  return {
    setSeries,
    removeSeries,
    getSeriesBuffer,
    dispose,
  };
}

