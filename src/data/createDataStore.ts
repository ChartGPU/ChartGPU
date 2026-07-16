import type { CartesianSeriesData } from '../config/types';
import {
  destroyBufferAfterSubmit,
  flushDeviceSubmit,
} from '../core/gpu/submitBatcher';
import { getPointCount, packXYInto } from './cartesianData';
import { maxPointsPeakRetention, normalizeMaxPoints, planMaxPointsWindow } from './maxPointsWindow';
import { isYOnlyRewriteAgainstStaging, packYOnlyInto } from './seriesRewriteDetect';

/**
 * Compute: equal-N line y-only rewrite into interleaved vec2 storage (Track C Option B).
 * Uploads only N×4 dense y bytes via writeBuffer; GPU rewrites y lanes in place so
 * line/area/decimation keep a single interleaved layout (not dual-buffer line).
 */
const Y_REWRITE_WGSL = /* wgsl */ `
struct Params {
  count : u32,
  _p0 : u32,
  _p1 : u32,
  _p2 : u32,
};
@group(0) @binding(0) var<storage, read_write> points : array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> yIn : array<f32>;
@group(0) @binding(2) var<uniform> params : Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let p = points[i];
  points[i] = vec2<f32>(p.x, yIn[i]);
}
`;

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
    options?: Readonly<{
      xOffset?: number;
      /**
       * When true, skip the O(N) FNV content hash after packing (issue 2.6).
       * Coordinator already decided content changed (e.g. cache miss, y-only).
       * contentVersion for decimation still updates via a cheap stamp.
       */
      skipContentHash?: boolean;
    }>
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
  appendSeries(index: number, newPoints: CartesianSeriesData, options?: Readonly<{ maxPoints?: number }>): void;
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
   *
   * Note: during the pre-wrap fill phase `capacity` is still reported as `0`
   * so decimation can index linearly; use {@link isSeriesRingMode} to detect
   * whether the series is under maxPoints ring residency (including pre-wrap).
   */
  getSeriesRingLayout(index: number): SeriesRingLayout;
  /**
   * True when the series is under maxPoints modular-ring residency
   * (`ringCapacityPoints > 0`), including the pre-wrap fill phase where
   * {@link getSeriesRingLayout} still reports `capacity === 0`.
   *
   * Callers must not linearize via `setSeries` while this is true unless an
   * intentional full rebuild is desired (issue 0.2).
   */
  isSeriesRingMode(index: number): boolean;
  /**
   * Content version for GPU dirty-gating (WG-P0-2).
   *
   * - **`setSeries`**: FNV-1a of the packed Float32 payload (equal-content
   *   early-out when the full rewrite matches the previous hash).
   * - **`appendSeries`**: O(1) version stamp (not FNV of the new floats). Append
   *   always mutates residency; hashing 250k×5 floats/frame was pure tax.
   *
   * Changes whenever packed content is rewritten (including same-N appends).
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

/** Series device-local buffers: draw + decimation storage + upload + growth copy. */
const seriesBufferUsage = (): number =>
  GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

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

/**
 * Cap series buffer capacity for devices with tight storage-binding limits.
 *
 * Series buffers are bound as **read-only storage** (line + decimation). WebGPU
 * rejects bind groups when `buffer.size > maxStorageBufferBindingSize` (often
 * **128 MiB** on Chrome/Metal even when `maxBufferSize` is 256 MiB+).
 * FIFO 10M×5 was allocating ~256 MiB/series via setSeries headroom →
 * `Invalid BindGroup` / black chart on the last suite row.
 */
