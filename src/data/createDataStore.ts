import type { CartesianSeriesData } from "../config/types";
import { getPointCount, getX, getY, packXYInto } from "./cartesianData";

/**
 * Bounds tracked per series. Coordinates are in the original (pre-xOffset) domain.
 */
export type SeriesBounds = Readonly<{
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}>;

export interface DataStore {
  setSeries(
    index: number,
    data: CartesianSeriesData,
    options?: Readonly<{ xOffset?: number }>,
  ): void;
  /**
   * Appends new points to an existing series without re-uploading the entire buffer when possible.
   *
   * - Reuses the same geometric growth policy as `setSeries`.
   * - When no reallocation is needed, writes only the appended byte range via `queue.writeBuffer(...)`.
   * - When reallocation is needed (rare, amortized by geometric growth), performs a GPU-to-GPU
   *   copy of the existing data onto the new buffer via a self-contained `queue.submit`, then
   *   writes only the appended delta via `queue.writeBuffer`. This submit is outside the main
   *   render frame submit and is intentionally standalone so the old buffer can be destroyed
   *   safely immediately after the copy is submitted — batching into an external encoder would
   *   require deferring destruction until after the external submit.
   * - Maintains `pointCount` for render path queries.
   *
   * Throws if the series has not been set yet.
   */
  appendSeries(index: number, newPoints: CartesianSeriesData): void;
  removeSeries(index: number): void;
  getSeriesBuffer(index: number): GPUBuffer;
  /**
   * Returns the number of points last set for the given series index.
   *
   * Throws if the series has not been set yet.
   */
  getSeriesPointCount(index: number): number;
  /**
   * Returns incrementally-tracked bounds (xMin/xMax/yMin/yMax) for the given series, or `null`
   * when the series has no finite points. Bounds are updated on every `setSeries()` and merged
   * incrementally on `appendSeries()` so consumers can avoid per-frame O(n) data scans.
   *
   * X coordinates are reported in the original (pre-xOffset) domain — i.e. the same domain
   * the caller passed to `setSeries()` — so axis derivation does not need to compensate for
   * the Float32 precision-preserving offset.
   *
   * Throws if the series has not been set yet.
   */
  getSeriesBounds(index: number): SeriesBounds | null;
  dispose(): void;
}

type SeriesEntry = {
  readonly buffer: GPUBuffer;
  readonly capacityBytes: number;
  readonly pointCount: number;
  readonly hash32: number;
  /**
   * X-origin subtracted during packing to preserve Float32 precision for large-magnitude domains
   * (e.g. epoch-ms time axes). Stored so appendSeries can pack consistently.
   */
  readonly xOffset: number;
  /**
   * Growable staging buffer for interleaved Float32 x,y data.
   * Maintained to enable efficient incremental append without repacking all data.
   */
  readonly stagingBuffer: Float32Array;
  /**
   * Incremental bounds over the original (pre-xOffset) x and y values. `null` when the series
   * has zero finite points.
   */
  readonly bounds: SeriesBounds | null;
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

function computeGrownCapacityBytes(
  currentCapacityBytes: number,
  requiredBytes: number,
): number {
  // Grow geometrically to reduce buffer churn (power-of-two policy).
  // Enforce 4-byte alignment via MIN_BUFFER_BYTES (>= 4) and power-of-two growth.
  const required = Math.max(
    MIN_BUFFER_BYTES,
    roundUpToMultipleOf4(requiredBytes),
  );
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
  const u32 = new Uint32Array(
    data.buffer,
    data.byteOffset,
    data.byteLength / 4,
  );
  return fnv1aUpdate(0x811c9dc5, u32); // FNV-1a offset basis
}

/**
 * Computes bounds over a CartesianSeriesData input directly (no xOffset adjustment),
 * skipping non-finite x or y values. Returns `null` if no finite points exist.
 *
 * Kept local to the DataStore so bounds tracking shares the same accessor semantics as
 * `packXYInto` and stays cheap to update on `setSeries()` / `appendSeries()`.
 */
function computeBoundsFromCartesian(
  data: CartesianSeriesData,
  pointOffset: number,
  pointCount: number,
): SeriesBounds | null {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < pointCount; i++) {
    const idx = pointOffset + i;
    const x = getX(data, idx);
    const y = getY(data, idx);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  if (
    !Number.isFinite(xMin) ||
    !Number.isFinite(xMax) ||
    !Number.isFinite(yMin) ||
    !Number.isFinite(yMax)
  ) {
    return null;
  }

  return { xMin, xMax, yMin, yMax };
}

/**
 * Merges two bounds (either of which may be `null`).
 *
 * Note: bounds returned here are the raw min/max over the seen data — no min===max widening.
 * Consumers that need a non-degenerate domain should normalize at use-site (mirrors how
 * `computeRawBoundsFromCartesianData` is consumed downstream).
 */
function mergeBounds(
  a: SeriesBounds | null,
  b: SeriesBounds | null,
): SeriesBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    xMin: a.xMin < b.xMin ? a.xMin : b.xMin,
    xMax: a.xMax > b.xMax ? a.xMax : b.xMax,
    yMin: a.yMin < b.yMin ? a.yMin : b.yMin,
    yMax: a.yMax > b.yMax ? a.yMax : b.yMax,
  };
}

