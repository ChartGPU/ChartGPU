/**
 * GPU compute-shader decimation for line-series data.
 *
 * Replaces CPU-side LTTB / min / max sampling with a compute pipeline that reads
 * raw series points from a storage buffer (owned by `DataStore`) and writes the
 * decimated point set into its own output storage buffer. The renderer consumes
 * the output buffer directly — no readback to CPU, no repacking per frame.
 *
 * Wired identically to scatter-density: the caller invokes {@link prepare} to
 * update uniforms and dirty-gate, then {@link encodeCompute} from the render
 * loop just before `beginRenderPass()` (see `encodeScatterDensityCompute` in
 * `renderCoordinator/render/renderSeries.ts` for the sibling pattern).
 *
 * Supported `sampling` modes (match the existing CPU API 1:1):
 *   - `'min'` / `'max'` — per-bucket argmin/argmax on y. One kernel dispatch.
 *   - `'lttb'` / `'auto'` — two-phase parallel LTTB (per-bucket averages, then
 *     triangle-area maximization against the neighboring bucket averages).
 *
 * **Dense-bucket candidate cap (WGSL):** when a bucket's raw range exceeds 512
 * points, LTTB / min / max evaluate a uniform **128**-sample candidate set
 * (including endpoints) instead of every raw point; the averages pre-pass uses
 * **64** samples for coarse triangle anchors. Below 512 pts/bucket the scan is
 * exact (covers 1M × 2500 ≈ 400). At extreme N (5M–10M / 2500 buckets) min/max
 * are approximate extrema, not guaranteed true bucket min/max. Cap is a G4
 * residual — still period=1 honest recompute for this frame's `SIG` (G0–G2).
 *
 * **Tile hierarchy (Phase B multi‑M FIFO):** physical tiles of size 1024 store
 * min/max/sum aggregates. Maintain is O(touched tiles) on append/wrap; present
 * reads hierarchy when policy enables it (modular multi‑K or pts/bucket > 512).
 * Hierarchy never skips present encode when `SIG ≠ lastEncodedSIG`.
 *
 * All entry points live in `src/shaders/decimation.wgsl` (+ maintain in
 * `decimationHierarchy.wgsl`).
 *
 * ---
 *
 * ## Golden encode-signature / temporal present fidelity (G0–G2)
 *
 * **G0 — Present-time encode-signature fidelity:** never present decimation
 * output whose last successful encode `SIG` differs from this frame’s prepare
 * inputs. `SIG` fields: algorithm, rawBuffer, rawPointCount, visibleStart,
 * visibleEnd, targetBuckets, contentVersion, ringStart, ringCapacity.
 *
 * **G1 — Lifecycle:** three concepts stay distinct:
 * - **Current prepare `SIG`** — this frame’s inputs (every `prepare`).
 * - **`lastEncodedSIG`** — updated **only after successful `encodeCompute`**
 *   that wrote output for that `SIG`. Never on prepare entry.
 * - **Present** — draw binds output only when current `SIG == lastEncodedSIG`
 *   (coordinator: prepare → encode if needsEncode → draw same frame).
 *
 * **G2 — No multi-frame streaming amortization:** whenever prepare `SIG`
 * differs from `lastEncodedSIG`, encode this frame (period effectively 1 for
 * all pure streaming: modular FIFO **and** linear growth). Density period
 * tables, skip streaks, and intentional present lag are **forbidden**
 * (period-flash class). Equal-N version bumps and `resourcesChanged` still
 * force encode.
 *
 * **Illegal forever:**
 * 1. `SIG != lastEncodedSIG` and draw binds decimation output.
 * 2. Update lastEncoded / clear dirty without encode (permanent stale).
 * 3. Dirty/encode without rewriting uniforms for the new `SIG`.
 * 4. Skip present because hierarchy is warm while SIG changed.
 */

import decimationWgsl from '../shaders/decimation.wgsl?raw';
import decimationHierarchyWgsl from '../shaders/decimationHierarchy.wgsl?raw';
import type { PipelineCache } from '../core/PipelineCache';
import { createComputePipeline, createShaderModule, createUniformBuffer, writeUniformBuffer } from './rendererUtils';
import {
  HIERARCHY_TILE,
  HIERARCHY_TILE_BYTES,
  modularOverwriteRanges,
  shouldUseHierarchyPresent,
  tileCountForCapacity,
  tilesOverlappingPhysical,
} from './decimationHierarchy';

/**
 * Algorithm selected by the caller. Mirrors the CPU `SeriesSampling` values
 * that this module can accelerate. The coordinator is responsible for mapping
 * `'auto'` to `'lttb'` before calling in (we do not re-encode that decision
 * here so the module stays policy-free).
 */
export type DecimationAlgorithm = 'lttb' | 'min' | 'max';

export interface DecimationComputePrepareParams {
  readonly algorithm: DecimationAlgorithm;
  /**
   * Raw (unsampled) series data on the GPU. Must be a storage buffer of
   * interleaved `vec2<f32>` points, identical to the buffer `DataStore`
   * maintains for line/area renderers.
   */
  readonly rawBuffer: GPUBuffer;
  /**
   * Total number of raw points in {@link rawBuffer}. The compute shader only
   * indexes `[0, rawPointCount)` regardless of the buffer's byte capacity.
   */
  readonly rawPointCount: number;
  /**
   * Inclusive-start, exclusive-end raw-index window to decimate. The caller
   * normally derives this from a binary search over the raw x-column keyed on
   * the visible x-domain (identical to what `findVisibleRangeIndicesByX` does
   * for scatter-density).
   */
  readonly visibleStart: number;
  readonly visibleEnd: number;
  /**
   * Desired output point count. Typically `plotWidthPx * samplingDensity` in
   * the same spirit as the CPU `samplingThreshold` logic.
   */
  readonly targetBuckets: number;
  /**
   * Monotonic or content-derived version of the packed raw payload (WG-P0-2).
   * DataStore's FNV-1a `hash32` is the usual source. Same buffer identity +
   * same point count + rewritten floats must change this so compute re-runs.
   * Omit (or keep stable) when content is known unchanged so pure pan/window
   * skips still work via the other signature fields.
   */
  readonly contentVersion?: number;
  /**
   * Fixed-capacity ring FIFO layout for `rawBuffer`. When `ringCapacity` is
   * 0/omitted, storage is linear chronological. When set, logical index `i`
   * maps to physical `(ringStart + i) % ringCapacity` in WGSL.
   */
  readonly ringStart?: number;
  readonly ringCapacity?: number;
}

