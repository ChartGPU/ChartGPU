import type { DataPoint } from '../config/types';
import { packDataPoints } from './packDataPoints';

export interface DataStore {
  setSeries(index: number, data: ReadonlyArray<DataPoint>): void;
  /**
   * Appends new points to an existing series without re-uploading the entire buffer when possible.
   *
   * - Reuses the same geometric growth policy as `setSeries`.
   * - When no reallocation is needed, writes only the appended byte range via `queue.writeBuffer(...)`.
   * - Maintains `pointCount` and a CPU-side combined data array so `getSeriesData(...)` remains correct.
   *
   * Throws if the series has not been set yet.
   */
  appendSeries(index: number, newPoints: ReadonlyArray<DataPoint>): void;
  removeSeries(index: number): void;
  getSeriesBuffer(index: number): GPUBuffer;
  /**
   * Returns the number of points last set for the given series index.
   *
   * Throws if the series has not been set yet.
   */
  getSeriesPointCount(index: number): number;
  /**
   * Returns the last CPU-side data set for the given series index.
   *
   * This is intended for internal metadata/hit-testing paths that need the same
   * input array that was packed into the GPU buffer (without re-threading it
   * through other state). Throws if the series has not been set yet.
   */
  getSeriesData(index: number): ReadonlyArray<DataPoint>;
  dispose(): void;
}

type SeriesEntry = {
  readonly buffer: GPUBuffer;
  readonly capacityBytes: number;
  readonly pointCount: number;
  readonly hash32: number;
  // Store a mutable array so streaming append can update in-place.
  readonly data: DataPoint[];
};

const MIN_BUFFER_BYTES = 4;

function roundUpToMultipleOf4(bytes: number): number {
  return (bytes + 3) & ~3;
}

function nextPow2(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 1;
  const n = Math.ceil(bytes);
  return 2 ** Math.ceil(Math.log2(n));
}

function computeGrownCapacityBytes(currentCapacityBytes: number, requiredBytes: number): number {
  // Grow geometrically to reduce buffer churn (power-of-two policy).
  // Enforce 4-byte alignment via MIN_BUFFER_BYTES (>= 4) and power-of-two growth.
  const required = Math.max(MIN_BUFFER_BYTES, roundUpToMultipleOf4(requiredBytes));
  const grown = Math.max(MIN_BUFFER_BYTES, nextPow2(required));
  return Math.max(currentCapacityBytes, grown);
}

function fnv1aUpdate(hash: number, words: Uint32Array): number {
  let h = hash >>> 0;
  for (let i = 0; i < words.length; i++) {
    h ^= words[i]!;
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime
  }
  return h >>> 0;
}

/**
 * Computes a stable 32-bit hash of the Float32 contents using their IEEE-754
 * bit patterns (not numeric equality), to cheaply detect changes.
 */
function hashFloat32ArrayBits(data: Float32Array): number {
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  return fnv1aUpdate(0x811c9dc5, u32); // FNV-1a offset basis
}