export function createDataStore(device: GPUDevice): DataStore {
  const series = new Map<number, SeriesEntry>();
  let disposed = false;

  /**
   * Packs CartesianSeriesData into an interleaved Float32Array using packXYInto.
   * Returns a view-safe Float32Array suitable for GPU upload.
   */
  const packCartesianData = (
    data: CartesianSeriesData,
    xOffset: number,
  ): Float32Array => {
    const pointCount = getPointCount(data);
    if (pointCount === 0) return new Float32Array(0);

    const buffer = new ArrayBuffer(pointCount * 2 * 4);
    const f32 = new Float32Array(buffer);

    packXYInto(f32, 0, data, 0, pointCount, xOffset);

    return f32;
  };

  const assertNotDisposed = (): void => {
    if (disposed) {
      throw new Error("DataStore is disposed.");
    }
  };

  const getSeriesEntry = (index: number): SeriesEntry => {
    assertNotDisposed();
    const entry = series.get(index);
    if (!entry) {
      throw new Error(
        `Series ${index} has no data. Call setSeries(${index}, data) first.`,
      );
    }
    return entry;
  };

  const setSeries = (
    index: number,
    data: CartesianSeriesData,
    options?: Readonly<{ xOffset?: number }>,
  ): void => {
    assertNotDisposed();

    const xOffset = options?.xOffset ?? 0;
    const pointCount = getPointCount(data);
    const packed = packCartesianData(data, xOffset);
    const hash32 = hashFloat32ArrayBits(packed);
    // Bounds are tracked in the original (pre-xOffset) domain so axis derivation does not need
    // to undo the precision-preserving offset.
    const bounds = computeBoundsFromCartesian(data, 0, pointCount);

    const requiredBytes = roundUpToMultipleOf4(packed.byteLength);
    const targetBytes = Math.max(MIN_BUFFER_BYTES, requiredBytes);

    const existing = series.get(index);
    const unchanged =
      existing &&
      existing.pointCount === pointCount &&
      existing.hash32 === hash32;
    if (unchanged) return;

    let buffer = existing?.buffer ?? null;
    let capacityBytes = existing?.capacityBytes ?? 0;
    let newBufferCreated = false;

    if (!buffer || targetBytes > capacityBytes) {
      const maxBufferSize = device.limits.maxBufferSize;
      if (targetBytes > maxBufferSize) {
        throw new Error(
          `DataStore.setSeries(${index}): required buffer size ${targetBytes} exceeds device.limits.maxBufferSize (${maxBufferSize}).`,
        );
      }

      if (buffer) {
        try {
          buffer.destroy();
        } catch {
          // Ignore destroy errors; we are replacing the buffer anyway.
        }
      }

      const grownCapacityBytes = computeGrownCapacityBytes(
        capacityBytes,
        targetBytes,
      );
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
        usage:
          GPUBufferUsage.VERTEX |
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
      });

      // Write data directly into the mapped range (avoids separate writeBuffer IPC round-trip)
      if (packed.byteLength > 0) {
        new Float32Array(buffer.getMappedRange(0, packed.byteLength)).set(
          packed,
        );
      }
      buffer.unmap();

      newBufferCreated = true;
    } else {
      // Existing buffer has enough capacity; update data in-place via writeBuffer
      if (packed.byteLength > 0) {
        device.queue.writeBuffer(
          buffer,
          0,
          packed.buffer,
          packed.byteOffset,
          packed.byteLength,
        );
      }
    }

    // Create staging buffer matching the packed data for efficient append
    const stagingBuffer = newBufferCreated
      ? new Float32Array(capacityBytes / 4)
      : existing?.stagingBuffer ?? new Float32Array(capacityBytes / 4);
    stagingBuffer.set(packed);

    series.set(index, {
      buffer,
      capacityBytes,
      pointCount,
      hash32,
      xOffset,
      stagingBuffer,
      bounds,
    });
  };

  const appendSeries = (
    index: number,
    newPoints: CartesianSeriesData,
  ): void => {
    assertNotDisposed();
    const newPointCount = getPointCount(newPoints);
    if (newPointCount === 0) return;

    const existing = getSeriesEntry(index);
    const prevPointCount = existing.pointCount;
    const nextPointCount = prevPointCount + newPointCount;

    // Each point is 2 floats (x, y) = 8 bytes.
    const requiredBytes = roundUpToMultipleOf4(nextPointCount * 2 * 4);
    const targetBytes = Math.max(MIN_BUFFER_BYTES, requiredBytes);

    let buffer = existing.buffer;
    let capacityBytes = existing.capacityBytes;
    let stagingBuffer = existing.stagingBuffer;

    const maxBufferSize = device.limits.maxBufferSize;

    if (targetBytes > capacityBytes) {
      if (targetBytes > maxBufferSize) {
        throw new Error(
          `DataStore.appendSeries(${index}): required buffer size ${targetBytes} exceeds device.limits.maxBufferSize (${maxBufferSize}).`,
        );
      }

      const grownCapacityBytes = computeGrownCapacityBytes(
        capacityBytes,
        targetBytes,
      );
      capacityBytes =
        grownCapacityBytes > maxBufferSize ? targetBytes : grownCapacityBytes;

      const newBuffer = device.createBuffer({
        size: capacityBytes,
        usage:
          GPUBufferUsage.VERTEX |
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      });

      // GPU-to-GPU copy of existing data (fast, no CPU round-trip).
      // Self-contained submit so that the old buffer can be safely destroyed immediately below —
      // deferring this copy into an external encoder would require pending-destroy tracking to
      // avoid destroying the source buffer before its submit executes.
      const existingBytes = prevPointCount * 2 * 4;
      if (existingBytes > 0) {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, newBuffer, 0, existingBytes);
        device.queue.submit([encoder.finish()]);
      }

      // Destroy old buffer after GPU copy is enqueued
      try {
        buffer.destroy();
      } catch {
        // Ignore destroy errors; we are replacing the buffer anyway.
      }

      buffer = newBuffer;

      // Create new staging buffer with grown capacity and copy old staged data
      const newStagingBuffer = new Float32Array(capacityBytes / 4);
      newStagingBuffer.set(stagingBuffer.subarray(0, prevPointCount * 2));

      // Pack only the NEW points into staging buffer and upload the delta
      packXYInto(
        newStagingBuffer,
        prevPointCount * 2,
        newPoints,
        0,
        newPointCount,
        existing.xOffset,
      );

      const appendedView = newStagingBuffer.subarray(
        prevPointCount * 2,
        nextPointCount * 2,
      );
      if (appendedView.byteLength > 0) {
        const byteOffset = prevPointCount * 2 * 4;
        device.queue.writeBuffer(
          buffer,
          byteOffset,
          appendedView.buffer,
          appendedView.byteOffset,
          appendedView.byteLength,
        );
      }

      // Compute hash over the full data in the staging buffer
      const fullPacked = newStagingBuffer.subarray(0, nextPointCount * 2);

      // Merge incremental bounds: scan only the new range and combine with the prior bounds.
      const appendedBounds = computeBoundsFromCartesian(
        newPoints,
        0,
        newPointCount,
      );
      const mergedBounds = mergeBounds(existing.bounds, appendedBounds);

      series.set(index, {
        buffer,
        capacityBytes,
        pointCount: nextPointCount,
        hash32: hashFloat32ArrayBits(fullPacked),
        xOffset: existing.xOffset,
        stagingBuffer: newStagingBuffer,
        bounds: mergedBounds,
      });
      return;
    }

    // Fast path: pack directly into existing staging buffer and upload only the appended range.
    packXYInto(
      stagingBuffer,
      prevPointCount * 2,
      newPoints,
      0,
      newPointCount,
      existing.xOffset,
    );

    const appendedView = stagingBuffer.subarray(
      prevPointCount * 2,
      nextPointCount * 2,
    );
    if (appendedView.byteLength > 0) {
      const byteOffset = prevPointCount * 2 * 4;
      device.queue.writeBuffer(
        buffer,
        byteOffset,
        appendedView.buffer,
        appendedView.byteOffset,
        appendedView.byteLength,
      );
    }

    // Incremental FNV-1a update over the appended IEEE-754 bit patterns.
    const appendWords = new Uint32Array(
      appendedView.buffer,
      appendedView.byteOffset,
      appendedView.byteLength / 4,
    );
    const nextHash32 = fnv1aUpdate(existing.hash32, appendWords);

    // Merge incremental bounds over only the new range.
    const appendedBounds = computeBoundsFromCartesian(
      newPoints,
      0,
      newPointCount,
    );
    const mergedBounds = mergeBounds(existing.bounds, appendedBounds);

    series.set(index, {
      buffer,
      capacityBytes,
      pointCount: nextPointCount,
      hash32: nextHash32,
      xOffset: existing.xOffset,
      stagingBuffer,
      bounds: mergedBounds,
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

  const getSeriesBounds = (index: number): SeriesBounds | null => {
    return getSeriesEntry(index).bounds;
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
    getSeriesBounds,
    dispose,
  };
}