/** @internal Harness / unit diagnostics for hierarchy maintain + present path. */
export interface DecimationHierarchyDebug {
  readonly hierarchyReady: boolean;
  readonly lastPresentHierarchy: boolean;
  readonly lastMaintainTileCount: number;
  readonly preparedRawPointCount: number;
  readonly preparedRingCapacity: number;
}

export interface DecimationCompute {
  /**
   * Updates uniforms + dirty-gating for the next call to {@link encodeCompute}.
   *
   * Safe to call on every frame; compute work is only dispatched when the
   * input signature actually changes.
   *
   * @returns Presentable point count for this frame: the bucket count when the
   * output will (or already does) represent this prepare's `SIG`, or **0** when
   * the visible span is empty / not current so the coordinator must not draw a
   * prior encode as current (G0).
   */
  prepare(params: DecimationComputePrepareParams): number;

  /**
   * True when the next {@link encodeCompute} will dispatch work — present SIG
   * dirty **or** hierarchy maintain still pending (cold chunk / range dirty).
   * Used by the coordinator to open a shared compute pass only when needed.
   */
  needsEncode(): boolean;

  /**
   * Encodes the compute pass(es) onto {@link encoder}. No-op if no eligible
   * `prepare()` has been called and hierarchy does not need maintain.
   *
   * When `intoPass` is provided, dispatches into that shared pass (caller owns
   * begin/end). Used by the coordinator to batch all series decimation into one
   * compute pass instead of 5× beginComputePass per frame.
   *
   * Order: (1) hierarchy maintain if dirty, (2) present select into output when
   * present SIG is dirty, (3) set lastEncodedSIG only after present write.
   * Maintain-only encodes (cold chunk while present SIG clean) do **not**
   * advance lastEncodedSIG.
   */
  encodeCompute(encoder: GPUCommandEncoder, intoPass?: GPUComputePassEncoder): void;

  /**
   * GPU storage buffer holding the decimated `vec2<f32>` points. Stable across
   * frames except when the target bucket count grows past capacity (geometric
   * growth). Renderers should cache their bind group by buffer identity.
   */
  getOutputBuffer(): GPUBuffer;

  /**
   * Number of points actually written to {@link getOutputBuffer} by the most
   * recent {@link prepare} call. Returns `0` until the first prepare.
   */
  getOutputPointCount(): number;

  /**
   * @internal Hierarchy path diagnostics for unit tests / harness — not a public API.
   */
  getHierarchyDebug(): DecimationHierarchyDebug;

  dispose(): void;
}

export interface DecimationComputeOptions {
  readonly pipelineCache?: PipelineCache;
}

const MIN_OUTPUT_CAPACITY = 64;
const MIN_HIERARCHY_TILE_CAPACITY = 8;

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

// Uniforms struct in decimation.wgsl: 12 × u32 = 48 bytes (multiple of 16).
const DECIMATION_UNIFORM_BYTES = 48;
// Hierarchy maintain uniforms: 8 × u32 = 32 bytes.
const HIERARCHY_MAINTAIN_UNIFORM_BYTES = 32;

// Mode bits consumed by `minMaxDecimate` (bit 0: 0 = min, 1 = max).
const MODE_MIN = 0;
const MODE_MAX = 1;