export function createDataStore(device: GPUDevice): DataStore {
  const series = new Map<number, SeriesEntry>();
  let disposed = false;

  const assertNotDisposed = (): void => {
    if (disposed) {
      throw new Error('DataStore is disposed.');
    }
  };

  const getSeriesEntry = (index: number): SeriesEntry => {
    assertNotDisposed();
    const entry = series.get(index);
    if (!entry) {
      throw new Error(`Series ${index} has no data. Call setSeries(${index}, data) first.`);
    }
    return entry;
  };

  const setSeries = (index: number, data: ReadonlyArray<DataPoint>): void => {
    assertNotDisposed();

    const packed = packDataPoints(data);
    const pointCount = data.length;
    const hash32 = hashFloat32ArrayBits(packed);

    const requiredBytes = roundUpToMultipleOf4(packed.byteLength);
    const targetBytes = Math.max(MIN_BUFFER_BYTES, requiredBytes);

    const existing = series.get(index);
    const unchanged = existing && existing.pointCount === pointCount && existing.hash32 === hash32;
    if (unchanged) return;

    let buffer = existing?.buffer ?? null;
    let capacityBytes = existing?.capacityBytes ?? 0;

    if (!buffer || targetBytes > capacityBytes) {
      const maxBufferSize = device.limits.maxBufferSize;
      if (targetBytes > maxBufferSize) {
        throw new Error(
          `DataStore.setSeries(${index}): required buffer size ${targetBytes} exceeds device.limits.maxBufferSize (${maxBufferSize}).`
        );
      }

      if (buffer) {
        try {
          buffer.destroy();
        } catch {
          // Ignore destroy errors; we are replacing the buffer anyway.
        }
      }

      const grownCapacityBytes = computeGrownCapacityBytes(capacityBytes, targetBytes);
      if (grownCapacityBytes > maxBufferSize) {
        // If geometric growth would exceed the limit, fall back to the exact required size.
        // (Still no shrink: if current capacity was already larger, we'd keep it above.)
        // NOTE: targetBytes is already checked against maxBufferSize above.
        capacityBytes = targetBytes;
      } else {
        capacityBytes = grownCapacityBytes;
      }

      buffer = device.createBuffer({
        size: capacityBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }

    // Avoid 0-byte writes (empty series). The buffer is still valid for binding.
    if (packed.byteLength > 0) {
      device.queue.writeBuffer(buffer, 0, packed.buffer);
    }

    series.set(index, {
      buffer,
      capacityBytes,
      pointCount,
      hash32,
      data: data.length === 0 ? [] : data.slice(),
    });
  };

  const appendSeries = (index: number, newPoints: ReadonlyArray<DataPoint>): void => {
    assertNotDisposed();
    if (!newPoints || newPoints.length === 0) return;

    const existing = getSeriesEntry(index);
    const prevPointCount = existing.pointCount;
    const nextPointCount = prevPointCount + newPoints.length;

    const appendPacked = packDataPoints(newPoints);
    const appendBytes = appendPacked.byteLength;

    // Each point is 2 floats (x, y) = 8 bytes.
    const requiredBytes = roundUpToMultipleOf4(nextPointCount * 2 * 4);
    const targetBytes = Math.max(MIN_BUFFER_BYTES, requiredBytes);

    let buffer = existing.buffer;
    let capacityBytes = existing.capacityBytes;

    // Ensure the CPU-side store is updated regardless of GPU growth path.
    const nextData = existing.data;
    nextData.push(...newPoints);

    const maxBufferSize = device.limits.maxBufferSize;

    if (targetBytes > capacityBytes) {
      if (targetBytes > maxBufferSize) {
        throw new Error(
          `DataStore.appendSeries(${index}): required buffer size ${targetBytes} exceeds device.limits.maxBufferSize (${maxBufferSize}).`
        );
      }

      // Replace buffer (no shrink). This is the slow path; we re-upload the full series.
      try {
        buffer.destroy();
      } catch {
        // Ignore destroy errors; we are replacing the buffer anyway.
      }

      const grownCapacityBytes = computeGrownCapacityBytes(capacityBytes, targetBytes);
      capacityBytes = grownCapacityBytes > maxBufferSize ? targetBytes : grownCapacityBytes;

      buffer = device.createBuffer({
        size: capacityBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const fullPacked = packDataPoints(nextData);
      if (fullPacked.byteLength > 0) {
        device.queue.writeBuffer(buffer, 0, fullPacked.buffer);
      }

      series.set(index, {
        buffer,
        capacityBytes,
        pointCount: nextPointCount,
        hash32: hashFloat32ArrayBits(fullPacked),
        data: nextData,
      });
      return;
    }

    // Fast path: write only the appended range into the existing buffer.
    if (appendBytes > 0) {
      const byteOffset = prevPointCount * 2 * 4;
      device.queue.writeBuffer(buffer, byteOffset, appendPacked.buffer);
    }

    // Incremental FNV-1a update over the appended IEEE-754 bit patterns.
    const appendWords = new Uint32Array(appendPacked.buffer, appendPacked.byteOffset, appendPacked.byteLength / 4);
    const nextHash32 = fnv1aUpdate(existing.hash32, appendWords);

    series.set(index, {
      buffer,
      capacityBytes,
      pointCount: nextPointCount,
      hash32: nextHash32,
      data: nextData,
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
    return getSeriesEntry(index).buffer;
  };

  const getSeriesPointCount = (index: number): number => {
    return getSeriesEntry(index).pointCount;
  };

  const getSeriesData = (index: number): ReadonlyArray<DataPoint> => {
    return getSeriesEntry(index).data;
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
    appendSeries,
    removeSeries,
    getSeriesBuffer,
    getSeriesPointCount,
    getSeriesData,
    dispose,
  };
}

