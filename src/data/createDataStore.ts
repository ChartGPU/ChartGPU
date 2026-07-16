import type { CartesianSeriesData } from "../config/types";
import { getPointCount, packXYInto } from "./cartesianData";
import {
  maxPointsPeakRetention,
  normalizeMaxPoints,
  planMaxPointsWindow,
} from "./maxPointsWindow";
import {
  isYOnlyRewriteAgainstStaging,
  packYOnlyInto,
} from "./seriesRewriteDetect";

export type SeriesRingLayout = Readonly<{
  /**
   * Physical index of the oldest retained point. `0` with `capacity === 0`
   * means linear layout in `[0, pointCount)`.
   */
  start: number;
  /**
   * Modular ring size in points. `0` means the buffer is chronological /
   * linear (decimation may index `raw[i]` directly).
   */
  capacity: number;
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
   * - Reuses the same geometric growth policy as `setSeries` when unbounded.
   * - When no reallocation is needed and no points are dropped, writes only the appended byte
   *   range via `queue.writeBuffer(...)`.
   * - When `maxPoints` is set, applies the shared fixed-capacity **ring** policy
   *   (`planMaxPointsWindow` in `maxPointsWindow.ts`):
   *   - if the new batch alone is ≥ `maxPoints`, keep only that batch’s tail
   *     (strict replace — previous points discarded);
   *   - else fill up to `maxPoints`, then overwrite oldest slots modularly
   *     (O(append) `writeBuffer` only — no full retained-window rewrite).
   * - Peak GPU reservation under ring capacity is **`maxPoints`** points.
   * - Maintains `pointCount` for render path queries.
   *
   * Throws if the series has not been set yet.
   */
  appendSeries(
    index: number,
    newPoints: CartesianSeriesData,
    options?: Readonly<{ maxPoints?: number }>,
  ): void;
  removeSeries(index: number): void;
  getSeriesBuffer(index: number): GPUBuffer;
  /**
   * Returns the number of points last set for the given series index.
   *
   * Throws if the series has not been set yet.
   */
  getSeriesPointCount(index: number): number;
  /**
   * Modular ring layout for GPU consumers (decimation). When `capacity === 0`,
   * points are packed linearly at the start of the buffer.
   */
  getSeriesRingLayout(index: number): SeriesRingLayout;
  /**
   * Returns the FNV-1a content hash of the packed Float32 payload for this series.
   * Changes whenever `setSeries` / `appendSeries` rewrites floats (even into the
   * same buffer at the same point count). Used by GPU decimation dirty-gating
   * (WG-P0-2) so same-N content rewrites re-dispatch compute.
   *
   * Throws if the series has not been set yet.
   */
  getSeriesContentHash(index: number): number;
  /**
   * Capacity-sized CPU staging buffer retained for this series (WG-P1-9).
   * Same object identity across `setSeries` calls that do not grow capacity.
   * Under ring mode after wrap, layout is **modular** (oldest at `ringStart`).
   *
   * Throws if the series has not been set yet.
   */
  getSeriesStagingBuffer(index: number): Float32Array;
  /**
   * X-origin subtracted during packing (time-axis Float32 precision). Staging
   * stores `x - xOffset`; domain-space consumers must add this back.
   */
  getSeriesXOffset(index: number): number;
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
   * Ring mode: modular layout matching the GPU buffer.
   */
  readonly stagingBuffer: Float32Array;
  /** Physical index of oldest point when ringCapacityPoints > 0 and wrapped. */
  readonly ringStart: number;
  /**
   * Fixed ring capacity in points when maxPoints streaming is active.
   * `0` means unbounded / linear packing only.
   */
  readonly ringCapacityPoints: number;
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
 * Packs `pointCount` points from `src` into modular ring slots of `out`,
 * starting at physical index `physStart` (wraps at `ringCapacity`).
 */
function packXYIntoRing(
  out: Float32Array,
  physStart: number,
  ringCapacity: number,
  src: CartesianSeriesData,
  srcPointOffset: number,
  pointCount: number,
  xOffset: number,
): void {
  if (pointCount <= 0 || ringCapacity <= 0) return;
  const first = Math.min(pointCount, ringCapacity - physStart);
  if (first > 0) {
    packXYInto(out, physStart * 2, src, srcPointOffset, first, xOffset);
  }
  const rest = pointCount - first;
  if (rest > 0) {
    packXYInto(out, 0, src, srcPointOffset + first, rest, xOffset);
  }
}

/**
 * Uploads a modular contiguous-or-wrapped point range from staging to the GPU.
 * `physStart` / `pointCount` are in points; may split into two writeBuffer calls.
 */
function writeRingRangeToGpu(
  device: GPUDevice,
  buffer: GPUBuffer,
  staging: Float32Array,
  physStart: number,
  ringCapacity: number,
  pointCount: number,
): void {
  if (pointCount <= 0) return;
  const first = Math.min(pointCount, ringCapacity - physStart);
  if (first > 0) {
    const view = staging.subarray(physStart * 2, (physStart + first) * 2);
    if (view.byteLength > 0) {
      device.queue.writeBuffer(
        buffer,
        physStart * 2 * 4,
        view.buffer,
        view.byteOffset,
        view.byteLength,
      );
    }
  }
  const rest = pointCount - first;
  if (rest > 0) {
    const view = staging.subarray(0, rest * 2);
    if (view.byteLength > 0) {
      device.queue.writeBuffer(
        buffer,
        0,
        view.buffer,
        view.byteOffset,
        view.byteLength,
      );
    }
  }
}

/**
 * Copies modular (or linear) staging into chronological order at the start of
 * `out` for `count` logical points. Safe when `out === src` only if layout is
 * already linear (`ringStart === 0` or `ringCap === 0`).
 */
function linearizeStagingChronological(
  out: Float32Array,
  src: Float32Array,
  ringStart: number,
  ringCap: number,
  count: number,
): void {
  if (count <= 0) return;
  if (ringCap <= 0 || ringStart === 0) {
    if (out !== src) {
      out.set(src.subarray(0, count * 2));
    }
    return;
  }
  // Modular → chronological. Use a temp when overlapping the same buffer.
  const needsTemp = out === src;
  const dest = needsTemp ? new Float32Array(count * 2) : out;
  for (let i = 0; i < count; i++) {
    const phys = (ringStart + i) % ringCap;
    dest[i * 2] = src[phys * 2]!;
    dest[i * 2 + 1] = src[phys * 2 + 1]!;
  }
  if (needsTemp) {
    out.set(dest);
  }
}

function writeFullPointsToGpu(
  device: GPUDevice,
  buffer: GPUBuffer,
  staging: Float32Array,
  pointCount: number,
): void {
  if (pointCount <= 0) return;
  const view = staging.subarray(0, pointCount * 2);
  if (view.byteLength === 0) return;
  device.queue.writeBuffer(
    buffer,
    0,
    view.buffer,
    view.byteOffset,
    view.byteLength,
  );
}

export function createDataStore(device: GPUDevice): DataStore {
  const series = new Map<number, SeriesEntry>();
  let disposed = false;

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
    const requiredBytes = roundUpToMultipleOf4(pointCount * 2 * 4);
    const targetBytes = Math.max(MIN_BUFFER_BYTES, requiredBytes);

    const existing = series.get(index);

    let buffer = existing?.buffer ?? null;
    let capacityBytes = existing?.capacityBytes ?? 0;

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
          GPUBufferUsage.COPY_DST,
      });
    } else {
      capacityBytes = existing!.capacityBytes;
    }

    // Reuse existing staging when capacity fits (WG-P1-9). Pack directly into
    // staging to avoid a temporary Float32Array allocation every full rewrite.
    const requiredStagingFloats = capacityBytes / 4;
    let stagingBuffer = existing?.stagingBuffer;
    if (!stagingBuffer || stagingBuffer.length < requiredStagingFloats) {
      stagingBuffer = new Float32Array(requiredStagingFloats);
    }

    // Y-only path: same length + identical x channel → rewrite y floats only in
    // staging (CPU). Must NOT fire for Brownian scatter where x also changes.
    // Note: GPU upload is still a full interleaved writeBuffer of N*8 bytes —
    // WebGPU has no strided partial upload; residual vs true partial GPU xfer.
    // Suite group 4 is scatter (default LTTB) so this path is mainly for line/
    // bar full-rewrite with sorted x, not the scatter hot path.
    const yOnly =
      existing != null &&
      existing.pointCount === pointCount &&
      existing.xOffset === xOffset &&
      existing.ringStart === 0 &&
      existing.ringCapacityPoints === 0 &&
      isYOnlyRewriteAgainstStaging(
        data,
        existing.stagingBuffer,
        existing.pointCount,
        existing.xOffset,
      );

    if (yOnly) {
      packYOnlyInto(stagingBuffer, data, pointCount);
    } else if (pointCount > 0) {
      packXYInto(stagingBuffer, 0, data, 0, pointCount, xOffset);
    }

    const packedView =
      pointCount > 0
        ? stagingBuffer.subarray(0, pointCount * 2)
        : new Float32Array(0);
    const hash32 = hashFloat32ArrayBits(packedView);

    const unchanged =
      existing &&
      existing.pointCount === pointCount &&
      existing.hash32 === hash32 &&
      existing.ringStart === 0 &&
      existing.buffer === buffer;
    if (unchanged) {
      // Staging may already match GPU; keep entry identity.
      return;
    }

    // Full interleaved GPU upload (even after y-only CPU pack).
    if (packedView.byteLength > 0) {
      device.queue.writeBuffer(
        buffer,
        0,
        packedView.buffer,
        packedView.byteOffset,
        packedView.byteLength,
      );
    }

    series.set(index, {
      buffer,
      capacityBytes,
      pointCount,
      hash32,
      xOffset,
      stagingBuffer,
      ringStart: 0,
      ringCapacityPoints: 0,
    });
  };

  const appendSeries = (
    index: number,
    newPoints: CartesianSeriesData,
    options?: Readonly<{ maxPoints?: number }>,
  ): void => {
    assertNotDisposed();
    const newPointCount = getPointCount(newPoints);
    if (newPointCount === 0) return;

    const existing = getSeriesEntry(index);
    const prevPointCount = existing.pointCount;
    const maxPoints = normalizeMaxPoints(options?.maxPoints);
    const plan = planMaxPointsWindow(
      prevPointCount,
      newPointCount,
      maxPoints,
    );
    const {
      nextCount: nextPointCount,
      dropPrevCount,
      newSrcOffset,
      keepNewCount,
      isStrictReplace,
      ringCapacity,
      isRing,
    } = plan;

    // Reserve peak ring capacity when maxPoints is set so streaming never
    // reallocates (full re-upload) on every geometric step.
    const reservePoints =
      isRing && ringCapacity > 0
        ? Math.max(nextPointCount, maxPointsPeakRetention(ringCapacity))
        : nextPointCount;
    const requiredBytes = roundUpToMultipleOf4(reservePoints * 2 * 4);
    const targetBytes = Math.max(MIN_BUFFER_BYTES, requiredBytes);

    let buffer = existing.buffer;
    let capacityBytes = existing.capacityBytes;
    let stagingBuffer = existing.stagingBuffer;
    let ringStart = existing.ringStart;
    const maxBufferSize = device.limits.maxBufferSize;
    const prevRingCap = existing.ringCapacityPoints;
    const prevRingStart = existing.ringStart;
    const wasRing = prevRingCap > 0;

    const needsGrowth = targetBytes > capacityBytes;

    // Modular ring O(append) path when:
    // - maxPoints active, no growth, not strict replace
    // - first activation with prev already ≤ capacity (linear base, ringStart=0), OR
    // - already ring-tagged at the same capacity with prev ≤ capacity
    // Oversized→ring (prev > capacity) and capacity changes use rebuild below.
    const firstRingActivation =
      isRing &&
      !wasRing &&
      ringCapacity > 0 &&
      prevPointCount <= ringCapacity;
    const continuingRing =
      isRing &&
      wasRing &&
      prevRingCap === ringCapacity &&
      ringCapacity > 0 &&
      prevPointCount <= prevRingCap;
    const steadyRing =
      (firstRingActivation || continuingRing) &&
      !needsGrowth &&
      !isStrictReplace;

    // Pure linear ranged append: never been a ring, no windowing, no growth.
    const pureLinearRanged =
      !isRing &&
      !wasRing &&
      !needsGrowth &&
      !isStrictReplace &&
      dropPrevCount === 0;

    // ── Growth: allocate new GPU buffer + linearize staging chronologically ──
    // Retained points are always full-uploaded later on non-steady paths (or
    // here when we continue into pure linear after growth).
    if (needsGrowth) {
      if (targetBytes > maxBufferSize) {
        throw new Error(
          `DataStore.appendSeries(${index}): required buffer size ${targetBytes} exceeds device.limits.maxBufferSize (${maxBufferSize}).`,
        );
      }
      const oldStaging = existing.stagingBuffer;
      const oldStart = existing.ringStart;
      const oldCap = existing.ringCapacityPoints;
      const oldCount = existing.pointCount;

      try {
        buffer.destroy();
      } catch {
        // Ignore destroy errors; we are replacing the buffer anyway.
      }
      const grownCapacityBytes = computeGrownCapacityBytes(
        capacityBytes,
        targetBytes,
      );
      capacityBytes =
        grownCapacityBytes > maxBufferSize ? targetBytes : grownCapacityBytes;
      buffer = device.createBuffer({
        size: capacityBytes,
        usage:
          GPUBufferUsage.VERTEX |
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST,
      });
      stagingBuffer = new Float32Array(capacityBytes / 4);

      // Linearize previous points into chronological order at offset 0.
      // GPU contents are empty until we full-upload after packing new points.
      linearizeStagingChronological(
        stagingBuffer,
        oldStaging,
        oldStart,
        oldCap,
        oldCount,
      );
      ringStart = 0;
    }

    // ── Strict replace: linear pack of the new batch tail at index 0 ──
    if (isStrictReplace) {
      packXYInto(
        stagingBuffer,
        0,
        newPoints,
        newSrcOffset,
        keepNewCount,
        existing.xOffset,
      );
      const fullPacked = stagingBuffer.subarray(0, nextPointCount * 2);
      writeFullPointsToGpu(device, buffer, stagingBuffer, nextPointCount);
      series.set(index, {
        buffer,
        capacityBytes,
        pointCount: nextPointCount,
        hash32: hashFloat32ArrayBits(fullPacked),
        xOffset: existing.xOffset,
        stagingBuffer,
        ringStart: 0,
        ringCapacityPoints: isRing ? ringCapacity : 0,
      });
      return;
    }

    // ── Steady modular ring: O(append) overwrite only ──
    if (steadyRing) {
      const cap = ringCapacity;
      // First activation: layout is chronological at ringStart=0.
      if (!wasRing) {
        ringStart = 0;
      } else if (ringStart >= cap) {
        ringStart = ringStart % cap;
      }

      const writeHead =
        prevPointCount >= cap
          ? ringStart
          : (ringStart + prevPointCount) % cap;

      packXYIntoRing(
        stagingBuffer,
        writeHead,
        cap,
        newPoints,
        newSrcOffset,
        keepNewCount,
        existing.xOffset,
      );
      writeRingRangeToGpu(
        device,
        buffer,
        stagingBuffer,
        writeHead,
        cap,
        keepNewCount,
      );

      const nextRingStart =
        dropPrevCount > 0 ? (ringStart + dropPrevCount) % cap : ringStart;

      let nextHash32 = existing.hash32;
      if (keepNewCount <= cap - writeHead) {
        const writtenView = stagingBuffer.subarray(
          writeHead * 2,
          (writeHead + keepNewCount) * 2,
        );
        nextHash32 = fnv1aUpdate(
          nextHash32,
          new Uint32Array(
            writtenView.buffer,
            writtenView.byteOffset,
            writtenView.byteLength / 4,
          ),
        );
      } else {
        const first = cap - writeHead;
        const v1 = stagingBuffer.subarray(
          writeHead * 2,
          (writeHead + first) * 2,
        );
        const v2 = stagingBuffer.subarray(0, (keepNewCount - first) * 2);
        nextHash32 = fnv1aUpdate(
          nextHash32,
          new Uint32Array(v1.buffer, v1.byteOffset, v1.byteLength / 4),
        );
        nextHash32 = fnv1aUpdate(
          nextHash32,
          new Uint32Array(v2.buffer, v2.byteOffset, v2.byteLength / 4),
        );
      }
      if (dropPrevCount > 0) {
        nextHash32 = (nextHash32 + 0x9e3779b9) >>> 0;
      }

      series.set(index, {
        buffer,
        capacityBytes,
        pointCount: nextPointCount,
        hash32: nextHash32,
        xOffset: existing.xOffset,
        stagingBuffer,
        ringStart: nextRingStart,
        ringCapacityPoints: cap,
      });
      return;
    }

    // ── Pure linear ranged append (no maxPoints, no growth) ──
    if (pureLinearRanged) {
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

      const appendWords = new Uint32Array(
        appendedView.buffer,
        appendedView.byteOffset,
        appendedView.byteLength / 4,
      );
      const nextHash32 = fnv1aUpdate(existing.hash32, appendWords);

      series.set(index, {
        buffer,
        capacityBytes,
        pointCount: nextPointCount,
        hash32: nextHash32,
        xOffset: existing.xOffset,
        stagingBuffer,
        ringStart: 0,
        ringCapacityPoints: 0,
      });
      return;
    }

    // ── Rebuild path (growth, leave-ring, activate ring, capacity change,
    //    oversized→ring, or any non-steady transition) ──
    // Staging must be chronological [0, prevPointCount); GPU full-upload of the
    // planned retained window after packing. ringStart always resets to 0.
    if (!needsGrowth) {
      // Linearize modular layout in place when leaving ring / changing capacity /
      // activating from a previously modular buffer without growth.
      if (prevRingCap > 0 && prevRingStart !== 0) {
        linearizeStagingChronological(
          stagingBuffer,
          stagingBuffer,
          prevRingStart,
          prevRingCap,
          prevPointCount,
        );
      }
    }
    // After growth we already linearized; ringStart is 0.

    // Apply drop of oldest previous points in chronological space.
    if (dropPrevCount > 0 && dropPrevCount < prevPointCount) {
      stagingBuffer.copyWithin(
        0,
        dropPrevCount * 2,
        prevPointCount * 2,
      );
    }
    const retainedPrev =
      dropPrevCount >= prevPointCount ? 0 : prevPointCount - dropPrevCount;

    // Pack kept new points after the retained prefix.
    if (keepNewCount > 0) {
      packXYInto(
        stagingBuffer,
        retainedPrev * 2,
        newPoints,
        newSrcOffset,
        keepNewCount,
        existing.xOffset,
      );
    }

    // Full GPU upload of the entire retained window (required after growth and
    // any layout transition — new buffer / linearized staging must match GPU).
    writeFullPointsToGpu(device, buffer, stagingBuffer, nextPointCount);

    const fullPacked = stagingBuffer.subarray(0, nextPointCount * 2);
    series.set(index, {
      buffer,
      capacityBytes,
      pointCount: nextPointCount,
      hash32: hashFloat32ArrayBits(fullPacked),
      xOffset: existing.xOffset,
      stagingBuffer,
      ringStart: 0,
      ringCapacityPoints: isRing && ringCapacity > 0 ? ringCapacity : 0,
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

  const getSeriesRingLayout = (index: number): SeriesRingLayout => {
    const entry = getSeriesEntry(index);
    // Modular indexing is only required once the write head has wrapped
    // (ringStart !== 0). Linear fill under maxPoints still uses capacity 0
    // so decimation can read raw[i] directly.
    if (entry.ringCapacityPoints > 0 && entry.ringStart !== 0) {
      return { start: entry.ringStart, capacity: entry.ringCapacityPoints };
    }
    return { start: 0, capacity: 0 };
  };

  const getSeriesContentHash = (index: number): number => {
    return getSeriesEntry(index).hash32;
  };

  const getSeriesStagingBuffer = (index: number): Float32Array => {
    return getSeriesEntry(index).stagingBuffer;
  };

  const getSeriesXOffset = (index: number): number => {
    return getSeriesEntry(index).xOffset;
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
    getSeriesRingLayout,
    getSeriesContentHash,
    getSeriesStagingBuffer,
    getSeriesXOffset,
    dispose,
  };
}