export function createDecimationCompute(device: GPUDevice, options?: DecimationComputeOptions): DecimationCompute {
  let disposed = false;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'decimationCompute/bindGroupLayout',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'read-only-storage' },
      },
    ],
  });

  const maintainBindGroupLayout = device.createBindGroupLayout({
    label: 'decimationCompute/maintainBindGroupLayout',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
    ],
  });

  const module = createShaderModule(device, decimationWgsl, 'decimation.wgsl', pipelineCache);
  const hierarchyModule = createShaderModule(
    device,
    decimationHierarchyWgsl,
    'decimationHierarchy.wgsl',
    pipelineCache
  );

  // Best-effort: surface WGSL compile errors with line-level precision.
  const logCompilation = (mod: GPUShaderModule, label: string): void => {
    const getCompilationInfo = mod.getCompilationInfo?.bind(mod);
    if (!getCompilationInfo) return;
    getCompilationInfo()
      .then((info) => {
        for (const msg of info.messages) {
          if (msg.type === 'error') {
            // eslint-disable-next-line no-console
            console.error(`[${label}:${msg.lineNum ?? 0}:${msg.linePos ?? 0}] ${msg.message}`);
          } else if (msg.type === 'warning') {
            // eslint-disable-next-line no-console
            console.warn(`[${label}:${msg.lineNum ?? 0}:${msg.linePos ?? 0}] ${msg.message}`);
          }
        }
      })
      .catch(() => {
        // Ignore — best effort only.
      });
  };
  logCompilation(module, 'decimation.wgsl');
  logCompilation(hierarchyModule, 'decimationHierarchy.wgsl');

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });
  const maintainPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [maintainBindGroupLayout],
  });

  const minMaxPipeline = createComputePipeline(
    device,
    {
      label: 'decimationCompute/minMaxPipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'minMaxDecimate' },
    },
    pipelineCache
  );
  const averagesPipeline = createComputePipeline(
    device,
    {
      label: 'decimationCompute/averagesPipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'computeBucketAverages' },
    },
    pipelineCache
  );
  const lttbPipeline = createComputePipeline(
    device,
    {
      label: 'decimationCompute/lttbPipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'parallelLttbDecimate' },
    },
    pipelineCache
  );
  const hierarchyMinMaxPipeline = createComputePipeline(
    device,
    {
      label: 'decimationCompute/hierarchyMinMaxPipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'hierarchyMinMaxDecimate' },
    },
    pipelineCache
  );
  const hierarchyAveragesPipeline = createComputePipeline(
    device,
    {
      label: 'decimationCompute/hierarchyAveragesPipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'hierarchyBucketAverages' },
    },
    pipelineCache
  );
  const hierarchyLttbPipeline = createComputePipeline(
    device,
    {
      label: 'decimationCompute/hierarchyLttbPipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'hierarchyParallelLttb' },
    },
    pipelineCache
  );
  const maintainPipeline = createComputePipeline(
    device,
    {
      label: 'decimationCompute/maintainPipeline',
      layout: maintainPipelineLayout,
      compute: { module: hierarchyModule, entryPoint: 'maintainTiles' },
    },
    pipelineCache
  );

  const uniformBuffer = createUniformBuffer(device, DECIMATION_UNIFORM_BYTES, {
    label: 'decimationCompute/uniforms',
  });
  const uniformScratch = new ArrayBuffer(DECIMATION_UNIFORM_BYTES);
  const uniformScratchU32 = new Uint32Array(uniformScratch);

  // Dual maintain uniforms so seam wraps (two phys ranges) can dispatch in one
  // pass without queue.writeBuffer clobber (same hazard as grid FS colors).
  const maintainUniformBuffer0 = createUniformBuffer(device, HIERARCHY_MAINTAIN_UNIFORM_BYTES, {
    label: 'decimationCompute/maintainUniforms0',
  });
  const maintainUniformBuffer1 = createUniformBuffer(device, HIERARCHY_MAINTAIN_UNIFORM_BYTES, {
    label: 'decimationCompute/maintainUniforms1',
  });
  const maintainUniformScratch = new ArrayBuffer(HIERARCHY_MAINTAIN_UNIFORM_BYTES);
  const maintainUniformU32 = new Uint32Array(maintainUniformScratch);

  // Output + averages buffers. Grown geometrically (power-of-two).
  let outputBuffer: GPUBuffer | null = null;
  let averagesBuffer: GPUBuffer | null = null;
  let bufferCapacityPoints = 0; // counts `vec2<f32>` elements, not bytes
  let bindGroup: GPUBindGroup | null = null;
  let boundRawBuffer: GPUBuffer | null = null;

  // Hierarchy tile storage (physical tiles).
  let tilesBuffer: GPUBuffer | null = null;
  let tilesCapacity = 0; // number of Tile slots
  let maintainBindGroup0: GPUBindGroup | null = null;
  let maintainBindGroup1: GPUBindGroup | null = null;
  let maintainBoundRaw: GPUBuffer | null = null;

  // Prepared state: uniforms + dispatch params for the next encode (G1 current SIG).
  let hasPrepared = false;
  let dirty = false;
  let preparedAlgorithm: DecimationAlgorithm | null = null;
  let preparedRawBuffer: GPUBuffer | null = null;
  let preparedRawPointCount = -1;
  let preparedVisibleStart = -1;
  let preparedVisibleEnd = -1;
  let preparedTargetBuckets = -1;
  /** `undefined` means "not yet prepared with a version". */
  let preparedContentVersion: number | undefined = undefined;
  let preparedRingStart = 0;
  let preparedRingCapacity = 0;
  let preparedUseHierarchy = false;
  let lastOutputPointCount = 0;

  /**
   * `lastEncodedSIG` — what the GPU output buffer actually represents.
   * Updated **only** after a successful `encodeCompute` dispatch (G1).
   */
  let hasEncoded = false;
  let lastEncodedAlgorithm: DecimationAlgorithm | null = null;
  let lastEncodedRawBuffer: GPUBuffer | null = null;
  let lastEncodedRawPointCount = -1;
  let lastEncodedVisibleStart = -1;
  let lastEncodedVisibleEnd = -1;
  let lastEncodedTargetBuckets = -1;
  let lastEncodedContentVersion: number | undefined = undefined;
  let lastEncodedRingStart = 0;
  let lastEncodedRingCapacity = 0;

  /** Set when output/raw bind-group resources change; forces a compute re-dispatch. */
  let bindGroupResourcesChanged = false;

  // Hierarchy maintain stamp + dirty tile ranges (physical tile indices).
  // Full cold rebuild uses coldProgressTile..nTiles (chunked). Incremental uses
  // up to two non-merged tile ranges (modular wrap seam).
  let hierarchyReady = false;
  let hierarchyDirtyFull = true;
  /** Next tile index for an in-progress full cold rebuild (always advances). */
  let coldProgressTile = 0;
  /** Incremental dirty tile ranges (max 2). Ignored when hierarchyDirtyFull. */
  let dirtyTileRanges: Array<{ start: number; endExclusive: number }> = [];
  let lastMaintainedRawBuffer: GPUBuffer | null = null;
  let lastMaintainedRawPointCount = -1;
  let lastMaintainedRingStart = 0;
  let lastMaintainedRingCapacity = 0;
  let lastMaintainedContentVersion: number | undefined = undefined;

  /** Last successful encode diagnostics (for harness / unit checks). */
  let lastEncodeUsedHierarchyPresent = false;
  let lastEncodeMaintainTileCount = 0;

  /** Cap cold full-rebuild tiles per encode (setup budget). Incremental is uncapped. */
  const MAX_COLD_MAINTAIN_TILES_PER_ENCODE = 2048;

  const physicalCapacityOf = (rawCount: number, ringCap: number): number => {
    if (ringCap > 0) return ringCap;
    return Math.max(0, rawCount);
  };

  const markFullDirty = (nTiles: number): void => {
    hierarchyDirtyFull = true;
    coldProgressTile = 0;
    dirtyTileRanges = [];
    hierarchyReady = false;
    if (nTiles <= 0) {
      coldProgressTile = 0;
    }
  };

  const addIncrementalTileRange = (startTile: number, endTileExclusive: number, nTiles: number): void => {
    const lo = Math.max(0, Math.min(nTiles, startTile));
    const hi = Math.max(lo, Math.min(nTiles, endTileExclusive));
    if (hi <= lo) return;
    if (hierarchyDirtyFull) {
      // Overwrite during cold rebuild: re-maintain from the earliest dirty tile.
      if (lo < coldProgressTile) coldProgressTile = lo;
      return;
    }
    // Merge into existing ranges (coalesce overlapping / adjacent).
    const next: Array<{ start: number; endExclusive: number }> = [];
    let a = lo;
    let b = hi;
    for (const r of dirtyTileRanges) {
      if (b < r.start || a > r.endExclusive) {
        next.push(r);
        continue;
      }
      a = Math.min(a, r.start);
      b = Math.max(b, r.endExclusive);
    }
    next.push({ start: a, endExclusive: b });
    next.sort((x, y) => x.start - y.start);
    // Coalesce sorted
    const merged: Array<{ start: number; endExclusive: number }> = [];
    for (const r of next) {
      const last = merged[merged.length - 1];
      if (!last || r.start > last.endExclusive) {
        merged.push({ ...r });
      } else {
        last.endExclusive = Math.max(last.endExclusive, r.endExclusive);
      }
    }
    if (merged.length <= 2) {
      dirtyTileRanges = merged;
    } else {
      // More than two disjoint ranges → full rebuild (rare).
      markFullDirty(nTiles);
    }
  };

  const remainingMaintainTiles = (nTiles: number): number => {
    if (nTiles <= 0) return 0;
    if (hierarchyDirtyFull) {
      return Math.max(0, nTiles - coldProgressTile);
    }
    let total = 0;
    for (const r of dirtyTileRanges) {
      total += Math.max(0, r.endExclusive - r.start);
    }
    return total;
  };

  const ensureBuffers = (capacityPoints: number): void => {
    const required = Math.max(MIN_OUTPUT_CAPACITY, capacityPoints);
    if (outputBuffer && averagesBuffer && required <= bufferCapacityPoints) {
      return;
    }

    bufferCapacityPoints = Math.max(bufferCapacityPoints, Math.max(MIN_OUTPUT_CAPACITY, nextPow2(required)));
    const byteSize = bufferCapacityPoints * 2 * 4; // vec2<f32> = 8 bytes

    if (outputBuffer) {
      try {
        outputBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    if (averagesBuffer) {
      try {
        averagesBuffer.destroy();
      } catch {
        // best-effort
      }
    }

    outputBuffer = device.createBuffer({
      label: 'decimationCompute/outputBuffer',
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    averagesBuffer = device.createBuffer({
      label: 'decimationCompute/averagesBuffer',
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    bindGroup = null;
    boundRawBuffer = null;
    bindGroupResourcesChanged = true;
  };

  const ensureHierarchyBuffers = (physicalCapacity: number): void => {
    const neededTiles = Math.max(
      MIN_HIERARCHY_TILE_CAPACITY,
      tileCountForCapacity(Math.max(physicalCapacity, HIERARCHY_TILE))
    );
    if (tilesBuffer && neededTiles <= tilesCapacity) {
      return;
    }
    tilesCapacity = Math.max(tilesCapacity, nextPow2(neededTiles));
    const byteSize = tilesCapacity * HIERARCHY_TILE_BYTES;
    if (tilesBuffer) {
      try {
        tilesBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    tilesBuffer = device.createBuffer({
      label: 'decimationCompute/tilesBuffer',
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    // New tiles buffer → must full rebuild + rebind.
    markFullDirty(tilesCapacity > 0 ? tilesCapacity : neededTiles);
    bindGroup = null;
    boundRawBuffer = null;
    maintainBindGroup0 = null;
    maintainBindGroup1 = null;
    maintainBoundRaw = null;
    bindGroupResourcesChanged = true;
  };

  const ensureBindGroup = (rawBuffer: GPUBuffer): void => {
    if (bindGroup && boundRawBuffer === rawBuffer) return;
    if (!outputBuffer || !averagesBuffer || !tilesBuffer) return;

    bindGroup = device.createBindGroup({
      label: 'decimationCompute/bindGroup',
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: rawBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: averagesBuffer } },
        { binding: 4, resource: { buffer: tilesBuffer } },
      ],
    });
    boundRawBuffer = rawBuffer;
    bindGroupResourcesChanged = true;
  };

  const ensureMaintainBindGroups = (rawBuffer: GPUBuffer): void => {
    if (maintainBindGroup0 && maintainBindGroup1 && maintainBoundRaw === rawBuffer) return;
    if (!tilesBuffer) return;
    maintainBindGroup0 = device.createBindGroup({
      label: 'decimationCompute/maintainBindGroup0',
      layout: maintainBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: maintainUniformBuffer0 } },
        { binding: 1, resource: { buffer: rawBuffer } },
        { binding: 2, resource: { buffer: tilesBuffer } },
      ],
    });
    maintainBindGroup1 = device.createBindGroup({
      label: 'decimationCompute/maintainBindGroup1',
      layout: maintainBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: maintainUniformBuffer1 } },
        { binding: 1, resource: { buffer: rawBuffer } },
        { binding: 2, resource: { buffer: tilesBuffer } },
      ],
    });
    maintainBoundRaw = rawBuffer;
  };

  /**
   * Update hierarchy dirty ranges from prepare delta vs last maintain stamp.
   * Physical tile indexing: modular wrap invalidates up to two phys ranges
   * (no min/max collapse across the seam).
   */
  const updateHierarchyDirty = (
    rawBuffer: GPUBuffer,
    rawCount: number,
    ringStart: number,
    ringCap: number,
    version: number | undefined
  ): void => {
    const physCap = physicalCapacityOf(rawCount, ringCap);
    ensureHierarchyBuffers(physCap);
    const nTiles = tileCountForCapacity(physCap);

    // Stamp comparisons only apply after a successful maintain stamped lastMaintained*.
    // During cold rebuild lastMaintained* is unset — must not restart every prepare.
    const hasMaintainStamp = lastMaintainedRawBuffer != null;
    const bufferChanged = hasMaintainStamp && lastMaintainedRawBuffer !== rawBuffer;
    // Ring capacity change forces full rebuild. Linear physCap tracks N and is
    // handled by the growth path — do not treat N↑ as capChanged.
    const capChanged = hasMaintainStamp && lastMaintainedRingCapacity !== ringCap;
    const equalNRewrite =
      hasMaintainStamp &&
      hierarchyReady &&
      !bufferChanged &&
      !capChanged &&
      lastMaintainedRawPointCount === rawCount &&
      lastMaintainedRingStart === ringStart &&
      lastMaintainedContentVersion !== version;

    if (nTiles === 0) {
      markFullDirty(0);
      return;
    }

    if (bufferChanged || capChanged || equalNRewrite) {
      markFullDirty(nTiles);
      return;
    }

    // In-progress cold rebuild: keep coldProgressTile (advanced only in encodeMaintain).
    if (!hierarchyReady && hierarchyDirtyFull) {
      if (coldProgressTile > nTiles) coldProgressTile = 0;
      // Equal-N content rewrite mid-cold (stable geometry, version bump) must
      // restart — otherwise mixed V1/V2 tiles stamp ready (Issue 2 round 2).
      if (
        hasPrevPrepareStamp &&
        prevPrepareContentVersion !== version &&
        rawCount === prevPrepareRawCount &&
        ringStart === prevPrepareRingStart &&
        ringCap === prevPrepareRingCap
      ) {
        markFullDirty(nTiles);
        return;
      }
      // Overwrite rewind applied via applyColdOverwriteRewind (prev-prepare stamp).
      return;
    }

    if (!hierarchyReady) {
      markFullDirty(nTiles);
      return;
    }

    // Linear / ring fill growth: new physical points at [oldN, newN).
    if (rawCount > lastMaintainedRawPointCount && ringStart === lastMaintainedRingStart) {
      const ov = tilesOverlappingPhysical(lastMaintainedRawPointCount, rawCount);
      if (ov) {
        addIncrementalTileRange(ov.startTile, Math.min(nTiles, ov.endTileExclusive), nTiles);
      }
      return;
    }

    // Modular full-ring wrap: up to two physical spans (no seam min/max collapse).
    if (
      ringCap > 0 &&
      rawCount >= ringCap &&
      lastMaintainedRawPointCount >= ringCap &&
      ringStart !== lastMaintainedRingStart
    ) {
      const ranges = modularOverwriteRanges(lastMaintainedRingStart, ringStart, ringCap);
      for (const r of ranges) {
        const ov = tilesOverlappingPhysical(r.start, r.end);
        if (!ov) continue;
        addIncrementalTileRange(ov.startTile, Math.min(nTiles, ov.endTileExclusive), nTiles);
      }
      return;
    }

    // N shrink or unexpected layout: full rebuild.
    if (rawCount !== lastMaintainedRawPointCount || ringStart !== lastMaintainedRingStart) {
      markFullDirty(nTiles);
      return;
    }

    // Content version-only with same geometry already handled as equalNRewrite.
    // Pure window/bucket present — no hierarchy dirty.
  };

  /**
   * During cold full rebuild, FIFO may overwrite physical tiles already
   * maintained in earlier chunks. Call after updateHierarchyDirty with the
   * previous-frame ring stamp (preparedRingStart before assign).
   */
  let prevPrepareRingStart = 0;
  let prevPrepareRingCap = 0;
  let prevPrepareRawCount = -1;
  let prevPrepareContentVersion: number | undefined = undefined;
  let hasPrevPrepareStamp = false;

  const applyColdOverwriteRewind = (
    rawCount: number,
    ringStart: number,
    ringCap: number
  ): void => {
    if (!hierarchyDirtyFull || hierarchyReady || !hasPrevPrepareStamp) return;
    if (ringCap <= 0 || prevPrepareRingCap <= 0) return;
    if (rawCount < ringCap || prevPrepareRawCount < prevPrepareRingCap) return;
    if (ringStart === prevPrepareRingStart) return;
    const ranges = modularOverwriteRanges(prevPrepareRingStart, ringStart, ringCap);
    for (const r of ranges) {
      const ov = tilesOverlappingPhysical(r.start, r.end);
      if (!ov) continue;
      if (ov.startTile < coldProgressTile) {
        coldProgressTile = ov.startTile;
      }
    }
  };

  const hierarchyNeedsMaintain = (): boolean => {
    // Do not gate on preparedRawBuffer: prepare() computes willMaintain *before*
    // assigning prepared* fields. tilesBuffer existence is enough for the policy
    // decision; encodeMaintain still requires preparedRawBuffer at encode time.
    if (!tilesBuffer) return false;
    // Before first prepare assigns counts, use tilesCapacity as upper bound.
    const nTiles =
      preparedRawPointCount >= 0
        ? tileCountForCapacity(physicalCapacityOf(preparedRawPointCount, preparedRingCapacity))
        : tilesCapacity;
    if (hierarchyDirtyFull) {
      return coldProgressTile < Math.max(nTiles, 1) || !hierarchyReady;
    }
    return dirtyTileRanges.some((r) => r.endExclusive > r.start);
  };

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('DecimationCompute is disposed.');
  };

  const prepare: DecimationCompute['prepare'] = (params) => {
    assertNotDisposed();

    const {
      algorithm,
      rawBuffer,
      rawPointCount,
      visibleStart,
      visibleEnd,
      targetBuckets,
      contentVersion,
      ringStart: ringStartIn,
      ringCapacity: ringCapacityIn,
    } = params;

    const rawCount = Math.max(0, rawPointCount | 0);
    const vs = Math.min(rawCount, Math.max(0, visibleStart | 0));
    const ve = Math.min(rawCount, Math.max(vs, visibleEnd | 0));
    const buckets = Math.max(2, targetBuckets | 0);
    const version = contentVersion;
    const ringCap = Math.max(0, (ringCapacityIn ?? 0) | 0);
    const ringStart = ringCap > 0 ? Math.max(0, (ringStartIn ?? 0) | 0) % ringCap : 0;

    bindGroupResourcesChanged = false;
    ensureBuffers(buckets);
    const physCap = physicalCapacityOf(rawCount, ringCap);
    ensureHierarchyBuffers(Math.max(physCap, 1));
    ensureBindGroup(rawBuffer);
    ensureMaintainBindGroups(rawBuffer);
    const resourcesChanged = bindGroupResourcesChanged;
    const span = Math.max(0, ve - vs);

    if (resourcesChanged) {
      hasEncoded = false;
      lastEncodedAlgorithm = null;
      lastEncodedRawBuffer = null;
      lastEncodedRawPointCount = -1;
      lastEncodedVisibleStart = -1;
      lastEncodedVisibleEnd = -1;
      lastEncodedTargetBuckets = -1;
      lastEncodedContentVersion = undefined;
      lastEncodedRingStart = 0;
      lastEncodedRingCapacity = 0;
    }

    // Hierarchy dirty tracking vs last maintain stamp (independent of present SIG).
    updateHierarchyDirty(rawBuffer, rawCount, ringStart, ringCap, version);
    applyColdOverwriteRewind(rawCount, ringStart, ringCap);

    // Assign prepared* early so hierarchyNeedsMaintain / encode can use them.
    preparedAlgorithm = algorithm;
    preparedRawBuffer = rawBuffer;
    preparedRawPointCount = rawCount;
    preparedVisibleStart = vs;
    preparedVisibleEnd = ve;
    preparedTargetBuckets = buckets;
    preparedContentVersion = version;
    preparedRingStart = ringStart;
    preparedRingCapacity = ringCap;

    prevPrepareRingStart = ringStart;
    prevPrepareRingCap = ringCap;
    prevPrepareRawCount = rawCount;
    prevPrepareContentVersion = version;
    hasPrevPrepareStamp = true;

    if (span <= 0) {
      hasPrepared = true;
      dirty = false;
      preparedUseHierarchy = false;
      lastOutputPointCount = 0;
      return 0;
    }

    const sigMatchesLastEncoded =
      hasEncoded &&
      lastEncodedAlgorithm === algorithm &&
      lastEncodedRawBuffer === rawBuffer &&
      lastEncodedRawPointCount === rawCount &&
      lastEncodedVisibleStart === vs &&
      lastEncodedVisibleEnd === ve &&
      lastEncodedTargetBuckets === buckets &&
      lastEncodedContentVersion === version &&
      lastEncodedRingStart === ringStart &&
      lastEncodedRingCapacity === ringCap;

    // Hierarchy present only when already ready, or maintain will *finish* this
    // frame (no optimistic partial-cold hierarchy path — Issue 11).
    const nTiles = tileCountForCapacity(physicalCapacityOf(rawCount, ringCap));
    const remain = remainingMaintainTiles(nTiles);
    const willCompleteCold =
      hierarchyDirtyFull && remain > 0 && remain <= MAX_COLD_MAINTAIN_TILES_PER_ENCODE;
    const willCompleteIncremental = !hierarchyDirtyFull && remain > 0;
    const hierarchyReadyAfterEncode = hierarchyReady || willCompleteCold || willCompleteIncremental;
    const useHierarchy = shouldUseHierarchyPresent({
      rawPointCount: rawCount,
      targetBuckets: buckets,
      visibleStart: vs,
      visibleEnd: ve,
      ringCapacity: ringCap,
      hierarchyReady: hierarchyReadyAfterEncode,
    });

    if (!sigMatchesLastEncoded) {
      dirty = true;
      preparedUseHierarchy = useHierarchy;

      const physCapU = physicalCapacityOf(rawCount, ringCap);
      const tileCount = tileCountForCapacity(physCapU);

      uniformScratchU32[0] = rawCount >>> 0;
      uniformScratchU32[1] = vs >>> 0;
      uniformScratchU32[2] = ve >>> 0;
      uniformScratchU32[3] = buckets >>> 0;
      uniformScratchU32[4] = algorithm === 'max' ? MODE_MAX : algorithm === 'min' ? MODE_MIN : 0;
      uniformScratchU32[5] = ringStart >>> 0;
      uniformScratchU32[6] = ringCap >>> 0;
      // Reserved (pipelines selected in TS; flag unused in WGSL).
      uniformScratchU32[7] = 0;
      uniformScratchU32[8] = tileCount >>> 0;
      uniformScratchU32[9] = physCapU >>> 0;
      uniformScratchU32[10] = 0;
      uniformScratchU32[11] = 0;
      writeUniformBuffer(device, uniformBuffer, uniformScratch);
      lastOutputPointCount = buckets;
    } else {
      dirty = false;
      preparedUseHierarchy = useHierarchy;
      lastOutputPointCount = lastEncodedTargetBuckets;
      // Present SIG clean; hierarchy may still need maintain (cold chunks).
    }

    hasPrepared = true;
    return lastOutputPointCount;
  };

  const needsEncode: DecimationCompute['needsEncode'] = () => {
    if (disposed || !hasPrepared || !bindGroup) return false;
    const buckets = preparedTargetBuckets;
    const span = preparedVisibleEnd - preparedVisibleStart;
    // Empty / degenerate window: never open a compute pass (G0 cold).
    if (buckets < 2 || span <= 0) return false;
    // Present SIG dirty or hierarchy maintain still pending (cold chunk / range).
    if (dirty) return true;
    return hierarchyNeedsMaintain();
  };

  /**
   * Dispatch one maintain range using dedicated uniform slot `slot` (0 or 1).
   * Dual slots avoid queue.writeBuffer clobber when two seam ranges share a pass.
   */
  const dispatchMaintainRange = (
    pass: GPUComputePassEncoder,
    slot: 0 | 1,
    startTile: number,
    count: number,
    rawCount: number,
    ringStart: number,
    ringCap: number,
    physCap: number
  ): void => {
    if (count <= 0 || !preparedRawBuffer) return;
    ensureMaintainBindGroups(preparedRawBuffer);
    const uniformBuffer = slot === 0 ? maintainUniformBuffer0 : maintainUniformBuffer1;
    const bg = slot === 0 ? maintainBindGroup0 : maintainBindGroup1;
    if (!bg) return;
    maintainUniformU32[0] = rawCount >>> 0;
    maintainUniformU32[1] = ringStart >>> 0;
    maintainUniformU32[2] = ringCap >>> 0;
    maintainUniformU32[3] = physCap >>> 0;
    maintainUniformU32[4] = startTile >>> 0;
    maintainUniformU32[5] = count >>> 0;
    maintainUniformU32[6] = 0;
    maintainUniformU32[7] = 0;
    writeUniformBuffer(device, uniformBuffer, maintainUniformScratch);
    pass.setPipeline(maintainPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(count);
  };

  const encodeMaintain = (pass: GPUComputePassEncoder): number => {
    if (!preparedRawBuffer || !tilesBuffer) return 0;
    if (!hierarchyNeedsMaintain()) return 0;

    const rawCount = preparedRawPointCount;
    const ringCap = preparedRingCapacity;
    const ringStart = preparedRingStart;
    const physCap = physicalCapacityOf(rawCount, ringCap);
    const nTiles = tileCountForCapacity(physCap);
    if (nTiles <= 0) return 0;

    let tilesDispatched = 0;

    if (hierarchyDirtyFull) {
      let startTile = Math.max(0, Math.min(nTiles, coldProgressTile));
      let endTile = nTiles;
      let count = endTile - startTile;
      if (count <= 0) {
        hierarchyDirtyFull = false;
        dirtyTileRanges = [];
        coldProgressTile = 0;
        hierarchyReady = true;
        lastMaintainedRawBuffer = preparedRawBuffer;
        lastMaintainedRawPointCount = rawCount;
        lastMaintainedRingStart = ringStart;
        lastMaintainedRingCapacity = ringCap;
        lastMaintainedContentVersion = preparedContentVersion;
        return 0;
      }

      // Chunk cold full rebuilds; advance coldProgressTile (Issue 1).
      if (count > MAX_COLD_MAINTAIN_TILES_PER_ENCODE) {
        endTile = startTile + MAX_COLD_MAINTAIN_TILES_PER_ENCODE;
        count = MAX_COLD_MAINTAIN_TILES_PER_ENCODE;
      }

      dispatchMaintainRange(pass, 0, startTile, count, rawCount, ringStart, ringCap, physCap);
      tilesDispatched = count;
      coldProgressTile = endTile;

      if (coldProgressTile < nTiles) {
        hierarchyReady = false;
        hierarchyDirtyFull = true;
        return tilesDispatched;
      }

      // Full cold complete.
      hierarchyDirtyFull = false;
      coldProgressTile = 0;
      dirtyTileRanges = [];
      hierarchyReady = true;
      lastMaintainedRawBuffer = preparedRawBuffer;
      lastMaintainedRawPointCount = rawCount;
      lastMaintainedRingStart = ringStart;
      lastMaintainedRingCapacity = ringCap;
      lastMaintainedContentVersion = preparedContentVersion;
      return tilesDispatched;
    }

    // Incremental: up to two disjoint tile ranges (modular seam).
    // Each range uses its own uniform buffer so both dispatches see correct
    // startTile/count after queue.writeBuffer reordering (AGENTS grid hazard).
    const ranges = dirtyTileRanges.slice();
    dirtyTileRanges = [];
    let slot: 0 | 1 = 0;
    for (const r of ranges) {
      const startTile = Math.max(0, Math.min(nTiles, r.start));
      const endTile = Math.max(startTile, Math.min(nTiles, r.endExclusive));
      const count = endTile - startTile;
      if (count <= 0) continue;
      dispatchMaintainRange(pass, slot, startTile, count, rawCount, ringStart, ringCap, physCap);
      tilesDispatched += count;
      slot = 1; // second range uses slot 1; >2 ranges already collapsed to full dirty
    }

    hierarchyReady = true;
    lastMaintainedRawBuffer = preparedRawBuffer;
    lastMaintainedRawPointCount = rawCount;
    lastMaintainedRingStart = ringStart;
    lastMaintainedRingCapacity = ringCap;
    lastMaintainedContentVersion = preparedContentVersion;
    return tilesDispatched;
  };

  const encodePresent = (pass: GPUComputePassEncoder): void => {
    if (!bindGroup) return;
    const buckets = preparedTargetBuckets;
    const useH = preparedUseHierarchy && hierarchyReady;

    pass.setBindGroup(0, bindGroup);

    if (preparedAlgorithm === 'min' || preparedAlgorithm === 'max') {
      pass.setPipeline(useH ? hierarchyMinMaxPipeline : minMaxPipeline);
      const dispatch = Math.max(1, buckets - 2);
      pass.dispatchWorkgroups(dispatch);
    } else {
      pass.setPipeline(useH ? hierarchyAveragesPipeline : averagesPipeline);
      pass.dispatchWorkgroups(buckets);
      pass.setPipeline(useH ? hierarchyLttbPipeline : lttbPipeline);
      pass.dispatchWorkgroups(buckets);
    }
  };

  const getHierarchyDebug = (): DecimationHierarchyDebug => ({
    hierarchyReady,
    lastPresentHierarchy: lastEncodeUsedHierarchyPresent,
    lastMaintainTileCount: lastEncodeMaintainTileCount,
    preparedRawPointCount,
    preparedRingCapacity,
  });

  const encodeCompute: DecimationCompute['encodeCompute'] = (encoder, intoPass) => {
    assertNotDisposed();
    if (!hasPrepared) return;
    if (!bindGroup) return;

    const buckets = preparedTargetBuckets;
    const span = preparedVisibleEnd - preparedVisibleStart;
    // Degenerate window: clear present dirty and skip (no maintain-only either).
    if (buckets < 2 || span <= 0) {
      dirty = false;
      return;
    }

    const needMaintain = hierarchyNeedsMaintain();
    const needPresent = dirty;
    if (!needMaintain && !needPresent) return;

    const canPresent = needPresent;

    const ownsPass = intoPass == null;
    const pass =
      intoPass ??
      encoder.beginComputePass({
        label: 'decimationCompute/computePass',
      });

    // (1) Hierarchy maintain if dirty — may run without present (Issue 4).
    lastEncodeMaintainTileCount = needMaintain ? encodeMaintain(pass) : 0;

    // If hierarchy was planned but not ready, fall back to legacy present.
    if (preparedUseHierarchy && !hierarchyReady) {
      preparedUseHierarchy = false;
    }

    // (2) Present only when present SIG is dirty (G1: lastEncoded only after write).
    if (canPresent) {
      lastEncodeUsedHierarchyPresent = preparedUseHierarchy && hierarchyReady;
      encodePresent(pass);

      dirty = false;
      hasEncoded = true;
      lastEncodedAlgorithm = preparedAlgorithm;
      lastEncodedRawBuffer = preparedRawBuffer;
      lastEncodedRawPointCount = preparedRawPointCount;
      lastEncodedVisibleStart = preparedVisibleStart;
      lastEncodedVisibleEnd = preparedVisibleEnd;
      lastEncodedTargetBuckets = preparedTargetBuckets;
      lastEncodedContentVersion = preparedContentVersion;
      lastEncodedRingStart = preparedRingStart;
      lastEncodedRingCapacity = preparedRingCapacity;
    }

    if (ownsPass) {
      pass.end();
    }
  };

  const getOutputBuffer: DecimationCompute['getOutputBuffer'] = () => {
    if (!outputBuffer) {
      ensureBuffers(MIN_OUTPUT_CAPACITY);
      ensureHierarchyBuffers(HIERARCHY_TILE);
    }
    return outputBuffer!;
  };

  const getOutputPointCount: DecimationCompute['getOutputPointCount'] = () => lastOutputPointCount;

  const dispose: DecimationCompute['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    try {
      uniformBuffer.destroy();
    } catch {
      // best-effort
    }
    try {
      maintainUniformBuffer0.destroy();
    } catch {
      // best-effort
    }
    try {
      maintainUniformBuffer1.destroy();
    } catch {
      // best-effort
    }
    if (outputBuffer) {
      try {
        outputBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    if (averagesBuffer) {
      try {
        averagesBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    if (tilesBuffer) {
      try {
        tilesBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    outputBuffer = null;
    averagesBuffer = null;
    tilesBuffer = null;
    bindGroup = null;
    maintainBindGroup0 = null;
    maintainBindGroup1 = null;
    boundRawBuffer = null;
    maintainBoundRaw = null;
    bufferCapacityPoints = 0;
    tilesCapacity = 0;
    hasPrepared = false;
    dirty = false;
    hasEncoded = false;
    hierarchyReady = false;
    hierarchyDirtyFull = true;
    coldProgressTile = 0;
    dirtyTileRanges = [];
    hasPrevPrepareStamp = false;
    prevPrepareContentVersion = undefined;
    lastEncodedAlgorithm = null;
    lastEncodedRawBuffer = null;
    lastEncodedRawPointCount = -1;
    lastEncodedVisibleStart = -1;
    lastEncodedVisibleEnd = -1;
    lastEncodedTargetBuckets = -1;
    lastEncodedContentVersion = undefined;
    lastEncodedRingStart = 0;
    lastEncodedRingCapacity = 0;
    preparedAlgorithm = null;
    preparedRawBuffer = null;
    preparedRawPointCount = -1;
    preparedVisibleStart = -1;
    preparedVisibleEnd = -1;
    preparedTargetBuckets = -1;
    preparedContentVersion = undefined;
    preparedRingStart = 0;
    preparedRingCapacity = 0;
    lastOutputPointCount = 0;
    lastMaintainedRawBuffer = null;
    lastMaintainedRawPointCount = -1;
    lastMaintainedRingStart = 0;
    lastMaintainedRingCapacity = 0;
    lastMaintainedContentVersion = undefined;
  };

  return {
    prepare,
    needsEncode,
    encodeCompute,
    getOutputBuffer,
    getOutputPointCount,
    getHierarchyDebug,
    dispose,
  };
}