function clampSeriesCapacityBytes(
  desiredBytes: number,
  requiredBytes: number,
  maxBufferSize: number,
  maxStorageBufferBindingSize: number
): number {
  const required = Math.max(MIN_BUFFER_BYTES, roundUpToMultipleOf4(requiredBytes));
  const hardCap = Math.min(maxBufferSize, maxStorageBufferBindingSize);
  if (required > hardCap) {
    // Caller should have thrown already; keep required so createBuffer fails loudly.
    return required;
  }
  const desired = Math.max(MIN_BUFFER_BYTES, roundUpToMultipleOf4(desiredBytes));
  return Math.min(hardCap, Math.max(required, desired));
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

/**
 * O(1) content-version bump for append paths.
 *
 * Full FNV over packed floats is only needed on `setSeries` for equal-content
 * early-out. Append always mutates GPU residency; hashing every new float
 * (250k×5 at FIFO 10M) was a pure tax on the decimation dirty gate.
 */
function bumpContentVersion(hash: number, keepNewCount: number, dropPrevCount = 0): number {
  let h = (hash + 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (keepNewCount >>> 0), 0x01000193) >>> 0;
  if (dropPrevCount > 0) {
    h = (h + 0x85ebca6b) >>> 0;
  }
  // Ensure a change even when keepNewCount is 0 (drop-only edge).
  if (h === (hash >>> 0)) {
    h = (h + 1) >>> 0;
  }
  return h;
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
  count: number
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

function writeFullPointsToGpu(device: GPUDevice, buffer: GPUBuffer, staging: Float32Array, pointCount: number): void {
  if (pointCount <= 0) return;
  const view = staging.subarray(0, pointCount * 2);
  if (view.byteLength === 0) return;
  device.queue.writeBuffer(buffer, 0, view.buffer, view.byteOffset, view.byteLength);
}

/**
 * GPU-copy retained points from `src` into chronological order at the start of
 * `dst` (issue 1.1 option A). Linear layout is one copy; modular ring uses up
 * to two copies (tail then head). Self-submits so `src` can be destroyed after.
 */
function copyRetainedPointsToNewBuffer(
  device: GPUDevice,
  src: GPUBuffer,
  dst: GPUBuffer,
  ringStart: number,
  ringCap: number,
  pointCount: number
): void {
  if (pointCount <= 0) return;
  const bytesPerPoint = 8;
  const encoder = device.createCommandEncoder({
    label: 'DataStore/growCopy',
  });
  if (ringCap <= 0 || ringStart === 0) {
    const copyBytes = pointCount * bytesPerPoint;
    encoder.copyBufferToBuffer(src, 0, dst, 0, copyBytes);
  } else {
    // Modular physical → linear chronological on dst.
    const first = Math.min(pointCount, ringCap - ringStart);
    if (first > 0) {
      encoder.copyBufferToBuffer(src, ringStart * bytesPerPoint, dst, 0, first * bytesPerPoint);
    }
    const rest = pointCount - first;
    if (rest > 0) {
      encoder.copyBufferToBuffer(src, 0, dst, first * bytesPerPoint, rest * bytesPerPoint);
    }
  }
  device.queue.submit([encoder.finish()]);
}

export function createDataStore(device: GPUDevice): DataStore {
  const series = new Map<number, SeriesEntry>();
  let disposed = false;
  /**
   * Small pack scratch for O(append) GPU uploads. Avoids `queue.writeBuffer` sourcing
   * a subarray of the full-capacity staging ArrayBuffer (can be 80MB+ at 10M pts) —
   * browser drivers often pin/validate the parent buffer. Scratch stays ~append-sized.
   */
  let appendScratch: Float32Array = new Float32Array(0);

  /**
   * Destroy a series buffer without flushing multi-chart submit coalescing.
   * If command buffers are pending on this device, destroy is deferred until
   * after the next batched submit (see destroyBufferAfterSubmit).
   */
  const destroyBufferSafe = (buf: GPUBuffer): void => {
    destroyBufferAfterSubmit(device, buf);
  };

  const ensureAppendScratch = (pointCount: number): Float32Array => {
    const need = Math.max(0, pointCount | 0) * 2;
    if (appendScratch.length >= need) return appendScratch;
    const next = Math.max(need, appendScratch.length > 0 ? appendScratch.length * 2 : 64);
    // Power-of-two float count (even) for stable growth.
    let cap = 64;
    while (cap < next) cap *= 2;
    appendScratch = new Float32Array(cap);
    return appendScratch;
  };

  /**
   * Pack `pointCount` new points into a small append scratch, mirror into
   * modular/linear staging, and ranged-write GPU from the **scratch** buffer
   * (not a subarray of the full-capacity staging ArrayBuffer — browser drivers
   * often pin/validate the parent, which is 80MB+ at 10M pts).
   */
  const packAppendAndUpload = (
    stagingBuffer: Float32Array,
    gpuBuffer: GPUBuffer,
    physStart: number,
    ringCapacity: number,
    newPoints: CartesianSeriesData,
    srcPointOffset: number,
    pointCount: number,
    xOffset: number,
    linearDestPointOffset: number | null
  ): void => {
    if (pointCount <= 0) return;
    const scratch = ensureAppendScratch(pointCount);
    packXYInto(scratch, 0, newPoints, srcPointOffset, pointCount, xOffset);

    if (linearDestPointOffset != null) {
      const floats = pointCount * 2;
      stagingBuffer.set(scratch.subarray(0, floats), linearDestPointOffset * 2);
      const byteOffset = linearDestPointOffset * 2 * 4;
      const byteLength = floats * 4;
      if (byteLength > 0) {
        device.queue.writeBuffer(gpuBuffer, byteOffset, scratch.buffer, scratch.byteOffset, byteLength);
      }
      return;
    }

    // Modular ring: 1–2 GPU writes from scratch + staging mirror for leave-ring.
    const cap = ringCapacity;
    const first = Math.min(pointCount, cap - physStart);
    const floatsFirst = first * 2;
    if (first > 0) {
      stagingBuffer.set(scratch.subarray(0, floatsFirst), physStart * 2);
      device.queue.writeBuffer(
        gpuBuffer,
        physStart * 2 * 4,
        scratch.buffer,
        scratch.byteOffset,
        floatsFirst * 4
      );
    }
    const rest = pointCount - first;
    if (rest > 0) {
      const floatsRest = rest * 2;
      stagingBuffer.set(scratch.subarray(floatsFirst, floatsFirst + floatsRest), 0);
      device.queue.writeBuffer(
        gpuBuffer,
        0,
        scratch.buffer,
        scratch.byteOffset + floatsFirst * 4,
        floatsRest * 4
      );
    }
  };

  // Lazy equal-N y-only GPU rewrite (Track C Option B — compute y lanes).
  let yRewritePipeline: GPUComputePipeline | null = null;
  let yRewriteBindGroupLayout: GPUBindGroupLayout | null = null;
  let yChannelBuffer: GPUBuffer | null = null;
  let yChannelCapacityBytes = 0;
  let yChannelStaging = new Float32Array(0);
  let yParamsUniform: GPUBuffer | null = null;
  const yParamsScratch = new Uint32Array(4);
  /** Bind group cached by (seriesBuffer, yChannelBuffer) identity — avoid per-frame createBindGroup. */
  let yRewriteBindGroup: GPUBindGroup | null = null;
  let yRewriteBoundSeriesBuffer: GPUBuffer | null = null;
  let yRewriteBoundYChannel: GPUBuffer | null = null;

  const ensureYRewritePipeline = (): void => {
    if (yRewritePipeline) return;
    const module = device.createShaderModule({
      label: 'DataStore/yRewrite.wgsl',
      code: Y_REWRITE_WGSL,
    });
    yRewriteBindGroupLayout = device.createBindGroupLayout({
      label: 'DataStore/yRewriteBGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const layout = device.createPipelineLayout({
      label: 'DataStore/yRewritePL',
      bindGroupLayouts: [yRewriteBindGroupLayout],
    });
    yRewritePipeline = device.createComputePipeline({
      label: 'DataStore/yRewritePipeline',
      layout,
      compute: { module, entryPoint: 'main' },
    });
    yParamsUniform = device.createBuffer({
      label: 'DataStore/yRewriteParams',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  };

  const ensureYChannelCapacity = (pointCount: number): void => {
    const bytes = Math.max(4, roundUpToMultipleOf4(pointCount * 4));
    if (!yChannelBuffer || yChannelCapacityBytes < bytes) {
      if (yChannelBuffer) {
        try {
          yChannelBuffer.destroy();
        } catch {
          // best-effort
        }
      }
      const grown = Math.max(bytes, nextPow2(bytes));
      yChannelBuffer = device.createBuffer({
        label: 'DataStore/yChannelUpload',
        size: grown,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      yChannelCapacityBytes = grown;
      yChannelStaging = new Float32Array(grown / 4);
    } else if (yChannelStaging.length < pointCount) {
      yChannelStaging = new Float32Array(yChannelCapacityBytes / 4);
    }
  };

  /**
   * Upload dense y (N×4) and rewrite y lanes of the interleaved series buffer on GPU.
   * CPU staging must already hold the correct interleaved floats (packYOnlyInto).
   */
  const gpuYOnlyRewrite = (seriesBuffer: GPUBuffer, staging: Float32Array, pointCount: number): void => {
    if (pointCount <= 0) return;
    ensureYRewritePipeline();
    ensureYChannelCapacity(pointCount);
    // Dense y extract from interleaved staging.
    for (let i = 0; i < pointCount; i++) {
      yChannelStaging[i] = staging[i * 2 + 1]!;
    }
    const yBytes = pointCount * 4;
    device.queue.writeBuffer(yChannelBuffer!, 0, yChannelStaging.buffer, yChannelStaging.byteOffset, yBytes);
    yParamsScratch[0] = pointCount >>> 0;
    yParamsScratch[1] = 0;
    yParamsScratch[2] = 0;
    yParamsScratch[3] = 0;
    device.queue.writeBuffer(yParamsUniform!, 0, yParamsScratch.buffer, yParamsScratch.byteOffset, 16);

    // Rebuild bind group only when series or y-channel buffer identity changes.
    // (ensureYChannelCapacity may reallocate yChannelBuffer; bound identity covers that.)
    if (
      yRewriteBindGroup == null ||
      yRewriteBoundSeriesBuffer !== seriesBuffer ||
      yRewriteBoundYChannel !== yChannelBuffer
    ) {
      yRewriteBindGroup = device.createBindGroup({
        layout: yRewriteBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: seriesBuffer } },
          { binding: 1, resource: { buffer: yChannelBuffer! } },
          { binding: 2, resource: { buffer: yParamsUniform! } },
        ],
      });
      yRewriteBoundSeriesBuffer = seriesBuffer;
      yRewriteBoundYChannel = yChannelBuffer;
    }
    // Per-setSeries submit is intentional: y-lane rewrite must complete on the queue
    // before the frame encoder's decimation/main-pass reads the interleaved buffer.
    // WebGPU orders submits; multi-series frames pay one submit each (FIFO append stays
    // on the thin path via ring/length gates). Batching onto the frame encoder would
    // collapse submits but needs pending-work plumbing across DataStore → coordinator.
    const encoder = device.createCommandEncoder({ label: 'DataStore/yRewrite' });
    const pass = encoder.beginComputePass({ label: 'DataStore/yRewritePass' });
    pass.setPipeline(yRewritePipeline!);
    pass.setBindGroup(0, yRewriteBindGroup);
    pass.dispatchWorkgroups(Math.ceil(pointCount / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

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

  const setSeries = (
    index: number,
    data: CartesianSeriesData,
    options?: Readonly<{ xOffset?: number; skipContentHash?: boolean }>
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
      const maxStorageBinding = device.limits.maxStorageBufferBindingSize;
      const hardCap = Math.min(maxBufferSize, maxStorageBinding);
      if (targetBytes > hardCap) {
        throw new Error(
          `DataStore.setSeries(${index}): required buffer size ${targetBytes} exceeds ` +
            `min(maxBufferSize=${maxBufferSize}, maxStorageBufferBindingSize=${maxStorageBinding}). ` +
            `Series buffers are storage-bound for line/decimation.`
        );
      }

      if (buffer) {
        destroyBufferSafe(buffer);
      }

      const grownCapacityBytes = computeGrownCapacityBytes(capacityBytes, targetBytes);
      // SciChart-parity streaming headroom: series compression / multi-chart line
      // slots seed ~100k then append 10k/frame unbounded. Pre-reserve headroom for
      // mid-size seeds, but **do not** 4× multi-M seeds (5M×5 FIFO was reserving
      // ~256MB/series → multi-GB + Invalid BindGroup under memory pressure).
      // High-rate pure growth headroom remains on appendSeries (2× / 2M cap).
      // Always clamp to maxStorageBufferBindingSize (10M seed 2× → 256MB would
      // fail bind-group validation on 128 MiB devices).
      let desired = grownCapacityBytes;
      if (pointCount >= 10_000) {
        const mult = pointCount >= 1_000_000 ? 2 : 4;
        const minReservePts = pointCount >= 1_000_000 ? pointCount : 1_000_000;
        const headroom = nextPow2(Math.max(targetBytes * mult, minReservePts * 2 * 4));
        desired = Math.max(desired, headroom);
      }
      capacityBytes = clampSeriesCapacityBytes(desired, targetBytes, maxBufferSize, maxStorageBinding);

      buffer = device.createBuffer({
        size: capacityBytes,
        usage: seriesBufferUsage(),
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
    // staging (CPU) + GPU y-lane compute (Track C). Must NOT fire for Brownian
    // xy where x also changes. Linear layout only (no modular ring).
    const yOnly =
      existing != null &&
      existing.pointCount === pointCount &&
      existing.xOffset === xOffset &&
      existing.ringStart === 0 &&
      existing.ringCapacityPoints === 0 &&
      existing.buffer === buffer &&
      isYOnlyRewriteAgainstStaging(data, existing.stagingBuffer, existing.pointCount, existing.xOffset);

    let yOnlyChanged = false;
    if (yOnly) {
      yOnlyChanged = packYOnlyInto(stagingBuffer, data, pointCount);
      if (!yOnlyChanged) {
        // x matched and every y is identical — no GPU work.
        return;
      }
    } else if (pointCount > 0) {
      packXYInto(stagingBuffer, 0, data, 0, pointCount, xOffset);
    }

    const packedView = pointCount > 0 ? stagingBuffer.subarray(0, pointCount * 2) : new Float32Array(0);

    // Issue 2.1 / Track C: y-only already proved y changed — skip full O(N) FNV.
    // Stamp hash so decimation still dirties. Issue 2.6: skipContentHash same.
    const skipHash = yOnlyChanged || options?.skipContentHash === true;
    let hash32: number;
    if (skipHash && existing) {
      hash32 = (existing.hash32 + 0x9e3779b9) >>> 0;
    } else {
      hash32 = hashFloat32ArrayBits(packedView);
    }

    const unchanged =
      !skipHash &&
      existing &&
      existing.pointCount === pointCount &&
      existing.hash32 === hash32 &&
      existing.ringStart === 0 &&
      existing.buffer === buffer;
    if (unchanged) {
      // Staging may already match GPU; keep entry identity.
      return;
    }

    if (yOnlyChanged && pointCount > 0) {
      // Track C Option B: write N×4 y + compute merge into interleaved GPU buffer.
      gpuYOnlyRewrite(buffer, stagingBuffer, pointCount);
    } else if (packedView.byteLength > 0) {
      // Full interleaved GPU upload (xy rewrite, cold, growth, length change).
      device.queue.writeBuffer(buffer, 0, packedView.buffer, packedView.byteOffset, packedView.byteLength);
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
    options?: Readonly<{ maxPoints?: number }>
  ): void => {
    assertNotDisposed();
    const newPointCount = getPointCount(newPoints);
    if (newPointCount === 0) return;

    const existing = getSeriesEntry(index);
    const prevPointCount = existing.pointCount;
    const maxPoints = normalizeMaxPoints(options?.maxPoints);
    const plan = planMaxPointsWindow(prevPointCount, newPointCount, maxPoints);
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
      isRing && ringCapacity > 0 ? Math.max(nextPointCount, maxPointsPeakRetention(ringCapacity)) : nextPointCount;
    const requiredBytes = roundUpToMultipleOf4(reservePoints * 2 * 4);
    const targetBytes = Math.max(MIN_BUFFER_BYTES, requiredBytes);

    let buffer = existing.buffer;
    let capacityBytes = existing.capacityBytes;
    let stagingBuffer = existing.stagingBuffer;
    let ringStart = existing.ringStart;
    const maxBufferSize = device.limits.maxBufferSize;
    const maxStorageBinding = device.limits.maxStorageBufferBindingSize;
    const prevRingCap = existing.ringCapacityPoints;
    const prevRingStart = existing.ringStart;
    const wasRing = prevRingCap > 0;

    const needsGrowth = targetBytes > capacityBytes;

    // Modular ring O(append) path when:
    // - maxPoints active, no growth, not strict replace
    // - first activation with prev already ≤ capacity (linear base, ringStart=0), OR
    // - already ring-tagged at the same capacity with prev ≤ capacity
    // Oversized→ring (prev > capacity) and capacity changes use rebuild below.
    const firstRingActivation = isRing && !wasRing && ringCapacity > 0 && prevPointCount <= ringCapacity;
    const continuingRing =
      isRing && wasRing && prevRingCap === ringCapacity && ringCapacity > 0 && prevPointCount <= prevRingCap;
    const steadyRing = (firstRingActivation || continuingRing) && !needsGrowth && !isStrictReplace;

    // Pure linear ranged append: never been a ring, no windowing, no growth.
    const pureLinearRanged = !isRing && !wasRing && !needsGrowth && !isStrictReplace && dropPrevCount === 0;

    // ── Growth: allocate new GPU buffer + linearize staging on CPU (1.1 A). ──
    // Pure unbounded append: GPU-copy retained prefix + ranged-write new only.
    // Non-pure paths (drop / strict / ring rebuild) still full-upload the planned
    // window after packing — GPU prefix copy is skipped there to avoid a wasted
    // copy that would be overwritten by writeFullPointsToGpu.
    if (needsGrowth) {
      const hardCap = Math.min(maxBufferSize, maxStorageBinding);
      if (targetBytes > hardCap) {
        throw new Error(
          `DataStore.appendSeries(${index}): required buffer size ${targetBytes} exceeds ` +
            `min(maxBufferSize=${maxBufferSize}, maxStorageBufferBindingSize=${maxStorageBinding}).`
        );
      }
      const oldBuffer = existing.buffer;
      const oldStaging = existing.stagingBuffer;
      const oldStart = existing.ringStart;
      const oldCap = existing.ringCapacityPoints;
      const oldCount = existing.pointCount;

      let grownCapacityBytes = computeGrownCapacityBytes(capacityBytes, targetBytes);
      // Unbounded high-rate append (series compression): grow ~2× required so
      // display-refresh windows avoid a tight 1M→1.01M→… ladder, without a hard
      // multi-M floor that multi-chart slots would multiply into multi-GB.
      // Cap stream headroom at 2M points so N concurrent line slots stay safe.
      if (!isRing && nextPointCount >= 100_000) {
        const MAX_STREAM_HEADROOM_POINTS = 2_000_000;
        const preferred = nextPow2(targetBytes * 2);
        const capped = Math.min(preferred, MAX_STREAM_HEADROOM_POINTS * 2 * 4);
        grownCapacityBytes = Math.max(grownCapacityBytes, Math.max(targetBytes, capped));
      }
      capacityBytes = clampSeriesCapacityBytes(
        grownCapacityBytes,
        targetBytes,
        maxBufferSize,
        maxStorageBinding
      );
      buffer = device.createBuffer({
        size: capacityBytes,
        usage: seriesBufferUsage(),
      });
      stagingBuffer = new Float32Array(capacityBytes / 4);

      // Linearize previous points into chronological order at offset 0 (CPU mirror).
      linearizeStagingChronological(stagingBuffer, oldStaging, oldStart, oldCap, oldCount);

      // Pure unbounded growth append (no windowing): GPU-copy retained prefix,
      // then pack + ranged-write only the new points.
      const pureGrowthAppend = !isRing && !isStrictReplace && dropPrevCount === 0 && keepNewCount === newPointCount;

      if (pureGrowthAppend && oldCount > 0) {
        copyRetainedPointsToNewBuffer(device, oldBuffer, buffer, oldStart, oldCap, oldCount);
      }
      destroyBufferSafe(oldBuffer);
      ringStart = 0;

      if (pureGrowthAppend) {
        packAppendAndUpload(
          stagingBuffer,
          buffer,
          0,
          0,
          newPoints,
          0,
          newPointCount,
          existing.xOffset,
          oldCount
        );
        series.set(index, {
          buffer,
          capacityBytes,
          pointCount: nextPointCount,
          hash32: bumpContentVersion(existing.hash32, newPointCount, 0),
          xOffset: existing.xOffset,
          stagingBuffer,
          ringStart: 0,
          ringCapacityPoints: 0,
        });
        return;
      }
      // Otherwise fall through: drop/strict/ring rebuild packs the planned
      // window on CPU and full-uploads (no GPU prefix copy — that would be
      // overwritten by writeFullPointsToGpu on those paths).
    }

    // ── Strict replace: linear pack of the new batch tail at index 0 ──
    if (isStrictReplace) {
      packXYInto(stagingBuffer, 0, newPoints, newSrcOffset, keepNewCount, existing.xOffset);
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

      const writeHead = prevPointCount >= cap ? ringStart : (ringStart + prevPointCount) % cap;

      packAppendAndUpload(
        stagingBuffer,
        buffer,
        writeHead,
        cap,
        newPoints,
        newSrcOffset,
        keepNewCount,
        existing.xOffset,
        null
      );

      const nextRingStart = dropPrevCount > 0 ? (ringStart + dropPrevCount) % cap : ringStart;

      series.set(index, {
        buffer,
        capacityBytes,
        pointCount: nextPointCount,
        hash32: bumpContentVersion(existing.hash32, keepNewCount, dropPrevCount),
        xOffset: existing.xOffset,
        stagingBuffer,
        ringStart: nextRingStart,
        ringCapacityPoints: cap,
      });
      return;
    }

    // ── Pure linear ranged append (no maxPoints, no growth) ──
    if (pureLinearRanged) {
      packAppendAndUpload(
        stagingBuffer,
        buffer,
        0,
        0,
        newPoints,
        0,
        newPointCount,
        existing.xOffset,
        prevPointCount
      );

      series.set(index, {
        buffer,
        capacityBytes,
        pointCount: nextPointCount,
        hash32: bumpContentVersion(existing.hash32, newPointCount, 0),
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
        linearizeStagingChronological(stagingBuffer, stagingBuffer, prevRingStart, prevRingCap, prevPointCount);
      }
    }
    // After growth we already linearized; ringStart is 0.

    // Apply drop of oldest previous points in chronological space.
    if (dropPrevCount > 0 && dropPrevCount < prevPointCount) {
      stagingBuffer.copyWithin(0, dropPrevCount * 2, prevPointCount * 2);
    }
    const retainedPrev = dropPrevCount >= prevPointCount ? 0 : prevPointCount - dropPrevCount;

    // Pack kept new points after the retained prefix.
    if (keepNewCount > 0) {
      packXYInto(stagingBuffer, retainedPrev * 2, newPoints, newSrcOffset, keepNewCount, existing.xOffset);
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

  const isSeriesRingMode = (index: number): boolean => {
    return getSeriesEntry(index).ringCapacityPoints > 0;
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

    try {
      flushDeviceSubmit(device);
    } catch {
      // best-effort
    }
    for (const entry of series.values()) {
      try {
        entry.buffer.destroy();
      } catch {
        // Ignore destroy errors; disposal should be best-effort.
      }
    }
    series.clear();

    if (yChannelBuffer) {
      try {
        yChannelBuffer.destroy();
      } catch {
        // best-effort
      }
      yChannelBuffer = null;
    }
    if (yParamsUniform) {
      try {
        yParamsUniform.destroy();
      } catch {
        // best-effort
      }
      yParamsUniform = null;
    }
    yRewritePipeline = null;
    yRewriteBindGroupLayout = null;
    yRewriteBindGroup = null;
    yRewriteBoundSeriesBuffer = null;
    yRewriteBoundYChannel = null;
    yChannelCapacityBytes = 0;
    yChannelStaging = new Float32Array(0);
  };

  return {
    setSeries,
    appendSeries,
    removeSeries,
    getSeriesBuffer,
    getSeriesPointCount,
    getSeriesRingLayout,
    isSeriesRingMode,
    getSeriesContentHash,
    getSeriesStagingBuffer,
    getSeriesXOffset,
    dispose,
  };
}
